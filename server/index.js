"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL } = require("url");

const { NoPaletteDatabase } = require("./lib/nopalette/db");
const { EthereumBlockSource } = require("./lib/nopalette/blockSource");
const { NoPaletteRarityService } = require("./lib/nopalette/rarityService");
const { NoPaletteGenerationService } = require("./lib/nopalette/generationService");
const { renderNoPaletteNoiseGif } = require("./lib/nopalette/imageWorker");
const { GalleryStore } = require("./lib/galleryStore");
const { createRecoveryFaultsService, normalizeAddress } = require("./lib/recoveryFaults");

const APP_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(APP_ROOT, "web");
const DATA_ROOT = path.join(APP_ROOT, "data");
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");
const TRANSPARENT_ROOT = path.join(REPO_ROOT, "transparent");
const FONT_ROOT = path.join(REPO_ROOT, "assets", "fonts");
const TRAIT_DB_PATH = path.join(REPO_ROOT, "scripts", "trait_db.json");
const RENDERS_ROOT = path.join(APP_ROOT, "renders");
const NO_PALETTE_OUTPUT_ROOT = path.join(RENDERS_ROOT, "no-palette");
const NO_STUDIO_NOISE_GIF_ROOT = path.join(RENDERS_ROOT, "no-studio-noise-gif");
const NO_PALETTE_WORKER_PATH = path.join(APP_ROOT, "scripts", "nopalette_worker.py");
const NO_GALLERY_ROOT = path.join(DATA_ROOT, "no-gallery");
const NO_GALLERY_INDEX_PATH = path.join(NO_GALLERY_ROOT, "gallery.json");
const NO_GALLERY_DB_PATH = path.join(DATA_ROOT, "no-gallery.sqlite");
const NO_GALLERY_SCHEMA_VERSION = 3;
const HOLDER_DISCOVERY_ROOT = path.resolve(REPO_ROOT, "..", "nopunks-site", "public", "data", "holders");
const HOLDER_DISCOVERY_LATEST_PATH = path.join(HOLDER_DISCOVERY_ROOT, "latest.json");
const HOLDER_DISCOVERY_HISTORY_PATH = path.join(HOLDER_DISCOVERY_ROOT, "history.json");

const FEATURED_IDS = [7804, 0, 52, 9999, 214, 604, 1337, 420, 69, 8888];
const LEGACY_TOOL_ROUTES = new Set(["/tools/no-palette", "/tools/no-generate", "/tools/gif-lab", "/tools/tcg-forge"]);

let datasetCache = null;
let traitDbRawCache = null;

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || 0)));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toId(value) {
  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 0 || numeric > 9999) return null;
  return numeric;
}

function buildTraitSummary(traits) {
  const order = ["Type", "Hair", "Eyes", "Beard", "Mouth", "Smoke", "Mask", "Neck", "Face", "Nose", "Ears"];
  const seen = new Set();
  const pairs = [];

  for (const key of order) {
    if (traits[key]) {
      pairs.push(`${key}: ${traits[key]}`);
      seen.add(key);
    }
  }

  for (const [key, value] of Object.entries(traits)) {
    if (!seen.has(key) && value) {
      pairs.push(`${key}: ${value}`);
    }
  }

  return pairs.join(" · ");
}

function normalizePunkRecord(id, entry) {
  const traits = entry && typeof entry === "object" && entry.traits ? entry.traits : {};
  const name = String((entry && entry.name) || `No-Punk #${id}`);
  const traitSummary = buildTraitSummary(traits);
  const searchBlob = [
    String(id),
    `#${id}`,
    name,
    traitSummary,
    ...Object.keys(traits),
    ...Object.values(traits).map((value) => String(value)),
  ]
    .join(" | ")
    .toLowerCase();

  return {
    id,
    idText: String(id),
    name,
    type: String(traits.Type || "Unknown"),
    traits,
    traitSummary,
    previewUrl: `/transparent/${id}.png`,
    searchBlob,
  };
}

function loadTraitDbRaw() {
  if (!traitDbRawCache) {
    traitDbRawCache = readJson(TRAIT_DB_PATH);
  }
  return traitDbRawCache;
}

function loadDataset() {
  if (datasetCache) return datasetCache;

  const raw = loadTraitDbRaw();
  const byId = new Map();
  const list = [];

  for (const [idKey, entry] of Object.entries(raw.punks || {})) {
    const id = toId(idKey);
    if (id === null) continue;
    const record = normalizePunkRecord(id, entry);
    byId.set(id, record);
    list.push(record);
  }

  list.sort((a, b) => a.id - b.id);
  datasetCache = {
    total: Number(raw.total) || list.length,
    list,
    byId,
    loadedAt: new Date().toISOString(),
  };
  return datasetCache;
}

