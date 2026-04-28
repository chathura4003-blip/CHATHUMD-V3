"use strict";

const fs = require("fs");
const path = require("path");

const LOCAL_BANNER_CANDIDATES = [
  path.join(__dirname, "..", "public", "assets", "banner.jpg"),
  path.join(__dirname, "..", "public", "assets", "banner.png"),
  path.join(__dirname, "..", "public", "banner.jpg"),
  path.join(__dirname, "..", "public", "banner.png"),
];

// Cache the banner buffer so we don't re-read it from disk on every menu
// invocation. The file is ~tens of KB but is read on every `.menu` /
// `.help` / `.ping` etc., which adds avoidable IO under load.
let _cachedBannerPath = null;
let _cachedBannerBuffer = null;
let _cachedBannerMtimeMs = 0;
let _missingBannerLogged = false;

function getLocalBannerPath() {
  return LOCAL_BANNER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

function loadBannerBuffer() {
  const bannerPath = getLocalBannerPath();
  if (!bannerPath) {
    if (!_missingBannerLogged) {
      _missingBannerLogged = true;
      // Use logger lazily to avoid a hard dep cycle if logger needs config.
      try { require("../logger").logger(`[media-fallback] No banner image found; falling back to text-only menus.`); } catch {}
    }
    return null;
  }
  let stat;
  try { stat = fs.statSync(bannerPath); } catch { return null; }
  if (
    _cachedBannerBuffer &&
    _cachedBannerPath === bannerPath &&
    _cachedBannerMtimeMs === stat.mtimeMs
  ) {
    return _cachedBannerBuffer;
  }
  try {
    _cachedBannerBuffer = fs.readFileSync(bannerPath);
    _cachedBannerPath = bannerPath;
    _cachedBannerMtimeMs = stat.mtimeMs;
    return _cachedBannerBuffer;
  } catch {
    return null;
  }
}

async function sendBannerMessage(sock, from, options = {}) {
  const {
    caption = "",
    text = caption,
    mentions = [],
    contextInfo,
    quoted,
  } = options;

  const buffer = loadBannerBuffer();
  if (buffer) {
    try {
      return await sock.sendMessage(
        from,
        {
          image: buffer,
          caption,
          mentions,
          ...(contextInfo ? { contextInfo } : {}),
        },
        quoted ? { quoted } : undefined
      );
    } catch {}
  }

  return sock.sendMessage(
    from,
    {
      text,
      mentions,
      ...(contextInfo ? { contextInfo } : {}),
    },
    quoted ? { quoted } : undefined
  );
}

module.exports = {
  getLocalBannerPath,
  sendBannerMessage,
};
