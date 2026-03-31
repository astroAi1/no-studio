"use strict";

const crypto = require("node:crypto");
const { list, put } = require("@vercel/blob");

const INDEX_KEY = "no-gallery/index-v3.json";
const REACTIONS_KEY = "no-gallery/reactions-v1.json";
const MEDIA_PREFIX = "no-gallery/media";
const MAX_GALLERY_ITEMS = 240;
const NO_GALLERY_SCHEMA_VERSION = 3;
const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

function normalizeReaction(value) {
  return String(value || "").trim().toLowerCase() === "yes" ? "yes" : "no";
}

function safeIso(value, fallback = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  const timestamp = Number.isFinite(parsed) ? parsed : Number(fallback) || Date.now();
  return new Date(timestamp).toISOString();
}

function compareByNew(a, b) {
  return String(b?.createdAt || "").localeCompare(String(a?.createdAt || ""))
    || String(b?.id || "").localeCompare(String(a?.id || ""));
}

function compareByTop(a, b) {
  return (Number(b?.score) || 0) - (Number(a?.score) || 0)
    || (Number(b?.noCount) || 0) - (Number(a?.noCount) || 0)
    || compareByNew(a, b);
}

function sortEntries(entries, sort = "new") {
  const list = Array.isArray(entries) ? entries.slice() : [];
  if (String(sort || "new").toLowerCase() === "top") {
    return list.sort(compareByTop);
  }
  return list.sort(compareByNew);
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
    createdAt: safeIso(entry.createdAt),
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

function normalizeReactionRecord(record) {
  const entryId = sanitizeText(record?.entryId || record?.id, 128);
  const viewerId = sanitizeText(record?.viewerId, 128);
  if (!entryId || !viewerId) return null;
  const createdAt = safeIso(record?.createdAt);
  return {
    entryId,
    viewerId,
    reaction: normalizeReaction(record?.reaction),
    createdAt,
    updatedAt: safeIso(record?.updatedAt || createdAt),
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
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

async function loadJsonIndex(pathname, fallbackValue) {
  const listing = await list({ prefix: pathname, limit: 1 });
  const blob = Array.isArray(listing.blobs) ? listing.blobs.find((item) => item.pathname === pathname) : null;
  if (!blob) return fallbackValue;
  const response = await fetch(blob.url, { cache: "no-store" });
  if (!response.ok) return fallbackValue;
  try {
    const parsed = await response.json();
    return parsed == null ? fallbackValue : parsed;
  } catch {
    return fallbackValue;
  }
}

async function saveJsonIndex(pathname, payload) {
  await put(pathname, JSON.stringify(payload, null, 2), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json; charset=utf-8",
  });
  return payload;
}

async function loadGalleryIndex() {
  const parsed = await loadJsonIndex(INDEX_KEY, []);
  return Array.isArray(parsed) ? parsed : [];
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

  await saveJsonIndex(INDEX_KEY, normalized);
  return normalized;
}

async function loadReactionIndex() {
  const parsed = await loadJsonIndex(REACTIONS_KEY, []);
  return Array.isArray(parsed)
    ? parsed.map((entry) => normalizeReactionRecord(entry)).filter(Boolean)
    : [];
}

async function saveReactionIndex(reactions) {
  const normalized = (Array.isArray(reactions) ? reactions : [])
    .map((entry) => normalizeReactionRecord(entry))
    .filter(Boolean);
  await saveJsonIndex(REACTIONS_KEY, normalized);
  return normalized;
}

function buildReactionMaps(reactions, viewerId = "") {
  const countsByEntry = new Map();
  const viewerReactionByEntry = new Map();
  const safeViewerId = sanitizeText(viewerId, 128);
  for (const reaction of Array.isArray(reactions) ? reactions : []) {
    const entryId = String(reaction.entryId || "");
    if (!entryId) continue;
    const counts = countsByEntry.get(entryId) || { noCount: 0, yesCount: 0 };
    if (reaction.reaction === "yes") counts.yesCount += 1;
    else counts.noCount += 1;
    countsByEntry.set(entryId, counts);
    if (safeViewerId && reaction.viewerId === safeViewerId) {
      viewerReactionByEntry.set(entryId, reaction.reaction);
    }
  }
  return { countsByEntry, viewerReactionByEntry };
}

function weekIdFor(startedAt) {
  const timestamp = Date.parse(String(startedAt || ""));
  if (Number.isFinite(timestamp)) {
    return `week-${timestamp}`;
  }
  return `week-${crypto.createHash("sha1").update(String(startedAt || "")).digest("hex").slice(0, 12)}`;
}

function withReactionStats(entry, reactionMaps) {
  const counts = reactionMaps.countsByEntry.get(String(entry.id || "")) || { noCount: 0, yesCount: 0 };
  const viewerReaction = reactionMaps.viewerReactionByEntry.get(String(entry.id || "")) || null;
  const noCount = Number(counts.noCount) || 0;
  const yesCount = Number(counts.yesCount) || 0;
  return {
    ...entry,
    voteCount: noCount,
    noCount,
    yesCount,
    score: noCount - yesCount,
    viewerReaction,
    viewerHasVoted: viewerReaction === "no" || viewerReaction === "yes",
  };
}

function buildWeekBuckets(entries, reactions, viewerId = "") {
  const baseEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => toPublicEntry(entry))
    .filter((entry) => entry.id && entry.mediaUrl && Number(entry.schemaVersion) === NO_GALLERY_SCHEMA_VERSION)
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));

  if (!baseEntries.length) return [];

  const reactionMaps = buildReactionMaps(reactions, viewerId);
  const now = Date.now();
  const rawWeeks = [];
  let current = null;

  for (const entry of baseEntries) {
    const createdAt = safeIso(entry.createdAt);
    const createdMs = Date.parse(createdAt);
    if (!current || createdMs >= current.endsMs) {
      if (current) rawWeeks.push(current);
      current = {
        startedAt: createdAt,
        endsMs: createdMs + WEEK_WINDOW_MS,
        items: [],
      };
    }
    current.items.push(withReactionStats({ ...entry, createdAt }, reactionMaps));
  }
  if (current) rawWeeks.push(current);

  return rawWeeks.map((week, index) => {
    const isLast = index === rawWeeks.length - 1;
    const endsAt = new Date(week.endsMs).toISOString();
    const weekState = (!isLast || now >= week.endsMs) ? "archived" : "live";
    const weekId = weekIdFor(week.startedAt);
    const items = week.items.map((entry) => ({
      ...entry,
      weekId,
      weekState,
    }));
    return {
      weekId,
      startedAt: week.startedAt,
      endsAt,
      closedAt: weekState === "archived" ? endsAt : null,
      weekState,
      items,
      entryCount: items.length,
      topNoCount: items.reduce((max, item) => Math.max(max, Number(item.noCount) || 0), 0),
    };
  });
}

