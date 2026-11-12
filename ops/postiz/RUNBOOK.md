# Postiz on Mulinux: runbook

Postiz is the self-hosted scheduler that holds our YouTube, TikTok, Instagram and X accounts.
clipfarm posts approved clips through its public API (issue #7). This runbook installs it on
Mulinux at `https://postiz.techinsiderbytes.com`, keeps it backed up, and covers updates,
stopping, removal and restore.

Run every command as root on Mulinux, in order. Each step says what you should see.

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

## 1. Check the box first

```bash
free -m          # "available" on the Mem: line should be 2500 or more
df -h /          # "Avail" should be 10G or more
ss -ltnp 'sport = :5300'                      # must print only the header line (port free)
docker compose version                        # must print a version (v2 or newer)
grep -n 'postiz' /etc/caddy/Caddyfile || echo "no postiz block yet"   # expect "no postiz block yet"
systemctl is-active docker caddy cloudflared  # expect three lines: active
```

If RAM is short, don't start Postiz: say so to the manager. If port 5300 is taken, pick another
free port (check it the same way) and use it everywhere this runbook says 5300: `POSTIZ_PORT`
in `.env` (step 3) and the Caddy block (step 6).

## 2. Get the files and create /opt/postiz

```bash
install -d -m 700 /opt/postiz
git clone --depth 1 https://github.com/7empes7s/clipfarm.git /opt/postiz/repo
cd /opt/postiz
install -m 644 repo/ops/postiz/docker-compose.yml /opt/postiz/docker-compose.yml
install -m 755 repo/ops/postiz/backup.sh /opt/postiz/backup.sh
install -d -m 700 config uploads postgres redis temporal-postgres
ls /opt/postiz
```

You should see: `backup.sh config docker-compose.yml postgres redis repo temporal-postgres uploads`.

## 3. Create .env and fill the secrets

```bash
cd /opt/postiz
install -m 600 repo/ops/postiz/.env.example .env
for key in JWT_SECRET POSTIZ_DB_PASSWORD TEMPORAL_DB_PASSWORD; do
  sed -i "s/^${key}=\$/${key}=$(openssl rand -hex 32)/" .env
done
grep -E '^(JWT_SECRET|POSTIZ_DB_PASSWORD|TEMPORAL_DB_PASSWORD)=' .env | cut -c1-30
docker compose config --quiet && echo "compose OK"
```

You should see the three keys each followed by hex characters, then `compose OK`.
If you see `set JWT_SECRET in .env` (or another name), that value is still empty: fill it.

Leave the platform keys empty for now (step 10). Save a copy of `/opt/postiz/.env` in the
team password manager: the backup does not include it.

## 4. Pull the images and start

```bash
cd /opt/postiz
docker compose pull
docker compose up -d
```

The first start takes 2-5 minutes (Temporal sets up its database, Postiz runs migrations).

## 5. Health check

```bash
cd /opt/postiz
watch -n 10 docker compose ps        # wait until all 5 say "(healthy)", then Ctrl+C
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5300/   # expect 200 or 307
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}' | grep -E 'NAME|postiz|temporal'
free -m
```

Each container's memory should be below its limit. If one is not healthy after 5 minutes:
`docker compose logs --tail 100 <name>` (for example `postiz` or `temporal`) shows why.

Now hand the containers to systemd so they come back after a reboot:

```bash
install -m 644 /opt/postiz/repo/ops/postiz/postiz.service /etc/systemd/system/postiz.service
systemctl daemon-reload
systemctl enable --now postiz
systemctl is-active postiz      # expect: active
```

(`postiz.service` runs `docker compose up` attached to the running containers; it does not restart them.)

## 6. Caddy: route the hostname to Postiz

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)
printf '\n' >> /etc/caddy/Caddyfile
cat /opt/postiz/repo/ops/postiz/Caddyfile.postiz >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # expect "Valid configuration"
systemctl reload caddy
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: postiz.techinsiderbytes.com' http://127.0.0.1/   # expect 200 or 307
```

If `caddy validate` fails, put the backup back (`cp /etc/caddy/Caddyfile.bak-$(date +%F) /etc/caddy/Caddyfile`)
and look at how the existing `keel.techinsiderbytes.com` block is written; write the Postiz block the same way.

## 7. Cloudflare tunnel: add the hostname

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

## 8. Backups

```bash
systemctl list-timers mimule-backup.timer   # note the NEXT time of the daily backup
install -m 644 /opt/postiz/repo/ops/postiz/postiz-backup.service /etc/systemd/system/
install -m 644 /opt/postiz/repo/ops/postiz/postiz-backup.timer /etc/systemd/system/
```

`postiz-backup.timer` runs at 04:30. If `mimule-backup` runs later than 04:00, edit
`OnCalendar=` in `/etc/systemd/system/postiz-backup.timer` to 30 minutes after it, so both land
in the same day folder. Then:

```bash
systemctl daemon-reload
systemctl enable --now postiz-backup.timer
systemctl start postiz-backup.service        # take one backup now
journalctl -u postiz-backup.service -n 5 --no-pager   # expect "postiz backup: /opt/backups/<today>/postiz.sql.gz (...)"
ls -l /opt/backups/$(date +%F)/postiz.sql.gz
```

The script keeps the 3 newest `postiz.sql.gz` files and never touches other files in the
backup folders. It backs up the database only: `/opt/postiz/uploads` (media that was posted)
and `.env` are not in it.

## 9. Create the admin account, then close sign-ups

1. Open <https://postiz.techinsiderbytes.com> → **Sign up**. Use the team email, a strong
   password, and company name `clipfarm`. You land in the Postiz calendar.
2. Close sign-ups:

```bash
cd /opt/postiz
sed -i 's/^DISABLE_REGISTRATION=false$/DISABLE_REGISTRATION=true/' .env
grep '^DISABLE_REGISTRATION' .env     # expect DISABLE_REGISTRATION=true
systemctl restart postiz
```

3. After 1-2 minutes open the site in a private window and try **Sign up** with another email:
   it must be refused. Log in with the admin account: it must work.

## 10. Connect YouTube, TikTok, Instagram and X

For each platform: create a developer app, paste the callback URL below, put the app's keys in
`/opt/postiz/.env`, restart, then in Postiz click **Add Channel** → the platform → log in → allow.

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

```bash
cd /opt/postiz
nano .env                       # paste the keys you got above; save
systemctl restart postiz
watch -n 10 docker compose ps   # wait for postiz "(healthy)", Ctrl+C
```

In Postiz: **Add Channel** → pick the platform → log in with the clipfarm account → **Allow**.
The channel appears in the left column. Use the same page name everywhere ("GTA VI Moments").

## 11. Connect clipfarm (API key)

1. Postiz → **Settings** → **Public API** → copy the API key.
2. Where clipfarm runs, put these two lines in clipfarm's `.env` (never commit it):

```bash
POSTIZ_URL=https://postiz.techinsiderbytes.com
POSTIZ_API_KEY=<the key you copied>
```

   If clipfarm runs on Mulinux too, `POSTIZ_URL=http://127.0.0.1:5300` also works and skips
   Cloudflare's 100 MB upload limit.
3. From the clipfarm folder:

```bash
npm run postiz:check
```

You should see `OK: Postiz at ... answered with N connected accounts.` and one line per channel.
`NOT OK: ...` says what is wrong (key refused, not reachable, wrong URL, variable not set).
A channel marked `disabled` must be reconnected in Postiz.

---

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
3. On Mulinux:

```bash
systemctl start postiz-backup.service                 # fresh backup first
cd /opt/postiz
git -C repo pull --ff-only
install -m 644 repo/ops/postiz/docker-compose.yml docker-compose.yml
docker compose config --quiet && docker compose pull
systemctl restart postiz
watch -n 10 docker compose ps                         # all "(healthy)", Ctrl+C
```

4. Run `npm run postiz:check` in clipfarm: expect `OK`.

Roll back: put the old tag back in `/opt/postiz/docker-compose.yml`, `systemctl restart postiz`.
If the new version changed the database, also restore the backup taken in step 3 (below).

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

On a new box: do steps 1-6 (with your saved `.env` instead of generating secrets in step 3),
then the restore above, then step 7 if the hostname changed.

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
in the Zero Trust dashboard (step 7) delete the `postiz` public hostname and, under the domain's
DNS records, the `postiz` CNAME; finally `rm -rf /opt/postiz`.
