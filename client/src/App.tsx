import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Clip, Job, Pick, Source, Vod, VodDetail } from "../../shared/types";
import { PERMISSION_KIND_LABELS, PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { CampaignForm } from "./CampaignForm";
import { ClipsTab } from "./ClipsTab";
import { DASH_VIEWS, DashboardTab, type DashView } from "./DashboardTab";
import { FaceCamSheet } from "./FaceCamSheet";
import { InboxTab } from "./InboxTab";
import { tabCounts } from "./review";
import { StatsTab } from "./StatsTab";
import { SuggestedSheet } from "./SuggestedSheet";
import { WatchlistTab } from "./WatchlistTab";
import { Clips } from "./Clips";
import { clock, shortDate, usd } from "./format";

const STATE_LABEL = { active: "Allowed", "needs-review": "Needs review", expired: "Expired", none: "No permission" } as const;
const VOD_STATUS_LABEL: Record<Vod["status"], string> = {
  queued: "Waiting",
  downloading: "Downloading audio",
  transcribing: "Transcribing",
  ready: "Transcript ready",
  failed: "Failed",
};
const JOB_STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const JOB_TYPE_LABEL: Record<string, string> = {
  ingest: "Transcript",
  picks: "Picking highlights",
  render: "Cutting a clip",
  "render-clip": "New version",
  "demo-clips": "Demo clips",
};

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "inbox", label: "Inbox" },
  { id: "approved", label: "Approved" },
  { id: "posted", label: "Posted" },
  { id: "sources", label: "Sources" },
  { id: "watchlist", label: "Watchlist" },
  { id: "jobs", label: "Jobs" },
  { id: "stats", label: "Stats" },
] as const;
/** "rejected" is reached from the inbox, not the tab bar. */
type Tab = (typeof TABS)[number]["id"] | "rejected";
// Older links keep working.
const ALIASES: Record<string, Tab> = { campaigns: "sources", clips: "approved" };

function tabFromHash(): Tab {
  // "#dashboard/outputs" opens a section of the dashboard.
  const h = window.location.hash.slice(1).split("/")[0]!;
  if (h === "rejected" || TABS.some((t) => t.id === h)) return h as Tab;
  return ALIASES[h] ?? "inbox";
}

