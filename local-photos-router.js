/**
 * local-photos-router.js
 * ──────────────────────
 * Express router that serves the Boundary Waters photo library.
 *
 * Adds two routes to the Pi's Express app:
 *   GET /api/local-photos   → JSON list of filenames in public/photos/
 *   GET /photos/:file       → static file serving for the photos themselves
 *
 * Pi paths:
 *   App root : /home/luke/SmartDisplayPi/
 *   Photos   : /home/luke/SmartDisplayPi/public/photos/
 *   This file: /home/luke/SmartDisplayPi/local-photos-router.js
 *
 * Installation (in the Pi's server.js — see deployment instructions):
 *   const localPhotos = require('./local-photos-router');
 *   app.use(localPhotos);
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const router     = express.Router();
const PHOTOS_DIR = path.join(__dirname, 'public', 'photos');
const VALID_EXT  = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// ── GET /api/local-photos ────────────────────────────────────────────────────
// Returns { files: ["filename1.jpg", "filename2.jpg", ...] }
router.get('/api/local-photos', (req, res) => {
    try {
        if (!fs.existsSync(PHOTOS_DIR)) {
            return res.json({ files: [] });
        }
        const files = fs.readdirSync(PHOTOS_DIR)
            .filter(f => VALID_EXT.has(path.extname(f).toLowerCase()))
            .sort();
        res.json({ files });
    } catch (err) {
        console.error('[local-photos] Error reading photos directory:', err.message);
        res.json({ files: [] });
    }
});

// ── GET /photos/:file ────────────────────────────────────────────────────────
// Serves individual photo files with caching headers.
// express.static could also serve this if public/ is already a static root —
// this explicit route ensures caching is set correctly for large JPEGs.
router.get('/photos/:file', (req, res) => {
    const filename = path.basename(req.params.file); // strip any path traversal
    const filepath = path.join(PHOTOS_DIR, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).send('Not found');
    }

    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h browser cache
    res.sendFile(filepath);
});

module.exports = router;
