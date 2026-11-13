# Postiz on Mulinux: runbook

Postiz is the self-hosted scheduler that holds our YouTube, TikTok, Instagram and X accounts.
clipfarm posts approved clips through its public API (issue #7). This runbook installs it on
Mulinux at `https://postiz.techinsiderbytes.com`, keeps it backed up, and covers updates,
stopping, removal and restore.

One script installs it: `ops/postiz/install.sh`. IT runs it with one command (step 1); the
manager only signs up, connects the channels and, for each platform, makes a developer app.
Nobody types or reads a secret: the script makes them and never prints one.

**What gets installed**

| Piece | Where |
|---|---|
| Containers: `postiz` (v2.25.3), `postiz-postgres`, `postiz-redis`, `temporal`, `temporal-postgres` | Docker, compose project `postiz` |
| Compose file, `.env`, backup script | `/opt/postiz/` |
| Data (database, uploads, Redis, Temporal) | `/opt/postiz/{postgres,uploads,config,redis,temporal-postgres}` |
| Web app | `127.0.0.1:5300` only, published through Caddy (`:80`) and the Cloudflare tunnel |
| systemd | `postiz.service`, `postiz-backup.service`, `postiz-backup.timer` |
| Backups | `/opt/backups/YYYY-MM-DD/postiz.sql.gz`, newest 3 kept |

Memory: the containers are capped at 2176 MiB in total (Postiz 1280, its Postgres 256,
Redis 96, Temporal 384, Temporal's Postgres 160). Idle use is usually well below that.

---

## 1. Install (IT: one command)

```bash
systemd-run --pipe --wait --collect --quiet /bin/bash -c 'test -d /opt/postiz/repo/.git || git clone --depth 1 https://github.com/7empes7s/clipfarm.git /opt/postiz/repo; git -C /opt/postiz/repo pull --ff-only && /opt/postiz/repo/ops/postiz/install.sh'
```

It is safe to run again at any time: a second run changes nothing that is already right. In order, it:

1. Checks the box: docker runs, port 5300 is free (or already Postiz), 2500 MB of memory and
   10 GB of disk are free. If not, it stops with the reason and starts nothing.
2. Creates `/opt/postiz` with the compose file and the backup script.
3. Writes `/opt/postiz/.env` (root only, mode 600) from `.env.example` with fresh random values for
   `JWT_SECRET`, `POSTIZ_DB_PASSWORD` and `TEMPORAL_DB_PASSWORD`. An existing `.env` keeps every
   value; only missing keys are added.
4. Installs `postiz.service`, the backup service and timer, and puts the Postiz block in
   `/etc/caddy/Caddyfile` in place of the "being installed" placeholder (the old file is kept
   next to it as `Caddyfile.bak-postiz-<time>`; if Caddy refuses the new file, the old one is put back).
5. Pulls the images, starts Postiz and waits until it answers (2-5 minutes the first time).
6. Once an account exists (step 3): checks Postiz's API key, saves it in
   `/etc/clipfarm/clipfarm.env` for clipfarm, and closes sign-ups.

You should see, at the end:

```
Postiz is installed.
  postiz.service: active
  postiz-backup.timer: active
  http://127.0.0.1:5300/: answers (307)
  https://postiz.techinsiderbytes.com/: answers (307)
  Platform keys set: none
  API key for clipfarm: not made yet: open the site, sign up (the first account is the admin), then run this again
  Sign-ups: open until the first account exists
Next: connect channels in Postiz (...)
```

A line starting with `postiz-install:` and a non-zero exit says what is wrong, in plain words
(not enough memory, port taken, Postiz did not answer, the public address does not answer).
Fix that and run the same command again.

If port 5300 is taken by something else: set `POSTIZ_PORT=<free port>` in `/opt/postiz/.env`
(create the file with just that line) and run the command again; the script uses that port for
the containers and the Caddy block.

`/opt/postiz/.env` is not in the backups, and the database only opens with the passwords in
it. To move Postiz to a new box, copy that file together with a backup ("Restore from a backup").

## 2. Cloudflare tunnel: add the hostname (only on a new box)

On Mulinux the hostname already exists. On a new box, do this once, then run step 1 again.

In a browser:

1. Go to <https://one.dash.cloudflare.com> and pick the account that owns `techinsiderbytes.com`.
2. Left menu: **Networks** → **Tunnels** (newer dashboards: **Networks** → **Connectors** → **Cloudflare Tunnels**).
3. Click the tunnel Mulinux runs (status **Healthy**; it already has `keel.techinsiderbytes.com`) → **Edit** / **Configure**.
4. Tab **Public Hostname** (newer: **Published application routes**) → **Add a public hostname** / **Add a published application route**.
5. Fill in:
   - Subdomain: `postiz`
   - Domain: `techinsiderbytes.com`
   - Path: leave empty
   - Service Type: `HTTP`
   - URL: the same as the keel entry uses (normally `localhost:80`)
6. **Save**. Cloudflare creates the DNS record by itself.

Don't put Cloudflare Access in front of this hostname: the platforms' login callbacks and
clipfarm's API calls must reach Postiz directly. Postiz has its own login.

Back in the shell (allow a minute for DNS):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://postiz.techinsiderbytes.com/   # expect 200 or 307
```

## 3. Create the admin account (manager), then run the installer again (IT)

1. Manager: open <https://postiz.techinsiderbytes.com> → **Sign up**. Use the team email, a strong
   password, and company name `clipfarm`. You land in the Postiz calendar.
2. IT: run the command of step 1 again. Now that an account exists, it:
   - closes sign-ups (`DISABLE_REGISTRATION=true`) and restarts Postiz;
   - reads the workspace's API key from Postiz's database, checks it against Postiz
     (`OK: Postiz at http://127.0.0.1:5300 answered with N connected accounts.`), writes
     `POSTIZ_URL` and `POSTIZ_API_KEY` into `/etc/clipfarm/clipfarm.env` and restarts clipfarm.
     The key is never printed. The summary says `API key for clipfarm: works, saved in ...`.
3. Manager: clipfarm → **Settings** → **Postiz** → **Test** says it works. In a private window,
   **Sign up** on the Postiz site with another email must be refused.

If the key is ever regenerated in Postiz (**Settings** → **Public API**), run step 1 again: it
hands the new key to clipfarm.

## 4. Connect YouTube, TikTok, Instagram and X

For each platform: create a developer app, paste the callback URL below, hand the app's keys to
the installer in a file ("Apply and connect" below), then in Postiz click **Add Channel** → the
platform → log in → allow.

Callback URLs (paste exactly, no trailing slash):

| Platform | Callback / redirect URL | .env keys |
|---|---|---|
| YouTube | `https://postiz.techinsiderbytes.com/integrations/social/youtube` | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` |
| TikTok | `https://postiz.techinsiderbytes.com/integrations/social/tiktok` | `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET` |
| Instagram (Standalone) | `https://postiz.techinsiderbytes.com/integrations/social/instagram-standalone` | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` |
| Instagram via a Facebook page (optional) | `https://postiz.techinsiderbytes.com/integrations/social/instagram` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| X | `https://postiz.techinsiderbytes.com/integrations/social/x` | `X_API_KEY`, `X_API_SECRET` |

### YouTube (Google Cloud)

1. <https://console.cloud.google.com> → project picker → **New project** → name `clipfarm-postiz` → **Create**.
2. **APIs & Services** → **Library**: enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **APIs & Services** → **OAuth consent screen** (or **Google Auth Platform**): User type **External**,
   app name `clipfarm`, support email = team email, authorized domain `techinsiderbytes.com`.
   Under **Audience**, add the Google account that owns the channel as a **Test user**, then
   **Publish app** (in "Testing" the login expires every 7 days).
4. **Credentials** → **Create credentials** → **OAuth client ID** → type **Web application** →
   **Authorized redirect URIs** → add the YouTube URL from the table → **Create**.
5. Copy **Client ID** → `YOUTUBE_CLIENT_ID`, **Client secret** → `YOUTUBE_CLIENT_SECRET`.
6. Important: uploads from an API project that has not passed Google's audit are locked to
   **private**. Submit the "YouTube API Services - Audit and Quota Extension Form"
   (<https://support.google.com/youtube/contact/yt_api_form>) for this project; until it is
   approved, Shorts posted through Postiz stay private.

### TikTok (TikTok for Developers)

1. <https://developers.tiktok.com> → log in → **Manage apps** → **Connect an app** (or **Create app**).
2. Fill in app name `clipfarm`, category, description, website `https://postiz.techinsiderbytes.com`,
   terms and privacy URLs (ask the manager if we have none yet).
3. **Add products**: **Login Kit** and **Content Posting API** (turn on **Direct Post**).
4. Login Kit → **Redirect URI** (Web) → the TikTok URL from the table.
5. Scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`, `video.upload`, `video.publish`.
6. Copy **Client key** → `TIKTOK_CLIENT_ID`, **Client secret** → `TIKTOK_CLIENT_SECRET`.
7. **Submit for review**. Until TikTok approves the app, posts go up as private (only you can see
   them); the TikTok account must be added under **Sandbox** → **Target users** to test before that.

### Instagram (Meta for Developers, Instagram login)

The Instagram account must be a **Professional** account (Business or Creator).

1. <https://developers.facebook.com/apps> → **Create app** → use case **Manage messaging & content on Instagram** →
   app type **Business** → name `clipfarm` → **Create**.
2. Left menu: **Instagram** → **API setup with Instagram login** → **3. Set up Instagram business login** →
   **Business login settings** → **OAuth redirect URIs** → the Instagram (Standalone) URL from the table → **Save**.
3. On the same page copy **Instagram app ID** → `INSTAGRAM_APP_ID` and **Instagram app secret**
   → `INSTAGRAM_APP_SECRET` (not the Facebook app ID at the top of the dashboard).
4. **App roles** → **Roles** → **Add people** → **Instagram Tester** → the Instagram account; accept the
   invite in Instagram (Settings → Website permissions → Apps and websites → Tester invites).
5. To post for real (not only as tester), switch the app to **Live** after Meta's App Review for
   `instagram_business_basic` and `instagram_business_content_publish`.
6. In Postiz pick **Instagram (Standalone)** when adding the channel.

Optional, only if the Instagram account is linked to a Facebook page and you prefer that route:
create a second Meta app with **Facebook Login for Business**, add
`https://postiz.techinsiderbytes.com/integrations/social/instagram` under **Valid OAuth Redirect URIs**,
put its App ID / App secret (Settings → Basic) in `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`, and pick
**Instagram (Facebook Business)** in Postiz.

### X (X Developer Platform)

1. <https://developer.x.com/en/portal/dashboard> → **Projects & Apps** → your project → your app
   (or **Add App**).
2. **User authentication settings** → **Set up**: App permissions **Read and write**, Type of App
   **Web App, Automated App or Bot**, Callback URI = the X URL from the table, Website URL
   `https://postiz.techinsiderbytes.com` → **Save**.
3. **Keys and tokens** → **Consumer Keys** → **Regenerate** → **API Key** → `X_API_KEY`,
   **API Key Secret** → `X_API_SECRET`.
4. Check the plan's monthly post limit on the dashboard: the free plan allows only a few hundred posts per month.

### Apply and connect

Put the keys in a file on the box, one `KEY=VALUE` per line with the names from the table, for
example `/root/postiz-keys.env`:

```
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
```

IT runs the installer with it (repeat `--keys-from` for more files):

```bash
systemd-run --pipe --wait --collect --quiet /bin/bash -c 'git -C /opt/postiz/repo pull --ff-only && /opt/postiz/repo/ops/postiz/install.sh --keys-from /root/postiz-keys.env'
```

The keys are merged into `/opt/postiz/.env`, the file is then emptied (add `--keep-source` to
keep it), Postiz restarts, and the summary lists the names that are set
(`Platform keys set: YOUTUBE_CLIENT_ID YOUTUBE_CLIENT_SECRET`), never a value. Only the names
in the table are accepted: any other name is refused (`refused, not platform keys: ...`) and
nothing is changed.

In Postiz: **Add Channel** → pick the platform → log in with the clipfarm account → **Allow**.
The channel appears in the left column. Use the same page name everywhere ("GTA VI Moments").

## Connect clipfarm: check by hand

The installer connects clipfarm and runs this check with the real key (step 3). To run it again
by hand, where clipfarm's `.env` has `POSTIZ_URL` and `POSTIZ_API_KEY`:

```bash
npm run postiz:check
```

You should see `OK: Postiz at ... answered with N connected accounts.` and one line per channel.
`NOT OK: ...` says what is wrong (key refused, not reachable, wrong URL, variable not set).
A channel marked `disabled` must be reconnected in Postiz.

---

## Backups

The installer turns on `postiz-backup.timer`: every day at 04:30 it writes
`/opt/backups/YYYY-MM-DD/postiz.sql.gz`. If `mimule-backup` runs later than 04:00
(`systemctl list-timers mimule-backup.timer`), edit `OnCalendar=` in
`/etc/systemd/system/postiz-backup.timer` to 30 minutes after it and run
`systemctl daemon-reload`; the installer keeps your time on later runs.

```bash
systemctl start postiz-backup.service        # take one backup now
journalctl -u postiz-backup.service -n 5 --no-pager   # expect "postiz backup: /opt/backups/<today>/postiz.sql.gz (...)"
```

The script keeps the 3 newest `postiz.sql.gz` files and never touches other files in the
backup folders. It backs up the database only: `/opt/postiz/uploads` (media that was posted)
and `.env` are not in it.

## Day to day

```bash
systemctl status postiz --no-pager
cd /opt/postiz && docker compose ps
docker compose logs --tail 100 postiz           # or temporal, postiz-postgres, ...
docker stats --no-stream | grep -E 'postiz|temporal'
```

## Update Postiz (bump the pinned version)

1. Read the release notes: <https://github.com/gitroomhq/postiz-app/releases>.
2. In clipfarm, open a PR that changes `image: ghcr.io/gitroomhq/postiz-app:v2.25.3` in
   `ops/postiz/docker-compose.yml` to the new tag (other images the same way; Temporal one
   minor version at a time). Wait for it to merge.
3. On Mulinux, take a fresh backup, then run the installer (step 1): it copies the new compose
   file, restarts Postiz (which pulls the new image) and waits until it answers.

```bash
systemctl start postiz-backup.service
systemd-run --pipe --wait --collect --quiet /bin/bash -c 'git -C /opt/postiz/repo pull --ff-only && /opt/postiz/repo/ops/postiz/install.sh'
```

4. Run `npm run postiz:check` in clipfarm: expect `OK`.

Roll back: put the old tag back in `/opt/postiz/docker-compose.yml`, `systemctl restart postiz`.
If the new version changed the database, also restore the backup taken in step 3 of this list (below).

## Stop and start

```bash
systemctl stop postiz      # stops and removes the containers; all data in /opt/postiz stays
systemctl start postiz
systemctl disable --now postiz postiz-backup.timer   # stop and don't start at boot
```

## Restore from a backup

```bash
ls /opt/backups/*/postiz.sql.gz                     # pick a date
BACKUP=/opt/backups/YYYY-MM-DD/postiz.sql.gz        # the one you picked
systemctl stop postiz
cd /opt/postiz
docker compose up -d postiz-postgres
until docker compose exec -T postiz-postgres pg_isready -U postiz -d postiz; do sleep 2; done
gunzip -c "$BACKUP" | docker compose exec -T postiz-postgres psql -U postiz -d postiz -v ON_ERROR_STOP=1 -q
docker compose down
systemctl start postiz
```

`psql` must finish without `ERROR`. Then log in, check the channels and the calendar, and run
`npm run postiz:check`. Posts that were scheduled but not yet sent at the time of the backup:
open each one in the calendar and confirm its time (re-save it if it shows as failed).

On a new box: put your saved `.env` in `/opt/postiz/.env` first (the installer keeps it), do
step 2 if the hostname changed, run step 1, then the restore above.

## Remove Postiz completely

This deletes all Postiz data. Take and copy off a backup first.

```bash
systemctl start postiz-backup.service
systemctl disable --now postiz postiz-backup.timer
rm /etc/systemd/system/postiz.service /etc/systemd/system/postiz-backup.service /etc/systemd/system/postiz-backup.timer
systemctl daemon-reload
cd /opt/postiz && docker compose down --rmi all
```

Then: delete the `http://postiz.techinsiderbytes.com { ... }` block from `/etc/caddy/Caddyfile`,
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy`;
in the Zero Trust dashboard (step 2) delete the `postiz` public hostname and, under the domain's
DNS records, the `postiz` CNAME; finally `rm -rf /opt/postiz`.