function dashViewFromHash(): DashView {
  const v = window.location.hash.slice(1).split("/")[1];
  return DASH_VIEWS.find((d) => d.id === v)?.id ?? "today";
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [dashView, setDashView] = useState<DashView>(dashViewFromHash);
  const [sources, setSources] = useState<Source[]>([]);
  const [vods, setVods] = useState<Vod[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [suggestedOpen, setSuggestedOpen] = useState(false);
  const [faceCamFor, setFaceCamFor] = useState<Source | null>(null);
  // Bumped on every local change to the clips, so a poll that started earlier cannot undo it.
  const clipsEdits = useRef(0);

  const updateClips = useCallback((fn: (c: Clip[]) => Clip[]) => {
    clipsEdits.current++;
    setClips(fn);
  }, []);

  const refresh = useCallback(async () => {
    const edits = clipsEdits.current;
    try {
      const [s, v, j, c, p] = await Promise.all([api.sources(), api.vods(), api.jobs(), api.clips(), api.picks()]);
      setSources(s);
      setVods(v);
      setJobs(j);
      setPicks(p);
      if (edits === clipsEdits.current) setClips(c);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  const busy = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    // Refresh now, then poll: every second while a job is working, else every 5 s.
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), busy ? 1000 : 5000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh, busy]);

  const closeForm = useCallback(() => setFormOpen(false), []);
  const closeSuggested = useCallback(() => setSuggestedOpen(false), []);
  const closeFaceCam = useCallback(() => setFaceCamFor(null), []);
  const counts = tabCounts(clips, sources, jobs);

  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash());
      setDashView(dashViewFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="page">
      <header className="masthead">
        <h1>
          <span className="tally" aria-hidden="true" />
          clipfarm
        </h1>
        <p>Streams in, vertical clips out. Only from creators who said yes.</p>
      </header>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
            {t.label}
            {t.id !== "stats" && t.id !== "dashboard" && t.id !== "watchlist" && <span className="count">{counts[t.id]}</span>}
          </a>
        ))}
      </nav>

      {loadError && (
        <p className="error" role="alert">
          Could not reach the server: {loadError}
        </p>
      )}

      {tab === "dashboard" && <DashboardTab view={dashView} clips={clips} sources={sources} jobs={jobs} />}
      {tab === "inbox" && <InboxTab clips={clips} sources={sources} jobs={jobs} updateClips={updateClips} refresh={refresh} />}
      {(tab === "approved" || tab === "posted" || tab === "rejected") && (
        <ClipsTab key={tab} view={tab} clips={clips} sources={sources} onChange={refresh} />
      )}
      {tab === "stats" && <StatsTab />}
      {tab === "watchlist" && <WatchlistTab sources={sources} onQueued={refresh} />}

      {tab === "sources" && (
        <section aria-labelledby="campaigns-title">
          <div className="section-head">
            <h2 id="campaigns-title">Campaigns</h2>
            <button type="button" className="primary" onClick={() => setFormOpen(true)}>
              Add a campaign
            </button>
          </div>
          <p className="hint">
            Start with creators who already say clipping is allowed.{" "}
            <button type="button" className="link" onClick={() => setSuggestedOpen(true)}>
              Add suggested creators
            </button>
          </p>
          {sources.length === 0 ? (
            <p className="empty">
              No campaigns yet. Add one from a clipping program (like Whop Content Rewards) before adding any stream.
            </p>
          ) : (
            <ul className="stack">
              {sources.map((s) => (
                <SourceCard
                  key={s.id}
                  source={s}
                  vods={vods.filter((v) => v.sourceId === s.id)}
                  picks={picks}
                  onChange={refresh}
                  onFaceCam={() => setFaceCamFor(s)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "jobs" && (
        <section aria-labelledby="jobs-title">
          <h2 id="jobs-title">Jobs</h2>
          <p className="hint">One job at a time, so the server stays light.</p>
          {jobs.length === 0 ? (
            <p className="empty">Nothing running. Add a stream link to a campaign in Sources to start.</p>
          ) : (
            <ul className="jobs">
              {jobs.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  name={vods.find((v) => v.id === j.vodId)?.title ?? vods.find((v) => v.id === j.vodId)?.url ?? clips.find((c) => c.id === j.clipId)?.title}
                  onChange={refresh}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {formOpen && (
        <CampaignForm
          onClose={closeForm}
          onSaved={() => {
            setFormOpen(false);
            void refresh();
          }}
        />
      )}
      {suggestedOpen && (
        <SuggestedSheet
          onClose={closeSuggested}
          onAdded={() => {
            setSuggestedOpen(false);
            void refresh();
          }}
        />
      )}
      {faceCamFor && (
        <FaceCamSheet
          source={faceCamFor}
          clip={clips.find((c) => c.sourceId === faceCamFor.id)}
          onClose={closeFaceCam}
          onSaved={() => {
            setFaceCamFor(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function SourceCard({
  source,
  vods,
  picks,
  onChange,
  onFaceCam,
}: {
  source: Source;
  vods: Vod[];
  picks: Pick[];
  onChange: () => void;
  onFaceCam: () => void;
}) {
  const perm = source.permissions.at(-1);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);

  async function checkAgain(permissionId: number) {
    setChecking(true);
    setCheckNote(null);
    try {
      setCheckNote((await api.checkPermission(permissionId)).message);
      onChange();
    } catch (err) {
      setCheckNote((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function addVod(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.addVod(source.id, url);
      setUrl("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <li className="card" data-testid="campaign">
      <div className="card-head">
        <h3>{source.creatorName}</h3>
        <span className={`state state-${source.permissionState}`}>{STATE_LABEL[source.permissionState]}</span>
      </div>
      {perm && (
        <dl className="stub">
          <div>
            <dt>Via</dt>
            <dd>
              {perm.campaignUrl ? (
                <a href={perm.campaignUrl} target="_blank" rel="noreferrer">
                  {PERMISSION_KIND_LABELS[perm.kind]}
                </a>
              ) : (
                PERMISSION_KIND_LABELS[perm.kind]
              )}
            </dd>
          </div>
          {perm.cpmRateUsd !== null && (
            <div>
              <dt>Pays</dt>
              <dd>{usd(perm.cpmRateUsd)} per 1k views</dd>
            </div>
          )}
          {perm.minViews !== null && (
            <div>
              <dt>Minimum</dt>
              <dd>{perm.minViews.toLocaleString()} views</dd>
            </div>
          )}
          <div>
            <dt>Ends</dt>
            <dd>{perm.expiresAt ? shortDate(perm.expiresAt) : "No end date"}</dd>
          </div>
          <div className="wide">
            <dt>Post to</dt>
            <dd>{perm.allowedPlatforms.map((p) => PLATFORM_LABELS[p]).join(", ")}</dd>
          </div>
          {perm.proofUrl && (
            <div className="wide" data-testid="proof">
              <dt>Proof{perm.proofCheckedAt ? `, last seen ${shortDate(perm.proofCheckedAt)}` : ""}</dt>
              <dd>
                <blockquote className="proof">“{perm.proofQuote}”</blockquote>
                <span className="meta">
                  <a href={perm.proofUrl} target="_blank" rel="noreferrer">
                    See the proof
                  </a>
                  <button type="button" className="link" disabled={checking} onClick={() => void checkAgain(perm.id)}>
                    {checking ? "Checking…" : "Check again"}
                  </button>
                </span>
                {checkNote && (
                  <p className="hint" role="status">
                    {checkNote}
                  </p>
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
      {source.bannedContent && <p className="banned">Off limits: {source.bannedContent}</p>}
      <div className="meta">
        <span>{source.faceCam ? "Face cam set" : "No face cam set"}</span>
        <button type="button" className="link" onClick={onFaceCam}>
          {source.faceCam ? "Change face cam" : "Set face cam"}
        </button>
      </div>

      {source.permissionState === "active" ? (
        <form className="add-vod" onSubmit={addVod}>
          <label htmlFor={`vod-url-${source.id}`}>Stream or video link</label>
          <div className="inline">
            <input
              id={`vod-url-${source.id}`}
              type="url"
              inputMode="url"
              required
              placeholder="https://www.twitch.tv/videos/…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit">Add</button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <p className="blocked">
          {source.permissionState === "needs-review"
            ? `Needs review: ${source.permissions.find((p) => p.reviewReason)?.reviewReason ?? ""} No new streams or posts until the proof is found again: fix it, then tap Check again, or add a current campaign.`
            : `${source.permissionState === "expired" ? "This permission has expired." : "There is no permission yet."} ${
                perm?.proofUrl ? "Tap Check again to read the proof once more, or add" : "Add"
              } a current campaign before adding streams.`}
        </p>
      )}

      {vods.length > 0 && (
        <ul className="vods">
          {vods.map((v) => (
            <VodRow key={v.id} vod={v} picks={picks.filter((p) => p.vodId === v.id)} />
          ))}
        </ul>
      )}
    </li>
  );
}

function VodRow({ vod, picks }: { vod: Vod; picks: Pick[] }) {
  const [detail, setDetail] = useState<VodDetail | null>(null);
  const [open, setOpen] = useState(false);

  async function toggle() {
    if (!open && (!detail || detail.wordCount !== vod.wordCount)) setDetail(await api.vod(vod.id));
    setOpen(!open);
  }

  return (
    <li className="vod" data-testid="vod">
      <div className="vod-title">{vod.title ?? vod.url}</div>
      <div className="meta">
        <span className={`vod-status vod-${vod.status}`}>{VOD_STATUS_LABEL[vod.status]}</span>
        {vod.durationSec !== null && <span>{clock(vod.durationSec)}</span>}
        {vod.status === "ready" && <span>{vod.wordCount} words</span>}
        {vod.transcriptCostUsd !== null && <span>cost {usd(vod.transcriptCostUsd)}</span>}
      </div>
      {vod.status === "ready" && (
        <button type="button" className="link" aria-expanded={open} onClick={() => void toggle()}>
          {open ? "Hide transcript" : "Show transcript"}
        </button>
      )}
      {open && detail && (
        <p className="transcript" data-testid="transcript">
          {detail.words.map((w, i) => (
            <span key={i} title={clock(w.startSec)}>
              {i % 20 === 0 && <time>{clock(w.startSec)}</time>}
              {w.word}{" "}
            </span>
          ))}
        </p>
      )}
      <Clips picks={picks} />
    </li>
  );
}

function JobRow({ job, name, onChange }: { job: Job; name?: string; onChange: () => void }) {
  const active = job.status === "queued" || job.status === "running";
  const kind = JOB_TYPE_LABEL[job.type] ?? "Job";
  return (
    <li className={`job job-${job.status}`} data-testid="job">
      <div className="job-line">
        <span className="job-name">{name ? `${kind}: ${name}` : `${kind} ${job.id}`}</span>
        <span className="job-status">{JOB_STATUS_LABEL[job.status]}</span>
      </div>
      {active && (
        <div className="bar" role="progressbar" aria-valuenow={Math.round(job.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
      )}
      <div className="job-line">
        <span className="hint">{job.error ?? (active ? job.message : "")}</span>
        {active && (
          <button
            type="button"
            className="link"
            onClick={() => {
              void api.cancelJob(job.id).then(onChange);
            }}
          >
            Cancel
          </button>
        )}
        {(job.status === "failed" || job.status === "cancelled") && (
          <button
            type="button"
            className="link"
            onClick={() => {
              void api.retryJob(job.id).then(onChange);
            }}
          >
            Try again
          </button>
        )}
      </div>
    </li>
  );
}