function scoreRecord(record, query) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  let score = 0;
  const idMatch = q.match(/^#?(\d{1,4})$/);
  if (idMatch) {
    const wanted = Number.parseInt(idMatch[1], 10);
    if (record.id === wanted) return 10000;
    if (record.idText.startsWith(idMatch[1])) score += 500;
  }

  if (record.name.toLowerCase() === q) score += 1400;
  if (record.name.toLowerCase().includes(q)) score += 700;
  if (record.traitSummary.toLowerCase().includes(q)) score += 650;
  if (record.type.toLowerCase() === q) score += 550;

  const terms = q.split(/[^a-z0-9#]+/).filter(Boolean);
  if (!terms.length) return score;

  let termMatches = 0;
  for (const term of terms) {
    if (record.searchBlob.includes(term)) {
      termMatches += 1;
      score += 120;
      if (record.idText === term) score += 300;
      if (record.idText.startsWith(term)) score += 120;
    }
  }

  if (termMatches === terms.length) score += 240;
  return score;
}

function serializeRecord(record) {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    traits: record.traits,
    traitSummary: record.traitSummary,
    previewUrl: record.previewUrl,
  };
}

function featuredResults(limit) {
  const { byId, list } = loadDataset();
  const items = [];
  const seen = new Set();

  for (const id of FEATURED_IDS) {
    const record = byId.get(id);
    if (!record) continue;
    items.push(serializeRecord(record));
    seen.add(id);
    if (items.length >= limit) return items;
  }

  for (const record of list) {
    if (seen.has(record.id)) continue;
    items.push(serializeRecord(record));
    if (items.length >= limit) break;
  }

  return items;
}

function searchPunks(query, rawLimit) {
  const limit = clampInt(rawLimit || 24, 1, 60) || 24;
  const q = String(query || "").trim();
  if (!q) return featuredResults(limit);

  const { list } = loadDataset();
  const scored = [];
  for (const record of list) {
    const score = scoreRecord(record, q);
    if (score > 0) scored.push({ score, record });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.record.id - b.record.id));
  return scored.slice(0, limit).map((entry) => serializeRecord(entry.record));
}

