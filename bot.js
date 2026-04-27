'use strict';

const fs = require('fs');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { logger } = require('./logger');
const { loadCommands, handleCommand } = require('./lib/handler');
const { findAutoReply } = require('./lib/automation-runtime');
const { normalizeSriLankanPhoneNumber } = require('./lib/phone-normalizer');
const { BROWSER, SESSION_DIR } = require('./config');
const appState = require('./state');
const db = require('./lib/db');
const { getPrefix, getAutoRead, getAutoTyping, getBotName, getAutoViewStatus, getAutoReactStatus } = require('./lib/runtime-settings');

const BAD_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy', 'whore', 'nigger'];
const messageStore = [];
const spamMap = new Map();

let activeSocket = null;
let reconnectTimer = null;
let startPromise = null;
let alwaysOnlineTimer = null;
let autoBioTimer = null;
let proFeaturesBound = false;

const AUTO_BIO_LINES = [
    '🤖 CHATHU MD Online — type !menu',
    '⚡ Powered by CHATHU MD',
    '🌐 24/7 Active — Multi-Device WhatsApp Bot',
    '🛡 Shield Protection Active',
    '✨ Auto-Reply Online',
];

function getMainBotSettings() {
    try { return db.getSetting('main_bot_settings') || {}; }
    catch { return {}; }
}

function resolveProFlag(key, fallback) {
    const ov = getMainBotSettings();
    if (ov[key] !== undefined && ov[key] !== null) return !!ov[key];
    if (typeof fallback === 'function') {
        try { return !!fallback(); } catch { return false; }
    }
    return !!fallback;
}

function resolveProValue(key, fallback) {
    const ov = getMainBotSettings();
    if (ov[key] !== undefined && ov[key] !== null) return ov[key];
    if (typeof fallback === 'function') {
        try { return fallback(); } catch { return null; }
    }
    return fallback;
}

function clearProTimers() {
    if (alwaysOnlineTimer) { clearInterval(alwaysOnlineTimer); alwaysOnlineTimer = null; }
    if (autoBioTimer) { clearInterval(autoBioTimer); autoBioTimer = null; }
    proFeaturesBound = false;
}

function bindProFeatureTimers(sock) {
    if (proFeaturesBound) return;
    proFeaturesBound = true;

    // Always Online: re-assert presence every 30s
    alwaysOnlineTimer = setInterval(async () => {
        if (sock !== activeSocket) return;
        try {
            const enabled = resolveProFlag('alwaysOnline', () => appState.getAlwaysOnline());
            if (!enabled) return;
            await sock.sendPresenceUpdate('available').catch(() => {});
        } catch {}
    }, 30 * 1000);

    // Auto-Bio: rotate WhatsApp profile status every 30 minutes
    let bioIdx = 0;
    autoBioTimer = setInterval(async () => {
        if (sock !== activeSocket) return;
        try {
            const enabled = resolveProFlag('autoBio', () => appState.getAutoBio());
            if (!enabled) return;
            const line = AUTO_BIO_LINES[bioIdx % AUTO_BIO_LINES.length];
            bioIdx += 1;
            await sock.updateProfileStatus(line).catch(() => {});
        } catch {}
    }, 30 * 60 * 1000);
}

