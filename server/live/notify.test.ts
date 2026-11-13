import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { ValidationError } from "../errors.js";
import { parsePushSubscription, WebPushNotifier } from "./notify.js";
import { LiveRepo } from "./repo.js";

const sub = (n: number) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

describe("WebPushNotifier", () => {
  it("sends the notice to every subscriber, signed with the server's own keys, and forgets dead subscriptions", async () => {
    const db = openDb(":memory:");
    const repo = new LiveRepo(db);
    [1, 2, 3].forEach((n) => repo.addPushSubscription(sub(n), new Date()));
    const sent: { endpoint: string; payload: string; subject: string; publicKey: string }[] = [];
    // A stand-in for the browsers' push services: no network.
    const notifier = new WebPushNotifier(repo, "https://clips.example", async (s, payload, options) => {
      if (s.endpoint.endsWith("/2")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      if (s.endpoint.endsWith("/3")) throw new Error("network down");
      sent.push({ endpoint: s.endpoint, payload, subject: options.vapidDetails!.subject, publicKey: options.vapidDetails!.publicKey });
    });
    expect(notifier.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    await notifier.notify({ title: "First LIVE clip: Kai", body: "It is in the Inbox.", url: "/#inbox" });
    expect(sent).toEqual([
      {
        endpoint: "https://push.example/1",
        payload: JSON.stringify({ title: "First LIVE clip: Kai", body: "It is in the Inbox.", url: "/#inbox" }),
        subject: "https://clips.example",
        publicKey: notifier.publicKey,
      },
    ]);
    // Gone for good: removed. A passing error: kept for the next notice.
    expect(repo.pushSubscriptions().map((s) => s.endpoint)).toEqual(["https://push.example/1", "https://push.example/3"]);
    // The keys are made once and kept.
    expect(new WebPushNotifier(new LiveRepo(db), "https://clips.example").publicKey).toBe(notifier.publicKey);
  });
});

describe("parsePushSubscription", () => {
  it("takes what the browser gives and refuses anything else", () => {
    expect(parsePushSubscription({ ...sub(1), expirationTime: null })).toEqual(sub(1));
    for (const bad of [null, {}, { endpoint: "http://push.example/1", keys: sub(1).keys }, { endpoint: "nope", keys: sub(1).keys }, { endpoint: sub(1).endpoint, keys: { p256dh: "x" } }]) {
      expect(() => parsePushSubscription(bad)).toThrow(ValidationError);
    }
  });
});
