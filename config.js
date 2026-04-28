"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DEFAULT_ADMIN_PASS = "chathura123";
const DEFAULT_JWT_SECRET = "replace_this_jwt_secret_before_production";

function readInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

// ---- Persistent data directory --------------------------------------------
// Free hosts (Railway, Fly, Render, etc.) typically mount a persistent volume
// at a single configurable path. We honour DATA_DIR if set so all stateful
// files (db.json, WhatsApp session creds, downloaded files) live on the
// volume and survive deploys/restarts. When unset we fall back to the repo
// root so local development still "just works".
const DATA_DIR = (() => {
  const fromEnv = readString(process.env.DATA_DIR);
  const dir = fromEnv ? path.resolve(fromEnv) : __dirname;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Non-fatal: callers will surface a clearer error when they fail to
    // write into the directory.
  }
  return dir;
})();

const SESSION_DIR = readString(process.env.SESSION_DIR) || path.join(DATA_DIR, "session");
const DOWNLOAD_DIR = readString(process.env.DOWNLOAD_DIR) || path.join(DATA_DIR, "downloads");
const DB_PATH = readString(process.env.DB_PATH) || path.join(DATA_DIR, "db.json");
const SESSIONS_DIR = readString(process.env.SESSIONS_DIR) || path.join(DATA_DIR, "sessions");
// View Once captures contain media the sender intended to be seen once.
// They must NEVER live under public/ where express.static could serve
// them. Default to a private directory under DATA_DIR.
const VIEWONCE_DIR = readString(process.env.VIEWONCE_DIR) || path.join(DATA_DIR, "private", "viewonce");
const VIEWONCE_LOG_PATH = readString(process.env.VIEWONCE_LOG_PATH) || path.join(DATA_DIR, "viewonce-log.json");

// ---- Auto-provisioned JWT secret ------------------------------------------
// Free-host first-deploy UX: if JWT_SECRET is not provided we generate a
// strong random secret and persist it under the data dir so it stays stable
// across restarts. This keeps logged-in admins logged in (no surprise
// invalidation) while still being safer than the placeholder default.
function ensureJwtSecret() {
  const fromEnv = readString(process.env.JWT_SECRET);
  if (fromEnv) return fromEnv;
  const secretFile = path.join(DATA_DIR, ".jwt_secret");
  try {
    if (fs.existsSync(secretFile)) {
      const cached = fs.readFileSync(secretFile, "utf8").trim();
      if (cached) return cached;
    }
    const generated = crypto.randomBytes(48).toString("hex");
    try {
      fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    } catch {
      // Read-only filesystem — fall through and reuse generated for this run.
    }
    return generated;
  } catch {
    return crypto.randomBytes(48).toString("hex");
  }
}

const ADMIN_PASS = readString(process.env.ADMIN_PASS, DEFAULT_ADMIN_PASS);
const JWT_SECRET = ensureJwtSecret();
const NODE_ENV = String(process.env.NODE_ENV || "development").trim().toLowerCase();
const IS_PRODUCTION = NODE_ENV === "production";
const OWNER_NUMBER = readString(process.env.OWNER_NUMBER);

// ---- Production startup guards --------------------------------------------
// In production we refuse to boot with the legacy default credentials or
// without an explicit owner number. Operators were repeatedly leaving the
// shipped "chathura123" admin password and the bundled owner number in
// place, which gave anyone who could reach the dashboard full bot control.
if (IS_PRODUCTION) {
  if (!process.env.ADMIN_PASS || process.env.ADMIN_PASS === DEFAULT_ADMIN_PASS) {
    throw new Error(
      "Refusing to start in production with the default ADMIN_PASS. " +
      "Set ADMIN_PASS to a unique value before deploying."
    );
  }
  if (!OWNER_NUMBER) {
    throw new Error(
      "Refusing to start in production without OWNER_NUMBER. " +
      "Set OWNER_NUMBER to your WhatsApp number (digits only) before deploying."
    );
  }
}

// Public AI fallback APIs leak user prompts to third parties. Default to
// off; operators can opt in explicitly if they understand the trade-off.
const AI_PUBLIC_FALLBACK = String(
  process.env.AI_PUBLIC_FALLBACK ?? (IS_PRODUCTION ? "false" : "false")
).toLowerCase() === "true";

// ---- DATA_DIR persistence warning -----------------------------------------
// Free hosts (Railway, Render, Fly without volumes, etc.) run with an
// ephemeral filesystem. Without DATA_DIR pointing at a persistent volume
// the bot loses sessions / db.json / downloads on every restart and the
// user has to re-pair WhatsApp. Warn loudly so operators don't get
// surprised in production.
if (!process.env.DATA_DIR) {
  const message = "[config] DATA_DIR is not set. db.json, sessions and downloads will be stored under the repo root and may be wiped on container restart. Set DATA_DIR to a persistent volume path (e.g. /data) before deploying.";
  if (IS_PRODUCTION) {
    console.warn(message);
  } else {
    // In development this is usually fine, but still surface a hint.
    console.info(message);
  }
}

module.exports = {
  BOT_NAME: process.env.BOT_NAME || "Chathu MD",
  // No hardcoded fallback owner number — operators must supply their own.
  // Sub-session entries can still override this per session.
  OWNER_NUMBER,
  PREFIX: process.env.PREFIX || ".",
  PORT: readInt(process.env.PORT, 5000),
  HOST: readString(process.env.HOST, "0.0.0.0"),
  ADMIN_USER: readString(process.env.ADMIN_USER, "admin"),
  ADMIN_PASS,
  JWT_SECRET,
  NODE_ENV,
  IS_PRODUCTION,
  PREMIUM_CODE: process.env.PREMIUM_CODE || "CHATHU2026",
  DATA_DIR,
  SESSION_DIR,
  SESSIONS_DIR,
  DOWNLOAD_DIR,
  VIEWONCE_DIR,
  VIEWONCE_LOG_PATH,
  DB_PATH,
  BROWSER: ["Ubuntu", "Chrome", "131.0.6778.205"],
  SEARCH_CACHE_TTL: readInt(process.env.SEARCH_CACHE_TTL, 300000),
  DOWNLOAD_CACHE_TTL: readInt(process.env.DOWNLOAD_CACHE_TTL, 10 * 60 * 1000),
  AUTO_READ: String(process.env.AUTO_READ || "true").toLowerCase() !== "false",
  AUTO_TYPING: String(process.env.AUTO_TYPING || "true").toLowerCase() !== "false",
  // Adult/NSFW commands are off by default. Operators must opt in by
  // setting NSFW_ENABLED=true (and the dashboard "Adult Zone" toggle).
  NSFW_ENABLED: String(process.env.NSFW_ENABLED || "false").toLowerCase() === "true",
  AI_PUBLIC_FALLBACK,
  WORK_MODE: process.env.WORK_MODE || "public",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
  DEFAULT_ADMIN_PASS,
  DEFAULT_JWT_SECRET,
};
