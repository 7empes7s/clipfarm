import type { Post } from "../../shared/types";
import { SUBMIT_REMIND_MIN, SUBMIT_WINDOW_MIN } from "../../shared/submitWindow";

export interface SubmitCountdown {
  /** "open": time left; "late": the last 10 minutes; "missed": the window passed. */
  state: "open" | "late" | "missed";
  text: string;
}

/** What a campaign post's card says about its 30-minute submit window; null when there is nothing to say. */
export function submitCountdown(post: Pick<Post, "submit" | "whopSubmittedAt" | "lostEarningsUsd">, now: number): SubmitCountdown | null {
  const s = post.submit;
  if (!s || post.whopSubmittedAt || !s.dueBy) return null;
  const left = Math.ceil((new Date(s.dueBy).getTime() - now) / 1000);
  if (s.missedAt || left <= 0) {
    const lost = post.lostEarningsUsd > 0 ? ` About $${post.lostEarningsUsd.toFixed(2)} lost.` : "";
    return { state: "missed", text: `Window missed: it was not submitted within ${SUBMIT_WINDOW_MIN} minutes, so it earns nothing.${lost}` };
  }
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return { state: left <= (SUBMIT_WINDOW_MIN - SUBMIT_REMIND_MIN) * 60 ? "late" : "open", text: `Submit within ${clock}` };
}

/** "#posted/submit-12" → 12: the post a push notification opens. */
export function submitTarget(sub: string | undefined): number | null {
  const m = /^submit-(\d+)$/.exec(sub ?? "");
  return m ? Number(m[1]) : null;
}

/** "clip-12" → 12: the clip a dashboard row opens. */
export function clipTarget(sub: string | undefined): number | null {
  const m = /^clip-(\d+)$/.exec(sub ?? "");
  return m ? Number(m[1]) : null;
}

/** "today 15:00", "tomorrow 08:00", "Sat 08:00", on the phone's clock. */
export function whenShort(iso: string, now: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}
