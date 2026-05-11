// PM2 process manifest for SmartDisplayPi.
//
// Two services run side by side:
//   - smartdisplay : Node Express server (server.js) on :3000
//   - keep         : Python Flask sidecar (keep_service.py) on 127.0.0.1:3002
//
// Pi OS Bookworm+ blocks system-wide pip installs (PEP 668), so the Python
// sidecar runs from a project-local venv at ./.venv. Create it once with:
//   python3 -m venv .venv
//   .venv/bin/pip install -r requirements.txt
//   .venv/bin/playwright install chromium
//   sudo .venv/bin/playwright install-deps chromium
//
// Auth state (keep_auth.json) must be present in the project root before
// the Keep sidecar will start — see KEEP_SETUP.md for how to mint it on
// your laptop and copy it over.
//
// Adopt this manifest with:
//   pm2 delete all && pm2 start ecosystem.config.js && pm2 save
// Afterward, `pm2 restart all` cycles both services together.

module.exports = {
  apps: [
    {
      name: 'smartdisplay',
      script: 'server.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'keep',
      script: 'keep_service.py',
      cwd: __dirname,
      // Use the project-local venv (Pi OS PEP 668 blocks system pip installs).
      // Absolute path so PM2 finds it regardless of where it was started from.
      interpreter: `${__dirname}/.venv/bin/python`,
      autorestart: true,
      // Keep auth can fail at startup if .env is missing — don't hammer restart loops.
      max_restarts: 5,
      restart_delay: 10000,
      watch: false,
    },
  ],
};
