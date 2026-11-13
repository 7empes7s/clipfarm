import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Clip, Job, RejectReason, Source } from "../../shared/types";
import { PERMISSION_KIND_LABELS, REJECT_REASON_LABELS, REJECT_REASONS } from "../../shared/types";
import { api } from "./api";
import { ExperimentBadge } from "./Experiment";
import { EditSheet } from "./EditSheet";
import { type Decision, decide, inboxQueue, type LastAction, merge, nextAfter, undo } from "./review";
import { buzz, swipeIntent, type SwipeIntent } from "./swipe";
import { Avatar, EmptyState, Icon } from "./ui";

/** Wide screens get the "Up next" grid beside the clip. */
function useWide(): boolean {
  const query = "(min-width: 960px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

interface Props {
  clips: Clip[];
  sources: Source[];
  jobs: Job[];
  updateClips: (fn: (clips: Clip[]) => Clip[]) => void;
  refresh: () => Promise<void>;
}

export function InboxTab({ clips, sources, jobs, updateClips, refresh }: Props) {
  const wide = useWide();
  const [creator, setCreator] = useState<number | null>(null);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [last, setLast] = useState<{ action: LastAction; title: string; reason: RejectReason | null } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState<Clip | null>(null);
  const [muted, setMuted] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Server calls run one after another, so an undo never overtakes the decision it takes back.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const serial = (fn: () => Promise<unknown>) => {
    chain.current = chain.current.then(fn, fn);
  };

  const queue = inboxQueue(clips, creator);
  const current = queue.find((c) => c.id === currentId) ?? queue[0] ?? null;
  const nextId = current ? nextAfter(queue, current.id) : null;
  const next = queue.find((c) => c.id === nextId) ?? null;
  const index = current ? queue.indexOf(current) : -1;
  const remaking = clips.filter((c) => c.status === "rendering").length;
  const rejectedCount = clips.filter((c) => c.status === "rejected").length;
  const creatorsWithClips = sources.filter((s) => clips.some((c) => c.sourceId === s.id && c.status === "pending"));

  const act = (action: Decision, reason: RejectReason | null = null) => {
    if (!current) return;
    const clip = current;
    const result = decide(clips, clip.id, action, reason);
    if (!result.last) return;
    const lastAction = result.last;
    setCurrentId(nextAfter(queue, clip.id));
    setRejecting(false);
    setError(null);
    setNote(null);
    updateClips((cs) => decide(cs, clip.id, action, reason).clips);
    setLast({ action: lastAction, title: clip.title, reason });
    serial(async () => {
      try {
        const saved = action === "approve" ? await api.approveClip(clip.id) : await api.rejectClip(clip.id, reason);
        updateClips((cs) => merge(cs, [saved]));
      } catch (err) {
        updateClips((cs) => undo(cs, lastAction));
        setLast(null);
        setError((err as Error).message);
      }
    });
  };

  const takeBack = () => {
    if (!last) return;
    const { action } = last;
    updateClips((cs) => undo(cs, action));
    setCurrentId(action.clipId);
    setLast(null);
    setError(null);
    serial(async () => {
      try {
        const saved = await api.undoReview();
        updateClips((cs) => merge(cs, [saved]));
      } catch (err) {
        setError((err as Error).message);
        await refresh();
      }
    });
  };

  const step = (delta: number) => {
    const target = queue[index + delta];
    if (target) {
      setCurrentId(target.id);
      setRejecting(false);
    }
  };

  // Keyboard on desktop: A approve, R reject (then 1-5 for the reason), E edit, arrows move, Z undo.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  const onKey = (e: KeyboardEvent) => {
    if (editing || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    const k = e.key.toLowerCase();
    if (rejecting && /^[1-5]$/.test(k)) act("reject", REJECT_REASONS[Number(k) - 1]!);
    else if (k === "a") act("approve");
    else if (k === "r") setRejecting((r) => !r);
    else if (k === "e" && current) setEditing(current);
    else if (k === "z") takeBack();
    else if (k === "escape") setRejecting(false);
    else if (k === "arrowright" || k === "arrowdown") step(1);
    else if (k === "arrowleft" || k === "arrowup") step(-1);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    keys.current = onKey;
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const closeEdit = useCallback(() => setEditing(null), []);

  const onSwipe = (intent: SwipeIntent) => {
    if (intent === "approve" || intent === "reject") {
      buzz();
      act(intent);
    } else if (intent === "next") step(1);
    else if (intent === "back") step(-1);
  };

  if (clips.length === 0) return <EmptyGallery jobs={jobs} sources={sources} refresh={refresh} />;

  return (
    <section aria-labelledby="inbox-title" className={wide ? "inbox inbox-wide" : "inbox"}>
      <div className="section-head">
        <h2 id="inbox-title">Inbox</h2>
        {creatorsWithClips.length > 1 && (
          <select aria-label="Creator" value={creator ?? ""} onChange={(e) => setCreator(e.target.value ? Number(e.target.value) : null)}>
            <option value="">All creators</option>
            {creatorsWithClips.map((s) => (
              <option key={s.id} value={s.id}>
                {s.creatorName}
              </option>
            ))}
          </select>
        )}
      </div>
      {remaking > 0 && (
        <p className="hint">
          {remaking === 1 ? "1 clip is" : `${remaking} clips are`} being remade with your edits. They come back here when done (
          <a href="#jobs">see Jobs</a>).
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {current ? (
        <div className="review">
          <ClipFrame
            current={current}
            next={next}
            source={sources.find((s) => s.id === current.sourceId)}
            position={`${index + 1} of ${queue.length}`}
            muted={muted}
            onToggleSound={() => setMuted((m) => !m)}
            onSwipe={onSwipe}
          />
          <ClipDetails clip={current} source={sources.find((s) => s.id === current.sourceId)} />
          <div className="decide" data-testid="decide">
            {rejecting ? (
              <div className="reasons" role="group" aria-label="Why reject it?">
                <span className="reasons-label">Why?</span>
                {REJECT_REASONS.map((r, i) => (
                  <button key={r} type="button" className="chip" onClick={() => act("reject", r)}>
                    {REJECT_REASON_LABELS[r]}
                    {wide && <kbd>{i + 1}</kbd>}
                  </button>
                ))}
                <button type="button" className="close" aria-label="Close reasons" onClick={() => setRejecting(false)}>
                  ×
                </button>
              </div>
            ) : (
              <div className="decide-buttons">
                <button type="button" className="decide-reject" onClick={() => setRejecting(true)}>
                  <Icon name="reject" />
                  Reject{wide && <kbd>R</kbd>}
                </button>
                <button type="button" onClick={() => setEditing(current)}>
                  <Icon name="edit" />
                  Edit{wide && <kbd>E</kbd>}
                </button>
                <button type="button" className="decide-approve" onClick={() => act("approve")}>
                  <Icon name="approve" />
                  Approve{wide && <kbd>A</kbd>}
                </button>
              </div>
            )}
            <div className="decide-foot" role="status">
              {last ? (
                <>
                  <span>
                    {last.action.action === "approve" ? "Approved" : "Rejected"} “{last.title}”
                    {last.reason ? ` (${REJECT_REASON_LABELS[last.reason].toLowerCase()})` : ""}.
                  </span>
                  <button type="button" className="link" onClick={takeBack}>
                    Undo
                  </button>
                </>
              ) : (
                note && <span>{note}</span>
              )}
            </div>
          </div>
          {wide && (
            <UpNext
              queue={queue}
              currentId={current.id}
              onPick={(id) => {
                setCurrentId(id);
                setRejecting(false);
              }}
            />
          )}
        </div>
      ) : (
        <EmptyState
          icon="approved"
          title="All caught up"
          action={{ label: "Paste a stream link", href: "#sources" }}
          extra={
            last && (
              <button type="button" onClick={takeBack}>
                Undo last ({last.action.action === "approve" ? "approved" : "rejected"} “{last.title}”)
              </button>
            )
          }
        >
          Every clip is reviewed. New ones land here as streams are cut; paste another stream link to make more.
        </EmptyState>
      )}

      <p className="inbox-links">
        <span className="hint">
          {wide ? "Keys: A approve, R reject, E edit, ← → move, Z undo" : "Swipe right to approve, left to reject, up for the next clip."}
        </span>
        <a href="#rejected">Rejected clips ({rejectedCount})</a>
      </p>

      {editing && (
        <EditSheet
          clip={editing}
          source={sources.find((s) => s.id === editing.sourceId)}
          onClose={closeEdit}
          onSaved={(saved) => {
            setEditing(null);
            setLast(null);
            if (saved.id === current?.id) setCurrentId(nextAfter(queue, saved.id));
            updateClips((cs) => merge(cs, [saved]));
            setNote(`Remaking “${saved.title}”. It comes back to the inbox when done.`);
          }}
        />
      )}
    </section>
  );
}

function ClipFrame({
  current,
  next,
  source,
  position,
  muted,
  onToggleSound,
  onSwipe,
}: {
  current: Clip;
  next: Clip | null;
  source?: Source;
  position: string;
  muted: boolean;
  onToggleSound: () => void;
  onSwipe: (intent: SwipeIntent) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);

  // Play the current clip, keep the preloaded next one paused.
  useEffect(() => {
    for (const v of frame.current?.querySelectorAll("video") ?? []) {
      if (v.dataset.clip === String(current.id)) {
        v.muted = muted;
        void v.play().catch(() => {});
      } else {
        v.pause();
      }
    }
  }, [current.id, current.videoUrl, muted]);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY };
  };
  const move = (e: PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const to = { x: e.clientX - s.x, y: e.clientY - s.y };
    // A tick in the hand at the point where letting go starts to count.
    if (swipeOf(to) && !swipeOf(drag)) buzz(8);
    setDrag(to);
  };
  const up = (e: PointerEvent) => {
    const s = start.current;
    start.current = null;
    setDrag(null);
    if (!s) return;
    const intent = swipeIntent(e.clientX - s.x, e.clientY - s.y);
    if (intent === "tap") onToggleSound();
    else if (intent) onSwipe(intent);
  };

  const pending = swipeOf(drag);
  // The clip follows the finger: sideways with a tilt, or a little up and down.
  const sideways = drag !== null && Math.abs(drag.x) >= Math.abs(drag.y);
  const transform = !drag ? undefined : sideways ? `translateX(${drag.x}px) rotate(${drag.x / 40}deg)` : `translateY(${drag.y / 3}px)`;

  // Stable order by id, so the preloaded next video keeps its element (and its loaded data).
  const shown = [current, ...(next ? [next] : [])].sort((a, b) => a.id - b.id);
  return (
    <div
      ref={frame}
      className={drag ? "frame is-dragging" : "frame"}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
      style={transform ? { transform } : undefined}
      data-swipe={pending ?? undefined}
    >
      {shown.map((c) => (
        <video
          key={c.id}
          data-clip={c.id}
          data-testid={c.id === current.id ? "current-video" : "next-video"}
          className={c.id === current.id ? "is-current" : "is-next"}
          src={c.videoUrl}
          muted
          loop
          playsInline
          preload="auto"
          aria-label={c.id === current.id ? `Clip: ${c.title}` : undefined}
          aria-hidden={c.id !== current.id}
        />
      ))}
      <div className="clip-over" key={current.id} data-testid="current-clip" data-clip={current.id}>
        <div className="over-top">
          <span className="score" aria-label={`Score ${current.score ?? "unknown"} of 100`}>
            {current.score === null ? "–" : Math.round(current.score)}
            <small>score</small>
          </span>
          <span className="over-chip">{position}</span>
        </div>
        <div>
          {current.hook && <p className="hook">{current.hook}</p>}
          <h3>{current.title}</h3>
          <div className="over-chips">
            <span className="over-chip">
              {source && <Avatar name={source.creatorName} />}
              {source?.creatorName ?? "Unknown creator"}
            </span>
            <span className="over-chip">
              <Icon name="clock" size={16} />
              {Math.round(current.durationSec)} s
            </span>
            {current.experiment && <ExperimentBadge />}
          </div>
        </div>
      </div>
      <button
        type="button"
        className="sound"
        aria-label={muted ? "Turn sound on" : "Turn sound off"}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={onToggleSound}
      >
        <Icon name={muted ? "muted" : "sound"} />
      </button>
      {pending && (
        <span className="stamp" aria-hidden="true">
          {STAMP[pending]}
        </span>
      )}
    </div>
  );
}

const STAMP = { approve: "Approve", reject: "Reject", next: "Next clip", back: "Back" } as const;

/** The swipe a drag would be if the finger lifted now; null for none (or a tap). */
function swipeOf(drag: { x: number; y: number } | null): Exclude<SwipeIntent, "tap"> | null {
  const intent = drag ? swipeIntent(drag.x, drag.y) : null;
  return intent === "tap" ? null : intent;
}

function ClipDetails({ clip, source }: { clip: Clip; source?: Source }) {
  const perm = source?.permissions.at(-1);
  return (
    <div className="clip-details">
      {perm && (
        <dl className="stub">
          <div className="wide">
            <dt>Campaign</dt>
            <dd>
              {(perm.campaignUrl ?? perm.proofUrl) ? (
                <a href={(perm.campaignUrl ?? perm.proofUrl)!} target="_blank" rel="noreferrer">
                  {PERMISSION_KIND_LABELS[perm.kind]}
                </a>
              ) : (
                PERMISSION_KIND_LABELS[perm.kind]
              )}
            </dd>
          </div>
        </dl>
      )}
      {clip.reason && <p className="why">Why it was picked: {clip.reason}</p>}
    </div>
  );
}

function UpNext({ queue, currentId, onPick }: { queue: Clip[]; currentId: number; onPick: (id: number) => void }) {
  return (
    <aside className="up-next" aria-label="Up next">
      <h3>Up next</h3>
      <ul>
        {queue.slice(0, 12).map((c) => (
          <li key={c.id}>
            <button type="button" aria-current={c.id === currentId ? "true" : undefined} onClick={() => onPick(c.id)}>
              <video src={c.videoUrl} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} />
              <span className="tile-score">{c.score === null ? "–" : Math.round(c.score)}</span>
              <span className="tile-title">{c.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function EmptyGallery({ jobs, sources, refresh }: { jobs: Job[]; sources: Source[]; refresh: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const demo = jobs.find((j) => j.type === "demo-clips" && (j.status === "queued" || j.status === "running"));
  const hasCampaign = sources.some((s) => s.permissionState === "active");
  return (
    <section aria-labelledby="inbox-title" className="inbox">
      <div className="section-head">
        <h2 id="inbox-title">Inbox</h2>
      </div>
      <EmptyState
        icon="inbox"
        title="No clips to review yet"
        action={hasCampaign ? { label: "Paste a stream link", href: "#sources" } : { label: "Add a creator", href: "#sources" }}
        extra={
          <>
            <p className="hint">Want to try the review first? Load ten demo clips made from test patterns. They can never be posted.</p>
            {demo ? (
              <p role="status">Making demo clips… {Math.round(demo.progress * 100)}%</p>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  void api.loadDemo().then(refresh, (err: Error) => setError(err.message));
                }}
              >
                Load demo clips
              </button>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </>
        }
      >
        {hasCampaign
          ? "Paste a stream link on a campaign in Sources. Its best moments are cut into vertical clips and land here to review."
          : "Add a creator who allows clipping in Sources, then paste one of their stream links. The clips land here to review."}
      </EmptyState>
    </section>
  );
}
