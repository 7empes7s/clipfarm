# clipfarm on Mulinux: runbook

This puts clipfarm (the gallery, the pipeline and posting) on Mulinux at
`https://clip.techinsiderbytes.com`, behind a Cloudflare sign-in, and covers updates, rollback,
logs, backups and restore.

**Who does what.** Every step is marked with its owner:

- **IT**: commands on the server, as root on Mulinux, in order. Each step says what you should see.
- **Manager**: taps in the Cloudflare dashboard (works on the phone) and the first sign-in.

| Step | What | Owner |
|---|---|---|
| 1 | Check the box | IT |
| 2 | Install Node 22, ffmpeg, yt-dlp | IT |
| 3 | User, folders, code | IT |
| 4 | Settings (keys) and the service | IT, keys from the manager |
| 5 | First deploy | IT |
| 6 | Caddy: route the hostname | IT |
| 7 | Cloudflare Access: the sign-in | Manager |
| 8 | Cloudflare tunnel: the public hostname | Manager |
| 9 | Check it, open it on the phone | IT, then manager |
| 10 | Backups and disk cleanup | IT |
| 11 | Point clipfarm at the local Postiz | IT, key from the manager |
| 12 | Test the live site end to end | Manager makes the token, then runs it (or IT does) |
| IT ops | Test keys, add a source, turn a video into clips, list clips: no browser | IT |

Do step 7 before step 8: the sign-in exists before the address does, so the gallery is never
open to the internet, not even for a minute.

**What gets installed**

| Piece | Where |
|---|---|
| Code | `/opt/clipfarm-live/`: `repo/` (git clone), `releases/<time>-<commit>/` (last 2 kept), `current` → the live release |
| Settings and keys | `/etc/clipfarm/clipfarm.env` (mode 600, never in git) |
| Scripts root runs | `/usr/local/sbin/clipfarm-deploy`, `/usr/local/sbin/clipfarm-backup` (root-owned copies of `deploy.sh`, `backup.sh`) |
| Ops command | `/usr/local/sbin/clipfarm-ops` (copy of `ops.sh`; runs as the `clipfarm` user through `systemd-run`, see "IT ops") |
| Data | `/var/lib/clipfarm/`: `clipfarm.db` (SQLite) and `media/` (final clips) |
| Web app | `127.0.0.1:5310` only, published through Caddy (`:80`) and the Cloudflare tunnel |
| systemd | `clipfarm.service`, `clipfarm-backup.service` + `.timer`, `clipfarm-media-cleanup.service` + `.timer` |
| Backups | `/opt/backups/YYYY-MM-DD/clipfarm.db.gz`, newest 3 kept, database only |

Memory: the service is capped at 3072 MiB (`MemoryMax`), which covers the server plus the one
heavy job that runs at a time (ffmpeg, yt-dlp, the local speech model at about 0.5 GiB, or the
local hook writer at about 1.9 GiB). Idle it uses about 100 MiB. Before it loads a model the
engine checks that the box has that much free plus 1 GiB spare, and refuses with the reason if not.

Engine: clipfarm transcribes and picks highlights on this box, with no outside AI service. On
its first start it downloads its programs and models into `/var/lib/clipfarm/models` (about
1.3 GB, each file checked against a pinned SHA-256) as a job called "Engine setup". The
Dashboard shows "Local engine: ready", or what is missing with a button that fetches it.

---

## 1. Check the box first (IT)

```bash
free -m          # "available" on the Mem: line should be 2000 or more
df -h /          # "Avail" should be 15G or more (a 1-hour VOD needs a few GB while it is worked on)
ss -ltnp 'sport = :5310'                      # must print only the header line (port free)
grep -n 'clip\.techinsiderbytes' /etc/caddy/Caddyfile || echo "no clip block yet"   # expect "no clip block yet"
systemctl is-active caddy cloudflared         # expect two lines: active
```

If RAM is short, don't start clipfarm: say so to the manager. If port 5310 is taken, pick another
free port (check it the same way) and use it everywhere this runbook says 5310: `PORT` in
`/etc/clipfarm/clipfarm.env` (step 4) and the Caddy block (step 6). `deploy.sh` and
`clipfarm:check` read the port from that file.

## 2. Install Node 22, ffmpeg and yt-dlp (IT)

See what is already there:

```bash
command -v node && node -v      # need /usr/bin/node and v22.18 or newer
ffmpeg -version | head -1       # need any 6.x or newer
yt-dlp --version                # need a version from the last few months
git --version
```

Install only what is missing:

```bash
# Node 22 (NodeSource), if node is missing or older than 22.18
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# ffmpeg and git (libgomp1 is what the local engine's programs need; ffmpeg usually brings it)
apt-get install -y --no-install-recommends ffmpeg git libgomp1

# yt-dlp: the release binary (the apt one is too old for Twitch and YouTube)
curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
chmod 755 /usr/local/bin/yt-dlp
```

