import type { ProofFetcher, ProofPage } from "../proof.js";

/** A made-up campaign page, named after the last part of its link ("…/night-owl-clips" → "Night Owl Clips"). */
export function demoCampaignPage(url: string): string {
  const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "demo-creator";
  const name = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const handle = slug.replace(/[^a-z0-9]/gi, "").toLowerCase() || "democreator";
  return `<html><body><main>
    <h1>${name} clipping campaign</h1>
    <dl>
      <dt>Creator</dt><dd>${name}</dd>
      <dt>Channels</dt><dd><a href="https://www.twitch.tv/${handle}">Twitch</a></dd>
      <dt>Reward</dt><dd>$2.50 per 1,000 views</dd>
      <dt>Minimum views</dt><dd>5,000</dd>
      <dt>Budget left</dt><dd>$4,200</dd>
      <dt>Platforms</dt><dd>TikTok, YouTube Shorts</dd>
      <dt>Ends</dt><dd>December 31, 2027</dd>
    </dl>
    <h2>Requirements</h2>
    <ul>
      <li>Caption must include #${handle} and #ad</li>
      <li>Clips must be 15 to 45 seconds long</li>
      <li>No gambling, politics or giveaways</li>
    </ul>
  </main></body></html>`;
}

/**
 * No network (tests and demo mode). Pages given to it are served as written. Any other link is a
 * running demo campaign, unless the link contains "gone" (a 404), "blocked" (a 403), "ended" (a
 * campaign that is over) or "bare" (a page that says nothing we can read).
 */
export class FakeCampaignFetcher implements ProofFetcher {
  readonly name = "fake";

  constructor(private pages: Record<string, ProofPage> = {}) {}

  set(url: string, page: ProofPage): void {
    this.pages[url] = page;
  }

  fetchPage(url: string): Promise<ProofPage> {
    const known = this.pages[url];
    if (known) return Promise.resolve(known);
    if (url.includes("gone")) return Promise.resolve({ status: 404, text: "Not found" });
    if (url.includes("blocked")) return Promise.resolve({ status: 403, text: "Just a moment…" });
    if (url.includes("bare")) return Promise.resolve({ status: 200, text: "<html><body><h1>Clip and earn</h1><p>Sign in to see this campaign.</p></body></html>" });
    const page = demoCampaignPage(url);
    return Promise.resolve({ status: 200, text: url.includes("ended") ? page.replace("<h2>Requirements</h2>", "<p>This campaign has ended.</p><h2>Requirements</h2>") : page });
  }
}
