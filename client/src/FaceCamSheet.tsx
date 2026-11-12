import { type PointerEvent, useRef, useState } from "react";
import type { Clip, FaceCam, Source } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Drag a box around the creator's face cam on a frame of their stream; used by the stacked layout. */
export function FaceCamSheet({ source, clip, onClose, onSaved }: { source: Source; clip?: Clip; onClose: () => void; onSaved: () => void }) {
  const [box, setBox] = useState<FaceCam | null>(source.faceCam);
  const [error, setError] = useState<string | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const area = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ x: number; y: number } | null>(null);

  const point = (e: PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    anchor.current = point(e);
    setBox({ ...anchor.current, w: 0, h: 0 });
  };
  const move = (e: PointerEvent) => {
    const a = anchor.current;
    if (!a) return;
    const p = point(e);
    setBox({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) });
  };
  const up = () => {
    anchor.current = null;
  };

  async function save(faceCam: FaceCam | null) {
    setError(null);
    try {
      await api.setFaceCam(source.id, faceCam);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Sheet id="facecam-title" title={`Face cam: ${source.creatorName}`} onClose={onClose}>
      {clip ? (
        <div className="form">
          <p className="hint">Drag a box around the face cam on this frame. Clips with “Face cam on top” put this part above the gameplay.</p>
          <div
            ref={area}
            className="facecam-area"
            data-testid="facecam-area"
            style={{ aspectRatio: String(aspect) }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          >
            <video
              src={clip.masterUrl}
              muted
              playsInline
              preload="auto"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
                v.currentTime = Math.min(1, v.duration / 3);
              }}
            />
            {box && (
              <span
                className="facecam-box"
                data-testid="facecam-box"
                style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
              />
            )}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <button type="button" className="primary" disabled={!box || box.w < 0.05 || box.h < 0.05} onClick={() => box && void save(box)}>
              Save face cam
            </button>
            {source.faceCam && (
              <button type="button" onClick={() => void save(null)}>
                Remove face cam
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="empty">No video from {source.creatorName} yet. Set the face cam once their first clips are made.</p>
      )}
    </Sheet>
  );
}
