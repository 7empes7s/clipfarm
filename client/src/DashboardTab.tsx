import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type {
  AccountCard,
  AccountHealth,
  AccountRole,
  AccountsInfo,
  Clip,
  DailyPoint,
  Dashboard,
  Job,
  PermissionKind,
  Platform,
  Post,
  Source,
  SetupChecklist,
  VodProgress,
  WatchedCreator,
} from "../../shared/types";
import {
  ACCOUNT_HEALTH_LABELS,
  ACCOUNT_HEALTHS,
  ACCOUNT_ROLE_LABELS,
  ACCOUNT_ROLES,
  PERMISSION_KIND_LABELS,
  PERMISSION_KINDS,
  PLATFORM_LABELS,
  PLATFORMS,
  WATCH_PLATFORM_LABELS,
} from "../../shared/types";
import { EngineCard } from "./EngineCard";
import { GoogleCard } from "./GoogleCard";
import { api } from "./api";
import { BarChart, LineChart, Meter } from "./charts";
import { ExperimentBadge, ExperimentView } from "./Experiment";
import { compact, duration, shortDate, usd } from "./format";
import { LaunchCard } from "./LaunchCard";
import { Sheet } from "./Sheet";
import { Avatar, EmptyState, Icon, Ring, Skeleton, Sparkline } from "./ui";

export const DASH_VIEWS = [
  { id: "today", label: "Today" },
  { id: "progress", label: "Progress" },
  { id: "outputs", label: "Outputs" },
  { id: "accounts", label: "Accounts" },
  { id: "earnings", label: "Earnings" },
  { id: "experiment", label: "Experiment" },
] as const;
export type DashView = (typeof DASH_VIEWS)[number]["id"];

const STAGE_LABEL = { transcript: "Transcript", picks: "Picks", render: "Render" } as const;
const STAGE_STATE_LABEL = { waiting: "Waiting", running: "Running", done: "Done", failed: "Failed" } as const;

/** The dashboard: today's numbers, pipeline progress, every clip, account stats and earnings. */
export function DashboardTab({ view, clips, sources, jobs }: { view: DashView; clips: Clip[]; sources: Source[]; jobs: Job[] }) {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([api.dashboard(), api.posts()]);
      setDash(d);
      setPosts(p);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // Reload whenever the job list changes (App polls it), so progress and tiles stay current.
  const jobsKey = jobs.map((j) => `${j.id}:${j.status}:${Math.round(j.progress * 100)}`).join(",");
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load, jobsKey, clips.length]);

  return (
    <section aria-labelledby="dash-title" className="dash">
      <h2 id="dash-title" className="visually-hidden">
        Dashboard
      </h2>
      <nav className="dash-nav" aria-label="Dashboard sections">
        {DASH_VIEWS.map((v) => (
          <a key={v.id} href={`#dashboard/${v.id}`} aria-current={view === v.id ? "page" : undefined}>
            {v.label}
          </a>
        ))}
      </nav>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view === "today" && <Setup refreshKey={`${clips.length}:${posts.length}:${sources.length}`} />}
      {!dash && !error && (view === "today" || view === "earnings") && <Skeleton shape="tiles" />}
      {!dash && !error && (view === "progress" || view === "experiment") && <Skeleton shape="card" count={2} />}
      {view === "today" && <LaunchCard refreshKey={`${sources.length}:${clips.length}`} />}
      {dash && view === "today" && <Today dash={dash} jobs={jobs} onLoaded={load} />}
      {dash && view === "progress" && <Progress dash={dash} />}
      {view === "outputs" && <Outputs clips={clips} posts={posts} sources={sources} />}
      {view === "accounts" && <Accounts sources={sources} />}
      {dash && view === "earnings" && <Earnings dash={dash} />}
      {dash && view === "experiment" && <ExperimentView report={dash.experiment} posts={posts} onChange={load} />}
    </section>
  );
}

