# SmartDisplayPi — Living Task Plan

> Last updated: 2026-05-04 (session 4)
> This file tracks what's done, what's in flight, and what's next.
> Update it as tasks are completed or reprioritized.

---

## Completed

### Simulator — Full Build
- [x] Created `simulator.html` as a self-contained 1024×600 dev scratchpad
- [x] 4-card carousel (CSS `translateX`, 400% wide, each card 25%)
- [x] **Card 0 — Home/Ambient:** Boundary Waters photo crossfade, Manrope 200 clock, mini upcoming-events panel (upper-right), 3 stacked shortcut buttons bottom-right (Calendar, Weather, Summary)
- [x] **Card 1 — Weather:** DAK Boreal Lens design — hero temp + 4 stat cards (2×2), hourly strip (8 slots, "Now" highlighted), 7-day daily strip with secondary/green labels; home button top-right
- [x] **Card 2 — Calendar:** Full Day/Week/Month three-view system; home button visible; default view is Week
- [x] **Card 3 — Daily Summary:** Glass header with home button; mock schedule/weather/affirmation
- [x] Home Assistant card preserved in `<div id="simCardHA" style="display:none">` outside carousel for future re-integration
- [x] Navigation dots + left/right arrows
- [x] Clock updates every second in card headers

### Simulator — Bug Fixes
- [x] Calendar button positioning (was appearing top-left due to `position: relative` override in `injectCalendarGridStyles`)
- [x] Shortcut buttons stacking correctly inside flex container (`.sim-ambient-shortcuts .cal-ambient-shortcut-btn { position: relative; }`)
- [x] Clock IDs updated to match new card structure (`simClockWeather`, `simClockSummary`, `simClock`)
- [x] `showCalendarView` triggered at correct index (`index === 2`, not `index === 4`)

### Simulator — Navigation
- [x] Home icon on all non-home cards (immediate `goToCard(0)`, no waiting)
- [x] **Auto-return timer:** 60s inactivity on any non-home card → `goToCard(0)`. `_returnTimer` reset on every `goToCard()` call. Fixes bug where display reverted to Daily Summary and stayed there.

### Simulator — Photo Background
- [x] Photo rotation with 30s interval, 1.8s crossfade
- [x] `PHOTO_DIR` corrected to `'background images/resized/'` (was `'background images/'`)
- [x] ~300 Boundary Waters JPEGs listed in `PHOTO_FILES` array

### Production (app.js / server.js)
- [x] `CALENDAR_AUTO_RETURN_MS` increased from 30s to 60s
- [x] Calendar CSS bug fixed (`.cal-ambient-shortcut-btn` removed from `position: relative` group rule)
- [x] Week view tap-to-day navigation: `data-date` added to each `.cal-week-col`, delegated click listener in `setupCalendarGrid()`
- [x] Week view tap feedback CSS (`:active` highlight, `cursor: pointer`)
- [x] `agendaBackBtn` wired to `goToCard(0)` so calendar card has an immediate home exit
- [x] `CALENDAR_AUTO_RETURN_MS` timer calls `goToCard(0)` on expiry

### Production — Session 2 Backport (this session)
- [x] **Weather card — full Boreal Lens design:** hero temp + feels-like, 4 stat cards (wind/humidity/UV/precip), hourly strip (8 slots, "Now" highlighted), 7-day daily strip with green labels
- [x] **Weather card — photo background:** same crossfade + overlay transparency as calendar card (`setupWeatherBackground()` / `_wxNextPhoto()`, 30s interval, Fisher-Yates shuffle, `/api/local-photos`)
- [x] **Weather card — auto-return timer:** 60s progress bar under header, same duration as calendar; starts on card entry, cancels on swipe away
- [x] **Weather card — day detail drill-down:** tap any day in daily strip → 24-hour horizontal scrollable panel for that day (real API hourly data filtered by date); auto-scrolls to current hour (today) or 8am (future days); back arrow returns to normal view; panel closes on swipe away
- [x] **Home card — 3 shortcut buttons:** Calendar, Weather, Summary stacked bottom-right; `touchstart`/`touchend` stopPropagation prevents swipe interference
- [x] **Calendar — defaults to Week view** when opened from home card (`showCalendarView('week')` in `goToCard(4)`)
- [x] **Calendar — home button fixed:** `agendaBackBtn` now shows home icon and is visible (was explicitly hidden)
- [x] **Daily summary — null-safe:** `data.summary || data.error || 'Summary unavailable'` prevents blank card
- [x] **Auto-navigate to summary removed:** `checkHourlySummary()` no longer calls `goToCard(1)` on the hour — summary only shown when button explicitly tapped
- [x] **Settings cog removed** from HA card and Calendar card; kept only on Daily Summary card
- [x] **Home button opacity:** all `.ha-back-btn` instances set to full-opacity `#b8c8db` (was faded `#666`)

### Card 0 — Google Keep Lists Panel (Session 3–4)
The native Google Tasks/Keep APIs and master-token flows were both blocked by Google's anti-abuse systems. Current working architecture uses a Playwright sidecar on a separate Ubuntu machine ("YOUR_SERVER") that drives headless Chromium against keep.google.com using a saved real-browser auth session.

