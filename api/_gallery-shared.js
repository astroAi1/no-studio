"use strict";

const crypto = require("node:crypto");
const { list, put } = require("@vercel/blob");

const INDEX_KEY = "no-gallery/index-v3.json";
const MEDIA_PREFIX = "no-gallery/media";
const MAX_GALLERY_ITEMS = 240;
const NO_GALLERY_SCHEMA_VERSION = 3;

function sanitizeText(value, maxLength = 160) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeSignatureHandle(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 15);
  return cleaned ? `@${cleaned}` : "";
}

function sanitizeHex(value) {
  const hex = String(value || "").trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(hex) ? hex : null;
}

function sanitizePalette(value) {
  if (!Array.isArray(value)) return [];
  const dedupe = new Set();
  const out = [];
  for (const item of value) {
    const hex = sanitizeHex(item);
    if (!hex || dedupe.has(hex)) continue;
    dedupe.add(hex);
    out.push(hex);
    if (out.length >= 64) break;
  }
  return out;
}

function normalizeCurationLabel(label, tokenId) {
  const base = sanitizeText(label, 160) || `No-Curation #${Number(tokenId) || 0}`;
  return base.replace(/\bsurprise\s+world\b/gi, "No-Curation");
}

function parseDataUrl(value) {
  const raw = String(value || "");
  const match = /^data:image\/(png|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
  if (!match) {
    throw new Error("Invalid media payload");
  }
  const mediaType = String(match[1]).toLowerCase();
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) {
    throw new Error("Empty media payload");
  }
  const maxBytes = mediaType === "gif" ? 24_000_000 : 8_000_000;
  if (bytes.length > maxBytes) {
    throw new Error(mediaType === "gif" ? "GIF too large" : "PNG too large");
  }
  return { mediaType, bytes };
}

function normalizeRolePair(value) {
  if (!value || typeof value !== "object") return null;
  return {
    background: sanitizeText(value.background, 7),
    figure: sanitizeText(value.figure, 7),
    mode: sanitizeText(value.mode, 12),
  };
}

function toPublicEntry(entry) {
  const mediaType = String(entry.mediaType || "").toLowerCase() === "gif" ? "gif" : "png";
  const mediaUrl = sanitizeText(entry.mediaUrl, 1024);
  const palette = sanitizePalette(entry.palette || entry.paletteHexes || []);
  return {
    id: String(entry.id || ""),
    tokenId: Number(entry.tokenId) || 0,
    family: sanitizeText(entry.family, 32) || "studio",
    label: normalizeCurationLabel(entry.label, entry.tokenId),
    createdAt: entry.createdAt || new Date().toISOString(),
    signatureHandle: sanitizeSignatureHandle(
      entry.signatureHandle || entry.signature || entry.twitterHandle || "",
    ),
    palette,
    paletteCount: palette.length,
    rolePair: normalizeRolePair(entry.rolePair),
    mediaType,
    mediaUrl,
    viewUrl: mediaUrl,
    thumbUrl: mediaUrl,
    pngUrl: mediaType === "png" ? mediaUrl : null,
    gifUrl: mediaType === "gif" ? mediaUrl : null,
    schemaVersion: Number(entry?.schemaVersion) || 0,
  };
}

async function parseJsonBody(req) {
  if (req && req.body && typeof req.body === "object") {
    return req.body;
  }
  if (req && typeof req.body === "string" && req.body.trim()) {
    return JSON.parse(req.body);
  }
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk || "");
      if (raw.length > 32_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

async function loadGalleryIndex() {
  const listing = await list({ prefix: INDEX_KEY, limit: 1 });
  const blob = Array.isArray(listing.blobs) ? listing.blobs.find((item) => item.pathname === INDEX_KEY) : null;
  if (!blob) {
    return [];
  }
  const response = await fetch(blob.url, { cache: "no-store" });
  if (!response.ok) {
    return [];
  }
  const parsed = await response.json().catch(() => []);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed;
}

async function saveGalleryIndex(entries) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map((entry) => toPublicEntry(entry))
    .filter((entry) => entry.id && entry.mediaUrl && entry.schemaVersion === NO_GALLERY_SCHEMA_VERSION)
    .slice(0, MAX_GALLERY_ITEMS)
    .map((entry) => ({
      id: entry.id,
      tokenId: entry.tokenId,
      family: entry.family,
      label: entry.label,
      createdAt: entry.createdAt,
      signatureHandle: entry.signatureHandle,
      palette: entry.palette,
      rolePair: entry.rolePair,
      mediaType: entry.mediaType,
      mediaUrl: entry.mediaUrl,
      schemaVersion: NO_GALLERY_SCHEMA_VERSION,
    }));

  await put(INDEX_KEY, JSON.stringify(normalized, null, 2), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json; charset=utf-8",
  });

  return normalized;
}

async function listGalleryEntries(limit = 120) {
  const max = Math.max(1, Math.min(500, Number(limit) || 120));
  const index = await loadGalleryIndex();
  return index
    .map((entry) => toPublicEntry(entry))
    .filter((entry) => (
      entry.id
      && entry.mediaUrl
      && Number(entry.schemaVersion) === NO_GALLERY_SCHEMA_VERSION
    ))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, max);
}

async function saveGalleryEntry(payload) {
  const tokenId = Number(payload?.tokenId);
  if (!Number.isInteger(tokenId) || tokenId < 0) {
    throw new Error("Invalid tokenId");
  }

  const mediaDataUrl = payload?.mediaDataUrl || payload?.pngDataUrl || payload?.gifDataUrl || "";
  const { mediaType, bytes } = parseDataUrl(mediaDataUrl);
  const now = Date.now();
  const id = `${now}-${crypto.randomBytes(4).toString("hex")}`;
  const fileName = `no-gallery-${id}.${mediaType}`;
  const mediaPath = `${MEDIA_PREFIX}/${fileName}`;
  const mediaBlob = await put(mediaPath, bytes, {
    access: "public",
    addRandomSuffix: false,
    contentType: mediaType === "gif" ? "image/gif" : "image/png",
  });

  const entry = {
    id,
    tokenId,
    family: sanitizeText(payload?.family, 32) || "studio",
    label: normalizeCurationLabel(payload?.label, tokenId),
    createdAt: new Date(now).toISOString(),
    signatureHandle: sanitizeSignatureHandle(
      payload?.signatureHandle || payload?.signature || payload?.twitterHandle || "",
    ),
    palette: sanitizePalette(payload?.palette || payload?.paletteHexes || []),
    rolePair: normalizeRolePair(payload?.rolePair),
    mediaType,
    mediaUrl: mediaBlob.url,
    schemaVersion: NO_GALLERY_SCHEMA_VERSION,
  };

  const index = await loadGalleryIndex();
  const nextIndex = [entry, ...index.filter((item) => String(item?.id || "") !== entry.id)];
  await saveGalleryIndex(nextIndex);

  return toPublicEntry(entry);
}

module.exports = {
  parseJsonBody,
  listGalleryEntries,
  saveGalleryEntry,
};