function materializeWeek(week, sort = "new", { limit = null, offset = 0 } = {}) {
  const items = sortEntries(week?.items || [], sort);
  const slice = Number.isFinite(limit) ? items.slice(offset, offset + limit) : items;
  const coverEntries = sortEntries(week?.items || [], "top").slice(0, 9);
  return {
    weekId: week.weekId,
    startedAt: week.startedAt,
    endsAt: week.endsAt,
    closedAt: week.closedAt,
    weekState: week.weekState,
    count: items.length,
    entryCount: week.entryCount,
    topNoCount: week.topNoCount,
    sort: String(sort || "new").toLowerCase() === "top" ? "top" : "new",
    items: slice,
    coverEntries,
    coverUrl: null,
  };
}

async function listGalleryEntries(options = {}) {
  const limit = typeof options === "number" ? options : Number(options?.limit || 120);
  const sort = typeof options === "object" ? options?.sort || "new" : "new";
  const viewerId = typeof options === "object" ? options?.viewerId || "" : "";
  const weeks = buildWeekBuckets(await loadGalleryIndex(), await loadReactionIndex(), viewerId);
  const items = sortEntries(
    weeks.flatMap((week) => week.items),
    sort,
  ).slice(0, Math.max(1, Math.min(500, limit || 120)));
  return items;
}

