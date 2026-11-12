import { type PointerEvent, useEffect, useRef, useState } from "react";
import type { CropRect, Source } from "../../shared/types";
import { api } from "./api";

interface Props {
  source: Source;
  onClose: () => void;
  onSaved: () => void;
}

/** Common face cam spots, for a quick start or when drawing is awkward. */
const PRESETS: { label: string; rect: CropRect }[] = [
  { label: "Top left", rect: { x: 0.02, y: 0.03, w: 0.26, h: 0.3 } },
  { label: "Top right", rect: { x: 0.72, y: 0.03, w: 0.26, h: 0.3 } },
  { label: "Bottom left", rect: { x: 0.02, y: 0.67, w: 0.26, h: 0.3 } },
  { label: "Bottom right", rect: { x: 0.72, y: 0.67, w: 0.26, h: 0.3 } },
];

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Draw where the creator's face cam is on a frame of their stream. Clips then put it on top. */
export function FaceCamEditor({ source, onClose, onSaved }: Props) {
  const [rect, setRect] = useState<CropRect | null>(source.faceCam);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function point(e: PointerEvent) {
    const r = area.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  }
  function down(e: PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = point(e);
  }
  function move(e: PointerEvent) {
    if (!start.current) return;
    const p = point(e);
    const s = start.current;
    setRect({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  }
  function up() {
    start.current = null;
  }

  async function save(value: CropRect | null) {
    setSaving(true);
    setError(null);
    try {
      await api.setFaceCam(source.id, value);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="facecam-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="facecam-title">Face cam for {source.creatorName}</h2>
          <button type="button" className="close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="hint">Drag a box around their camera. Clips will show it on top and the game below.</p>
        <div
          ref={area}
          className="frame-area"
          data-testid="frame-area"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <img src={`/api/sources/${source.id}/frame`} alt={`A frame from ${source.creatorName}'s stream`} draggable={false} />
          {rect && (
            <span
              className="facecam-box"
              style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
            />
          )}
        </div>
        <div className="chips" role="group" aria-label="Quick spots">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => setRect(p.rect)}>
              {p.label}
            </button>
          ))}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="sheet-actions">
          {source.faceCam && (
            <button type="button" disabled={saving} onClick={() => void save(null)}>
              No face cam
            </button>
          )}
          <button type="button" className="primary" disabled={saving || !rect} onClick={() => void save(rect)}>
            Save face cam
          </button>
        </div>
      </div>
    </div>
  );
}
