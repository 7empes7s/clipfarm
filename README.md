# clipfarm

Turns other creators' streams and VODs (with their permission, through clipping programs such as
Whop Content Rewards) into short vertical clips for TikTok, YouTube Shorts and Instagram Reels.

This first version covers the foundation: campaigns with permission records, a one-at-a-time job
queue, and **link → audio → word-timed transcript**.

## Requirements

- Node 22+
- `ffmpeg` and `ffprobe` on the PATH
- `yt-dlp` on the PATH for real downloads (not needed for tests or the fake mode)

## Run it

```sh
npm install
npm run dev        # API on :3000 (tsx watch) + Vite client on :5173 with /api proxied
npm run build      # server to dist/server, client to dist/client
npm run preview    # built client + API on one port ($PORT, default 3000)
```

On an empty gallery, the Inbox has a **Load demo clips** button: a queued job makes two demo
creators and ten clips from generated test patterns (about 20 s), so the review can be tried right
away. Demo campaigns allow no platform, so demo clips can be exported but never posted.

Try it without network or API keys (fake downloader makes a 10 s test clip, fake transcriber
returns fixed words):

```sh
npm run build && CLIPFARM_FAKES=1 PORT=3000 npm run preview
```

## Settings (env vars)

Export them in your shell or put them in a `.env` you load yourself (never commit it; see
`.env.example`).

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port for the API and, in preview, the client |
| `DATA_DIR` | `./data` | Folder for the SQLite database |
| `OPENAI_API_KEY` | – | Key for the Whisper API. Without it, transcription jobs fail with a clear message |
| `TRANSCRIBER` | `openai` | `openai` or `fake` |
| `DOWNLOADER` | `yt-dlp` | `yt-dlp` or `fake` |
| `YT_DLP_BIN` | `yt-dlp` | Path to the yt-dlp binary |
| `CLIPFARM_FAKES` | – | `1` uses the fakes (downloader, transcriber, posting) and adds a demo-clip button for e2e |
| `POSTIZ_URL` | – | Address you open Postiz at, e.g. `https://postiz.techinsiderbytes.com` |
| `POSTIZ_API_KEY` | – | From Postiz > Settings > Public API |
| `UPLOAD_POST_API_KEY` | – | Upload-Post API key (instead of Postiz) |
| `UPLOAD_POST_USER` | – | The Upload-Post profile that holds the accounts |
| `UPLOAD_POST_PLATFORMS` | `tiktok,youtube,instagram` | Platforms connected on that profile |
| `POSTING_SERVICE` | auto | `postiz`, `upload-post` or `none`; only needed when both are set |
| `POSTING_REFRESH_MINUTES` | `60` | How often post links and views are read (5 or more) |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | – | A Twitch app (dev.twitch.tv/console) for the watchlist's Helix calls (app access token) |
| `YOUTUBE_API_KEY` | – | YouTube Data API key for the watchlist |
| `WATCHLIST_POLL_MINUTES` | `15` | How often the watchlist checks for live streams and new VODs (5 or more) |

## Posting (Postiz or Upload-Post)

clipfarm does not post to each platform itself. A posting service holds the connected accounts
(YouTube, TikTok, Instagram, X) and does the posting and scheduling; clipfarm uploads the
approved MP4 with its caption and keeps what is ours: the permission gate, spacing, Whop
submissions and earnings.

**Postiz** (self-hosted, see `ops/postiz/RUNBOOK.md` to install it):

1. In Postiz, connect the accounts, then copy the key from Settings > Public API.
2. Set `POSTIZ_URL` and `POSTIZ_API_KEY` on the clipfarm server and restart it.
3. Check the link with `npm run postiz:check`, then open Clips: it says "Posting through Postiz".

Only Postiz's public HTTP API is called, so none of its (AGPL) code is part of clipfarm. Its API
allows about 30 calls an hour, so views are read hourly and at most 20 posts per refresh.

**Upload-Post** (hosted, paid): set `UPLOAD_POST_API_KEY`, `UPLOAD_POST_USER` (the profile name)
and `UPLOAD_POST_PLATFORMS`. Its daily caps (YouTube 10, TikTok 15, Instagram 50) are shown when
posting and enforced before anything is sent.