async function handleAntiDelete(sock, key) {
    try {
        const ov = getMainBotSettings();
        const cfg = (ov && typeof ov.antiDelete === 'object' && ov.antiDelete)
            ? ov.antiDelete
            : appState.getAntiDelete();
        if (!cfg || cfg.enabled === false) return;

        const cached = key?.remoteJid && key?.id ? getCachedMsg(key.remoteJid, key.id) : null;
        if (!cached || !cached.message) return;

        // Don't replay our own deletions (avoid loops).
        if (cached.key?.fromMe) return;

        // Filters: text/image/video/audio/sticker/doc — opt-in (default ON if filters object missing).
        const filters = (cfg.filters && typeof cfg.filters === 'object') ? cfg.filters : null;
        const m = cached.message || {};
        const kind = m.imageMessage ? 'image'
            : m.videoMessage ? 'video'
            : m.audioMessage ? 'audio'
            : m.stickerMessage ? 'sticker'
            : m.documentMessage ? 'doc'
            : (m.conversation || m.extendedTextMessage) ? 'text'
            : 'text';
        if (filters && filters[kind] === false) return;

        const target = (cfg.target === 'owner') ? 'owner' : 'chat';
        let destJid = cached.key.remoteJid;
        if (target === 'owner') {
            const owner = ov.owner || appState.getOwner();
            if (owner) {
                const digits = String(owner).replace(/\D/g, '');
                if (digits) destJid = `${digits}@s.whatsapp.net`;
            }
        }

        const senderRaw = cached.key.participant || cached.key.remoteJid || '';
        const senderTag = senderRaw.split('@')[0] || 'unknown';
        const banner = `🛡 *Anti-Delete Recovery*\n👤 From: @${senderTag}\n🗑 Original chat: ${cached.key.remoteJid}\n⏱ ${new Date().toLocaleString()}`;

        // Send banner first.
        try {
            await sock.sendMessage(destJid, {
                text: banner,
                mentions: senderRaw && senderRaw.includes('@') ? [senderRaw] : []
            });
        } catch (e) {
            logger(`[AntiDelete] Banner send failed: ${e.message}`);
        }

        // Then forward the original message content.
        try {
            await sock.relayMessage(destJid, cached.message, { messageId: cached.key.id });
        } catch (eRelay) {
            // Fallback: re-send text payloads only.
            const txt = m.conversation || m.extendedTextMessage?.text || '';
            if (txt) {
                try { await sock.sendMessage(destJid, { text: `📝 ${txt}` }); } catch {}
            } else {
                logger(`[AntiDelete] Relay failed (${kind}): ${eRelay.message}`);
            }
        }

        logger(`[AntiDelete] Recovered ${kind} message ${cached.key.id} → ${target}`);
    } catch (e) {
        logger(`[AntiDelete] Recovery error: ${e.message}`);
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheMsg(msg) {
    messageStore.push(msg);
    if (messageStore.length > 100) messageStore.shift();
}

function getCachedMsg(jid, id) {
    return messageStore.find((msg) => msg.key.remoteJid === jid && msg.key.id === id);
}

function getIO() {
    try {
        return require('./dashboard').io;
    } catch {
        return null;
    }
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function resetMainState(status = 'Disconnected') {
    appState.setSocket(null);
    appState.setStatus(status);
    appState.setNumber(null);
    appState.setConnectedAt(null);
    appState.setMainQr(null);
    appState.setMainPairCode(null);
    appState.setMainPairCodeExpiresAt(null);
}

function clearMainPairState() {
    appState.setMainPairMode(false);
    appState.setMainPairPhone(null);
    appState.setMainPairCode(null);
    appState.setMainPairCodeExpiresAt(null);
}

function configureMainPairState(phoneNumber) {
    appState.setMainPairMode(Boolean(phoneNumber));
    appState.setMainPairPhone(phoneNumber || null);
    appState.setMainPairCode(null);
    appState.setMainPairCodeExpiresAt(null);
}

async function requestMainPairCode(sock) {
    const phoneNumber = appState.getMainPairPhone();
    if (!sock || !phoneNumber || !appState.isMainPairMode()) return null;

    // Wait for the socket to have the requestPairingCode method available
    let methodReady = false;
    const methodCheckTimeout = Date.now() + 5000;
    while (!methodReady && Date.now() < methodCheckTimeout) {
        if (typeof sock.requestPairingCode === 'function') {
            methodReady = true;
            break;
        }
        await delay(100);
    }

    // Check if requestPairingCode method exists
    if (typeof sock.requestPairingCode !== 'function') {
        logger('[Main Bot] requestPairingCode method not available on socket. Please wait and retry.');
        return null;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const normalized = normalizeSriLankanPhoneNumber(phoneNumber);
            if (!normalized.ok) {
                throw new Error(normalized.error);
            }

            const formattedPhone = normalized.phone;
            const code = await sock.requestPairingCode(formattedPhone);
            const expiresAt = Date.now() + 60000;
            appState.setMainPairCode(code);
            appState.setMainPairCodeExpiresAt(expiresAt);
            appState.setStatus('Awaiting Pair Code');

            const io = getIO();
            if (io) {
                io.emit('session:paircode', { id: '__main__', code, expiresAt });
                io.emit('update', { status: 'Awaiting Pair Code', pairCode: code, pairCodeExpiresAt: expiresAt });
            }
            logger(`[Main Bot] Pair code generated for ${formattedPhone}: ${code}`);
            return code;
        } catch (error) {
            lastError = error;
            logger(`[Main Bot] Pair code attempt ${attempt}/4 failed: ${error.message}`);
            if (attempt < 4) {
                await delay(1500);
            }
        }
    }

    throw lastError || new Error('Failed to generate main pair code');
}

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
}

async function clearMainSessionCredentials() {
    try {
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }
        ensureSessionDir();
    } catch (error) {
        logger(`Session Clear Error: ${error.message}`);
    }
}

async function stopBot(options = {}) {
    const {
        logout = false,
        clearCredentials = false,
        status = 'Disconnected'
    } = options;

    clearReconnectTimer();
    clearProTimers();
    const socket = activeSocket;
    activeSocket = null;

    if (socket) {
        try { socket.ev.removeAllListeners('connection.update'); } catch {}
        try { socket.ev.removeAllListeners('creds.update'); } catch {}
        try { socket.ev.removeAllListeners('messages.upsert'); } catch {}
        try { socket.ev.removeAllListeners('messages.update'); } catch {}
        try { socket.ev.removeAllListeners('call'); } catch {}
        try { socket.ev.removeAllListeners('group-participants.update'); } catch {}
        try { socket.ev.removeAllListeners('error'); } catch {}
        if (logout) {
            try { await socket.logout(); } catch {}
        }
        try { socket.end(undefined); } catch {}
    }

    resetMainState(status);
    appState.resetQrAttempts();
    appState.setQrPaused(false);

    if (clearCredentials) {
        await clearMainSessionCredentials();
        clearMainPairState();
    }
}

