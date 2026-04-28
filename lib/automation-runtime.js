'use strict';

const db = require('./db');

// Cap regex/trigger length so an autoreply rule cannot blow up the
// matcher with a pathological pattern. Real triggers are short; anything
// approaching this length is almost certainly a mis-configuration.
const MAX_TRIGGER_LENGTH = 200;

const compiledRegexCache = new Map();

// Per-rule cooldown. After a rule fires we short-circuit further matches
// for the same rule until the cooldown elapses, so a single message can't
// keep re-triggering the same auto-reply (and a busy chat can't run the
// same regex hundreds of times per minute).
const ruleCooldownMs = 4000;
const lastFiredAt = new Map();

function isLikelyUnsafeRegex(pattern) {
    if (!pattern || typeof pattern !== 'string') return true;
    if (pattern.length > MAX_TRIGGER_LENGTH) return true;
    // Reject classic ReDoS shapes: nested quantifiers / overlapping
    // alternation that combine into catastrophic backtracking.
    if (/(\([^)]*[+*][^)]*\)[+*])/.test(pattern)) return true;
    if (/(\(\?:.*[+*]\)[+*])/.test(pattern)) return true;
    return false;
}

function getCompiledRegex(pattern, isCaseSensitive) {
    const key = `${isCaseSensitive ? 'cs' : 'ci'}:${pattern}`;
    if (compiledRegexCache.has(key)) return compiledRegexCache.get(key);
    if (isLikelyUnsafeRegex(pattern)) {
        compiledRegexCache.set(key, null);
        return null;
    }
    try {
        const regex = new RegExp(pattern, isCaseSensitive ? '' : 'i');
        compiledRegexCache.set(key, regex);
        return regex;
    } catch {
        compiledRegexCache.set(key, null);
        return null;
    }
}

function normalizeTarget(value, defaultSuffix) {
    if (!value) return null;
    let str = String(value).trim();
    if (str.includes('@')) return str;
    const clean = str.replace(/[^0-9]/g, '');
    if (!clean) return null;
    return `${clean}${defaultSuffix || '@s.whatsapp.net'}`;
}

function matchesRule(message, rule) {
    const trigger = String(rule?.trigger || '');
    if (!trigger) return false;
    if (trigger.length > MAX_TRIGGER_LENGTH) return false;

    const source = String(message || '');
    const isCaseSensitive = Boolean(rule.caseSensitive);

    const haystack = isCaseSensitive ? source : source.toLowerCase();
    const needle = isCaseSensitive ? trigger : trigger.toLowerCase();

    switch (rule.matchType) {
        case 'regex': {
            const regex = getCompiledRegex(trigger, isCaseSensitive);
            if (!regex) return false;
            return regex.test(source);
        }
        case 'word': {
            try {
                const escapedNeedle = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = getCompiledRegex(`\\b${escapedNeedle}\\b`, isCaseSensitive);
                return regex ? regex.test(source) : false;
            } catch {
                return false;
            }
        }
        case 'contains':
            return haystack.includes(needle);
        case 'startsWith':
            return haystack.startsWith(needle);
        case 'endsWith':
            return haystack.endsWith(needle);
        case 'exact':
        default:
            return haystack.trim() === needle.trim();
    }
}

function ruleId(rule) {
    return rule?.id || rule?._id || rule?.trigger || '';
}

function findAutoReply(message, options = {}) {
    const {
        isGroupMessage = false,
        chatId = null,
    } = options;

    const rules = db.listAutoReply();
    const sortedRules = rules.slice().sort((a, b) => {
        const pa = Number.isFinite(a?.priority) ? a.priority : 0;
        const pb = Number.isFinite(b?.priority) ? b.priority : 0;
        return pb - pa;
    });

    const now = Date.now();
    for (const rule of sortedRules) {
        if (!rule || rule.enabled === false) continue;
        const groupsOnly = Boolean(rule.groupsOnly) && !rule.pmOnly;
        const pmOnly = Boolean(rule.pmOnly) && !rule.groupsOnly;
        if (groupsOnly && !isGroupMessage) continue;
        if (pmOnly && isGroupMessage) continue;

        if (!matchesRule(message, rule)) continue;

        const cooldownKey = `${ruleId(rule)}|${chatId || ''}`;
        const last = lastFiredAt.get(cooldownKey) || 0;
        const cd = Number.isFinite(rule.cooldownMs) ? rule.cooldownMs : ruleCooldownMs;
        if (now - last < cd) continue;
        lastFiredAt.set(cooldownKey, now);
        return rule;
    }
    return null;
}

module.exports = {
    normalizeTarget,
    findAutoReply,
    isLikelyUnsafeRegex,
};