Without either, posting says what to set, and **Export** still works: MP4, caption (credit, the
brief's links and hashtags) and a Share button for posting by hand from the phone.

Rules the server enforces before calling any service: the clip is approved, its creator has an
active permission record whose brief allows each platform (and is still in force at the post's
time), the service's daily cap is not passed, and each account keeps the spacing set in Clips >
"Spacing between posts" (default 3 a day, 90 minutes apart: busy accounts move to the next free
time). TikTok and YouTube keep API posts private until the posting app passes their review, and
Instagram needs a Business or Creator account.

Tracking: every post stores clip, platform, account, link, time, permission record and campaign.
Views come from the service on a timer, or by hand. "Mark sent to Whop" records the submission
(Whop has no clipper API). Stats shows posts, views and estimated earnings (views × pay per 1,000,
counted once a post reaches the campaign's minimum views) per campaign and platform, plus cost per
approved clip.

## Watchlist

The **Watchlist** tab follows the streamers worth clipping: their Twitch, Kick and YouTube channels,
language, games (GTA VI first) and clipping program (Whop Content Rewards, their own program, Kick's
clipping program, or none known). It starts from `server/sources/watchlist/seed.json` (names and
handles only: the most-clipped streamers of 2026 and the top GTA streamers on Twitch and Kick, with
the sources and date) on the first start; after that the list is edited in the app.

- **Permission first.** A creator counts as allowed only when a campaign in Sources (found by the
  same name, or picked in Edit) has an active permission record. Without one they are watched but
  never ingested: "Needs permission: join their program".
- **New VODs.** Every `WATCHLIST_POLL_MINUTES` the server reads Twitch Helix
  (`videos?type=archive`, `streams`), Kick's public channel endpoints and YouTube's uploads playlist
  (1 quota unit a call, not search). A finished VOD from the last 48 hours whose category or title
  names one of the creator's games (and no leak) is queued for ingest, newest first, when the
  creator's **Auto-ingest** switch is on. The job queue still runs one job at a time. The same
  stream simulcast on two platforms is queued once.
- **Live now** shows who on the list is streaming and what.
- A platform that errors is backed off (5 min, doubling up to 6 h, longer if it sends Retry-After);
  a platform without keys is skipped and the tab says what to set.

## Checks

```sh
npm run lint
npm run typecheck
npm test           # Vitest: unit tests + a real-ffmpeg fixture test on a generated sample
npm run test:e2e   # Playwright at 390 px against the built app, with fakes
```

No test touches the network or a paid API: yt-dlp, OpenAI, Postiz, Upload-Post, Twitch, Kick and YouTube are faked
(adapter tests use fixtures of their documented answers). Sample media is generated
by ffmpeg (`testsrc` + `sine`) during the test and deleted after; no media is committed.

## How it works

- `server/sources/`: a source is a creator plus permission records (`whop-campaign`,
  `direct-permission` or `own-content`, with campaign link, brief rules, pay per 1,000 views,
  minimum views, allowed platforms and end date). The server refuses to ingest from a source
  without an active record, both when the link is added and again when the job runs.
- `server/jobs/`: a SQLite-backed queue. One job at a time (the box is shared), automatic retries,
  cancel, progress, and a temp folder per job that is always removed.
- `server/pipeline/ingest/`: yt-dlp downloads **audio only** (`-f bestaudio`, ~60 MB per hour)
  plus title, duration and chapters. The video is not downloaded here; the render step will fetch
  only the picked sections.
- `server/pipeline/transcript/`: a `Transcriber` interface with word timestamps. The `openai`
  adapter calls `whisper-1` (`verbose_json`, word granularity), splits audio over 25 MB into
  overlapping chunks and merges the timings. The cost of each VOD is stored.
- `server/publish/`: a `PostingService` interface with Postiz, Upload-Post and fake adapters,
  plus pure planners for the permission/brief gate, spacing, captions and earnings.
- `server/clips/`: clips, review decisions (approve, reject with a reason, undo of the last one; all
  stored in `clip_reviews` for tuning picks later) and edits (trim, title, hook, caption text,
  layout). Saving an edit marks the clip "being remade" and queues a `render-clip` job.
- `server/pipeline/rerender/`: a pure planner (9:16 crop math for the stacked / center / full
  layouts, caption lines, ASS subtitles) and a runner that cuts the clip again from its master (the
  longer source section) with ffmpeg, one job at a time. The face cam box is set per creator in
  Sources and used by the stacked layout.
- `client/`: the phone-first gallery (React + Vite). Tabs: Inbox (one clip at a time, autoplay
  muted, tap for sound; swipe right or Approve, swipe left or Reject + a reason; Edit; Undo; on
  desktop an "Up next" grid and keys A / R then 1-5 / E / arrows / Z), Approved and Posted
  (posting, export, views, Whop), Sources (campaigns, face cam), Jobs (progress, cancel, try again)
  and Stats. Rejected clips are one tap away from the Inbox.
- `shared/`: types used by both.

## Manual check with a real link (not run in CI)

1. Install `yt-dlp` and set `OPENAI_API_KEY`.
2. `npm run build && PORT=3000 npm run preview`, open http://localhost:3000.
3. Add a campaign you really have permission for, then paste a short VOD link (a few minutes).
4. The work queue shows "Downloading audio", then "Transcribing", then "Done". Open
   "Show transcript" and check the words and that the cost is a few cents at most.
