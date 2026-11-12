# clipfarm

Turns other creators' streams and VODs (with their permission, through clipping programs such as
Whop Content Rewards) into short vertical clips for TikTok, YouTube Shorts and Instagram Reels.

It covers campaigns with permission records, a one-at-a-time job queue, and
**link → audio → word-timed transcript → ranked picks → captioned 9:16 clips**.

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

The **Dashboard** has a **Load demo data** button on an empty database: the same ten demo clips
plus two finished demo streams with stage times, review decisions, posts with views on three demo
accounts and 30 days of account stats, so every dashboard section can be tried. The demo posts are
records only (nothing is sent), and their demo campaign has already ended, so nothing demo can be
posted.

## The dashboard (installable on the phone)

Open the app and tap **Dashboard** (or the installed app, which opens on it). On iPhone: Safari >
Share > Add to Home Screen; on Android: Chrome's menu > Install app. A service worker keeps the
app shell, so it opens without a network; numbers load once it is back.

- **Today**: clips waiting for review, approved but not posted, posted today, views today, estimated
  earnings and cost this week, cost per approved clip, and the job running now with its progress
  and time left.
- **Progress**: the goals (O1: clips per hour of stream, minutes per hour of stream, share
  approved; O2: review time per clip) and each stream's stages (transcript, picks, render) with
  the time each took.
- **Experiment**: what happened to experiment posts, in total, per burner account and per creator:
  posts, views, claims, removals, strikes and the time to the first claim. The posting service
  reports these where it can; otherwise tap Claim, Removed or Strike on a post. A strike switches
  the burner off and says why, until you switch it on again in its settings.
