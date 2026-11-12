import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Clip, Post, PostingInfo, Source } from "../../shared/types";
import { noAccountReason } from "../../shared/routing";
import { PLATFORM_LABELS, REJECT_REASON_LABELS } from "../../shared/types";
import { api } from "./api";
import { ExportSheet } from "./ExportSheet";
import { allowedPlatforms, PostSheet } from "./PostSheet";
import { shortDate } from "./format";
import { filterClips } from "./review";

const CLIP_STATUS_LABEL: Record<Clip["status"], string> = {
  pending: "To review",
  approved: "Approved",
  rejected: "Rejected",
  rendering: "Being remade",
};

const VIEW_TEXT = {
  approved: { title: "Approved", empty: "No approved clips waiting to post. Approve clips in the Inbox." },
  posted: { title: "Posted", empty: "Nothing posted yet. Post an approved clip to see it here." },
  rejected: { title: "Rejected", empty: "No rejected clips." },
} as const;

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
}: {
  view: keyof typeof VIEW_TEXT;
  clips: Clip[];
  sources: Source[];
  onChange: () => Promise<void>;
}) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [info, setInfo] = useState<PostingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skippedNote, setSkippedNote] = useState<string | null>(null);
  const [posting, setPosting] = useState<Clip | null>(null);
  const [exporting, setExporting] = useState<Clip | null>(null);

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
  const clips = filterClips(allClips, view);

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
        <p className="empty">{VIEW_TEXT[view].empty}</p>
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
                        <button type="button" onClick={() => setExporting(clip)}>
                          Export
                        </button>
                      </>
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
                        <PostRow key={p.id} post={p} onChange={refresh} />
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

function PostRow({ post, onChange }: { post: Post; onChange: () => void }) {
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

  async function copyLink() {
    if (!post.url) return;
    try {
      await navigator.clipboard.writeText(post.url);
      setNote("Link copied. Paste it in the Whop campaign, then mark it sent.");
    } catch {
      setNote(`Copy this link into Whop: ${post.url}`);
    }
  }

  return (
    <li className={`post post-${post.status}`} data-testid="post">
      <div className="job-line">
        <span className="job-name">
          {post.accountName} · {PLATFORM_LABELS[post.platform]}
        </span>
        <span className="post-status">{postStatusLabel(post)}</span>
      </div>
      {post.error && <p className="hint">{post.error}</p>}
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
        <div className="meta">
          {post.whopSubmittedAt ? (
            <span>
              Sent to Whop on {shortDate(post.whopSubmittedAt)}, posted by {post.accountName}
            </span>
          ) : (
            <>
              <button type="button" className="link" onClick={() => void copyLink()} disabled={!post.url}>
                Copy link for Whop
              </button>
              <a href={post.campaignUrl} target="_blank" rel="noreferrer">
                Open campaign
              </a>
              <button type="button" className="link" onClick={() => void api.markWhop(post.id).then(onChange)}>
                Mark sent to Whop
              </button>
            </>
          )}
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
