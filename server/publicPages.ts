import type { Express, Response } from "express";
import { PUBLIC_PAGE_PATHS } from "./access.js";

/**
 * The pages anyone may read without signing in: a public home, the Privacy Policy and the Terms.
 * Google checks them before it lets the app ask for YouTube access, so the whole text is in the
 * HTML the server sends: no script, no cookie, no request to anyone else.
 *
 * Everything they say must stay true to what clipfarm and Postiz do. When the code changes what
 * is read from Google, where it is kept or who gets it, change the text and EFFECTIVE_DATE.
 */

/** The app's name, the same as on the Google consent screen. */
export const APP_NAME = "TechInsiderBytes";
/** The day this wording took effect. */
export const EFFECTIVE_DATE = "13 November 2026";

export const USER_DATA_POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";
export const YOUTUBE_TERMS_URL = "https://www.youtube.com/t/terms";
export const GOOGLE_PRIVACY_URL = "https://policies.google.com/privacy";
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";
/** Google's wording, word for word: its reviewers look for this sentence. */
export const LIMITED_USE_SENTENCE = `${APP_NAME}' use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements.`;

/** How long after a request stored data is gone (YouTube asks for 7 calendar days at most). */
const DELETE_WITHIN_DAYS = 7;
/** How long after access is taken away at Google, or a deletion, the last backup copy is gone. */
const GONE_EVERYWHERE_DAYS = 30;

const [HOME, PRIVACY, TERMS] = PUBLIC_PAGE_PATHS;

/** An address that can be shown and written to: one name, one @, a dotted domain, nothing to escape. */
export function parseSupportEmail(raw: string | undefined): string | null {
  const email = (raw ?? "").trim();
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email) ? email : null;
}

/* The app's design tokens (client/src/styles.css), by the same names and values: publicPages.test.ts
   fails when one drifts. Fonts fall back to the system's: these pages load nothing but themselves. */
const STYLE = `
:root {
  --paper: #f5f2fa;
  --surface: #ffffff;
  --sunk: #ebe6f4;
  --ink: #1b1530;
  --muted: #5d5577;
  --line: #dcd5ea;
  --accent: #ffb224;
  --accent-ink: #1b1530;
  --second: #5a3fd4;
  --focus: #5a3fd4;
  --font-body: "Figtree Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-head: "Bricolage Grotesque Variable", "Figtree Variable", system-ui, sans-serif;
  --t-sm: 0.875rem;
  --t-md: 1rem;
  --t-lg: 1.25rem;
  --t-2xl: 2.5rem;
  --s1: 0.25rem;
  --s2: 0.5rem;
  --s3: 0.75rem;
  --s4: 1rem;
  --s5: 1.5rem;
  --s6: 2.25rem;
  --radius: 18px;
  --radius-small: 12px;
  --gutter: 16px;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #15111f;
    --surface: #201a30;
    --sunk: #2a2340;
    --ink: #f3effc;
    --muted: #aba3c4;
    --line: #3a3155;
    --second: #a594ff;
    --focus: #a594ff;
  }
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: var(--t-md) / 1.6 var(--font-body);
  -webkit-text-size-adjust: 100%;
  overflow-wrap: break-word;
}
.sheet {
  max-width: 42rem;
  margin: 0 auto;
  padding: var(--s5) var(--gutter) var(--s6);
}
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s2) var(--s4);
  padding-bottom: var(--s4);
  border-bottom: 1px solid var(--line);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  min-height: 44px;
  font: 700 var(--t-lg) / 1.15 var(--font-head);
  letter-spacing: -0.015em;
  text-decoration: none;
  color: inherit;
}
.brand svg {
  flex: none;
  border-radius: var(--radius-small);
}
.logo-tile {
  fill: var(--accent);
}
.logo-mark {
  fill: var(--accent-ink);
}
nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s1) var(--s4);
}
nav a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--muted);
  font-weight: 600;
  text-decoration: none;
}
nav a:hover,
nav a[aria-current="page"] {
  color: var(--ink);
}
nav a[aria-current="page"] {
  box-shadow: inset 0 -3px 0 var(--accent);
}
h1,
h2 {
  font-family: var(--font-head);
  line-height: 1.15;
  letter-spacing: -0.015em;
}
h1 {
  margin: var(--s6) 0 var(--s2);
  font-size: var(--t-2xl);
}
h2 {
  margin: var(--s6) 0 var(--s2);
  font-size: var(--t-lg);
}
p,
ul {
  margin: 0 0 var(--s3);
}
ul {
  padding-left: var(--s5);
}
li {
  margin-bottom: var(--s2);
}
a {
  color: var(--second);
  text-underline-offset: 0.15em;
}
:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
}
.dated {
  color: var(--muted);
  font-size: var(--t-sm);
}
.lead {
  font-size: var(--t-lg);
  line-height: 1.45;
}
.short {
  margin: var(--s5) 0 0;
  padding: var(--s4);
  border-left: 4px solid var(--accent);
  border-radius: var(--radius-small);
  background: var(--sunk);
}
.short ul,
.short li:last-child {
  margin-bottom: 0;
}
.pledge {
  padding: var(--s4);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
footer {
  margin-top: var(--s6);
  padding-top: var(--s4);
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: var(--t-sm);
}
footer p {
  margin-bottom: var(--s2);
}
`;

