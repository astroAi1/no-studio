const STATIC_STUDIO_CONFIG = {
  ok: true,
  productName: "No-Studio",
  liveHeadAvailable: false,
  blockMode: "manual",
  machineDrawerEnabled: false,
  noiseGifAvailable: false,
  noGalleryAvailable: true,
  modes: [
    { id: "canonical-machine", label: "Machine", descriptionShort: "Canonical block render", exportKinds: ["single"] },
    { id: "dither-study", label: "Texture", descriptionShort: "Pattern-led block render", exportKinds: ["single"] },
    { id: "serial-pop", label: "Serial", descriptionShort: "Nearby state sheet", exportKinds: ["single", "contact-sheet"] },
  ],
  head: {},
};

let staticTraitDbPromise = null;
let staticPunkIndexPromise = null;
const BROWSER_GALLERY_KEY = "no-studio-browser-gallery-v1";
const BROWSER_GALLERY_LIMIT = 60;
const BROWSER_GALLERY_DB_NAME = "no-studio-gallery-v1";
const BROWSER_GALLERY_DB_VERSION = 1;
const BROWSER_GALLERY_STORE = "entries";
const GALLERY_REQUEST_TIMEOUT_MS = 4500;
let browserGalleryDbPromise = null;
let browserGalleryMigrationDone = false;
let sharedGalleryUnavailable = false;

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  let payload = null;
  let rawText = "";
  try {
    rawText = await response.text();
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || payload.ok === false) {
    let message = (payload && payload.error) || `Request failed (${response.status})`;
    if (!payload && /^<!doctype html>|^<html/i.test(rawText.trim())) {
      message = "API route returned HTML. Restart the No-Studio server so the new route is loaded.";
    }
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    error.url = url;
    error.responseText = rawText;
    console.error("[No-Studio API]", url, response.status, payload || rawText);
    throw error;
  }

  return payload;
}

export async function fetchJsonWithTimeout(url, options = {}, timeoutMs = GALLERY_REQUEST_TIMEOUT_MS) {
  if (typeof AbortController === "undefined") {
    return fetchJson(url, options);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || GALLERY_REQUEST_TIMEOUT_MS));
  try {
    return await fetchJson(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      const timeoutError = new Error(`Request timed out (${Math.max(250, Number(timeoutMs) || GALLERY_REQUEST_TIMEOUT_MS)}ms)`);
      timeoutError.code = "REQUEST_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isUnavailableApiError(error) {
  if (!error) return false;
  if (error.status === 404 || error.status === 405 || error.status === 501) return true;
  const message = String(error.message || "");
  return (
    message.includes("API route returned HTML") ||
    message.includes("Failed to fetch") ||
    message.includes("NetworkError")
  );
}

function isSharedGalleryConfigError(error) {
  if (!error) return false;
  if (error.status === 503) {
    const message = String(error.message || "");
    if (message.includes("Shared No-Gallery is not configured")) {
      return true;
    }
  }
  return false;
}

function isTimeoutApiError(error) {
  if (!error) return false;
  if (error.code === "REQUEST_TIMEOUT") return true;
  return String(error.message || "").includes("Request timed out");
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
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const hex = sanitizeHexColor(item);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
    if (out.length >= 64) break;
  }
  return out;
}

function sanitizeText(value, maxLength = 160) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeMediaType(value) {
  return String(value || "").toLowerCase() === "gif" ? "gif" : "png";
}

function normalizeBrowserGalleryItem(entry) {
  const mediaType = normalizeMediaType(entry && entry.mediaType);
  const mediaUrl = String(entry?.mediaUrl || "").trim();
  const palette = sanitizePalette(entry && (entry.palette || entry.paletteHexes || []));
  return {
    id: String(entry?.id || ""),
    tokenId: Number(entry?.tokenId) || 0,
    family: sanitizeText(entry?.family, 32),
    label: sanitizeText(entry?.label, 160) || `No-Studio #${Number(entry?.tokenId) || 0}`,
    createdAt: entry?.createdAt || new Date().toISOString(),
    signatureHandle: sanitizeSignatureHandle(entry?.signatureHandle || entry?.signature || entry?.twitterHandle || ""),
    palette,
    paletteCount: palette.length,
    rolePair: entry?.rolePair && typeof entry.rolePair === "object"
      ? {
          background: sanitizeHexColor(entry.rolePair.background) || "",
          figure: sanitizeHexColor(entry.rolePair.figure) || "",
          mode: sanitizeText(entry.rolePair.mode, 12),
        }
      : null,
    mediaType,
    mediaUrl,
    thumbUrl: mediaUrl,
    viewUrl: mediaUrl,
    pngUrl: mediaType === "png" ? mediaUrl : null,
    gifUrl: mediaType === "gif" ? mediaUrl : null,
  };
}