- **Trends** ("What's working today"): the fastest GTA VI Shorts of the last 48 hours on YouTube,
  ranked by views an hour, grouped by moment type (police chase, crash, first reaction…) and hook
  pattern, with example titles and links (no video is downloaded), the fastest-rising streamers,
  and your approved clips that fit. It reads once a day and on **Refresh**, within 1,500 YouTube
  quota units a day (shown; a refresh costs about 202). Titles are tagged by the AI model when an
  OpenAI key is set, otherwise by keywords, always against a fixed list. New picks of a trending
  moment type get a few points (set on the same screen, 0 is off) and say why ("+trend: police
  chase"); the winning hook patterns are offered to the hook writer.
- **Hook lab**: off by default. Switched on, each approved clip that is not posted yet gets 2-3
  hook variants (another hook and title on the same cut), each posted to its own **burner**
  account (it needs two burners on one platform that the clip's permission routes to). After the
  window (6 hours by default) the variant with the most views an hour goes to the main accounts;
  nothing goes to a main account before that, and an experiment creator's clips never do. A
  variant that was claimed, removed or struck cannot win. The scoreboard shows which hook
  patterns win for you.
- **Outputs**: every clip with its status, where it was posted, links and views; filters by
  creator, campaign, platform and date; tap ▶ to play.
- **Accounts** (Posting accounts): several accounts per platform, each linked once in the posting
  service by hand and picked up by "Sync accounts". Settings per account: role (main or burner),
  niche, posts a day and minutes between posts (empty follows the shared spacing), status
  (healthy, limited or banned, set by hand), on/off, and routing: which permission kinds the
  account takes (every kind to start with) and, optionally, the Whop campaigns pinned to it. A
  clip only posts to accounts that take its permission kind, so ticking only "Whop campaign" on
  one account and unticking it on the others keeps a channel for campaign clips; a pinned campaign
  posts on that platform only from its account. With no account for a kind the clip says so ("No
  account takes “Whop campaign” clips yet") and nothing is posted. One card per account: followers and growth,
  views per day, average views per post, top 5 clips and posts in the last 7 days against the
  spacing plan. Stats are read from Postiz (`/analytics/{integration}`, at most 4 accounts per
  read) or Upload-Post (`/analytics/{profile}`, one call) at most every 6 hours and cached, so
  opening the dashboard never spends the service's API limit. Where the service has no follower
  numbers, type them in by hand; the card says "Entered by hand".
- **Earnings**: per campaign and platform: views, posts over the minimum, estimated payout, how
  many were sent to Whop, this week and in all.

Try it without network or API keys (fake downloader makes a test clip, fake transcriber returns
fixed words, fake picker takes the loudest moments). Use a 40 s fake VOD so a 15-60 s clip fits:

```sh
npm run build && CLIPFARM_FAKES=1 FAKE_VOD_SEC=40 PORT=3000 npm run preview
```

## Settings (env vars)

Export them in your shell or put them in a `.env` you load yourself (never commit it; see
`.env.example`).

The keys (OpenAI and the picking model, Twitch, YouTube, Postiz, Upload-Post) can also be pasted
in the app: **⋯ > Settings** (`#settings`). Each row has Save, Test (one cheap read-only call),
Replace and Remove. A saved key is used on the next call, with no restart, and wins over the env
variable of the same name, which stays as the fallback. They are kept in `DATA_DIR/secrets.json`
(mode 600, never in git, logs, answers or the backup); the server never sends a value back, only
"set, ends in …a1b2". Where the server listens, its folders, the access gate and demo mode stay
env-only.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port for the API and, in preview, the client |
| `HOST` | every interface | Address to listen on; the live box uses `127.0.0.1` |
| `CLIPFARM_REQUIRE_ACCESS` | off | `1` on the live box: requests without Cloudflare Access's `Cf-Access-Jwt-Assertion` header are refused (clipfarm has no login of its own) |
| `DATA_DIR` | `./data` | Folder for the SQLite database and the local engine's programs and models (`models/`) |
| `OPENAI_API_KEY` | – | Optional. For "Use cloud AI for speed" on the Dashboard, tagging the trend radar's titles and writing hook variants; without it everything runs locally |
| `TRANSCRIBER` | local engine | `fake` skips real transcription |
| `WHISPER_BIN` / `LLAMA_SERVER_BIN` | downloaded | Your own whisper.cpp `whisper-cli` / llama.cpp `llama-server` (needed where there is no ready-made Linux build, e.g. macOS) |
| `DOWNLOADER` | `yt-dlp` | `yt-dlp` or `fake` |
| `YT_DLP_BIN` | `yt-dlp` | Path to the yt-dlp binary |
| `CLIPFARM_FAKES` | – | `1` uses the fakes (downloader, transcriber, picker, posting) and adds a demo-clip button for e2e |
| `FAKE_VOD_SEC` | `10` | Length of the fake downloader's test clip |
| `PICKER` | local engine | `fake` takes the loudest moments (demos only, it cannot flag spoilers) |
| `LLM_API_KEY` | `OPENAI_API_KEY` | Key for the cloud picking model (only used with "Use cloud AI for speed") |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible API, e.g. `https://openrouter.ai/api/v1`, `https://api.cerebras.ai/v1` |
| `LLM_MODEL` | `gpt-4o-mini` | Model name at that API (must support JSON-schema answers) |
| `LLM_USD_PER_MTOK_IN` / `_OUT` | `0` | Model list prices per million tokens, for the cost per clip |
| `MAX_PICKS` | `15` | Most clips kept per VOD |
| `MEDIA_DIR` | `./media` | Where clips, thumbnails and their masters are kept (never committed) |
| `RENDER_PRESET` | `veryfast` | x264 preset for clips |
| `POSTIZ_URL` | – | Address you open Postiz at, e.g. `https://postiz.techinsiderbytes.com` |
| `POSTIZ_API_KEY` | – | From Postiz > Settings > Public API |
| `UPLOAD_POST_API_KEY` | – | Upload-Post API key (instead of Postiz) |
| `UPLOAD_POST_USER` | – | The Upload-Post profile that holds the accounts |
| `UPLOAD_POST_PLATFORMS` | `tiktok,youtube,instagram` | Platforms connected on that profile |
| `POSTING_SERVICE` | auto | `postiz`, `upload-post` or `none`; only needed when both are set |
| `POSTING_REFRESH_MINUTES` | `60` | How often post links and views are read (5 or more) |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | – | A Twitch app (dev.twitch.tv/console) for the watchlist's Helix calls (app access token) |
| `YOUTUBE_API_KEY` | – | YouTube Data API key for the watchlist and the trend radar |
| `WATCHLIST_POLL_MINUTES` | `15` | How often the watchlist checks for live streams and new VODs (5 or more) |

## Live box (clip.techinsiderbytes.com)

`ops/clipfarm/RUNBOOK.md` puts clipfarm on Mulinux behind Caddy, the Cloudflare tunnel and a
Cloudflare Access sign-in: systemd unit, `deploy.sh` (build a commit, switch, health-check, roll
back), daily database backup and media cleanup. `npm run clipfarm:check`, on the box, says
whether the service, its port, Caddy and the sign-in are in place; it only reads.

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
time; an account's own pace from Dashboard > Accounts wins). One clip never goes out on two of our
accounts at the same time: each next account follows at least its spacing later. An account that
is switched off or marked banned is left out with a note. When posting, main accounts whose niche
fits the clip start ticked; burners are picked by hand. TikTok and YouTube keep API posts private until the posting app passes their review, and
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
npm run e2e:live   # the whole flow, link → clips → review → post, against its own preview or any BASE_URL
```

`npm run e2e:live` runs one flow at 390 px and on desktop and ends with a pass/fail table per
step, including how long the link took to become clips (goal: under 30 minutes). Without
`BASE_URL` it builds and starts its own preview with the fakes; `BASE_URL=http://localhost:3000
npm run e2e:live` tests a preview you started (`CLIPFARM_FAKES=1 FAKE_VOD_SEC=40`). It adds a test
campaign named "E2E test …" and removes it, with its clips and files, at the end. Posting stops
at the server's dry run (`POST /api/clips/:id/posts/dry-run`: every check, nothing sent or
stored) and the export pack; `E2E_DRY_RUN=0` posts through the test posting service and is
refused on any address that is not this machine. For the live site (service token, test video)
see step 12 of `ops/clipfarm/RUNBOOK.md`.

No test touches the network or a paid API: yt-dlp, OpenAI, Postiz, Upload-Post, Twitch, Kick and YouTube are faked
(adapter tests use fixtures of their documented answers). Sample media is generated
by ffmpeg (`testsrc` + `sine`) during the test and deleted after; no media is committed.

## How it works

- `server/sources/`: a source is a creator plus permission records (`whop-campaign`,
  `direct-permission` or `own-content`, with campaign link, brief rules, pay per 1,000 views,
  minimum views, allowed platforms and end date). The server refuses to ingest from a source
  without an active record, both when the link is added and again when the job runs.
  A fifth kind, `experiment`, tests what the platforms do to clips posted without the creator's
  permission: it needs no proof, only a note, and ends after 30 days unless a date is given. Its
  clips carry an "Experiment" badge and go to **burner accounts only**: main accounts are not in
  the picker, and exports and Whop refuse them (`requireActivePermission`, `accountsAllowedFor`).
  With no burner switched on, posting is refused with the reason. The content rules stay: no
  leaks, isolated cutscenes or ending spoilers.
- `server/jobs/`: a SQLite-backed queue. One job at a time (the box is shared), automatic retries,
  cancel, progress, and a temp folder per job that is always removed.
- `server/engine/`: clipfarm's own engine. `catalog.ts` pins every program and model to a
  SHA-256, `download.ts` fetches with resume and checks it, `memory.ts` is the guard, `llama.ts`
  runs the hook writer for one picking session, and `engine.ts` reports status, keeps the
  settings and hands the pipeline its transcriber and picker (local by default, cloud as an option).
- `server/pipeline/ingest/`: yt-dlp downloads **audio only** (`-f bestaudio`, ~60 MB per hour)
  plus title, duration and chapters. The video is not downloaded here; the render step will fetch
  only the picked sections.
- `server/pipeline/transcript/`: a `Transcriber` interface with word timestamps. The `local`
  one (default) runs whisper.cpp with VAD and parses its one-word segments. The optional `openai`
  adapter calls `whisper-1` (`verbose_json`, word granularity), splits audio over 25 MB into
  overlapping chunks and merges the timings. The cost of each VOD is stored.
  Ingest also measures loudness per second (ffmpeg `ebur128`) while the audio is still there.
- `server/pipeline/picks/`: plain signals (loudness spikes, speech rate, laughing/shouting words,
  a slot for chat replay) find up to 30 candidate moments, snapped to sentence boundaries. The
  `local` picker (default) ranks them by those signals, screens them with keywords and writes
  hooks from the transcript or with the local writer. With cloud AI on, an
  OpenAI-compatible model ranks them with a strict JSON schema: start, end, hook, title, score,
  reason, layout and flags (spoiler, story cutscene, ending, leak, breaks the brief). The campaign
  brief and the creator's off-limits note go into the prompt. Then a plain-code gate drops anything
  flagged, anything mentioning a "No …" phrase from the brief, overlaps, and windows that cannot be
  cut to 15-60 s on sentence boundaries. Dropped picks are stored with the reason and never render.
- `server/pipeline/render/`: one job per kept pick. yt-dlp downloads only that section (±3 s,
  ≤1080p30). Layouts: *stacked* (the creator's face cam box on top, gameplay below; the box is
  drawn once per creator in Sources), *center* (9:16 gameplay crop), *full* (whole frame over a
  blurred copy). Karaoke captions (ASS, 2-4 words a line, the spoken word highlighted, clear of the
  bottom 20% and right 15%) and the hook for the first 2 s are burned in. Output: H.264 + AAC MP4,
  1080×1920, 30 fps, -14 LUFS, plus a thumbnail, in `media/clips/`. The padded section is kept
  next to it as the clip's master (for edits and re-renders in the gallery); other temp files go
  with the job's temp folder. Each render becomes a clip in the Inbox. The server log prints time
  per step and cost per clip, and the gallery shows them on each clip.
- `server/publish/`: a `PostingService` interface with Postiz, Upload-Post and fake adapters,
  plus pure planners for the permission/brief gate, spacing, captions and earnings.
- `server/clips/`: clips (each rendered pick becomes one, with its padded section kept as the
  master), review decisions (approve, reject with a reason, undo of the last one; all
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
  and Stats, plus the Dashboard. Rejected clips are one tap away from the Inbox.
- `server/accounts/`: our posting accounts and their settings (`accountsAllowedFor(permission)`
  says which a permission may post to; the routing rule itself is `shared/routing.ts`), account stats from the posting service, cached in SQLite behind a guard
  (how often, how many accounts per read), plus followers typed in by hand.
- `server/dashboard/`: builds the dashboard from our records and the cached account stats.
- `shared/`: types used by both, and `metrics.ts` (growth, averages, cost per approved clip, time
  left, review speed).

## The local engine (no outside AI service)

By default clipfarm transcribes and picks on its own machine; OpenAI is only an optional speed-up
("Use cloud AI for speed" on the Dashboard, once an OpenAI key is set in Settings).

- **Speech-to-text**: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) with
  [Silero VAD](https://github.com/snakers4/silero-vad) (MIT) first, so only speech is transcribed.
  One word per segment gives the word times the captions need. Default model `base.en`
  (`tiny.en` and `small.en` can be picked on the Dashboard).
- **Picks**: signals that need no AI rank the moments (loudness spikes, speech rate, hype and
  laughing words, shouted lines, chat spikes when there are any), and a keyword screen flags
  spoilers, endings, leaks and cutscenes. Hooks and titles are the line said at the peak, or, with
  the hook writer on, written by Qwen2.5-1.5B-Instruct (Apache-2.0) on
  [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT) with a JSON schema. The writer is
  loaded only while picking and can add flags, never clear them.
- **Setup**: on first start a job called "Engine setup" downloads the ready-made programs and the
  models into `DATA_DIR/models` (about 1.3 GB with the writer, 160 MB without). Every file is
  pinned to a SHA-256 in `server/engine/catalog.ts`; an interrupted download carries on where it
  stopped. The Dashboard shows "Local engine: ready" or what is missing, with a button.
- **Memory guard**: a model is not started when free memory is below its need plus 1 GB (or it
  does not fit under the service's own cap); the job says why. Without room for the writer, picks
  still come out, with transcript hooks and the reason on each pick.
- **Measured** on the 4-vCPU box with `base.en`: 10 minutes of generated speech → transcript and
  ranked picks in about 62 s (6 min per hour of stream), peak 440 MB. The writer adds about 15 s
  per moment (about 8 min for 30) at a 1.9 GB peak.

`npm run test:engine` runs the real engine on speech generated by ffmpeg (flite voice): it
downloads the pinned parts into `data/engine-test`, checks word times across silences, and holds
a 10-minute sample to the budget (250 s, 2.5 GB). CI runs it. `npm run test:engine:writer` does
the same for the hook writer (1.1 GB download, needs about 2.9 GB of free memory; not in CI).

## Manual check with a real link (not run in CI)

1. Install `yt-dlp`. Start the app and wait for "Local engine: ready" on the Dashboard.
2. `npm run build && PORT=3000 npm run preview`, open http://localhost:3000.
3. Add a campaign you really have permission for, then paste a short VOD link (a few minutes).
4. The work queue shows "Downloading audio", then "Transcribing", then "Done". Open
   "Show transcript" and check the words (the local engine costs nothing per minute).
