import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Clip, Post, PostingInfo, Source, WhopStep } from "../../shared/types";
import { noAccountReason } from "../../shared/routing";
import { submitCountdown, submitTarget } from "./submitFormat";
import { PLATFORM_LABELS, REJECT_REASON_LABELS, WHOP_FEE, WHOP_HOLD_DAYS, WHOP_STEPS } from "../../shared/types";
import { api } from "./api";
import { ExperimentBadge } from "./Experiment";
import { ExportSheet } from "./ExportSheet";
import { LiveTag } from "./LiveTag";
import { allowedPlatforms, PostSheet } from "./PostSheet";
import { ThumbSheet } from "./ThumbSheet";
import { QualityChips } from "./QualityChips";
import { shortDate, usd } from "./format";
import { filterClips } from "./review";
import { EmptyState } from "./ui";

const CLIP_STATUS_LABEL: Record<Clip["status"], string> = {
  pending: "To review",
  approved: "Approved",
  rejected: "Rejected",
  rendering: "Being remade",
};

const VIEW_TEXT = {
  approved: {
    title: "Approved",
    icon: "approved",
    emptyTitle: "Nothing waiting to post",
    empty: "No approved clips waiting to post. Approve clips in the Inbox and they line up here, ready to post.",
    action: { label: "Review the inbox", href: "#inbox" },
  },
  posted: {
    title: "Posted",
    icon: "posted",
    emptyTitle: "Nothing posted yet",
    empty: "Post an approved clip to see it here, with its link and views on each platform.",
    action: { label: "Go to approved clips", href: "#approved" },
  },
  rejected: {
    title: "Rejected",
    icon: "reject",
    emptyTitle: "No rejected clips",
    empty: "Clips you reject in the Inbox are kept here with the reason, so you can bring one back.",
    action: { label: "Back to the inbox", href: "#inbox" },
  },
} as const;

const WHOP_STEP_DO: Record<WhopStep, string> = { submitted: "Mark sent to Whop", approved: "Mark approved", paid: "Mark paid" };
const WHOP_STEP_DONE: Record<WhopStep, string> = { submitted: "Sent to Whop", approved: "Approved", paid: "Paid" };

