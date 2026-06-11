# Google Keep Sidecar — Setup & Recovery (Playwright edition)

The Lists panel on Card 0 is backed by Google Keep. Because Google killed
the master-token (`EmbeddedSetup`) flow that `gkeepapi` depends on, this
project uses a different approach: **a headless Chromium browser replays a
logged-in Keep session that you capture once on your laptop.**

It's heavier than an API client (~300 MB RAM), but it survives Google's
anti-abuse blocks because it's literally the same web auth your laptop
uses to view Keep. As long as keep.google.com works for humans, this
keeps working.

---

## Topology — READ THIS FIRST

The sidecar does **not** run on the Pi. It runs on **YOUR_SERVER**.

```
Laptop (Windows)            YOUR_SERVER — Ubuntu server (YOUR_PLEX_SERVER_IP)        Pi — YOUR_PI_HOSTNAME
─────────────────           ─────────────────────────────────────        ───────────
keep_login.py               keep-mirror.service  (systemd, enabled)       Express :3000
  ↓                         /home/YOUR_PI_USER/keep-mirror/                          ↓
real Chrome window            .venv + Playwright + chrome-headless-shell    proxies /api/lists
  ↓                           keep_service.py  → Flask :3002  (0.0.0.0)   ──►  ↓
you sign in (full 2FA)        reads storage_state from keep_auth.json          Display Card 0
  ↓
saves keep_auth.json  ──WinSCP──►  /home/YOUR_PI_USER/keep-mirror/keep_auth.json
```

Key facts (corrects earlier docs that claimed Pi / PM2):

| Thing | Value |
|---|---|
| Host | **YOUR_SERVER**, `YOUR_PLEX_SERVER_IP` (not the Pi) |
| Supervision | **systemd** unit `keep-mirror.service` (not PM2) |
| Working dir | `/home/YOUR_PI_USER/keep-mirror/` |
| Python | project-local `.venv` + Playwright |
| Auth file | `/home/YOUR_PI_USER/keep-mirror/keep_auth.json` |
| Bind | `KEEP_SIDECAR_HOST=0.0.0.0`, port `3002` (so the Pi can reach it) |
| Pi side | Express proxies the sidecar at `/api/lists` (`KEEP_SIDECAR_URL=http://YOUR_PLEX_SERVER_IP:3002`) |

