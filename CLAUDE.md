# SmartDisplayPi — Project Context

> Read this cold. Everything a new Claude Code session needs to know.

---

## What This Is

A Raspberry Pi–based smart home display running at 1024×600 in a Chromium kiosk. It shows a rotating carousel of full-screen cards: an ambient photo background with a clock and shortcuts, a live weather card, an interactive calendar, and a Gemini AI–generated daily summary. The aesthetic is called **Boreal** — dark glassmorphism over Boundary Waters photography.

The project lives in two places simultaneously:
- **Development machine (Windows):** `C:\Projects\CLAUDEHOME\Smart Calendar\Interactive Smart Family Hub Project\repo\`
- **Pi deployment:** `/home/YOUR_PI_USER/SmartDisplayPi/` on `YOUR_PI_HOSTNAME` (user: `YOUR_PI_USER`) — as of 2026-05-29 this is a **git clone of the `YOUR_PRIVATE_REPO` fork** (it previously sat on the upstream `Piflyer` remote with uncommitted edits). Web assets are under `public/`; `server.js` + `package.json` at root. Deploy with `git pull && pm2 restart smart-display`.

**Project record (Cowork):** Full build log, issue tracker, findings, and task state live in the Cowork project folder at `C:\Projects\CLAUDEHOME\Smart Calendar\Interactive Smart Family Hub Project\`. Key files: `insights.md` (immutable findings log — read before starting technical work), `todos.md` (task tracker), `technical_rules.md` (non-negotiable build constraints). After completing significant work, log a dated summary entry in `insights.md`. Do not leave Claude Code session work undocumented — the Cowork record is the authoritative project history.

**GitHub:** Private repo `https://github.com/YOUR_GITHUB_USERNAME/YOUR_PRIVATE_REPO` (personal config intact). Public repo `https://github.com/ltdavis74/LTD-smart-display` (scrubbed). Private is canonical — changes flow private → scrub → public, never the reverse.

**NEVER push directly to the public repo.** Always sync via the wrapper script from the project root:
```powershell
cd "C:\Projects\CLAUDEHOME\Smart Calendar\Interactive Smart Family Hub Project"
.\sync_to_public.ps1
```
The script runs the scrubber, verifies no personal data leaked, then commits and pushes. Skipping it risks exposing personal data publicly.

`simulator.html` is the design/dev scratchpad — a self-contained HTML file that mirrors the Pi display. Changes proven there get mapped back into the production files (`app.js`, `index.html`, `styles.css`, `server.js`).

---

## Architecture

```
browser (Chromium kiosk, 1024×600)
  └── index.html + styles.css + app.js
        └── SmartDisplay class (app.js) — all UI logic, carousel, calendar
              └── fetch() → server.js (Express, port 3000)
                    ├── /api/weather       → Open-Meteo (no API key)
                    ├── /api/calendar/agenda → Google Calendar OAuth2
                    ├── /api/calendar/events → Google Calendar OAuth2
                    ├── /api/summary       → Gemini AI (cached hourly)
                    ├── /api/photos        → Plex media server (optional)
                    ├── /api/photo-proxy/* → Plex proxy (keeps token server-side)
                    └── /api/local-photos  → local-photos-router.js (Pi photos dir)
```

**Process management on Pi:** PM2 runs the Node server. LightDM manages the Wayland display session. Chromium launches in kiosk mode via `kiosk.sh`.

---

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express backend. All API routes. Google Calendar OAuth2, Gemini AI, Plex, Open-Meteo. |
| `app.js` | All frontend logic. `SmartDisplay` class. Carousel nav, calendar three-view system, photo rotation, weather fetch, summary fetch. |
| `index.html` | HTML shell. 5-card carousel (`slide-left` CSS classes). Calendar grid injected at runtime by `app.js`. |
| `styles.css` | Production CSS for `index.html`. Does not affect simulator. |
| `simulator.html` | **Self-contained** dev scratchpad. Has its own CSS, JS, and 4-card carousel. Not served by the Pi. Open directly in a browser. |
| `kiosk.sh` | Launches Chromium on the Pi in kiosk mode using Wayland flags. Never run from SSH — only valid inside a Wayland session. |
| `local-photos-router.js` | Express router for serving local photo files from `public/photos/` on the Pi. |
| `designs/DAK_inspired/` | Reference design exports (HTML + screenshots) for weather tab, calendar day/week/month views. Source of truth for the Boreal aesthetic. |
| `background images/resized/` | ~300+ Boundary Waters JPEGs, pre-resized to 1024×600. Used by `simulator.html` directly via relative path. |

---

## Production Carousel (app.js / index.html)

