import { useCallback, useEffect, useState } from "react";
import type { OpsCheck, OpsInfo, OpsJob, OpsLevel, OpsPost } from "../../shared/ops";
import { PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";
import { Skeleton } from "./ui";

const LEVEL_WORD: Record<OpsLevel, string> = { ok: "OK", warn: "Check", down: "Down", off: "Off" };
const BANNER: Record<OpsLevel, string> = {
  ok: "Everything is running",
  off: "Everything is running",
  warn: "Something needs a look",
  down: "Something is down",
};

/** "3 min", "2 h", "4 d": how long ago. */
function ago(iso: string | null): string {
  if (!iso) return "";
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}

/** For a datetime-local input: the local time, to the minute. */
function localInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Checks({ title, checks }: { title: string; checks: OpsCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <div className="ops-checks">
      <h3>{title}</h3>
      <ul>
        {checks.map((c) => (
          <li key={c.id} className={`ops-check level-${c.level}`} data-check={c.id}>
            <span className="ops-dot" aria-hidden="true" />
            <span className="ops-check-label">{c.label}</span>
            <span className="ops-check-detail">
              <span className="sr-only">{LEVEL_WORD[c.level]}: </span>
              {c.detail}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Confirm {
  title: string;
  line: string;
  button: string;
  run: () => Promise<OpsInfo>;
}

/** Operations: is everything up, and the controls to run the queue, publishing, submits and sources from the phone. */
export function OperationsTab() {
  const [info, setInfo] = useState<OpsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; href?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [moving, setMoving] = useState<{ post: OpsPost; at: string } | null>(null);

  const load = useCallback(async (fresh = false) => {
    try {
      setInfo(await api.ops(fresh));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 5000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  /** Runs one control; the answer is the whole page again. */
  const act = useCallback(async (key: string, run: () => Promise<OpsInfo>, done?: string) => {
    setBusy(key);
    setNotice(null);
    try {
      setInfo(await run());
      setError(null);
      if (done) setNotice({ text: done });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const closeConfirm = useCallback(() => setConfirm(null), []);
  const closeMoving = useCallback(() => setMoving(null), []);

  if (!info) return error ? <p className="error" role="alert">{error}</p> : <Skeleton shape="card" count={3} />;
  const { status, worker, jobs, publishing, campaigns, sources, activity } = info;

  const jobButtons = (j: OpsJob) => (
    <div className="ops-actions">
      {j.canRetry && (
        <button type="button" disabled={busy !== null} onClick={() => void act(`job-${j.id}`, () => api.opsRetryJob(j.id), "Back in the queue.")}>
          Retry
        </button>
      )}
      {j.canMoveTop && (
        <button type="button" disabled={busy !== null} onClick={() => void act(`job-${j.id}`, () => api.opsJobTop(j.id), "Moved to the top.")}>
          Move to top
        </button>
      )}
      {j.canCancel && (
        <button
          type="button"
          className="danger"
          disabled={busy !== null}
          onClick={() => setConfirm({ title: "Cancel this job?", line: `${j.step}${j.what ? `: ${j.what}` : ""}. It stops and leaves the queue. Retry brings it back.`, button: "Cancel the job", run: () => api.opsCancelJob(j.id) })}
        >
          Cancel
        </button>
      )}
    </div>
  );

  const postRow = (p: OpsPost) => (
    <li key={p.id} className="ops-row" data-post={p.id}>
      <div className="ops-row-main">
        <strong>{p.clipTitle}</strong>
        <span className="hint">
          {p.status === "failed" ? `Failed: ${p.error ?? "no reason given"}` : `Goes out ${when(p.scheduledAt)}${p.movable ? "" : " (queued in the posting service)"}`}
        </span>
      </div>
      <div className="ops-actions">
        {p.status === "failed" && (
          <button type="button" disabled={busy !== null} onClick={() => void act(`post-${p.id}`, () => api.opsRetryPost(p.id), "Sent again.")}>
            Retry
          </button>
        )}
        {p.status === "scheduled" && p.movable && (
          <button type="button" disabled={busy !== null} onClick={() => setMoving({ post: p, at: localInput(p.scheduledAt) })}>
            Reschedule
          </button>
        )}
        {(p.status === "failed" || p.movable) && (
          <button
            type="button"
            className="danger"
            disabled={busy !== null}
            onClick={() =>
              setConfirm({
                title: "Skip this post?",
                line: p.status === "failed" ? `${p.clipTitle} on ${p.accountName} leaves the failed list.` : `${p.clipTitle} will not go out on ${p.accountName}.`,
                button: "Skip it",
                run: () => api.opsSkipPost(p.id),
              })
            }
          >
            Skip
          </button>
        )}
      </div>
    </li>
  );

  return (
    <section className="ops" aria-labelledby="ops-title">
      <div className="section-head">
        <h2 id="ops-title">Operations</h2>
        <button type="button" disabled={busy !== null} onClick={() => void act("fresh", () => api.ops(true))}>
          Check again
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ops-notice" role="status">
          {notice.text}{" "}
          {notice.href && (
            <a href={notice.href} target="_blank" rel="noreferrer">
              Open the campaign
            </a>
          )}
        </p>
      )}

      <div className={`card ops-status level-${status.level}`} data-level={status.level}>
        <p className="ops-banner">
          <span className="ops-dot" aria-hidden="true" />
          {BANNER[status.level]}
        </p>
        <p className="hint">
          {status.deploy.sha ? (
            <>
              Live version <code>{status.deploy.sha.slice(0, 7)}</code>, {status.deploy.result === "live" ? "deployed" : status.deploy.result} {ago(status.deploy.at)} ago
              {status.deploy.reason && `: ${status.deploy.reason}`}.
            </>
          ) : (
            "No deploy record on this server (it is not the live box)."
          )}{" "}
          {status.deploy.lastRollback
            ? `Last rollback: ${status.deploy.lastRollback.sha.slice(0, 7)}, ${when(status.deploy.lastRollback.at)}.`
            : "No rollback so far."}
        </p>
        <Checks title="Services" checks={status.services} />
        <Checks title="Room on the server" checks={status.resources} />
        <Checks title="Keys and quota" checks={status.keys} />
        <Checks title="Live proof" checks={[status.proof]} />
        <div className="ops-actions">
          <button type="button" disabled={busy !== null} onClick={() => void act("keys", () => api.opsTestKeys(), "Keys tested.")}>
            Test keys now
          </button>
        </div>
      </div>

      <h2 className="ops-h">Pipeline</h2>
      <div className="card">
        <div className="card-head">
          <p>
            <strong>Job worker:</strong> {worker.paused ? `paused ${ago(worker.since)} ago` : worker.seenAt ? "running" : "not running"}
          </p>
          <button
            type="button"
            className={worker.paused ? "primary" : undefined}
            disabled={busy !== null}
            onClick={() => void act("worker", () => api.opsWorker(!worker.paused), worker.paused ? "Worker resumed." : "Worker paused: the job running now finishes, nothing new starts.")}
          >
            {worker.paused ? "Resume the worker" : "Pause the worker"}
          </button>
        </div>
        {jobs.length === 0 ? (
          <p className="hint">Nothing waiting, running or failed in the last 3 days.</p>
        ) : (
          <ul className="ops-list">
            {jobs.map((j) => (
              <li key={j.id} className={`ops-row job-${j.status}`} data-job={j.id}>
                <div className="ops-row-main">
                  <strong>
                    {j.step}
                    {j.what && <span className="ops-what"> · {j.what}</span>}
                  </strong>
                  <span className="hint">
                    {j.status === "running" ? `Running, ${Math.round(j.progress * 100)}%: ${j.message}` : j.status === "queued" ? "Waiting" : "Failed"} · added {ago(j.createdAt)} ago
                  </span>
                  {j.error && <span className="ops-err">{j.error}</span>}
                </div>
                {jobButtons(j)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2 className="ops-h">Publishing</h2>
      <div className={`card ${publishing.paused ? "ops-paused" : ""}`}>
        <div className="card-head">
          <p>
            <strong>{publishing.paused ? `All publishing paused ${ago(publishing.since)} ago.` : "Publishing is on."}</strong>{" "}
            <span className="hint">{publishing.paused ? "Autopilot rules stay but do not fire; nothing waiting goes out." : "Autopilot and scheduled posts go out on time."}</span>
          </p>
          <button
            type="button"
            className={publishing.paused ? "primary" : "danger"}
            disabled={busy !== null}
            onClick={() =>
              publishing.paused
                ? void act("publishing", () => api.opsPublishing(false), "Publishing is on again.")
                : setConfirm({
                    title: "Pause all publishing?",
                    line: "Autopilot rules stay but do not fire, and posts waiting in clipfarm do not go out until you resume. Posts already queued in the posting service still go out.",
                    button: "Pause all publishing",
                    run: () => api.opsPublishing(true),
                  })
            }
          >
            {publishing.paused ? "Resume publishing" : "Pause all publishing"}
          </button>
        </div>
        {publishing.accounts.length === 0 ? (
          <p className="hint">No posts waiting and none failed in the last 14 days.</p>
        ) : (
          publishing.accounts.map((a) => (
            <div key={`${a.platform}:${a.accountId}`} className="ops-account">
              <h3>
                {a.accountName} <span className="hint">· {PLATFORM_LABELS[a.platform]}</span>
              </h3>
              <ul className="ops-list">
                {a.failed.map(postRow)}
                {a.scheduled.map(postRow)}
              </ul>
            </div>
          ))
        )}
      </div>

      <h2 className="ops-h">Campaigns</h2>
      {campaigns.length === 0 ? (
        <p className="hint">No campaigns yet.</p>
      ) : (
        <ul className="stack">
          {campaigns.map((c) => (
            <li key={c.permissionId} className="card" data-campaign={c.permissionId}>
              <div className="card-head">
                <h3>{c.creatorName}</h3>
                {c.campaignUrl && (
                  <a href={c.campaignUrl} target="_blank" rel="noreferrer">
                    Campaign page
                  </a>
                )}
              </div>
              <p className="hint">
                Submit within {c.windowMin} min of going live · {c.missed} missed{c.lostUsd > 0 ? ` ($${c.lostUsd.toFixed(2)} lost)` : ""} · Sent {c.payout.submitted}, approved {c.payout.approved}, paid {c.payout.paid}
                {c.payout.rejected > 0 ? `, turned down ${c.payout.rejected}` : ""} · About ${c.payout.estimatedUsd.toFixed(2)} earned
              </p>
              {c.open.length > 0 && (
                <ul className="ops-list">
                  {c.open.map((s) => (
                    <li key={s.postId} className="ops-row">
                      <div className="ops-row-main">
                        <strong>{s.clipTitle}</strong>
                        <span className="hint">
                          {s.accountName} · {PLATFORM_LABELS[s.platform]} · due by {when(s.dueBy)}
                        </span>
                      </div>
                      <div className="ops-actions">
                        <button
                          type="button"
                          className="primary"
                          disabled={busy !== null}
                          onClick={() => {
                            if (s.url) void navigator.clipboard?.writeText(s.url).catch(() => undefined);
                            void act(`submit-${s.postId}`, () => api.opsSubmit(s.postId)).then((ok) => {
                              if (ok) setNotice({ text: `Marked as sent${s.url ? "; the post link is copied" : ""}. Paste it on the campaign page.`, href: c.campaignUrl ?? undefined });
                            });
                          }}
                        >
                          Submit now
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2 className="ops-h">Sources</h2>
      {sources.length === 0 ? (
        <p className="hint">No watched streamers yet. Add them under Watchlist.</p>
      ) : (
        <ul className="card ops-list">
          {sources.map((s) => (
            <li key={s.id} className="ops-row" data-source={s.id}>
              <div className="ops-row-main">
                <strong>
                  {s.name}
                  {s.live && <span className="ops-live"> · Live</span>}
                  {s.paused && <span className="ops-what"> · Paused</span>}
                </strong>
                <span className="hint">
                  {s.channels.join(", ")} · {s.permissionState === "active" ? "allowed" : "no active permission"}
                  {s.lastVodTitle ? ` · last video ${ago(s.lastVodAt)} ago` : ""}
                </span>
              </div>
              <div className="ops-actions">
                <button type="button" disabled={busy !== null} onClick={() => void act(`src-${s.id}`, () => api.opsCheckSource(s.id), `${s.name} checked.`)}>
                  {busy === `src-${s.id}` ? "Checking…" : "Check now"}
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void act(`src-${s.id}`, () => api.opsPauseSource(s.id, !s.paused))}>
                  {s.paused ? "Resume" : "Pause"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="ops-h">Activity</h2>
      {activity.length === 0 ? (
        <p className="hint">Nothing done here yet. Every tap on this page is listed with who and when.</p>
      ) : (
        <ol className="card ops-activity">
          {activity.map((a) => (
            <li key={a.id}>
              <span className="hint">{when(a.at)}</span> <strong>{a.who}</strong> {a.action.toLowerCase()}: {a.target}
              {a.detail && <span className="hint"> · {a.detail}</span>}
            </li>
          ))}
        </ol>
      )}

      {confirm && (
        <Sheet id="ops-confirm" title={confirm.title} onClose={closeConfirm}>
          <p>{confirm.line}</p>
          <div className="ops-actions ops-confirm">
            <button type="button" onClick={closeConfirm}>
              Keep it
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy !== null}
              onClick={() => {
                const run = confirm.run;
                setConfirm(null);
                void act("confirm", run, "Done.");
              }}
            >
              {confirm.button}
            </button>
          </div>
        </Sheet>
      )}

      {moving && (
        <Sheet id="ops-move" title="Reschedule" onClose={closeMoving}>
          <p>
            {moving.post.clipTitle} on {moving.post.accountName}. The account's spacing may move it a little later.
          </p>
          <label>
            New time
            <input type="datetime-local" value={moving.at} onChange={(e) => setMoving({ ...moving, at: e.target.value })} />
          </label>
          <div className="ops-actions ops-confirm">
            <button type="button" onClick={closeMoving}>
              Keep the time
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy !== null || !moving.at}
              onClick={() => {
                const { post, at } = moving;
                setMoving(null);
                void act(`post-${post.id}`, () => api.opsReschedule(post.id, new Date(at).toISOString()), "Moved.");
              }}
            >
              Save the time
            </button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
