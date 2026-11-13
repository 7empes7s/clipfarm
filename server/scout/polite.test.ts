import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpProofFetcher } from "../sources/proof.js";
import { PoliteFetcher, RobotsDisallowedError, SCOUT_GAP_MS } from "./polite.js";
import { parseRobots } from "./robots.js";

describe("parseRobots", () => {
  const text = `
# comments and blank lines are skipped
User-agent: *
Disallow: /api/
Disallow: /home
Allow: /api/public/
Disallow: /*.json$
Crawl-delay: 8

User-agent: badbot
User-agent: clipfarm
Disallow: /private
`;

  it("follows the * group when none names the crawler: the longest matching rule wins", () => {
    const r = parseRobots(text, "somebody");
    expect(r.allows("/c/campaigns/abc")).toBe(true);
    expect(r.allows("/api/campaigns")).toBe(false);
    expect(r.allows("/api/public/list")).toBe(true);
    expect(r.allows("/home")).toBe(false);
    expect(r.allows("/data/list.json")).toBe(false);
    expect(r.allows("/data/list.json?x=1")).toBe(true);
    expect(r.crawlDelaySec).toBe(8);
  });

  it("follows only the group that names the crawler when there is one", () => {
    const r = parseRobots(text, "clipfarm");
    expect(r.allows("/private/page")).toBe(false);
    expect(r.allows("/api/campaigns")).toBe(true);
    expect(r.crawlDelaySec).toBeNull();
  });

  it("allows everything when the file forbids nothing", () => {
    expect(parseRobots("User-agent: *\nDisallow:\n", "clipfarm").allows("/anything")).toBe(true);
    expect(parseRobots("", "clipfarm").allows("/anything")).toBe(true);
  });
});

describe("PoliteFetcher against a fake site", () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  /** A local web server that notes every path asked for and the (fake) time it was asked at. */
  async function site(robots: { status: number; text: string }) {
    let clock = 1_000_000;
    const hits: { path: string; at: number }[] = [];
    server = createServer((req, res) => {
      hits.push({ path: req.url!, at: clock });
      if (req.url === "/robots.txt") res.writeHead(robots.status, { "Content-Type": "text/plain" }).end(robots.text);
      else res.writeHead(200, { "Content-Type": "text/html" }).end(`<h1>${req.url}</h1>`);
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sleeps: number[] = [];
    const fetcher = new PoliteFetcher(new HttpProofFetcher(), {
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });
    return { base, hits, sleeps, fetcher };
  }

  it("reads robots.txt first, never asks for a disallowed page, and waits 5 s between requests", async () => {
    const t = await site({ status: 200, text: "User-agent: *\nDisallow: /private/\n" });

    expect((await t.fetcher.fetchPage(`${t.base}/c/campaigns/one`)).text).toBe("<h1>/c/campaigns/one</h1>");
    await expect(t.fetcher.fetchPage(`${t.base}/private/two`)).rejects.toBeInstanceOf(RobotsDisallowedError);
    // Asked at once, they still go out one by one.
    await Promise.all([t.fetcher.fetchPage(`${t.base}/c/campaigns/three`), t.fetcher.fetchPage(`${t.base}/c/campaigns/four`)]);

    expect(t.hits.map((h) => h.path)).toEqual(["/robots.txt", "/c/campaigns/one", "/c/campaigns/three", "/c/campaigns/four"]);
    const gaps = t.hits.slice(1).map((h, i) => h.at - t.hits[i]!.at);
    expect(gaps).toEqual([SCOUT_GAP_MS, SCOUT_GAP_MS, SCOUT_GAP_MS]);
    expect(SCOUT_GAP_MS).toBeGreaterThanOrEqual(5000);
    expect(t.sleeps).toEqual([5000, 5000, 5000]);
  });

  it("waits longer when the site's Crawl-delay asks for it", async () => {
    const t = await site({ status: 200, text: "User-agent: *\nCrawl-delay: 12\n" });
    await t.fetcher.fetchPage(`${t.base}/a`);
    await t.fetcher.fetchPage(`${t.base}/b`);
    expect(t.hits[2]!.at - t.hits[1]!.at).toBe(12_000);
  });

  it("reads a site that has no robots.txt", async () => {
    const t = await site({ status: 404, text: "Not found" });
    expect((await t.fetcher.fetchPage(`${t.base}/a`)).status).toBe(200);
  });

  it("stays away from a site whose robots.txt cannot be read", async () => {
    const t = await site({ status: 503, text: "Busy" });
    await expect(t.fetcher.fetchPage(`${t.base}/a`)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(t.hits.map((h) => h.path)).toEqual(["/robots.txt"]);
  });

  it("reads robots.txt again on the next run", async () => {
    const t = await site({ status: 200, text: "" });
    await t.fetcher.fetchPage(`${t.base}/a`);
    t.fetcher.newRun();
    await t.fetcher.fetchPage(`${t.base}/b`);
    expect(t.hits.map((h) => h.path)).toEqual(["/robots.txt", "/a", "/robots.txt", "/b"]);
  });
});
