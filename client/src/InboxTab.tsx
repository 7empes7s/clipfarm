import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Clip, Job, RejectReason, Source } from "../../shared/types";
import { PERMISSION_KIND_LABELS, REJECT_REASON_LABELS, REJECT_REASONS } from "../../shared/types";
import { api } from "./api";
import { EditSheet } from "./EditSheet";
import { type Decision, decide, inboxQueue, type LastAction, merge, nextAfter, undo } from "./review";

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

  if (clips.length === 0) return <EmptyGallery jobs={jobs} refresh={refresh} />;

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
          <ClipHead clip={current} position={`${index + 1} of ${queue.length}`} />
          <ClipFrame current={current} next={next} muted={muted} onToggleSound={() => setMuted((m) => !m)} onSwipe={(dir) => (dir === "right" ? act("approve") : setRejecting(true))} />
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
                  Reject{wide && <kbd>R</kbd>}
                </button>
                <button type="button" onClick={() => setEditing(current)}>
                  Edit{wide && <kbd>E</kbd>}
                </button>
                <button type="button" className="decide-approve" onClick={() => act("approve")}>
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
        <div className="caught-up">
          <p>
            <strong>All caught up.</strong> New clips land here as streams are cut.
          </p>
          {last && (
            <button type="button" onClick={takeBack}>
              Undo last ({last.action.action === "approve" ? "approved" : "rejected"} “{last.title}”)
            </button>
          )}
        </div>
      )}

      <p className="inbox-links">
        {wide && <span className="hint">Keys: A approve · R reject · E edit · ← → move · Z undo</span>}
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
  muted,
  onToggleSound,
  onSwipe,
}: {
  current: Clip;
  next: Clip | null;
  muted: boolean;
  onToggleSound: () => void;
  onSwipe: (dir: "left" | "right") => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dragX, setDragX] = useState(0);

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
    if (start.current) setDragX(e.clientX - start.current.x);
  };
  const up = (e: PointerEvent) => {
    const s = start.current;
    start.current = null;
    setDragX(0);
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) onSwipe(dx > 0 ? "right" : "left");
    else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) onToggleSound();
  };

  // Stable order by id, so the preloaded next video keeps its element (and its loaded data).
  const shown = [current, ...(next ? [next] : [])].sort((a, b) => a.id - b.id);
  return (
    <div
      ref={frame}
      className="frame"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
        setDragX(0);
      }}
      style={dragX ? { transform: `translateX(${dragX}px) rotate(${dragX / 40}deg)` } : undefined}
      data-swipe={dragX > 70 ? "approve" : dragX < -70 ? "reject" : undefined}
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
      <button
        type="button"
        className="sound"
        aria-label={muted ? "Turn sound on" : "Turn sound off"}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={onToggleSound}
      >
        {muted ? "Sound off" : "Sound on"}
      </button>
    </div>
  );
}

function ClipHead({ clip, position }: { clip: Clip; position: string }) {
  return (
    <div className="clip-head" data-testid="current-clip">
      <span className="score" aria-label={`Score ${clip.score ?? "unknown"} of 100`}>
        {clip.score === null ? "–" : Math.round(clip.score)}
      </span>
      <div>
        {clip.hook && <p className="hook">{clip.hook}</p>}
        <h3>{clip.title}</h3>
        <p className="hint">score · {position}</p>
      </div>
    </div>
  );
}

function ClipDetails({ clip, source }: { clip: Clip; source?: Source }) {
  const perm = source?.permissions.at(-1);
  return (
    <div className="clip-details">
      <dl className="stub">
        <div>
          <dt>Creator</dt>
          <dd>{source?.creatorName ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{Math.round(clip.durationSec)} s</dd>
        </div>
        {perm && (
          <div className="wide">
            <dt>Campaign</dt>
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
        )}
      </dl>
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

function EmptyGallery({ jobs, refresh }: { jobs: Job[]; refresh: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const demo = jobs.find((j) => j.type === "demo-clips" && (j.status === "queued" || j.status === "running"));
  return (
    <section aria-labelledby="inbox-title" className="inbox">
      <h2 id="inbox-title">Inbox</h2>
      <div className="caught-up">
        <p>No clips yet. They show up here once a stream from a campaign is cut into clips.</p>
        <p className="hint">Want to try the review first? Load ten demo clips made from test patterns. They can never be posted.</p>
        {demo ? (
          <p role="status">Making demo clips… {Math.round(demo.progress * 100)}%</p>
        ) : (
          <button
            type="button"
            className="primary"
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
      </div>
    </section>
  );
}