const LOGO = `<svg width="32" height="32" viewBox="0 0 512 512" aria-hidden="true"><rect class="logo-tile" width="512" height="512"/><g class="logo-mark"><rect x="108" y="128" width="48" height="256" rx="24"/><rect x="356" y="128" width="48" height="256" rx="24"/><path d="M218 208v96a14 14 0 0 0 21 12l72-48a14 14 0 0 0 0-24l-72-48a14 14 0 0 0-21 12z"/></g></svg>`;

/** A link to another site. */
const out = (url: string, text: string = url) => `<a href="${url}" rel="noopener">${text}</a>`;

interface Page {
  path: string;
  /** In the browser tab, after the app's name. */
  title: string;
  description: string;
  body: (email: string) => string;
}

function render(page: Page, email: string): string {
  const mail = `<a href="mailto:${email}">${email}</a>`;
  const link = (path: string, label: string) => `<a href="${path}"${path === page.path ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${page.description}">
<title>${APP_NAME}${page.title ? `: ${page.title}` : ""}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="sheet">
<header class="top">
<a class="brand" href="${HOME}">${LOGO}${APP_NAME}</a>
<nav aria-label="Pages">${link(HOME, "About")}${link(PRIVACY, "Privacy Policy")}${link(TERMS, "Terms")}</nav>
</header>
<main>
${page.body(mail)}
</main>
<footer>
<p>${APP_NAME}. Questions or complaints: ${mail}</p>
<p><a href="${HOME}">About</a> | <a href="${PRIVACY}">Privacy Policy</a> | <a href="${TERMS}">Terms of Use</a> | <a href="/">Team sign-in</a></p>
</footer>
</div>
</body>
</html>
`;
}

