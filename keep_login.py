"""
keep_login.py — run on your Windows laptop to capture an authenticated
Keep session. Saves cookies + localStorage to keep_auth.json.

Two modes:

  Default (stealth launch):
    .venv\\Scripts\\python keep_login.py

      Launches installed Google Chrome with anti-automation flags
      (drops --enable-automation, hides navigator.webdriver). Works
      for most accounts. If Google still rejects with "Couldn't sign
      you in / This browser or app may not be secure," use CDP mode.

  CDP attach (nuclear option, very reliable):
    .venv\\Scripts\\python keep_login.py --cdp

      Connects to a Chrome you launch yourself. See instructions
      printed when you run with --cdp.

Re-run when the Lists panel goes "Keep service offline" — typically
every few weeks to months.
"""

import argparse
import os
import sys
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("ERROR: playwright not installed.", file=sys.stderr)
    print("  py -m pip install playwright && py -m playwright install chromium", file=sys.stderr)
    sys.exit(1)

PROJECT_ROOT = Path(__file__).resolve().parent
OUT          = PROJECT_ROOT / "keep_auth.json"

# JS that hides the obvious "I am Playwright" tells. Google's bot detection
# checks navigator.webdriver and a few other quirks; clobbering them is
# enough to get past most consumer-account sign-in checks.
STEALTH_INIT = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'plugins', {
  get: () => [{ name: 'PDF Viewer' }, { name: 'Chrome PDF Viewer' }],
});
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
"""


def banner():
    print("─" * 60)
    print("  Keep auth capture")
    print("─" * 60)


def save_and_exit(context, label):
    if "keep.google.com" not in context.pages[0].url:
        print(f"  ✗ Active page is {context.pages[0].url!r} — not Keep. Aborting.")
        context.close()
        sys.exit(1)
    context.storage_state(path=str(OUT))
    size_kb = OUT.stat().st_size / 1024
    print(f"  ✓ Wrote {OUT} ({size_kb:.1f} KB) via {label}")
    print()
    print("  Next steps:")
    print(f"    1. WinSCP {OUT.name} to the Pi:  ~/SmartDisplayPi/{OUT.name}")
    print( "    2. On the Pi:                     pm2 restart keep")


def stealth_launch():
    banner()
    print()
    print("  A real Chrome window will open at keep.google.com.")
    print("  Sign in normally — full 2FA, security keys, whatever your")
    print("  account requires.")
    print()
    print("  When you can see your Keep notes, switch back to this")
    print("  terminal and press ENTER.")
    print()
    print("  If Google says \"Couldn't sign you in / browser may not be")
    print("  secure\", abort with Ctrl+C and re-run with --cdp.")
    print()

    with sync_playwright() as pw:
        common = dict(
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
            # Removing --enable-automation kills the "Chrome is being controlled
            # by automated test software" banner AND removes the strongest signal
            # Google uses for the rejection page.
            ignore_default_args=["--enable-automation"],
        )
        try:
            browser = pw.chromium.launch(channel="chrome", **common)
            label = "real Chrome"
        except Exception as e:
            print(f"  · installed Chrome not available ({e}); using bundled Chromium")
            browser = pw.chromium.launch(**common)
            label = "bundled Chromium (less reliable)"

        context = browser.new_context(viewport={"width": 1280, "height": 900})
        context.add_init_script(STEALTH_INIT)
        page = context.new_page()
        page.goto("https://keep.google.com")

        try:
            input("  Press ENTER once you're signed in and seeing your notes: ")
        except (EOFError, KeyboardInterrupt):
            print("\n  aborted.")
            browser.close()
            sys.exit(130)

        save_and_exit(context, label)
        browser.close()


def cdp_attach(port: int):
    banner()
    print()
    print("  CDP ATTACH MODE")
    print()
    print("  Step 1 (in another terminal — REQUIRED):")
    print( "    Close every Chrome window (check Task Manager — kill any")
    print( "    chrome.exe / *Chrome* processes still lingering).")
    print()
    print( "    Then run, in PowerShell:")
    print(f'      Start-Process chrome -ArgumentList "--remote-debugging-port={port}",`')
    print( '        "--user-data-dir=$env:TEMP\\keep-pw-profile",`')
    print( '        "https://keep.google.com"')
    print()
    print(f"    A normal Chrome window opens. Sign into Google in it like")
    print( "    a human would. When you can see your Keep notes, leave that")
    print( "    Chrome window open and continue here.")
    print()
    input("  Press ENTER when Chrome is open, signed in, and showing Keep: ")

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.connect_over_cdp(f"http://localhost:{port}")
        except Exception as e:
            print(f"  ✗ Couldn't connect to Chrome on port {port}: {e}")
            print( "    Make sure Chrome is running with --remote-debugging-port and")
            print( "    that no other Chrome instance is already using your default profile.")
            sys.exit(1)

        # The first context belongs to the user-launched Chrome. We grab the
        # page that has keep.google.com loaded.
        contexts = browser.contexts
        if not contexts:
            print("  ✗ Connected to Chrome but no browser contexts found.")
            sys.exit(1)
        ctx = contexts[0]
        keep_page = next((p for p in ctx.pages if "keep.google.com" in p.url), None)
        if keep_page is None:
            print(f"  ✗ No tab on keep.google.com found. Open one in Chrome and retry.")
            print(f"    Tabs Playwright sees: {[p.url for p in ctx.pages]}")
            sys.exit(1)

        ctx.storage_state(path=str(OUT))
        size_kb = OUT.stat().st_size / 1024
        print(f"  ✓ Wrote {OUT} ({size_kb:.1f} KB) via CDP attach")
        print()
        print("  Next steps:")
        print(f"    1. WinSCP {OUT.name} to the Pi:  ~/SmartDisplayPi/{OUT.name}")
        print( "    2. On the Pi:                     pm2 restart keep")
        print( "    3. You can close that Chrome window now.")


def main():
    ap = argparse.ArgumentParser(description="Capture a Keep auth state for the Pi sidecar.")
    ap.add_argument("--cdp", nargs="?", const=9222, type=int, default=None,
                    help="Connect to a Chrome you launched yourself with --remote-debugging-port. "
                         "Optionally specify the port (default 9222).")
    args = ap.parse_args()

    if args.cdp is not None:
        cdp_attach(args.cdp)
    else:
        stealth_launch()


if __name__ == "__main__":
    main()