`keep_auth.json` holds your Keep session cookies. Treat it like a
password (it's already in `.gitignore`). It expires every few weeks —
re-running `keep_login.py` re-mints it.

> ⚠️ YOUR_SERVER's `/home/YOUR_PI_USER/keep-mirror/` is **not** a git client of this repo.
> The Pi pulls from the fork; YOUR_SERVER's copy of `keep_service.py` was deployed
> by hand. If you change `keep_service.py`, you must copy it to YOUR_SERVER
> separately — `git pull` on the Pi does not touch YOUR_SERVER.

---

## Routine re-auth (the common case)

This is what you do when the Lists panel goes blank / "Keep service offline".
You'll typically need it every few weeks to months as cookies decay.

**Capture on YOUR_SERVER — the durable method (confirmed multi-day 2026-06-10).** Prior
captures done on the Windows laptop and replayed from YOUR_SERVER died within hours because
Google's session-risk engine treats a device/IP mismatch as a hijack. Capturing
directly on YOUR_SERVER eliminates the mismatch.

### 1. SSH to YOUR_SERVER with X forwarding

Use the **MobaXterm saved session** for YOUR_SERVER (not a typed `ssh` command — the saved
session is required for X forwarding to work). YOUR_SERVER's SSH is on port 2222.

Once connected, verify the display is set:

```bash
echo $DISPLAY    # must be non-empty, e.g. localhost:10.0
```

### 2. Launch Chromium on YOUR_SERVER with remote debugging

```bash
CHROME=/home/YOUR_PI_USER/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
"$CHROME" \
  --remote-debugging-port=9222 \
  --user-data-dir=/home/YOUR_PI_USER/keep-capture-profile \
  --no-sandbox \
  https://keep.google.com &
```

> `--no-sandbox` is required on this Ubuntu version (AppArmor restricts unprivileged
> user namespaces). The `keep-capture-profile` directory gives YOUR_SERVER a consistent
> browser fingerprint across re-auths — keep it on disk.
>
> If the Chromium binary path above stops working after a Playwright update, find it
> with: `ls /home/YOUR_PI_USER/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`

A Chromium window opens on your Windows desktop via MobaXterm. Sign in fully —
2FA, and click **Trust this device** if offered. Wait until the Keep notes grid is
fully visible.

### 3. Capture the session via CDP

Open a **second** SSH session to YOUR_SERVER (double-click the saved session again in
MobaXterm). The first session's terminal is busy with Chromium output.

```bash
cd /home/YOUR_PI_USER/keep-mirror
.venv/bin/python keep_login.py --cdp 9222
```

The script prints Windows-style CDP setup instructions — **ignore them**. Chromium
is already running and signed in. Press **ENTER** when prompted. Success output:

```
✓ Wrote /home/YOUR_PI_USER/keep-mirror/keep_auth.json (N.N KB) via CDP attach
```

The file is already in the right place. Ignore the "WinSCP to YOUR_SERVER" line in the
printed next steps.

### 4. Restart and verify on YOUR_SERVER

```bash
sudo systemctl restart keep-mirror.service
sleep 20
curl -s http://127.0.0.1:3002/health; echo      # want "authed": true
```

If `authed: false` after 20s, wait another 20s and retry — headless Chromium takes
time to hydrate the Keep page.

### 5. Confirm end-to-end from the Pi

```bash
curl -s http://YOUR_PLEX_SERVER_IP:3002/health; echo
curl -s http://localhost:3000/api/lists; echo    # grocery + costco populated
```

The display's Lists panel repopulates within ~60s on its own.

---

### Fallback: capture on Windows laptop

If YOUR_SERVER-side capture is not possible (YOUR_SERVER is down, MobaXterm unavailable), you can
capture on the Windows laptop and WinSCP the file to YOUR_SERVER. Sessions captured this
way are shorter-lived (hours, not days/weeks) due to the device/IP mismatch.

From the repo folder in PowerShell 7:

```powershell
cd "C:\Projects\CLAUDEHOME\Smart Calendar\Interactive Smart Family Hub Project\repo"
& ".\.venv\Scripts\python.exe" keep_login.py
```

Then WinSCP `keep_auth.json` to YOUR_SERVER at `/home/YOUR_PI_USER/keep-mirror/keep_auth.json`
and restart the service as in step 4 above.

> If `.venv` doesn't exist, recreate it — venvs are not portable:
> ```powershell
> py -m venv .venv
> & ".\.venv\Scripts\python.exe" -m pip install playwright
> & ".\.venv\Scripts\python.exe" -m playwright install chromium
> ```

---

## When auth breaks — symptoms

- Lists panel shows "Keep service offline" / goes blank.
- `journalctl -u keep-mirror.service` shows `auth state expired` or
  `Auth state lost mid-run`.
- `curl http://127.0.0.1:3002/health` returns `"authed": false`.
- You get an **ntfy push** titled "Keep sidecar (YOUR_SERVER)" (see Monitoring).

Recovery = the routine re-auth above.

---

## Monitoring & self-protection (added 2026-05-30)

The sidecar used to fail silently: when cookies expired it crash-looped
under systemd ~every 70s and the Lists panel just went dark — once for 16
days (28,000+ restarts) before anyone noticed. Three guards now prevent
that.

### 1. Effective start-limit cap

systemd's defaults (5 starts / 10s) never tripped, because the ~70s crash
cycle never puts 5 restarts inside a 10s window. Drop-in widens the window
so 5 failed starts (~6 min) land the unit in `failed` instead of looping
forever:

`/etc/systemd/system/keep-mirror.service.d/override.conf`
```ini
[Unit]
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
RestartSec=30
```

### 2. Immediate failure alert (`OnFailure=`)

When the unit lands in `failed`, systemd fires a one-shot that pushes via
ntfy.

`/etc/systemd/system/keep-mirror.service.d/alert.conf`
```ini
[Unit]
OnFailure=keep-mirror-alert@%n.service
```

`/etc/systemd/system/keep-mirror-alert@.service`
```ini
[Unit]
Description=ntfy alert for failed unit %i

[Service]
Type=oneshot
ExecStart=/usr/local/bin/keep-alert.sh "%i landed in FAILED state on YOUR_SERVER — re-run keep_login.py (see KEEP_SETUP.md)"
```

### 3. Health probe (catches running-but-unauthed)

If the session drops mid-run, `keep_service.py` sets `authed=false` but
keeps the Flask process alive — so it stays `active` and `OnFailure=`
never fires. A timer polls `/health` every 15 min and alerts on a
healthy→unhealthy transition (debounced via `/run/keep-health.state`, so
no repeat spam; one "recovered" ping when it comes back).

`/etc/systemd/system/keep-health.timer` (`OnUnitActiveSec=15min`,
`OnBootSec=3min`, `Persistent=true`) → `keep-health.service` →
`/usr/local/bin/keep-health.sh`.

### Shared notifier + config

`/usr/local/bin/keep-alert.sh` posts to ntfy; the topic lives only in
`/etc/keep-alert.conf` (root-owned, `chmod 600`):

```ini
NTFY_TOPIC=keep-YOUR_SERVER-XXXXXXXX
# NTFY_SERVER=https://ntfy.sh   # default; change only if self-hosting
```

Subscribe the ntfy phone app to that exact topic. Test any time with:

```bash
sudo /usr/local/bin/keep-alert.sh "test"
```

---

## One-time setup on YOUR_SERVER (reference — already done)

### System packages + venv

```bash
ssh YOUR_PI_USER@YOUR_PLEX_SERVER_IP
cd /home/YOUR_PI_USER/keep-mirror
sudo apt install -y python3-venv
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### Playwright browser binary

```bash
.venv/bin/playwright install chromium
sudo .venv/bin/playwright install-deps chromium
```

`install chromium` downloads a Chromium build into `~/.cache/ms-playwright`.
`install-deps` apt-installs the system libs Chromium needs (libnss3, libgbm1,
etc.) — that's why it needs sudo.

### `.env` on YOUR_SERVER

```
KEEP_SIDECAR_HOST=0.0.0.0
KEEP_SIDECAR_PORT=3002
KEEP_GROCERY_LIST=Grocery
KEEP_COSTCO_LIST=Costco
```

The list names are matched by exact title (case-insensitive); they must be
Keep **lists** (with checkboxes), not plain notes. Override the names here
if yours differ.

### systemd unit

`/etc/systemd/system/keep-mirror.service`
```ini
[Unit]
Description=Keep mirror — Playwright sidecar for SmartDisplayPi
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_PI_USER
WorkingDirectory=/home/YOUR_PI_USER/keep-mirror
EnvironmentFile=/home/YOUR_PI_USER/keep-mirror/.env
ExecStart=/home/YOUR_PI_USER/keep-mirror/.venv/bin/python /home/YOUR_PI_USER/keep-mirror/keep_service.py
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now keep-mirror.service
```

---

## Tuning selectors

When Keep ships a frontend redesign (rare), the DOM extractor in
`keep_service.py` may stop returning anything. Two debug endpoints help —
run them **on YOUR_SERVER**:

```bash
curl http://127.0.0.1:3002/debug/extract        # what the extractor sees
curl http://127.0.0.1:3002/debug/html > keep.html  # live page HTML
```

Open `keep.html`, search for your list title. Selectors live in
`EXTRACT_JS` and `CHECK_JS` at the top of `keep_service.py`. Note the
sidecar also writes `keep_startup.png` + `keep_startup.html` to
`/home/YOUR_PI_USER/keep-mirror/` on each start for the same purpose — these
contain your list data, keep them off any repo.

---

## Known limits

- **Read + check-off only.** No add-from-display. The family's "OK Google,
  add milk to the grocery list" voice flow still populates Keep — the
  display reads what's there.
- **Polling, not push.** Keep has no webhook. The sidecar reloads its tab
  every 60s; check-off is optimistic in the UI and reflected in Keep
  within ~1 second.
- **Cookie decay.** Sessions last weeks to months. Re-run `keep_login.py`
  when the panel goes offline (or when ntfy pings you).
- **Memory.** Headless Chromium adds ~300 MB resident on YOUR_SERVER.
- **Keep retirement.** Google has signaled Keep will eventually be sunset.
  When that day comes this whole sidecar gets ripped out.
