import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { snapToWord, type TimeRange } from "../../shared/studio";
import type { Word } from "../../shared/types";

const FRAMES = 10;
const PEAKS = 240;

/** Frames of the master at even steps, drawn once into a strip (same-origin video, so the canvas can read it). */
function useFilmstrip(src: string, total: number, canvas: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    if (!(total > 0)) return;
    let stopped = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.src = src;
    const seek = (t: number) =>
      new Promise<void>((resolve, reject) => {
        v.addEventListener("seeked", () => resolve(), { once: true });
        v.addEventListener("error", () => reject(new Error("no video")), { once: true });
        v.currentTime = t;
      });
    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          v.addEventListener("loadeddata", () => resolve(), { once: true });
          v.addEventListener("error", () => reject(new Error("no video")), { once: true });
        });
        const c = canvas.current;
        const ctx = c?.getContext("2d");
        if (!c || !ctx) return;
        const w = c.width / FRAMES;
        for (let i = 0; i < FRAMES && !stopped; i++) {
          await seek(((i + 0.5) * total) / FRAMES);
          const scale = Math.max(w / v.videoWidth, c.height / v.videoHeight);
          const dw = v.videoWidth * scale;
          ctx.drawImage(v, i * w + (w - dw) / 2, (c.height - v.videoHeight * scale) / 2, dw, v.videoHeight * scale);
        }
      } catch {
        // No filmstrip is fine: the waveform and handles still work.
      } finally {
        v.removeAttribute("src");
        v.load();
      }
    })();
    return () => {
      stopped = true;
    };
  }, [src, total, canvas]);
}

/** Loudness peaks of the master's sound, decoded in the browser (no work for the server). */
function useWaveform(src: string): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok || Number(res.headers.get("content-length") ?? 0) > 80_000_000) return;
        const audio = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(await res.arrayBuffer());
        const data = audio.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / PEAKS));
        const out: number[] = [];
        for (let i = 0; i < PEAKS; i++) {
          let max = 0;
          for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) max = Math.max(max, Math.abs(data[j]!));
          out.push(max);
        }
        const top = Math.max(...out, 0.0001);
        if (!stopped) setPeaks(out.map((p) => p / top));
      } catch {
        // A master without sound (or one the browser cannot decode) has no waveform.
      }
    })();
    return () => {
      stopped = true;
    };
  }, [src]);
  return peaks;
}

export interface TimelineProps {
  src: string;
  total: number;
  startSec: number;
  endSec: number;
  cuts: TimeRange[];
  playhead: number;
  words: Word[];
  onSeek: (t: number) => void;
  /** A handle was let go: the new in or out point, already snapped to a word edge. */
  onTrim: (edge: "start" | "end", t: number) => void;
}

/** Filmstrip and waveform of the whole master: the kept window between two handles, cuts hatched, the playhead. */
export function StudioTimeline({ src, total, startSec, endSec, cuts, playhead, words, onSeek, onTrim }: TimelineProps) {
  const strip = useRef<HTMLCanvasElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const peaks = useWaveform(src);
  const [drag, setDrag] = useState<{ edge: "start" | "end"; t: number } | null>(null);
  useFilmstrip(src, total, strip);

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(total, ((clientX - r.left) / r.width) * total));
  };
  const pct = (t: number) => `${(Math.max(0, Math.min(total, t)) / total) * 100}%`;
  const inSec = drag?.edge === "start" ? drag.t : startSec;
  const outSec = drag?.edge === "end" ? drag.t : endSec;

  const grab = (edge: "start" | "end") => (e: ReactPointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ edge, t: edge === "start" ? startSec : endSec });
  };
  const move = (e: ReactPointerEvent) => {
    if (!drag) return;
    const t = snapToWord(timeAt(e.clientX), words, drag.edge);
    setDrag({ ...drag, t });
  };
  const drop = () => {
    if (!drag) return;
    onTrim(drag.edge, drag.t);
    setDrag(null);
  };

  return (
    <div className="timeline" data-testid="timeline">
      <div
        ref={track}
        className="timeline-track"
        onPointerDown={(e) => !drag && onSeek(timeAt(e.clientX))}
        onPointerMove={move}
        onPointerUp={drop}
        onPointerCancel={() => setDrag(null)}
      >
        <canvas ref={strip} className="timeline-strip" width={FRAMES * 96} height={54} aria-hidden="true" />
        <svg className="timeline-wave" viewBox={`0 0 ${PEAKS} 100`} preserveAspectRatio="none" aria-hidden="true">
          {peaks?.map((p, i) => <rect key={i} x={i} y={50 - p * 46} width={0.7} height={Math.max(1, p * 92)} />)}
        </svg>
        <span className="timeline-out" style={{ left: 0, width: pct(inSec) }} />
        <span className="timeline-out" style={{ left: pct(outSec), right: 0 }} />
        {cuts.map((c) => (
          <span key={`${c.startSec}-${c.endSec}`} className="timeline-cut" style={{ left: pct(c.startSec), width: pct(c.endSec - c.startSec) }} />
        ))}
        <span className="timeline-head" style={{ left: pct(playhead) }} />
        <button
          type="button"
          className="timeline-handle"
          style={{ left: pct(inSec) }}
          aria-label="Drag the start (snaps to a word)"
          onPointerDown={grab("start")}
        />
        <button
          type="button"
          className="timeline-handle end"
          style={{ left: pct(outSec) }}
          aria-label="Drag the end (snaps to a word)"
          onPointerDown={grab("end")}
        />
      </div>
    </div>
  );
}
