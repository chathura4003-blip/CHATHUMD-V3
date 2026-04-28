'use strict';

const express = require('express');
const http = require('http');
const net = require('net');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const si = require('systeminformation');
const config = require('./config');
const { PORT, ADMIN_USER, ADMIN_PASS, JWT_SECRET, DOWNLOAD_DIR } = config;
const appState = require('./state');
const { setIO, logger } = require('./logger');
const db = require('./lib/db');
const runtimeSettings = require('./lib/runtime-settings');
const { validateConfig } = require('./lib/config-validation');
const { normalizeTarget } = require('./lib/automation-runtime');
const { normalizeOwner } = require('./lib/utils');
const { normalizeSriLankanPhoneNumber } = require('./lib/phone-normalizer');
const { createSchedulerRuntime } = require('./lib/scheduler-runtime');

const app = express();
const server = http.createServer(app);
let dashboardStarted = false;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_COOLDOWN_MS = 2 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();

function normalizeUserJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (raw.endsWith('@s.whatsapp.net')) return raw.toLowerCase();
    if (raw.endsWith('@lid')) return raw.toLowerCase();
    const digits = raw.replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
}

function normalizeGroupJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (raw.endsWith('@g.us')) return raw.toLowerCase();
    const digits = raw.replace(/\D/g, '');
    return digits ? `${digits}@g.us` : null;
}

function normalizeSessionId(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === 'main' || raw === '__main__') return '__main__';
    return raw;
}

function parseNumberValue(value, fallback) {
    const n = parseInt(value);
    return isNaN(n) ? fallback : n;
}

function parseBooleanFlag(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true' || lower === '1') return true;
        if (lower === 'false' || lower === '0') return false;
    }
    return fallback;
}

function getClientAddress(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0';
}