Run the four checks again: each prints a version. `command -v node` must print `/usr/bin/node`.
If it prints another path, use that path in `ExecStart=` of both `.service` files after
installing them (steps 4 and 10).

When downloads start failing months from now, update yt-dlp first: `yt-dlp -U`.

## 3. User, folders and code (IT)

```bash
useradd --system --home-dir /var/lib/clipfarm --shell /usr/sbin/nologin clipfarm
install -d -o clipfarm -g clipfarm -m 750 /var/lib/clipfarm /var/lib/clipfarm/media
install -d -o clipfarm -g clipfarm -m 755 /opt/clipfarm-live /opt/clipfarm-live/releases
install -d -o root -g root -m 700 /etc/clipfarm
runuser -u clipfarm -- git clone https://github.com/7empes7s/clipfarm.git /opt/clipfarm-live/repo
install -o root -g root -m 755 /opt/clipfarm-live/repo/ops/clipfarm/deploy.sh /usr/local/sbin/clipfarm-deploy
install -o root -g root -m 755 /opt/clipfarm-live/repo/ops/clipfarm/backup.sh /usr/local/sbin/clipfarm-backup
install -o root -g root -m 755 /opt/clipfarm-live/repo/ops/clipfarm/ops.sh /usr/local/sbin/clipfarm-ops
ls /opt/clipfarm-live /usr/local/sbin/clipfarm-*
```

You should see `releases repo` and the three scripts. They are copied to `/usr/local/sbin` on
purpose: root runs them, so they must be files only root can change (everything under
`/opt/clipfarm-live` belongs to the `clipfarm` user).

(If the repository is private, the clone asks for a login: use a read-only GitHub token as the
password.)

## 4. Settings and the service (IT, keys from the manager)

```bash
install -o root -g root -m 600 /opt/clipfarm-live/repo/ops/clipfarm/.env.example /etc/clipfarm/clipfarm.env
nano /etc/clipfarm/clipfarm.env
```

The keys do not have to go in this file: the manager pastes and tests them in the app, under
**⋯ > Settings** (`https://clip.techinsiderbytes.com/#settings`), and they are in use at once,
with no restart. Leave the key lines empty unless you are given keys to put here. A key saved in
Settings wins over the same line in this file; this file is the fallback.

The file explains every line. The ones that matter:

| Line | Value |
|---|---|
| `HOST`, `PORT`, `CLIPFARM_REQUIRE_ACCESS`, `DATA_DIR`, `MEDIA_DIR` | leave as they are (`127.0.0.1`, `5310`, `1`, `/var/lib/clipfarm`...) |
| `CLIPFARM_PUBLIC_URL`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | leave as they are: the server finds the Cloudflare team and application by itself from the public address (an env file without these lines works the same) |
| `OPENAI_API_KEY` | optional: only for "Use cloud AI for speed" on the Dashboard. Empty = everything runs on this box |
| `LLM_API_KEY`, `LLM_BASE_URL` | optional: only if cloud picks should use another provider |
| `LLM_MODEL`, `OPENAI_TRANSCRIBE_MODEL` | leave empty: the models are picked in the app under Settings > OpenAI. An env file that still says `LLM_MODEL=gpt-4o-mini` needs no edit: that line is ignored and the card says so |
| `POSTIZ_API_KEY` | step 11 |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `YOUTUBE_API_KEY` | watchlist; empty skips that platform |

Without keys clipfarm still starts and shows the gallery; jobs that need a missing key fail and
say which key.

Save a copy of the filled file in the team password manager: the backup does not include it.

Keys pasted in Settings are kept in `/var/lib/clipfarm/secrets.json` (owner `clipfarm`, mode 600).
The server writes it; never open, copy or print it. It is not in the backup either: after a
restore on a new box the keys are pasted again in Settings.

Install the service (it starts in step 5, once there is a release to run):

```bash
install -m 644 /opt/clipfarm-live/repo/ops/clipfarm/clipfarm.service /etc/systemd/system/clipfarm.service
systemctl daemon-reload
systemctl enable clipfarm
systemctl cat clipfarm | grep -E '^(User|ExecStart|MemoryMax)='
```

You should see `User=clipfarm`, `ExecStart=/usr/bin/node dist/server/index.js` and `MemoryMax=3072M`.

## 5. First deploy (IT)

```bash
clipfarm-deploy origin/main
```

It takes 2-4 minutes: it builds the newest commit of `main` in a fresh folder under
`/opt/clipfarm-live/releases/`, points `current` at it, starts the service and asks
`/api/health`. The last line must be:

`clipfarm deploy: <time>-<commit> is live and healthy at http://127.0.0.1:5310/api/health.`

