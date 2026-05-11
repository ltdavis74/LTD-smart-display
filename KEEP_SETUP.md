# Google Keep Sidecar — Setup & Recovery (Playwright edition)

The Lists panel on Card 0 is backed by Google Keep. Because Google killed
the master-token (`EmbeddedSetup`) flow that `gkeepapi` depends on, this
project uses a different approach: **a headless Chromium browser on the
Pi replays a logged-in Keep session that you capture once on your
laptop.**

It's heavier than an API client (~300 MB RAM), but it survives Google's
anti-abuse blocks because it's literally the same web auth your laptop
uses to view Keep. As long as keep.google.com works for humans, this
keeps working.

---

## How it works

```
Laptop (Windows)                 Pi (Linux ARM64)
─────────────────                ────────────────
keep_login.py                    keep_service.py
  ↓                                ↓
real Chrome window               headless Chromium
  ↓                                ↓
you sign in (full 2FA)           replays saved session
  ↓                                ↓
saves keep_auth.json  ─WinSCP─►  reads/checks list items
                                   ↓
                                 Flask :3002 ──► Express :3000 ──► Display
```

`keep_auth.json` holds your Keep session cookies. Treat it like a
password (it's already in `.gitignore`). It eventually expires (weeks to
months) — re-running `keep_login.py` re-mints it.

---

## One-time setup on your Windows laptop

You're capturing the auth state here because the Pi has no usable
browser to log in with.

### 1. Create a venv and install Playwright

From the project folder on Windows:

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install playwright
.venv\Scripts\python -m playwright install chromium
```

If `keep_login.py` later prefers real Chrome (better fingerprint vs.
Google's bot detection), it'll try that first; the bundled Chromium is
the fallback.

### 2. Capture the auth state

```powershell
.venv\Scripts\python keep_login.py
```

A real Chrome window opens at `keep.google.com`. Sign in normally —
including any 2FA / security key prompts. When you can see your Keep
notes (the main grid view), switch back to the terminal and press
**ENTER**. The script writes `keep_auth.json` to the project folder.

### 3. WinSCP `keep_auth.json` to the Pi

Drop it at `~/SmartDisplayPi/keep_auth.json`.

---

## One-time setup on the Pi

### 1. System packages

Pi OS Bookworm+ blocks system-wide `pip install` (PEP 668), so we use a
project-local venv.

```bash
ssh YOUR_PI_USER@YOUR_PI_HOSTNAME
cd ~/SmartDisplayPi
sudo apt install -y python3-venv
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 2. Playwright browser binary

```bash
.venv/bin/playwright install chromium
sudo .venv/bin/playwright install-deps chromium
```

`install chromium` downloads a ~150 MB ARM64 Chromium binary into
`~/.cache/ms-playwright`. `install-deps` runs `apt-get` for the system
libraries Chromium needs (libnss3, libgbm1, etc.) — that's why it needs
sudo. First run takes 5–10 minutes; subsequent updates are short.

### 3. Make sure your Keep lists are titled correctly

The sidecar looks for two Keep lists by exact title (case-insensitive):

- **Grocery**
- **Costco**

These must be **lists** (with checkboxes), not plain notes. Override the
names by adding to `.env`:

```
KEEP_GROCERY_LIST=Whatever You Call It
KEEP_COSTCO_LIST=Costco Run
```

### 4. Start the sidecar under PM2

The `ecosystem.config.js` manifest already points PM2 at the venv's
Python. Adopt it once:

```bash
pm2 delete all
pm2 start ecosystem.config.js
pm2 save
```

If you'd rather keep your existing PM2 process layout:

```bash
pm2 start keep_service.py --name keep --interpreter ~/SmartDisplayPi/.venv/bin/python
pm2 save
```

### 5. Verify

```bash
curl http://127.0.0.1:3002/health
# → { "ok": true, "authed": true, "url": "https://keep.google.com/...", ... }

curl http://127.0.0.1:3002/lists
# → { "grocery": { "listId": "Grocery", "items": [...] }, "costco": {...} }

curl http://localhost:3000/api/lists
# → same shape, served via the Node proxy
```

If `/lists` returns the right shape but `items` is empty when your Keep
list isn't, the DOM extractor needs tuning — see **Tuning selectors**
below.

Reload the kiosk:

```bash
sudo systemctl restart lightdm
```

---

## When auth breaks

Symptoms:

- Lists panel shows "Keep service offline"
- `pm2 logs keep` shows `Auth state expired` or `Auth state lost mid-run`
- `curl http://127.0.0.1:3002/health` returns `"authed": false`

Recovery is fast — re-run `keep_login.py` on your laptop, copy the new
`keep_auth.json` over, restart:

```powershell
# laptop
.venv\Scripts\python keep_login.py
# WinSCP keep_auth.json → ~/SmartDisplayPi/keep_auth.json
```

```bash
# pi
pm2 restart keep
```

Plan on doing this every few months. It's about a 90-second job.

---

## Tuning selectors

When Keep ships a frontend redesign (rare, but it happens), the DOM
extractor in `keep_service.py` may stop returning anything. Two
debug endpoints help:

```bash
# What the extractor currently sees:
curl http://127.0.0.1:3002/debug/extract

# Live page HTML, for finding new selectors:
curl http://127.0.0.1:3002/debug/html > keep.html
```

Open `keep.html` and search for your list title. The selectors live in
`EXTRACT_JS` and `CHECK_JS` at the top of `keep_service.py` — both are
plain JavaScript that runs inside the headless browser.

---

## Known limits

- **Read + check-off only.** No add-from-display. The family's existing
  "OK Google, add milk to the grocery list" voice flow continues to
  populate Keep — the display reads what's there.
- **Polling, not push.** Keep has no webhook. The sidecar reloads its
  tab every 60s; check-off is optimistic in the UI and reflected in
  Keep within ~1 second.
- **Cookie decay.** Sessions last weeks to months. Re-run
  `keep_login.py` when the panel goes offline.
- **Memory.** Headless Chromium adds ~300 MB resident on the Pi 5.
  Plenty of headroom on a 4 GB Pi 5; if you ever go to a 2 GB model,
  reconsider.
- **Keep retirement.** Google has signaled Keep will eventually be
  sunset. When that day comes this whole sidecar gets ripped out.
