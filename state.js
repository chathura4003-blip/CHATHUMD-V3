'use strict';

let _socket = null;
let _status = 'Disconnected';
let _number = null;
let _pushName = null;
let _connectedAt = null;
let _mainQr = null;
let _mainPairCode = null;
let _mainPairCodeExpiresAt = null;
let _mainPairMode = false;
let _mainPairPhone = null;
let _workMode = 'public';
let _autoStatus = true;
let _botEnabled = true;
let _disabledModules = [];
let _owner = null;
let _restartRequested = false;
let _qrPaused = false;
let _qrPausedReason = null;
let _qrAttempts = 0;
let _processedCount = 0;
let _commandsCount = 0;
let _lastError = null;
let _lastErrorAt = null;
let _lastConnectedAt = null;
let _badMacCount = 0;
const _logs = [];

module.exports = {
    setSocket: (s) => { _socket = s; },
    getSocket: () => _socket,
    setStatus: (s) => { _status = s; },
    getStatus: () => _status,
    setNumber: (n) => { _number = n; },
    getNumber: () => _number,
    setPushName: (n) => { _pushName = n; },
    getPushName: () => _pushName,
    setConnectedAt: (t) => { _connectedAt = t; },
    getConnectedAt: () => _connectedAt,
    setMainQr: (q) => { _mainQr = q; },
    getMainQr: () => _mainQr,
    setMainPairCode: (c) => { _mainPairCode = c; },
    getMainPairCode: () => _mainPairCode,
    setMainPairCodeExpiresAt: (t) => { _mainPairCodeExpiresAt = t; },
    getMainPairCodeExpiresAt: () => _mainPairCodeExpiresAt,
    setMainPairMode: (m) => { _mainPairMode = !!m; },
    isMainPairMode: () => _mainPairMode,
    setMainPairPhone: (p) => { _mainPairPhone = p; },
    getMainPairPhone: () => _mainPairPhone,
    requestRestart: () => { _restartRequested = true; },
    clearRestart: () => { _restartRequested = false; },
    isRestartRequested: () => _restartRequested,
    setQrPaused: (v) => { _qrPaused = !!v; },
    isQrPaused: () => _qrPaused,
    setQrPausedReason: (v) => { _qrPausedReason = v || null; },
    getQrPausedReason: () => _qrPausedReason,
    incQrAttempts: () => ++_qrAttempts,
    resetQrAttempts: () => { _qrAttempts = 0; },
    getQrAttempts: () => _qrAttempts,
    setLastError: (msg) => {
        _lastError = msg ? String(msg).slice(0, 280) : null;
        _lastErrorAt = msg ? new Date().toISOString() : null;
    },
    clearLastError: () => { _lastError = null; _lastErrorAt = null; },
    getLastError: () => _lastError,
    getLastErrorAt: () => _lastErrorAt,
    setLastConnectedAt: (v) => { _lastConnectedAt = v || new Date().toISOString(); },
    getLastConnectedAt: () => _lastConnectedAt,
    setBadMacCount: (v) => { _badMacCount = Number.isFinite(v) ? v : 0; },
    incBadMacCount: () => ++_badMacCount,
    resetBadMacCount: () => { _badMacCount = 0; },
    getBadMacCount: () => _badMacCount,
    incProcessedCount: () => {
        _processedCount++;
        try { require('./lib/db').setSetting('main_processed_count', _processedCount); } catch {}
        return _processedCount;
    },
    getProcessedCount: () => {
        try { return require('./lib/db').getSetting('main_processed_count') || _processedCount; } catch { return _processedCount; }
    },
    incCommandsCount: () => {
        _commandsCount++;
        try { require('./lib/db').setSetting('main_commands_count', _commandsCount); } catch {}
        return _commandsCount;
    },
    getCommandsCount: () => {
        try { return require('./lib/db').getSetting('main_commands_count') || _commandsCount; } catch { return _commandsCount; }
    },
    setWorkMode: (v) => { 
        _workMode = v; 
        try { require('./lib/db').setSetting('work_mode', v); } catch {}
    },
    getWorkMode: () => {
        try { return require('./lib/db').getSetting('work_mode') || _workMode; } catch { return _workMode; }
    },
    setAutoStatus: (v) => { 
        _autoStatus = !!v; 
        try { require('./lib/db').setSetting('main_auto_status', !!v); } catch {}
    },
    getAutoStatus: () => {
        try {
            const val = require('./lib/db').getSetting('main_auto_status');
            return val !== undefined ? val : _autoStatus;
        } catch { return _autoStatus; }
    },
    setBotEnabled: (v) => { 
        _botEnabled = !!v; 
        try { require('./lib/db').setSetting('main_bot_enabled', !!v); } catch {}
    },
    getBotEnabled: () => {
        try { 
            const val = require('./lib/db').getSetting('main_bot_enabled');
            return val !== undefined ? val : _botEnabled;
        } catch { return _botEnabled; }
    },
    setDisabledModules: (v) => { 
        _disabledModules = Array.isArray(v) ? v : []; 
        try { require('./lib/db').setSetting('main_disabled_modules', _disabledModules); } catch {}
    },
    getDisabledModules: () => {
        try { return require('./lib/db').getSetting('main_disabled_modules') || _disabledModules; } catch { return _disabledModules; }
    },
    setOwner: (v) => { 
        _owner = v; 
        try { require('./lib/db').setSetting('main_owner', v); } catch {}
    },
    getOwner: () => {
        try { return require('./lib/db').getSetting('main_owner') || _owner; } catch { return _owner; }
    },
    setAutoRead: (v) => {
        try { require('./lib/db').setSetting('autoRead', v === null ? null : !!v); } catch {}
    },
    getAutoRead: () => {
        try { return require('./lib/db').getSetting('autoRead'); } catch { return null; }
    },
    setAutoTyping: (v) => {
        try { require('./lib/db').setSetting('autoTyping', v === null ? null : !!v); } catch {}
    },
    getAutoTyping: () => {
        try { return require('./lib/db').getSetting('autoTyping'); } catch { return null; }
    },
    setAutoReactStatus: (v) => {
        try { require('./lib/db').setSetting('auto_react_status', v === null ? null : !!v); } catch {}
    },
    getAutoReactStatus: () => {
        try { return require('./lib/db').getSetting('auto_react_status'); } catch { return null; }
    },
    setAntiViewOnceEnabled: (v) => {
        try { require('./lib/db').setSetting('anti_view_once', !!v); } catch {}
    },
    getAntiViewOnceEnabled: () => {
        try { return require('./lib/db').getSetting('anti_view_once') === true; } catch { return false; }
    },
    setNsfwEnabled: (v) => {
        try { require('./lib/db').setSetting('nsfwEnabled', v === null ? null : !!v); } catch {}
    },
    getNsfwEnabled: () => {
        try { return require('./lib/db').getSetting('nsfwEnabled'); } catch { return null; }
    },
    setAutoReply: (v) => {
        try { require('./lib/db').setSetting('autoReply', v === null ? null : !!v); } catch {}
    },
    getAutoReply: () => {
        try { return require('./lib/db').getSetting('autoReply'); } catch { return null; }
    },
    setAiAutoReply: (v) => {
        try { require('./lib/db').setSetting('aiAutoReply', v === null ? null : !!v); } catch {}
    },
    getAiAutoReply: () => {
        try { return require('./lib/db').getSetting('aiAutoReply'); } catch { return null; }
    },
    setAiAutoPersona: (v) => {
        try { require('./lib/db').setSetting('aiAutoPersona', v); } catch {}
    },
    getAiAutoPersona: () => {
        try { return require('./lib/db').getSetting('aiAutoPersona') || 'friendly'; } catch { return 'friendly'; }
    },
    setAiAutoLang: (v) => {
        try { require('./lib/db').setSetting('aiAutoLang', v); } catch {}
    },
    getAiAutoLang: () => {
        try { return require('./lib/db').getSetting('aiAutoLang') || 'auto'; } catch { return 'auto'; }
    },
    setAiAutoVoice: (v) => {
        try { require('./lib/db').setSetting('aiAutoVoice', !!v); } catch { return false; }
    },
    getAiAutoVoice: () => {
        try { return require('./lib/db').getSetting('aiAutoVoice') === true; } catch { return false; }
    },
    setAiGroupMode: (v) => {
        try { require('./lib/db').setSetting('aiGroupMode', v); } catch {}
    },
    getAiGroupMode: () => {
        try { return require('./lib/db').getSetting('aiGroupMode') || 'mention'; } catch { return 'mention'; }
    },
    setAiSystemInstruction: (v) => {
        try { require('./lib/db').setSetting('aiSystemInstruction', v); } catch {}
    },
    getAiSystemInstruction: () => {
        try { return require('./lib/db').getSetting('aiSystemInstruction') || ''; } catch { return ''; }
    },
    setAiMaxWords: (v) => {
        try { require('./lib/db').setSetting('aiMaxWords', parseInt(v) || 30); } catch {}
    },
    getAiMaxWords: () => {
        try { return parseInt(require('./lib/db').getSetting('aiMaxWords')) || 30; } catch { return 30; }
    },
    getLogs: () => _logs,
};
