import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import type { Db } from "../db/index.js";
import { ValidationError } from "../errors.js";

// Web push without a library: the message is encrypted for the browser (RFC 8291, aes128gcm) and
// the request is signed with our own key pair (VAPID, RFC 8292). No push account is needed; the
// browser's push service (Google, Mozilla, Apple) only passes the sealed message on.

export interface VapidKeys {
  /** The uncompressed P-256 point (65 bytes) and the private scalar (32 bytes), base64url. */
  publicKey: string;
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSubscriber extends PushTarget {
  /** The browser's time zone, so "09:00" is the phone's morning. */
  tz: string;
  lastDigestDay: string | null;
}

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

/** Seals a message for one browser. `salt` and `localKey` are random; tests pass their own. */
export function encryptPayload(payload: Buffer, target: Pick<PushTarget, "p256dh" | "auth">, opts: { salt?: Buffer; localKey?: Buffer } = {}): Buffer {
  const browserKey = unb64(target.p256dh);
  const salt = opts.salt ?? randomBytes(16);
  const ecdh = createECDH("prime256v1");
  if (opts.localKey) ecdh.setPrivateKey(opts.localKey);
  else ecdh.generateKeys();
  const ourKey = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(browserKey);
  const ikm = hkdf(unb64(target.auth), shared, Buffer.concat([Buffer.from("WebPush: info\0"), browserKey, ourKey]), 32);
  const key = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  // 0x02 marks the last (only) record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(ourKey.length, 20);
  return Buffer.concat([header, ourKey, sealed]);
}

/** The Authorization header that tells the push service who is sending (a signed, short-lived token). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now: Date): string {
  const pub = unb64(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const part = (o: object) => b64(Buffer.from(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicKey}`;
}

export interface PushSender {
  /** "gone": the browser dropped the subscription, so it should be forgotten. */
  send(target: PushTarget, message: { title: string; body: string; url: string }): Promise<"sent" | "gone">;
}

export class WebPushSender implements PushSender {
  constructor(
    private opts: { keys: () => VapidKeys; subject: string; fetch?: typeof fetch; now?: () => Date },
  ) {}

  async send(target: PushTarget, message: { title: string; body: string; url: string }): Promise<"sent" | "gone"> {
    const res = await (this.opts.fetch ?? fetch)(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(target.endpoint, this.opts.keys(), this.opts.subject, (this.opts.now ?? (() => new Date()))()),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(12 * 3600),
        Urgency: "low",
      },
      body: new Uint8Array(encryptPayload(Buffer.from(JSON.stringify(message)), target)),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) throw new Error(`The push service answered ${res.status}.`);
    return "sent";
  }
}

/** Stands in for the push services in tests and demos: nothing leaves the server. */
export class FakePushSender implements PushSender {
  sent: { endpoint: string; title: string; body: string }[] = [];
  gone = new Set<string>();

  send(target: PushTarget, message: { title: string; body: string }): Promise<"sent" | "gone"> {
    if (this.gone.has(target.endpoint)) return Promise.resolve("gone");
    this.sent.push({ endpoint: target.endpoint, title: message.title, body: message.body });
    return Promise.resolve("sent");
  }
}

export function parseSubscription(body: unknown): PushTarget & { tz: string } {
  const b = (body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; tz?: unknown };
  const ok = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 2000;
  if (!ok(b.endpoint) || !/^https:\/\//.test(b.endpoint) || !ok(b.keys?.p256dh) || !ok(b.keys?.auth)) {
    throw new ValidationError("That is not a push subscription from a browser.");
  }
  return { endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, tz: ok(b.tz) ? b.tz : "UTC" };
}

/** The browsers that asked for the daily digest, and the key pair that signs what we send them. */
export class PushStore {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  /** Made on first use and kept in the database: nobody has to create or paste a key. */
  keys(): VapidKeys {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'vapid_keys'").get() as { value: string } | undefined;
    if (row) return JSON.parse(row.value) as VapidKeys;
    const keys = generateVapidKeys();
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('vapid_keys', ?)").run(JSON.stringify(keys));
    return keys;
  }

  subscribe(s: PushTarget & { tz: string }): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, tz, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, tz = excluded.tz`,
      )
      .run(s.endpoint, s.p256dh, s.auth, s.tz, this.now().toISOString());
  }

  unsubscribe(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  list(): PushSubscriber[] {
    return this.db.prepare("SELECT endpoint, p256dh, auth, tz, last_digest_day AS lastDigestDay FROM push_subscriptions").all() as PushSubscriber[];
  }

  markSent(endpoint: string, day: string): void {
    this.db.prepare("UPDATE push_subscriptions SET last_digest_day = ? WHERE endpoint = ?").run(day, endpoint);
  }
}
