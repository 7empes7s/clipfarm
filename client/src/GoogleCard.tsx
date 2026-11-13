import { type FormEvent, useEffect, useState } from "react";
import type { GoogleSettings, GoogleStatus } from "../../shared/google";
import { api } from "./api";
import { Meter } from "./charts";
import { shortDate } from "./format";

const eur = (n: number) => `€${n.toFixed(2)}`;

/** The Google Cloud credit: what Gemini has cost so far, when it stops, and what it is used for. Hidden until Google is connected. */
export function GoogleCard({ refreshKey }: { refreshKey: string }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    // An older server has no such page: the card just stays away.
    api.google().then((s) => on && setStatus(s), () => undefined);
    return () => {
      on = false;
    };
  }, [refreshKey]);

  if (!status?.configured) return null;

  const save = (change: Partial<GoogleSettings>) => {
    setBusy(true);
    setError(null);
    void api
      .saveGoogleSettings(change)
      .then(setStatus, (err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    save({ dailyCapEur: Number(form.get("dailyCapEur")), weight: Number(form.get("weight")) });
  };
  const s = status.settings;

  return (
    <section className="card google" aria-labelledby="google-title" data-testid="google">
      <div className="card-head">
        <h3 id="google-title">Google credit</h3>
        <span className={`state ${status.blocked ? "state-none" : "state-active"}`}>{status.blocked ? "Paused" : "In use"}</span>
      </div>
      <p className="google-spent" data-testid="google-spent">
        <strong>{eur(status.spentEur)}</strong> of {eur(status.creditEur)} used
      </p>
      <Meter value={status.creditEur > 0 ? Math.min(1, status.spentEur / status.creditEur) : null} label="Google credit used" />
      <p className="hint">
        Today {eur(status.todayEur)} of {eur(s.dailyCapEur)}. The credit ends {shortDate(`${status.expiresAt}T12:00:00Z`)}. Amounts are estimates from
        Google's list prices; Google is no longer called at 90% of the credit.
      </p>
      {status.blocked && (
        <p className="hint" role="status" data-testid="google-blocked">
          {status.blocked} Clips are still made, by the local engine alone.
        </p>
      )}
      <label className="switch">
        <input type="checkbox" role="switch" checked={s.rerank} disabled={busy} onChange={(e) => save({ rerank: e.target.checked })} />
        Watch the best picks before ranking them
      </label>
      <p className="hint">
        Gemini watches a small copy of the top {s.topN} picks of each video and scores what words cannot show: crashes, chases, faces. Each pick then
        says what it saw.
      </p>
      <label className="switch">
        <input type="checkbox" role="switch" checked={s.thumbnails} disabled={busy} onChange={(e) => save({ thumbnails: e.target.checked })} />
        Make thumbnails for approved clips
      </label>
      <form className="form google-limits" onSubmit={submit} key={`${s.dailyCapEur}:${s.weight}`}>
        <label>
          Daily limit in euros
          <input name="dailyCapEur" type="number" inputMode="decimal" min="0" step="0.5" defaultValue={s.dailyCapEur} required />
        </label>
        <label>
          How much the video counts in a pick's score (0 to 100)
          <input name="weight" type="number" inputMode="numeric" min="0" max="100" step="5" defaultValue={s.weight} required />
        </label>
        <button type="submit" disabled={busy}>
          Save limits
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
