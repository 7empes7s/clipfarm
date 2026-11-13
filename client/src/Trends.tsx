import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { HookLabInfo, HookTest, TrendGroup, TrendReport } from "../../shared/trends";
import { HOOK_LAB_HOURS, HOOK_PATTERN_LABELS, TREND_WEIGHT_MAX } from "../../shared/trends";
import { api } from "./api";
import { ago, compact } from "./format";

const perHour = (n: number) => `${compact(n)} views an hour`;

/** One tag (a moment type or a hook pattern) with a bar for its share of today's views and its fastest titles. */
function GroupRow<T extends string>({ group, top }: { group: TrendGroup<T>; top: number }) {
  return (
    <li className="trend-row">
      <div className="trend-head">
        <strong>{group.label}</strong>
        <span className="hint">
          {perHour(group.viewsPerHour)}, {group.videos} video{group.videos === 1 ? "" : "s"}
        </span>
      </div>
      <div className="trend-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(4, Math.round((group.viewsPerHour / Math.max(1, top)) * 100))}%` }} />
      </div>
      <ul className="trend-examples">
        {group.examples.map((e) => (
          <li key={e.url}>
            <a href={e.url} target="_blank" rel="noreferrer">
              {e.title}
            </a>
            <span className="hint">
              {e.channel}, {perHour(e.viewsPerHour)}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function Groups<T extends string>({ title, groups, testId }: { title: string; groups: TrendGroup<T>[]; testId: string }) {
  if (groups.length === 0) return null;
  return (
    <>
      <h3 className="sub">{title}</h3>
      <ul className="trend-list" data-testid={testId}>
        {groups.slice(0, 5).map((g) => (
          <GroupRow key={g.tag} group={g} top={groups[0]!.viewsPerHour} />
        ))}
      </ul>
    </>
  );
}

/** The dashboard's Trends view: what GTA clips win today, read from public YouTube numbers. */
export function TrendsView() {
  const [report, setReport] = useState<TrendReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [weight, setWeight] = useState("");

  const show = useCallback((r: TrendReport) => {
    setReport(r);
    setWeight(String(r.boostWeight));
  }, []);
  useEffect(() => {
    let live = true;
    api.trends().then(
      (r) => live && show(r),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [show]);

  const act = (work: Promise<TrendReport>) => {
    setBusy(true);
    setError(null);
    void work.then(show, (err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  const saveWeight = (e: FormEvent) => {
    e.preventDefault();
    act(api.saveTrendWeight(Number(weight)));
  };

  if (!report) {
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : (
      <p className="hint">Loading trends…</p>
    );
  }
  const { quota } = report;
  const left = Math.max(0, Math.floor((quota.dailyBudget - quota.usedToday) / quota.refreshCost));
  return (
    <div data-testid="trends">
      <div className="section-head">
        <h3>What's working today</h3>
        {report.configured && (
          <button type="button" onClick={() => act(api.refreshTrends())} disabled={busy || left === 0}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>
      <p className="hint">
        The fastest GTA VI Shorts of the last 48 hours on YouTube, ranked by views an hour. Only titles, channels and numbers are
        read: no video is downloaded. It refreshes by itself once a day.
      </p>
      {report.note && (
        <p className="empty">
          {report.note} <a href="#settings/youtube">Open Settings</a>
        </p>
      )}
      {report.configured && (
        <p className="hint" data-testid="trend-quota">
          {report.refreshedAt ? `Updated ${ago(report.refreshedAt)}. ` : "Not read yet. "}
          YouTube quota used today: {quota.usedToday.toLocaleString("en")} of {quota.dailyBudget.toLocaleString("en")} units (a refresh
          costs about {quota.refreshCost}, so {left} more today).
          {report.tagger === "keywords" && " Tagged by keywords; with an OpenAI key in Settings, the AI tags them."}
        </p>
      )}
      {(error ?? report.error) && (
        <p className="error" role="alert">
          {error ?? report.error}
        </p>
      )}
      {report.configured && report.videos === 0 && !report.error && <p className="empty">Nothing read yet. Tap Refresh to read today's videos.</p>}

      {report.clipsToPost.length > 0 && (
        <div className="card trend-tips" data-testid="trend-tips">
          <div className="card-head">
            <h3>You have clips of these: post them</h3>
            <a className="button" href="#approved">
              Open Approved
            </a>
          </div>
          <ul>
            {report.clipsToPost.map((c) => (
              <li key={c.clipId}>
                <strong>{c.title}</strong>
                <span className="hint">
                  {c.creatorName}. {c.why}.
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Groups title="Moment types" groups={report.momentTypes} testId="trend-moments" />
      <Groups title="Hook patterns" groups={report.hookPatterns} testId="trend-hooks" />

      {report.streamers.length > 0 && (
        <>
          <h3 className="sub">Fastest-rising streamers and channels</h3>
          <table className="breakdown" data-testid="trend-streamers">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Videos</th>
                <th scope="col">Views an hour</th>
              </tr>
            </thead>
            <tbody>
              {report.streamers.map((s) => (
                <tr key={s.name}>
                  <th scope="row">
                    {s.name}
                    {s.onWatchlist && <span className="hint">On your watchlist</span>}
                  </th>
                  <td>{s.videos}</td>
                  <td>{compact(s.viewsPerHour)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3 className="sub">Into picks</h3>
      <form className="trend-weight" onSubmit={saveWeight}>
        <label>
          Points for a trending moment
          <input type="number" min={0} max={TREND_WEIGHT_MAX} step={1} inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || weight === "" || Number(weight) === report.boostWeight}>
          Save
        </button>
      </form>
      <p className="hint">
        A new pick whose moment type is today's top one gets this many points on its score (out of 100); weaker trends get fewer.
        The pick says why, like "+trend: police chase". 0 switches it off. Today's winning hook patterns are also offered to the
        hook writer.
      </p>
    </div>
  );
}

const TEST_STATE: Record<HookTest["status"], { label: string; className: string }> = {
  rendering: { label: "Making variants", className: "state-idle" },
  running: { label: "On burners", className: "state-idle" },
  done: { label: "Done", className: "state-active" },
  stopped: { label: "Stopped", className: "state-none" },
};

function TestCard({ test }: { test: HookTest }) {
  const state = TEST_STATE[test.status];
  return (
    <li className="card hook-test" data-testid="hook-test">
      <div className="card-head">
        <h3>{test.clipTitle}</h3>
        <span className={`state ${state.className}`}>{state.label}</span>
      </div>
      {test.status === "running" && test.endsAt && <p className="hint">Compared on {new Date(test.endsAt).toLocaleString()}.</p>}
      {test.note && <p className="hook-note">{test.note}</p>}
      <ul className="hook-variants">
        {test.variants.map((v) => (
          <li key={v.id} className={v.winner ? "winner" : undefined}>
            <span className="hook-label" aria-hidden="true">
              {v.label}
            </span>
            <div>
              <strong>
                <span className="visually-hidden">Variant {v.label}: </span>
                {v.hook || "(no hook)"}
                {v.winner && <span className="state state-active">Winner</span>}
              </strong>
              <span className="hint">{v.title}</span>
              <span className="hint">
                {HOOK_PATTERN_LABELS[v.pattern]}, on {v.accountName}
                {v.viewsPerHour !== null ? `: ${perHour(v.viewsPerHour)}` : v.views !== null ? `: ${compact(v.views)} views so far` : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The dashboard's Hook lab view: the switch, the tests and which hook patterns win for us. */
export function HookLabView() {
  const [info, setInfo] = useState<HookLabInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState("");

  const show = useCallback((i: HookLabInfo) => {
    setInfo(i);
    setHours(String(i.settings.hours));
  }, []);
  useEffect(() => {
    let live = true;
    api.hookLab().then(
      (i) => live && show(i),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [show]);

  const act = (work: Promise<HookLabInfo>) => {
    setBusy(true);
    setError(null);
    void work.then(show, (err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  const saveHours = (e: FormEvent) => {
    e.preventDefault();
    act(api.saveHookLab({ hours: Number(hours) }));
  };

  if (!info) {
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : (
      <p className="hint">Loading the hook lab…</p>
    );
  }
  const { settings } = info;
  return (
    <div data-testid="hook-lab">
      <div className="section-head">
        <h3>Hook lab</h3>
        {settings.on && (
          <button type="button" onClick={() => act(api.runHookLab())} disabled={busy}>
            {busy ? "Checking…" : "Check now"}
          </button>
        )}
      </div>
      <p className="hint">
        Tests 2 or 3 hooks for each approved clip: same cut, different hook and title, each on its own burner account. After the
        window, the one with the most views an hour goes to your main accounts. Nothing goes to a main account before that.
      </p>
      <label className="switch">
        <input type="checkbox" role="switch" checked={settings.on} disabled={busy} onChange={(e) => act(api.saveHookLab({ on: e.target.checked }))} />
        Test hooks on burners before posting to main
      </label>
      <p className="hint">
        {settings.on
          ? "On: it runs by itself. Approved clips that are not posted yet are tested, three at a time."
          : "Off: clips are posted only when you post them."}
      </p>
      <form className="trend-weight" onSubmit={saveHours}>
        <label>
          Hours before comparing
          <input type="number" min={HOOK_LAB_HOURS.min} max={HOOK_LAB_HOURS.max} step={1} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || hours === "" || Number(hours) === settings.hours}>
          Save
        </button>
      </form>
      {info.note && (
        <p className="empty">
          {info.note} <a href="#dashboard/accounts">Open Accounts</a>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <h3 className="sub">Scoreboard</h3>
      {info.scoreboard.length === 0 ? (
        <p className="empty">No finished tests yet. The patterns that win for you show up here.</p>
      ) : (
        <table className="breakdown" data-testid="hook-scoreboard">
          <thead>
            <tr>
              <th scope="col">Hook pattern</th>
              <th scope="col">Wins</th>
              <th scope="col">Views an hour</th>
            </tr>
          </thead>
          <tbody>
            {info.scoreboard.map((s) => (
              <tr key={s.pattern}>
                <th scope="row">{s.label}</th>
                <td>
                  {s.wins} of {s.tests}
                </td>
                <td>{compact(s.avgViewsPerHour)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="sub">Tests</h3>
      {info.tests.length === 0 ? (
        <p className="empty">No tests yet. Switch the lab on and approve a clip.</p>
      ) : (
        <ul className="stack">
          {info.tests.map((t) => (
            <TestCard key={t.id} test={t} />
          ))}
        </ul>
      )}
    </div>
  );
}
