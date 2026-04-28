#!/usr/bin/env node
'use strict';

/**
 * Static checks for the admin dashboard UI.
 *
 *  - All `onclick="fn(..."` handlers referenced in the page templates must be
 *    exposed by `public/js/app.js`. (The legacy `core.js` SPA shell was
 *    removed in the production-stability cleanup.)
 *  - Every CSS class used in `public/pages/*.html` must either be defined in
 *    `public/css/app.css` or be a known utility/state class. This guards
 *    against the "missing CSS" regressions that previously left modal headers,
 *    user-database stat tiles, and warning buttons unstyled.
 *
 * Exit code is non-zero when any violation is found so CI/the npm script
 * (`npm run check:admin-ui`) fails fast instead of silently shipping bugs.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PAGES_DIR = path.join(PUBLIC, 'pages');
const APP_JS = path.join(PUBLIC, 'js', 'app.js');
const APP_CSS = path.join(PUBLIC, 'css', 'app.css');

function readFile(p) {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function listPages() {
    if (!fs.existsSync(PAGES_DIR)) return [];
    return fs.readdirSync(PAGES_DIR)
        .filter((f) => f.endsWith('.html'))
        .map((f) => path.join(PAGES_DIR, f));
}

function collectOnclickHandlers(html) {
    const out = new Set();
    const re = /onclick\s*=\s*"([a-zA-Z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(html))) out.add(m[1]);
    return out;
}

function collectClassTokens(html) {
    const out = new Set();
    const re = /class\s*=\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
        m[1].split(/\s+/).filter(Boolean).forEach((t) => out.add(t));
    }
    return out;
}

function functionDefinedIn(name, source) {
    const patterns = [
        new RegExp(`function\\s+${name}\\b`),
        new RegExp(`window\\.${name}\\s*=`),
        new RegExp(`\\b${name}\\s*=\\s*(async\\s+)?function\\b`),
        new RegExp(`\\b${name}\\s*=\\s*\\(`),
        new RegExp(`\\b${name}\\s*:\\s*(async\\s+)?function\\b`),
    ];
    return patterns.some((re) => re.test(source));
}

function classDefinedIn(token, css) {
    // .token followed by non-identifier or end-of-string.
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-zA-Z0-9_-])\\.${escaped}([^a-zA-Z0-9_-]|$)`);
    return re.test(css);
}

const KNOWN_UTILITY_PREFIXES = ['mt-', 'mb-', 'ml-', 'mr-', 'mx-', 'my-', 'p-', 'pt-', 'pb-', 'pl-', 'pr-', 'px-', 'py-', 'gap-', 'w-', 'h-', 'text-', 'flex-', 'grid-cols-', 'col-', 'row-'];
const KNOWN_STATE_CLASSES = new Set([
    'active', 'open', 'show', 'hidden', 'disabled',
    'loading', 'is-active', 'is-open', 'is-loading',
    'good', 'bad', 'warn', 'info', 'danger', 'brand', 'accent',
    'blue', 'green', 'gray', 'violet', 'pink', 'red',
    'public', 'private', 'small', 'large', 'mini',
    'fragment-script', 'no-print',
    'offline', 'online', 'connected', 'disconnected', 'pending',
]);

function shouldSkipClass(token) {
    if (!token) return true;
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token)) return true;
    if (KNOWN_STATE_CLASSES.has(token)) return true;
    return KNOWN_UTILITY_PREFIXES.some((p) => token.startsWith(p));
}

function main() {
    const pages = listPages();
    if (!pages.length) {
        console.error(`[check-admin-ui] No pages found under ${PAGES_DIR}`);
        process.exit(1);
    }

    const appJs = readFile(APP_JS);
    const appCss = readFile(APP_CSS);
    // Page-level templates often define their own classes via inline <style>
    // blocks. Treat those blocks as additional CSS sources.
    const inlineCss = pages.map(readFile).join('\n');
    const allCss = [appCss, inlineCss].join('\n');

    const errors = [];
    const handlerCache = new Map();

    for (const file of pages) {
        const rel = path.relative(ROOT, file);
        const html = readFile(file);
        const handlers = collectOnclickHandlers(html);
        const classes = collectClassTokens(html);

        for (const fn of handlers) {
            if (!handlerCache.has(fn)) {
                handlerCache.set(fn, functionDefinedIn(fn, appJs));
            }
            if (!handlerCache.get(fn)) {
                errors.push(`${rel}: onclick handler "${fn}" is not defined in app.js`);
            }
        }

        for (const cls of classes) {
            if (shouldSkipClass(cls)) continue;
            if (!classDefinedIn(cls, allCss)) {
                errors.push(`${rel}: CSS class ".${cls}" is referenced but never defined`);
            }
        }
    }

    if (errors.length) {
        console.error(`[check-admin-ui] Found ${errors.length} issue(s):`);
        for (const err of errors) console.error('  - ' + err);
        process.exit(1);
    }

    const totalHandlers = handlerCache.size;
    const totalPages = pages.length;
    console.log(`[check-admin-ui] OK — ${totalPages} page(s) scanned, ${totalHandlers} unique onclick handler(s) verified.`);
}

main();