const home: Page = {
  path: HOME,
  title: "",
  description: `${APP_NAME} turns streams into short vertical clips and posts them to the channels their owners connect.`,
  body: (mail) => `<h1>${APP_NAME}</h1>
<p class="lead">${APP_NAME} turns live streams and recordings into short vertical clips, and posts the clips its team approves to the team's own channels on YouTube and other video platforms.</p>

<h2>What it does</h2>
<ul>
<li>It takes streams only from creators who allow clipping. Every clip keeps a record of the permission it relies on.</li>
<li>It cuts the best moments into vertical clips with captions.</li>
<li>A team member looks at each clip and approves or rejects it.</li>
<li>Approved clips are uploaded to the channels the team has connected, and their views are shown to the team.</li>
</ul>

<h2>Who can use it</h2>
<p>${APP_NAME} is a private tool. Only people the team has invited can sign in. There is no public sign-up.</p>

<h2>Why it asks for access to a YouTube channel</h2>
<p>To post a clip to a YouTube channel, the channel's owner signs in with Google and lets ${APP_NAME} upload videos to that channel. ${APP_NAME} uses that access for three things only: to show which channel is connected, to upload the clips the team approved, and to read how those clips and the channel are doing. It asks for nothing else, shows no ads and sells no data.</p>
<p>The <a href="${PRIVACY}">Privacy Policy</a> says exactly what is read from Google and YouTube, where it is kept and how to have it deleted. The <a href="${TERMS}">Terms of Use</a> are the rules for using the service.</p>

<h2>Contact</h2>
<p>Write to ${mail}.</p>`,
};

