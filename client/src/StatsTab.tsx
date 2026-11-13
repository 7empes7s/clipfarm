import { useCallback, useEffect, useState } from "react";
import type { Post, Stats, StatsRow } from "../../shared/types";
import { PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { postStatusLabel } from "./ClipsTab";
import { usd } from "./format";

export function StatsTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.stats(), api.posts()]);
      setStats(s);
      setPosts(p);
    } catch (err) {
      setMsg((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  async function update() {
    setUpdating(true);
    try {
      const r = await api.refreshPosts();
      setMsg(r.error ?? null);
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <section aria-labelledby="stats-title">
      <div className="section-head">
        <h2 id="stats-title">Stats</h2>
        <button type="button" onClick={() => void update()} disabled={updating}>
          {updating ? "Updating…" : "Update views"}
        </button>
      </div>
      <p className="hint">Views come from the posting service every hour, or by hand. Earnings are estimates: views × the campaign's pay, less Whop's 10% fee on Whop campaigns, once a post passes its minimum views.</p>
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
      {stats && (
        <>
          <dl className="totals" data-testid="totals">
            <div>
              <dt>Posts</dt>
              <dd>{stats.posts}</dd>
            </div>
            <div>
              <dt>Views</dt>
              <dd>{stats.views.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Estimated earnings</dt>
              <dd>{usd(stats.estimatedEarningsUsd)}</dd>
            </div>
            <div>
              <dt>Cost per approved clip</dt>
              <dd>{stats.costPerApprovedClipUsd === null ? "No approved clips yet" : usd(stats.costPerApprovedClipUsd)}</dd>
            </div>
          </dl>
          <Breakdown title="By campaign" rows={stats.byCampaign} />
          <Breakdown title="By platform" rows={stats.byPlatform} />
        </>
      )}
      <h3 className="sub">Posts</h3>
      {posts.length === 0 ? (
        <p className="empty">No posts yet. Approve a clip in Clips, then post it.</p>
      ) : (
        <ul className="stack posts">
          {posts.map((p) => (
            <li key={p.id} className="post" data-testid="stats-post">
              <div className="job-line">
                <span className="job-name">{p.clipTitle}</span>
                <span className="post-status">{postStatusLabel(p)}</span>
              </div>
              <div className="meta">
                <span>
                  {p.accountName} · {PLATFORM_LABELS[p.platform]}
                </span>
                {p.groupName && <span>Group {p.groupName}{p.exitIp && `, left from ${p.exitIp}`}</span>}
                <span>{p.views === null ? "No views yet" : `${p.views.toLocaleString()} views`}</span>
                <span>{usd(p.estimatedEarningsUsd)} estimated</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Breakdown({ title, rows }: { title: string; rows: StatsRow[] }) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="sub">{title}</h3>
      <table className="breakdown">
        <thead>
          <tr>
            <th scope="col">{title.replace("By ", "").replace(/^./, (c) => c.toUpperCase())}</th>
            <th scope="col">Posts</th>
            <th scope="col">Views</th>
            <th scope="col">Earnings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{r.posts}</td>
              <td>{r.views.toLocaleString()}</td>
              <td>{usd(r.estimatedEarningsUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