function extractBearerToken(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

function getAuthConfigState() {
    const cfg = require('./config');
    const adminPassReady = typeof cfg.ADMIN_PASS === 'string' && cfg.ADMIN_PASS.trim().length > 0;
    const jwtSecretReady = typeof cfg.JWT_SECRET === 'string' && cfg.JWT_SECRET.trim().length > 0;

    return {
        ready: adminPassReady && jwtSecretReady,
        message: !adminPassReady
            ? 'ADMIN_PASS is missing. Configure a dashboard password before signing in.'
            : !jwtSecretReady
                ? 'JWT_SECRET is missing. Configure it before using admin sessions.'
                : null,
    };
}

function getSettingsPayload() {
    const cfg = require('./config');
    const validation = validateConfig(cfg);

    return {
        botName: runtimeSettings.getBotName(),
        prefix: runtimeSettings.getPrefix(),
        ownerNumber: cfg.OWNER_NUMBER,
        autoRead: runtimeSettings.getAutoRead(),
        autoTyping: runtimeSettings.getAutoTyping(),
        nsfwEnabled: runtimeSettings.getNsfwEnabled(),
        workMode: runtimeSettings.getWorkMode(),
        autoViewStatus: runtimeSettings.getAutoViewStatus(),
        autoReactStatus: runtimeSettings.getAutoReactStatus(),
        aiAutoReply: appState.getAiAutoReply(),
        aiAutoVoice: appState.getAiAutoVoice(),
        aiAutoPersona: appState.getAiAutoPersona(),
        aiAutoLang: appState.getAiAutoLang(),
        aiGroupMode: appState.getAiGroupMode(),
        aiSystemInstruction: appState.getAiSystemInstruction(),
        aiMaxWords: appState.getAiMaxWords(),
        premiumCode: cfg.PREMIUM_CODE,
        warnings: validation.warnings,
        runMode: validation.mode.explicitMode,
        secureByDefault: validation.mode.isProductionLike,
        envLoaded: process.env.CHMD_ENV_PRELOADED === 'true',
        envSource: process.env.CHMD_ENV_SOURCE || null,
    };
}

function getMainSessionPayload() {
    const mainStatus = appState.getStatus();
    const ov = db.getSetting('main_bot_settings') || {};
    const config = require('./config');
    return {
        id: '__main__',
        label: 'Main Bot',
        number: appState.getNumber() || null,
        pushName: appState.getPushName() || null,
        name: ov.name || runtimeSettings.getBotName(),
        prefix: ov.prefix || runtimeSettings.getPrefix(),
        status: mainStatus,
        isMain: true,
        startedAt: appState.getConnectedAt() || null,
        qrAvailable: !!appState.getMainQr() && mainStatus !== 'Connected',
        pairCode: mainStatus !== 'Connected' ? (appState.getMainPairCode() || null) : null,
        pairCodeExpiresAt: mainStatus !== 'Connected' ? (appState.getMainPairCodeExpiresAt() || null) : null,
        qrPaused: appState.isQrPaused(),
        workMode: ov.workMode || appState.getWorkMode(),
        autoStatus: ov.autoStatus !== undefined ? ov.autoStatus : appState.getAutoStatus(),
        botEnabled: ov.botEnabled !== undefined ? ov.botEnabled : appState.getBotEnabled(),
        disabledModules: ov.disabledModules || appState.getDisabledModules(),
        owner: ov.owner || appState.getOwner(),
        processedCount: appState.getProcessedCount(),
        commandsCount: appState.getCommandsCount(),
        autoRead: ov.autoRead !== undefined ? ov.autoRead : appState.getAutoRead(),
        autoTyping: ov.autoTyping !== undefined ? ov.autoTyping : appState.getAutoTyping(),
        autoReactStatus: ov.autoReactStatus !== undefined ? ov.autoReactStatus : appState.getAutoReactStatus(),
        nsfwEnabled: ov.nsfwEnabled !== undefined ? ov.nsfwEnabled : appState.getNsfwEnabled(),
        autoReply: ov.autoReply !== undefined ? ov.autoReply : appState.getAutoReply(),
        aiAutoReply: ov.aiAutoReply !== undefined ? ov.aiAutoReply : appState.getAiAutoReply(),
        aiAutoVoice: ov.aiAutoVoice !== undefined ? ov.aiAutoVoice : appState.getAiAutoVoice(),
        aiAutoPersona: ov.aiAutoPersona || appState.getAiAutoPersona(),
        aiAutoLang: ov.aiAutoLang || appState.getAiAutoLang(),
        aiGroupMode: ov.aiGroupMode || appState.getAiGroupMode(),
        aiSystemInstruction: ov.aiSystemInstruction || appState.getAiSystemInstruction(),
        aiMaxWords: ov.aiMaxWords || appState.getAiMaxWords(),
        alwaysOnline: ov.alwaysOnline || false,
        antiCall: ov.antiCall || false,
        antiDelete: ov.antiDelete || false,
        autoBio: ov.autoBio || false,
        alwaysRecording: ov.alwaysRecording || false,
        autoViewStatus: ov.autoViewStatus !== undefined ? !!ov.autoViewStatus : runtimeSettings.getAutoViewStatus(),
        antiViewOnce: ov.antiViewOnce || false,
        antiGroupJoin: ov.antiGroupJoin || false,
        mentionReply: ov.mentionReply || '',
        aiKeysStatus: {
            gemini: !!(config.GEMINI_API_KEY && config.GEMINI_API_KEY.trim()),
            openrouter: !!(config.OPENROUTER_API_KEY && config.OPENROUTER_API_KEY.trim()),
            groq: !!(config.GROQ_API_KEY && config.GROQ_API_KEY.trim()),
        }
    };
}

function loadCommandCatalog() {
    const commandsDir = path.join(__dirname, 'lib', 'commands');
    const files = fs.readdirSync(commandsDir).filter((file) => file.endsWith('.js'));
    const overrides = db.getCommandSettings();
    const seen = new Set();
    const list = [];

    files.forEach((file) => {
        try {
            const commandModule = require(path.join(commandsDir, file));
            const commands = Array.isArray(commandModule) ? commandModule : [commandModule];
            const fallbackCategory = file === 'menu.js' ? 'system' : file.replace('.js', '');

            commands.forEach((cmd) => {
                if (!cmd?.name || seen.has(cmd.name)) return;
                seen.add(cmd.name);
                const commandOverride = overrides[cmd.name] || {};
                list.push({
                    name: cmd.name,
                    aliases: cmd.aliases || [],
                    description: cmd.description || '',
                    category: (cmd.category || fallbackCategory).toLowerCase(),
                    enabled: commandOverride.enabled !== undefined ? commandOverride.enabled : true,
                    cooldown: cmd.cooldown || 0,
                    pmOnly: cmd.pmOnly || false,
                    groupOnly: cmd.groupOnly || false,
                    premiumOnly: cmd.premiumOnly || false,
                    ownerOnly: cmd.ownerOnly || false,
                    usageCount: commandOverride.usageCount || 0,
                });
            });
        } catch {}
    });

    return list;
}

function pruneLoginAttempts(now = Date.now()) {
    for (const [key, entry] of loginAttempts.entries()) {
        const attempts = (entry.attempts || []).filter((stamp) => now - stamp <= LOGIN_WINDOW_MS);
        const blockedUntil = Number(entry.blockedUntil || 0);

        if (!attempts.length && blockedUntil <= now) {
            loginAttempts.delete(key);
            continue;
        }

        entry.attempts = attempts;
        if (blockedUntil <= now) {
            entry.blockedUntil = 0;
        }
        loginAttempts.set(key, entry);
    }
}

function getLoginAttemptKey(req) {
    const username = String(req.body?.username || '').trim().toLowerCase();
    return `${getClientAddress(req)}:${username}`;
}

function getLoginRateLimitState(key, now = Date.now()) {
    pruneLoginAttempts(now);
    const entry = loginAttempts.get(key) || { attempts: [], blockedUntil: 0 };
    return {
        key,
        attempts: entry.attempts.slice(),
        blockedUntil: Number(entry.blockedUntil || 0),
        isBlocked: Number(entry.blockedUntil || 0) > now,
    };
}

function recordLoginFailure(key, now = Date.now()) {
    const state = getLoginRateLimitState(key, now);
    const attempts = state.attempts.filter((stamp) => now - stamp <= LOGIN_WINDOW_MS);
    attempts.push(now);

    const nextState = {
        attempts,
        blockedUntil: attempts.length >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_COOLDOWN_MS : state.blockedUntil,
    };

    loginAttempts.set(key, nextState);
    return {
        ...nextState,
        isBlocked: nextState.blockedUntil > now,
    };
}

function clearLoginFailures(key) {
    loginAttempts.delete(key);
}

function logAuthEvent(event, payload = {}) {
    logger(`[Auth] ${JSON.stringify({ event, ...payload })}`);
}

function sendInvalidCredentials(res, options = {}) {
    const retryAfterMs = Number(options.retryAfterMs || 0);
    const statusCode = retryAfterMs > 0 ? 429 : 401;
    const body = { error: 'Invalid credentials' };

    if (retryAfterMs > 0) {
        const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        res.setHeader('Retry-After', String(seconds));
        body.retryAfterSeconds = seconds;
    }

    return res.status(statusCode).json(body);
}

function getSocketForSession(sessionId) {
    if (!sessionId || sessionId === 'main' || sessionId === '__main__') {
        return {
            sessionId: '__main__',
            label: 'Main Bot',
            sock: appState.getSocket(),
        };
    }

    try {
        const sessionMgr = require('./session-manager');
        const session = sessionMgr.get(sessionId);
        return {
            sessionId,
            label: session?.label || sessionId,
            sock: session?.sock || null,
        };
    } catch {
        return {
            sessionId,
            label: sessionId,
            sock: null,
        };
    }
}

function resolveTargets(targetType = 'all', rawTargets = []) {
    if (targetType === 'groups') {
        return [...new Set(db.listGroups().map((group) => group.jid).filter(Boolean))];
    }

    if (targetType === 'custom') {
        return [...new Set((Array.isArray(rawTargets) ? rawTargets : [])
            .map((value) => normalizeTarget(value, String(value || '').includes('@g.us') ? '@g.us' : '@s.whatsapp.net'))
            .filter(Boolean))];
    }

    return [...new Set(db.listUsers().map((user) => user.jid).filter(Boolean))];
}

function findManagedUserByJid(jid) {
    const target = decodeURIComponent(String(jid || ''));
    return db.listUsers().find((item) => item.jid === target || item.realJid === target) || null;
}

function resolveMessageTargets(rawTargets) {
    if (!Array.isArray(rawTargets) || !rawTargets.length) {
        return db.listUsers().map((user) => user.jid);
    }

    return resolveTargets('custom', rawTargets);
}

// ── Network & CPU stats tracker ──────────────────────────────────────────────────
let netSpeedRx = 0, netSpeedTx = 0;
let netTotalRx = 0, netTotalTx = 0;
let currentCpuLoad = 0;
let lastRx = 0, lastTx = 0, lastTime = 0;

async function updateStats() {
    try {
        const net = await si.networkStats();
        if (net && net.length > 0) {
            let tr = 0, tt = 0;
            const now = Date.now();
            const elapsed = (now - lastTime) / 1000;

            // Use the primary/default interface if possible, or aggregate active ones
            const active = net.find(i => i.operstate === 'up' && i.iface !== 'lo') || net[0];
            if (active) {
                tr = active.rx_bytes || 0;
                tt = active.tx_bytes || 0;
            }

            if (lastTime > 0 && elapsed > 0) {
                netSpeedRx = Math.max(0, (tr - lastRx) / elapsed);
                netSpeedTx = Math.max(0, (tt - lastTx) / elapsed);
            }

            netTotalRx = tr;
            netTotalTx = tt;
            lastRx = tr;
            lastTx = tt;
            lastTime = now;
        }

        const load = await si.currentLoad();
        currentCpuLoad = load.currentLoad || 0;
    } catch (e) { console.error('Stats error:', e.message); }
}

// Initial update and periodic loop every 2 seconds
updateStats();
const statsTimer = setInterval(updateStats, 2000);
if (typeof statsTimer.unref === 'function') statsTimer.unref();

const io = new Server(server, { cors: { origin: false } });

function createPortInUseError(port) {
    const error = new Error(`Dashboard port ${port} is already in use by another process.`);
    error.code = 'EADDRINUSE';
    return error;
}

function isLocalPortInUse(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let settled = false;

        const finish = (result, error = null) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        };

        socket.setTimeout(700);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', (error) => {
            if (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH') {
                finish(false);
                return;
            }
            finish(false, error);
        });

        socket.connect(port, host);
    });
}

function markDashboardStarted() {
    setIO(io);
    if (!dashboardStarted) {
        schedulerRuntime.start();
        dashboardStarted = true;
    }
}

