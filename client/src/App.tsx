import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { CampaignDraft, CampaignRules, Clip, Job, Pick, Source, Vod, VodDetail } from "../../shared/types";
import { PERMISSION_KIND_LABELS, PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { CampaignForm } from "./CampaignForm";
import { CampaignImport } from "./CampaignImport";
import { CampaignsTab } from "./CampaignsTab";
import { ClipsTab } from "./ClipsTab";
import { DASH_VIEWS, DashboardTab, type DashView } from "./DashboardTab";
import { FaceCamSheet } from "./FaceCamSheet";
import { InboxTab } from "./InboxTab";
import { tabCounts } from "./review";
import { SettingsTab } from "./SettingsTab";
import { StatsTab } from "./StatsTab";
import { SuggestedSheet } from "./SuggestedSheet";
import { WatchlistTab } from "./WatchlistTab";
import { Clips } from "./Clips";
import { clock, shortDate, usd } from "./format";
import { EmptyState, Icon, type IconName, Logo, Skeleton } from "./ui";

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
  "engine-setup": "Engine setup",
  picks: "Picking highlights",
  render: "Cutting a clip",
  "live-segment": "Live segment",
  "render-clip": "New version",
  "hook-variants": "Hook variants",
  "demo-clips": "Demo clips",
};

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "inbox", label: "Inbox" },
  { id: "approved", label: "Approved" },
  { id: "posted", label: "Posted" },
  { id: "sources", label: "Sources" },
  { id: "watchlist", label: "Watchlist" },
  { id: "campaigns", label: "Campaigns" },
  { id: "jobs", label: "Jobs" },
  { id: "stats", label: "Stats" },
] as const satisfies readonly { id: IconName; label: string }[];
/** "rejected" is reached from the inbox, "settings" from the ⋯ in the header: neither is in the tab bar. */
type Tab = (typeof TABS)[number]["id"] | "rejected" | "settings";
// Older links keep working.
const ALIASES: Record<string, Tab> = { clips: "approved" };

function tabFromHash(): Tab {
  // "#dashboard/outputs" opens a section of the dashboard.
  const h = window.location.hash.slice(1).split("/")[0]!;
  if (h === "rejected" || h === "settings" || TABS.some((t) => t.id === h)) return h as Tab;
  return ALIASES[h] ?? "inbox";
}

/** "#settings/twitch" → "twitch". */
function subFromHash(): string | undefined {
  return window.location.hash.slice(1).split("/")[1];
}

