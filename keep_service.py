"""
Keep sidecar — Playwright edition.

Drives a real headless Chromium against keep.google.com using a saved
auth state from keep_login.py (run once on your laptop).

Why Playwright instead of gkeepapi:
  - Google killed the EmbeddedSetup master-token flow that gkeepapi
    depends on. Most personal accounts can't mint a token in 2026.
  - Playwright reuses a logged-in browser session — the same auth that
    keep.google.com itself uses. As long as Keep works for humans,
    this works.
  - Tradeoff: ~300MB RAM for headless Chromium, plus DOM-scraping
    selectors may need occasional tuning when Keep's frontend ships
    a redesign (rare).

API surface (unchanged — server.js still works):
    GET  /health
    GET  /lists
         → { grocery: { listId, items: [{id, text}] },
             costco:  { listId, items: [{id, text}] } }
    POST /lists/<list_title>/items/<item_id>/check
    GET  /debug/extract  — show raw extractor output (selector tuning)
    GET  /debug/html     — dump current page HTML (selector tuning)

Concurrency: Flask is run threaded=False. Playwright objects are bound to
the thread that creates them, and a single browser context is fine for
the load this sidecar sees (a /lists hit every 60s + occasional checks).

Re-auth: when the Lists panel goes offline, re-run keep_login.py on your
laptop and copy the new keep_auth.json over.
"""

import logging
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("ERROR: playwright not installed. From the project root:", file=sys.stderr)
    print("  .venv/bin/pip install -r requirements.txt", file=sys.stderr)
    print("  .venv/bin/playwright install chromium", file=sys.stderr)
    sys.exit(1)

# ─────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(PROJECT_ROOT / ".env")

AUTH_FILE        = PROJECT_ROOT / "keep_auth.json"
GROCERY_NAME     = os.environ.get("KEEP_GROCERY_LIST", "Grocery").strip()
COSTCO_NAME      = os.environ.get("KEEP_COSTCO_LIST",  "Costco").strip()
HOST             = os.environ.get("KEEP_SIDECAR_HOST", "127.0.0.1")
PORT             = int(os.environ.get("KEEP_SIDECAR_PORT", "3002"))
REFRESH_INTERVAL = 60   # seconds — minimum gap between page reloads

