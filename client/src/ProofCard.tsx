import { useCallback, useEffect, useState } from "react";
import type { ProofDay, ProofInfo, ProofRun } from "../../shared/proof";
import { PROOF_CLIPS_PER_HOUR } from "../../shared/proof";
import type { Clip } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";

const STATUS_LABEL: Record<ProofRun["status"], string> = { waiting: "Waiting", running: "Running", passed: "Met the target", failed: "Missed the target", skipped: "Not run" };
const STATUS_CLASS: Record<ProofRun["status"], string> = { waiting: "state-idle", running: "state-idle", passed: "state-active", failed: "state-none", skipped: "state-idle" };
/** Height of the trend's bars, as in .proof-day. */
const BAR_REM = 4.5;
const RUN_NAME = { campaign: "Campaign video", gta: "GTA video", drill: "Launch drill" } as const;

const weekday = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
const clock = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/**
 * The daily live proof: real videos through the real pipeline every day, measured against
 * "10 clips per hour of video in under 30 minutes", with the launch drill and "Launch ready".
 */
export function ProofCard({ clips, refreshKey }: { clips: Clip[]; refreshKey: string }) {
  const [info, setInfo] = useState<ProofInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<Clip | null>(null);

  const load = useCallback(() => api.proof().then(setInfo, () => undefined), []);
  const running = info?.busy ?? false;
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    // A run moves by itself: follow it closely while it is on.
    const poll = setInterval(() => void load(), running ? 3000 : 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [load, refreshKey, running]);

  if (!info) return null;

  const ask = (call: () => Promise<ProofInfo>) => {
    setBusy(true);
    setError(null);
    call()
      .then(setInfo, (err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card proof" aria-labelledby="proof-title" data-testid="proof-card">
      <div className="card-head">
        <h3 id="proof-title">Daily proof</h3>
        <span className={`state ${info.launch.ready ? "state-active" : "state-none"}`} data-testid="launch-ready">
          Launch ready: {info.launch.ready ? "yes" : "no"}
        </span>
      </div>
      <p className="hint">
        Real videos through the real pipeline, kept private. The target: {PROOF_CLIPS_PER_HOUR} clips per hour of video, in under 30 minutes.
        {info.nextAt && !running && ` Next run: ${clock(info.nextAt)}.`}
      </p>
      {!info.launch.ready && (
        <ul className="proof-reasons" data-testid="launch-reasons">
          {info.launch.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {info.runs.length === 0 && <p className="proof-none">No proof has run yet.</p>}
      {info.runs.map((run) => (
        <Run key={run.id} run={run} clips={clips} onPlay={setPlaying} />
      ))}
      {info.drill && <Run run={info.drill} clips={clips} onPlay={setPlaying} />}

      <Week days={info.days} />

      <div className="proof-actions">
        <button type="button" className="primary" disabled={busy || running} onClick={() => ask(api.runProof)}>
          {running ? "Proof running…" : "Run proof now"}
        </button>
        <button type="button" disabled={busy || running} onClick={() => ask(api.runDrill)}>
          Run live drill
        </button>
      </div>
      <p className="hint">The live drill records 15 minutes of an allowed creator who is live right now.</p>

      {playing && (
        <Sheet id="proof-play-title" title={playing.title} onClose={() => setPlaying(null)}>
          <video className="proof-video" src={playing.videoUrl} controls autoPlay playsInline data-testid="proof-video" />
          <p className="hint">
            Waiting in the <a href="#inbox">Inbox</a>, tagged Proof. Approve it there to post it.
          </p>
        </Sheet>
      )}
    </section>
  );
}

function Run({ run, clips, onPlay }: { run: ProofRun; clips: Clip[]; onPlay: (clip: Clip) => void }) {
  const mine = run.clipIds.map((id) => clips.find((c) => c.id === id)).filter((c): c is Clip => c !== undefined);
  const judged = run.checks.filter((c) => c.target !== "");
  const facts = run.checks.filter((c) => c.target === "");
  const live = run.status === "waiting" || run.status === "running";
  return (
    <div className="proof-run" data-testid="proof-run">
      <div className="proof-run-head">
        <strong>{RUN_NAME[run.target]}</strong>
        <span className={`state ${STATUS_CLASS[run.status]}`}>{STATUS_LABEL[run.status]}</span>
      </div>
      {run.label && <p className="proof-label">{run.label}</p>}
      {(live || run.status === "skipped") && (
        <p className="hint" role="status">
          {run.step || "Waiting for its turn"}
        </p>
      )}
      {run.problems.map((p) => (
        <p key={p.text} className="error" role="alert">
          {p.text}
        </p>
      ))}
      {run.status !== "skipped" && run.status !== "waiting" && (
        <>
          <ul className="proof-checks">
            {judged.map((c) => (
              <li key={c.label} className={c.ok === null ? undefined : c.ok ? "is-ok" : "is-miss"}>
                <span className="proof-check-label">{c.label}</span>
                <span className="proof-check-value">{c.value}</span>
                <span className="proof-check-target">
                  {c.ok === null ? "Target" : c.ok ? "Met" : "Missed"}: {c.target}
                </span>
              </li>
            ))}
          </ul>
          <dl className="proof-facts">
            {facts.map((c) => (
              <div key={c.label}>
                <dt>{c.label}</dt>
                <dd>{c.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {mine.length > 0 && (
        <ul className="proof-clips" aria-label={`Clips of ${RUN_NAME[run.target].toLowerCase()}`}>
          {mine.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onPlay(c)} data-testid="proof-clip">
                <span className="proof-play" aria-hidden="true" />
                <span className="proof-clip-title">{c.title}</span>
                <span className="hint">
                  {Math.round(c.durationSec)} s{c.status === "approved" ? ", approved" : c.status === "rejected" ? ", rejected" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Seven days of clips per hour of video against the target line; a day's colour says met or missed. */
function Week({ days }: { days: ProofDay[] }) {
  const top = Math.max(PROOF_CLIPS_PER_HOUR * 1.5, ...days.map((d) => d.clipsPerHour ?? 0));
  const text = (d: ProofDay) =>
    d.status === "none"
      ? `${weekday(d.day)}: no proof`
      : `${weekday(d.day)}: ${d.status === "passed" ? "met" : "missed"} the target, ${d.clips} clips${d.clipsPerHour === null ? "" : `, ${d.clipsPerHour} per hour of video`}${
          d.minPerHour === null ? "" : `, ${Math.round(d.minPerHour)} min per hour`
        }${d.approved + d.rejected > 0 ? `, ${d.approved} of ${d.approved + d.rejected} approved` : ""}`;
  return (
    <div className="proof-week" data-testid="proof-week">
      <p className="proof-week-title">Last 7 days, clips per hour of video</p>
      <ol style={{ "--target-y": `${(1 - PROOF_CLIPS_PER_HOUR / top) * BAR_REM}rem` } as React.CSSProperties}>
        {days.map((d) => (
          <li key={d.day} className={`proof-day proof-day-${d.status}`} title={text(d)}>
            <span className="proof-bar" style={{ height: `${Math.max(d.status === "none" ? 0 : 6, ((d.clipsPerHour ?? 0) / top) * 100)}%` }} aria-hidden="true" />
            <span className="visually-hidden">{text(d)}</span>
            <span className="proof-day-name" aria-hidden="true">
              {weekday(d.day)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
