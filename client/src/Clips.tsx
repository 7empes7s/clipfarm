import { useEffect, useState } from "react";
import type { Pick } from "../../shared/types";
import { clock, megabytes, seconds, usd } from "./format";

const STATUS_LABEL: Record<Pick["status"], string> = {
  picked: "Waiting to cut",
  rendering: "Cutting…",
  rendered: "Ready",
  failed: "Could not cut",
  dropped: "Left out",
};

const STEP_LABEL: Record<string, string> = { pick: "picking", download: "download", render: "cutting" };

/** The clips picked from one VOD, best first, plus the moments that were left out and why. */
export function Clips({ picks }: { picks: Pick[] }) {
  const [playing, setPlaying] = useState<Pick | null>(null);
  const kept = picks.filter((p) => p.status !== "dropped");
  const left = picks.filter((p) => p.status === "dropped");
  if (picks.length === 0) return null;

  return (
    <div className="clips" data-testid="clips">
      <h4>
        {kept.length} {kept.length === 1 ? "clip" : "clips"}
      </h4>
      {kept.length > 0 && (
        <ul className="clip-grid">
          {kept.map((p) => (
            <li key={p.id} className={`clip clip-${p.status}`} data-testid="clip">
              <button
                type="button"
                className="clip-frame"
                disabled={!p.videoUrl}
                aria-label={p.videoUrl ? `Play ${p.title}` : `${p.title}: ${STATUS_LABEL[p.status]}`}
                onClick={() => setPlaying(p)}
              >
                {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : <span>{STATUS_LABEL[p.status]}</span>}
                <span className="clip-score" title="How likely viewers keep watching (0-100)">
                  {Math.round(p.score)}
                </span>
              </button>
              <div className="clip-title">{p.title}</div>
              <div className="meta">
                <span>{clock(p.endSec - p.startSec)}</span>
                {p.sizeBytes !== null && <span>{megabytes(p.sizeBytes)}</span>}
                {p.status !== "rendered" && <span>{STATUS_LABEL[p.status]}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {left.length > 0 && (
        <details className="left-out">
          <summary>{left.length} left out</summary>
          <ul>
            {left.map((p) => (
              <li key={p.id}>
                <span className="clip-title">{p.title || `Moment at ${clock(p.startSec)}`}</span>{" "}
                <span className="hint">{p.dropReason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {playing && <ClipPlayer pick={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

function ClipPlayer({ pick, onClose }: { pick: Pick; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="clip-player-title" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="clip-player-title">{pick.title}</h2>
          <button type="button" className="close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <video className="player" src={pick.videoUrl ?? undefined} controls autoPlay playsInline />
        <dl className="stub clip-facts">
          <div className="wide">
            <dt>Why this one</dt>
            <dd>{pick.reason}</dd>
          </div>
          <div className="wide">
            <dt>Hook (first 2 s)</dt>
            <dd>{pick.hook || "None"}</dd>
          </div>
          <div>
            <dt>From the stream</dt>
            <dd>
              {clock(pick.startSec)} to {clock(pick.endSec)}
            </dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>{usd(pick.costUsd)}</dd>
          </div>
          <div className="wide">
            <dt>Time taken</dt>
            <dd>{pick.steps.map((s) => `${STEP_LABEL[s.step] ?? s.step} ${seconds(s.ms)}`).join(", ")}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
