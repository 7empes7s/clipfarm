import { useCallback, useEffect, useState } from "react";
import type { ScoutedCampaign, ScoutInfo } from "../../shared/scout";
import type { CampaignDraft } from "../../shared/types";
import { PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { emptyDraft } from "./CampaignImport";
import { ago } from "./format";

/** $3, $2.50, $8,800: whole amounts without cents. */
function dollars(n: number): string {
  return n.toLocaleString("en", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
}

/** Loads the scout's state, again every few seconds while a run is going on. */
function useScout(refreshKey: string) {
  const [info, setInfo] = useState<ScoutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.scout().then(setInfo, () => undefined), []);
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load, refreshKey]);
  const running = info?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const poll = setInterval(() => void load(), 3000);
    return () => clearInterval(poll);
  }, [running, load]);
  const change = useCallback((call: () => Promise<ScoutInfo>) => {
    setError(null);
    call().then(setInfo, (err: Error) => setError(err.message));
  }, []);
  return { info, error, change };
}

/**
 * "Campaigns for you" on the Dashboard: the five best campaigns the scout found, each with its
 * estimate per day, why, and its key rules. Join opens the campaign's page; after "Yes, I joined"
 * the campaign form opens, filled in from that page.
 */
export function ScoutCard({ refreshKey, onJoined }: { refreshKey: string; onJoined: (draft: CampaignDraft) => void }) {
  const { info, error, change } = useScout(refreshKey);
  const [reading, setReading] = useState<number | null>(null);
  if (!info) return null;

  const joined = (c: ScoutedCampaign) => {
    setReading(c.id);
    // A page that cannot be read still opens the form, to fill in by hand.
    api
      .readCampaign(c.url)
      .then(onJoined, () => onJoined(emptyDraft(c.url)))
      .finally(() => setReading(null));
  };

  return (
    <div className="card scout" data-testid="scout-card">
      <div className="card-head">
        <h3>Campaigns for you</h3>
        <button type="button" disabled={info.running} onClick={() => change(api.scoutNow)}>
          {info.running ? "Scouting…" : "Scout now"}
        </button>
      </div>
      <p className="hint" role="status">
        {info.running
          ? "Reading public campaign pages, one every 5 seconds. This can take a few minutes."
          : info.lastRunAt
            ? `Looked ${ago(info.lastRunAt)}: ${info.found} ${info.found === 1 ? "campaign" : "campaigns"} read. clipfarm looks again every day.`
            : "clipfarm reads the public Content Rewards campaign pages every day and ranks them by what a clip should earn."}
      </p>
      {info.lastError && !info.running && (
        <p className="error" role="alert">
          The last look found nothing: {info.lastError}.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {info.suggestions.length === 0 ? (
        !info.running && info.lastRunAt && !info.lastError && <p className="hint">Nothing new to suggest today.</p>
      ) : (
        <ol className="scout-list">
          {info.suggestions.map((c) => (
            <li key={c.id} data-testid="scout-campaign">
              <div className="scout-top">
                <div className="scout-name">
                  <h4>{c.facts.title}</h4>
                  <span className="hint">
                    {[c.facts.creatorName, c.facts.agency && `through ${c.facts.agency}`].filter(Boolean).join(", ")}
                  </span>
                </div>
                <p className="scout-day">
                  <b>{dollars(c.score.perDayUsd)}</b>
                  <span>a day, estimate</span>
                </p>
              </div>
              <p className="scout-facts">
                {c.facts.ratePer1kUsd !== null &&
                  `${dollars(c.facts.ratePer1kUsd)} per 1,000 views${c.facts.platforms.length > 0 ? ` on ${c.facts.platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}` : ""}.`}
                {c.facts.budgetLeftUsd !== null &&
                  ` ${dollars(c.facts.budgetLeftUsd)}${c.facts.budgetTotalUsd !== null ? ` of ${dollars(c.facts.budgetTotalUsd)}` : ""} budget left.`}
                {c.facts.minViews !== null && ` Pays from ${c.facts.minViews.toLocaleString("en")} views.`}
              </p>
              {c.facts.rules.length + c.facts.audience.length + c.facts.lockedRequirements > 0 && (
                <ul className="scout-rules" aria-label="Key rules">
                  {[...c.facts.audience, ...c.facts.rules].slice(0, 4).map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                  {c.facts.lockedRequirements > 0 && (
                    <li>
                      {c.facts.lockedRequirements} more {c.facts.lockedRequirements === 1 ? "rule shows" : "rules show"} only after you join
                    </li>
                  )}
                </ul>
              )}
              <details className="scout-why">
                <summary>Why this one</summary>
                <dl>
                  {c.score.steps.map((s) => (
                    <div key={s.label}>
                      <dt>
                        {s.label} <b>{s.value}</b>
                      </dt>
                      <dd>{s.why}</dd>
                    </div>
                  ))}
                </dl>
              </details>
              {c.status === "opened" ? (
                <div className="scout-asked">
                  <span id={`scout-asked-${c.id}`}>Did you join?</span>
                  <div className="actions" role="group" aria-labelledby={`scout-asked-${c.id}`}>
                    <button type="button" className="primary" disabled={reading !== null} onClick={() => joined(c)}>
                      {reading === c.id ? "Reading the page…" : "Yes, I joined"}
                    </button>
                    <button type="button" onClick={() => change(() => api.scoutMark(c.id, "new"))}>
                      Not yet
                    </button>
                  </div>
                </div>
              ) : (
                <div className="actions">
                  <a className="button primary" href={c.url} target="_blank" rel="noreferrer" onClick={() => change(() => api.scoutMark(c.id, "opened"))}>
                    Join
                  </a>
                  {/* One tap: the campaign's page is read into the form, its rules ready for one check. */}
                  <button type="button" disabled={reading !== null} onClick={() => joined(c)}>
                    {reading === c.id ? "Reading…" : "Import"}
                  </button>
                  <button type="button" onClick={() => change(() => api.scoutMark(c.id, "hidden"))}>
                    Not interested
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Auto mode in Settings: off to start with. On, clipfarm shares each day's clips over the joined campaigns by score. */
export function AutoModeCard() {
  const { info, error, change } = useScout("");
  if (!info) return null;
  const { on, slots, plan } = info.auto;
  return (
    <div className="card scout-auto" id="settings-auto" data-testid="settings-auto">
      <div className="card-head">
        <h3>Campaign auto mode</h3>
        <span className={on ? "state state-active" : "state state-idle"}>{on ? "On" : "Off"}</span>
      </div>
      <p className="hint key-purpose">
        On, clipfarm decides which of the campaigns you joined get clips, and how many a day, by their score and within what your
        posting accounts can carry. A campaign with under 10% of its budget left, or one that ended, gets none. Off, you choose.
      </p>
      <label className="switch">
        <input type="checkbox" role="switch" checked={on} onChange={(e) => change(() => api.scoutAuto(e.target.checked))} />
        Let clipfarm choose
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {plan.length === 0 ? (
        <p className="hint">
          No campaign joined yet. Pick one from <a href="#dashboard">Campaigns for you</a> on the Dashboard.
        </p>
      ) : (
        <>
          <p className="hint">
            {on ? "Today's plan" : "The plan if you turn it on"}: {slots} {slots === 1 ? "clip" : "clips"} a day across your accounts.
          </p>
          <ul className="scout-plan">
            {plan.map((r) => (
              <li key={r.permissionId} data-testid="auto-plan-row">
                <span className="scout-plan-name">{r.name}</span>
                <span>
                  {r.paused ? `Paused. ${r.paused}` : `${r.slots} ${r.slots === 1 ? "clip" : "clips"} a day`}
                  {!r.paused && r.budgetUsedPct !== null && `, ${r.budgetUsedPct}% of its budget used`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
