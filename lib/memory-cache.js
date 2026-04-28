"use strict";

const DEFAULT_MAX_ENTRIES = 1000;
const activeCaches = new Set();

let _shutdownHookInstalled = false;
function installShutdownHook() {
  if (_shutdownHookInstalled) return;
  _shutdownHookInstalled = true;
  const cleanup = () => {
    for (const cache of activeCaches) {
      try { cache.destroy(); } catch {}
    }
    activeCaches.clear();
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => { cleanup(); process.exit(0); });
  process.once("SIGTERM", () => { cleanup(); process.exit(0); });
}

class MemoryCache {
  constructor(defaultTTL = 600000, options = {}) {
    this.store = new Map();
    this.timers = new Map();
    this.defaultTTL = defaultTTL;
    // Bounded size — older insertion-order entries are evicted first.
    // Without this, long-lived caches (search results, AI history) grow
    // unbounded and leak memory under sustained load.
    this.maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : DEFAULT_MAX_ENTRIES;

    this._cleanup = setInterval(() => this._sweep(), 120000);
    this._cleanup.unref();
    activeCaches.add(this);
    installShutdownHook();
  }

  set(key, value, ttlMs) {
    if (key == null) return;
    this._clearTimer(key);
    const ttl = ttlMs || this.defaultTTL;
    const timer = setTimeout(() => this.delete(key), ttl);
    timer.unref();
    this.store.set(key, value);
    this.timers.set(key, { timer, expiresAt: Date.now() + ttl });
    if (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined && oldestKey !== key) this.delete(oldestKey);
    }
  }

  get(key) {
    if (key == null) return undefined;
    const meta = this.timers.get(key);
    if (!meta || meta.expiresAt < Date.now()) {
      this.delete(key);
      return undefined;
    }
    return this.store.get(key);
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    if (key == null) return;
    this._clearTimer(key);
    this.store.delete(key);
  }

  clear() {
    for (const key of [...this.store.keys()]) this.delete(key);
  }

  size() {
    return this.store.size;
  }

  _clearTimer(key) {
    const meta = this.timers.get(key);
    if (meta?.timer) clearTimeout(meta.timer);
    this.timers.delete(key);
  }

  _sweep() {
    const now = Date.now();
    for (const [key, meta] of this.timers.entries()) {
      if (meta.expiresAt < now) this.delete(key);
    }
  }

  destroy() {
    clearInterval(this._cleanup);
    this.clear();
    activeCaches.delete(this);
  }
}

module.exports = { MemoryCache };