5 cards, navigated by CSS class on `#carouselWrapper`:

| Index | Card | CSS Class | ID |
|-------|------|-----------|-----|
| 0 | Ambient (Photos + clock) | *(no class)* | `photosCard` |
| 1 | Daily Summary (Gemini AI) | `slide-left` | `summaryCard` |
| 2 | Home Assistant (dormant) | `slide-left-2` | `homeAssistantCard` |
| 3 | Weather Forecast | `slide-left-3` | `forecastCard` |
| 4 | Calendar (Day/Week/Month) | `slide-left-4` | `agendaCard` |

Navigation: `this.goToCard(index)` in `SmartDisplay`.

**Calendar auto-return:** `CALENDAR_AUTO_RETURN_MS = 60000`. After 60s on Card 4 with no interaction, progress bars drain and `goToCard(0)` is called. Implemented in `exitToDefaultView()` and `resetCalendarAutoReturn()`.

**Weather auto-return:** Same 60s timer, separate implementation (`startWeatherAutoReturn()` / `clearWeatherAutoReturn()`). A 2px progress bar sits below the weather header (`#wxReturnProgress`). Starts when Card 3 is entered; cancelled on swipe away.

**Weather card photo background:** Crossfading Boundary Waters photos behind the weather card, identical to the calendar card. Two `<img>` slots (`#wxPhotoSlot0`, `#wxPhotoSlot1`) inside `.wx-photo-bg`. Initialized once on first entry to Card 3 via `setupWeatherBackground()` / `_wxNextPhoto()`. Guard: `this._wxPhotosInitialized`.

**Weather day drill-down:** Tapping any item in the daily forecast strip opens an inline 24-hour detail panel for that day. Normal strips hidden via `#wxNormal`; detail panel shown via `#wxDayDetail.visible`. Method: `showWxDayDetail(dayIndex)` / `closeWxDayDetail()`. Uses `this._weatherData` cached when forecast loads. Auto-scrolls to current hour (today) or 8am (future days).

**Settings cog:** Only present on the Daily Summary card (`#summarySettingsBtn`). Removed from Home Assistant and Calendar card headers.

**Daily Summary auto-navigation removed:** `checkHourlySummary()` is a no-op. The summary card only appears when the user explicitly taps the Summary shortcut button. Do not re-add auto-navigation.

---

## Simulator Carousel (simulator.html)

4 active cards at `width: 400%` with CSS `translateX`. HA card is hidden outside the carousel for future use.

| Index | Card | ID |
|-------|------|----|
| 0 | Home/Ambient | `simCard0` |
| 1 | Weather (DAK Boreal Lens) | `simCard1` |
| 2 | Calendar (Day/Week/Month) | `simCard2` |
| 3 | Daily Summary | `simCard3` |

Navigation: `goToCard(index)` global function.

**Auto-return timer:** 60s inactivity on any non-home card → `goToCard(0)`. Implemented as `_returnTimer` in `goToCard()`. Any call to `goToCard()` resets the timer.

**Photo rotation:** `PHOTO_DIR = 'background images/resized/'` (relative to `simulator.html`). Crossfades every 30s. All images listed in `PHOTO_FILES` array.

---

## Boreal Design System

```
surface                  #121416
surface-container-low    #1a1c1e
surface-container        #1e2022
surface-container-high   #282a2c
surface-container-highest #333537
primary                  #b8c8db  ← dusty slate-blue
primary-container        #2e3e4d
secondary                #a1d494  ← pine green (accents, highlights)
on-surface               #e2e2e5
on-surface-variant       #c4c6cd
outline-variant          #43474c
error / holiday          #ffb4ab

Glassmorphism:           rgba(51,53,55,0.4) + backdrop-filter: blur(20px)
Ghost borders:           outline: 1px solid rgba(142,145,151,0.15)
Font:                    Manrope (weights 200/300/400/500/600/700/800)
Hero numbers:            font-weight: 200 (extralight)
```

---

## Calendar Three-View System

Lives on Card 4 (production) / Card 2 (simulator). Three tabs: Day, Week, Month.

- **Day view:** all-day chips + "Next Up" glass card + pill event rows. Rendered by `renderDayView(date)`.
- **Week view:** 7 columns with large extralight date numbers + glass event cards. Rendered by `renderWeekGrid()`. Each column has `data-date` for tap-to-day navigation. Click listener is delegated from `setupCalendarGrid()`.
- **Month view:** calendar grid (~60% left) + Upcoming sidebar (~40% right). Rendered by `renderMonthGrid()`.

Default entry: **Week view** (both simulator and production). Entering Card 4 via `goToCard(4)` calls `setTimeout(() => this.showCalendarView('week'), 50)`.