If it ends with `there is no earlier release to go back to, so clipfarm is stopped`, the server
did not start: `journalctl -u clipfarm -n 50 --no-pager` says why (most often a typo in
`/etc/clipfarm/clipfarm.env`). Fix it and run the command again.

Check it by hand:

```bash
systemctl is-active clipfarm                                        # expect: active
curl -sS http://127.0.0.1:5310/api/health                           # expect: {"ok":true}
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5310/    # expect: 403
ss -ltnp 'sport = :5310'                                            # expect 127.0.0.1:5310, not 0.0.0.0 or *
```

The 403 is right: the gallery only answers requests that carry a sign-in signed by Cloudflare
Access for this application. The server checks the signature against the team's public keys, so
a header someone made up on the box (`-H "Cf-Access-Jwt-Assertion: x"`) gets 403 too. To work on
the box, use `clipfarm-ops` ("IT ops" below): it needs no sign-in.

## 6. Caddy: route the hostname to clipfarm (IT)

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)
printf '\n' >> /etc/caddy/Caddyfile
cat /opt/clipfarm-live/repo/ops/clipfarm/Caddyfile.snippet >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # expect "Valid configuration"
systemctl reload caddy
curl -sS -H 'Host: clip.techinsiderbytes.com' http://127.0.0.1/api/health   # expect: {"ok":true}
```

If `caddy validate` fails, put the backup back (`cp /etc/caddy/Caddyfile.bak-$(date +%F) /etc/caddy/Caddyfile`)
and look at how the existing `keel.techinsiderbytes.com` block is written; write the clipfarm
block the same way. If you changed the port in step 1, change `5310` in the block too.

Uploads: clipfarm takes links, not files, so the block needs no large upload limit (it stops
requests over 1 MB, which the app would refuse anyway).

## 7. Cloudflare Access: the sign-in (Manager)

The gallery can approve and post clips and has no password of its own. Cloudflare Access is its
login: only the emails you allow get in. Do this before step 8.

In a browser (the phone works):

1. Go to <https://one.dash.cloudflare.com> and pick the account that owns `techinsiderbytes.com`.
2. Left menu: **Access** → **Applications** (newer dashboards: **Access controls** → **Applications**)
   → **Add an application** → **Self-hosted**.
3. Fill in:
   - Application name: `clipfarm`
   - Session duration: `1 month` (so the phone does not ask every day)
   - **Add public hostname**: Subdomain `clip`, Domain `techinsiderbytes.com`, Path: leave empty
4. Under **Access policies** → **Create new policy** (or **Add a policy**):
   - Policy name: `manager`
   - Action: **Allow**
   - Include → Selector **Emails** → your email address (add more addresses later the same way)
   - Save the policy and select it for the application.
5. Login methods: leave **One-time PIN** on (Cloudflare emails you a 6-digit code). Turn
   **Instant Auth** on if only one method is listed.
6. Leave everything else as it is → **Save** / **Add application**.

Never add a policy with Include **Everyone** and Action **Allow** to this application.

**Paths that skip the sign-in: none.** Leave the whole hostname behind Access:

| Path | Skip Access? | Why |
|---|---|---|
| `/`, `/assets/*`, `/sw.js` | No | The app itself. The service worker is fetched with your sign-in cookie, so it works behind Access. |
| `/api/*` (clips, approve, post, videos) | Never | This is what Access protects. |
| `/api/health` | No | Only checked on the box (`deploy.sh`, `clipfarm:check`), which does not go through Cloudflare. |
| Webhooks | None exist | clipfarm calls Postiz and the platforms; nothing calls clipfarm from outside. If a webhook is added later, it needs its own secret and its own bypass, in that issue. |
| `/manifest.webmanifest`, `/icons/*` | No, unless installing fails (below) | The page asks for the manifest with your sign-in cookie, so it normally works behind Access. |

Only if "Add to Home Screen" on the phone shows no clipfarm name or icon (step 9): add a second
application so the phone can fetch the install files without a cookie. They hold nothing
private (a name, colours and the icon), and the server keeps exactly these paths open too.

1. **Access** → **Applications** → **Add an application** → **Self-hosted**, name `clipfarm install files`.
2. Add two public hostnames: `clip.techinsiderbytes.com` with Path `manifest.webmanifest`, and
   `clip.techinsiderbytes.com` with Path `icons/*`.
3. Policy: Action **Bypass**, Include **Everyone**. Save.

Don't bypass anything else. In particular not `/api/*`: the server would refuse it anyway
(`CLIPFARM_REQUIRE_ACCESS=1` turns away every request without a sign-in signed by Access).

## 8. Cloudflare tunnel: add the public hostname (Manager)

The tunnel is managed in the dashboard, not in a file on the server.

1. <https://one.dash.cloudflare.com> → **Networks** → **Tunnels** (newer: **Networks** → **Connectors** → **Cloudflare Tunnels**).
2. Click the tunnel Mulinux runs (status **Healthy**; it already has `keel.techinsiderbytes.com`
   and `postiz.techinsiderbytes.com`) → **Edit** / **Configure**.
3. Tab **Public Hostname** (newer: **Published application routes**) → **Add a public hostname**.
4. Fill in:
   - Subdomain: `clip`
   - Domain: `techinsiderbytes.com`
   - Path: leave empty
   - Service Type: `HTTP`
   - URL: `localhost:80` (the same as the keel entry)
5. **Save**. Cloudflare creates the DNS record by itself.

## 9. Check it, then open it on the phone (IT, then manager)

IT, on the box (allow a minute for DNS):

```bash
cd /opt/clipfarm-live/current && npm run clipfarm:check
```

You should see four `OK:` lines:

```
OK: the clipfarm service is active.
OK: something listens on 127.0.0.1:5310.
OK: Caddy routes clip.techinsiderbytes.com to clipfarm (/api/health answers).
OK: https://clip.techinsiderbytes.com/ sends visitors to the Cloudflare Access login.
```

A `NOT OK:` line says what is wrong and which step fixes it. The check only reads; run it as
often as you like. What the last line means when it is not OK:

| It says | Meaning | Fix |
|---|---|---|
| `answers 404 from Cloudflare` | The tunnel has no public hostname for `clip` | Step 8 |
| `answers 403 instead of the Cloudflare login` | The address works but there is no Access application on it (the server is refusing visitors itself) | Step 7 |
| `answers 200 without a sign-in: the gallery is open to the internet` | No Access application and the server's own gate is off | Step 7 now; set `CLIPFARM_REQUIRE_ACCESS=1` (step 4) and `systemctl restart clipfarm` |
| `answers 502` (or 530) | Cloudflare cannot reach the box | `systemctl is-active cloudflared caddy`; step 6 |

Manager, on the phone:

1. Open <https://clip.techinsiderbytes.com>. Cloudflare asks for your email, then for the code
   it emails you.
2. The clipfarm dashboard opens. Tap **Clips**: the gallery loads (empty on a new install).
3. Add it to the home screen: iPhone Safari → Share → **Add to Home Screen**; Android Chrome →
   menu → **Install app** / **Add to Home screen**. The icon is the clipfarm logo.
4. In a private window, open the address again and enter an email that is not allowed: no code
   arrives and you don't get in.

When the sign-in runs out (after a month), the app opens but shows that it cannot load: close
it, open it again and sign in.

## 10. Backups and disk cleanup (IT)

```bash
systemctl list-timers mimule-backup.timer postiz-backup.timer   # note the NEXT times
cd /opt/clipfarm-live/repo/ops/clipfarm
install -m 644 clipfarm-backup.service clipfarm-backup.timer clipfarm-media-cleanup.service clipfarm-media-cleanup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now clipfarm-backup.timer clipfarm-media-cleanup.timer
systemctl start clipfarm-backup.service        # take one backup now
journalctl -u clipfarm-backup.service -n 5 --no-pager   # expect "clipfarm backup: /opt/backups/<today>/clipfarm.db.gz (...)"
ls -l /opt/backups/$(date +%F)/clipfarm.db.gz
```

`clipfarm-backup.timer` runs at 04:40, after `mimule-backup` and Postiz's 04:30. If those run
later on this box, edit `OnCalendar=` in `/etc/systemd/system/clipfarm-backup.timer` to 10
minutes after the last of them, so all land in the same day folder.

What is and is not backed up:

- **Backed up:** the database (`/var/lib/clipfarm/clipfarm.db`): creators and their permission
  records, VODs, transcripts, picks, clips and their reviews, posts, stats. A consistent copy
  is taken while the server runs. The 3 newest are kept; other files in the backup folders are
  never touched.
- **Not backed up:** `/var/lib/clipfarm/media` (video files: clips can be rendered again from
  their source), `/etc/clipfarm/clipfarm.env` (keep it in the password manager) and
  `/var/lib/clipfarm/secrets.json` (the keys pasted in Settings: left out on purpose, so no copy
  of them sits in `/opt/backups`. After a restore on a new box, paste them again in Settings).

Disk cleanup: `clipfarm-media-cleanup.timer` runs at 05:00 and deletes the video files of clips
that were **rejected more than 14 days ago** (`MEDIA_KEEP_REJECTED_DAYS` in the env file).
Pending and approved clips are never deleted, and the clip's row stays in the database. To see
what it would delete, without deleting:

```bash
cd /opt/clipfarm-live/current
runuser -u clipfarm -- env $(grep -E '^(DATA_DIR|MEDIA_DIR|MEDIA_KEEP_REJECTED_DAYS)=' /etc/clipfarm/clipfarm.env) node ops/clipfarm/media-cleanup-cli.ts --dry-run
```

Downloads and working files of a job live in the service's private `/tmp`, are removed when
the job ends, and the whole folder is emptied when the service stops.

## 11. Point clipfarm at the local Postiz (IT, key from the manager)

Postiz runs on the same box (`ops/postiz/RUNBOOK.md`). clipfarm talks to it on the local port,
which skips Cloudflare and its 100 MB upload limit.

1. Manager: sign up on <https://postiz.techinsiderbytes.com> (the first account is the admin).
2. IT: run the Postiz installer (`ops/postiz/RUNBOOK.md`, step 1). It reads the API key from
   Postiz, checks it, writes `POSTIZ_URL` and `POSTIZ_API_KEY` into `/etc/clipfarm/clipfarm.env`
   and restarts clipfarm. Nobody copies or sees the key. The summary ends with:

```
  API key for clipfarm: works, saved in /etc/clipfarm/clipfarm.env (clipfarm restarted)
```

   A line `NOT OK: ...` says what is wrong (key refused, Postiz not running).

3. Manager: open clipfarm → **Clips**: it says "Posting through Postiz" and lists the accounts.

A clip is only ever posted when its creator has a permission record that allows that platform;
that rule is in the app and does not depend on this setup.

---

## 12. Test the live site end to end (Manager makes the token, then runs it)

`npm run e2e:live` drives the real site in a browser, at phone width and on desktop: it adds a
test campaign with a permission record, submits one video link, waits for the clips, plays one,
approves, rejects, undoes, edits, checks the export pack and the posting queue, reads the
dashboard, and removes everything it made. It ends with a pass/fail table and how long the link
took to become clips (the goal is under 30 minutes).

**It never posts.** Against any address that is not this machine it only runs as a dry run: the
server checks that the clip could be posted and sends nothing to Postiz or any platform. Asking
for real posting (`E2E_DRY_RUN=0`) against the live site is refused before a browser starts.

What it does cost: one download, one transcription and one picking call for the test video (a few
cents), and the job queue is busy for those minutes. Run it when no stream is being cut.

**12a. Make the service token (Manager, once).** The site sits behind the Cloudflare sign-in
(step 7), and a test cannot read your email. A service token is a second key, for this test only.

1. <https://one.dash.cloudflare.com> → **Access** → **Service auth** (newer dashboards:
   **Access controls** → **Service credentials**) → **Service Tokens** → **Create Service Token**.
2. Name: `clipfarm-e2e`. Duration: the shortest offered. **Generate token**.
3. Copy the **Client ID** and the **Client Secret** now: the secret is shown once. Keep them in
   your password manager, never in the repo, a chat or a ticket.
4. **Access** → **Applications** → `clipfarm` → **Policies** → **Add a policy**:
   - Policy name: `e2e test`
   - Action: **Service Auth** (not Allow: Allow would ask the token for an email code)
   - Include: **Service Token** → `clipfarm-e2e`
5. **Save**. The email policy from step 7 stays as it is.

When the test is done with, delete the token (**Service Tokens** → `clipfarm-e2e` → **Delete**)
or let it run out. A leaked token opens the gallery until then.

**12b. Pick the test video.** A short video (20 s to 2 min) with clear speech that we made
ourselves, or one whose owner said yes in writing. Never a real creator's stream. The suite
refuses to run against the live site without one.

**12c. Run it.** On any machine with this repo (`npm ci`, then once `npx playwright install
chromium`). The live site must already run the release that has this test (see Update below).
`read -s` keeps the secret out of the shell history:

```bash
read -rs -p "Client ID: " CF_ACCESS_CLIENT_ID && echo
read -rs -p "Client Secret: " CF_ACCESS_CLIENT_SECRET && echo
export CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET
BASE_URL=https://clip.techinsiderbytes.com \
E2E_VIDEO_URL=https://www.youtube.com/watch?v=OUR_OWN_TEST_VIDEO \
npm run e2e:live
```

| Setting | Needed | What it is |
|---|---|---|
| `BASE_URL` | Yes | The site to test |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Behind the sign-in | The service token from 12a; both or neither, and only sent over https |
| `E2E_VIDEO_URL` | On any live site | The test video from 12b |
| `E2E_PERMISSION_URL` | If the video is not ours | Link to the written permission; the test campaign is then saved as "Direct permission" instead of "Our own content" |
| `E2E_PIPELINE_MINUTES` | No | How long to wait for clips before failing: 30 on a live site |
| `E2E_DRY_RUN` | No | Leave it alone. `0` posts through the test posting service and only works on a local preview |

You should see one line per step and a table like this at the end:

```
clipfarm end to end: https://clip.techinsiderbytes.com (dry run: nothing is posted)

| Step                                                    | phone      | desktop     |
|---------------------------------------------------------|------------|-------------|
| The gallery loads and the server is healthy             | pass 1.4 s | pass 1.1 s  |
| A link becomes clips: ingest, transcript, picks, render | pass 2m 8s | pass 1m 57s |
...
Link to clips (goal: under 30 min): phone 2m 8s, within the goal; desktop 1m 57s, within the goal
Result: PASS
```

`npm run e2e:live -- --project=phone` runs the phone column only (half the time and cost).

| It says | Meaning | Fix |
|---|---|---|
| `Refusing to run against … without the dry run` | `E2E_DRY_RUN=0` is set | Unset it |
| `Set E2E_VIDEO_URL …` | No test video named | 12b |
| `GET /api/sources answered 403` or `did not answer with JSON: a sign-in page?` | The token is missing, wrong, run out, or its policy is not **Service Auth** | 12a |
| `this server is too old to tidy up after the test` | The live release does not have this test's server side yet | Update, below |
| `picking kept no moment from this video` | The test video has too little speech | A video with 20 s or more of talking |
| A step says `FAIL` | The table names the step; the lines above it say what was expected | Fix, then run again: each run uses its own test campaign |

Whatever happens, the run removes its test campaigns ("E2E test …") and their clips at the end.
If the machine dies mid-run, they stay: on the box, `clipfarm-ops source list` shows the
"E2E test …" entries with their ids and `clipfarm-ops source remove <id>` removes each (how to
run it: "IT ops" below). A campaign whose clips were really posted is never removed this way.

## IT ops: run clipfarm without a browser (IT)

`clipfarm-ops` does on the box what the app does in the browser: test the keys, add a source,
turn a video into clips, list the clips, show the queue. It needs no sign-in and no token: it
runs as the `clipfarm` user and reads the same database and saved keys as the service. It never
posts, never prints a key, and exits non-zero with one plain line when something fails.

Install it once (and again after an update that changed `ops/clipfarm/ops.sh`):

```bash
runuser -u clipfarm -- git -C /opt/clipfarm-live/repo pull --ff-only
install -o root -g root -m 755 /opt/clipfarm-live/repo/ops/clipfarm/ops.sh /usr/local/sbin/clipfarm-ops
```

Every command is run the same way, as one `systemd-run` (as root). Only the last words change:

```bash
systemd-run --uid=clipfarm --gid=clipfarm --pipe --wait --collect --quiet -p EnvironmentFile=/etc/clipfarm/clipfarm.env -p MemoryMax=3072M -p UMask=0027 -p PrivateTmp=true /usr/local/sbin/clipfarm-ops test-keys
```

You should see one line per connection: `OpenAI: Working`, `Twitch: Working`, `YouTube: Not set`...
A `Failed <reason>` line says what the service answered (the key is wrong, no connection). The
manager fixes a key in the app under **⋯ > Settings**; nothing to restart.

**A first run, for the TJR campaign** (replace `<campaign>` with the campaign's Whop link, or its
id on whop.com):

```bash
systemd-run --uid=clipfarm --gid=clipfarm --pipe --wait --collect --quiet -p EnvironmentFile=/etc/clipfarm/clipfarm.env -p MemoryMax=3072M -p UMask=0027 -p PrivateTmp=true /usr/local/sbin/clipfarm-ops source add kick.com/tjr --kind whop-campaign --campaign <campaign> --name TJR --rules "Caption must include #TJR. English only. Made without AI voices or added logos. Submit within 30 minutes of posting."

systemd-run --uid=clipfarm --gid=clipfarm --pipe --wait --collect --quiet -p EnvironmentFile=/etc/clipfarm/clipfarm.env -p MemoryMax=3072M -p UMask=0027 -p PrivateTmp=true /usr/local/sbin/clipfarm-ops run latest kick.com/tjr
```

`source add` prints `Added. Source 1: TJR (https://kick.com/tjr), Whop campaign …, permission active`
(run twice, it says `Already there, nothing changed`). The rules are the campaign's brief: a
hashtag in them (`#TJR`) is put in every caption, and the picker reads the rest.

`run` prints the job, one line per step as it moves, and ends like this:

```
Job 14: video 5 of TJR: https://kick.com/tjr/videos/…
The clipfarm service does the work; this command follows it.
[02:14:07] job 14 ingest: Downloading audio 5%
[02:19:40] job 14 ingest: Transcribing 62%
[02:26:12] job 15 picks: Finding highlights 10%
[02:27:30] job 16 render: Cutting and adding captions 30%
Done in 24m 10s: 11 clips from a 1h 2m video (2 picks left out by the rules). Kept private: nothing was posted.
clip 31  pending  score 92  27 s  2026-11-13 02:31  /var/lib/clipfarm/media/clips/pick-31.mp4  …
```

The clips are then in the gallery on the phone, waiting for review. Nothing is posted by this
command, ever: posting stays a tap in the app.

| Command (the last words of the line) | What it does |
|---|---|
| `test-keys` | Tests each saved key, the same test as the Test button in Settings |
| `source add <channel link> --campaign <link or Whop id> [--name … --rules "…" --banned "…" --platforms tiktok,youtube,instagram --rate 1.5 --min-views 3000 --expires 2026-12-31]` | Adds a creator with its permission record. `--kind direct-permission` or `own-content` for the other kinds; `--kind experiment --note "<what is tested>"` (no `--campaign`) for an experiment, whose clips post to burner accounts only |
| `source list`, `source remove <id>` | Shows the sources; removes one with everything made from it (refused once its clips were posted) |
| `run latest <channel link or source id> [--count N]` | The channel's newest finished video → clips. Says `Nothing new` when that video was already done |
| `run <video link> [--source <id or channel link>] [--count N]` | One video → clips. `--source` when the link does not start with the channel (Twitch and YouTube video links) |
| `clips [--since 2h]` | Clips ready for review or approved, with file and score (`--since` takes `45m`, `2h`, `3d` or a date) |
| `status` | Whether the service is working the queue, the jobs, and the disk |
| `help` | Every command |

Good to know:

- One heavy job at a time still holds: while the service is up it does the work and `run` only
  follows it. If the service is down, `run` does the work itself (that is why the line caps
  memory, at the service's own 3072 MiB), and gives the queue back when it ends.
- Transcripts and picks run on the box's own engine unless cloud AI is switched on in the
  Dashboard. If the engine is not downloaded yet, `run` fails with that reason; the service
  fetches it by itself after a start (`status` shows the `engine-setup` job).
- `run` waits up to 3 hours (`--timeout <minutes>`). Stopping it (Ctrl+C) does not cancel the
  job: `status` shows it, and the clips still arrive in the gallery.
- Exit code 0: done. 1: it failed, the last line says why (`clipfarm-ops: The permission for TJR
  expired on …`, `clipfarm-ops: The ingest step failed: …`). 2: the command was mistyped.
- `run it as the clipfarm user` or `DATA_DIR is not set`: it was started without the
  `systemd-run … -p EnvironmentFile=…` part. Use the full line above.
- `run latest` on a Kick channel asks kick.com, which sometimes refuses servers (`Kick refused
  the request`). Then copy the video's link from the channel page and use `run <video link>`.

## Update (IT)

```bash
systemctl start clipfarm-backup.service              # fresh backup first
clipfarm-deploy origin/main
```

If `systemctl cat clipfarm | grep MemoryMax` still shows `MemoryMax=1536M` (a box set up before
the local engine), install the new unit once, before the deploy. Until then the hook writer is
refused for memory and hooks come from the transcript:

```bash
install -m 644 /opt/clipfarm-live/repo/ops/clipfarm/clipfarm.service /etc/systemd/system/clipfarm.service
systemctl daemon-reload
```

`origin/main` is the newest merged commit; a commit id (`clipfarm-deploy 460bfc0`) or a tag works too.
The script fetches from GitHub, builds in a new folder while the old release keeps running,
then switches and restarts (a few seconds of downtime; a job that was running goes back in the
queue and starts again).

- Ends with `... is live and healthy`: done. The release before it is kept for a rollback; older ones are removed.
- Ends with `went back to <old release>, which is live and healthy again`: the new version did
  not start, the old one is serving again, nothing else to do on the box. Send the manager the
  output of `journalctl -u clipfarm -n 80 --no-pager`.
- The build fails (an `npm` error): nothing was switched or restarted. Same: send the output.

To update the deploy and backup scripts and the unit files themselves (when a release changed
something under `ops/clipfarm/`):

```bash
runuser -u clipfarm -- git -C /opt/clipfarm-live/repo pull --ff-only
install -o root -g root -m 755 /opt/clipfarm-live/repo/ops/clipfarm/deploy.sh /usr/local/sbin/clipfarm-deploy
install -o root -g root -m 755 /opt/clipfarm-live/repo/ops/clipfarm/backup.sh /usr/local/sbin/clipfarm-backup
install -o root -g root -m 755 /opt/clipfarm-live/repo/ops/clipfarm/ops.sh /usr/local/sbin/clipfarm-ops
```

then install any changed `.service` / `.timer` file again as in steps 4 and 10, and
`systemctl daemon-reload`.

Changed settings only (`/etc/clipfarm/clipfarm.env`): `systemctl restart clipfarm`, no deploy.

## Roll back (IT)

To the release that was live before the last update (no build, a few seconds):

```bash
ls /opt/clipfarm-live/releases/            # two folders: the live one and the one before
clipfarm-deploy --rollback
```

It switches `current` to the other release, restarts and checks health; if that release does
not answer, it switches back by itself. Running `--rollback` again returns to the newer one.

To any older commit: `clipfarm-deploy <commit id>` (builds it again).

If the newer version changed the database and the older one fails on it (its log says so),
also restore the backup taken before the update ("Restore" below).

## Logs and day to day (IT)

```bash
systemctl status clipfarm --no-pager
journalctl -u clipfarm -n 100 --no-pager          # last 100 lines
journalctl -u clipfarm -f                         # follow live (Ctrl+C to stop)
journalctl -u clipfarm --since today | grep -i error
journalctl -u clipfarm-backup.service -u clipfarm-media-cleanup.service -n 20 --no-pager
systemctl show clipfarm -p MemoryCurrent -p NRestarts
du -sh /var/lib/clipfarm/media /var/lib/clipfarm/clipfarm.db
readlink /opt/clipfarm-live/current               # which release is live
cd /opt/clipfarm-live/current && npm run clipfarm:check
```

The start line in the log names what the server uses, for example
`clipfarm on http://127.0.0.1:5310 (access gate: on, downloader: yt-dlp, transcriber: openai, picker: llm, posting: postiz)`.

Common problems:

| You see | Do |
|---|---|
| Phone shows the Cloudflare login again and again | The email is not in the Access policy (step 7) |
| Phone shows "Sign in through Cloudflare Access to use clipfarm." | The request did not come through Access: a bypass was added for a path it should not cover (step 7), or someone called the port directly |
| Everyone gets that message, and the log has a line starting `Access gate:` | The server could not find the Cloudflare team's keys to check sign-ins with; the line says why (the public address does not lead to the Access login: steps 7 and 8, or no connection to Cloudflare). It tries again every minute and recovers by itself. To pin the values instead: `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in the env file, then `systemctl restart clipfarm` |
| `NRestarts` keeps growing | `journalctl -u clipfarm -n 50`: a bad setting in the env file, or the port is taken (step 1) |
| A render job fails with "killed" / the log shows an out-of-memory kill | ffmpeg hit the 3072 MiB cap. The job is retried. If it keeps happening, tell the manager before raising `MemoryMax` (the box is shared) |
| Downloads fail for every link | `yt-dlp -U`, then retry the job in the app |
| Disk filling up | `du -sh /var/lib/clipfarm/media`; lower `MEDIA_KEEP_REJECTED_DAYS`, `systemctl start clipfarm-media-cleanup.service` |

## Stop and start (IT)

```bash
systemctl stop clipfarm       # the gallery goes offline; data stays; a running job is put back in the queue
systemctl start clipfarm
systemctl disable --now clipfarm clipfarm-backup.timer clipfarm-media-cleanup.timer   # stop and don't start at boot
```

## Restore from a backup (IT)

```bash
ls /opt/backups/*/clipfarm.db.gz                    # pick a date
BACKUP=/opt/backups/YYYY-MM-DD/clipfarm.db.gz       # the one you picked
systemctl stop clipfarm
cd /var/lib/clipfarm
mv clipfarm.db clipfarm.db.before-restore
rm -f clipfarm.db-wal clipfarm.db-shm
gunzip -c "$BACKUP" > clipfarm.db
chown clipfarm:clipfarm clipfarm.db && chmod 640 clipfarm.db
systemctl start clipfarm
cd /opt/clipfarm-live/current && npm run clipfarm:check
```

Then open the gallery and check the clips and creators. Clips made after the backup are gone
from the lists (their files are still in `media/`); posts made after it are still on the
platforms but no longer tracked. When all is well: `rm /var/lib/clipfarm/clipfarm.db.before-restore`.

On a new box: do steps 1-6 (with your saved `clipfarm.env` in step 4), the restore above, then
steps 8-10. The keys that were pasted in Settings are not in the backup: the manager pastes them
again under ⋯ > Settings and taps Test on each (the dashboard's setup list shows what is missing). The Access application (step 7) stays as it is.

## Remove clipfarm from the box (IT, then manager)

This deletes the clips and the database on the box. Take a backup and copy it off first.

```bash
systemctl start clipfarm-backup.service
systemctl disable --now clipfarm clipfarm-backup.timer clipfarm-media-cleanup.timer
rm /etc/systemd/system/clipfarm.service /etc/systemd/system/clipfarm-backup.service /etc/systemd/system/clipfarm-backup.timer \
   /etc/systemd/system/clipfarm-media-cleanup.service /etc/systemd/system/clipfarm-media-cleanup.timer \
   /usr/local/sbin/clipfarm-deploy /usr/local/sbin/clipfarm-backup /usr/local/sbin/clipfarm-ops
systemctl daemon-reload
```

Then: delete the `http://clip.techinsiderbytes.com { ... }` block from `/etc/caddy/Caddyfile`,
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy`;
`rm -rf /opt/clipfarm-live /var/lib/clipfarm /etc/clipfarm`; `userdel clipfarm`.

Manager: in the Zero Trust dashboard delete the `clip` public hostname from the tunnel (step 8),
the `clipfarm` Access application (step 7) and, under the domain's DNS records, the `clip` CNAME.
