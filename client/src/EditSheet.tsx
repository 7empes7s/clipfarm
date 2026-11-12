import { type FormEvent, useEffect, useRef, useState } from "react";
import type { Clip, ClipLayout, Source } from "../../shared/types";
import { CLIP_LAYOUT_LABELS, CLIP_LAYOUTS, CLIP_MAX_SEC, CLIP_MIN_SEC } from "../../shared/types";
import { api } from "./api";
import { clock } from "./format";
import { Sheet } from "./Sheet";

const STEP = 0.5;
const round = (v: number) => Math.round(v * 100) / 100;

function fmt(sec: number): string {
  const tenths = Math.round((sec % 1) * 10) % 10;
  return `${clock(sec)}.${tenths}`;
}

/** Trim (±0.5 s), retitle, fix caption typos and switch layout; saving queues a new render. */
export function EditSheet({ clip, source, onClose, onSaved }: { clip: Clip; source?: Source; onClose: () => void; onSaved: (clip: Clip) => void }) {
  const [start, setStart] = useState(clip.startSec);
  const [end, setEnd] = useState(clip.endSec);
  const [title, setTitle] = useState(clip.title);
  const [hook, setHook] = useState(clip.hook);
  const [captionText, setCaptionText] = useState(() =>
    clip.captionWords
      .filter((w) => w.endSec > clip.startSec && w.startSec < clip.endSec)
      .map((w) => w.word)
      .join(" "),
  );
  const [layout, setLayout] = useState<ClipLayout>(clip.layout);
  const [playhead, setPlayhead] = useState(clip.startSec);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const total = clip.masterDurationSec;
  const length = round(end - start);

  const seek = (t: number) => {
    setPlayhead(t);
    if (video.current) video.current.currentTime = t;
  };

  // Play only the trimmed part, looping back to the start.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onTime = () => {
      if (v.currentTime >= end || v.currentTime < start - 0.25) v.currentTime = start;
      setPlayhead(v.currentTime);
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [start, end]);

  const canStart = (d: number) => {
    const s = round(start + d);
    return s >= 0 && end - s >= CLIP_MIN_SEC && end - s <= CLIP_MAX_SEC;
  };
  const canEnd = (d: number) => {
    const e = round(end + d);
    return e <= total + 0.001 && e - start >= CLIP_MIN_SEC && e - start <= CLIP_MAX_SEC;
  };
  const moveStart = (d: number) => {
    const s = round(start + d);
    setStart(s);
    seek(s);
  };
  const moveEnd = (d: number) => {
    const e = round(Math.min(total, end + d));
    setEnd(e);
    seek(Math.max(start, e - 1.5));
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { clip: saved } = await api.editClip(clip.id, { title, hook, captionText, layout, startSec: start, endSec: end });
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  const pct = (t: number) => `${(t / total) * 100}%`;
  return (
    <Sheet id="edit-title" title="Edit clip" onClose={onClose}>
      <form className="form edit" onSubmit={save}>
        <div className="edit-preview">
          <video ref={video} src={clip.masterUrl} muted playsInline preload="auto" controls={false} onLoadedMetadata={() => seek(start)} />
          <div className="trim-bar" aria-hidden="true">
            <span className="trim-kept" style={{ left: pct(start), width: pct(end - start) }} />
            <span className="trim-head" style={{ left: pct(playhead) }} />
          </div>
          <label className="scrub">
            Scrub
            <input type="range" min={0} max={total} step={0.1} value={playhead} onChange={(e) => seek(Number(e.target.value))} />
          </label>
          <div className="row">
            <button type="button" onClick={() => void video.current?.play()}>
              Play
            </button>
            <button type="button" onClick={() => video.current?.pause()}>
              Pause
            </button>
          </div>
        </div>

        <fieldset className="trim">
          <legend>Trim</legend>
          <div className="trim-row">
            <span>
              Start <strong data-testid="trim-start">{fmt(start)}</strong>
            </span>
            <button type="button" aria-label="Start 0.5 s earlier" disabled={!canStart(-STEP)} onClick={() => moveStart(-STEP)}>
              −0.5 s
            </button>
            <button type="button" aria-label="Start 0.5 s later" disabled={!canStart(STEP)} onClick={() => moveStart(STEP)}>
              +0.5 s
            </button>
          </div>
          <div className="trim-row">
            <span>
              End <strong data-testid="trim-end">{fmt(end)}</strong>
            </span>
            <button type="button" aria-label="End 0.5 s earlier" disabled={!canEnd(-STEP)} onClick={() => moveEnd(-STEP)}>
              −0.5 s
            </button>
            <button type="button" aria-label="End 0.5 s later" disabled={!canEnd(STEP)} onClick={() => moveEnd(STEP)}>
              +0.5 s
            </button>
          </div>
          <p className="hint">
            Length {length} s ({CLIP_MIN_SEC}–{CLIP_MAX_SEC} s; 20–35 s does best).
          </p>
        </fieldset>

        <label>
          Title
          <input value={title} maxLength={100} required onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Hook (on screen for the first 2 s)
          <input value={hook} maxLength={100} onChange={(e) => setHook(e.target.value)} />
        </label>
        <label>
          Caption text
          <textarea rows={3} value={captionText} onChange={(e) => setCaptionText(e.target.value)} />
        </label>

        <fieldset className="layouts">
          <legend>Layout</legend>
          {CLIP_LAYOUTS.map((l) => {
            const blocked = l === "stacked" && !source?.faceCam;
            return (
              <label key={l} className={blocked ? "layout blocked" : "layout"}>
                <input type="radio" name="layout" value={l} checked={layout === l} disabled={blocked} onChange={() => setLayout(l)} />
                {CLIP_LAYOUT_LABELS[l]}
              </label>
            );
          })}
          {!source?.faceCam && <p className="hint">Face cam on top needs the face cam position: set it in Sources.</p>}
        </fieldset>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save and remake clip"}
        </button>
      </form>
    </Sheet>
  );
}