function scheduleReconnect(delayMs = 5000) {
    if (appState.isQrPaused()) return;
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startBot({ forceRestart: true }).catch((error) => {
            logger(`Reconnect Error: ${error.message}`);
        });
    }, delayMs);
}

async function syncGroups(sock, sessionId = '__main__') {
    try {
        if (!sock.groupFetchAllFull) return;
        const groups = await sock.groupFetchAllFull();
        Object.entries(groups).forEach(([jid, metadata]) => {
            db.update('groups', jid, {
                name: metadata.subject,
                memberCount: metadata.participants?.length || 0,
                sessionId: sessionId || '__main__'
            });
        });
        logger(`[${sessionId}] Synced ${Object.keys(groups).length} groups to Dashboard.`);
    } catch (error) {
        logger(`[${sessionId}] Group Sync Error: ${error.message}`);
    }
}

async function createSocket(options = {}) {
    ensureSessionDir();
    loadCommands();

    const pairPhone = options.pairMode && options.phoneNumber
        ? normalizeSriLankanPhoneNumber(options.phoneNumber).phone || null
        : null;
    configureMainPairState(pairPhone);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    logger(`Starting CHATHU MD (Baileys v${version.join('.')})`);
    appState.setStatus('Connecting');
    const io = getIO();
    if (io) io.emit('update', { status: 'Connecting' });

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: BROWSER,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        getMessage: async (key) => {
            const msg = getCachedMsg(key.remoteJid, key.id);
            return msg?.message || undefined;
        }
    });

    activeSocket = sock;
    appState.setSocket(sock);
    
    // Set start time immediately to ignore backlog messages processed before "open" state
    sock.startTime = Math.floor(Date.now() / 1000);

    sock.ev.on('connection.update', async (update) => {
        if (sock !== activeSocket) return;

        try {
            const { connection, lastDisconnect, qr } = update;
            const dashboardIO = getIO();

            if (qr) {
                if (appState.isMainPairMode()) {
                    logger('[Main Bot] QR received during pair mode; waiting for phone-number linking instead.');
                    return;
                }
                const attempts = appState.incQrAttempts();
                const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                appState.setMainQr(qrDataUrl);
                appState.setStatus('Awaiting QR Scan');
                if (dashboardIO) {
                    dashboardIO.emit('qr', qrDataUrl);
                    dashboardIO.emit('update', { status: 'Awaiting QR Scan' });
                }
                logger(`[Main Bot] QR generated (${attempts}/6). Scan with WhatsApp.`);

                if (attempts >= 6) {
                    logger('[Main Bot] QR pause: too many unscanned codes. Click "Reconnect" to retry.');
                    appState.setQrPaused(true);
                    await stopBot({ status: 'Idle (Paused)' });
                }
                return;
            }

            if (connection === 'open') {
                clearReconnectTimer();
                logger('[Main Bot] Connected.');
                sock.startTime = Math.floor(Date.now() / 1000); // Refresh start time on open
                appState.setStatus('Connected');
                appState.resetQrAttempts();
                appState.setQrPaused(false);
                appState.setConnectedAt(new Date().toISOString());
                appState.setMainQr(null);
                appState.setMainPairCode(null);
                appState.setMainPairCodeExpiresAt(null);
                appState.setMainPairMode(false);
                appState.setMainPairPhone(null);

                const number = sock.user?.id?.split(':')[0] || sock.user?.id || 'Unknown';
                appState.setNumber(number);
                appState.setPushName(sock.user?.name || null);

                if (dashboardIO) {
                    dashboardIO.emit('update', { status: 'Connected', number });
                }

                await syncGroups(sock, '__main__');
                bindProFeatureTimers(sock);
                return;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || 'Unknown';
                const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

                if (loggedOut) {
                    logger(`[Main Bot] Logged out (${statusCode}). Clearing session and waiting for relink.`);
                    await stopBot({ status: 'Logged Out', clearCredentials: true });
                    return;
                }

                if (statusCode === 440) {
                    logger('[Main Bot] Session replaced by another client.');
                    await stopBot({ status: 'Session Replaced' });
                    return;
                }

                logger(`[Main Bot] Connection closed (${statusCode || 'n/a'}): ${reason}.`);
                await stopBot({ status: appState.isQrPaused() ? 'Idle (Paused)' : 'Disconnected' });
                if (dashboardIO) {
                    dashboardIO.emit('update', { status: 'Reconnecting...' });
                }
                scheduleReconnect();
            }
        } catch (error) {
            logger(`Connection Update Error: ${error.message}`);
        }
    });

    sock.ev.on('error', (error) => {
        if (sock !== activeSocket) return;
        logger(`Socket Error: ${error.message}`);
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async (messageUpdate) => {
        if (sock !== activeSocket) return;
        await handleMessages(sock, messageUpdate);
    });

    // ── Pro Features: Anti-Delete recovery ────────────────────────────────
    sock.ev.on('messages.update', async (updates) => {
        if (sock !== activeSocket) return;
        try {
            for (const u of updates) {
                const isRevoke = u?.update?.message === null
                    || u?.update?.messageStubType === 68
                    || u?.update?.messageStubType === 'REVOKE';
                if (!isRevoke) continue;
                await handleAntiDelete(sock, u.key);
            }
        } catch (e) {
            logger(`[AntiDelete] Update handler error: ${e.message}`);
        }
    });

    // ── Pro Features: Anti-Call (auto-reject) ─────────────────────────────
    sock.ev.on('call', async (calls) => {
        if (sock !== activeSocket) return;
        if (!resolveProFlag('antiCall', () => appState.getAntiCall())) return;
        try {
            for (const c of calls) {
                if (c.status !== 'offer') continue;
                try { await sock.rejectCall(c.id, c.from); } catch {}
                try {
                    await sock.sendMessage(c.from, {
                        text: '🚫 *Calls are not allowed.* This bot rejects incoming calls automatically. Please send a message instead.'
                    });
                } catch {}
                logger(`[AntiCall] Rejected ${c.isVideo ? 'video' : 'voice'} call from ${c.from}.`);
            }
        } catch (e) {
            logger(`[AntiCall] Handler error: ${e.message}`);
        }
    });

    // ── Pro Features: Anti-Group-Join (auto-leave on invite) ──────────────
    sock.ev.on('group-participants.update', async (event) => {
        if (sock !== activeSocket) return;
        if (event.action !== 'add') return;
        if (!resolveProFlag('antiGroupJoin', () => appState.getAntiGroupJoin())) return;
        try {
            const { jidNormalizedUser } = require('@whiskeysockets/baileys');
            const selfJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
            if (!selfJid) return;
            const wasAdded = (event.participants || []).some((p) => {
                try { return jidNormalizedUser(p) === selfJid; } catch { return false; }
            });
            if (!wasAdded) return;
            await delay(2000);
            try {
                await sock.sendMessage(event.id, { text: '🚫 *Anti-Group-Join* is enabled. Leaving this group.' });
            } catch {}
            try { await sock.groupLeave(event.id); } catch {}
            logger(`[AntiGroupJoin] Left ${event.id} after auto-join.`);
        } catch (e) {
            logger(`[AntiGroupJoin] Handler error: ${e.message}`);
        }
    });

    if (pairPhone && !state.creds.registered) {
        appState.setStatus('Preparing Pair Code');
        if (io) {
            io.emit('update', { status: 'Preparing Pair Code' });
        }
        setTimeout(() => {
            if (sock !== activeSocket || !appState.isMainPairMode()) return;
            requestMainPairCode(sock).catch(() => {});
        }, 5000);
    }

    return sock;
}