function Today({ dash, jobs, onLoaded }: { dash: Dashboard; jobs: Job[]; onLoaded: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const t = dash.today;
  const making = jobs.find((j) => j.type === "demo-data" && (j.status === "queued" || j.status === "running"));
  const failed = jobs.find((j) => j.type === "demo-data" && j.status === "failed");
  return (
    <>
      {dash.empty && (
        <div className="dash-empty">
          <EmptyState
            icon="dashboard"
            title="Your numbers start with a first stream"
            action={{ label: "Add a campaign", href: "#sources" }}
            extra={
              <>
                <p className="hint">
                  Or look around first with demo data made from test patterns: ten clips, two streams, posts and account stats.
                  None of it can be posted.
                </p>
                {making ? (
                  <p role="status">Making demo data… {Math.round(making.progress * 100)}%</p>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      void api.loadDemoData().then(onLoaded, (err: Error) => setError(err.message));
                    }}
                  >
                    Load demo data
                  </button>
                )}
                {(error ?? failed?.error) && (
                  <p className="error" role="alert">
                    {error ?? failed?.error}
                  </p>
                )}
              </>
            }
          >
            Nothing here yet. Add a campaign and a stream link in Sources: views, clips waiting and earnings fill in from there.
          </EmptyState>
        </div>
      )}
      <dl className="tiles" data-testid="today">
        <Tile lead label={t.viewsTodayFrom === "accounts" ? "Views today" : "Views on today's posts"} value={compact(t.viewsToday)} trend={dash.trends.views} />
        <Tile label="Waiting for review" value={String(t.waiting)} href="#inbox" trend={dash.trends.clips} />
        <Tile label="Earnings this week (estimate)" value={usd(t.earningsWeekUsd)} trend={dash.trends.earnings} />
        <Tile label="Approved, not posted" value={String(t.approved)} href="#approved" />
        <Tile label="Posted today" value={String(t.postedToday)} href="#posted" />
        <Tile label="Cost this week" value={usd(t.costWeekUsd)} />
        <Tile label="Cost per approved clip" value={t.costPerApprovedClipUsd === null ? "None yet" : usd(t.costPerApprovedClipUsd)} />
      </dl>
      {(dash.growth.campaigns.length > 0 || dash.growth.recommendations.length > 0) && (
        <div className="card dash-campaigns" data-testid="dash-campaigns">
          <h3 className="mini">Test campaigns</h3>
          <ul>
            {dash.growth.campaigns.map((c) => (
              <li key={c.campaign.id}>
                <a href={`#campaigns/${c.campaign.id}`}>{c.campaign.name}</a>: {c.campaign.status === "paused" ? "paused, " : ""}day {c.progress.day} of{" "}
                {c.progress.days}, {c.progress.posts} of {c.progress.planned} posts
              </li>
            ))}
            {dash.growth.recommendations.map((r) => (
              <li key={`r${r.id}`}>
                Recommendation: <a href="#campaigns">{r.text}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <EngineCard jobs={jobs} />

      <GoogleCard refreshKey={String(jobs.filter((j) => j.status === "done").length)} />

      <LiveNow />

      <h3 className="sub">Running now</h3>
      {dash.running.length === 0 ? (
        <p className="hint">No job is running. One runs at a time, so the server stays light.</p>
      ) : (
        <ul className="stack" data-testid="running">
          {dash.running.map((j) => (
            <li key={j.jobId} className="job">
              <div className="job-line">
                <span className="job-name">{j.label}</span>
                <span className="job-status">{j.etaSec === null ? `${Math.round(j.progress * 100)}%` : `about ${duration(j.etaSec)} left`}</span>
              </div>
              <Meter value={j.progress} label={`${j.label} progress`} />
              <span className="hint">{j.message}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="hint settings-link">
        <a href="#settings">Keys and connections</a>
      </p>
    </>
  );
}

/** What is left to set up, at the top of the dashboard until every item is done. */
function Setup({ refreshKey }: { refreshKey: string }) {
  const [list, setList] = useState<SetupChecklist | null>(null);
  useEffect(() => {
    let on = true;
    api.setup().then(
      (s) => on && setList(s),
      () => on && setList(null),
    );
    return () => {
      on = false;
    };
  }, [refreshKey]);
  if (!list || list.done) return null;
  const done = list.items.filter((i) => i.done).length;
  const next = list.items.find((i) => !i.done);
  const others = list.items.filter((i) => i !== next);
  return (
    <div className="card setup" data-testid="setup">
      <div className="setup-head">
        <Ring done={done} total={list.items.length} label={`${done} of ${list.items.length} setup steps done`} />
        <div className="setup-next">
          <h3>Finish setting up</h3>
          {next && (
            <>
              <p className="setup-label">{next.label}</p>
              <p className="hint">{next.line}</p>
              <a className="button primary" href={next.href}>
                {next.action}
              </a>
            </>
          )}
        </div>
      </div>
      <details>
        <summary>
          The other steps: {done} done, {list.items.length - done - 1} to do
        </summary>
        <ol className="setup-list">
          {others.map((item) => (
            <li key={item.id} className={item.done ? "setup-done" : undefined}>
              <span className="setup-mark" aria-hidden="true">
                {item.done && <Icon name="approve" size={14} />}
              </span>
              <div className="setup-text">
                <span className="setup-label">
                  {item.label}
                  <span className="visually-hidden">{item.done ? " (done)" : " (to do)"}</span>
                </span>
                <span className="hint">{item.line}</span>
              </div>
              {!item.done && (
                <a className="button" href={item.href}>
                  {item.action}
                </a>
              )}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/** The watched creators as a row of faces, whoever is live first with a pulsing ring. */
function LiveNow() {
  const [creators, setCreators] = useState<WatchedCreator[] | null>(null);
  useEffect(() => {
    let on = true;
    api.watchlist().then(
      (w) => on && setCreators(w.creators),
      () => on && setCreators(null),
    );
    return () => {
      on = false;
    };
  }, []);
  if (creators === null) return null;
  const live = creators.filter((c) => c.live);
  const rest = creators.filter((c) => !c.live);
  return (
    <>
      <h3 className="sub">Live now</h3>
      {creators.length === 0 ? (
        <EmptyState icon="watchlist" title="Nobody to watch yet" action={{ label: "Add a creator", href: "#watchlist" }}>
          Put the streamers you clip on the watchlist. Their new streams are picked up on their own, and you see here who is live.
        </EmptyState>
      ) : (
        <>
          <p className="hint">
            {live.length === 0 ? "Nobody on the " : `${live.length} live on the `}
            <a href="#watchlist">watchlist</a>
            {live.length === 0 ? " is live." : "."}
          </p>
          <ul className="faces" data-testid="dash-live">
            {live.map((c) => (
              <li key={c.id}>
                <a href={c.live!.url} target="_blank" rel="noreferrer" title={c.live!.game ? `${c.live!.game}: ${c.live!.title}` : c.live!.title}>
                  <Avatar name={c.name} live />
                  <span className="who">{c.name}</span>
                  <span className="on-air">
                    Live<span className="visually-hidden"> on {WATCH_PLATFORM_LABELS[c.live!.platform]}</span>
                  </span>
                </a>
              </li>
            ))}
            {rest.map((c) => (
              <li key={c.id}>
                <a href="#watchlist">
                  <Avatar name={c.name} />
                  <span className="who">{c.name}</span>
                  <span className="where">{c.channels[0] ? WATCH_PLATFORM_LABELS[c.channels[0].platform] : "No channel"}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Tile({ label, value, href, trend, lead }: { label: string; value: string; href?: string; trend?: DailyPoint[]; lead?: boolean }) {
  return (
    <div className={lead ? "tile tile-hero tile-lead" : trend ? "tile tile-hero" : "tile"}>
      <dt>{href ? <a href={href}>{label}</a> : label}</dt>
      <dd>{value}</dd>
      {trend && <Sparkline values={trend.map((p) => p.value)} />}
    </div>
  );
}

function Progress({ dash }: { dash: Dashboard }) {
  return (
    <>
      <h3 className="sub">Goals</h3>
      <ul className="goals" data-testid="goals">
        {dash.goals.map((g) => (
          <li key={g.id}>
            <div className="job-line">
              <span className="job-name">
                {g.label} <span className="hint">({g.objective})</span>
              </span>
              <span className="job-status">{g.now}</span>
            </div>
            <Meter value={g.value} label={`${g.label}: ${g.now}, goal ${g.target}`} />
            <span className="hint">Goal: {g.target}</span>
          </li>
        ))}
      </ul>

      <h3 className="sub">Streams</h3>
      {dash.vods.length === 0 ? (
        <EmptyState icon="link" title="No streams yet" action={{ label: "Paste a stream link", href: "#sources" }}>
          Paste a stream link on a campaign in Sources. Its transcript, picks and renders are tracked here, step by step.
        </EmptyState>
      ) : (
        <ul className="stack">
          {dash.vods.map((v) => (
            <VodCard key={v.vodId} vod={v} />
          ))}
        </ul>
      )}
    </>
  );
}

function VodCard({ vod }: { vod: VodProgress }) {
  const total = vod.stages.reduce((s, x) => s + (x.seconds ?? 0), 0);
  return (
    <li className="card" data-testid="vod-progress">
      <div className="card-head">
        <h3>{vod.title}</h3>
      </div>
      <p className="hint">
        {vod.creatorName}
        {vod.durationSec !== null && `, ${duration(vod.durationSec)} long`}
      </p>
      <ol className="stages">
        {vod.stages.map((s) => (
          <li key={s.stage} className={`stage stage-${s.state}`}>
            <span className="stage-name">{STAGE_LABEL[s.stage]}</span>
            <span className="stage-state">
              {s.state === "done" && s.seconds !== null
                ? duration(s.seconds)
                : s.state === "running"
                  ? `${Math.round(s.progress * 100)}%`
                  : STAGE_STATE_LABEL[s.state]}
            </span>
          </li>
        ))}
      </ol>
      <div className="meta">
        <span>{vod.clips} clips made</span>
        <span>{vod.approvedShare === null ? "None approved yet" : `${Math.round(vod.approvedShare * 100)}% approved`}</span>
        {total > 0 && <span>{duration(total)} in all</span>}
      </div>
      {vod.engines.length > 0 && (
        <ul className="vod-engines" data-testid="vod-engines">
          {vod.engines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

type ClipState = "new" | "approved" | "posted" | "rejected";
const CLIP_STATE_LABEL: Record<ClipState, string> = { new: "New", approved: "Approved", posted: "Posted", rejected: "Rejected" };
const DATE_FILTERS = { all: "Any time", today: "Today", week: "Last 7 days", month: "Last 30 days" } as const;
type DateFilter = keyof typeof DATE_FILTERS;

/** Start of the date filter's range, in ms. */
function sinceOf(when: DateFilter): number {
  const now = Date.now();
  return { all: 0, today: new Date().setHours(0, 0, 0, 0), week: now - 7 * 86_400_000, month: now - 30 * 86_400_000 }[when];
}

function clipState(c: Clip): ClipState {
  if (c.postCount > 0) return "posted";
  if (c.status === "approved") return "approved";
  if (c.status === "rejected") return "rejected";
  return "new";
}

function campaignLabel(p: Post): string {
  if (p.experiment) return `${p.creatorName} (experiment)`;
  return p.campaignUrl ? new URL(p.campaignUrl).pathname.replace(/^\/+|\/+$/g, "") || p.creatorName : `${p.creatorName} (direct)`;
}

function Outputs({ clips, posts, sources }: { clips: Clip[]; posts: Post[]; sources: Source[] }) {
  const [creator, setCreator] = useState("");
  const [campaign, setCampaign] = useState("");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [when, setWhen] = useState<DateFilter>("all");
  const [since, setSince] = useState(0);
  const [playing, setPlaying] = useState<Clip | null>(null);
  const closePlayer = useCallback(() => setPlaying(null), []);

  const campaigns = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of posts) m.set(p.permissionId, campaignLabel(p));
    return [...m];
  }, [posts]);

  const shown = useMemo(() => {
    return clips.filter((c) => {
      const mine = posts.filter((p) => p.clipId === c.id && p.status !== "failed");
      if (creator && String(c.sourceId) !== creator) return false;
      if (campaign && !mine.some((p) => String(p.permissionId) === campaign)) return false;
      if (platform && !mine.some((p) => p.platform === platform)) return false;
      const latest = Math.max(new Date(c.createdAt).getTime(), ...mine.map((p) => new Date(p.postedAt ?? p.scheduledAt).getTime()));
      return latest >= since;
    });
  }, [clips, posts, creator, campaign, platform, since]);

  return (
    <>
      <div className="filters" data-testid="output-filters">
        <label>
          Creator
          <select value={creator} onChange={(e) => setCreator(e.target.value)}>
            <option value="">All creators</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.creatorName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Campaign
          <select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value="">All campaigns</option>
            {campaigns.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Platform
          <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform | "")}>
            <option value="">All platforms</option>
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <select value={when} onChange={(e) => {
              const w = e.target.value as DateFilter;
              setWhen(w);
              setSince(sinceOf(w));
            }}>
            {Object.entries(DATE_FILTERS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint" role="status">
        {shown.length} of {clips.length} clips
      </p>
      {shown.length === 0 ? (
        clips.length === 0 ? (
          <EmptyState icon="play" title="No clips yet" action={{ label: "Paste a stream link", href: "#sources" }}>
            Every clip made from your streams is listed here, with where it was posted and its views.
          </EmptyState>
        ) : (
          <EmptyState
            icon="play"
            title="No clips match these filters"
            action={{
              label: "Clear the filters",
              onClick: () => {
                setCreator("");
                setCampaign("");
                setPlatform("");
                setWhen("all");
                setSince(0);
              },
            }}
          >
            Widen the creator, campaign, platform or date to see more.
          </EmptyState>
        )
      ) : (
        <ul className="outputs">
          {shown.map((c) => {
            const state = clipState(c);
            const mine = posts.filter((p) => p.clipId === c.id && p.status !== "failed");
            const views = mine.reduce((s, p) => s + (p.views ?? 0), 0);
            return (
              <li key={c.id} className={`output output-${state}`} data-testid="output">
                <button type="button" className="output-play" aria-label={`Play ${c.title}`} onClick={() => setPlaying(c)}>
                  <Icon name="play" />
                </button>
                <div className="output-body">
                  <div className="job-line">
                    <span className="job-name">{c.title}</span>
                    <span className={`chip-state state-${state}`}>{CLIP_STATE_LABEL[state]}</span>
                  </div>
                  <div className="meta">
                    <span>{sources.find((s) => s.id === c.sourceId)?.creatorName ?? "Unknown creator"}</span>
                    <span>{shortDate(c.createdAt)}</span>
                    {c.experiment && <ExperimentBadge />}
                    {mine.length > 0 && <span>{compact(views)} views</span>}
                  </div>
                  {mine.length > 0 && (
                    <ul className="output-posts">
                      {mine.map((p) => (
                        <li key={p.id}>
                          {p.url ? (
                            <a href={p.url} target="_blank" rel="noreferrer">
                              {PLATFORM_LABELS[p.platform]}
                            </a>
                          ) : (
                            PLATFORM_LABELS[p.platform]
                          )}
                          <span className="hint">
                            {p.views === null ? "no views yet" : `${compact(p.views)} views`}, {campaignLabel(p)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {playing && (
        <Sheet id="player-title" title={playing.title} onClose={closePlayer}>
          <video className="player" src={playing.videoUrl} controls autoPlay playsInline />
        </Sheet>
      )}
    </>
  );
}

function Accounts({ sources }: { sources: Source[] }) {
  const [info, setInfo] = useState<AccountsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const closeSettings = useCallback(() => setEditing(null), []);

  async function sync() {
    setSyncing(true);
    setSyncNote(null);
    try {
      setInfo(await api.syncAccounts());
      setSyncNote("Accounts are up to date.");
    } catch (err) {
      setSyncNote((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    let live = true;
    api.accounts().then(
      (i) => live && setInfo(i),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, []);

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!info) return <Skeleton shape="card" count={2} />;
  const edited = info.cards.find((c) => c.accountId === editing);
  return (
    <>
      <div className="section-head">
        <h3>Posting accounts</h3>
        {info.service !== "none" && (
          <button type="button" onClick={() => void sync()} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync accounts"}
          </button>
        )}
      </div>
      {info.service !== "none" && (
        <p className="hint">
          Create each account yourself and link it once in {info.label}. It shows up here after a sync, and clipfarm posts to it
          from then on.
        </p>
      )}
      {syncNote && (
        <p className="hint" role="status">
          {syncNote}
        </p>
      )}
      {info.service !== "none" && (
        <p className="hint">
          Stats come from {info.label}, read every {info.refreshHours} hours to stay inside its limits.
        </p>
      )}
      {info.error && (
        <p className="error" role="alert">
          {info.error}
        </p>
      )}
      {info.cards.length === 0 ? (
        info.service === "none" ? (
          <EmptyState icon="posted" title="Connect a posting service" action={{ label: "Open Settings", href: "#settings/postiz" }}>
            No accounts yet. Add Postiz or Upload-Post in Settings, and the accounts linked there show up here with their
            stats.
          </EmptyState>
        ) : (
          <EmptyState icon="posted" title="Link your first account" action={{ label: "Look for linked accounts", onClick: () => void sync() }}>
            No accounts yet. Link each TikTok, YouTube or Instagram account once in {info.label}, then sync. clipfarm posts to them from then on.
          </EmptyState>
        )
      ) : (
        <ul className="stack">
          {info.cards.map((c) => (
            <AccountCardView key={c.accountId} card={c} label={info.label} onSaved={setInfo} onSettings={() => setEditing(c.accountId)} />
          ))}
        </ul>
      )}
      {edited?.account && (
        <AccountSheet
          card={edited}
          info={info}
          sources={sources}
          onClose={closeSettings}
          onSaved={(i) => {
            setInfo(i);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/** Whop campaigns in force, to pin to an account: the permission id and "creator · whop.com". */
function whopCampaigns(sources: Source[]): { id: number; label: string }[] {
  const now = Date.now();
  return sources.flatMap((s) =>
    s.permissions
      .filter((p) => p.kind === "whop-campaign" && (!p.expiresAt || new Date(p.expiresAt).getTime() > now))
      .map((p) => ({ id: p.id, label: p.campaignUrl ? `${s.creatorName} · ${new URL(p.campaignUrl).hostname.replace(/^www\./, "")}` : s.creatorName })),
  );
}

/** Role, niche, routing, pace, status and on/off for one posting account. */
function AccountSheet({
  card,
  info,
  sources,
  onClose,
  onSaved,
}: {
  card: AccountCard;
  info: AccountsInfo;
  sources: Source[];
  onClose: () => void;
  onSaved: (i: AccountsInfo) => void;
}) {
  const a = card.account!;
  const [role, setRole] = useState<AccountRole>(a.role);
  const [niche, setNiche] = useState(a.niche);
  const [maxPerDay, setMaxPerDay] = useState(a.maxPerDay === null ? "" : String(a.maxPerDay));
  const [gap, setGap] = useState(a.minGapMinutes === null ? "" : String(a.minGapMinutes));
  const [health, setHealth] = useState<AccountHealth>(a.health);
  const [enabled, setEnabled] = useState(a.enabled);
  const [takes, setTakes] = useState<PermissionKind[]>(a.takes);
  const [pinned, setPinned] = useState<number[]>(a.pinnedCampaignIds);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const campaigns = whopCampaigns(sources);
  const flip = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      onSaved(
        await api.saveAccount(a.id, {
          role,
          niche,
          maxPerDay: maxPerDay === "" ? null : Number(maxPerDay),
          minGapMinutes: gap === "" ? null : Number(gap),
          health,
          enabled,
          takes,
          pinnedCampaignIds: pinned,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <Sheet id="account-sheet-title" title="Account settings" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <p className="hint">
          {a.name} · {PLATFORM_LABELS[a.platform]}
        </p>
        <fieldset>
          <legend>Role</legend>
          <div className="chips">
            {ACCOUNT_ROLES.map((r) => (
              <label key={r} className="chip">
                <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
                {ACCOUNT_ROLE_LABELS[r]}
              </label>
            ))}
          </div>
          <p className="hint">A burner is a throwaway channel for tests. It is never ticked for you when posting.</p>
        </fieldset>
        <label>
          Niche
          <input type="text" maxLength={60} placeholder="GTA VI moments" value={niche} onChange={(e) => setNiche(e.target.value)} />
        </label>
        <p className="hint">Clips that fit the niche are suggested for this account. Empty takes any clip.</p>
        <fieldset>
          <legend>Takes clips from</legend>
          <div className="chips">
            {PERMISSION_KINDS.map((k) => (
              <label key={k} className="chip">
                <input type="checkbox" checked={takes.includes(k)} onChange={() => setTakes(flip(takes, k))} />
                {PERMISSION_KIND_LABELS[k]}
              </label>
            ))}
          </div>
          <p className="hint">
            Clips only post to accounts that take their kind of permission. Tick only Whop campaign to keep this channel for
            campaign clips.
          </p>
        </fieldset>
        {takes.includes("whop-campaign") && campaigns.length > 0 && (
          <fieldset>
            <legend>Whop campaigns pinned here</legend>
            <div className="chips">
              {campaigns.map((c) => (
                <label key={c.id} className="chip">
                  <input type="checkbox" checked={pinned.includes(c.id)} onChange={() => setPinned(flip(pinned, c.id))} />
                  {c.label}
                </label>
              ))}
            </div>
            <p className="hint">
              A pinned campaign posts on {PLATFORM_LABELS[a.platform]} only from this account. Leave all unticked to share
              campaigns between the accounts that take them.
            </p>
          </fieldset>
        )}
        <div className="row">
          <label>
            Posts a day
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="50"
              step="1"
              placeholder={String(info.rules.maxPerDay)}
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
            />
          </label>
          <label>
            Minutes between posts
            <input
              type="number"
              inputMode="numeric"
              min="0"
              max="1440"
              step="1"
              placeholder={String(info.rules.minGapMinutes)}
              value={gap}
              onChange={(e) => setGap(e.target.value)}
            />
          </label>
        </div>
        <p className="hint">
          Empty follows the shared spacing ({info.rules.maxPerDay} a day, {info.rules.minGapMinutes} minutes apart).
        </p>
        <fieldset>
          <legend>Status</legend>
          <div className="chips">
            {ACCOUNT_HEALTHS.map((h) => (
              <label key={h} className="chip">
                <input type="radio" name="health" checked={health === h} onChange={() => setHealth(h)} />
                {ACCOUNT_HEALTH_LABELS[h]}
              </label>
            ))}
          </div>
          <p className="hint">Set by hand: {info.label} does not say. A banned account is skipped when posting.</p>
        </fieldset>
        <label className="chip">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Post to this account
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </Sheet>
  );
}

function AccountCardView({
  card,
  label,
  onSaved,
  onSettings,
}: {
  card: AccountCard;
  label: string;
  onSaved: (i: AccountsInfo) => void;
  onSettings: () => void;
}) {
  const a = card.account;
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const g = card.followersGrowth;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      onSaved(await api.setFollowers(card.accountId, Number(value)));
      setValue("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <li className="card account" data-testid="account-card">
      <div className="card-head">
        <div className="account-name">
          {a?.avatarUrl ? (
            <img className="avatar" src={a.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span className="avatar" aria-hidden="true">
              {card.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <h3>{card.name}</h3>
            {a?.handle && <p className="hint">@{a.handle.replace(/^@/, "")}</p>}
          </div>
        </div>
        <span className="state">{card.demo ? `${PLATFORM_LABELS[card.platform]}, demo` : PLATFORM_LABELS[card.platform]}</span>
      </div>
      {a && (
        <div className="account-tags" data-testid="account-tags">
          <span className={`state role-${a.role}`}>{ACCOUNT_ROLE_LABELS[a.role]}</span>
          <span className={`state health-${a.health}`}>{ACCOUNT_HEALTH_LABELS[a.health]}</span>
          {!a.enabled && <span className="state state-none">Off</span>}
          {a.disabled && <span className="state state-none">Disconnected</span>}
          {a.niche && <span className="hint">{a.niche}</span>}
          {a.takes.length < PERMISSION_KINDS.length && (
            <span className="hint">Takes only: {a.takes.map((k) => PERMISSION_KIND_LABELS[k]).join(", ")}</span>
          )}
          <button type="button" className="link" onClick={onSettings}>
            Settings
          </button>
        </div>
      )}
      {a?.pausedReason && <p className="blocked">{a.pausedReason}</p>}
      <div className="followers">
        <strong>{card.followers === null ? "–" : card.followers.toLocaleString()}</strong>
        <span>
          followers
          {g && (
            <span className={g.change < 0 ? "down" : "up"}>
              {" "}
              {g.change >= 0 ? "+" : ""}
              {g.change.toLocaleString()}
              {g.pct !== null && ` (${g.pct >= 0 ? "+" : ""}${Math.round(g.pct * 1000) / 10}%)`} in {card.followersSeries.length} days
            </span>
          )}
        </span>
        {card.followersSource === "manual" && <span className="hand">Entered by hand</span>}
      </div>
      {card.followersSource === "none" && <p className="hint">{label} has no follower numbers for this account.</p>}
      <LineChart points={card.followersSeries} label="Followers" />
      {card.viewsSource === "none" ? (
        <p className="hint">No views per day from {label} yet.</p>
      ) : (
        <BarChart points={card.viewsPerDay} label="Views per day" />
      )}
      <dl className="stub">
        <div>
          <dt>Average views per post</dt>
          <dd>{card.avgViewsPerPost === null ? "No views yet" : card.avgViewsPerPost.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Posts in 7 days</dt>
          <dd>
            {card.postsLast7Days} of {card.plannedLast7Days} planned
          </dd>
        </div>
        <div>
          <dt>Posts so far</dt>
          <dd>
            {card.posts}, {usd(card.estimatedEarningsUsd)} estimated
          </dd>
        </div>
        <div>
          <dt>Claims or strikes</dt>
          <dd>{card.claims === null ? `Not reported by ${label}` : card.claims.toLocaleString()}</dd>
        </div>
        {a && (
          <div className="wide">
            <dt>Pace</dt>
            <dd>
              Up to {a.pace.maxPerDay} post{a.pace.maxPerDay === 1 ? "" : "s"} a day, {a.pace.minGapMinutes} minutes apart
              {a.maxPerDay === null && a.minGapMinutes === null && " (shared spacing)"}
            </dd>
          </div>
        )}
      </dl>
      <Meter value={card.plannedLast7Days ? card.postsLast7Days / card.plannedLast7Days : null} label="Posting compared with the plan" />
      {card.topClips.length > 0 && (
        <>
          <h4 className="mini">Top clips</h4>
          <ol className="top-clips">
            {card.topClips.map((t, i) => (
              <li key={`${t.clipId}-${i}`}>
                {t.url ? (
                  <a href={t.url} target="_blank" rel="noreferrer">
                    {t.title}
                  </a>
                ) : (
                  t.title
                )}
                <span>{compact(t.views)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {!card.demo && card.followersSource !== "service" && (
        <form className="inline-form" onSubmit={save}>
          <label htmlFor={`followers-${card.accountId}`}>Followers today (by hand)</label>
          <div className="inline">
            <input
              id={`followers-${card.accountId}`}
              type="number"
              inputMode="numeric"
              min={0}
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button type="submit">Save</button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      {card.updatedAt && <p className="hint">Updated {new Date(card.updatedAt).toLocaleString()}</p>}
    </li>
  );
}

function Earnings({ dash }: { dash: Dashboard }) {
  const { rows, weekUsd, totalUsd } = dash.earnings;
  return (
    <>
      <dl className="tiles">
        <Tile label="This week (estimate)" value={usd(weekUsd)} />
        <Tile label="All time (estimate)" value={usd(totalUsd)} />
      </dl>
      <p className="hint">A post earns only once it reaches its campaign's minimum views. Mark posts sent to Whop in Posted.</p>
      {rows.length === 0 ? (
        <EmptyState icon="approved" title="Nothing earned yet" action={{ label: "Post an approved clip", href: "#approved" }}>
          No posts yet. Earnings are estimated from the views of each post and its campaign's pay per 1,000 views.
        </EmptyState>
      ) : (
        <table className="breakdown earnings" data-testid="earnings">
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Views</th>
              <th scope="col">Over min.</th>
              <th scope="col">Payout</th>
              <th scope="col">Whop</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">
                  {r.campaign}
                  <span className="hint">{PLATFORM_LABELS[r.platform]}</span>
                </th>
                <td>{compact(r.views)}</td>
                <td>
                  {r.overMinimum} of {r.posts}
                  {r.minViews !== null && <span className="hint">{compact(r.minViews)} min.</span>}
                </td>
                <td>
                  {usd(r.estimatedUsd)}
                  {r.weekUsd > 0 && <span className="hint">{usd(r.weekUsd)} this week</span>}
                </td>
                <td>
                  {r.submitted} of {r.posts}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
