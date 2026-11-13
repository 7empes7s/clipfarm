import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  CAMPAIGN_STATUS_LABELS,
  type CampaignComparison,
  type CampaignReport,
  type CampaignSummary,
  type Comparison,
  type GrowthCampaign,
  type GrowthCampaignInput,
  type GrowthDefaults,
  type GrowthInfo,
  type Kpis,
  type Recommendation,
  type ReportPost,
  SUCCESS_METRIC_LABELS,
  SUCCESS_METRICS,
  type SuccessMetric,
  TEST_VARIABLE_LABELS,
  TEST_VARIABLES,
  type TestVariable,
} from "../../shared/growth";
import type { ChannelAccount, Source } from "../../shared/types";
import { ACCOUNT_ROLE_LABELS, PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { LinesChart } from "./charts";
import { shortDate, usd } from "./format";
import { rate, shiftTime, shown } from "./growthFormat";
import { Sheet } from "./Sheet";

const pct = (n: number) => `${n}%`;

/** The growth lab: test campaigns, their reports, and what they recommend. "#campaigns/3" opens a report. */
export function CampaignsTab({ sources, sub }: { sources: Source[]; sub?: string }) {
  const [info, setInfo] = useState<GrowthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const reportId = sub && /^\d+$/.test(sub) ? Number(sub) : null;

  const load = useCallback(async () => {
    try {
      setInfo(await api.growth());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const closeForm = useCallback(() => setFormOpen(false), []);

  if (reportId !== null) return <ReportView id={reportId} onChange={load} />;

  return (
    <section aria-labelledby="tests-title" className="growth">
      <div className="section-head">
        <h2 id="tests-title">Test campaigns</h2>
        <button type="button" className="primary" onClick={() => setFormOpen(true)}>
          New campaign
        </button>
      </div>
      <p className="hint">
        A campaign posts approved clips by itself, splits them evenly over the variants you set, and says which one wins once the
        numbers are in.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {info && (
        <>
          {info.recommendations.map((r) => (
            <RecommendationCard key={r.id} rec={r} onChange={setInfo} />
          ))}
          <List campaigns={info.campaigns} onChange={load} />
          <Defaults defaults={info.defaults} />
          <DigestCard info={info} />
        </>
      )}
      {formOpen && info && (
        <CampaignFormSheet
          sources={sources}
          defaults={info.defaults}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            void load();
          }}
        />
      )}
    </section>
  );
}

function progressLine(s: Pick<CampaignSummary, "campaign" | "progress">): string {
  const { campaign: c, progress: p } = s;
  if (c.status === "draft") return `Not started. ${p.planned} posts over ${p.days} ${p.days === 1 ? "day" : "days"}.`;
  return `Day ${p.day} of ${p.days}, ${p.posts} of ${p.planned} posts`;
}

function StatusChip({ campaign }: { campaign: GrowthCampaign }) {
  return <span className={`chip-state run-${campaign.status}`}>{CAMPAIGN_STATUS_LABELS[campaign.status]}</span>;
}

/** Start, Pause and Stop, whichever the campaign's state allows. */
function Controls({ campaign, onChange }: { campaign: GrowthCampaign; onChange: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setConfirmStop(false);
    }
  }
  const { id, status } = campaign;
  if (status === "finished") return null;
  return (
    <>
      <div className="actions">
        {(status === "draft" || status === "paused") && (
          <button type="button" className="primary" disabled={busy} onClick={() => void run(() => api.campaignAction(id, "start"))}>
            {status === "draft" ? "Start" : "Start again"}
          </button>
        )}
        {status === "running" && (
          <button type="button" disabled={busy} onClick={() => void run(() => api.campaignAction(id, "pause"))}>
            Pause
          </button>
        )}
        {status !== "draft" &&
          (confirmStop ? (
            <>
              <button type="button" className="danger" disabled={busy} onClick={() => void run(() => api.campaignAction(id, "stop"))}>
                Stop for good
              </button>
              <button type="button" className="link" onClick={() => setConfirmStop(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="link" onClick={() => setConfirmStop(true)}>
              Stop
            </button>
          ))}
        {status === "draft" && (
          <button type="button" className="link" disabled={busy} onClick={() => void run(() => api.removeCampaign(id))}>
            Delete draft
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** The statistical read as one line: a solid edge for a called winner, a dashed one while it is open. */
function Read({ text, significant }: { text: string; significant: boolean }) {
  return (
    <p className={`read${significant ? " is-called" : ""}`} data-testid="read">
      {text}
    </p>
  );
}

function List({ campaigns, onChange }: { campaigns: CampaignSummary[]; onChange: () => Promise<void> }) {
  const [picked, setPicked] = useState<number[]>([]);
  const [comparison, setComparison] = useState<CampaignComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const comparable = campaigns.filter((c) => c.campaign.status !== "draft");

  async function compare() {
    setError(null);
    try {
      setComparison(await api.compareCampaigns(picked));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (campaigns.length === 0) {
    return (
      <p className="empty">
        No campaigns yet. Start with one question, like "do 20-30 s clips beat 45-60 s clips?", two accounts and a week. To see a
        finished report first, load the demo data from the Dashboard.
      </p>
    );
  }
  return (
    <>
      <ul className="stack">
        {campaigns.map((s) => {
          const c = s.campaign;
          return (
            <li key={c.id} className="card" data-testid="test-campaign">
              <div className="card-head">
                <h3>{c.name}</h3>
                <StatusChip campaign={c} />
              </div>
              {c.hypothesis && <p className="hypothesis">{c.hypothesis}</p>}
              <p className="meta">
                <span>{progressLine(s)}</span>
                <span>Views: {shown(s.totalViews)}</span>
              </p>
              {c.pausedReason && <p className="blocked">{c.pausedReason}</p>}
              {c.note && c.status === "running" && <p className="hint">{c.note}</p>}
              {s.read && <Read text={s.read} significant={!s.read.startsWith("Not enough")} />}
              <Controls campaign={c} onChange={onChange} />
              {c.status !== "draft" && (
                <div className="meta">
                  <a href={`#campaigns/${c.id}`}>Open report</a>
                  {comparable.length > 1 && (
                    <label className="compare-tick">
                      <input
                        type="checkbox"
                        checked={picked.includes(c.id)}
                        onChange={(e) => {
                          setComparison(null);
                          setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id));
                        }}
                      />
                      Compare
                    </label>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {picked.length >= 2 && !comparison && (
        <button type="button" className="compare-go" onClick={() => void compare()}>
          Compare {picked.length} campaigns
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {comparison && (
        <section className="card" aria-labelledby="compare-title" data-testid="comparison">
          <div className="card-head">
            <h3 id="compare-title">Side by side</h3>
            <button type="button" className="close" aria-label="Close the comparison" onClick={() => setComparison(null)}>
              ×
            </button>
          </div>
          {comparison.comparisons.map((c, i) => (
            <Read key={i} text={c.text} significant={c.significant} />
          ))}
          <KpiTable
            first="Campaign"
            metricLabel={comparison.metricLabel}
            rows={comparison.rows.map((r) => ({ key: String(r.id), label: r.name, kpis: r.kpis }))}
          />
        </section>
      )}
    </>
  );
}

function KpiTable({ first, metricLabel, rows }: { first: string; metricLabel: string; rows: { key: string; label: string; kpis: Kpis }[] }) {
  return (
    <>
      <table className="breakdown kpi-table">
        <thead>
          <tr>
            <th scope="col">{first}</th>
            <th scope="col">Posts</th>
            <th scope="col">Median</th>
            <th scope="col">Views</th>
            <th scope="col">Watched</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{r.kpis.posts}</td>
              <td>{shown(r.kpis.medianMetric, rate)}</td>
              <td>{shown(r.kpis.totalViews)}</td>
              <td>{shown(r.kpis.avgWatchPct, pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Median: {metricLabel.toLowerCase()}, over the posts old enough to have it. Watched: average share of the clip.</p>
    </>
  );
}

function changeText(change: Partial<GrowthDefaults>): string {
  const parts: string[] = [];
  if ("clipMinSec" in change || "clipMaxSec" in change) parts.push("the preferred clip length when picking");
  if (change.postTimes) parts.push("the default post times of new campaigns");
  if (change.boostWords) parts.push("the words that rank a pick higher");
  return parts.join(" and ");
}

function RecommendationCard({ rec, onChange }: { rec: Recommendation; onChange: (info: GrowthInfo) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "apply" | "undo" | "dismiss") {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.recommendation(rec.id, action));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className={`recommend${rec.status === "applied" ? " is-applied" : ""}`} data-testid="recommendation" aria-label="Recommendation">
      <h3>{rec.text}</h3>
      <p>{rec.detail}</p>
      <p className="hint">
        From <a href={`#campaigns/${rec.campaignId}`}>{rec.campaignName}</a>. {rec.status === "applied" ? "Applied: it changed" : "Apply changes"}{" "}
        {changeText(rec.change)}.
      </p>
      <div className="actions">
        {rec.status === "open" ? (
          <>
            <button type="button" className="primary" disabled={busy} onClick={() => void act("apply")}>
              Apply
            </button>
            <button type="button" disabled={busy} onClick={() => void act("dismiss")}>
              Dismiss
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => void act("undo")}>
            Undo
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}

/** The defaults recommendations change, so Apply and Undo can be seen to work. */
function Defaults({ defaults: d }: { defaults: GrowthDefaults }) {
  const length =
    d.clipMinSec === null && d.clipMaxSec === null
      ? "No preference yet"
      : d.clipMinSec !== null && d.clipMaxSec !== null
        ? `${d.clipMinSec}-${d.clipMaxSec} s`
        : d.clipMinSec !== null
          ? `${d.clipMinSec} s or longer`
          : `Up to ${d.clipMaxSec} s`;
  return (
    <>
      <h3 className="sub">Defaults in use</h3>
      <dl className="stub defaults" data-testid="defaults">
        <div>
          <dt>Preferred clip length</dt>
          <dd>{length}</dd>
        </div>
        <div>
          <dt>Post times</dt>
          <dd>{d.postTimes.length ? d.postTimes.map((t) => shiftTime(t, "local")).join(", ") : "Spread over the day"}</dd>
        </div>
        <div className="wide">
          <dt>Favoured in picks</dt>
          <dd>{d.boostWords.length ? d.boostWords.join(", ") : "Nothing yet"}</dd>
        </div>
      </dl>
    </>
  );
}

function DigestCard({ info }: { info: GrowthInfo }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  useEffect(() => {
    if (!supported) return;
    let live = true;
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((s) => live && setOn(s !== null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [supported]);

  async function turnOn() {
    setMessage(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        throw new Error("Notifications are blocked for clipfarm. Allow them in the browser's site settings, then tap again.");
      }
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: info.pushKey });
      await api.subscribeDigest({ ...subscription.toJSON(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setOn(true);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function turnOff() {
    setMessage(null);
    try {
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (subscription) {
        await api.unsubscribeDigest(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setOn(false);
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  return (
    <>
      <h3 className="sub">Daily digest</h3>
      <div className="card digest" data-testid="digest">
        <ul>
          {info.digest.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {!supported ? (
          <p className="hint">This browser cannot get notifications. On an iPhone, add clipfarm to the home screen and open it from there.</p>
        ) : on ? (
          <div className="meta">
            <span>Sent to this device every day at 09:00.</span>
            <button type="button" className="link" onClick={() => void turnOff()}>
              Turn off
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => void turnOn()}>
            Send me this every day at 09:00
          </button>
        )}
        {message && (
          <p className="error" role="alert">
            {message}
          </p>
        )}
      </div>
    </>
  );
}

function PostList({ title, posts, metricLabel, testId }: { title: string; posts: ReportPost[]; metricLabel: string; testId: string }) {
  if (posts.length === 0) return null;
  return (
    <>
      <h3 className="sub">{title}</h3>
      <ol className="ranked" data-testid={testId}>
        {posts.map((p) => (
          <li key={p.postId}>
            <div className="ranked-title">
              {p.url ? (
                <a href={p.url} target="_blank" rel="noreferrer">
                  {p.clipTitle}
                </a>
              ) : (
                p.clipTitle
              )}
            </div>
            <div className="meta">
              <span>{p.variantLabel}</span>
              <span>
                {p.accountName}, {PLATFORM_LABELS[p.platform]}
              </span>
              <span>{shown(p.views)} views</span>
              <span>
                {metricLabel}: {shown(p.metric, rate)}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

function ReportView({ id, onChange }: { id: number; onChange: () => Promise<void> }) {
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [info, setInfo] = useState<GrowthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await api.campaignReport(id));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load, info]);

  const back = (
    <a className="back" href="#campaigns">
      Back to all campaigns
    </a>
  );
  if (!report) {
    return (
      <section className="growth">
        {back}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }
  const { campaign: c, kpis: k } = report;
  return (
    <section aria-labelledby="report-title" className="growth report">
      {back}
      <div className="section-head">
        <h2 id="report-title">{c.name}</h2>
        <StatusChip campaign={c} />
      </div>
      {c.hypothesis && <p className="hypothesis">{c.hypothesis}</p>}
      <p className="meta">
        <span>Tests: {TEST_VARIABLE_LABELS[c.variable].toLowerCase()}</span>
        <span>{progressLine(report)}</span>
        {c.startedAt && <span>Started {shortDate(c.startedAt)}</span>}
        {report.platforms.length > 0 && <span>{report.platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}</span>}
      </p>
      {c.pausedReason && <p className="blocked">{c.pausedReason}</p>}
      <Controls
        campaign={c}
        onChange={async () => {
          await Promise.all([load(), onChange()]);
        }}
      />

      {report.comparisons.map((cmp: Comparison, i) => (
        <Read key={i} text={cmp.text} significant={cmp.significant} />
      ))}
      {report.comparisons.length > 0 && c.status !== "finished" && (
        <p className="hint">This is the read so far. A change of defaults is only offered once the campaign has finished and every post is counted.</p>
      )}
      {report.recommendation && (
        <RecommendationCard
          rec={(info?.recommendations.find((r) => r.id === report.recommendation!.id) ?? report.recommendation)}
          onChange={(next) => {
            setInfo(next);
            void onChange();
          }}
        />
      )}

      <dl className="tiles" data-testid="kpis">
        <Tile label="Posts" value={k.scheduled ? `${k.posts} + ${k.scheduled} due` : String(k.posts)} />
        <Tile label="Total views" value={shown(k.totalViews)} />
        <Tile label={`Median ${report.metricLabel.toLowerCase()}`} value={shown(k.medianMetric, rate)} />
        <Tile label="Average watched" value={shown(k.avgWatchPct, pct)} />
        <Tile label="Follows gained" value={shown(k.followsGained)} />
        <Tile label="Earnings (estimate)" value={usd(k.earningsUsd)} />
        <Tile label="Cost per 1k views" value={shown(k.costPer1kViewsUsd, usd)} />
        <Tile label="Cost of the clips" value={shown(k.costUsd, usd)} />
      </dl>
      <p className="hint">
        "Not available" means the platform or the posting service did not give that number. {k.measured} of {k.posts} posts are old
        enough for the median.
      </p>

      <h3 className="sub">Views so far</h3>
      {report.chart.length > 0 ? <LinesChart series={report.chart} label="Total views, day by day" /> : <p className="empty">No views have been read yet.</p>}

      <h3 className="sub">By variant</h3>
      <KpiTable first="Variant" metricLabel={report.metricLabel} rows={report.variants.map((v) => ({ key: v.key, label: v.label, kpis: v }))} />

      <PostList title="Top posts" posts={report.top} metricLabel="Per hour" testId="top-posts" />
      <PostList title="Bottom posts" posts={report.bottom} metricLabel="Per hour" testId="bottom-posts" />

      {k.posts + k.scheduled > 0 && (
        <p className="export">
          <a className="button" href={`/api/growth/campaigns/${c.id}/export.csv`} download>
            Export CSV
          </a>
          <span className="hint">One line per post, with its views at 1 h, 6 h, 24 h, 72 h and 7 days.</span>
        </p>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className={`tile${value === "not available" ? " is-missing" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

interface VariantDraft {
  label: string;
  minSec: string;
  maxSec: string;
  words: string;
  times: string;
}

const STARTERS: Record<TestVariable, VariantDraft[]> = {
  length: [
    { label: "20-30 s", minSec: "20", maxSec: "30", words: "", times: "" },
    { label: "45-60 s", minSec: "45", maxSec: "60", words: "", times: "" },
  ],
  hook: [
    { label: "Question", minSec: "", maxSec: "", words: "?", times: "" },
    { label: "Shout", minSec: "", maxSec: "", words: "!", times: "" },
  ],
  time: [
    { label: "Morning", minSec: "", maxSec: "", words: "", times: "09:00" },
    { label: "Evening", minSec: "", maxSec: "", words: "", times: "19:00" },
  ],
  niche: [
    { label: "Police chases", minSec: "", maxSec: "", words: "police chase", times: "" },
    { label: "Heists", minSec: "", maxSec: "", words: "heist", times: "" },
  ],
};

const list = (text: string) => text.split(",").map((x) => x.trim()).filter(Boolean);
const TIME = /^\d{1,2}:\d{2}$/;
/** Times typed on this device's clock, sent as UTC; anything else goes as typed so the server can say what is wrong. */
const timesToUtc = (text: string) => list(text).map((t) => (TIME.test(t) ? shiftTime(t.padStart(5, "0"), "utc") : t));

function CampaignFormSheet({
  sources,
  defaults,
  onClose,
  onSaved,
}: {
  sources: Source[];
  defaults: GrowthDefaults;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accounts, setAccounts] = useState<ChannelAccount[] | null>(null);
  const [name, setName] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [variable, setVariable] = useState<TestVariable>("length");
  const [variants, setVariants] = useState<VariantDraft[]>(STARTERS.length);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [sourceIds, setSourceIds] = useState<number[]>([]);
  const [postsPerDay, setPostsPerDay] = useState("2");
  const [durationDays, setDurationDays] = useState("7");
  const [times, setTimes] = useState(defaults.postTimes.map((t) => shiftTime(t, "local")).join(", "));
  const [assignment, setAssignment] = useState<"alternate" | "random">("alternate");
  const [metric, setMetric] = useState<SuccessMetric>("vph24");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .posting()
      .then((p) => live && setAccounts(p.accounts.filter((a) => !a.disabled)))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  const setVariant = (i: number, change: Partial<VariantDraft>) => setVariants(variants.map((v, k) => (k === i ? { ...v, ...change } : v)));
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const input: GrowthCampaignInput = {
      name,
      hypothesis,
      sourceIds,
      accountIds,
      postsPerDay: Number(postsPerDay),
      times: variable === "time" ? [] : timesToUtc(times),
      durationDays: Number(durationDays),
      variable,
      variants: variants.map((v, i) => ({
        key: String.fromCharCode(65 + i),
        label: v.label,
        minSec: v.minSec === "" ? null : Number(v.minSec),
        maxSec: v.maxSec === "" ? null : Number(v.maxSec),
        words: list(v.words),
        times: timesToUtc(v.times),
      })),
      assignment,
      metric,
    };
    try {
      await api.addCampaign(input);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <Sheet id="campaign-form-title" title="New test campaign" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Short against long on TikTok" />
        </label>
        <label>
          What do you expect?
          <textarea value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} rows={2} maxLength={300} placeholder="20-30 s clips get more views per hour than 45-60 s clips" />
        </label>
        <label>
          What it tests
          <select
            value={variable}
            onChange={(e) => {
              const v = e.target.value as TestVariable;
              setVariable(v);
              setVariants(STARTERS[v]);
            }}
          >
            {TEST_VARIABLES.map((v) => (
              <option key={v} value={v}>
                {TEST_VARIABLE_LABELS[v]}
              </option>
            ))}
          </select>
        </label>

        <fieldset>
          <legend>Variants</legend>
          <ul className="variants">
            {variants.map((v, i) => (
              <li key={i}>
                <label>
                  Name of variant {String.fromCharCode(65 + i)}
                  <input value={v.label} onChange={(e) => setVariant(i, { label: e.target.value })} maxLength={40} required />
                </label>
                {variable === "length" && (
                  <div className="row">
                    <label>
                      Shortest (s)
                      <input type="number" inputMode="numeric" min={1} max={600} value={v.minSec} onChange={(e) => setVariant(i, { minSec: e.target.value })} />
                    </label>
                    <label>
                      Longest (s)
                      <input type="number" inputMode="numeric" min={1} max={600} value={v.maxSec} onChange={(e) => setVariant(i, { maxSec: e.target.value })} />
                    </label>
                  </div>
                )}
                {(variable === "hook" || variable === "niche") && (
                  <label>
                    {variable === "hook" ? "The hook has any of (commas between)" : "The clip is about any of (commas between)"}
                    <input value={v.words} onChange={(e) => setVariant(i, { words: e.target.value })} />
                  </label>
                )}
                {variable === "time" && (
                  <label>
                    Post at, on your clock (commas between)
                    <input value={v.times} onChange={(e) => setVariant(i, { times: e.target.value })} placeholder="09:00, 12:00" />
                  </label>
                )}
                {variants.length > 2 && (
                  <button type="button" className="link" onClick={() => setVariants(variants.filter((_, k) => k !== i))}>
                    Remove variant {String.fromCharCode(65 + i)}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {variants.length < 4 && (
            <button type="button" className="link" onClick={() => setVariants([...variants, { label: "", minSec: "", maxSec: "", words: "", times: "" }])}>
              Add a variant
            </button>
          )}
        </fieldset>

        <fieldset>
          <legend>Post from</legend>
          {accounts === null ? (
            <p className="hint">Loading accounts…</p>
          ) : accounts.length === 0 ? (
            <p className="hint">No posting account is connected yet. Connect one in Settings first.</p>
          ) : (
            <div className="chips">
              {accounts.map((a) => (
                <label key={a.id} className="chip">
                  <input type="checkbox" checked={accountIds.includes(a.id)} onChange={() => setAccountIds(toggle(accountIds, a.id))} />
                  {a.name} ({PLATFORM_LABELS[a.platform]}, {ACCOUNT_ROLE_LABELS[a.role].toLowerCase()})
                </label>
              ))}
            </div>
          )}
        </fieldset>

        {sources.length > 0 && (
          <fieldset>
            <legend>Clips from</legend>
            <p className="hint">Leave all unticked to use any creator's approved clips.</p>
            <div className="chips">
              {sources.map((s) => (
                <label key={s.id} className="chip">
                  <input type="checkbox" checked={sourceIds.includes(s.id)} onChange={() => setSourceIds(toggle(sourceIds, s.id))} />
                  {s.creatorName}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="row">
          <label>
            Posts per account a day
            <input type="number" inputMode="numeric" min={1} max={12} value={postsPerDay} onChange={(e) => setPostsPerDay(e.target.value)} required />
          </label>
          <label>
            Days
            <input type="number" inputMode="numeric" min={1} max={60} value={durationDays} onChange={(e) => setDurationDays(e.target.value)} required />
          </label>
        </div>
        {variable !== "time" && (
          <label>
            Post at, on your clock
            <input value={times} onChange={(e) => setTimes(e.target.value)} placeholder="Empty: spread over the day" />
            <span className="hint">One time for each post of the day, with commas between, like 09:00, 18:30.</span>
          </label>
        )}
        <div className="row">
          <label>
            Variants take turns
            <select value={assignment} onChange={(e) => setAssignment(e.target.value as "alternate" | "random")}>
              <option value="alternate">In order</option>
              <option value="random">At random</option>
            </select>
          </label>
          <label>
            Judge by
            <select value={metric} onChange={(e) => setMetric(e.target.value as SuccessMetric)}>
              {SUCCESS_METRICS.map((m) => (
                <option key={m} value={m}>
                  {SUCCESS_METRIC_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="hint">
          Either way every variant gets the same number of posts. The campaign is saved as a draft: nothing is posted until you tap
          Start, and every post still needs an approved clip with a permission record.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save as draft"}
        </button>
      </form>
    </Sheet>
  );
}
