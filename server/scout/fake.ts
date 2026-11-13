import type { ProofFetcher, ProofPage } from "../sources/proof.js";

const SITE = "https://contentrewards.com";

export const DEMO_SCOUT_START = `${SITE}/sitemap.xml`;
export const DEMO_NIGHT_OWL = `${SITE}/c/campaigns/night-owl-gta`;
export const DEMO_HARBOR = `${SITE}/c/campaigns/harbor-podcast`;
export const DEMO_PIXEL_RUSH = `${SITE}/c/campaigns/pixel-rush-kick`;
export const DEMO_AGENCY = `${SITE}/demo-clip-agency`;

/**
 * Hand-written stand-ins for the public pages the scout reads: a sitemap that lists two campaigns,
 * three campaign pages and one agency page (which lists a third campaign). All names are made up.
 */
export const DEMO_SCOUT_PAGES: Record<string, string> = {
  [`${SITE}/robots.txt`]: `User-agent: *
Disallow: /api/
Disallow: /home
Sitemap: ${DEMO_SCOUT_START}
`,
  [DEMO_SCOUT_START]: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/pricing</loc></url>
  <url><loc>${DEMO_NIGHT_OWL}</loc></url>
  <url><loc>${DEMO_HARBOR}</loc></url>
</urlset>`,
  [DEMO_NIGHT_OWL]: `<html><head><title>Night Owl GTA VI stream clips | Content Rewards</title></head><body>
<nav><a href="/c/discover">Discover</a> <a href="/login">Sign in</a></nav>
<main>
  <h1>Night Owl GTA VI stream clips</h1>
  <p>Clip the best moments of Night Owl's GTA VI streams and get paid per view.</p>
  <dl>
    <dt>Creator</dt><dd>Night Owl</dd>
    <dt>Agency</dt><dd><a href="/demo-clip-agency">Demo Clip Agency</a></dd>
    <dt>Channels</dt><dd><a href="https://www.twitch.tv/nightowl">Twitch</a></dd>
    <dt>Status</dt><dd>Accepting clips</dd>
    <dt>Platforms</dt><dd>TikTok, YouTube Shorts</dd>
    <dt>Minimum views</dt><dd>2,000</dd>
    <dt>Clippers</dt><dd>40</dd>
    <dt>Budget</dt><dd>$1,200 / $10,000</dd>
  </dl>
  <section><h2>TikTok</h2><dl><dt>Per 1K views</dt><dd>$3.00</dd><dt>Min payout</dt><dd>$2.00</dd><dt>Max payout</dt><dd>$150.00</dd></dl></section>
  <section><h2>YouTube Shorts</h2><dl><dt>Per 1K views</dt><dd>$3.00</dd><dt>Min payout</dt><dd>$2.00</dd><dt>Max payout</dt><dd>$150.00</dd></dl></section>
  <h2>Requirements</h2>
  <ul>
    <li>Caption must include #nightowl and #ad</li>
    <li>Clips must be 15 to 45 seconds long</li>
    <li>No gambling or giveaways</li>
  </ul>
</main></body></html>`,
  [DEMO_HARBOR]: `<html><head><title>Harbor Talk podcast clipping | Content Rewards</title></head><body>
<main>
  <h1>Harbor Talk podcast clipping</h1>
  <p>Short clips from the weekly Harbor Talk business podcast.</p>
  <dl>
    <dt>Creator</dt><dd>Harbor Talk</dd>
    <dt>Status</dt><dd>Accepting clips</dd>
    <dt>Platforms</dt><dd>TikTok, Instagram Reels</dd>
    <dt>Per 1K views</dt><dd>$1.50</dd>
    <dt>Max payout</dt><dd>$100.00</dd>
    <dt>Clippers</dt><dd>25</dd>
    <dt>Budget</dt><dd>$4,500 / $5,000</dd>
  </dl>
  <h2>Requirements</h2>
  <ul>
    <li>No AI content</li>
    <li>Audience must be at least 50% US/UK viewers</li>
    <li>Caption must include #harbortalk</li>
  </ul>
</main></body></html>`,
  [DEMO_AGENCY]: `<html><head><title>Demo Clip Agency</title></head><body>
<main>
  <h1>Demo Clip Agency</h1>
  <p>We run clipping campaigns for streamers.</p>
  <ul>
    <li><a href="/c/campaigns/night-owl-gta">Night Owl GTA VI stream clips</a></li>
    <li><a href="/c/campaigns/pixel-rush-kick">Pixel Rush Kick streams</a></li>
  </ul>
</main></body></html>`,
  [DEMO_PIXEL_RUSH]: `<html><head><title>Pixel Rush Kick streams | Content Rewards</title></head><body>
<main>
  <h1>Pixel Rush Kick streams</h1>
  <p>Funny moments from Pixel Rush's variety gaming streams on Kick.</p>
  <dl>
    <dt>Creator</dt><dd>Pixel Rush</dd>
    <dt>Channels</dt><dd><a href="https://kick.com/pixelrush">Kick</a></dd>
    <dt>Status</dt><dd>Accepting clips</dd>
    <dt>Platforms</dt><dd>TikTok, YouTube Shorts, Instagram Reels</dd>
    <dt>Per 1K views</dt><dd>$2.00</dd>
    <dt>Clippers</dt><dd>12</dd>
    <dt>Budget</dt><dd>$500 / $8,000</dd>
  </dl>
  <p>2 requirements are locked until you join.</p>
</main></body></html>`,
};

/** No network (tests and demo mode): serves the pages it was given, and "404 not found" for anything else. */
export class FakeScoutFetcher implements ProofFetcher {
  readonly name = "fake";
  /** Every link asked for, in order. */
  readonly asked: string[] = [];

  constructor(private pages: Record<string, string> = DEMO_SCOUT_PAGES) {}

  fetchPage(url: string): Promise<ProofPage> {
    this.asked.push(url);
    const text = this.pages[url];
    return Promise.resolve(text === undefined ? { status: 404, text: "Not found" } : { status: 200, text });
  }
}