function readBrowserGalleryLegacy() {
  try {
    const raw = localStorage.getItem(BROWSER_GALLERY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => normalizeBrowserGalleryItem(entry)).filter((entry) => entry.id && entry.mediaUrl);
  } catch {
    return [];
  }
}

function writeBrowserGalleryLegacy(entries) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeBrowserGalleryItem(entry))
    .filter((entry) => entry.id && entry.mediaUrl)
    .slice(0, BROWSER_GALLERY_LIMIT);

  let candidate = normalized.slice();
  while (candidate.length) {
    try {
      localStorage.setItem(BROWSER_GALLERY_KEY, JSON.stringify(candidate));
      return candidate;
    } catch (error) {
      if (!/quota/i.test(String(error && error.message || ""))) {
        throw error;
      }
      candidate.pop();
    }
  }
  localStorage.removeItem(BROWSER_GALLERY_KEY);
  throw new Error("Gallery storage is full in this browser");
}

function hasBrowserIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function openBrowserGalleryDb() {
  if (!hasBrowserIndexedDb()) return Promise.resolve(null);
  if (browserGalleryDbPromise) return browserGalleryDbPromise;
  browserGalleryDbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(BROWSER_GALLERY_DB_NAME, BROWSER_GALLERY_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BROWSER_GALLERY_STORE)) {
          db.createObjectStore(BROWSER_GALLERY_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return browserGalleryDbPromise;
}

async function readBrowserGalleryFromDb() {
  const db = await openBrowserGalleryDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(BROWSER_GALLERY_STORE, "readonly");
      const store = tx.objectStore(BROWSER_GALLERY_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const out = Array.isArray(req.result)
          ? req.result.map((entry) => normalizeBrowserGalleryItem(entry)).filter((entry) => entry.id && entry.mediaUrl)
          : [];
        out.sort((a, b) => {
          const aTs = Date.parse(a.createdAt || "");
          const bTs = Date.parse(b.createdAt || "");
          return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
        });
        resolve(out);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function writeBrowserGalleryToDb(entries) {
  const db = await openBrowserGalleryDb();
  if (!db) return false;
  const normalized = (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeBrowserGalleryItem(entry))
    .filter((entry) => entry.id && entry.mediaUrl)
    .slice(0, BROWSER_GALLERY_LIMIT);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(BROWSER_GALLERY_STORE, "readwrite");
      const store = tx.objectStore(BROWSER_GALLERY_STORE);
      store.clear();
      for (const entry of normalized) {
        store.put(entry);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function migrateLegacyBrowserGalleryToDb() {
  if (browserGalleryMigrationDone) return;
  browserGalleryMigrationDone = true;
  const existing = await readBrowserGalleryFromDb();
  if (Array.isArray(existing) && existing.length) return;
  const legacy = readBrowserGalleryLegacy();
  if (!legacy.length) return;
  await writeBrowserGalleryToDb(legacy);
}

async function readBrowserGallery() {
  await migrateLegacyBrowserGalleryToDb();
  const dbEntries = await readBrowserGalleryFromDb();
  if (Array.isArray(dbEntries)) return dbEntries;
  return readBrowserGalleryLegacy();
}

async function writeBrowserGallery(entries) {
  const normalized = (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeBrowserGalleryItem(entry))
    .filter((entry) => entry.id && entry.mediaUrl)
    .slice(0, BROWSER_GALLERY_LIMIT);
  const dbStored = await writeBrowserGalleryToDb(normalized);
  if (dbStored) return normalized;
  return writeBrowserGalleryLegacy(normalized);
}

async function listNoStudioGalleryBrowser({ limit = 18 } = {}) {
  const max = Math.max(1, Number(limit) || 18);
  const items = (await readBrowserGallery()).slice(0, max);
  return {
    ok: true,
    count: items.length,
    items,
    storage: "browser",
  };
}

async function saveNoStudioGalleryBrowser(body) {
  const mediaDataUrl = String(body?.mediaDataUrl || body?.pngDataUrl || body?.gifDataUrl || "").trim();
  const match = /^data:image\/(png|gif);base64,[A-Za-z0-9+/=]+$/i.exec(mediaDataUrl);
  if (!match) {
    throw new Error("Invalid media payload");
  }

  const mediaType = normalizeMediaType(match[1]);
  const now = Date.now();
  const id = `${now}-${Math.random().toString(16).slice(2, 10)}`;
  const palette = sanitizePalette(body?.palette || body?.paletteHexes || []);
  const entry = normalizeBrowserGalleryItem({
    id,
    tokenId: Number(body?.tokenId) || 0,
    family: body?.family || "studio",
    label: body?.label,
    createdAt: new Date(now).toISOString(),
    signatureHandle: body?.signatureHandle || body?.signature || body?.twitterHandle || "",
    rolePair: body?.rolePair && typeof body.rolePair === "object" ? body.rolePair : null,
    mediaType,
    mediaUrl: mediaDataUrl,
    palette,
  });

  const currentEntries = await readBrowserGallery();
  const nextEntries = [entry, ...currentEntries.filter((item) => item.id !== entry.id)];
  await writeBrowserGallery(nextEntries);
  return {
    ok: true,
    item: entry,
    storage: "browser",
  };
}

async function loadStaticTraitDb() {
  if (!staticTraitDbPromise) {
    staticTraitDbPromise = fetch("/data/trait_db.json", {
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Static data missing (${response.status})`);
      }
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || typeof payload.punks !== "object") {
        throw new Error("Static trait data is invalid");
      }
      return payload;
    });
  }
  return staticTraitDbPromise;
}

function buildTraitSummary(record) {
  const traits = record && record.traits ? record.traits : {};
  const ordered = [];
  if (traits.Type) ordered.push(`Type: ${traits.Type}`);
  for (const [key, value] of Object.entries(traits)) {
    if (key === "Type") continue;
    ordered.push(`${key}: ${value}`);
    if (ordered.length >= 4) break;
  }
  return ordered.join(" · ");
}

function buildStaticPunkItem(id, record) {
  const numId = Number(id);
  const traits = record && record.traits ? { ...record.traits } : {};
  const tileSize = 24;
  const atlasCols = 100;
  const atlasRows = 100;
  const atlasWidth = atlasCols * tileSize;
  const atlasHeight = atlasRows * tileSize;
  return {
    id: numId,
    name: record?.name || `No-Punk #${numId}`,
    type: traits.Type || "",
    traits,
    traitSummary: buildTraitSummary(record),
    previewUrl: `/data/punks-atlas.png`,
    previewAtlas: {
      url: "/data/punks-atlas.png",
      tileSize,
      atlasWidth,
      atlasHeight,
      x: (numId % atlasCols) * tileSize,
      y: Math.floor(numId / atlasCols) * tileSize,
    },
  };
}

async function loadStaticPunkIndex() {
  if (!staticPunkIndexPromise) {
    staticPunkIndexPromise = loadStaticTraitDb().then((db) => Object.entries(db.punks)
      .map(([id, record]) => buildStaticPunkItem(id, record))
      .sort((a, b) => a.id - b.id));
  }
  return staticPunkIndexPromise;
}

function scoreStaticPunk(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 0;

  const idText = String(item.id);
  const numeric = q.replace(/^#/, "");
  if (numeric && /^\d+$/.test(numeric)) {
    if (idText === numeric) return 1000;
    if (idText.startsWith(numeric)) return 700;
    if (idText.includes(numeric)) return 550;
  }

  const haystacks = [
    item.name,
    item.type,
    item.traitSummary,
    ...Object.entries(item.traits || {}).flatMap(([key, value]) => [key, value, `${key} ${value}`]),
  ].map((value) => String(value || "").toLowerCase());

  let best = -1;
  for (const text of haystacks) {
    if (!text) continue;
    const idx = text.indexOf(q);
    if (idx === -1) continue;
    const score = 300 - (idx * 3) - (text.length - q.length);
    if (score > best) best = score;
  }

  return best;
}

async function searchStaticPunks(query, limit = 24) {
  const items = await loadStaticPunkIndex();
  const max = Math.max(1, Number(limit) || 24);
  const q = String(query || "").trim();

  if (!q) {
    const slice = items.slice(0, max);
    return { ok: true, count: slice.length, items: slice };
  }

  const ranked = items
    .map((item) => ({ item, score: scoreStaticPunk(item, q) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.id - b.item.id;
    })
    .slice(0, max)
    .map((entry) => entry.item);

  return { ok: true, count: ranked.length, items: ranked };
}

export async function searchPunks(query, limit = 24) {
  const q = encodeURIComponent(String(query || ""));
  try {
    return await fetchJson(`/api/search?q=${q}&limit=${encodeURIComponent(String(limit))}`);
  } catch (error) {
    return searchStaticPunks(query, limit);
  }
}

export async function getPunk(id) {
  try {
    return await fetchJson(`/api/punk/${encodeURIComponent(String(id))}`);
  } catch (error) {
    const db = await loadStaticTraitDb();
    const key = String(Number(id));
    const record = db.punks && db.punks[key];
    if (!record) throw error;
    return {
      ok: true,
      punk: buildStaticPunkItem(key, record),
    };
  }
}

export async function getHealth() {
  try {
    return await fetchJson("/api/health");
  } catch {
    return { ok: true, static: true };
  }
}

export async function getNoStudioConfig() {
  try {
    return await fetchJson("/api/no-studio/config");
  } catch {
    return { ...STATIC_STUDIO_CONFIG };
  }
}

export async function getNoStudioRarity(tokenId) {
  try {
    return await fetchJson(`/api/no-studio/rarity/${encodeURIComponent(String(tokenId))}`);
  } catch {
    return {
      ok: true,
      tokenId: Number(tokenId),
      normalized: 0.5,
      source: "static-fallback",
    };
  }
}

export async function getNoStudioHead() {
  try {
    return await fetchJson("/api/no-studio/block/head");
  } catch (error) {
    if (isUnavailableApiError(error)) {
      throw new Error("Live head unavailable in static deploy");
    }
    throw error;
  }
}

export async function generateNoStudio(body) {
  try {
    return await fetchJson("/api/no-studio/render", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body || {}),
    });
  } catch (error) {
    if (isUnavailableApiError(error)) {
      throw new Error("Canonical machine render is unavailable in static deploy");
    }
    throw error;
  }
}

export async function renderNoStudioNoiseGif(body) {
  try {
    return await fetchJson("/api/no-studio/noise-gif", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body || {}),
    });
  } catch (error) {
    if (isUnavailableApiError(error)) {
      throw new Error("Animated grain GIF export requires the local No-Studio server");
    }
    throw error;
  }
}

export async function listNoStudioGallery({ limit = 18 } = {}) {
  if (sharedGalleryUnavailable) {
    return listNoStudioGalleryBrowser({ limit });
  }
  try {
    return await fetchJsonWithTimeout(`/api/no-studio/gallery?limit=${encodeURIComponent(String(limit))}`, {}, GALLERY_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (isSharedGalleryConfigError(error)) {
      sharedGalleryUnavailable = true;
      return listNoStudioGalleryBrowser({ limit });
    }
    if (isUnavailableApiError(error) || isTimeoutApiError(error)) {
      return listNoStudioGalleryBrowser({ limit });
    }
    throw error;
  }
}

export async function saveNoStudioGallery(body) {
  if (sharedGalleryUnavailable) {
    return saveNoStudioGalleryBrowser(body || {});
  }
  try {
    return await fetchJsonWithTimeout("/api/no-studio/gallery", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body || {}),
    }, GALLERY_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (isSharedGalleryConfigError(error)) {
      sharedGalleryUnavailable = true;
      return saveNoStudioGalleryBrowser(body || {});
    }
    if (isUnavailableApiError(error) || isTimeoutApiError(error)) {
      return saveNoStudioGalleryBrowser(body || {});
    }
    throw error;
  }
}

export async function getNoStudioHistory(tokenId, { limit = 8, offset = 0, mode = null, outputKind = null } = {}) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (mode) params.set("mode", String(mode));
  if (outputKind) params.set("outputKind", String(outputKind));

  try {
    return await fetchJson(`/api/no-studio/history/${encodeURIComponent(String(tokenId))}?${params}`);
  } catch {
    return {
      ok: true,
      count: 0,
      items: [],
    };
  }
}

export const getNoPaletteConfig = getNoStudioConfig;
export const getNoPaletteRarity = getNoStudioRarity;
export const getNoPaletteHead = getNoStudioHead;
export const generateNoPalette = generateNoStudio;
export const getNoPaletteHistory = getNoStudioHistory;
export const listNoPaletteGallery = listNoStudioGallery;
export const saveNoPaletteGallery = saveNoStudioGallery;
