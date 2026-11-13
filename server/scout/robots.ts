/** What a robots.txt asks of us: the paths we may read, and how long to wait between requests. */
export interface RobotsRules {
  allows(path: string): boolean;
  /** Crawl-delay in seconds, when the site asks for one. */
  crawlDelaySec: number | null;
}

export const ALLOW_ALL: RobotsRules = { allows: () => true, crawlDelaySec: null };
export const ALLOW_NONE: RobotsRules = { allows: () => false, crawlDelaySec: null };

interface Rule {
  allow: boolean;
  path: string;
}

/** A robots.txt path pattern ("*" is any run of characters, a final "$" is the end of the path) as a test. */
function matcher(pattern: string): RegExp {
  const end = pattern.endsWith("$");
  const body = (end ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${end ? "$" : ""}`);
}

/**
 * Reads a robots.txt for one crawler (RFC 9309): the group that names `agent` is followed, else the
 * "*" group. Among the rules that match a path the longest wins, and Allow wins a tie. No matching
 * rule means the path may be read.
 */
export function parseRobots(text: string, agent: string): RobotsRules {
  const groups: { agents: string[]; rules: Rule[]; delay: number | null }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const at = line.indexOf(":");
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (field === "user-agent") {
      // Agent lines in a row share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // "Disallow:" with nothing after it forbids nothing.
      if (value) current.rules.push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      const sec = Number(value);
      if (Number.isFinite(sec) && sec >= 0) current.delay = sec;
    }
  }
  const name = agent.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && name.includes(a)));
  const mine = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
  const rules = mine.flatMap((g) => g.rules).map((r) => ({ ...r, re: matcher(r.path) }));
  const delays = mine.map((g) => g.delay).filter((d): d is number => d !== null);
  return {
    allows(path: string): boolean {
      let best: (typeof rules)[number] | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
      }
      return best ? best.allow : true;
    },
    crawlDelaySec: delays.length > 0 ? Math.max(...delays) : null,
  };
}