const privacy: Page = {
  path: PRIVACY,
  title: "Privacy Policy",
  description: `What ${APP_NAME} reads from Google and YouTube, why, where it is kept, and how to have it deleted.`,
  body: (mail) => `<h1>Privacy Policy</h1>
<p class="dated">Effective ${EFFECTIVE_DATE}</p>
<div class="short">
<ul>
<li>We use your Google sign-in only to post the clips you chose to post to your own YouTube channel, and to show how they do.</li>
<li>We do not sell it, share it or show ads.</li>
<li>You can take the access away at any time, and we delete what we hold within ${DELETE_WITHIN_DAYS} days of your asking.</li>
</ul>
</div>

<h2>Who we are</h2>
<p>${APP_NAME} is a private tool run by a small team, at clip.techinsiderbytes.com. It turns streams into short vertical clips and posts them to channels on YouTube and other video platforms. Only people the team has invited can sign in. "We" in this policy is that team, and "you" are a person who signs in or who connects a channel.</p>
<p>${APP_NAME} uses YouTube API Services to connect a YouTube channel and upload to it. By using those features you also agree to be bound by the ${out(YOUTUBE_TERMS_URL, "YouTube Terms of Service")}, and Google handles your data under the ${out(GOOGLE_PRIVACY_URL, "Google Privacy Policy")}.</p>

<h2>What we get from Google and YouTube</h2>
<p>When you connect a YouTube channel, you sign in on Google's own page and Google shows you what ${APP_NAME} asks for. We never see your Google password. After you agree, we receive and use:</p>
<ul>
<li><strong>Access tokens</strong>: the keys Google issues so that we can act for the channel within what you allowed.</li>
<li><strong>The channel's identity</strong>: its ID, name, handle and picture. Where Google's page lists them, also the name, email address and picture of the Google account you signed in with.</li>
<li><strong>Permission to upload videos</strong> to the channel, and to set the title, description and settings of the videos we upload.</li>
<li><strong>Figures about the channel and the videos we uploaded</strong>: subscribers, views, likes and comment counts.</li>
</ul>
<p>We do not read your watch history, your subscriptions, your playlists or your messages, and we do not change or delete videos we did not upload.</p>
<p>Separately, and without any sign-in, we read public YouTube information with an API key: whether a public channel is live, its public videos, and the titles and view counts of public videos about the games we cover. It is not linked to anyone's Google account.</p>

<h2>Why we use it</h2>
<ul>
<li>To show you and the team which channel is connected.</li>
<li>To publish the clips the channel's owner or team chose to post, at the times they chose.</li>
<li>To show how those clips and the channel are doing, so the team can decide what to post next.</li>
</ul>
<p>We use it for nothing else. We do not use it for advertising, we do not build profiles of people, and we do not use data received through a Google sign-in to develop, improve or train artificial intelligence or machine learning models. The titles of public videos, read with the API key, may be sent to an AI service (OpenAI or Google Gemini) to sort them by topic. Nothing received through a Google sign-in is sent to one.</p>

<h2>Where it is kept</h2>
<p>Everything is kept on one server that we rent and run ourselves.</p>
<ul>
<li>The access tokens are held in Postiz, the open-source posting tool we run on that server, in its database. For a channel connected directly in the ${APP_NAME} app, they are held in a keys file on the same server that only the app can read.</li>
<li>The channel's identity, the figures and the list of what was posted are held in the app's database on the same server.</li>
<li>The server makes a backup copy of both databases every day and keeps only the newest few.</li>
</ul>
<p>The app is reached only over an encrypted connection, and only by team members who have signed in through Cloudflare Access. The tokens are never shown in the app and never written to its logs.</p>

<h2>Who we share it with</h2>
<p>No one. We do not sell Google or YouTube data, rent it, trade it or pass it to advertisers, data brokers or any other company, and we show no ads.</p>
<ul>
<li>The videos you choose to post, with their titles and descriptions, go to YouTube. That is the purpose of the service.</li>
<li>The company that rents us the server, and Cloudflare, which carries the traffic to our site, handle the data only as needed to run the service for us.</li>
<li>No person on the team reads data received through a Google sign-in, except with your agreement, to keep the service secure, to fix a fault you reported, or where the law requires it.</li>
<li>We would hand data over if a law or a court order obliged us to.</li>
</ul>
<p class="pledge">${LIMITED_USE_SENTENCE} Read the ${out(USER_DATA_POLICY_URL, "Google API Services User Data Policy")}.</p>

<h2>How long we keep it</h2>
<ul>
<li>We keep the access tokens, the channel's identity and the figures for as long as the channel stays connected. The figures are refreshed regularly while it is.</li>
<li>When you ask us to disconnect a channel or to delete your data, we delete the tokens, the channel's identity and its figures within ${DELETE_WITHIN_DAYS} days.</li>
<li>When you take the access away at Google, the tokens stop working at once, and we delete what we hold within ${GONE_EVERYWHERE_DAYS} days.</li>
<li>Backup copies are replaced within days, and none that still holds your data is kept longer than ${GONE_EVERYWHERE_DAYS} days after the deletion.</li>
<li>Videos already posted stay on YouTube until you remove them there. The public link of a posted video may stay in our list of posts.</li>
</ul>

<h2>How to take the access away and have your data deleted</h2>
<ul>
<li>Take the access away yourself, at any time, on your Google Account's permissions page: ${out(GOOGLE_PERMISSIONS_URL)}. Pick ${APP_NAME} and remove its access.</li>
<li>To have everything we hold about you and your channel deleted, write to ${mail} from the address you signed in with, or name the channel. We delete it within ${DELETE_WITHIN_DAYS} days and tell you when it is done.</li>
<li>You can also ask us what we hold about you, or to correct it, at the same address.</li>
</ul>

<h2>Cookies and analytics</h2>
<ul>
<li>These public pages set no cookies and load nothing from other sites. We run no analytics, no trackers and no ads anywhere in ${APP_NAME}.</li>
<li>When a team member signs in, Cloudflare Access sets a sign-in cookie. It is needed to stay signed in and is used for nothing else. Cloudflare may also set cookies it needs to protect the site.</li>
<li>The app keeps a few display choices, such as light or dark, in the browser's own storage. When it is installed on a phone, it keeps a copy of its own files there so that it opens quickly.</li>
<li>A team member who turns on notifications gives us the address their browser issues for sending them. It is deleted when they turn notifications off.</li>
</ul>

<h2>Children</h2>
<p>${APP_NAME} is a work tool for adults. It is not meant for children, and we do not knowingly collect data about them.</p>

<h2>Changes</h2>
<p>When we change what we collect or how we use it, we change this page and its date first. If a change means using Google data in a new way, we ask you to agree before we do it.</p>

<h2>Contact</h2>
<p>Questions, complaints and deletion requests: ${mail}.</p>`,
};

