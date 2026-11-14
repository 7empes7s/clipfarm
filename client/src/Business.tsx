import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { type BusinessBoard, GROUPS, type GroupBy, type HealthBoard, RANGES, type RangeId } from "../../shared/business";
import { NOT_AVAILABLE } from "../../shared/growth";
import { PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { BarChart, Meter } from "./charts";
import { compact, shortDate, usd } from "./format";
import { EmptyState, Skeleton } from "./ui";

/** A number, or "not available" when nobody gave it: never a 0 that looks real. */
const na = (n: number | null, f: (n: number) => string = compact) => (n === null ? NOT_AVAILABLE : f(n));
const money = (n: number | null) => na(n, usd);
const pct = (n: number | null) => na(n, (v) => `${v} %`);

const METRIC_LABELS: Record<string, string> = {
  views: "views",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saves: "saves",
  reach: "reach",
  avgWatchPct: "watch time",
  followsGained: "followers gained",
  revenueUsd: "platform revenue",
};

/** Opens a clip in Posted, first in the list. */
const clipHref = (clipId: number) => `#posted/clip-${clipId}`;

function Stat({ label, value, lead }: { label: string; value: string; lead?: boolean }) {
  return (
    <div className={lead ? "tile tile-lead" : "tile"}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Downloads({ tables, range }: { tables: { id: string; label: string }[]; range: RangeId }) {
  return (
    <p className="hint biz-csv">
      CSV:{" "}
      {tables.map((t, i) => (
        <span key={t.id}>
          {i > 0 && " · "}
          <a href={`/api/business/export/${t.id}.csv?range=${range}`} download>
            {t.label}
          </a>
        </span>
      ))}
    </p>
  );
}

/** Views, earnings and costs for today, 7 or 30 days, per platform, account, campaign, creator and workspace. */
export function MoneyView({ refreshKey }: { refreshKey: string }) {
  const [range, setRange] = useState<RangeId>("7d");
  const [by, setBy] = useState<GroupBy>("platform");
  const [board, setBoard] = useState<BusinessBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await api.business(range));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [range]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  async function importCsv(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImported(null);
    try {
      const r = await api.importPayouts(await file.text());
      setImported(
        `Read ${r.imported} row${r.imported === 1 ? "" : "s"}: ${r.matched} matched a post${r.unmatched.length ? `, ${r.unmatched.length} did not (posted from somewhere else?)` : ""}.`,
      );
      await load();
    } catch (err) {
      setImported((err as Error).message);
    }
  }

  return (
    <div className="biz" data-testid="money">
      <div className="seg" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
            {r.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!board && !error && <Skeleton shape="tiles" />}
      {board && <Board board={board} by={by} setBy={setBy} />}
      {board && (
        <>
          <h3 className="sub">Campaign results</h3>
          <p className="hint">Content Rewards has no API for clippers: download your submissions as CSV there and add the file here. Approved and paid posts are ticked off.</p>
          <label className="button biz-file">
            Add campaign CSV
            <input type="file" accept=".csv,text/csv" onChange={(e) => void importCsv(e)} />
          </label>
          {imported && <p role="status">{imported}</p>}
          <Downloads
            range={range}
            tables={[
              { id: "posts", label: "Posts" },
              ...GROUPS.map((g) => ({ id: g.id, label: g.label })),
              { id: "campaigns", label: "Campaigns" },
              { id: "costs", label: "Costs" },
            ]}
          />
        </>
      )}
    </div>
  );
}

function Board({ board, by, setBy }: { board: BusinessBoard; by: GroupBy; setBy: (g: GroupBy) => void }) {
  const { totals, money: m, funnel } = board;
  const rows = board.groups[by];
  const steps = [
    { label: "Made", n: funnel.made },
    { label: "Approved", n: funnel.approved },
    { label: "Posted", n: funnel.posted },
    { label: "Paid", n: funnel.paid },
  ];
  return (
    <>
      {board.demo && <p className="hint">Demo data: none of these numbers are real.</p>}
      <dl className="tiles" data-testid="money-tiles">
        <Stat lead label="Views" value={na(totals.views)} />
        <Stat label="Earnings (estimate)" value={usd(m.earningsUsd)} />
        <Stat label="Paid out" value={money(m.paidUsd)} />
        <Stat label="Cost" value={usd(m.costUsd)} />
        <Stat label="Profit (estimate)" value={usd(m.profitUsd)} />
        <Stat label="Per 1,000 views" value={money(m.perThousandUsd)} />
        <Stat label="Cost per approved clip" value={m.costPerApprovedClipUsd === null ? "None approved yet" : usd(m.costPerApprovedClipUsd)} />
        <Stat label="Watch time (average)" value={pct(totals.avgWatchPct)} />
        <Stat label="Likes" value={na(totals.likes)} />
        <Stat label="Shares" value={na(totals.shares)} />
        <Stat label="Comments" value={na(totals.comments)} />
        <Stat label="Followers gained" value={na(totals.followsGained)} />
      </dl>
      {board.days.length > 1 && board.days.some((d) => d.views !== null) && (
        <BarChart points={board.days.map((d) => ({ date: d.date, value: d.views ?? 0 }))} label="Views on each day's posts" />
      )}

      <h3 className="sub">From clip to payout</h3>
      <ol className="funnel" data-testid="funnel">
        {steps.map((s) => (
          <li key={s.label}>
            <span className="funnel-label">{s.label}</span>
            <span className="funnel-bar">
              <span style={{ width: `${funnel.made ? Math.round((s.n / funnel.made) * 100) : 0}%` }} />
            </span>
            <span className="funnel-n">{s.n}</span>
          </li>
        ))}
      </ol>

      <h3 className="sub">Breakdown</h3>
      <div className="seg" role="group" aria-label="Group by">
        {GROUPS.map((g) => (
          <button key={g.id} type="button" aria-pressed={by === g.id} onClick={() => setBy(g.id)}>
            {g.label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="approved" title="No posts in this range" action={{ label: "Post an approved clip", href: "#approved" }}>
          Numbers fill in once posts are out and the platforms report on them.
        </EmptyState>
      ) : (
        <table className="breakdown" data-testid="breakdown">
          <thead>
            <tr>
              <th scope="col">{GROUPS.find((g) => g.id === by)!.label}</th>
              <th scope="col">Views</th>
              <th scope="col">Earned</th>
              <th scope="col">Per 1k</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">
                  {r.label}
                  <span className="hint">
                    {r.posts} post{r.posts === 1 ? "" : "s"}
                  </span>
                </th>
                <td>{na(r.views)}</td>
                <td>{usd(r.earningsUsd)}</td>
                <td>{money(r.perThousandUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="biz-best">
        <div className="card">
          <h3 className="mini">Best clips</h3>
          {board.bestClips.length === 0 ? (
            <p className="hint">None yet: no post has views.</p>
          ) : (
            <ol className="biz-list" data-testid="best-clips">
              {board.bestClips.map((c) => (
                <li key={c.clipId}>
                  <a href={clipHref(c.clipId)}>{c.title}</a>
                  <span className="hint">
                    {compact(c.views)} views · {usd(c.earningsUsd)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="card">
          <h3 className="mini">Best hooks</h3>
          {board.bestHooks.length === 0 ? (
            <p className="hint">None yet.</p>
          ) : (
            <ol className="biz-list">
              {board.bestHooks.map((h) => (
                <li key={h.hook}>
                  <a href={clipHref(h.clipId)}>“{h.hook}”</a>
                  <span className="hint">
                    {compact(h.medianViews)} views (median of {h.posts})
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="card">
          <h3 className="mini">Best posting times</h3>
          {board.bestTimes.length === 0 ? (
            <p className="hint">None yet.</p>
          ) : (
            <ol className="biz-list">
              {board.bestTimes.map((t) => (
                <li key={t.hour}>
                  {localHour(t.hour)}
                  <span className="hint">
                    {compact(t.medianViews)} views (median of {t.posts})
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <h3 className="sub">Money by campaign</h3>
      {m.byCampaign.length === 0 ? (
        <p className="hint">No campaign post in this range.</p>
      ) : (
        <table className="breakdown" data-testid="campaign-money">
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Views</th>
              <th scope="col">OK / no</th>
              <th scope="col">Earned</th>
            </tr>
          </thead>
          <tbody>
            {m.byCampaign.map((c) => (
              <tr key={c.key}>
                <th scope="row">
                  {c.label}
                  <span className="hint">{money(c.perThousandUsd)} per 1k</span>
                </th>
                <td>
                  {na(c.views)}
                  <span className="hint">{na(c.viewsCounted)} counted</span>
                </td>
                <td>
                  {c.approved} / {c.rejected}
                </td>
                <td>
                  {usd(c.earningsUsd)}
                  <span className="hint">{money(c.paidUsd)} paid</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="sub">Costs</h3>
      <ul className="biz-costs" data-testid="costs">
        {m.costLines.map((l) => (
          <li key={l.label}>
            <span>
              {l.label}
              <span className="hint">{l.note}</span>
            </span>
            <strong>{money(l.usd)}</strong>
          </li>
        ))}
        <li>
          <span>Total</span>
          <strong>{usd(m.costUsd)}</strong>
        </li>
      </ul>

      <h3 className="sub">Posts</h3>
      {board.posts.length === 0 ? (
        <p className="hint">No posts in this range.</p>
      ) : (
        <ul className="biz-list biz-posts" data-testid="biz-posts">
          {board.posts.slice(0, 20).map((p) => (
            <li key={p.postId}>
              <a href={clipHref(p.clipId)}>{p.clipTitle}</a>
              <span className="hint">
                {PLATFORM_LABELS[p.platform]} · {p.accountName} · {shortDate(p.postedAt)} · {na(p.views)} views · {usd(p.earningsUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** An hour of the day (UTC) on the phone's clock. */
function localHour(utcHour: number): string {
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const RISK_LABELS = { strike: "Strike", claim: "Claim", removal: "Removed", paused: "Paused", rejected: "Rejected", warning: "Warning" } as const;

/** Pipeline runs, failures, the queue, quota left today and accounts at risk. */
export function HealthView({ refreshKey }: { refreshKey: string }) {
  const [h, setH] = useState<HealthBoard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api.businessHealth().then(
        (x) => {
          setH(x);
          setError(null);
        },
        (err: Error) => setError(err.message),
      );
    }, 0);
    return () => clearTimeout(t);
  }, [refreshKey]);

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!h) return <Skeleton shape="tiles" />;
  return (
    <div className="biz" data-testid="health">
      <dl className="tiles">
        <Stat lead label="Pipeline runs (7 days)" value={String(h.runs.total)} />
        <Stat label="Failed" value={String(h.runs.failed)} />
        <Stat label="In the queue" value={String(h.queueLength)} />
        <Stat label="Posts failed (7 days)" value={String(h.postingFailures.length)} />
      </dl>

      <h3 className="sub">Failures by step</h3>
      {h.failuresByStep.length === 0 ? (
        <p className="hint">No step failed in the last 7 days.</p>
      ) : (
        <ul className="biz-list" data-testid="failures">
          {h.failuresByStep.map((f) => (
            <li key={f.step}>
              <strong>
                {f.step}: {f.failed}
              </strong>
              {f.lastError && <span className="hint">Last: {f.lastError}</span>}
            </li>
          ))}
        </ul>
      )}

      <h3 className="sub">Posting failures</h3>
      {h.postingFailures.length === 0 ? (
        <p className="hint">No post failed in the last 7 days.</p>
      ) : (
        <ul className="biz-list">
          {h.postingFailures.map((f) => (
            <li key={f.postId}>
              <a href={`#approved/clip-${f.clipId}`}>{f.clipTitle}</a>
              <span className="hint">
                {PLATFORM_LABELS[f.platform]} · {f.accountName}: {f.error}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="sub">Quota left today</h3>
      {h.quotas.length === 0 ? (
        <p className="hint">No account with a posting limit is connected.</p>
      ) : (
        <ul className="biz-list" data-testid="quotas">
          {h.quotas.map((q) => (
            <li key={q.key}>
              <span>
                {PLATFORM_LABELS[q.platform]} · {q.label}: <strong>{compact(q.left)}</strong> of {compact(q.limit)} {q.unit} left
              </span>
              <Meter value={q.limit ? q.left / q.limit : null} label={`${q.label} quota left`} />
            </li>
          ))}
        </ul>
      )}

      <h3 className="sub">Accounts at risk</h3>
      {h.atRisk.length === 0 ? (
        <p className="hint">No strikes, claims, warnings or rejected clips.</p>
      ) : (
        <ul className="biz-list" data-testid="at-risk">
          {h.atRisk.map((r) => (
            <li key={r.key}>
              <span>
                <span className="chip-state state-rejected">{RISK_LABELS[r.kind]}</span> {r.accountName}
                {r.platform ? ` · ${PLATFORM_LABELS[r.platform]}` : ""}
              </span>
              <span className="hint">
                {r.clipId !== null ? <a href={clipHref(r.clipId)}>{r.reason}</a> : r.reason}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="sub">Stats from the platforms</h3>
      <ul className="biz-list" data-testid="stats-sources">
        {h.stats.map((s) => {
          const missing = Object.keys(METRIC_LABELS).filter((k) => k !== "revenueUsd" && !s.metrics.includes(k));
          return (
            <li key={s.platform}>
              <strong>{PLATFORM_LABELS[s.platform]}</strong>
              <span className="hint">
                {s.note}
                {s.connected ? ` ${s.callsToday} of ${s.callBudget} calls today.` : ""}
              </span>
              <span className="hint">Gives: {s.metrics.length ? s.metrics.map((k) => METRIC_LABELS[k]).join(", ") : "nothing yet"}</span>
              {missing.length > 0 && (
                <span className="hint">
                  {NOT_AVAILABLE[0]!.toUpperCase() + NOT_AVAILABLE.slice(1)}: {missing.map((k) => METRIC_LABELS[k]).join(", ")}
                </span>
              )}
              {s.lastError && (
                <span className="error" role="alert">
                  {s.lastError}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <Downloads range="7d" tables={[{ id: "health", label: "Health" }]} />
    </div>
  );
}

/** The daily digest as a card on Today: what posted, what earned, what failed, what's next. */
export function DigestCard({ refreshKey }: { refreshKey: string }) {
  const [digest, setDigest] = useState<{ title: string; lines: string[] } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api.growth().then(
        (g) => setDigest(g.digest),
        () => setDigest(null),
      );
    }, 0);
    return () => clearTimeout(t);
  }, [refreshKey]);
  if (!digest) return null;
  return (
    <div className="card biz-digest" data-testid="digest">
      <h3 className="mini">Daily summary</h3>
      <ul>
        {digest.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p className="hint">
        <a href="#dashboard/earnings">Money</a> · <a href="#dashboard/health">Health</a>
      </p>
    </div>
  );
}