io.use((socket, next) => {
    const authState = getAuthConfigState();
    if (!authState.ready) {
        return next(new Error(authState.message || 'Dashboard authentication is not configured.'));
    }

    const token = extractBearerToken(
        socket.handshake?.auth?.token
        || socket.handshake?.headers?.authorization
        || socket.handshake?.query?.token
    );

    if (!token) {
        return next(new Error('Authentication required'));
    }

    try {
        socket.data.admin = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        next(new Error('Invalid or expired token'));
    }
});

const schedulerRuntime = createSchedulerRuntime({
    listScheduler: () => db.listScheduler(),
    updateSchedulerItem: (id, patch) => db.updateSchedulerItem(id, patch),
    resolveTargets,
    getSocketForSession,
    emitSchedulerUpdate: (item) => io.emit('scheduler:update', item),
    logger,
});

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self' https://cdn.socket.io https://fonts.googleapis.com https://fonts.gstatic.com",
        "script-src 'self' 'unsafe-inline' https://cdn.socket.io",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join('; '));
    next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    dotfiles: 'ignore',
    etag: false,
    maxAge: 0,
    setHeaders: (res, filePath) => {
        if (/\.(?:js|css|html)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    },
}));

/**
 * Robust API handler wrapper to prevent unhandled rejections and maintain dashboard stability.
 */
