import { ValidationError } from "../errors.js";

/** An address down to its network, for the screen and the log: 203.0.113.x, 2001:db8:85a3:x. */
export function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}:x`;
  return `${ip.split(".").slice(0, 3).join(".")}.x`;
}

export interface ProxyAddress {
  /** As pasted, sign-in included: only ever handed to the connection. */
  url: string;
  /** Host and port, safe to show. */
  address: string;
  signIn: boolean;
}

/** Reads a pasted proxy address. The error never repeats it: it may hold a password. */
export function parseProxyUrl(raw: unknown): ProxyAddress {
  const bad = new ValidationError("The proxy address must start with http://, https:// or socks5://, like http://user:password@host:8080.");
  if (typeof raw !== "string" || raw.trim().length > 500 || /[\s\p{Cc}]/u.test(raw.trim())) throw bad;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw bad;
  }
  if (!["http:", "https:", "socks5:"].includes(url.protocol) || !url.hostname) throw bad;
  return { url: raw.trim(), address: url.host, signIn: url.username !== "" };
}

const PACIFIC = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function pacificParts(at: Date): Record<string, string> {
  return Object.fromEntries(PACIFIC.formatToParts(at).map((p) => [p.type, p.value]));
}

/** The day in Los Angeles (YYYY-MM-DD): YouTube's quota day. */
export function pacificDay(at: Date): string {
  const p = pacificParts(at);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The next midnight in Los Angeles after `at`: when YouTube's quota starts again. */
export function nextPacificMidnight(at: Date): Date {
  const sinceMidnight = (d: Date) => {
    const p = pacificParts(d);
    return (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000 + (d.getTime() % 1000);
  };
  // A day there has 23, 24 or 25 hours: land near the next midnight, then settle on it.
  let t = new Date(at.getTime() - sinceMidnight(at) + 24 * 3600_000);
  const off = sinceMidnight(t);
  t = new Date(t.getTime() + (off > 12 * 3600_000 ? 24 * 3600_000 - off : -off));
  return t;
}