async function getGalleryHome({
  sort = "new",
  liveLimit = 120,
  archiveLimit = 24,
  viewerId = "",
} = {}) {
  const weeks = buildWeekBuckets(await loadGalleryIndex(), await loadReactionIndex(), viewerId);
  const liveWeekRaw = weeks.find((week) => week.weekState === "live") || null;
  const archivedWeeks = weeks
    .filter((week) => week.weekState === "archived")
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
    .slice(0, Math.max(1, Number(archiveLimit) || 24));

  return {
    ok: true,
    storage: "shared",
    global: true,
    liveWeek: liveWeekRaw ? materializeWeek(liveWeekRaw, sort, { limit: Math.max(1, Number(liveLimit) || 120), offset: 0 }) : null,
    activeWeek: liveWeekRaw
      ? {
          weekId: liveWeekRaw.weekId,
          startedAt: liveWeekRaw.startedAt,
          endsAt: liveWeekRaw.endsAt,
          closedAt: liveWeekRaw.closedAt,
          weekState: liveWeekRaw.weekState,
        }
      : null,
    archiveWeeks: archivedWeeks.map((week) => materializeWeek(week, "top", { limit: 9, offset: 0 })),
    archives: archivedWeeks.map((week) => materializeWeek(week, "top", { limit: 9, offset: 0 })),
    sort: String(sort || "new").toLowerCase() === "top" ? "top" : "new",
  };
}

async function getGalleryWeek(weekId, {
  sort = "new",
  limit = 120,
  offset = 0,
  viewerId = "",
} = {}) {
  const weeks = buildWeekBuckets(await loadGalleryIndex(), await loadReactionIndex(), viewerId);
  const target = weeks.find((week) => week.weekId === String(weekId || ""));
  if (!target) {
    const error = new Error("Gallery week not found");
    error.statusCode = 404;
    throw error;
  }
  const materialized = materializeWeek(target, sort, {
    limit: Math.max(1, Number(limit) || 120),
    offset: Math.max(0, Number(offset) || 0),
  });
  return {
    ok: true,
    storage: "shared",
    global: true,
    count: materialized.count,
    items: materialized.items,
    week: {
      weekId: materialized.weekId,
      startedAt: materialized.startedAt,
      endsAt: materialized.endsAt,
      closedAt: materialized.closedAt,
      weekState: materialized.weekState,
    },
    sort: materialized.sort,
  };
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

  const weeks = buildWeekBuckets(nextIndex, await loadReactionIndex(), "");
  const savedItem = weeks.flatMap((week) => week.items).find((item) => item.id === id) || {
    ...toPublicEntry(entry),
    voteCount: 0,
    noCount: 0,
    yesCount: 0,
    score: 0,
    viewerReaction: null,
    viewerHasVoted: false,
    weekId: weekIdFor(entry.createdAt),
    weekState: "live",
  };

  return savedItem;
}

async function reactGalleryEntry(id, viewerId, reaction) {
  const entryId = sanitizeText(id, 128);
  const safeViewerId = sanitizeText(viewerId, 128);
  if (!entryId) {
    const error = new Error("Gallery entry not found");
    error.statusCode = 404;
    throw error;
  }
  if (!safeViewerId) {
    const error = new Error("Viewer id required");
    error.statusCode = 400;
    throw error;
  }

  const index = await loadGalleryIndex();
  const reactions = await loadReactionIndex();
  const weeksBefore = buildWeekBuckets(index, reactions, safeViewerId);
  const entry = weeksBefore.flatMap((week) => week.items).find((item) => item.id === entryId);
  if (!entry) {
    const error = new Error("Gallery entry not found");
    error.statusCode = 404;
    throw error;
  }
  if (entry.weekState === "archived") {
    const error = new Error("Archived weeks are read-only");
    error.statusCode = 409;
    throw error;
  }

  const safeReaction = normalizeReaction(reaction);
  const now = new Date().toISOString();
  let matched = false;
  const nextReactions = reactions.map((item) => {
    if (item.entryId !== entryId || item.viewerId !== safeViewerId) return item;
    matched = true;
    return {
      ...item,
      reaction: safeReaction,
      updatedAt: now,
    };
  });
  if (!matched) {
    nextReactions.push({
      entryId,
      viewerId: safeViewerId,
      reaction: safeReaction,
      createdAt: now,
      updatedAt: now,
    });
  }

  await saveReactionIndex(nextReactions);
  const weeksAfter = buildWeekBuckets(index, nextReactions, safeViewerId);
  const nextItem = weeksAfter.flatMap((week) => week.items).find((item) => item.id === entryId);
  return nextItem;
}

module.exports = {
  getGalleryHome,
  getGalleryWeek,
  listGalleryEntries,
  parseJsonBody,
  reactGalleryEntry,
  saveGalleryEntry,
};