const apiHandler = (fn) => async (req, res, next) => {
    try {
        await fn(req, res, next);
    } catch (error) {
        logger(`[Dashboard API Error] ${req.method} ${req.url}: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'An internal system error occurred' });
        }
    }
};

// ── Page routes (one HTML file per path) ───────────────────────────────────
const PAGE_IDS = [
    'dashboard', 'sessions', 'users', 'groups', 'commands',
    'aiengine', 'broadcast', 'autoreply', 'scheduler', 'users_db',
    'files', 'settings', 'logs',
];

app.get('/', (req, res) => res.redirect('/dashboard'));

// Health check for Railway/Fly/Render/etc. (no auth, lightweight, always 200
// when the dashboard process is up). Cloud platforms poll this to decide
// whether to route traffic / restart the container.
app.get('/health', (req, res) => {
    res.status(200).json({
        ok: true,
        service: 'chathu-md-dashboard',
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
for (const id of PAGE_IDS) {
    app.get('/' + id, (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'pages', `${id}.html`));
    });
}

// ── JWT middleware ─────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    const authState = getAuthConfigState();
    if (!authState.ready) {
        return res.status(503).json({ error: authState.message || 'Admin authentication is not configured securely.' });
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.admin = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ── Auth ───────────────────────────────────────────────────────────────────
app.post('/bot-api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const now = Date.now();
    const key = getLoginAttemptKey(req);
    const rateState = getLoginRateLimitState(key, now);
    const authState = getAuthConfigState();

    if (!authState.ready) {
        logAuthEvent('login_blocked_unconfigured', {
            ip: getClientAddress(req),
            username: String(username || '').trim() || null,
        });
        return res.status(503).json({ error: authState.message || 'Admin authentication is not configured securely.' });
    }

    if (rateState.isBlocked) {
        const retryAfterMs = Math.max(0, rateState.blockedUntil - now);
        logAuthEvent('login_blocked', {
            ip: getClientAddress(req),
            username: String(username || '').trim() || null,
            attempts: rateState.attempts.length,
            retryAfterMs,
        });
        return sendInvalidCredentials(res, { retryAfterMs });
    }

    if (username === ADMIN_USER && password === ADMIN_PASS) {
        clearLoginFailures(key);
        const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '24h' });
        return res.json({ token, username });
    }

    const failureState = recordLoginFailure(key, now);
    logAuthEvent(failureState.isBlocked ? 'login_cooldown' : 'login_failed', {
        ip: getClientAddress(req),
        username: String(username || '').trim() || null,
        attempts: failureState.attempts.length,
        blockedUntil: failureState.blockedUntil || null,
    });
    return sendInvalidCredentials(res, {
        retryAfterMs: failureState.isBlocked ? Math.max(0, failureState.blockedUntil - now) : 0,
    });
});

// ── Stats ──────────────────────────────────────────────────────────────────
app.get('/bot-api/stats', authMiddleware, (req, res) => {
    const memTotal = os.totalmem();
    const memFree  = os.freemem();
    const memUsed  = memTotal - memFree;
    const cpuLoad  = currentCpuLoad;

    let fileCount = 0, fileSize = 0;
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR);
        fileCount = files.length;
        files.forEach(f => {
            try { fileSize += fs.statSync(path.join(DOWNLOAD_DIR, f)).size; } catch {}
        });
    } catch {}

    let userCount = 0;
    try {
        userCount = Object.keys(db.getAll('users') || {}).length;
    } catch {}

    let currentStatus = appState.getStatus();
    let currentNumber = appState.getNumber();
    try {
        const sm = require('./session-manager');
        const cSession = sm.getAll().find(s => s.status === 'Connected');
        if (cSession && currentStatus !== 'Connected') {
            currentStatus = 'Connected';
            currentNumber = cSession.number;
        }
    } catch(e) {}

    function fmtBytes(b) {
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
        return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function fmtSpeed(bps) {
        if (bps < 1024) return bps + ' B/s';
        if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
        return (bps / 1024 / 1024).toFixed(2) + ' MB/s';
    }

    let sessionCount = 1; // main bot
    try {
        const sm = require('./session-manager');
        sessionCount += sm.getAll().length;
    } catch {}

    let broadcastCount = 0;
    try {
        broadcastCount = db.listBroadcastHistory().length;
    } catch {}

    res.json({
        status: currentStatus,
        number: currentNumber,
        connectedAt: appState.getConnectedAt(),
        uptime: Math.floor(process.uptime()),
        memUsed: Math.round(memUsed / 1024 / 1024),
        memTotal: Math.round(memTotal / 1024 / 1024),
        memPercent: Math.round((memUsed / memTotal) * 100),
        cpuLoad: cpuLoad.toFixed(2),
        platform: os.platform(),
        nodeVersion: process.version,
        userCount,
        sessionCount,
        broadcastCount,
        fileCount,
        fileSizeMB: (fileSize / 1024 / 1024).toFixed(1),
        net: {
            speedRx: fmtSpeed(netSpeedRx),
            speedTx: fmtSpeed(netSpeedTx),
            speedRxRaw: netSpeedRx,
            speedTxRaw: netSpeedTx,
            totalRx: fmtBytes(netTotalRx),
            totalTx: fmtBytes(netTotalTx),
            totalRxRaw: netTotalRx,
            totalTxRaw: netTotalTx,
        },
    });
});

// ── Sessions (Main bot) ────────────────────────────────────────────────────
app.get('/bot-api/bot/session', authMiddleware, (req, res) => {
    const sock = appState.getSocket();
    res.json({
        id: '__main__',
        label: 'Main Bot',
        number: appState.getNumber() || null,
        status: appState.getStatus(),
        connectedAt: appState.getConnectedAt(),
        platform: sock?.authState?.creds?.platform || 'whatsapp',
        isMain: true,
    });
});

app.post('/bot-api/sessions/__main__/paircode', authMiddleware, async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const normalized = normalizeSriLankanPhoneNumber(phone);
    if (!normalized.ok) {
        return res.status(400).json({ error: normalized.error });
    }

    if (appState.getStatus() === 'Connected') return res.status(400).json({ error: 'Already connected' });

    const { startBot, stopBot } = require('./bot');
    try {
        appState.resetQrAttempts();
        appState.setQrPaused(false);
        await stopBot({ status: 'Disconnected' });
        // Only wipe credentials if no registered device exists yet.
        // Repeated pair-code clicks on a partially registered session
        // used to nuke creds every time, forcing the user to start over.
        const credsPath = path.join(config.SESSION_DIR, 'creds.json');
        let alreadyRegistered = false;
        try {
            if (fs.existsSync(credsPath)) {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                alreadyRegistered = !!creds?.registered;
            }
        } catch {}
        await startBot({ forceRestart: true, clearCredentials: !alreadyRegistered, pairMode: true, phoneNumber: normalized.phone });

        let code = null;
        const timeoutAt = Date.now() + 12000;
        while (Date.now() < timeoutAt) {
            code = appState.getMainPairCode();
            if (code) break;
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        if (!code) {
            return res.status(504).json({ error: 'Pair code is still being prepared. Please wait a moment and try again.' });
        }

        res.json({ ok: true, code, expiresAt: appState.getMainPairCodeExpiresAt() || null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reconnect main bot (after QR pause)
app.post('/bot-api/bot/reconnect', authMiddleware, async (req, res) => {
    const { startBot, stopBot } = require('./bot');
    appState.resetQrAttempts();
    appState.setQrPaused(false);
    await stopBot({ status: 'Disconnected' });
    setTimeout(() => startBot({ forceRestart: true }).catch(() => {}), 500);
    res.json({ ok: true });
});

// Reconnect a multi-session (after QR pause)
app.post('/bot-api/sessions/:id/reconnect', authMiddleware, async (req, res) => {
    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.reconnectSession(req.params.id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.post('/bot-api/bot/session/logout', authMiddleware, async (req, res) => {
    const sock = appState.getSocket();
    if (!sock) return res.status(400).json({ error: 'No active main session' });
    try {
        const { stopBot } = require('./bot');
        await stopBot({ logout: true, clearCredentials: true, status: 'Logged Out' });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Multi-Session Manager API ──────────────────────────────────────────────
app.get('/bot-api/sessions', authMiddleware, (req, res) => {
    const sessionMgr = require('./session-manager');
    const multiSessions = sessionMgr.getAll();
    res.json([getMainSessionPayload(), ...multiSessions]);
});

app.post('/bot-api/sessions/:id/settings', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { workMode, autoStatus, botEnabled, disabledModules, owner, autoRead, autoTyping, autoReactStatus, nsfwEnabled } = req.body || {};
    
    if (id === '__main__') {
        try {
            let settingsChanged = false;
            if (workMode !== undefined) {
                const normalizedMode = String(workMode).toLowerCase();
                if (['public', 'private', 'self'].includes(normalizedMode)) {
                    appState.setWorkMode(normalizedMode);
                    settingsChanged = true;
                }
            }
            if (autoStatus !== undefined) {
                appState.setAutoStatus(autoStatus);
            }
            if (botEnabled !== undefined) {
                appState.setBotEnabled(botEnabled);
            }
            if (disabledModules !== undefined) {
                const mods = Array.isArray(disabledModules) ? disabledModules.map(m => String(m).toLowerCase()).filter(Boolean) : [];
                appState.setDisabledModules(mods);
            }
            if (owner !== undefined) {
                const normOwner = normalizeOwner(owner);
                appState.setOwner(normOwner);
            }
            const overrides = db.getSetting('main_bot_settings') || {};
            
            if (autoRead !== undefined) overrides.autoRead = autoRead;
            if (autoTyping !== undefined) overrides.autoTyping = autoTyping;
            if (autoReactStatus !== undefined) overrides.autoReactStatus = autoReactStatus;
            if (nsfwEnabled !== undefined) overrides.nsfwEnabled = nsfwEnabled;
            if (req.body.autoReply !== undefined) overrides.autoReply = req.body.autoReply;
            if (req.body.name !== undefined) overrides.name = String(req.body.name).trim();
            if (req.body.prefix !== undefined) overrides.prefix = String(req.body.prefix).trim().slice(0, 3);
            if (req.body.aiAutoReply !== undefined) overrides.aiAutoReply = !!req.body.aiAutoReply;
            if (req.body.aiAutoVoice !== undefined) overrides.aiAutoVoice = !!req.body.aiAutoVoice;
            if (req.body.aiAutoPersona !== undefined) overrides.aiAutoPersona = String(req.body.aiAutoPersona);
            if (req.body.aiAutoLang !== undefined) overrides.aiAutoLang = String(req.body.aiAutoLang);
            if (req.body.aiGroupMode !== undefined) overrides.aiGroupMode = String(req.body.aiGroupMode);
            if (req.body.aiSystemInstruction !== undefined) overrides.aiSystemInstruction = String(req.body.aiSystemInstruction);
            if (req.body.aiMaxWords !== undefined) overrides.aiMaxWords = parseInt(req.body.aiMaxWords) || 30;
            if (req.body.mentionReply !== undefined) overrides.mentionReply = String(req.body.mentionReply);
            if (req.body.alwaysOnline !== undefined) overrides.alwaysOnline = !!req.body.alwaysOnline;
            if (req.body.antiCall !== undefined) overrides.antiCall = !!req.body.antiCall;
            if (req.body.antiDelete !== undefined) overrides.antiDelete = req.body.antiDelete;
            if (req.body.autoBio !== undefined) overrides.autoBio = !!req.body.autoBio;
            if (req.body.alwaysRecording !== undefined) overrides.alwaysRecording = !!req.body.alwaysRecording;
            if (req.body.autoViewStatus !== undefined) overrides.autoViewStatus = !!req.body.autoViewStatus;
            if (req.body.antiViewOnce !== undefined) overrides.antiViewOnce = !!req.body.antiViewOnce;
            if (req.body.antiGroupJoin !== undefined) overrides.antiGroupJoin = !!req.body.antiGroupJoin;

            db.setSetting('main_bot_settings', overrides);
            db.flush();
            const sock = appState.getSocket();
            if (sock && (
                req.body.alwaysOnline !== undefined ||
                req.body.alwaysRecording !== undefined ||
                req.body.autoBio !== undefined
            )) {
                const { refreshRuntimeFeatures } = require('./bot');
                refreshRuntimeFeatures('__main__');
            }
            
            const session = getMainSessionPayload();
            io.emit('session:update', session);
            return res.json({ ok: true, session });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.updateSessionSettings(id, req.body);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.post('/bot-api/bot/api-keys', authMiddleware, (req, res) => {
    const { gemini, openrouter, groq } = req.body || {};
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, '');
    let envContent = fs.readFileSync(envPath, 'utf8');
    
    // We require config dynamically to ensure we have the object reference
    const cfg = require('./config');

    const updates = {
        GEMINI_API_KEY: gemini,
        OPENROUTER_API_KEY: openrouter,
        GROQ_API_KEY: groq
    };

    let changed = false;
    for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
            const regex = new RegExp(`^${key}=.*`, 'm');
            const cleanValue = String(value).trim();
            if (envContent.match(regex)) {
                envContent = envContent.replace(regex, `${key}=${cleanValue}`);
            } else {
                envContent += `\n${key}=${cleanValue}`;
            }
            cfg[key] = cleanValue;
            process.env[key] = cleanValue;
            changed = true;
        }
    }

    if (changed) {
        fs.writeFileSync(envPath, envContent.trim() + '\n');
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'No keys provided' });
    }
});

app.delete('/bot-api/bot/ai-history', authMiddleware, (req, res) => {
    try {
        const handler = require('./lib/handler');
        if (handler.chatHistory && typeof handler.chatHistory.clear === 'function') {
            handler.chatHistory.clear();
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/bot-api/bot/check-ai-keys', authMiddleware, async (req, res) => {
    try {
        const ai = require('./lib/commands/ai');
        const results = await ai.validateKeys();
        res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aggregate operator-facing warnings — surfaced as a banner on the
// dashboard so problems (missing tools, dangerous toggles left on) are
// visible without having to dig through individual settings pages.
app.get('/bot-api/health/warnings', authMiddleware, (req, res) => {
    const warnings = [];
    try {
        const cfg = require('./config');
        const sessionMgr = require('./session-manager');
        const ytdlpMgr = require('./lib/ytdlp-manager');
        const dl = require('./lib/download-manager');

        // AI keys
        const aiKeys = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'];
        const haveAi = aiKeys.some((k) => (process.env[k] || cfg[k] || '').trim());
        if (!haveAi) {
            warnings.push({
                level: 'warn',
                code: 'ai-keys-missing',
                message: 'No AI provider key configured (GEMINI/OPENAI/GROQ/OPENROUTER). AI commands will fail.',
            });
        }

        // ffmpeg
        if (!ytdlpMgr.FFMPEG_PATH) {
            warnings.push({
                level: 'warn',
                code: 'ffmpeg-missing',
                message: 'ffmpeg not detected. Audio extraction and video re-encoding will be unavailable.',
            });
        }

        // yt-dlp binary
        try {
            const fsLocal = require('fs');
            const binPath = ytdlpMgr.getBinPath ? ytdlpMgr.getBinPath() : null;
            if (!binPath || !fsLocal.existsSync(binPath)) {
                warnings.push({
                    level: 'warn',
                    code: 'yt-dlp-missing',
                    message: 'yt-dlp binary not found. .play / .download commands will fail until installed.',
                });
            }
        } catch {}

        // Public fallback ON
        if (cfg.AI_PUBLIC_FALLBACK) {
            warnings.push({
                level: 'warn',
                code: 'ai-public-fallback-on',
                message: 'AI_PUBLIC_FALLBACK is ON — user prompts may be sent to third-party public AI APIs.',
            });
        }

        // NSFW ON
        if (cfg.NSFW_ENABLED) {
            warnings.push({
                level: 'info',
                code: 'nsfw-on',
                message: 'NSFW commands are enabled (NSFW_ENABLED=true). Adult Zone is visible in .menu.',
            });
        }

        // Privacy-sensitive features active on any session
        try {
            const list = (sessionMgr.getAll && sessionMgr.getAll()) || [];
            const flagged = [];
            for (const s of list) {
                if (s.antiDelete) flagged.push(`${s.id || s.label}: anti-delete`);
                if (s.antiViewOnce) flagged.push(`${s.id || s.label}: anti-view-once`);
                if (s.alwaysOnline) flagged.push(`${s.id || s.label}: always-online`);
                if (s.autoBio) flagged.push(`${s.id || s.label}: auto-bio`);
            }
            if (flagged.length) {
                warnings.push({
                    level: 'info',
                    code: 'privacy-features-on',
                    message: `Privacy-sensitive features enabled (${flagged.length}): ${flagged.slice(0, 6).join(', ')}${flagged.length > 6 ? '…' : ''}.`,
                });
            }
        } catch {}

        // Default credentials still in use (development only — production
        // refuses to boot, see config.js)
        if (!cfg.IS_PRODUCTION && process.env.ADMIN_PASS === undefined) {
            warnings.push({
                level: 'info',
                code: 'dev-default-creds',
                message: 'Running with the development default ADMIN_PASS. Set ADMIN_PASS before deploying to production.',
            });
        }

        // DATA_DIR not set
        if (!process.env.DATA_DIR) {
            warnings.push({
                level: 'info',
                code: 'data-dir-unset',
                message: 'DATA_DIR is not set. WhatsApp sessions and db.json may be lost on container restart.',
            });
        }

        // Download stats (informational)
        try {
            const stats = dl.getDownloadStats ? dl.getDownloadStats() : null;
            if (stats) {
                res.set('X-Download-Active', String(stats.active));
                res.set('X-Download-Queue', String(stats.queued));
            }
        } catch {}
    } catch (e) {
        warnings.push({ level: 'error', code: 'warnings-error', message: `Warning collection failed: ${e.message}` });
    }
    res.json({ warnings });
});

app.post('/bot-api/sessions', authMiddleware, async (req, res) => {
    const { id, pairMode, phone } = req.body || {};
    let normalizedPhone = null;
    if (!id || !/^[a-zA-Z0-9_-]{2,30}$/.test(id)) {
        return res.status(400).json({ error: 'Invalid session ID. Use 2-30 characters (A-Z, 0-9, _, -) and no spaces.' });
    }
    if (pairMode && phone) {
        const normalized = normalizeSriLankanPhoneNumber(phone);
        if (!normalized.ok) return res.status(400).json({ error: normalized.error });
        normalizedPhone = normalized.phone;
    }
    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.createSession(id, { pairMode: !!pairMode, phone: normalizedPhone || phone || '' });
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.get('/bot-api/commands/categories', authMiddleware, apiHandler((req, res) => {
    const { getCategories } = require('./lib/handler');
    res.json(getCategories());
}));

app.delete('/bot-api/sessions/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    if (id === '__main__') {
        try {
            const { stopBot } = require('./bot');
            await stopBot({ logout: true, clearCredentials: true, status: 'Idle (Removed)' });
            const session = getMainSessionPayload();
            io.emit('session:update', session);
            return res.json({ ok: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.removeSession(id);
    res.json(result);
});

app.post('/bot-api/sessions/:id/paircode', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    if (id === '__main__') {
        try {
            const { startBot } = require('./bot');
            const appState = require('./state');
            // If already connected, can't pair
            if (appState.getStatus() === 'Connected') return res.status(400).json({ error: 'Main bot is already connected' });
            
            // Re-initialize main bot in pair mode
            await startBot({ forceRestart: true, pairMode: true, phoneNumber: phone });
            res.json({ ok: true, message: 'Main bot pairing initiated. Wait for code.' });
        } catch (e) { res.status(500).json({ error: e.message }); }
        return;
    }

    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.requestPairCode(id, phone);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.get('/bot-api/sessions/:id/qr', authMiddleware, (req, res) => {
    const { id } = req.params;
    if (id === '__main__') {
        if (appState.getStatus() === 'Connected') return res.status(400).json({ error: 'Bot is already linked! (Connected)' });
        const qr = appState.getMainQr();
        if (!qr) return res.status(404).json({ error: 'QR not ready yet. Please wait or refresh.' });
        return res.json({ qrCode: qr });
    }
    const sessionMgr = require('./session-manager');
    const entry = sessionMgr.get(id);
    if (!entry) return res.status(404).json({ error: 'Session not found' });
    if (!entry.qrDataUrl) return res.status(404).json({ error: 'No QR available' });
    res.json({ qrCode: entry.qrDataUrl });
});

app.post('/bot-api/sessions/:id/disconnect', authMiddleware, async (req, res) => {
    const { id } = req.params;
    if (id === '__main__') {
        const sock = appState.getSocket();
        if (!sock) return res.status(400).json({ error: 'Main bot not connected' });
        try {
            const { stopBot } = require('./bot');
            await stopBot({ logout: true, clearCredentials: true, status: 'Logged Out' });
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
        return;
    }
    const sessionMgr = require('./session-manager');
    const result = await sessionMgr.disconnectSession(id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
});

app.post('/bot-api/sessions/:id/settings', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};
    try {
        if (id === '__main__') {
            const current = db.getSetting('main_bot_settings') || {};
            const next = { ...current, ...body };
            db.setSetting('main_bot_settings', next);
            db.flush();
            const session = getMainSessionPayload();
            io.emit('session:update', session);
            return res.json({ ok: true, session });
        }
        const sessionMgr = require('./session-manager');
        const result = await sessionMgr.updateSessionSettings(id, body);
        if (result.error) return res.status(400).json(result);
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Broadcast ──────────────────────────────────────────────────────────────
app.post('/bot-api/broadcast', authMiddleware, async (req, res) => {
    const { message, targets, sessionId } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Message is required' });
    const session = getSocketForSession(sessionId);
    if (!session.sock) return res.status(400).json({ error: `${session.label} is not connected` });

    const jids = Array.isArray(targets) && targets.length
        ? resolveTargets('custom', targets)
        : resolveTargets('all');

    const results = { sent: 0, failed: 0, total: jids.length, errors: [] };
    // Jittered delay (1.0s..2.5s) between sends so broadcasts don't
    // produce a perfectly regular machine-gun cadence that anti-spam
    // systems flag immediately. Cap at 50 targets per request.
    for (const jid of jids.slice(0, 50)) {
        try {
            await session.sock.sendMessage(jid, { text: message });
            results.sent++;
            await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1500)));
        } catch (e) {
            results.failed++;
            results.errors.push({ jid, error: e.message });
        }
    }

    db.addBroadcastHistory({
        id: Date.now().toString(),
        message: message.substring(0, 200),
        targets: (targets || []).slice(0, 5),
        sessionId: session.sessionId,
        sent: results.sent,
        failed: results.failed,
        total: results.total,
        sentAt: new Date().toISOString(),
        status: results.failed === 0 ? 'success' : results.sent === 0 ? 'failed' : 'partial',
    });

    res.json(results);
});

app.get('/bot-api/broadcast/history', authMiddleware, (req, res) => {
    res.json(db.listBroadcastHistory());
});

// ── Bot Control ────────────────────────────────────────────────────────────
app.post('/bot-api/restart', authMiddleware, (req, res) => {
    appState.requestRestart();
    res.json({ ok: true, message: 'Restarting bot...' });
    setTimeout(() => {
        if (appState.isRestartRequested()) {
            appState.clearRestart();
            const { startBot } = require('./bot');
            startBot({ forceRestart: true }).catch(console.error);
        }
    }, 2000);
});

// ── Settings ───────────────────────────────────────────────────────────────
app.get('/bot-api/settings', authMiddleware, (req, res) => {
    res.json(getSettingsPayload());
});

app.post('/bot-api/settings', authMiddleware, (req, res) => {
    const { 
        botName, prefix, autoRead, autoTyping, nsfwEnabled, workMode, autoViewStatus, autoReactStatus,
        aiAutoReply, aiAutoPersona, aiAutoLang, aiAutoVoice, aiGroupMode, aiSystemInstruction, aiMaxWords
    } = req.body || {};
    try {
        if (botName !== undefined) db.setSetting('botName', String(botName).trim());
        if (prefix !== undefined) {
            const normalizedPrefix = String(prefix).trim() || '.';
            db.setSetting('prefix', normalizedPrefix.slice(0, 3));
        }
        if (autoRead !== undefined) db.setSetting('autoRead', !!autoRead);
        if (autoTyping !== undefined) db.setSetting('autoTyping', !!autoTyping);
        if (nsfwEnabled !== undefined) db.setSetting('nsfwEnabled', !!nsfwEnabled);
        if (workMode !== undefined) {
            const normalizedWorkMode = ['public', 'private', 'self'].includes(String(workMode).toLowerCase())
                ? String(workMode).toLowerCase()
                : 'public';
            db.setSetting('work_mode', normalizedWorkMode);
        }
        if (autoViewStatus !== undefined) db.setSetting('auto_view_status', !!autoViewStatus);
        if (autoReactStatus !== undefined) db.setSetting('auto_react_status', !!autoReactStatus);
        
        // AI Settings - Aligning with canonical camelCase fields
        if (aiAutoReply !== undefined) appState.setAiAutoReply(!!aiAutoReply);
        if (aiAutoPersona !== undefined) appState.setAiAutoPersona(String(aiAutoPersona));
        if (aiAutoLang !== undefined) appState.setAiAutoLang(String(aiAutoLang));
        if (aiAutoVoice !== undefined) appState.setAiAutoVoice(!!aiAutoVoice);
        if (aiGroupMode !== undefined) appState.setAiGroupMode(String(aiGroupMode));
        if (aiSystemInstruction !== undefined) appState.setAiSystemInstruction(String(aiSystemInstruction));
        if (aiMaxWords !== undefined) appState.setAiMaxWords(Number(aiMaxWords) || 30);

        db.flush();
        const payload = getSettingsPayload();
        io.emit('settings:update', payload);
        res.json({ ok: true, settings: payload });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});




// ── File Manager ───────────────────────────────────────────────────────────
app.get('/bot-api/files', authMiddleware, (req, res) => {
    try {
        const files = fs.readdirSync(DOWNLOAD_DIR).map(name => {
            const fPath = path.join(DOWNLOAD_DIR, name);
            try {
                const stat = fs.statSync(fPath);
                return {
                    name,
                    sizeMB: (stat.size / 1024 / 1024).toFixed(2),
                    modified: stat.mtime.toISOString(),
                    ext: path.extname(name).slice(1).toLowerCase() || 'file',
                };
            } catch { return null; }
        }).filter(Boolean).sort((a, b) => new Date(b.modified) - new Date(a.modified));
        res.json(files);
    } catch (e) { res.status(500).json({ error: e.message || 'Unable to read files' }); }
});

app.delete('/bot-api/files/:name', authMiddleware, (req, res) => {
    const name = path.basename(req.params.name);
    const fPath = path.join(DOWNLOAD_DIR, name);
    if (!fs.existsSync(fPath)) return res.status(404).json({ error: 'File not found' });
    try {
        fs.unlinkSync(fPath);
        res.json({ ok: true, name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Commands List ──────────────────────────────────────────────────────────
app.get('/bot-api/commands', authMiddleware, (req, res) => {
    try {
        res.json(loadCommandCatalog());
    } catch (e) { res.json([]); }
});

app.patch('/bot-api/commands/:name', authMiddleware, (req, res) => {
    const name = decodeURIComponent(req.params.name || '');
    const { enabled } = req.body || {};
    try {
        if (enabled !== undefined) {
            const nextEnabled = enabled === true || enabled === 'true' || enabled === 1 || enabled === '1';
            db.setCommandEnabled(name, nextEnabled);
            const catalog = loadCommandCatalog();
            const command = catalog.find(c => c.name === name);
            return res.json({ ok: true, command });
        }
        res.json({ ok: true, name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/commands/toggle-all', authMiddleware, (req, res) => {
    const { enabled, category } = req.body || {};
    try {
        const nextEnabled = enabled === true || enabled === 'true' || enabled === 1 || enabled === '1';
        const catalog = loadCommandCatalog();
        const updated = [];
        catalog.forEach((command) => {
            if (category && command.category !== category) return;
            db.setCommandEnabled(command.name, nextEnabled);
            command.enabled = nextEnabled;
            updated.push(command);
        });
        res.json({ ok: true, updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Groups Management ──────────────────────────────────────────────────────
app.get('/bot-api/groups', authMiddleware, (req, res) => {
    res.json(db.listGroups());
});

app.post('/bot-api/groups/upsert', authMiddleware, (req, res) => {
    const body = req.body || {};
    const jid = normalizeGroupJid(body.jid);
    if (!jid) return res.status(400).json({ error: 'Valid group JID required' });
    try {
        db.update('groups', jid, {
            name: String(body.name || '').trim() || jid.split('@')[0],
            sessionId: normalizeSessionId(body.sessionId),
            memberCount: parseNumberValue(body.memberCount, 0),
            isMuted: parseBooleanFlag(body.isMuted, false),
            antiLink: parseBooleanFlag(body.antiLink, false),
            antiSpam: parseBooleanFlag(body.antiSpam, false),
            welcome: parseBooleanFlag(body.welcome, false),
            welcomeEnabled: parseBooleanFlag(body.welcome, false),
            goodbye: parseBooleanFlag(body.goodbye, false),
            goodbyeEnabled: parseBooleanFlag(body.goodbye, false),
            nsfw: parseBooleanFlag(body.nsfw, false),
        });
        const group = db.listGroups().find((item) => item.jid === jid) || null;
        if (group) io.emit('group:update', group);
        res.json({ ok: true, group });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/bot-api/groups/:jid', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        const patch = { ...(req.body || {}) };
        if (Object.prototype.hasOwnProperty.call(patch, 'sessionId')) {
            patch.sessionId = normalizeSessionId(patch.sessionId);
        }
        db.update('groups', jid, patch);
        const group = db.listGroups().find((item) => item.jid === jid) || null;
        if (group) io.emit('group:update', group);
        res.json({ ok: true, group });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/bot-api/groups/:jid', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        db.delete('groups', jid);
        io.emit('group:removed', { jid });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Scheduler ──────────────────────────────────────────────────────────────
app.get('/bot-api/scheduler', authMiddleware, (req, res) => {
    const items = db.listScheduler().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    res.json(items);
});

app.post('/bot-api/scheduler', authMiddleware, (req, res) => {
    const { message, sessionId, targetType, targets, scheduledAt } = req.body || {};
    if (!message || !scheduledAt) return res.status(400).json({ error: 'message and scheduledAt required' });
    if (!['all', 'groups', 'custom'].includes(targetType || 'all')) {
        return res.status(400).json({ error: 'Invalid target type' });
    }
    try {
        const item = {
            id: Date.now().toString(),
            message,
            sessionId: normalizeSessionId(sessionId),
            targetType: targetType || 'all',
            targets: targets || [],
            scheduledAt,
            sent: false,
            sentAt: null,
            failed: false,
            failedAt: null,
            lastError: null,
            sentCount: 0,
            failedCount: 0,
            attemptedTargets: 0,
            createdAt: new Date().toISOString(),
        };
        const created = db.addSchedulerItem(item);
        io.emit('scheduler:update', created);
        res.json(created);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/bot-api/scheduler/:id', authMiddleware, (req, res) => {
    const current = db.listScheduler().find((item) => item.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Scheduled job not found' });
    if (current.sent) return res.status(400).json({ error: 'Sent jobs cannot be edited' });
    if (current.failed) return res.status(400).json({ error: 'Use retry for failed jobs' });

    const { message, sessionId, targetType, targets, scheduledAt } = req.body || {};
    if (targetType === 'custom' && (!Array.isArray(targets) || !targets.length)) {
        return res.status(400).json({ error: 'Custom targets required' });
    }
    if (targetType !== undefined && !['all', 'groups', 'custom'].includes(targetType || 'all')) {
        return res.status(400).json({ error: 'Invalid target type' });
    }
    if (scheduledAt !== undefined && !Number.isFinite(Date.parse(scheduledAt))) {
        return res.status(400).json({ error: 'Invalid scheduledAt value' });
    }

    try {
        const updated = db.updateSchedulerItem(req.params.id, {
            ...(message !== undefined ? { message: String(message).trim() } : {}),
            ...(sessionId !== undefined ? { sessionId: normalizeSessionId(sessionId) } : {}),
            ...(targetType !== undefined ? { targetType: targetType || 'all' } : {}),
            ...(targets !== undefined ? { targets: Array.isArray(targets) ? targets : [] } : {}),
            ...(scheduledAt !== undefined ? { scheduledAt } : {}),
        });
        if (updated) io.emit('scheduler:update', updated);
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/scheduler/:id/retry', authMiddleware, (req, res) => {
    const current = db.listScheduler().find((item) => item.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Scheduled job not found' });
    if (!current.failed) return res.status(400).json({ error: 'Only failed jobs can be retried' });

    const scheduledAt = req.body?.scheduledAt && Number.isFinite(Date.parse(req.body.scheduledAt))
        ? req.body.scheduledAt
        : new Date().toISOString();

    try {
        const updated = db.updateSchedulerItem(req.params.id, {
            sent: false,
            sentAt: null,
            failed: false,
            failedAt: null,
            lastError: null,
            sentCount: 0,
            failedCount: 0,
            attemptedTargets: 0,
            scheduledAt,
        });
        if (updated) io.emit('scheduler:update', updated);
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/bot-api/scheduler/:id', authMiddleware, (req, res) => {
    try {
        const ok = db.removeSchedulerItem(req.params.id);
        if (ok) io.emit('scheduler:removed', { id: req.params.id });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto-Reply ─────────────────────────────────────────────────────────────
app.get('/bot-api/auto-reply', authMiddleware, (req, res) => {
    res.json(db.listAutoReply());
});

app.post('/bot-api/auto-reply', authMiddleware, (req, res) => {
    const { trigger, response, matchType, caseSensitive, groupsOnly, pmOnly } = req.body || {};
    if (!trigger || !response) return res.status(400).json({ error: 'trigger and response required' });
    if (groupsOnly && pmOnly) return res.status(400).json({ error: 'Choose either groupsOnly or pmOnly, not both' });
    if (matchType === 'regex') {
        try {
            new RegExp(String(trigger), caseSensitive ? '' : 'i');
        } catch (e) {
            return res.status(400).json({ error: `Invalid regex: ${e.message}` });
        }
    }
    try {
        const rule = {
            id: Date.now().toString(),
            trigger: String(trigger).trim(),
            response: String(response).trim(),
            matchType: matchType || 'exact',
            caseSensitive: !!caseSensitive,
            groupsOnly: !!groupsOnly,
            pmOnly: !!pmOnly,
            enabled: true,
        };
        const created = db.addAutoReply(rule);
        io.emit('auto-reply:update', created);
        res.json(created);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/bot-api/auto-reply/:id', authMiddleware, (req, res) => {
    const patch = req.body || {};
    if (patch.trigger !== undefined && !String(patch.trigger).trim()) {
        return res.status(400).json({ error: 'trigger is required' });
    }
    if (patch.response !== undefined && !String(patch.response).trim()) {
        return res.status(400).json({ error: 'response is required' });
    }
    const current = db.listAutoReply().find((rule) => rule.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Rule not found' });
    const nextTrigger = patch.trigger !== undefined ? String(patch.trigger).trim() : undefined;
    const nextMatchType = patch.matchType !== undefined ? (patch.matchType || 'exact') : undefined;
    const nextCaseSensitive = patch.caseSensitive !== undefined ? !!patch.caseSensitive : undefined;
    const nextGroupsOnly = patch.groupsOnly !== undefined ? !!patch.groupsOnly : undefined;
    const nextPmOnly = patch.pmOnly !== undefined ? !!patch.pmOnly : undefined;
    const finalTrigger = nextTrigger !== undefined ? nextTrigger : String(current.trigger || '').trim();
    const finalMatchType = nextMatchType !== undefined ? nextMatchType : (current.matchType || 'exact');
    const finalCaseSensitive = nextCaseSensitive !== undefined ? nextCaseSensitive : !!current.caseSensitive;
    const finalGroupsOnly = nextGroupsOnly !== undefined ? nextGroupsOnly : !!current.groupsOnly;
    const finalPmOnly = nextPmOnly !== undefined ? nextPmOnly : !!current.pmOnly;
    if (finalGroupsOnly && finalPmOnly) {
        return res.status(400).json({ error: 'Choose either groupsOnly or pmOnly, not both' });
    }
    if (finalMatchType === 'regex') {
        try {
            new RegExp(finalTrigger, finalCaseSensitive ? '' : 'i');
        } catch (e) {
            return res.status(400).json({ error: `Invalid regex: ${e.message}` });
        }
    }
    try {
        const updated = db.updateAutoReply(req.params.id, {
            ...(patch.trigger !== undefined ? { trigger: nextTrigger } : {}),
            ...(patch.response !== undefined ? { response: String(patch.response).trim() } : {}),
            ...(patch.matchType !== undefined ? { matchType: nextMatchType } : {}),
            ...(patch.caseSensitive !== undefined ? { caseSensitive: nextCaseSensitive } : {}),
            ...(patch.groupsOnly !== undefined ? { groupsOnly: nextGroupsOnly } : {}),
            ...(patch.pmOnly !== undefined ? { pmOnly: nextPmOnly } : {}),
            ...(patch.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
        });
        io.emit('auto-reply:update', updated);
        res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/bot-api/auto-reply/:id', authMiddleware, (req, res) => {
    try {
        db.removeAutoReply(req.params.id);
        io.emit('auto-reply:removed', { id: req.params.id });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Users Management ───────────────────────────────────────────────────────
app.get('/bot-api/users', authMiddleware, (req, res) => {
    res.json(db.listUsers());
});

app.post('/bot-api/users/upsert', authMiddleware, (req, res) => {
    const body = req.body || {};
    const jid = normalizeUserJid(body.jid || body.number);
    if (!jid) return res.status(400).json({ error: 'Valid phone number or user JID required' });
    try {
        const current = db.get('users', jid) || {};
        db.upsertUser(jid, {
            number: String(body.number || jid.split('@')[0]).replace(/\D/g, ''),
            pushName: String(body.pushName || '').trim() || current.pushName || null,
            balance: parseNumberValue(body.balance, current.balance || 0),
            wins: parseNumberValue(body.wins, current.wins || 0),
            losses: parseNumberValue(body.losses, current.losses || 0),
            premium: parseBooleanFlag(body.premium, current.premium || false),
            banned: parseBooleanFlag(body.banned, current.banned || false),
            lastSeen: body.lastSeen || current.lastSeen || new Date().toISOString(),
            joinedAt: current.joinedAt || new Date().toISOString(),
        });
        const user = findManagedUserByJid(jid);
        if (user) io.emit('user:update', user);
        res.json({ ok: true, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/users/:jid/premium', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        const body = req.body || {};
        const current = db.get('users', jid) || {};
        const newValue = body.premium !== undefined ? parseBooleanFlag(body.premium, false) : !current.premium;
        db.setUserPremium(jid, newValue);
        const user = findManagedUserByJid(jid);
        if (user) io.emit('user:update', user);
        res.json({ ok: true, premium: newValue, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/users/:jid/owner', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        const verified = db.getSetting('verified_owners') || [];
        const normalizedJid = normalizeUserJid(jid) || jid;
        const identityKey = db.getManagedIdentityKey(normalizedJid);
        const index = verified.findIndex((entry) => db.getManagedIdentityKey(entry) === identityKey);
        const body = req.body || {};
        const newValue = body.isOwner !== undefined
            ? parseBooleanFlag(body.isOwner, false)
            : index === -1;
        if (newValue) {
            if (index === -1) verified.push(normalizedJid);
            const current = db.get('users', jid) || {};
            db.upsertUser(jid, {
                number: current.number || jid.split('@')[0],
                pushName: current.pushName || null,
                joinedAt: current.joinedAt || new Date().toISOString(),
                lastSeen: current.lastSeen || new Date().toISOString(),
            });
        } else if (index > -1) {
            verified.splice(index, 1);
        }
        db.setSetting('verified_owners', verified);
        const user = findManagedUserByJid(jid);
        if (user) io.emit('user:update', user);
        res.json({ ok: true, isOwner: newValue, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bot-api/users/:jid/ban', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        const body = req.body || {};
        const newValue = body.banned !== undefined ? parseBooleanFlag(body.banned, false) : !db.isUserBanned(jid);
        db.setUserBanned(jid, newValue);
        const user = findManagedUserByJid(jid);
        if (user) io.emit('user:update', user);
        res.json({ ok: true, banned: newValue, user });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/bot-api/users/:jid', authMiddleware, (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        db.deleteUser(jid);
        io.emit('user:removed', { jid });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── Stats & Data ──────────────────────────────────────────────────────────
// ── Logs ───────────────────────────────────────────────────────────────────
app.get('/bot-api/logs', authMiddleware, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    res.json(appState.getLogs().slice(-limit).reverse());
});
app.delete('/bot-api/logs', authMiddleware, (req, res) => {
    appState.getLogs().length = 0;
    res.json({ ok: true });
});

// ── WebSocket ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    logger('Dashboard client connected: ' + socket.id);
    socket.emit('update', {
        status: appState.getStatus(),
        number: appState.getNumber(),
    });
    appState.getLogs().slice(-30).forEach(l => socket.emit('log', l));
});

// ── Fallback ───────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
    if (req.path.startsWith('/bot-api/')) return res.status(404).json({ error: 'Not found' });
    res.redirect('/dashboard');
});

// ── Start ──────────────────────────────────────────────────────────────────
const HOST = process.env.HOST || '0.0.0.0';

function startDashboard() {
    server.listen(PORT, HOST, () => {
        markDashboardStarted();
        console.log(`🌐 Dashboard: http://${HOST}:${PORT}`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`❌ Port ${PORT} is already in use!`);
            console.log(`💡 Try running: "npx kill-port ${PORT}" or close the other bot window.`);
        } else {
            console.error('Server Error:', err);
        }
    });
}

async function startDashboardAsync() {
    if (server.listening) {
        markDashboardStarted();
        return Promise.resolve(server);
    }

    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('listening', onListening);
            if (err.code === 'EADDRINUSE') {
                console.error(`Dashboard port ${PORT} is already in use.`);
                console.log(`Try running: "npx kill-port ${PORT}" or close the other bot window.`);
            } else {
                console.error('Server Error:', err);
            }
            reject(err);
        };

        const onListening = () => {
            server.off('error', onError);
            markDashboardStarted();
            console.log(`Dashboard: http://${HOST}:${PORT}`);
            resolve(server);
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(PORT, HOST);
    });
}

module.exports = {
    startDashboard: startDashboardAsync,
    io,
    app,
    getSettingsPayload,
    getMainSessionPayload,
    __internals: {
        clearLoginFailures,
        getLoginRateLimitState,
        getSocketForSession,
        loginAttempts,
        recordLoginFailure,
        resolveTargets,
        resolveMessageTargets,
        sendInvalidCredentials,
    },
};
