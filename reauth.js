/**
 * reauth.js — Regenerate Google OAuth2 token.json for SmartDisplayPi
 *
 * Uses a local HTTP server on port 3001 to capture the auth code, replacing
 * the deprecated OOB flow (urn:ietf:wg:oauth:2.0:oob) that Google removed.
 *
 * Prerequisites:
 *   1. http://localhost:3001 added to Authorized redirect URIs in Google Cloud
 *      Console → APIs & Services → Credentials → your OAuth2 client.
 *   2. Fresh client_secret.json downloaded and placed in ~/SmartDisplayPi/.
 *   3. SSH tunnel open from your Windows machine:
 *        ssh -L 3001:localhost:3001 YOUR_PI_USER@YOUR_PI_HOSTNAME
 *      (run this in a second terminal — keep it open while you authorize)
 *
 * Usage:
 *   cd ~/SmartDisplayPi
 *   GOOGLE_APPLICATION_CREDENTIALS=./client_secret.json node reauth.js
 *
 * After successful auth, token.json is written and the server shuts down.
 * Then: pm2 restart smart-display --update-env
 */

'use strict';

const fs      = require('fs');
const http    = require('http');
const { URL } = require('url');
const { google } = require('googleapis');

const SCOPES        = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/tasks'
];
const REDIRECT_URI  = 'http://localhost:3001';
const TOKEN_PATH    = './token.json';
const PORT          = 3001;

// ── Load client credentials ───────────────────────────────────────────────────
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credPath || !fs.existsSync(credPath)) {
    console.error('ERROR: GOOGLE_APPLICATION_CREDENTIALS not set or file not found');
    console.error('Usage: cd ~/SmartDisplayPi && GOOGLE_APPLICATION_CREDENTIALS=./client_secret.json node reauth.js');
    process.exit(1);
}

const credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
const { client_id, client_secret } = credentials.installed || credentials.web;

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

// ── Build auth URL ────────────────────────────────────────────────────────────
const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'   // force refresh token to be returned even if already authorized
});

// ── Start local server to capture the redirect ────────────────────────────────
const server = http.createServer(async (req, res) => {
    try {
        const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
        const code   = reqUrl.searchParams.get('code');
        const error  = reqUrl.searchParams.get('error');

        if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<h2>Authorization failed: ${error}</h2><p>Close this tab and check the terminal.</p>`);
            server.close();
            console.error(`\nAuthorization error: ${error}`);
            process.exit(1);
        }

        if (!code) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<p>Waiting for authorization code...</p>');
            return;
        }

        // Exchange code for tokens
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // server.js uses google.auth.fromJSON() which requires type:"authorized_user"
        // plus client_id and client_secret embedded in the token file.
        // Saving raw tokens only (without these fields) causes fromJSON() to return
        // null and calendar never initializes.
        const tokenData = {
            type:          'authorized_user',
            client_id:     client_id,
            client_secret: client_secret,
            refresh_token: tokens.refresh_token,
            access_token:  tokens.access_token,
            expiry_date:   tokens.expiry_date,
            token_type:    tokens.token_type    || 'Bearer',
            scope:         tokens.scope         || SCOPES.join(' ')
        };

        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
            <h2 style="font-family:sans-serif;color:green">&#10003; Authorization successful!</h2>
            <p style="font-family:sans-serif">token.json written to SmartDisplayPi directory.<br>
            You can close this tab. Run <code>pm2 restart smart-display --update-env</code> on the Pi.</p>
        `);

        console.log(`\ntoken.json written to ${TOKEN_PATH}`);
        console.log('Run: pm2 restart smart-display --update-env');

        server.close();
        process.exit(0);

    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Error exchanging code for token</h2><pre>${err.message}</pre>`);
        console.error('\nToken exchange error:', err.message);
        server.close();
        process.exit(1);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('=== Google OAuth2 Re-Authorization ===');
    console.log(`\nLocal server listening on port ${PORT}`);
    console.log('\nMAKE SURE your SSH tunnel is open in a second terminal:');
    console.log('  ssh -L 3001:localhost:3001 YOUR_PI_USER@YOUR_PI_HOSTNAME\n');
    console.log('1. Open this URL in your browser (on your Windows machine):');
    console.log(`\n   ${authUrl}\n`);
    console.log('2. Sign in and authorize the app.');
    console.log('3. You will be redirected automatically — no code to copy.\n');
    console.log('Waiting for authorization...');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\nERROR: Port ${PORT} is already in use.`);
        console.error('Stop whatever is using it and try again.');
        console.error('  lsof -i :3001');
    } else {
        console.error('\nServer error:', err.message);
    }
    process.exit(1);
});