- [x] **Auth pivot:** gkeepapi/master-token → Playwright (master-token blocked categorically; Playwright drives real browser session)
- [x] **YOUR_SERVER sidecar (`keep_service.py`):** Playwright + Flask on port 3002; sync threaded=False (Playwright objects are thread-bound)
- [x] **Laptop auth capture (`keep_login.py`):** mints `keep_auth.json` from a real Chrome login; SCP'd to YOUR_SERVER
- [x] **Express proxy (`/api/lists`):** `server.js` forwards to YOUR_SERVER:3002 with 60s cache
- [x] **Card 0 lists panel:** `loadLists`/`renderListCol`/`checkItem` in `app.js`; polls every 60s; supports Grocery + Costco lists by title match
- [x] **Role-based selectors:** `[role="listitem"]`, `[role="checkbox"]` — stable across Keep CSS redesigns; debug endpoints at `/debug/extract` and `/debug/html`
- [x] **PM2 manifest (`ecosystem.config.js`):** manages both Node server and Python sidecar; venv at `.venv/bin/python`
- [x] **Voice flow preserved:** "OK Google, add X to grocery list" → Keep → display reads it. Display is read+check-off only; no write/add needed.
- [x] **Re-auth ritual documented:** run `keep_login.py` on laptop → SCP `keep_auth.json` to YOUR_SERVER → `pm2 restart keep`

### Infrastructure
- [x] `kiosk.sh` created with correct Wayland flags and `/usr/lib/chromium/chromium` binary
- [x] `kiosk.sh` — `--disk-cache-size=0` flag added; prevents Chromium serving stale files after WinSCP deploy
- [x] `local-photos-router.js` — Express router for serving local Pi photo library; photos confirmed present at `/home/YOUR_PI_USER/SmartDisplayPi/public/photos/`
- [x] `~/.claude/settings.json` (global) created with `Bash(pm2 *)` and `Bash(node --check *)` — persists across all projects and sessions, eliminates repeated permission prompts
- [x] `CLAUDE.md` — project context file for cold-start sessions
- [x] `plan.md` — this file

---

## In Progress

*Nothing actively in flight as of last update.*

---

## Up Next (Prioritized)

### 1. Boreal Calendar Polish (current)
`injectCalendarGridStyles()` is functional but cross-check against the simulator for visual parity:
- Day view: "Next Up" glass hero card treatment
- Week view: large extralight date numbers
- Month view: upcoming sidebar layout and spacing

### 2. Simulator — Day Detail Drill-Down
The weather day-detail panel was designed and built in `simulator.html` and then rolled to production. Verify the simulator version still matches the production version after both were edited independently.

### 3. Re-integrate Home Assistant Card
The HA card is parked outside the carousel in the simulator (`simCardHA`, `display:none`). When HA integration is ready:
- Decide whether it replaces card 2 or adds a 5th card
- Update `TOTAL_CARDS`, dots, and `goToCard()` bounds
- Add shortcut button on home card
- Wire HA URL in settings modal

---

## Deferred / Backlog

- **Settings panel** — there's a settings modal in `index.html` (summary enable/time). Not wired in simulator yet.
- **Google Tasks on summary card** — tasks API is in `server.js` but skipped in summary prompt due to past permission issues. Revisit.
- **Plex integration** — server-side proxy is built. Currently unused on Pi (no Plex credentials configured). Lower priority than local photos.
- **Night mode / dimming** — no auto-brightness or display sleep yet. Pi screen dims via OS settings only.
- **Touchscreen gestures** — swipe navigation exists in production (`app.js`) but not simulator. Low priority for now.
- **Calendar — recurring event display** — month view may show all instances of recurring events; verify it doesn't flood the sidebar.

---

## Architecture Notes for Future Work

**Simulator → Production mapping:**
- Simulator CSS in `<style>` tags → `styles.css` (outer chrome) or `injectCalendarGridStyles()` in `app.js` (calendar internals)
- Simulator card HTML in `#simCard*` divs → `index.html` carousel cards
- Simulator JS in `<script>` tags → `SmartDisplay` class methods in `app.js`

**Card index is different between simulator and production:**
| Card | Simulator Index | Production Index |
|------|-----------------|-----------------|
| Home/Ambient | 0 | 0 |
| Weather | 1 | 3 |
| Calendar | 2 | 4 |
| Daily Summary | 3 | 1 |
| Home Assistant | (hidden) | 2 |

Always double-check which index system you're working in.

**Weather card state machine (production):**
- Normal view: `#wxNormal` visible, `#wxDayDetail` hidden
- Day detail view: `#wxNormal` hidden, `#wxDayDetail.visible` shown (populated from `this._weatherData`)
- `showWxDayDetail(dayIndex)` / `closeWxDayDetail()` manage the toggle
- Navigating away from card 3 always resets to normal view

**Permission settings:**
- `~/.claude/settings.json` — global, applies all projects: `Bash(pm2 *)`, `Bash(node --check *)`
- `.claude/settings.json` — project-level (same entries, redundant with global but kept for explicitness)
- `Edit`, `Write`, `Read`, `Grep`, `Glob` — built-in tools, always auto-allowed, never need an entry