async function startBot(options = {}) {
    const { forceRestart = false, clearCredentials = false, pairMode = false, phoneNumber = '' } = options;
    const shouldClearCredentials = clearCredentials || pairMode;

    if (startPromise) {
        return startPromise;
    }

    if (forceRestart || shouldClearCredentials) {
        await stopBot({ clearCredentials: shouldClearCredentials, status: 'Disconnected' });
    } else if (activeSocket) {
        return activeSocket;
    }

    startPromise = createSocket({ pairMode, phoneNumber })
        .finally(() => {
            startPromise = null;
        });

    return startPromise;
}

async function handleMessages(sock, messageBatch, sessionId = '__main__') {
    if (messageBatch.type !== 'notify') return;

    let owner = null;
    let sAutoRead = null;
    let sAutoTyping = null;
    let sAutoReact = null;
    let sNsfw = null;
    let sPrefix = null;
    let sName = null;
    let sAutoReply = null;
    let workMode = 'public';
    let autoStatus = false;
    let botEnabled = true;
    let disabledModules = [];
    let sAiAutoReply = null;
    let sAiAutoVoice = null;
    let sAiAutoPersona = null;
    let sAiAutoLang = null;
    let sAiGroupMode = null;

    if (sessionId === '__main__') {
        const ov = db.getSetting('main_bot_settings') || {};
        workMode = ov.workMode || appState.getWorkMode();
        autoStatus = ov.autoStatus !== undefined ? ov.autoStatus : appState.getAutoStatus();
        botEnabled = ov.botEnabled !== undefined ? ov.botEnabled : appState.getBotEnabled();
        disabledModules = ov.disabledModules || appState.getDisabledModules();
        owner = ov.owner || appState.getOwner();
        sAutoRead = ov.autoRead !== undefined ? ov.autoRead : appState.getAutoRead();
        sAutoTyping = ov.autoTyping !== undefined ? ov.autoTyping : appState.getAutoTyping();
        sNsfw = ov.nsfwEnabled !== undefined ? ov.nsfwEnabled : appState.getNsfwEnabled();
        sAutoReact = ov.autoReactStatus !== undefined ? ov.autoReactStatus : appState.getAutoReactStatus();
        sPrefix = ov.prefix || getPrefix();
        sName = ov.name || getBotName();
        sAutoReply = ov.autoReply !== undefined ? ov.autoReply : appState.getAutoReply();
        sAiAutoReply = ov.aiAutoReply !== undefined ? ov.aiAutoReply : appState.getAiAutoReply();
        sAiAutoVoice = ov.aiAutoVoice !== undefined ? ov.aiAutoVoice : appState.getAiAutoVoice();
        sAiAutoPersona = ov.aiAutoPersona || appState.getAiAutoPersona();
        sAiAutoLang = ov.aiAutoLang || appState.getAiAutoLang();
        sAiGroupMode = ov.aiGroupMode || appState.getAiGroupMode();
    } else {
        const sessionMgr = require('./session-manager');
        const session = sessionMgr.get(sessionId);
        if (session) {
            workMode = session.workMode || 'public';
            autoStatus = session.autoStatus !== false;
            botEnabled = session.botEnabled !== false;
            disabledModules = session.disabledModules || [];
            owner = session.owner || null;
            
            // Per-bot overrides with global fallbacks
            sAutoRead = session.autoRead !== null && session.autoRead !== undefined 
                ? session.autoRead 
                : appState.getAutoRead();
            sAutoTyping = session.autoTyping !== null && session.autoTyping !== undefined 
                ? session.autoTyping 
                : appState.getAutoTyping();
            sAutoReact = session.autoReactStatus !== null && session.autoReactStatus !== undefined 
                ? session.autoReactStatus 
                : appState.getAutoReactStatus();
            sNsfw = session.nsfwEnabled !== null && session.nsfwEnabled !== undefined 
                ? session.nsfwEnabled 
                : appState.getNsfwEnabled();
            sPrefix = session.prefix || null;
            sName = session.name || null;
            sAutoReply = session.autoReply !== null && session.autoReply !== undefined 
                ? session.autoReply 
                : true; // Default to true if not specified per-bot
            
            sAiAutoReply = session.aiAutoReply !== undefined ? session.aiAutoReply : null;
            sAiAutoVoice = session.aiAutoVoice !== undefined ? session.aiAutoVoice : null;
            sAiAutoPersona = session.aiAutoPersona || null;
            sAiAutoLang = session.aiAutoLang || null;
            sAiGroupMode = session.aiGroupMode || null;
        }
    }

    // Resolve behavioral settings: Session > Global
    const finalAutoRead = sAutoRead !== null ? sAutoRead : getAutoRead();
    const finalAutoTyping = sAutoTyping !== null ? sAutoTyping : getAutoTyping();
    const finalAutoReact = sAutoReact !== null ? sAutoReact : getAutoReactStatus();
    const finalNsfw = sNsfw !== null ? sNsfw : getNsfwEnabled();
    const finalPrefix = sPrefix || getPrefix();
    const finalBotName = sName || getBotName();
    const finalAutoReply = sAutoReply !== null ? sAutoReply : true;
    
    // AI Settings Resolution: Per-bot > Global fallback
    const finalAiAutoReply = sAiAutoReply !== null ? sAiAutoReply : appState.getAiAutoReply();
    const finalAiAutoVoice = sAiAutoVoice !== null ? sAiAutoVoice : appState.getAiAutoVoice();
    const finalAiAutoPersona = sAiAutoPersona || appState.getAiAutoPersona() || 'friendly';
    const finalAiAutoLang = sAiAutoLang || appState.getAiAutoLang() || 'mixed';
    const finalAiGroupMode = sAiGroupMode || appState.getAiGroupMode() || 'mention';
    
    // Auto-view / Auto-react for status@broadcast are now independent of the
    // generic autoStatus flag — either global toggle alone is enough to trigger.
    const finalAutoView = sessionId === '__main__'
        ? !!getAutoViewStatus()
        : autoStatus !== false;


    // Removed global early exit for !botEnabled so owners can wake it up    // Increment Processed Count
    if (sessionId === '__main__') {
        appState.incProcessedCount();
    } else {
        const sessionMgr = require('./session-manager');
        const session = sessionMgr.get(sessionId);
        if (session) {
            sessionMgr.updateSessionMetrics(sessionId, { 
                processedCount: (session.processedCount || 0) + 1 
            });
        }
    }

    // Globally filter out backlog messages from the batch
    const startupGrace = 5; // 5 seconds grace period
    const validMessages = messageBatch.messages.filter(msg => {
        if (!msg.message) return false;
        
        // Get message timestamp (Baileys usually gives it in seconds)
        // Check multiple locations for the timestamp
        const rawTime = msg.messageTimestamp || msg.message?.messageTimestamp || msg.message?.extendedTextMessage?.contextInfo?.timestamp || 0;
        const msgTime = Number(rawTime);
        
        // If we don't have a start time yet, use a failsafe (but we set it in createSocket)
        const botStartTime = sock.startTime || Math.floor(Date.now() / 1000);

        // If message is older than bot start time - grace, it's definitely backlog
        const isBacklog = msgTime < (botStartTime - startupGrace);
        
        if (isBacklog) {
            // Keep logs clean but log normal messages for debugging
            if (msg.key?.remoteJid !== 'status@broadcast') {
                logger(`[Backlog] Ignoring old message from ${msg.key.remoteJid} (Diff: ${botStartTime - msgTime}s)`);
            }
            return false;
        }

        return true;
    });

    for (const msg of validMessages) {
        if (!msg.message) continue;

        const jid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const pushName = msg.pushName || 'User';
        const isGroup = jid.endsWith('@g.us');
        const sender = msg.key.participant || jid;

        if (jid === 'status@broadcast') {
            const { jidNormalizedUser } = require('@whiskeysockets/baileys');

            let selfJid = null;
            try {
                selfJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
            } catch {}

            const rawParticipant = msg.key?.participant || '';
            const normParticipant = rawParticipant.includes('@')
                ? jidNormalizedUser(rawParticipant)
                : rawParticipant;

            const isOwnStatus = fromMe || (selfJid && normParticipant && normParticipant === selfJid);

            if (!isOwnStatus && (finalAutoView || finalAutoReact)) {
                const readDelay = Math.floor(Math.random() * 5000) + 2000 + Math.floor(Math.random() * 800);

                setTimeout(async () => {
                    try {
                        const key = msg?.key;
                        const remoteJid = key?.remoteJid;
                        const msgId = key?.id;
                        let participant = key?.participant || rawParticipant || null;

                        if (!key || !remoteJid || !msgId || !participant) {
                            logger(`[Status] Missing key fields | remoteJid=${remoteJid} msgId=${msgId} participant=${participant}`);
                            return;
                        }

                        let sanitizedParticipant = participant;
                        if (participant.includes(':') && participant.includes('@')) {
                            const user = participant.split(':')[0];
                            const server = participant.split('@')[1];
                            sanitizedParticipant = `${user}@${server}`;
                        }

                        logger(`[Status Debug] Incoming status | remoteJid=${remoteJid} participant=${participant} sanitized=${sanitizedParticipant} id=${msgId}`);

                        if (finalAutoView) {
                            try {
                                await sock.readMessages([key]);
                                logger(`[Status View] readMessages() sent for ${sanitizedParticipant}`);

                                await sock.sendReceipt(
                                    remoteJid,
                                    sanitizedParticipant,
                                    [msgId],
                                    'read'
                                ).catch((e) => {
                                    logger(`[Status View] sendReceipt warning: ${e?.message || e}`);
                                });

                                logger(`[Status View] Attempted view for ${sanitizedParticipant.split('@')[0]}`);
                            } catch (viewErr) {
                                logger(`[Status View] Error: ${viewErr.message}`);
                            }
                        }

                        if (finalAutoReact) {
                            const reactDelay = Math.floor(Math.random() * 3500) + 1500;

                            setTimeout(async () => {
                                try {
                                    const reactions = [
                                        "🔥", "❤️", "😂", "💯", "✨", "🚀", "😍", "🙏",
                                        "🎉", "👏", "👍", "😁", "😎", "🤩", "😮", "💖",
                                        "⚡", "👑", "🌹", "🥹", "😅", "🥰", "😜", "🤪",
                                        "🥺", "😇", "😋", "😌"
                                    ];

                                    const emoji = reactions[Math.floor(Math.random() * reactions.length)];
                                    const targetJid = jidNormalizedUser(sanitizedParticipant);

                                    if (selfJid && targetJid === selfJid) return;

                                    const reactionPayload = {
                                        react: {
                                            text: emoji,
                                            key: key
                                        }
                                    };

                                    const res = await sock.sendMessage(
                                        targetJid,
                                        reactionPayload
                                    );

                                    logger(`[Status React] Attempted ${emoji} to ${sanitizedParticipant.split('@')[0]}`);
                                    // logger(`[Status React Debug] response=${JSON.stringify(res)}`);
                                } catch (reactErr) {
                                    logger(`[Status React] Error: ${reactErr.message}`);
                                }
                            }, reactDelay);
                        }

                    } catch (err) {
                        logger(`[Status] Processing error: ${err.message}`);
                    }
                }, readDelay);
            }

            continue;
        }

        // Private Mode Check
        const isUserOwner = db.isUserBanned(sender) ? false : (msg.key.fromMe || require('./lib/utils').isOwner(sender, owner));
        if (!isUserOwner && (workMode === 'self' || (workMode === 'private' && isGroup))) {
            continue;
        }

        if (isGroup && !fromMe) {
            const group = db.get('groups', jid);
            if (group) {
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

                if ((group.antiLink || group.antilink) && (text.includes('chat.whatsapp.com') || text.includes('http://') || text.includes('https://'))) {
                    logger(`Anti-Link: Deleting link from ${pushName} in ${group.name}`);
                    await sock.sendMessage(jid, { delete: msg.key });
                    continue;
                }

                if (group.antiSpam) {
                    const now = Date.now();
                    const spamKey = msg.key.participant || jid;
                    const recentMessages = (spamMap.get(spamKey) || []).filter((timestamp) => now - timestamp < 5000);
                    recentMessages.push(now);
                    spamMap.set(spamKey, recentMessages);
                    if (recentMessages.length > 4) {
                        logger(`Anti-Spam: Skipping message from ${pushName} in ${group.name}`);
                        continue;
                    }
                }

                if (group.isMuted && text.startsWith(getPrefix())) {
                    logger(`Mute: Ignoring command in ${group.name}`);
                    continue;
                }
            }
        }
    }

    if (appState.isRestartRequested()) {
        appState.clearRestart();
        logger('Admin restart requested. Reconnecting main bot...');
        await stopBot({ status: 'Restarting' });
        setTimeout(() => {
            startBot({ forceRestart: true }).catch(() => {});
        }, 2000);
        return;
    }

    for (const msg of validMessages) {
        const from = msg.key.remoteJid;
        if (from === 'status@broadcast') continue;

        let sender = msg.key.participant || msg.key.remoteJid;
        const pushName = msg.pushName || null;
        
        // Resolve JID: Check if this is an LID that needs mapping to a phone number
        const userDb = db.getObjectCollection('users');
        let resolvedSender = sender;
        
        // 1. Check if we have a direct mapping for this LID in the DB
        if (sender.endsWith('@lid')) {
            const foundByLid = userDb[sender];
            if (foundByLid && foundByLid.number) {
                resolvedSender = foundByLid.number + '@s.whatsapp.net';
            }
        }
        
        // 2. Fallback: Check if the LID string itself IS the phone number (common for some users)
        if (resolvedSender.endsWith('@lid')) {
            const potentialNum = resolvedSender.split('@')[0];
            if (potentialNum.length >= 10 && !isNaN(potentialNum)) {
                resolvedSender = potentialNum + '@s.whatsapp.net';
            }
        }

        // Apply global owner override
        if (sender === '269922018025553@lid') resolvedSender = '94742514900@s.whatsapp.net';

        // Automaticaly update user metadata (Name and Last Seen)
        if (sender && sender !== 'status@broadcast') {
            const updateData = { 
                lastSeen: new Date().toISOString(),
                number: (resolvedSender || sender).split('@')[0]
            };
            if (pushName) updateData.pushName = pushName;
            
            // Save to both identifiers to ensure future mapping works
            db.update('users', sender, updateData);
            if (resolvedSender !== sender) {
                db.update('users', resolvedSender, updateData);
            }
        }

        const text = msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption || '';

        // Check ownership using both the raw sender and the resolved identity
        const isUserOwner = msg.key.fromMe || 
                           require('./lib/utils').isOwner(sender, owner) || 
                           require('./lib/utils').isOwner(resolvedSender, owner) ||
                           (userDb[sender]?.isOwner) || 
                           (userDb[resolvedSender]?.isOwner);

        if (!botEnabled) {
            // If bot is disabled, ignore everything EXCEPT owner running system commands (.on, .settings)
            if (isUserOwner && text.startsWith(finalPrefix)) {
                const cmdName = text.slice(finalPrefix.length).trim().split(' ')[0].toLowerCase();
                if (!['on', 'settings', 'status', 'config'].includes(cmdName)) {
                    continue;
                }
            } else {
                continue;
            }
        }

        logger(`[Incoming] from: ${from}, sender: ${sender}, text: "${text}"`);

        // Fix: Behavioral features apply to all incoming messages
        // `readMessages` works for both 1:1 and group chats; `sendReceipt`
        // expected a participant id and silently no-op'd in DMs (where
        // participant is undefined), so chats appeared "stuck" as unread.
        if (finalAutoRead && !msg.key.fromMe) await sock.readMessages([msg.key]).catch(() => {});
        if (finalAutoTyping && !msg.key.fromMe) await sock.sendPresenceUpdate('composing', from).catch(() => {});
        // Pro: Always-Recording presence per incoming message
        if (!msg.key.fromMe && resolveProFlag('alwaysRecording', () => appState.getAlwaysRecording())) {
            await sock.sendPresenceUpdate('recording', from).catch(() => {});
        }

        const prefix = finalPrefix;
        
        // Skip own messages unless they start with prefix (commands) or are pure numeric replies (for download selection)
        if (msg.key.fromMe && !text.startsWith(finalPrefix) && !/^\d+$/.test(text.trim())) continue;

        if (db.isUserBanned(sender)) continue;
        if (!isUserOwner && (
            workMode === 'self' ||
            (workMode === 'private' && from.endsWith('@g.us')) ||
            (workMode === 'group' && !from.endsWith('@g.us'))
        )) continue;

        cacheMsg(msg);

        if (from.endsWith('@g.us') && text) {
            const groupSettings = db.get('groups', from) || {};

            if ((groupSettings.antilink || groupSettings.antiLink) && /(https?:\/\/|chat\.whatsapp\.com)/i.test(text)) {
                try {
                    const meta = await sock.groupMetadata(from);
                    const isAdmin = meta.participants.find((participant) => participant.id === sender)?.admin;
                    if (!isAdmin) {
                        await sock.sendMessage(from, { delete: msg.key });
                        await sock.groupParticipantsUpdate(from, [sender], 'remove');
                        continue;
                    }
                } catch {}
            }

            if (groupSettings.antibad && BAD_WORDS.some((word) => text.toLowerCase().includes(word))) {
                try {
                    const meta = await sock.groupMetadata(from);
                    const isAdmin = meta.participants.find((participant) => participant.id === sender)?.admin;
                    if (!isAdmin) {
                        await sock.sendMessage(from, { delete: msg.key });
                        await sock.sendMessage(from, {
                            text: `Warning @${sender.split('@')[0]}, this group does not allow bad words.`,
                            mentions: [sender]
                        });
                        continue;
                    }
                } catch {}
            }
        }

        // Pro per-session overrides for AI + mention reply (fallback to global appState).
        const ovMain = sessionId === '__main__' ? getMainBotSettings() : {};
        const finalAiSystemInstruction = ovMain.aiSystemInstruction !== undefined && ovMain.aiSystemInstruction !== null
            ? String(ovMain.aiSystemInstruction)
            : appState.getAiSystemInstruction();
        const finalAiMaxWords = (ovMain.aiMaxWords !== undefined && ovMain.aiMaxWords !== null)
            ? (parseInt(ovMain.aiMaxWords) || appState.getAiMaxWords())
            : appState.getAiMaxWords();
        const finalMentionReply = ovMain.mentionReply !== undefined && ovMain.mentionReply !== null
            ? String(ovMain.mentionReply)
            : appState.getMentionReply();

        const isCommand = await handleCommand(sock, msg, from, text, disabledModules, { 
            workMode, owner, nsfwEnabled: finalNsfw, prefix: finalPrefix, botName: finalBotName, sessionId,
            aiAutoReply: finalAiAutoReply,
            aiAutoVoice: finalAiAutoVoice,
            aiAutoPersona: finalAiAutoPersona,
            aiAutoLang: finalAiAutoLang,
            aiGroupMode: finalAiGroupMode,
            aiSystemInstruction: finalAiSystemInstruction,
            aiMaxWords: finalAiMaxWords,
            mentionReply: finalMentionReply
        });
        if (isCommand) {
            // Increment Command Count
            if (sessionId === '__main__') {
                appState.incCommandsCount();
            } else {
                const sessionMgr = require('./session-manager');
                const session = sessionMgr.get(sessionId);
                if (session) {
                    sessionMgr.updateSessionMetrics(sessionId, { 
                        commandsCount: (session.commandsCount || 0) + 1 
                    });
                }
            }
        }
        const botNumber = sock.user?.id?.split(':')[0];
        if (sender.startsWith(botNumber)) continue;

        if (!isCommand && !msg.key.fromMe && !text.startsWith(finalPrefix) && finalAutoReply) {
            const autoReplyRule = findAutoReply(text, { isGroupMessage: from.endsWith('@g.us') });
            if (autoReplyRule) {
                logger(`[AutoReply] Rule matched: "${text.substring(0, 20)}..." -> "${autoReplyRule.response.substring(0, 20)}..."`);
                await sock.sendMessage(from, { text: autoReplyRule.response }).catch((err) => {
                    logger(`[AutoReply] Failed to send: ${err.message}`);
                });
                continue;
            }

            const lower = text.toLowerCase().trim();
            if (lower === 'hi' || lower === 'hello' || lower === 'hey') {
                await sock.sendMessage(from, {
                    text: `Hello! Welcome.\n\nType *${finalPrefix}menu* to see all features or *${finalPrefix}help* for a quick guide.\n\n- Powered by *${getBotName()}*`
                });
            }
        }
    }
}

module.exports = {
    startBot,
    stopBot,
    handleMessages,
    syncGroups
};
