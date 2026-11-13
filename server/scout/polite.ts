import type { ProofFetcher, ProofPage } from "../sources/proof.js";
import { ALLOW_ALL, ALLOW_NONE, parseRobots, type RobotsRules } from "./robots.js";

/** The scout never asks any site for more than one page every five seconds. */
export const SCOUT_GAP_MS = 5_000;
/** The name robots.txt rules are matched against (a group for "*" applies when none names it). */
export const SCOUT_AGENT = "clipfarm";

/** The site's robots.txt asks crawlers not to read this page. */
export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`${new URL(url).hostname} asks crawlers not to read this page (robots.txt)`);
  }
}

export interface PoliteOptions {
  /** Least time between two requests, to any site. Never under SCOUT_GAP_MS outside tests and demo mode. */
  gapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The scout's way to the web: public pages only, one request at a time, at least five seconds apart
 * (longer when a site's Crawl-delay asks for it), and never a page its site's robots.txt disallows.
 * A site whose robots.txt cannot be read (other than "not found") is left alone for the run.
 */
export class PoliteFetcher {
  private robots = new Map<string, Promise<RobotsRules>>();
  private nextAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly gapMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private inner: ProofFetcher,
    opts: PoliteOptions = {},
  ) {
    this.gapMs = opts.gapMs ?? SCOUT_GAP_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  /** Forgets every robots.txt, so the next run reads them again. */
  newRun(): void {
    this.robots.clear();
  }

  /** One request, after waiting out the gap since the one before. */
  private paced(url: string, extraGapMs = 0): Promise<ProofPage> {
    const run = async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await this.inner.fetchPage(url);
      } finally {
        this.nextAt = this.now() + Math.max(this.gapMs, extraGapMs);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private rulesFor(origin: string): Promise<RobotsRules> {
    let rules = this.robots.get(origin);
    if (!rules) {
      rules = this.paced(`${origin}/robots.txt`).then(
        (page) => {
          if (page.status >= 200 && page.status < 300) return parseRobots(page.text, SCOUT_AGENT);
          // No robots.txt: nothing is asked of crawlers. Any other answer: stay away.
          return page.status === 404 || page.status === 410 ? ALLOW_ALL : ALLOW_NONE;
        },
        () => ALLOW_NONE,
      );
      this.robots.set(origin, rules);
    }
    return rules;
  }

  async fetchPage(url: string): Promise<ProofPage> {
    const u = new URL(url);
    const rules = await this.rulesFor(u.origin);
    if (!rules.allows(`${u.pathname}${u.search}`)) throw new RobotsDisallowedError(url);
    return this.paced(url, (rules.crawlDelaySec ?? 0) * 1000);
  }
}