function contentType(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".otf")) return "font/otf";
  if (lower.endsWith(".ttf")) return "font/ttf";
  if (lower.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function requestViewerId(req) {
  return String(req.headers["x-no-gallery-anon-id"] || "").trim().slice(0, 128);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 50_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function safeResolve(baseDir, requestPath) {
  const clean = requestPath.replace(/\/+$/, "") || "/";
  const candidate = clean === "/" ? "/index.html" : clean;
  const resolved = path.resolve(baseDir, `.${candidate}`);
  if (!resolved.startsWith(baseDir)) return null;
  return resolved;
}

function serveStatic(res, baseDir, requestPath, options = {}) {
  const resolved = safeResolve(baseDir, requestPath);
  if (!resolved) return false;
  if (!fs.existsSync(resolved)) return false;
  const stats = fs.statSync(resolved);
  if (!stats.isFile()) return false;

  const data = fs.readFileSync(resolved);
  res.writeHead(200, {
    "content-type": contentType(resolved),
    "cache-control": options.cacheControl || "no-store",
  });
  res.end(data);
  return true;
}

function sendRedirect(res, location) {
  res.writeHead(302, {
    location,
    "cache-control": "no-store",
  });
  res.end();
}

function readNoGalleryEntries() {
  try {
    if (!fs.existsSync(NO_GALLERY_INDEX_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(NO_GALLERY_INDEX_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeNoGalleryEntries(entries) {
  fs.writeFileSync(NO_GALLERY_INDEX_PATH, JSON.stringify(entries, null, 2));
}

function sanitizeText(value, maxLength = 140) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeCurationLabel(value, tokenId = 0) {
  const raw = sanitizeText(value, 160) || `No-Studio #${Number(tokenId) || 0}`;
  return raw.replace(/\bsurprise\s+world\b/gi, "No-Curation");
}

function sanitizeSignatureHandle(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 15);
  return cleaned ? `@${cleaned}` : "";
}

function sanitizeHexColor(value) {
  const raw = String(value || "").trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(raw) ? raw : null;
}

function sanitizePalette(value) {
  if (!Array.isArray(value)) return [];
  const dedupe = new Set();
  const out = [];
  for (const entry of value) {
    const hex = sanitizeHexColor(entry);
    if (!hex || dedupe.has(hex)) continue;
    dedupe.add(hex);
    out.push(hex);
    if (out.length >= 64) break;
  }
  return out;
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => Number(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function extractPaletteFromPng(buffer, limit = 64) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return [];
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) return [];

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let paletteTable = null;
  const idatParts = [];

  for (let offset = 8; offset + 8 <= buffer.length;) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const crcEnd = dataEnd + 4;
    if (dataEnd > buffer.length || crcEnd > buffer.length) return [];
    const chunkData = buffer.subarray(dataStart, dataEnd);

    if (chunkType === "IHDR" && chunkData.length >= 13) {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlace = chunkData[12];
    } else if (chunkType === "PLTE") {
      paletteTable = chunkData;
    } else if (chunkType === "IDAT") {
      idatParts.push(chunkData);
    } else if (chunkType === "IEND") {
      break;
    }

    offset = crcEnd;
  }

  if (!width || !height || !idatParts.length) return [];
  if (interlace !== 0 || bitDepth !== 8) return [];

  const bytesPerPixelByType = {
    0: 1, // grayscale
    2: 3, // truecolor
    3: 1, // indexed
    4: 2, // grayscale + alpha
    6: 4, // truecolor + alpha
  };
  const bpp = bytesPerPixelByType[colorType];
  if (!bpp) return [];

  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idatParts));
  } catch {
    return [];
  }

  const rowLen = width * bpp;
  const expectedMin = (rowLen + 1) * height;
  if (inflated.length < expectedMin) return [];

  const seen = new Set();
  const palette = [];
  const addHex = (r, g, b, a = 255) => {
    if (a === 0) return;
    const hex = rgbToHex(r, g, b);
    if (seen.has(hex)) return;
    seen.add(hex);
    palette.push(hex);
  };

  let pos = 0;
  let prev = new Uint8Array(rowLen);

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[pos];
    pos += 1;
    if (pos + rowLen > inflated.length) return [];
    const rowIn = inflated.subarray(pos, pos + rowLen);
    pos += rowLen;
    const rowOut = new Uint8Array(rowLen);

    for (let i = 0; i < rowLen; i += 1) {
      const raw = rowIn[i];
      const left = i >= bpp ? rowOut[i - bpp] : 0;
      const up = prev[i] || 0;
      const upLeft = i >= bpp ? (prev[i - bpp] || 0) : 0;
      if (filterType === 0) {
        rowOut[i] = raw;
      } else if (filterType === 1) {
        rowOut[i] = (raw + left) & 0xff;
      } else if (filterType === 2) {
        rowOut[i] = (raw + up) & 0xff;
      } else if (filterType === 3) {
        rowOut[i] = (raw + Math.floor((left + up) / 2)) & 0xff;
      } else if (filterType === 4) {
        rowOut[i] = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      } else {
        return [];
      }
    }

    for (let x = 0; x < width; x += 1) {
      const base = x * bpp;
      if (colorType === 6) {
        addHex(rowOut[base], rowOut[base + 1], rowOut[base + 2], rowOut[base + 3]);
      } else if (colorType === 2) {
        addHex(rowOut[base], rowOut[base + 1], rowOut[base + 2], 255);
      } else if (colorType === 4) {
        const gray = rowOut[base];
        addHex(gray, gray, gray, rowOut[base + 1]);
      } else if (colorType === 0) {
        const gray = rowOut[base];
        addHex(gray, gray, gray, 255);
      } else if (colorType === 3) {
        const idx = rowOut[base] * 3;
        if (!paletteTable || idx + 2 >= paletteTable.length) continue;
        addHex(paletteTable[idx], paletteTable[idx + 1], paletteTable[idx + 2], 255);
      }
      if (palette.length >= limit) return palette;
    }

    prev = rowOut;
  }

  return palette;
}

function inferPaletteFromMediaBuffer(buffer, mediaType) {
  if (String(mediaType || "").toLowerCase() === "png") {
    return sanitizePalette(extractPaletteFromPng(buffer, 64));
  }
  return [];
}

function inferPaletteFromGalleryFile(fileName) {
  const safeName = String(fileName || "");
  if (!/^[a-zA-Z0-9._-]+\.(png|gif)$/i.test(safeName)) return [];
  const filePath = path.join(NO_GALLERY_ROOT, safeName);
  if (!filePath.startsWith(NO_GALLERY_ROOT) || !fs.existsSync(filePath)) return [];
  const mediaType = safeName.toLowerCase().endsWith(".gif") ? "gif" : "png";
  try {
    return inferPaletteFromMediaBuffer(fs.readFileSync(filePath), mediaType);
  } catch {
    return [];
  }
}

function galleryItemUrls(fileName, useNoStudioPrefix) {
  const prefix = useNoStudioPrefix ? "/api/no-studio" : "/api/no-palette";
  const encoded = encodeURIComponent(fileName);
  const mediaUrl = `${prefix}/gallery/files/${encoded}`;
  const isGif = fileName.toLowerCase().endsWith(".gif");
  return {
    mediaUrl,
    thumbUrl: mediaUrl,
    viewUrl: mediaUrl,
    mediaType: isGif ? "gif" : "png",
    pngUrl: isGif ? null : mediaUrl,
    gifUrl: isGif ? mediaUrl : null,
  };
}

function normalizeGalleryEntry(entry, useNoStudioPrefix) {
  const fileName = String(entry.fileName || "");
  const signatureHandle = sanitizeSignatureHandle(
    entry.signatureHandle || entry.signature || entry.twitterHandle || "",
  );
  let palette = sanitizePalette(entry.palette || entry.paletteHexes || []);
  const inferred = inferPaletteFromGalleryFile(fileName);
  if (inferred.length && inferred.length > palette.length) {
    palette = inferred;
  } else if (!palette.length) {
    palette = inferred;
  }
  return {
    id: String(entry.id || ""),
    tokenId: Number(entry.tokenId) || 0,
    family: sanitizeText(entry.family, 32),
    label: normalizeCurationLabel(entry.label, entry.tokenId),
    createdAt: entry.createdAt,
    signatureHandle,
    palette,
    paletteCount: palette.length,
    rolePair: entry.rolePair && typeof entry.rolePair === "object"
      ? {
          background: sanitizeText(entry.rolePair.background, 7),
          figure: sanitizeText(entry.rolePair.figure, 7),
          mode: sanitizeText(entry.rolePair.mode, 12),
        }
      : null,
    schemaVersion: Number(entry?.schemaVersion) || 0,
    ...galleryItemUrls(fileName, useNoStudioPrefix),
  };
}

function saveNoGalleryEntry({
  tokenId,
  mediaDataUrl,
  pngDataUrl,
  gifDataUrl,
  label,
  family,
  rolePair,
  signatureHandle,
  signature,
  twitterHandle,
  palette,
  paletteHexes,
}, useNoStudioPrefix) {
  const rawDataUrl = String(mediaDataUrl || gifDataUrl || pngDataUrl || "");
  const match = /^data:image\/(png|gif);base64,([A-Za-z0-9+/=]+)$/.exec(rawDataUrl);
  if (!match) {
    throw new Error("Invalid media payload");
  }
  const mediaType = String(match[1]).toLowerCase();
  const imageBuffer = Buffer.from(match[2], "base64");
  if (!imageBuffer.length) {
    throw new Error("Empty media payload");
  }
  const maxBytes = mediaType === "gif" ? 24_000_000 : 8_000_000;
  if (imageBuffer.length > maxBytes) {
    throw new Error(mediaType === "gif" ? "GIF too large" : "PNG too large");
  }

  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const fileName = `no-gallery-${id}.${mediaType}`;
  const filePath = path.join(NO_GALLERY_ROOT, fileName);
  if (!filePath.startsWith(NO_GALLERY_ROOT)) {
    throw new Error("Invalid gallery path");
  }
  fs.writeFileSync(filePath, imageBuffer);

  const entries = readNoGalleryEntries();
  const normalizedSignature = sanitizeSignatureHandle(
    signatureHandle || signature || twitterHandle || "",
  );
  let normalizedPalette = sanitizePalette(palette || paletteHexes || []);
  const inferredPalette = inferPaletteFromMediaBuffer(imageBuffer, mediaType);
  if (inferredPalette.length && inferredPalette.length > normalizedPalette.length) {
    normalizedPalette = inferredPalette;
  } else if (!normalizedPalette.length) {
    normalizedPalette = inferredPalette;
  }
  const nextEntry = {
    id,
    fileName,
    tokenId: Number(tokenId) || 0,
    family: sanitizeText(family, 32),
    label: normalizeCurationLabel(label, tokenId),
    createdAt: new Date().toISOString(),
    signatureHandle: normalizedSignature,
    palette: normalizedPalette,
    rolePair: rolePair && typeof rolePair === "object"
      ? {
          background: sanitizeText(rolePair.background, 7),
          figure: sanitizeText(rolePair.figure, 7),
          mode: sanitizeText(rolePair.mode, 12),
        }
      : null,
    schemaVersion: NO_GALLERY_SCHEMA_VERSION,
  };
  entries.unshift(nextEntry);

  while (entries.length > 120) {
    const removed = entries.pop();
    if (!removed || !removed.fileName) continue;
    const removedPath = path.join(NO_GALLERY_ROOT, removed.fileName);
    if (removedPath.startsWith(NO_GALLERY_ROOT) && fs.existsSync(removedPath)) {
      try {
        fs.unlinkSync(removedPath);
      } catch {
        // ignore old file cleanup failures
      }
    }
  }

  writeNoGalleryEntries(entries);
  return normalizeGalleryEntry(nextEntry, useNoStudioPrefix);
}

function createServer({
  port = Number(process.env.PORT) || 8792,
  host = process.env.HOST || "127.0.0.1",
  galleryRoot = NO_GALLERY_ROOT,
  galleryDbPath = NO_GALLERY_DB_PATH,
  galleryIndexPath = NO_GALLERY_INDEX_PATH,
} = {}) {
  loadDataset();
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.mkdirSync(NO_PALETTE_OUTPUT_ROOT, { recursive: true });
  fs.mkdirSync(NO_STUDIO_NOISE_GIF_ROOT, { recursive: true });
  fs.mkdirSync(galleryRoot, { recursive: true });
  const globalGalleryEnabled = process.env.GLOBAL_GALLERY_ENABLED !== "0";
  const galleryRateLimitWindowMs = clampInt(process.env.GALLERY_RATE_LIMIT_WINDOW_MS || 60_000, 1_000, 3_600_000);
  const galleryRateLimitMax = clampInt(process.env.GALLERY_RATE_LIMIT_MAX || 18, 1, 500);

  const noPaletteDb = new NoPaletteDatabase({
    dbPath: path.join(DATA_ROOT, "no-palette.sqlite"),
  });
  const rarityService = new NoPaletteRarityService({
    db: noPaletteDb,
    traitDbRaw: loadTraitDbRaw(),
  });
  const blockSource = new EthereumBlockSource();
  const noPalette = new NoPaletteGenerationService({
    db: noPaletteDb,
    rarityService,
    blockSource,
    workerScriptPath: NO_PALETTE_WORKER_PATH,
    outputRoot: NO_PALETTE_OUTPUT_ROOT,
  });
  const galleryStore = globalGalleryEnabled
    ? new GalleryStore({
        dbPath: galleryDbPath,
        galleryRoot,
      })
    : null;
  const recoveryFaults = createRecoveryFaultsService({
    traitDbPath: TRAIT_DB_PATH,
    transparentRoot: TRANSPARENT_ROOT,
    holderSnapshotPath: HOLDER_DISCOVERY_LATEST_PATH,
    holderHistoryPath: HOLDER_DISCOVERY_HISTORY_PATH,
  });
  if (galleryStore && fs.existsSync(galleryIndexPath)) {
    galleryStore.migrateJsonIndex({
      jsonPath: galleryIndexPath,
      useNoStudioPrefix: true,
    });
  }
  const galleryWriteLimits = new Map();

  function requestIp(req) {
    return String(
      req.headers["x-forwarded-for"]
        || req.headers["x-real-ip"]
        || req.socket?.remoteAddress
        || "unknown"
    ).split(",")[0].trim() || "unknown";
  }

  function enforceGalleryWriteRateLimit(req) {
    const key = requestIp(req);
    const now = Date.now();
    const record = galleryWriteLimits.get(key);
    if (!record || (now - record.windowStart) >= galleryRateLimitWindowMs) {
      galleryWriteLimits.set(key, { windowStart: now, count: 1 });
      return;
    }
    if (record.count >= galleryRateLimitMax) {
      const error = new Error("No-Gallery save rate limit exceeded");
      error.statusCode = 429;
      throw error;
    }
    record.count += 1;
    galleryWriteLimits.set(key, record);
  }

  function rewriteNoStudioUrls(value) {
    if (typeof value === "string") {
      return value.replaceAll("/api/no-palette/", "/api/no-studio/");
    }
    if (Array.isArray(value)) {
      return value.map((entry) => rewriteNoStudioUrls(entry));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, rewriteNoStudioUrls(inner)]));
    }
    return value;
  }

  async function handleRequest(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = (url.pathname || "/").replace(/\/+$/, "") || "/";
      const method = req.method || "GET";

      if (method === "GET" && pathname === "/api/health") {
        const ds = loadDataset();
        return sendJson(res, 200, {
          ok: true,
          app: "no-studio",
          product: "No-Studio",
          totalPunks: ds.total,
          loadedAt: ds.loadedAt,
          hasTransparentAssets: fs.existsSync(TRANSPARENT_ROOT),
          hasNoPaletteDb: fs.existsSync(path.join(DATA_ROOT, "no-palette.sqlite")) || fs.existsSync(path.join(DATA_ROOT, "no-palette.json")),
          now: new Date().toISOString(),
        });
      }

      if (method === "GET" && pathname === "/api/recovery-faults/config") {
        return sendJson(res, 200, recoveryFaults.getConfig());
      }

      if (method === "GET" && pathname.startsWith("/api/recovery-faults/holder/")) {
        const address = normalizeAddress(pathname.slice("/api/recovery-faults/holder/".length));
        if (!address) return sendJson(res, 400, { ok: false, error: "Invalid address" });
        const config = recoveryFaults.getConfig();
        const holder = recoveryFaults.getHolder(address);
        if (!holder) {
          return sendJson(res, 404, {
            ok: false,
            error: "Holder not found in snapshot",
            address,
            balance: 0,
            tokenIds: [],
            holderSnapshot: config.holderSnapshot,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          address,
          balance: holder.balance,
          tokenIds: holder.tokenIds,
          lastActivity: holder.lastActivity,
          holderSnapshot: config.holderSnapshot,
          claimAuthority: {
            mode: "live-ownerOf",
            sourceCollection: config.contracts.v2,
            note: "Snapshot data is for holder discovery only. Claim eligibility is enforced onchain by ownerOf(tokenId).",
          },
        });
      }

      if (method === "GET" && pathname.startsWith("/api/recovery-faults/features/")) {
        const id = toId(pathname.slice("/api/recovery-faults/features/".length));
        if (id === null) return sendJson(res, 400, { ok: false, error: "Invalid tokenId" });
        return sendJson(res, 200, recoveryFaults.getFeaturePack(id));
      }

      if (method === "GET" && pathname === "/api/search") {
        const q = url.searchParams.get("q") || "";
        const limit = url.searchParams.get("limit") || "24";
        const items = searchPunks(q, limit);
        return sendJson(res, 200, {
          ok: true,
          query: q,
          count: items.length,
          items,
        });
      }

      if (method === "GET" && (pathname === "/api/no-palette/config" || pathname === "/api/no-studio/config")) {
        const config = await noPalette.getConfig();
        return sendJson(res, 200, {
          ok: true,
          product: "No-Studio",
          reductions: ["none", "silhouette", "ghost", "outline-only", "trait-echo", "no-minimalism"],
          ditherEngines: ["diffuse", "bayer", "cluster", "scan"],
          noMinimalismVisibilityModes: ["exact", "soft", "hard"],
          machineDrawerEnabled: true,
          noGalleryAvailable: true,
          globalGalleryEnabled,
          ...config,
        });
      }

      if (method === "GET" && pathname === "/api/no-studio/gallery/home") {
        if (!galleryStore) {
          return sendJson(res, 503, { ok: false, error: "Shared No-Gallery is not configured" });
        }
        const payload = galleryStore.getHome({
          sort: url.searchParams.get("sort") || "new",
          viewerId: requestViewerId(req),
          liveLimit: clampInt(url.searchParams.get("liveLimit") || 120, 1, 120),
          archiveLimit: clampInt(url.searchParams.get("archiveLimit") || 24, 1, 52),
          useNoStudioPrefix: true,
        });
        return sendJson(res, 200, payload);
      }

      if (method === "GET" && pathname.startsWith("/api/no-studio/gallery/week/")) {
        if (!galleryStore) {
          return sendJson(res, 503, { ok: false, error: "Shared No-Gallery is not configured" });
        }
        const weekId = decodeURIComponent(pathname.slice("/api/no-studio/gallery/week/".length));
        try {
          const payload = galleryStore.getWeekDetail(weekId, {
            sort: url.searchParams.get("sort") || "new",
            limit: clampInt(url.searchParams.get("limit") || 120, 1, 120),
            offset: clampInt(url.searchParams.get("offset") || 0, 0, 100000),
            viewerId: requestViewerId(req),
            useNoStudioPrefix: true,
          });
          return sendJson(res, 200, payload);
        } catch (error) {
          return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || "Gallery week unavailable" });
        }
      }

      if (method === "GET" && (pathname === "/api/no-palette/gallery" || pathname === "/api/no-studio/gallery")) {
        if (!galleryStore) {
          return sendJson(res, 503, { ok: false, error: "Shared No-Gallery is not configured" });
        }
        const useNoStudioPrefix = pathname.startsWith("/api/no-studio/");
        const payload = galleryStore.listEntries({
          limit: clampInt(url.searchParams.get("limit") || 18, 1, 120),
          offset: clampInt(url.searchParams.get("offset") || 0, 0, 100000),
          family: url.searchParams.get("family") || null,
          tokenId: url.searchParams.get("tokenId") || null,
          mediaType: url.searchParams.get("mediaType") || null,
          signature: url.searchParams.get("signature") || null,
          sort: url.searchParams.get("sort") || "new",
          viewerId: requestViewerId(req),
          useNoStudioPrefix,
        });
        return sendJson(res, 200, payload);
      }

      if ((method === "GET" || method === "HEAD") && (pathname.startsWith("/api/no-palette/gallery/files/") || pathname.startsWith("/api/no-studio/gallery/files/"))) {
        const fileName = decodeURIComponent(pathname.split("/").pop() || "");
        if (!/^[a-zA-Z0-9._-]+\.(png|gif)$/i.test(fileName)) {
          return sendJson(res, 400, { ok: false, error: "Invalid gallery file name" });
        }
        const filePath = path.join(galleryRoot, fileName);
        if (!filePath.startsWith(galleryRoot) || !fs.existsSync(filePath)) {
          return sendJson(res, 404, { ok: false, error: "Gallery file not found" });
        }
        const lower = fileName.toLowerCase();
        const headers = {
          "content-type": lower.endsWith(".gif") ? "image/gif" : "image/png",
          "cache-control": "no-store",
        };
        if (url.searchParams.get("download") === "1") {
          headers["content-disposition"] = `attachment; filename=\"${fileName}\"`;
        }
        res.writeHead(200, headers);
        if (method === "HEAD") {
          res.end();
          return;
        }
        res.end(fs.readFileSync(filePath));
        return;
      }

      if (method === "GET" && (pathname === "/api/no-palette/block/head" || pathname === "/api/no-studio/block/head")) {
        try {
          const block = await noPalette.getHead();
          return sendJson(res, 200, {
            ok: true,
            block,
          });
        } catch (error) {
          return sendJson(res, 503, {
            ok: false,
            error: error && error.message ? error.message : "live-head-unavailable",
          });
        }
      }

      if (method === "GET" && (pathname.startsWith("/api/no-palette/rarity/") || pathname.startsWith("/api/no-studio/rarity/"))) {
        const prefix = pathname.startsWith("/api/no-studio/rarity/") ? "/api/no-studio/rarity/" : "/api/no-palette/rarity/";
        const id = toId(pathname.slice(prefix.length));
        if (id === null) return sendJson(res, 400, { ok: false, error: "Invalid tokenId" });
        const record = loadDataset().byId.get(id);
        if (!record) return sendJson(res, 404, { ok: false, error: "NoPunk not found" });
        const rarity = await noPalette.getRarity(id);
        return sendJson(res, 200, {
          ok: true,
          tokenId: id,
          rarity,
        });
      }

      if (method === "GET" && (pathname.startsWith("/api/no-palette/history/") || pathname.startsWith("/api/no-studio/history/"))) {
        const prefix = pathname.startsWith("/api/no-studio/history/") ? "/api/no-studio/history/" : "/api/no-palette/history/";
        const id = toId(pathname.slice(prefix.length));
        if (id === null) return sendJson(res, 400, { ok: false, error: "Invalid tokenId" });
        const limit = clampInt(url.searchParams.get("limit") || 12, 1, 100);
        const offset = clampInt(url.searchParams.get("offset") || 0, 0, 10000);
        const mode = url.searchParams.get("mode") || null;
        const outputKind = url.searchParams.get("outputKind") || null;
        const items = noPalette.getHistory(id, { limit, offset, mode, outputKind });
        const normalizedItems = pathname.startsWith("/api/no-studio/") ? rewriteNoStudioUrls(items) : items;
        return sendJson(res, 200, {
          ok: true,
          tokenId: id,
          count: normalizedItems.length,
          items: normalizedItems,
        });
      }

      if ((method === "GET" || method === "HEAD") && (pathname.startsWith("/api/no-palette/files/") || pathname.startsWith("/api/no-studio/files/"))) {
        const match = pathname.match(/^\/api\/(?:no-palette|no-studio)\/files\/([^/]+)\/([^/]+)$/);
        if (!match) return sendJson(res, 400, { ok: false, error: "Invalid No-Palette file path" });
        const resolved = noPalette.resolveFile(match[1], decodeURIComponent(match[2]));
        if (!resolved) return sendJson(res, 404, { ok: false, error: "No-Palette file not found" });
        const headers = {
          "content-type": contentType(resolved.filePath),
          "cache-control": "no-store",
        };
        if (url.searchParams.get("download") === "1") {
          headers["content-disposition"] = `attachment; filename=\"${resolved.fileName}\"`;
        }
        res.writeHead(200, headers);
        if (method === "HEAD") {
          res.end();
          return;
        }
        res.end(fs.readFileSync(resolved.filePath));
        return;
      }

      if ((method === "GET" || method === "HEAD") && (pathname.startsWith("/api/no-palette/noise-gif/") || pathname.startsWith("/api/no-studio/noise-gif/"))) {
        const fileName = decodeURIComponent(pathname.split("/").pop() || "");
        if (!/^[a-zA-Z0-9._-]+\.gif$/.test(fileName)) {
          return sendJson(res, 400, { ok: false, error: "Invalid GIF file name" });
        }
        const filePath = path.join(NO_STUDIO_NOISE_GIF_ROOT, fileName);
        if (!filePath.startsWith(NO_STUDIO_NOISE_GIF_ROOT) || !fs.existsSync(filePath)) {
          return sendJson(res, 404, { ok: false, error: "GIF not found" });
        }
        const headers = {
          "content-type": "image/gif",
          "cache-control": "no-store",
        };
        if (url.searchParams.get("download") === "1") {
          headers["content-disposition"] = `attachment; filename=\"${fileName}\"`;
        }
        res.writeHead(200, headers);
        if (method === "HEAD") {
          res.end();
          return;
        }
        res.end(fs.readFileSync(filePath));
        return;
      }

      if (method === "POST" && (pathname === "/api/no-palette/generate" || pathname === "/api/no-studio/render")) {
        const body = await parseBody(req);
        const id = toId(body && body.tokenId);
        if (id === null) return sendJson(res, 400, { ok: false, error: "Invalid tokenId" });
        const record = loadDataset().byId.get(id);
        if (!record) return sendJson(res, 404, { ok: false, error: "NoPunk not found" });
        const mode = body && body.mode != null ? String(body.mode) : "canonical-machine";
        const blockNumber = body && body.blockNumber != null ? Number(body.blockNumber) : null;
        const outputKind = body && body.outputKind != null ? String(body.outputKind) : "single";
        const imagePath = path.join(TRANSPARENT_ROOT, `${id}.png`);
        if (!fs.existsSync(imagePath)) return sendJson(res, 404, { ok: false, error: "Transparent asset not found" });

        const generated = await noPalette.generate({ tokenId: id, mode, blockNumber, outputKind, imagePath });
        const payload = pathname === "/api/no-studio/render" ? rewriteNoStudioUrls(generated) : generated;
        return sendJson(res, 200, payload);
      }

      if (method === "POST" && (pathname === "/api/no-palette/noise-gif" || pathname === "/api/no-studio/noise-gif")) {
        const body = await parseBody(req);
        const id = toId(body && body.tokenId);
        if (id === null) return sendJson(res, 400, { ok: false, error: "Invalid tokenId" });
        const rgba24B64 = body && typeof body.rgba24B64 === "string" ? body.rgba24B64 : "";
        if (!rgba24B64) return sendJson(res, 400, { ok: false, error: "Missing rgba24B64" });
        const grain = body && body.grain && typeof body.grain === "object" ? body.grain : null;
        if (!grain || !grain.enabled || !(Number(grain.amount) > 0)) {
          return sendJson(res, 400, { ok: false, error: "Animated GIF export requires active grain" });
        }
        const noiseMask = Array.isArray(body && body.noiseMask) ? body.noiseMask.map((v) => String(v)) : [];
        const nonce = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        const fileName = `no-studio-${id}-${nonce}.gif`;
        const outputPath = path.join(NO_STUDIO_NOISE_GIF_ROOT, fileName);

        const renderResult = await renderNoPaletteNoiseGif({
          workerScriptPath: NO_PALETTE_WORKER_PATH,
          outputPath,
          size: 1024,
          frames: 12,
          durationMs: 1000,
          rgba24Bytes: rgba24B64,
          noiseMask,
          grain,
        });

        const payload = {
          ok: true,
          tokenId: id,
          output: {
            kind: "gif",
            width: renderResult.width,
            height: renderResult.height,
            frames: renderResult.frames,
            durationMs: renderResult.durationMs,
            bytes: renderResult.bytes,
            gifUrl: `${pathname.startsWith("/api/no-studio/") ? "/api/no-studio" : "/api/no-palette"}/noise-gif/${encodeURIComponent(fileName)}`,
          },
        };
        return sendJson(res, 200, payload);
      }

      if (method === "POST" && (pathname === "/api/no-palette/gallery" || pathname === "/api/no-studio/gallery")) {
        if (!galleryStore) {
          return sendJson(res, 503, { ok: false, error: "Shared No-Gallery is not configured" });
        }
        enforceGalleryWriteRateLimit(req);
        const body = await parseBody(req);
        const id = toId(body && body.tokenId);
        if (id === null) return sendJson(res, 400, { ok: false, error: "Invalid tokenId" });
        const record = loadDataset().byId.get(id);
        if (!record) return sendJson(res, 404, { ok: false, error: "NoPunk not found" });
        const payload = galleryStore.saveEntry({
          tokenId: id,
          mediaDataUrl: body && body.mediaDataUrl,
          pngDataUrl: body && body.pngDataUrl,
          gifDataUrl: body && body.gifDataUrl,
          mediaType: body && body.mediaType,
          family: body && body.family,
          rolePair: body && body.rolePair,
          signatureHandle: body && sanitizeSignatureHandle(body.signatureHandle || body.signature || body.twitterHandle),
          palette: body && body.palette,
          paletteHexes: body && body.paletteHexes,
          provenance: body && body.provenance,
        }, {
          useNoStudioPrefix: pathname.startsWith("/api/no-studio/"),
        });
        return sendJson(res, 200, payload);
      }

      if (method === "POST" && pathname === "/api/no-studio/gallery/react") {
        if (!galleryStore) {
          return sendJson(res, 503, { ok: false, error: "Shared No-Gallery is not configured" });
        }
        const body = await parseBody(req);
        try {
          const payload = galleryStore.reactEntry(body && body.id, requestViewerId(req), body && body.reaction, {
            useNoStudioPrefix: true,
          });
          return sendJson(res, 200, payload);
        } catch (error) {
          return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || "Reaction failed" });
        }
      }

      if (method === "POST" && pathname === "/api/no-studio/gallery/vote") {
        if (!galleryStore) {
          return sendJson(res, 503, { ok: false, error: "Shared No-Gallery is not configured" });
        }
        const body = await parseBody(req);
        try {
          const payload = galleryStore.reactEntry(body && body.id, requestViewerId(req), body && body.reaction ? body.reaction : "no", {
            useNoStudioPrefix: true,
          });
          return sendJson(res, 200, payload);
        } catch (error) {
          return sendJson(res, error.statusCode || 500, { ok: false, error: error.message || "Vote failed" });
        }
      }

      if (method === "GET" && pathname.startsWith("/api/punk/")) {
        const id = toId(pathname.slice("/api/punk/".length));
        if (id === null) return sendJson(res, 400, { ok: false, error: "Invalid NoPunk id" });
        const record = loadDataset().byId.get(id);
        if (!record) return sendJson(res, 404, { ok: false, error: "NoPunk not found" });
        return sendJson(res, 200, {
          ok: true,
          item: serializeRecord(record),
          transformHint: {
            rule: "No-Palette remaps colors at 24x24, derives canonical states from Ethereum block numbers, and preserves the #000000/#040404 role delta.",
            examples: [
              "background role => mixed B",
              "outline role => clamp(B + #040404)",
              "state => token + mode + block",
            ],
          },
        });
      }

      if (LEGACY_TOOL_ROUTES.has(pathname)) {
        return sendRedirect(res, "/tools/no-studio");
      }

      if (pathname.startsWith("/transparent/")) {
        const relativePath = pathname.slice("/transparent".length) || "/";
        if (serveStatic(res, TRANSPARENT_ROOT, relativePath, { cacheControl: "public, max-age=86400" })) {
          return;
        }
        return sendJson(res, 404, { ok: false, error: "Transparent asset not found" });
      }

      if (pathname.startsWith("/fonts/")) {
        const relativePath = pathname.slice("/fonts".length) || "/";
        if (serveStatic(res, FONT_ROOT, relativePath, { cacheControl: "public, max-age=31536000, immutable" })) {
          return;
        }
        return sendJson(res, 404, { ok: false, error: "Font not found" });
      }

      if (method === "GET" || method === "HEAD") {
        if (serveStatic(res, WEB_ROOT, pathname)) return;
        if (serveStatic(res, WEB_ROOT, "/index.html")) return;
      }
      return sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      return sendJson(res, error && error.statusCode ? error.statusCode : 500, {
        ok: false,
        error: error && error.message ? error.message : "Internal server error",
      });
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });

  return {
    host,
    port,
    server,
    handleRequest,
    noPalette,
    noPaletteDb,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          resolve({
            host,
            port: address && typeof address === "object" ? address.port : port,
          });
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      noPaletteDb.close();
      if (galleryStore) galleryStore.close();
      if (!server.listening) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

if (require.main === module) {
  const app = createServer();
  app.listen().then(({ host, port }) => {
    process.stdout.write(`No-Studio local app listening on http://${host}:${port}\n`);
  }).catch((error) => {
    process.stderr.write(`No-Studio failed to start: ${error && error.message ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createServer,
  loadDataset,
  loadTraitDbRaw,
  searchPunks,
};
