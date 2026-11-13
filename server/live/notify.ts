import { generateVAPIDKeys, type RequestOptions, sendNotification } from "web-push";
import type { LiveRepo, PushSubscriptionRecord } from "./repo.js";
import { ValidationError } from "../errors.js";

export interface Notice {
  title: string;
  body: string;
  /** Where a tap on the notification opens the app. */
  url: string;
}

/** Tells the manager's phone something happened. Never throws: a missed notification must not stop the work. */
export interface Notifier {
  /** The key browsers subscribe with; null when nothing can be sent (demo mode, tests). */
  readonly publicKey: string | null;
  notify(notice: Notice): Promise<void>;
}

/** Records what would have been sent. Tests and demo mode. */
export class FakeNotifier implements Notifier {
  readonly publicKey = null;
  readonly sent: Notice[] = [];

  notify(notice: Notice): Promise<void> {
    this.sent.push(notice);
    return Promise.resolve();
  }
}

/** Checks a subscription the browser made (PushSubscription.toJSON()). */
export function parsePushSubscription(body: unknown): PushSubscriptionRecord {
  const b = (body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  let https = false;
  try {
    https = typeof b.endpoint === "string" && new URL(b.endpoint).protocol === "https:";
  } catch {
    /* handled below */
  }
  if (!https || typeof b.keys?.p256dh !== "string" || typeof b.keys.auth !== "string") {
    throw new ValidationError("This browser did not give a usable notification address. Try again, or use another browser.");
  }
  return { endpoint: b.endpoint as string, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth } };
}

type Send = (sub: PushSubscriptionRecord, payload: string, options: RequestOptions) => Promise<unknown>;

/** Web push to every phone and browser that turned notifications on in the app. */
export class WebPushNotifier implements Notifier {
  private keys: { publicKey: string; privateKey: string };
  private send: Send;

  constructor(
    private repo: LiveRepo,
    /** Who the push services may contact about these messages: a web address of the app. */
    private subject: string,
    send?: Send,
  ) {
    this.keys = repo.vapidKeys(() => generateVAPIDKeys());
    this.send = send ?? ((sub, payload, options) => sendNotification(sub, payload, options));
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  async notify(notice: Notice): Promise<void> {
    const options = { TTL: 3600, vapidDetails: { subject: this.subject, ...this.keys } };
    await Promise.all(
      this.repo.pushSubscriptions().map(async (sub) => {
        try {
          await this.send(sub, JSON.stringify(notice), options);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // The browser dropped the subscription (app removed, permission taken back): forget it.
          if (status === 404 || status === 410) this.repo.removePushSubscription(sub.endpoint);
          // Only the status: the address and keys of a subscription stay out of the log.
          else console.error(`A notification could not be sent (${status ? `HTTP ${status}` : "network error"}).`);
        }
      }),
    );
  }
}
