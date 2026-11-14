import { PLATFORM_LABELS } from "../../shared/types.js";
import { SUBMIT_WINDOW_MIN, submitAction } from "../../shared/submitWindow.js";
import type { Notifier } from "../live/notify.js";
import type { Publisher } from "./publisher.js";
import type { PostsRepo } from "./repo.js";

export interface SubmitWatchDeps {
  posts: PostsRepo;
  publisher: Publisher;
  notifier: Notifier;
  /** Sends the uploads clipfarm does itself that are due, so their push goes out in the same round. */
  sendDirect?: () => Promise<unknown>;
  /** Operations' "Pause all publishing": nothing waiting is sent; the submit reminders still go out. */
  paused?: () => boolean;
  now?: () => Date;
}

/**
 * The submit window of campaign clips, run once a minute: sends the posts that waited for the
 * manager's hours, pushes "submit within 30 min" when a post is live and again at 20 minutes, and
 * marks the window missed at 30 when the post is still not marked sent.
 */
export class SubmitWatch {
  private running = false;
  private now: () => Date;

  constructor(private deps: SubmitWatchDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { posts, publisher, notifier, sendDirect } = this.deps;
      if (!this.deps.paused?.()) {
        await publisher.sendDueHeld();
        await sendDirect?.();
      }
      await publisher.confirmSubmits();
      for (const { post, notified, reminded } of posts.awaitingSubmit()) {
        const ageMin = (this.now().getTime() - new Date(post.submit!.liveAt!).getTime()) / 60_000;
        const action = submitAction(ageMin, { notified, reminded });
        if (!action) continue;
        if (action === "miss") {
          posts.markSubmit(post.id, "missed");
          continue;
        }
        // Recorded first: a push that fails is not sent a second time a minute later.
        posts.markSubmit(post.id, action === "notify" ? "notified" : "reminded");
        const left = SUBMIT_WINDOW_MIN - Math.floor(ageMin);
        const where = `${post.accountName} (${PLATFORM_LABELS[post.platform]})`;
        await notifier.notify({
          title: action === "notify" ? `${post.creatorName} clip is live: submit within ${left} min` : `${post.creatorName} clip: ${left} min left to submit`,
          body:
            action === "notify"
              ? `${post.clipTitle}, on ${where}. Tap to copy the link and open the campaign.`
              : `${post.clipTitle}, on ${where}, is still not submitted. After that it earns nothing.`,
          url: `/#posted/submit-${post.id}`,
          snooze: true,
        });
      }
    } finally {
      this.running = false;
    }
  }
}