function dashViewFromHash(): DashView {
  const v = window.location.hash.slice(1).split("/")[1];
  return DASH_VIEWS.find((d) => d.id === v)?.id ?? "today";
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [dashView, setDashView] = useState<DashView>(dashViewFromHash);
  const [sub, setSub] = useState(subFromHash);
  const [sources, setSources] = useState<Source[]>([]);
  const [vods, setVods] = useState<Vod[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // False until the first answer from the server: screens show loading shapes, not "nothing yet".
  const [loaded, setLoaded] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [suggestedOpen, setSuggestedOpen] = useState(false);
  const [permissionFor, setPermissionFor] = useState<Source | null>(null);
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
      setLoaded(true);
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

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setPermissionFor(null);
    setDraft(null);
  }, []);
  const closeSuggested = useCallback(() => setSuggestedOpen(false), []);
  const closeFaceCam = useCallback(() => setFaceCamFor(null), []);
  const counts = tabCounts(clips, sources, jobs);

  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash());
      setDashView(dashViewFromHash());
      setSub(subFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // A newly opened section starts at its top. On phones the sections are a rail that scrolls
  // sideways: keep the open one in sight.
  useEffect(() => {
    window.scrollTo(0, 0);
    const rail = nav.current;
    const open = rail?.querySelector<HTMLElement>('[aria-current="page"]');
    if (rail && open) rail.scrollTo({ left: open.offsetLeft - (rail.clientWidth - open.offsetWidth) / 2 });
  }, [tab]);

  // The lists below come with the first load; until then they would wrongly say "nothing yet".
  const waiting = !loaded && !loadError;

  return (
    <div className="shell">
      <div className="side">
        <header className="appbar">
          <h1 className="brand">
            <Logo />
            clipfarm
          </h1>
          <a className="more" href="#settings" aria-label="Settings: keys and connections" title="Settings" aria-current={tab === "settings" ? "page" : undefined}>
            <Icon name="settings" size={22} />
          </a>
        </header>

        <nav className="tabs" aria-label="Sections" ref={nav}>
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
              <Icon name={t.id} />
              {t.label}
              {t.id !== "stats" && t.id !== "dashboard" && t.id !== "watchlist" && t.id !== "campaigns" && <span className="count">{counts[t.id]}</span>}
            </a>
          ))}
        </nav>
        <p className="tagline">Streams in, vertical clips out. Only from creators who said yes.</p>
      </div>

      <main className="page">
      {loadError && (
        <p className="error" role="alert">
          Could not reach the server: {loadError}
        </p>
      )}

      {tab === "dashboard" && <DashboardTab view={dashView} clips={clips} sources={sources} jobs={jobs} onCampaignDraft={setDraft} />}
      {tab === "inbox" && (waiting ? <Skeleton shape="frame" /> : <InboxTab clips={clips} sources={sources} jobs={jobs} updateClips={updateClips} refresh={refresh} />)}
      {(tab === "approved" || tab === "posted" || tab === "rejected") &&
        (waiting ? <Skeleton shape="card" count={2} /> : <ClipsTab key={tab} view={tab} clips={clips} sources={sources} onChange={refresh} />)}
      {tab === "stats" && <StatsTab />}
      {tab === "campaigns" && <CampaignsTab sources={sources} sub={sub} />}
      {tab === "settings" && <SettingsTab focus={sub} />}
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
          <CampaignImport onDraft={setDraft} />
          {waiting ? (
            <Skeleton shape="card" count={2} />
          ) : sources.length === 0 ? (
            <EmptyState icon="sources" title="Start with a creator who allows clipping" action={{ label: "Add your first campaign", onClick: () => setFormOpen(true) }}>
              No campaigns yet. A campaign is a creator plus the permission to clip them, from a clipping program like Whop Content
              Rewards. Once it is saved you can paste their stream links.
            </EmptyState>
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
                  onAddPermission={() => setPermissionFor(s)}
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
          {waiting ? (
            <Skeleton shape="rows" count={3} />
          ) : jobs.length === 0 ? (
            <EmptyState icon="jobs" title="Nothing is running" action={{ label: "Paste a stream link", href: "#sources" }}>
              Paste a stream link on a campaign in Sources, and the work of turning it into clips shows up here.
            </EmptyState>
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

      {(formOpen || permissionFor || draft) && (
        <CampaignForm
          source={permissionFor ?? undefined}
          draft={draft ?? undefined}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
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
      </main>
    </div>
  );
}

function SourceCard({
  source,
  vods,
  picks,
  onChange,
  onFaceCam,
  onAddPermission,
}: {
  source: Source;
  vods: Vod[];
  picks: Pick[];
  onChange: () => void;
  onFaceCam: () => void;
  onAddPermission: () => void;
}) {
  const perm = source.permissions.at(-1);
  // A campaign the daily check put on hold is "Paused"; an allowance whose proof is gone "Needs review".
  const paused = source.permissionState === "needs-review" && source.permissions.find((p) => p.reviewReason)?.kind === "whop-campaign";
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
        <span className={`state state-${source.permissionState}`}>{paused ? "Paused" : STATE_LABEL[source.permissionState]}</span>
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
          {perm.rules && <CampaignRulesRows rules={perm.rules} />}
          {perm.kind === "whop-campaign" && perm.campaignUrl && /^https:\/\/([^/]+\.)?(whop|contentrewards)\.com\//.test(perm.campaignUrl) && (
            <div className="wide" data-testid="campaign-check">
              <dt>Campaign page{perm.campaignCheckedAt ? `, last read ${shortDate(perm.campaignCheckedAt)}` : ""}</dt>
              <dd>
                <span className="meta">
                  <span>Read again every day: if it has ended or its budget is out, this creator is paused.</span>
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
          {perm.note && (
            <div className="wide">
              <dt>Testing</dt>
              <dd>{perm.note}</dd>
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
        <button type="button" className="link" onClick={onAddPermission}>
          Add a permission
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
            ? paused
              ? `Paused: ${source.permissions.find((p) => p.reviewReason)?.reviewReason ?? ""} No new streams or posts until then: tap Check again if the campaign is running again, or add a current campaign.`
              : `Needs review: ${source.permissions.find((p) => p.reviewReason)?.reviewReason ?? ""} No new streams or posts until then: tap Check again once the page says it again, or add a current campaign.`
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

/** The campaign's own rules on its card: what a caption must carry, what is banned, how long a clip may be. */
function CampaignRulesRows({ rules }: { rules: CampaignRules }) {
  const must = [...rules.requiredTags, ...rules.requiredLinks, ...rules.requiredText.map((t) => `“${t}”`)];
  const length =
    rules.minSec !== null && rules.maxSec !== null
      ? `${rules.minSec} to ${rules.maxSec} s`
      : rules.maxSec !== null
        ? `${rules.maxSec} s at most`
        : rules.minSec !== null
          ? `${rules.minSec} s at least`
          : null;
  return (
    <>
      {must.length > 0 && (
        <div className="wide">
          <dt>Caption must carry</dt>
          <dd>{must.join(", ")}</dd>
        </div>
      )}
      {rules.bannedWords.length > 0 && (
        <div className="wide">
          <dt>Banned</dt>
          <dd>{rules.bannedWords.join(", ")}</dd>
        </div>
      )}
      {length && (
        <div>
          <dt>Clip length</dt>
          <dd>{length}</dd>
        </div>
      )}
      {rules.budgetLeftUsd !== null && (
        <div>
          <dt>Budget left</dt>
          <dd>{usd(rules.budgetLeftUsd)}</dd>
        </div>
      )}
    </>
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
