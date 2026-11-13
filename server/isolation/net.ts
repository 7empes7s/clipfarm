import { Agent, type Dispatcher, fetch as undiciFetch, ProxyAgent } from "undici";

export type Fetch = typeof fetch;

/** Gives the way out for a proxy address (null: straight from this server). One dispatcher per address. */
export type Transport = (proxyUrl: string | null) => Fetch;

/**
 * The real way out: undici with one connection pool per proxy, so one group's calls can never ride
 * on another group's connection. http(s) proxies are tunnelled with CONNECT, socks5 is spoken natively.
 */
export function undiciTransport(): { fetch: Transport; close(): Promise<void> } {
  const dispatchers = new Map<string, Dispatcher>();
  const dispatcher = (proxyUrl: string | null): Dispatcher => {
    const key = proxyUrl ?? "";
    let d = dispatchers.get(key);
    if (!d) {
      d = proxyUrl ? new ProxyAgent({ uri: proxyUrl, proxyTunnel: true }) : new Agent();
      dispatchers.set(key, d);
    }
    return d;
  };
  return {
    fetch: (proxyUrl) => {
      const via = dispatcher(proxyUrl);
      return ((input: string | URL, init: RequestInit = {}) =>
        undiciFetch(String(input), { ...(init as object), dispatcher: via })) as unknown as Fetch;
    },
    close: async () => {
      await Promise.all([...dispatchers.values()].map((d) => d.close().catch(() => undefined)));
      dispatchers.clear();
    },
  };
}

export interface Exit {
  ip: string;
  country: string | null;
}

/** Why a call did not get through, without the address it went to (a proxy's holds its password). */
export function networkReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "no answer in time";
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}

/** One call to the IP-echo address: where this way out leaves from. */
export async function readExit(doFetch: Fetch, ipEchoUrl: string): Promise<Exit> {
  const res = await doFetch(ipEchoUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { ip?: unknown; country?: unknown };
  if (typeof body.ip !== "string" || !/^[0-9a-f.:]{3,45}$/i.test(body.ip)) throw new Error("no address in the answer");
  return { ip: body.ip, country: typeof body.country === "string" && body.country ? body.country.slice(0, 40) : null };
}
