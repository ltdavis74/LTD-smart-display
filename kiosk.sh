#!/usr/bin/env bash
# kiosk.sh — launches Chromium in kiosk mode on the Pi display (Wayland)
#
# DO NOT run this from SSH — there is no display session available over SSH.
# The correct way to restart the display from SSH is:
#   sudo systemctl restart lightdm
#
# This script is auto-executed by LightDM on login. It is here for reference
# and in case LightDM needs a manual autostart entry pointing to it.

# Disable screen blanking (Wayland/wlr compatible)
wlr-randr --output HDMI-A-1 --on 2>/dev/null || true

# Launch Chromium in kiosk mode
exec /usr/lib/chromium/chromium \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --autoplay-policy=no-user-gesture-required \
    --check-for-update-interval=31536000 \
    --ozone-platform=wayland \
    --disk-cache-size=0 \
    http://localhost:3000
