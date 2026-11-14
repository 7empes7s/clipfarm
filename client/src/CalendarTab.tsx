import { useCallback, useEffect, useRef, useState } from "react";
import type { CalendarInfo, CalendarItem } from "../../shared/publishing";
import { SLOT_STATUS_LABELS } from "../../shared/publishing";
import type { Source } from "../../shared/types";
import { PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { AutopilotView } from "./AutopilotView";
import { Sheet } from "./Sheet";
import { VersionsSheet } from "./VersionsSheet";

const VIEWS = [
  { id: "week", label: "Week" },
  { id: "day", label: "Day" },
  { id: "list", label: "List" },
] as const;
type View = (typeof VIEWS)[number]["id"];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Monday of the week the day is in. */
function startOfWeek(d: Date): Date {
  return addDays(startOfDay(d), -((d.getDay() + 6) % 7));
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dayLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const whenLabel = (iso: string) => `${dayLabel(new Date(iso))}, ${timeLabel(iso)}`;

/** "2026-11-21T09:30" for a datetime-local field, on this device's clock. */
function localInput(iso: string): string {
  const d = new Date(iso);
  return `${dayKey(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function range(view: View, anchor: Date): { from: Date; to: Date; days: Date[] } {
  const from = view === "week" ? startOfWeek(anchor) : startOfDay(anchor);
  const count = view === "week" ? 7 : view === "day" ? 1 : 14;
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  return { from, to: addDays(from, count), days };
}

function readView(): View {
  try {
    const v = localStorage.getItem("calendar-view");
    return VIEWS.some((x) => x.id === v) ? (v as View) : "week";
  } catch {
    return "week";
  }
}

/** Where a dragged post lands: a day keeps its time of day, an hour keeps its minutes. */
function dropTime(target: string, item: CalendarItem): Date {
  const was = new Date(item.post.scheduledAt);
  const [kind, value] = target.split("|") as [string, string];
  if (kind === "day") {
    const [y, m, d] = value.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d, was.getHours(), was.getMinutes());
  }
  const hour = new Date(value);
  return new Date(hour.getFullYear(), hour.getMonth(), hour.getDate(), hour.getHours(), was.getMinutes());
}

/**
 * Drag to move: a mouse drags at once, a finger after holding for a moment (so the page still
 * scrolls). A tap without a drag opens the post.
 */
function useDrag(onDrop: (item: CalendarItem, target: string) => void) {
  const state = useRef<{ item: CalendarItem; el: HTMLElement; x: number; y: number; touch: boolean; active: boolean; timer: number | null } | null>(null);
  const dragged = useRef(false);
  const over = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const targetAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest("[data-drop]") as HTMLElement | null) ?? null;
    const end = () => {
      const s = state.current;
      if (s?.timer) window.clearTimeout(s.timer);
      if (s) {
        s.el.classList.remove("dragging");
        s.el.style.transform = "";
      }
      over.current?.classList.remove("drop-over");
      over.current = null;
      state.current = null;
    };
    const move = (e: PointerEvent) => {
      const s = state.current;
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.active) {
        if (Math.hypot(dx, dy) < 8) return;
        // A finger that moves before the hold is scrolling, not dragging.
        if (s.touch) return end();
        s.active = true;
        s.el.classList.add("dragging");
      }
      s.el.style.transform = `translate(${dx}px, ${dy}px)`;
      const target = targetAt(e.clientX, e.clientY);
      if (target !== over.current) {
        over.current?.classList.remove("drop-over");
        target?.classList.add("drop-over");
        over.current = target;
      }
    };
    const up = (e: PointerEvent) => {
      const s = state.current;
      if (s?.active) {
        dragged.current = true;
        const target = targetAt(e.clientX, e.clientY)?.dataset.drop;
        const item = s.item;
        end();
        if (target) onDrop(item, target);
        return;
      }
      end();
    };
    // While a finger drags, the page must not scroll under it.
    const touchMove = (e: TouchEvent) => {
      if (state.current?.active) e.preventDefault();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", end);
    window.addEventListener("touchmove", touchMove, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("touchmove", touchMove);
    };
  }, [onDrop]);

  const start = (e: React.PointerEvent<HTMLElement>, item: CalendarItem) => {
    if (!item.movable || e.button !== 0) return;
    const touch = e.pointerType !== "mouse";
    const s = { item, el: e.currentTarget, x: e.clientX, y: e.clientY, touch, active: false, timer: null as number | null };
    if (touch) {
      s.timer = window.setTimeout(() => {
        if (state.current !== s) return;
        s.active = true;
        s.el.classList.add("dragging");
        navigator.vibrate?.(15);
      }, 350);
    }
    state.current = s;
  };
  /** True once after a drag: the click that follows is not a tap. */
  const wasDrag = () => {
    const d = dragged.current;
    dragged.current = false;
    return d;
  };
  return { start, wasDrag };
}

function Slot({ item, drag, onOpen }: { item: CalendarItem; drag: ReturnType<typeof useDrag>; onOpen: (i: CalendarItem) => void }) {
  const { post, status } = item;
  return (
    <button
      type="button"
      className={`slot slot-${status}${item.movable ? " movable" : ""}`}
      onPointerDown={(e) => drag.start(e, item)}
      onClick={() => !drag.wasDrag() && onOpen(item)}
      title={item.movable ? "Drag to move, or tap for details" : undefined}
    >
      <span className="slot-top">
        <span className="slot-time">{timeLabel(post.scheduledAt)}</span>
        <span className={`slot-status status-${status}`}>{SLOT_STATUS_LABELS[status]}</span>
      </span>
      <span className="slot-where">
        {PLATFORM_LABELS[post.platform]} · {post.accountName}
      </span>
      <span className="slot-title">{post.clipTitle}</span>
    </button>
  );
}

export function CalendarTab({ sub, sources }: { sub?: string; sources: Source[] }) {
  const autopilot = sub === "autopilot";
  return (
    <section aria-labelledby="calendar-title">
      <div className="section-head">
        <h2 id="calendar-title">{autopilot ? "Autopilot" : "Calendar"}</h2>
      </div>
      <nav className="dash-nav" aria-label="Publishing sections">
        <a href="#calendar" aria-current={!autopilot ? "page" : undefined}>
          Calendar
        </a>
        <a href="#calendar/autopilot" aria-current={autopilot ? "page" : undefined}>
          Autopilot
        </a>
      </nav>
      {autopilot ? <AutopilotView sources={sources} /> : <CalendarView />}
    </section>
  );
}

function CalendarView() {
  const [view, setView] = useState<View>(readView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [info, setInfo] = useState<CalendarInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [versionsFor, setVersionsFor] = useState<{ clipId: number; title: string } | null>(null);
  const { from, to, days } = range(view, anchor);

  const load = useCallback(async () => {
    const shown = range(view, anchor);
    try {
      setInfo(await api.calendar(shown.from, shown.to));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [view, anchor]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem("calendar-view", v);
    } catch {
      // Remembering the view is a nicety.
    }
  };

  const move = useCallback(
    async (item: CalendarItem, at: Date) => {
      setMessage(null);
      setError(null);
      try {
        const { post, reasons } = await api.reschedule(item.post.id, at);
        setMessage(`Moved to ${whenLabel(post.scheduledAt)}.${reasons.length ? ` ${reasons.join(" ")}` : ""}`);
        await load();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [load],
  );
  const onDrop = useCallback((item: CalendarItem, target: string) => void move(item, dropTime(target, item)), [move]);
  const drag = useDrag(onDrop);

  const items = info?.items ?? [];
  const open = items.find((i) => i.post.id === openId) ?? null;
  const step = view === "week" ? 7 : view === "day" ? 1 : 14;
  const today = dayKey(new Date());
  const ofDay = (d: Date) => items.filter((i) => dayKey(new Date(i.post.scheduledAt)) === dayKey(d));
  const label = view === "day" ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(addDays(to, -1))}`;

  return (
    <>
      <div className="cal-bar">
        <div className="cal-seg" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => pickView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="cal-step">
          <button type="button" aria-label="Earlier" onClick={() => setAnchor(addDays(anchor, -step))}>
            ‹
          </button>
          <button type="button" onClick={() => setAnchor(startOfDay(new Date()))}>
            Today
          </button>
          <button type="button" aria-label="Later" onClick={() => setAnchor(addDays(anchor, step))}>
            ›
          </button>
        </div>
      </div>
      <p className="hint cal-range">
        {label}
        {view !== "list" && " · Drag a scheduled post to move it (on a phone, hold it first)."}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="cal-message" role="status">
          {message}
        </p>
      )}
      {!info && !error && <p className="hint">Loading the calendar…</p>}

      {info && view === "week" && (
        <div className="cal-week">
          {days.map((d) => (
            <div key={dayKey(d)} className={`cal-day${dayKey(d) === today ? " today" : ""}`} data-drop={`day|${dayKey(d)}`}>
              <h3 className="cal-day-head">{dayLabel(d)}</h3>
              {ofDay(d).map((i) => (
                <Slot key={i.post.id} item={i} drag={drag} onOpen={(x) => setOpenId(x.post.id)} />
              ))}
              {ofDay(d).length === 0 && <p className="cal-free">Free</p>}
            </div>
          ))}
        </div>
      )}

      {info && view === "day" && (
        <div className="cal-hours">
          {Array.from({ length: 24 }, (_, h) => {
            const hour = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h);
            const here = items.filter((i) => new Date(i.post.scheduledAt).getHours() === h && dayKey(new Date(i.post.scheduledAt)) === dayKey(from));
            return (
              <div key={h} className="cal-hour" data-drop={`hour|${hour.toISOString()}`}>
                <span className="cal-hour-label">{hour.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <div className="cal-hour-slots">
                  {here.map((i) => (
                    <Slot key={i.post.id} item={i} drag={drag} onOpen={(x) => setOpenId(x.post.id)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {info && view === "list" && (
        <div className="cal-list">
          {items.length === 0 && <p className="empty">Nothing scheduled or posted in these two weeks.</p>}
          {days
            .filter((d) => ofDay(d).length > 0)
            .map((d) => (
              <div key={dayKey(d)}>
                <h3 className="cal-day-head">{dayLabel(d)}</h3>
                {ofDay(d).map((i) => (
                  <Slot key={i.post.id} item={i} drag={drag} onOpen={(x) => setOpenId(x.post.id)} />
                ))}
              </div>
            ))}
        </div>
      )}

      {info && <LimitsPanel info={info} onChange={load} />}

      {open && (
        <SlotSheet
          item={open}
          onClose={() => setOpenId(null)}
          onMove={async (at) => {
            await move(open, at);
            setOpenId(null);
          }}
          onChanged={load}
          onVersions={() => setVersionsFor({ clipId: open.post.clipId, title: open.post.clipTitle })}
        />
      )}
      {versionsFor && <VersionsSheet clipId={versionsFor.clipId} title={versionsFor.title} onClose={() => setVersionsFor(null)} />}
    </>
  );
}

function LimitsPanel({ info, onChange }: { info: CalendarInfo; onChange: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="card cal-limits">
      <summary>Limits and best times</summary>
      <p className="hint">The planner never books past these. A post that does not fit moves to the next slot that does, and says why.</p>
      <ul className="notes">
        {info.limits.map((l) => (
          <li key={l.platform}>
            <strong>{PLATFORM_LABELS[l.platform]}:</strong> {l.text}{" "}
            <a href={l.source} target="_blank" rel="noreferrer">
              Source
            </a>
          </li>
        ))}
        <li>Each account also keeps its own posts a day and minutes apart (Dashboard, Accounts).</li>
      </ul>
      <label className="switch">
        <input
          type="checkbox"
          checked={info.tiktokAudited}
          onChange={async (e) => {
            try {
              await api.saveCalendarSettings(e.target.checked);
              setError(null);
              await onChange();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
        TikTok has audited our posting app
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3 className="cal-sub">Best times ({info.timeZone})</h3>
      <ul className="cal-best">
        {info.best.map((b) => (
          <li key={b.platform}>
            <span>{PLATFORM_LABELS[b.platform]}</span>
            <span>
              {b.hours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")}
              <span className="hint"> · {b.learned ? `learned from ${b.basedOn} posts` : "default until 10 posts have views"}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function SlotSheet({
  item,
  onClose,
  onMove,
  onChanged,
  onVersions,
}: {
  item: CalendarItem;
  onClose: () => void;
  onMove: (at: Date) => Promise<void>;
  onChanged: () => Promise<void>;
  onVersions: () => void;
}) {
  const { post, status } = item;
  const [at, setAt] = useState(localInput(post.scheduledAt));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const campaign = post.campaignUrl !== null && !post.experiment;
  return (
    <Sheet id="slot-sheet-title" title={post.clipTitle} onClose={onClose}>
      <div className="form">
        <p className="slot-detail">
          <span className={`slot-status status-${status}`}>{SLOT_STATUS_LABELS[status]}</span> {PLATFORM_LABELS[post.platform]} · {post.accountName}
          {post.experiment && <span className="state role-burner">Burner</span>}
        </p>
        <p className="hint">
          {status === "posted" ? "Went out" : "Goes out"} {whenLabel(post.postedAt ?? post.scheduledAt)}
        </p>
        {post.note && <p className="hint">{post.note}</p>}
        {status === "posted" && post.url && (
          <a className="button" href={post.url} target="_blank" rel="noreferrer">
            Open the post
          </a>
        )}
        {status === "failed" && (
          <>
            <p className="error">{post.error ?? "The platform refused the post."}</p>
            {item.retryable && (
              <button type="button" className="primary" disabled={busy} onClick={() => void run(() => api.retryPost(post.id)).then(onClose)}>
                Retry
              </button>
            )}
          </>
        )}
        {item.movable && (
          <form
            className="cal-move"
            onSubmit={(e) => {
              e.preventDefault();
              if (at) void onMove(new Date(at));
            }}
          >
            <label>
              Move to
              <input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} />
            </label>
            <button type="submit" disabled={busy}>
              Move
            </button>
          </form>
        )}
        {status === "scheduled" && !item.movable && <p className="hint">It is already queued in the posting service, so it can no longer be moved from here.</p>}
        <button type="button" onClick={onVersions}>
          Title, caption and hashtags per platform
        </button>
        <details>
          <summary>Caption</summary>
          <p className="cal-caption">{post.caption}</p>
        </details>
        {campaign && status === "posted" && (
          <fieldset>
            <legend>Campaign submit</legend>
            <p className="hint">
              {post.whopPaidAt
                ? "Paid."
                : post.whopApprovedAt
                  ? "Approved by the campaign."
                  : post.whopRejectedAt
                    ? `Turned down: ${post.whopRejectReason}`
                    : post.whopSubmittedAt
                      ? "Sent; waiting for the campaign's answer."
                      : post.submit?.missedAt
                        ? "The 30-minute window was missed."
                        : "Not sent yet. Copy the link and submit it on the campaign page."}
            </p>
            <div className="chips">
              {!post.whopSubmittedAt && post.url && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard?.writeText(post.url!).catch(() => undefined);
                      if (post.campaignUrl) window.open(post.campaignUrl, "_blank", "noopener");
                    })
                  }
                >
                  Copy link and open campaign
                </button>
              )}
              {!post.whopSubmittedAt && (
                <button type="button" disabled={busy} onClick={() => void run(() => api.markWhop(post.id, "submitted", true))}>
                  Mark sent
                </button>
              )}
              {post.whopSubmittedAt && !post.whopApprovedAt && (
                <button type="button" disabled={busy} onClick={() => void run(() => api.markWhop(post.id, "approved", true))}>
                  Approved
                </button>
              )}
              {post.whopApprovedAt && !post.whopPaidAt && (
                <button type="button" disabled={busy} onClick={() => void run(() => api.markWhop(post.id, "paid", true))}>
                  Paid
                </button>
              )}
            </div>
            {post.whopSubmittedAt && !post.whopApprovedAt && !post.whopRejectedAt && (
              <form
                className="cal-move"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api.rejectWhop(post.id, reason));
                }}
              >
                <label>
                  Turned down? Why
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. missing #TJR" required />
                </label>
                <button type="submit" disabled={busy}>
                  Rejected
                </button>
              </form>
            )}
            {post.whopRejectedAt && (
              <button type="button" className="link" disabled={busy} onClick={() => void run(() => api.rejectWhop(post.id, null))}>
                Take back the rejection
              </button>
            )}
          </fieldset>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