logging.basicConfig(
    level=logging.INFO,
    format="[keep] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("keep_service")

# ─────────────────────────────────────────────────────────────────────────
# Browser state — created at startup, reused for the process lifetime
# ─────────────────────────────────────────────────────────────────────────
_pw      = None
_browser = None
_context = None
_page    = None
_authed  = False
_last_refresh = 0.0


def start_browser():
    """Launch headless Chromium with the saved auth state and verify Keep loads."""
    global _pw, _browser, _context, _page, _authed
    if not AUTH_FILE.exists():
        log.error("Missing %s — run keep_login.py on your laptop and WinSCP it here.", AUTH_FILE.name)
        return False
    try:
        _pw = sync_playwright().start()
        _browser = _pw.chromium.launch(
            headless=True,
            # --no-sandbox: required when running as a non-root PM2 process on Pi
            # --disable-dev-shm-usage: Pi has tiny /dev/shm, use /tmp instead
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        _context = _browser.new_context(
            storage_state=str(AUTH_FILE),
            viewport={"width": 1280, "height": 900},
            # Same UA as a desktop Chrome so Keep doesn't serve a mobile layout
            user_agent=("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"),
        )
        _page = _context.new_page()
        _page.goto("https://keep.google.com", wait_until="domcontentloaded", timeout=30000)

        # Give Keep time to hydrate. We DON'T fail on a missing selector here —
        # if Keep is rendering something unexpected (login interstitial, captcha,
        # bot-detection page) we want to keep running so the /debug endpoints
        # are reachable for diagnosis. Failure paths are reflected in /health.
        try:
            _page.wait_for_load_state("networkidle", timeout=20000)
        except Exception as e:
            log.warning("networkidle wait timed out: %s — proceeding anyway", e)

        # Always log final state so the PM2 logs tell us what happened.
        try:
            log.info("Final URL:    %s", _page.url)
            log.info("Final title:  %s", _page.title())
        except Exception:
            pass

        # Save a startup screenshot + HTML for diagnosis. SCP these back from the Pi
        # to see exactly what headless Chromium rendered.
        try:
            _page.screenshot(path=str(PROJECT_ROOT / "keep_startup.png"), full_page=True)
            (PROJECT_ROOT / "keep_startup.html").write_text(_page.content(), encoding="utf-8")
            log.info("Saved keep_startup.png + keep_startup.html for diagnosis")
        except Exception as e:
            log.warning("Could not save startup snapshot: %s", e)

        # Detect login redirect AFTER snapshot so we capture evidence either way.
        if "accounts.google.com" in _page.url:
            log.error("Page redirected to accounts.google.com — auth state expired. Re-run keep_login.py.")
            _authed = False
            return False

        # Mark authed even if our preferred selector wasn't found — the /debug
        # endpoints will still work, and serialize_list() returns empty lists
        # gracefully if extraction comes back empty.
        _authed = True
        _mark_refreshed()
        log.info("Headless Keep loaded (auth state replayed). Ready for /lists.")
        return True
    except Exception as e:
        log.error("Browser startup failed: %s", e)
        _authed = False
        return False


def _mark_refreshed():
    global _last_refresh
    _last_refresh = time.time()


def refresh_if_stale(force=False):
    """Reload the Keep tab if cache is older than REFRESH_INTERVAL."""
    if not _authed:
        return
    if not force and (time.time() - _last_refresh) < REFRESH_INTERVAL:
        return
    try:
        _page.reload(wait_until="domcontentloaded", timeout=30000)
        if "accounts.google.com" in _page.url:
            _set_unauthed()
            return
        # Tolerate the networkidle timeout — Keep makes background requests
        # forever, so it never fully settles. The DOM is usable long before then.
        try:
            _page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass
        _mark_refreshed()
    except Exception as e:
        log.warning("Refresh failed: %s", e)


def _set_unauthed():
    global _authed
    _authed = False
    log.error("Auth state lost mid-run — re-run keep_login.py on your laptop")


# ─────────────────────────────────────────────────────────────────────────
# DOM extraction
#
# Keep's class names are auto-generated and unstable — never select on them.
# As of 2026-04, Keep's structure is:
#   - List title:      <div role="textbox" contenteditable="false">Grocery</div>
#   - Item checkbox:   <div role="checkbox" aria-checked="false">
#   - Item text:       <p role="presentation"><span>apples</span></p>
#   - Card boundary:   no stable role/attribute — walk up from the title
#                      until we hit an ancestor containing checkboxes.
#
# Item IDs: Keep doesn't surface stable IDs at the DOM level, so we use the
# item's text as its id (with "#N" suffix for duplicates). This survives
# DOM re-renders that would invalidate per-render handles like aria-describedby.
#
# If Keep redesigns its frontend and this stops returning lists, hit
# /debug/html and rewrite EXTRACT_JS / CHECK_JS against the new markup.
# ─────────────────────────────────────────────────────────────────────────
EXTRACT_JS = r"""
() => {
  const out = [];
  // Each note card has its title rendered as a role="textbox". A plain note's
  // body is also a textbox, so we filter to those that have a checkbox-bearing
  // card-like ancestor (i.e. the textbox is a list TITLE, not a note body).
  const titles = document.querySelectorAll('[role="textbox"]');
  for (const titleEl of titles) {
    const title = (titleEl.textContent || '').trim();
    if (!title) continue;

    // Walk up to the smallest ancestor that contains checkboxes. That's the
    // list card. If we never find one, this textbox isn't a list title — skip.
    let card = titleEl.parentElement;
    while (card && card !== document.body) {
      if (card.querySelector('[role="checkbox"]')) break;
      card = card.parentElement;
    }
    if (!card || card === document.body) continue;

    const items = [];
    const seen = {};
    for (const cb of card.querySelectorAll('[role="checkbox"]')) {
      // Item row: smallest ancestor of the checkbox that also contains a
      // <p role="presentation"> with the item text. Uses :has() (Chromium 105+).
      const row = cb.closest(':has(p[role="presentation"])');
      if (!row || row === card) continue;
      const span = row.querySelector('p[role="presentation"] span')
                || row.querySelector('p[role="presentation"]');
      const text = span ? span.textContent.trim() : '';
      if (!text) continue;

      // Use text as id. Duplicate texts get "text#1", "text#2", ... suffixes.
      let id = text;
      if (seen[text] !== undefined) {
        seen[text]++;
        id = text + '#' + seen[text];
      } else {
        seen[text] = 0;
      }

      const checked = cb.getAttribute('aria-checked') === 'true';
      items.push({ id, text, checked });
    }
    if (items.length > 0) {
      out.push({ title, items });
    }
  }
  return out;
}
"""


def extract_lists():
    """Run the DOM extractor and return a list of {title, items[]} dicts."""
    if not _authed or _page is None:
        return []
    try:
        return _page.evaluate(EXTRACT_JS)
    except Exception as e:
        log.error("extract_lists failed: %s", e)
        return []


def find_list(all_lists, target_name):
    target = (target_name or "").lower()
    for L in all_lists:
        if (L.get("title") or "").strip().lower() == target:
            return L
    return None


def serialize_list(L):
    """Frontend shape: { listId, items: [{id, text}] }. Skip checked items."""
    if L is None:
        return {"listId": None, "items": []}
    items = [
        {"id": it["id"], "text": it["text"]}
        for it in L.get("items", [])
        if not it.get("checked")
    ]
    # We expose the list TITLE as the listId because Keep doesn't surface a
    # stable list-card id at the DOM level. server.js URL-encodes it for us.
    return {"listId": L.get("title"), "items": items}


# ─────────────────────────────────────────────────────────────────────────
# Item check-off — clicks the checkbox in the live DOM and lets Keep sync.
# ─────────────────────────────────────────────────────────────────────────
CHECK_JS = r"""
([listTitle, itemId]) => {
  // Find the card by matching its title textbox, then walking up to the
  // smallest ancestor that contains checkboxes (mirrors EXTRACT_JS).
  const wantTitle = listTitle.toLowerCase();
  let card = null;
  for (const t of document.querySelectorAll('[role="textbox"]')) {
    if ((t.textContent || '').trim().toLowerCase() !== wantTitle) continue;
    let p = t.parentElement;
    while (p && p !== document.body) {
      if (p.querySelector('[role="checkbox"]')) { card = p; break; }
      p = p.parentElement;
    }
    if (card) break;
  }
  if (!card) return { ok: false, reason: 'list not found' };

  // Decode itemId — may be raw text or "text#N" for duplicate disambiguation.
  const hashIdx = itemId.lastIndexOf('#');
  const isDup = hashIdx >= 0 && /^\d+$/.test(itemId.slice(hashIdx + 1));
  const baseText = isDup ? itemId.slice(0, hashIdx) : itemId;
  const wantOccurrence = isDup ? parseInt(itemId.slice(hashIdx + 1), 10) : 0;

  let occurrence = -1;
  for (const cb of card.querySelectorAll('[role="checkbox"]')) {
    const row = cb.closest(':has(p[role="presentation"])');
    if (!row || row === card) continue;
    const span = row.querySelector('p[role="presentation"] span')
              || row.querySelector('p[role="presentation"]');
    const text = span ? span.textContent.trim() : '';
    if (text !== baseText) continue;
    occurrence++;
    if (occurrence !== wantOccurrence) continue;

    if (cb.getAttribute('aria-checked') === 'true') {
      return { ok: true, reason: 'already checked' };
    }
    cb.click();
    return { ok: true, reason: 'clicked' };
  }
  return { ok: false, reason: 'item not found' };
}
"""


def check_item(list_title, item_id):
    if not _authed:
        return False, "not authed"
    refresh_if_stale(force=True)  # ensure DOM has the item before we click
    try:
        result = _page.evaluate(CHECK_JS, [list_title, item_id])
        if result.get("ok"):
            time.sleep(0.7)  # let Keep persist the change before we move on
            return True, result.get("reason", "")
        return False, result.get("reason", "unknown")
    except Exception as e:
        log.error("check_item failed: %s", e)
        return False, str(e)


# ─────────────────────────────────────────────────────────────────────────
# Flask app
# ─────────────────────────────────────────────────────────────────────────
app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({
        "ok": _authed,
        "authed": _authed,
        "lastRefresh": _last_refresh,
        "url": _page.url if _page else None,
        "groceryListName": GROCERY_NAME,
        "costcoListName": COSTCO_NAME,
    })


@app.get("/lists")
def get_lists():
    if not _authed:
        return jsonify({"error": "not authenticated", "grocery": None, "costco": None}), 503
    refresh_if_stale()
    all_lists = extract_lists()
    return jsonify({
        "grocery": serialize_list(find_list(all_lists, GROCERY_NAME)),
        "costco":  serialize_list(find_list(all_lists, COSTCO_NAME)),
    })


@app.post("/lists/<list_id>/items/<item_id>/check")
def check_item_route(list_id, item_id):
    # list_id is the list TITLE (see serialize_list).
    ok, reason = check_item(list_id, item_id)
    if not ok:
        log.warning("check refused: %s", reason)
        return jsonify({"error": "check failed", "reason": reason}), 502
    return jsonify({"ok": True, "reason": reason})


@app.get("/debug/extract")
def debug_extract():
    """Show what the extractor sees right now — for tuning selectors."""
    if not _authed:
        return jsonify({"error": "not authed"}), 503
    refresh_if_stale()
    return jsonify({"lists": extract_lists()})


@app.get("/debug/html")
def debug_html():
    """Dump the live page HTML — for tuning selectors when extraction is empty."""
    if _page is None:
        return "Browser not running\n", 503
    return _page.content(), 200, {"Content-Type": "text/html; charset=utf-8"}


# ─────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not start_browser():
        # Don't restart-spam under PM2 if auth is missing — back off so the user
        # has time to fix it before the next attempt.
        log.error("Cannot start without valid auth. Sleeping 30s before exit.")
        time.sleep(30)
        sys.exit(1)
    log.info("Keep sidecar listening on http://%s:%d", HOST, PORT)
    # threaded=False is REQUIRED — Playwright objects are bound to the thread
    # that created them. Single-threaded is fine: the only client is server.js
    # polling once a minute.
    app.run(host=HOST, port=PORT, threaded=False, debug=False, use_reloader=False)
