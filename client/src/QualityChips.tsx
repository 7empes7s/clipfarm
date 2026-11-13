import { useState } from "react";
import type { Clip } from "../../shared/types";
import { api } from "./api";

/**
 * What the automatic check found wrong with a clip's latest render: one warning chip per problem,
 * and a Fix button when a change can clear them (it remakes the clip).
 */
export function QualityChips({ clip, onFixed }: { clip: Clip; onFixed: (clip: Clip) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quality = clip.quality;
  if (!quality || quality.issues.length === 0 || clip.status === "rendering") return null;
  const fix = clip.postCount === 0 ? quality.fix : null;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      onFixed((await api.fixClip(clip.id)).clip);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quality" data-testid="quality">
      <ul className="quality-chips" aria-label="Problems found in this clip">
        {quality.issues.map((issue, i) => (
          <li key={i} className="quality-chip">
            {issue.reason}
          </li>
        ))}
      </ul>
      {fix && (
        <div className="quality-fix">
          <button type="button" disabled={busy} onClick={() => void run()}>
            {busy ? "Fixing…" : "Fix"}
          </button>
          <span className="hint">{fix.label}, then remake the clip.</span>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