export function postStatusLabel(p: Post): string {
  if (p.status === "posted") return "Posted";
  if (p.status === "failed") return "Failed";
  return new Date(p.scheduledAt).getTime() > Date.now() ? `Scheduled ${shortTime(p.scheduledAt)}` : "Posting…";
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "No account takes “Whop campaign” clips yet": why an approved clip has nowhere to post, or null. */
function routingGap(source: Source | undefined, info: PostingInfo | null): string | null {
  return source && info ? noAccountReason(source.permissions, info.accounts, new Date()) : null;
}

/** The Approved, Posted and Rejected lists: posting, export, views and Whop tracking. */
export function ClipsTab({
  view,
  clips: allClips,
  sources,
  onChange,
  focus,
}: {
  view: keyof typeof VIEW_TEXT;
  clips: Clip[];
  sources: Source[];
  onChange: () => Promise<void>;
  /** "submit-12": the post a push notification opened, shown first with Submit to Whop ready. */
  focus?: string;
}) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [info, setInfo] = useState<PostingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skippedNote, setSkippedNote] = useState<string | null>(null);
  const [posting, setPosting] = useState<Clip | null>(null);
  const [exporting, setExporting] = useState<Clip | null>(null);
  const [thumbsOf, setThumbsOf] = useState<Clip | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [, p] = await Promise.all([onChange(), api.posts()]);
      setPosts(p);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [onChange]);

  useEffect(() => {
    const first = setTimeout(() => {
      void refresh();
      void api.posting().then(setInfo, (err: Error) => setError(err.message));
    }, 0);
    return () => clearTimeout(first);
  }, [refresh]);

  const closePost = useCallback(() => setPosting(null), []);
  const closeExport = useCallback(() => setExporting(null), []);
  const closeThumbs = useCallback(() => setThumbsOf(null), []);
  const target = submitTarget(focus);
  const targetClip = posts.find((p) => p.id === target)?.clipId;
  // The clip a push opened comes first.
  const clips = filterClips(allClips, view).sort((a, b) => Number(b.id === targetClip) - Number(a.id === targetClip));

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section aria-labelledby="clips-title">
      <h2 id="clips-title">{VIEW_TEXT[view].title}</h2>
      {view !== "rejected" && info && (
        <p className="hint">
          {info.service === "none"
            ? "No posting service is set up: use Export to post by hand."
            : `Posting through ${info.label}, ${info.accounts.length} account${info.accounts.length === 1 ? "" : "s"} connected.`}
        </p>
      )}
      {view !== "rejected" && info && <RulesForm info={info} onSaved={(rules) => setInfo({ ...info, rules })} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {skippedNote && (
        <p className="hint" role="status">
          {skippedNote}
        </p>
      )}
      {clips.length === 0 ? (
        <EmptyState icon={VIEW_TEXT[view].icon} title={VIEW_TEXT[view].emptyTitle} action={VIEW_TEXT[view].action}>
          {VIEW_TEXT[view].empty}
        </EmptyState>
      ) : (
        <ul className="stack">
          {clips.map((clip) => {
            const source = sources.find((s) => s.id === clip.sourceId);
            const clipPosts = posts.filter((p) => p.clipId === clip.id);
            const gap = clip.status === "approved" ? routingGap(source, info) : null;
            return (
              <li key={clip.id} className="card clip" data-testid="clip">
                <video className="clip-video" src={clip.videoUrl} controls playsInline preload="metadata" />
                <div className="clip-body">
                  <div className="card-head">
                    <h3>{clip.title}</h3>
                    <span className={`state clip-${clip.status}`}>{CLIP_STATUS_LABEL[clip.status]}</span>
                  </div>
                  <p className="hint">
                    {source?.creatorName ?? "Unknown creator"} · {Math.round(clip.durationSec)} s
                    {clip.rejectReason && ` · ${REJECT_REASON_LABELS[clip.rejectReason]}`}
                  </p>
                  <LiveTag clip={clip} short />
                  {clip.experiment && (
                    <p className="hint exp-line">
                      <ExperimentBadge /> Burner accounts only, no export.
                    </p>
                  )}
                  <QualityChips clip={clip} onFixed={() => void refresh()} />
                  {gap && (
                    <p className="hint" data-testid="routing-gap">
                      {gap}
                    </p>
                  )}
                  <div className="actions">
                    {clip.status !== "approved" && (
                      <button type="button" className="primary" onClick={() => void act(() => api.approveClip(clip.id))}>
                        Approve
                      </button>
                    )}
                    {clip.status === "approved" && (
                      <>
                        <button type="button" className="primary" onClick={() => setPosting(clip)} disabled={!info}>
                          Post
                        </button>
                        {!clip.experiment && (
                          <button type="button" onClick={() => setExporting(clip)}>
                            Export
                          </button>
                        )}
                        <button type="button" onClick={() => setThumbsOf(clip)}>
                          Thumbnail
                        </button>
                      </>
                    )}
                    {clip.postCount === 0 && (
                      <a className="button" href={`#studio/${clip.id}`}>
                        Studio
                      </a>
                    )}
                    {clip.status !== "rejected" && clip.postCount === 0 && (
                      <button type="button" onClick={() => void act(() => api.rejectClip(clip.id))}>
                        Reject
                      </button>
                    )}
                  </div>
                  {clipPosts.length > 0 && (
                    <ul className="posts">
                      {clipPosts.map((p) => (
                        <PostRow key={p.id} post={p} onChange={refresh} opened={p.id === target} />
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {posting && info && (
        <PostSheet
          clip={posting}
          info={info}
          gap={routingGap(sources.find((s) => s.id === posting.sourceId), info)}
          onClose={closePost}
          onPosted={(skipped) => {
            setPosting(null);
            setSkippedNote(skipped.length > 0 ? skipped.map((s) => s.reason).join(" ") : null);
            void refresh();
            void api.posting().then(setInfo);
          }}
        />
      )}
      {thumbsOf && <ThumbSheet clip={thumbsOf} onClose={closeThumbs} />}
      {exporting && (
        <ExportSheet
          clip={exporting}
          platforms={allowedPlatforms(sources.find((s) => s.id === exporting.sourceId))}
          onClose={closeExport}
        />
      )}
    </section>
  );
}

/** The 30 minutes a campaign post has to be submitted in, counting down on its card. */
function SubmitCountdownLine({ post }: { post: Post }) {
  const [now, setNow] = useState(() => Date.now());
  const running = post.submit?.dueBy != null && !post.submit.missedAt && !post.whopSubmittedAt;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const countdown = submitCountdown(post, now);
  if (!countdown) return null;
  return (
    <p className={`submit-countdown submit-${countdown.state}`} role={countdown.state === "missed" ? undefined : "timer"} data-testid="submit-countdown">
      {countdown.text}
    </p>
  );
}

function PostRow({ post, onChange, opened = false }: { post: Post; onChange: () => void; opened?: boolean }) {
  const row = useRef<HTMLLIElement>(null);
  const [editing, setEditing] = useState(false);
  const [views, setViews] = useState(String(post.views ?? ""));
  const [note, setNote] = useState<string | null>(null);

  async function saveViews(e: FormEvent) {
    e.preventDefault();
    try {
      await api.setViews(post.id, Number(views));
      setEditing(false);
      onChange();
    } catch (err) {
      setNote((err as Error).message);
    }
  }

  const whopAt = { submitted: post.whopSubmittedAt, approved: post.whopApprovedAt, paid: post.whopPaidAt };

  async function whop(step: WhopStep, on: boolean) {
    try {
      await api.markWhop(post.id, step, on);
      setNote(null);
      onChange();
    } catch (err) {
      setNote((err as Error).message);
    }
  }

  async function copyLink() {
    if (!post.url) return;
    try {
      await navigator.clipboard.writeText(post.url);
      setNote("Link copied. Paste it in the Whop campaign, then mark it sent.");
    } catch {
      setNote(`Copy this link into Whop: ${post.url}`);
    }
  }

  // Opened from the push: in sight, with the link already copied where the browser allows it without a tap.
  const postUrl = post.url;
  useEffect(() => {
    if (!opened) return;
    row.current?.scrollIntoView({ block: "center" });
    if (!postUrl || post.whopSubmittedAt) return;
    navigator.clipboard?.writeText(postUrl).then(
      () => setNote("Link copied. Tap Submit to Whop, paste it there, then mark it sent."),
      () => setNote("Tap Submit to Whop: it copies the link and opens the campaign."),
    );
    // Once per opening, not on every refresh of the post.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, postUrl]);

  return (
    <li ref={row} className={`post post-${post.status}${opened ? " post-opened" : ""}`} data-testid="post">
      <div className="job-line">
        <span className="job-name">
          {post.accountName} · {PLATFORM_LABELS[post.platform]}
        </span>
        <span className="post-status">{postStatusLabel(post)}</span>
      </div>
      {post.error && <p className="hint">{post.error}</p>}
      {post.note && <p className="hint">{post.note}</p>}
      {post.groupName && (
        <p className="hint" data-testid="post-group">
          Group {post.groupName}
          {post.exitIp && `, left from ${post.exitIp}`}
        </p>
      )}
      {post.url && (
        <a className="post-url" href={post.url} target="_blank" rel="noreferrer">
          {post.url}
        </a>
      )}
      <div className="meta">
        <span>{post.views === null ? "No views yet" : `${post.views.toLocaleString()} views${post.viewsSource === "manual" ? " (entered by hand)" : ""}`}</span>
        <button type="button" className="link" onClick={() => setEditing(!editing)}>
          {editing ? "Cancel" : "Enter views"}
        </button>
      </div>
      {editing && (
        <form className="inline" onSubmit={saveViews}>
          <input
            aria-label="Views"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            required
            value={views}
            onChange={(e) => setViews(e.target.value)}
          />
          <button type="submit">Save</button>
        </form>
      )}
      {post.proofUrl && (
        <div className="meta">
          <a href={post.proofUrl} target="_blank" rel="noreferrer">
            Proof that clipping is allowed
          </a>
        </div>
      )}
      {post.status === "posted" && post.campaignUrl && (
        <div className="whop" data-testid="whop">
          <SubmitCountdownLine post={post} />
          {!post.whopSubmittedAt && (
            <div className="meta">
              {/* One tap: the post's link is copied, and the campaign opens to paste it in. */}
              <a className={opened ? "submit-now" : undefined} href={post.campaignUrl} target="_blank" rel="noreferrer" onClick={() => void copyLink()}>
                Submit to Whop
              </a>
              <button type="button" className="link" onClick={() => void copyLink()} disabled={!post.url}>
                Copy link for Whop
              </button>
            </div>
          )}
          <ol className="whop-steps" aria-label="Whop payout steps">
            {WHOP_STEPS.map((step, i) => {
              const at = whopAt[step];
              const before = i === 0 || whopAt[WHOP_STEPS[i - 1]!] !== null;
              const last = at !== null && (i === WHOP_STEPS.length - 1 || whopAt[WHOP_STEPS[i + 1]!] === null);
              return (
                <li key={step} className={at ? "done" : undefined}>
                  {at ? (
                    <span>
                      {WHOP_STEP_DONE[step]} on {shortDate(at)}
                      {step === "submitted" && `, posted by ${post.accountName}`}
                    </span>
                  ) : (
                    <button type="button" className="link" disabled={!before} onClick={() => void whop(step, true)}>
                      {WHOP_STEP_DO[step]}
                    </button>
                  )}
                  {last && (
                    <button type="button" className="link" onClick={() => void whop(step, false)} aria-label={`Undo: ${WHOP_STEP_DONE[step]}`}>
                      Undo
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="hint">
            {usd(post.estimatedEarningsUsd)} estimated after Whop's {Math.round(WHOP_FEE * 100)}% fee.{" "}
            {post.whopPaidAt
              ? "Paid out."
              : post.whopPayoutAt
                ? `Whop holds payouts about ${WHOP_HOLD_DAYS} days after approval: due around ${shortDate(post.whopPayoutAt)}.`
                : `Whop holds payouts about ${WHOP_HOLD_DAYS} days after it approves a clip.`}
          </p>
        </div>
      )}
      {note && <p className="hint">{note}</p>}
    </li>
  );
}

function RulesForm({ info, onSaved }: { info: PostingInfo; onSaved: (rules: PostingInfo["rules"]) => void }) {
  const [maxPerDay, setMax] = useState(String(info.rules.maxPerDay));
  const [gap, setGap] = useState(String(info.rules.minGapMinutes));
  const [msg, setMsg] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      onSaved(await api.saveRules({ maxPerDay: Number(maxPerDay), minGapMinutes: Number(gap) }));
      setMsg("Saved.");
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <details className="rules">
      <summary>Spacing between posts</summary>
      <form className="form" onSubmit={save}>
        <div className="row">
          <label>
            Posts per account a day
            <input type="number" min="1" max="50" step="1" value={maxPerDay} onChange={(e) => setMax(e.target.value)} />
          </label>
          <label>
            Minutes between posts
            <input type="number" min="0" max="1440" step="1" value={gap} onChange={(e) => setGap(e.target.value)} />
          </label>
        </div>
        <button type="submit">Save spacing</button>
        {msg && <p className="hint">{msg}</p>}
      </form>
    </details>
  );
}