const terms: Page = {
  path: TERMS,
  title: "Terms of Use",
  description: `The rules for using ${APP_NAME}, including its YouTube features.`,
  body: (mail) => `<h1>Terms of Use</h1>
<p class="dated">Effective ${EFFECTIVE_DATE}</p>
<p class="lead">These are the rules for using ${APP_NAME}. By signing in, or by connecting a channel, you agree to them.</p>

<h2>The service</h2>
<p>${APP_NAME} turns live streams and recordings into short vertical clips and posts the clips its team approves to the channels connected to it. It is a private tool run by a small team at clip.techinsiderbytes.com.</p>

<h2>Who may use it</h2>
<p>Only people the team has invited. Keep your sign-in to yourself, and tell us at once if someone else may have used it.</p>

<h2>YouTube</h2>
<p>${APP_NAME} uses YouTube API Services to connect YouTube channels and upload videos to them. By using these features you agree to be bound by the ${out(YOUTUBE_TERMS_URL, "YouTube Terms of Service")}. Google handles your data under the ${out(GOOGLE_PRIVACY_URL, "Google Privacy Policy")}, and our <a href="${PRIVACY}">Privacy Policy</a> says what we read from Google and YouTube and how to take the access away.</p>
<p>Other platforms you connect have their own terms, and you agree to follow those as well.</p>

<h2>Your channels</h2>
<ul>
<li>Connect only channels that are yours, or that you are allowed to manage.</li>
<li>A connected channel stays yours. You decide what is posted to it, and you can disconnect it at any time.</li>
<li>You are responsible for what is posted to your channel through ${APP_NAME}, as you are for anything else you post there.</li>
</ul>

<h2>What may be posted</h2>
<ul>
<li>Only clips from creators who allow clipping, each with a record of that permission, and within the rules the creator set.</li>
<li>Nothing that breaks the law, another person's rights or the rules of the platform it is posted to.</li>
<li>No leaked material, and no spam or misleading titles.</li>
</ul>
<p>We may hold back or remove a clip, or disconnect a channel, when these rules are broken or a creator or a platform asks us to.</p>

<h2>Other people's rights</h2>
<p>The streams stay the work of their creators, and the platforms' names and logos belong to the platforms. If you think a clip uses your work without permission, write to ${mail} and we will take it down while we look into it.</p>

<h2>No promises we cannot keep</h2>
<p>The service is provided as it is. We work to keep it running and correct, but we do not promise that it will always be available, that a clip will be posted at a given time, or that a clip will be seen or earn money. Platforms can change or refuse what is posted to them, and that is outside our control.</p>
<p>As far as the law allows, we are not liable for indirect losses, such as lost income or lost data, from using the service or from not being able to use it. Nothing here limits rights the law gives you that cannot be limited.</p>

<h2>Stopping</h2>
<p>You can stop using ${APP_NAME} at any time and ask us to delete your data, as the <a href="${PRIVACY}">Privacy Policy</a> describes. We can end your access if you break these terms, or if we stop running the service.</p>

<h2>Changes</h2>
<p>When we change these terms, we change this page and its date. If you keep using the service after that, you agree to the new terms.</p>

<h2>Contact</h2>
<p>Write to ${mail}.</p>`,
};

const PAGES: Page[] = [home, privacy, terms];

function send(res: Response, html: string): void {
  res
    .status(200)
    .set({
      "Cache-Control": "public, max-age=300",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    })
    .type("html")
    .send(html);
}

/**
 * Serves the public pages. Without a contact address they answer 503 rather than a policy that
 * names nobody to write to (and never the app's own shell, which would look like a page to Google).
 */
export function publicPages(app: Express, supportEmail: string | null): void {
  for (const page of PAGES) {
    app.get(page.path, (_req, res) => {
      if (!supportEmail) {
        res.status(503).type("text/plain").send("This page is not set up yet.");
        return;
      }
      send(res, render(page, supportEmail));
    });
  }
}