CSS is injected at runtime by `injectCalendarGridStyles()` in `app.js`. This is the source of truth for calendar styles.

**Known CSS trap:** `.cal-ambient-shortcut-btn` must NOT appear in the `position: relative` rule that also applies to `.cal-month-view`, `.cal-week-view`, `.cal-day-view` — doing so overrides its `position: absolute` and breaks placement.

---

## Backend API Summary

| Endpoint | Source | Notes |
|----------|--------|-------|
| `GET /api/weather` | Open-Meteo | No API key. Returns `current`, `hourly`, `daily`. Temp in °F, wind in mph, timezone `America/Chicago`. |
| `GET /api/calendar/agenda` | Google Calendar | Supports `?start=YYYY-MM-DD&end=YYYY-MM-DD` for month view. Default: rolling 7-day window. |
| `GET /api/calendar/events` | Google Calendar | Fixed 7-day window from today. Used by ambient card mini-events. |
| `GET /api/summary` | Gemini 2.5 Flash | Cached per hour. Accepts `?refresh=1` to bust cache. Prompt includes weather + calendar + tasks. Seasonal sailing section May–Oct. |
| `GET /api/photos` | Plex | Random batch of 25 photos from Plex library. Requires `PLEX_URL` + `PLEX_TOKEN` in `.env`. |
| `GET /api/photo-proxy/*` | Plex | Server-side proxy. Transcodes to 1024×600. Token never exposed to browser. |
| `GET /api/local-photos` | Local FS | Lists files in `public/photos/` on Pi. |

**Calendar allowlist** (in `server.js`): Primary (Calendar 1), Shared (Calendar 2), Partner, US Holidays.

---

## Environment Variables (.env on Pi)

```
PORT=3000
LATITUDE=YOUR_LATITUDE
LONGITUDE=YOUR_LONGITUDE
CITY=YOUR_CITY_STATE
GEMINI_API_KEY=...
GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
PLEX_URL=http://...
PLEX_TOKEN=...
PLEX_PHOTO_SECTION_ID=11
```

---

## Pi Deployment

**Hostname:** `YOUR_PI_HOSTNAME` | **User:** `YOUR_PI_USER` | **App path:** `/home/YOUR_PI_USER/SmartDisplayPi/`

**Pi runs Wayland, not X11.** The correct Chromium binary is `/usr/lib/chromium/chromium`. X11-only flags (`--display`, `xdotool`, etc.) do not work.

**Restart commands (from SSH):**
```bash
# Backend only (JS/server changes):
pm2 restart all

# Frontend + backend (HTML/CSS/JS display changes):
pm2 restart all && sudo systemctl restart lightdm
```

**Never run `kiosk.sh` from SSH.** It must be launched inside a Wayland session (LightDM autostart). The file is in the project root for reference and Pi deployment only.

**Deploy workflow (updated 2026-05-29):** the Pi is now a git clone of the `YOUR_PRIVATE_REPO` fork. Commit/push from Windows, then on the Pi: `cd ~/SmartDisplayPi && git pull && pm2 restart smart-display` (run `npm ci` first only when `package-lock.json` changed; append `&& sudo systemctl restart lightdm` for frontend changes that need a kiosk reload). The old WinSCP edit-and-sync flow is retired. Note: the Cowork sandbox can't drive git — commits are authored in PowerShell 7 on Windows.

---

## Conventions

- **Simulator first, then map back.** Design changes are prototyped in `simulator.html`, then the relevant CSS/HTML/JS is backported into `app.js` (for calendar styles), `index.html`, and `styles.css`.
- **No stranding.** Every non-home card must have an immediate home button (not just a timeout). Timeouts are a backup, not the primary exit.
- **Auto-return is 60s everywhere.** Both production (`CALENDAR_AUTO_RETURN_MS`) and simulator (`AUTO_RETURN_MS`) use 60000ms.
- **Secondary color = accent.** `#a1d494` (pine green) is used for active states, "today" highlights, and secondary labels in the 7-day forecast.
- **Manrope 200 for hero numbers.** Large clock, temperature, date numbers use `font-weight: 200`.
- **Glassmorphism for floating UI.** Any overlay card/panel uses `rgba(51,53,55,0.4)` + `backdrop-filter: blur(20px)`.
- **Ghost borders.** Subtle card outlines: `outline: 1px solid rgba(142,145,151,0.15)`.

---

## Your Household Context (for Gemini prompt)

[HOUSEHOLD MEMBERS, ROLES, AGES]. Location: [YOUR CITY, STATE]. Add any seasonal context relevant to your household and location.
