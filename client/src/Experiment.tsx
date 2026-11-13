import { useState } from "react";
import type { ExperimentReport, ExperimentRow, Post, PostFlag } from "../../shared/types";
import { PLATFORM_LABELS, POST_FLAG_LABELS, POST_FLAGS } from "../../shared/types";
import { api } from "./api";
import { postStatusLabel } from "./ClipsTab";
import { compact, duration, shortDate } from "./format";
import { EmptyState } from "./ui";

/** Marks a clip that may only go to burner accounts. */
export function ExperimentBadge() {
  return (
    <span className="state experiment" title="Posts to burner accounts only">
      Experiment
    </span>
  );
}

const firstClaim = (r: ExperimentRow) => (r.firstClaimSec === null ? "None yet" : `after ${duration(r.firstClaimSec)}`);

/** The dashboard's Experiment view: what the platforms did to clips posted on burner accounts. */
export function ExperimentView({ report, posts, onChange }: { report: ExperimentReport; posts: Post[]; onChange: () => Promise<void> }) {
  const mine = posts.filter((p) => p.experiment && p.status !== "failed");
  const { total } = report;
  return (
    <>
      <p className="hint">
        Clips posted without the creator's permission, on burner accounts only, to see what each platform does. Main accounts,
        exports and Whop never get them.
      </p>
      {total.posts === 0 ? (
        <EmptyState icon="sources" title="No experiment posts yet" action={{ label: "Add an Experiment permission", href: "#sources" }}>
          In Sources, add a permission of the kind Experiment to a creator. In Accounts, mark an account as Burner. Then post an
          approved clip.
        </EmptyState>
      ) : (
        <>
          <Facts row={total} testId="experiment-total" />
          <Rows title="By burner account" rows={report.byAccount} testId="experiment-accounts" />
          <Rows title="By creator" rows={report.byCreator} testId="experiment-creators" />
          <h3 className="sub">Posts</h3>
          <p className="hint">Tap what you saw on the platform. Tap again to take it back. A strike pauses the account.</p>
          <ul className="posts">
            {mine.map((p) => (
              <FlagRow key={p.id} post={p} onChange={onChange} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Facts({ row, testId }: { row: ExperimentRow; testId?: string }) {
  return (
    <dl className="exp-facts" data-testid={testId}>
      <div>
        <dt>Posts</dt>
        <dd>{row.posts}</dd>
      </div>
      <div>
        <dt>Views</dt>
        <dd>{compact(row.views)}</dd>
      </div>
      <div>
        <dt>First claim</dt>
        <dd>{firstClaim(row)}</dd>
      </div>
      <div>
        <dt>Claims</dt>
        <dd>{row.claims}</dd>
      </div>
      <div>
        <dt>Removed</dt>
        <dd>{row.removals}</dd>
      </div>
      <div>
        <dt>Strikes</dt>
        <dd>{row.strikes}</dd>
      </div>
    </dl>
  );
}

function Rows({ title, rows, testId }: { title: string; rows: ExperimentRow[]; testId: string }) {
  return (
    <>
      <h3 className="sub">{title}</h3>
      <ul className="stack" data-testid={testId}>
        {rows.map((r) => (
          <li key={r.key} className="card exp-row">
            <h4>{r.label}</h4>
            {r.pausedReason && <p className="blocked">{r.pausedReason}</p>}
            <Facts row={r} />
          </li>
        ))}
      </ul>
    </>
  );
}

function FlagRow({ post, onChange }: { post: Post; onChange: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);

  async function toggle(flag: PostFlag) {
    setError(null);
    try {
      await api.flagPost(post.id, flag, post.flags[flag] === null);
      await onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <li className={`post post-${post.status}`} data-testid="experiment-post">
      <div className="job-line">
        <span className="job-name">{post.clipTitle}</span>
        <span className="post-status">{postStatusLabel(post)}</span>
      </div>
      <div className="meta">
        <span>{post.creatorName}</span>
        <span>
          {post.accountName}, {PLATFORM_LABELS[post.platform]}
        </span>
        <span>{post.views === null ? "No views yet" : `${compact(post.views)} views`}</span>
        {post.url && (
          <a href={post.url} target="_blank" rel="noreferrer">
            Open post
          </a>
        )}
      </div>
      {post.status === "posted" && (
        <div className="flags">
          {POST_FLAGS.map((f) => (
            <button key={f} type="button" className="flag" aria-pressed={post.flags[f] !== null} onClick={() => void toggle(f)}>
              {POST_FLAG_LABELS[f]}
              {post.flags[f] && <span className="hint">{shortDate(post.flags[f])}</span>}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
