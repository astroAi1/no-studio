const STATIC_STUDIO_CONFIG = {
  ok: true,
  productName: "No-Studio",
  liveHeadAvailable: false,
  blockMode: "manual",
  machineDrawerEnabled: false,
  noiseGifAvailable: false,
  noGalleryAvailable: false,
  modes: [
    { id: "canonical-machine", label: "Machine", descriptionShort: "Canonical block render", exportKinds: ["single"] },
    { id: "dither-study", label: "Texture", descriptionShort: "Pattern-led block render", exportKinds: ["single"] },
    { id: "serial-pop", label: "Serial", descriptionShort: "Nearby state sheet", exportKinds: ["single", "contact-sheet"] },
  ],
  head: {},
};

let staticTraitDbPromise = null;
let staticPunkIndexPromise = null;

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
  try {
    return await fetchJson(`/api/no-studio/gallery?limit=${encodeURIComponent(String(limit))}`);
  } catch (error) {
    if (isUnavailableApiError(error)) {
      throw new Error("No-Gallery requires the local No-Studio server");
    }
    throw error;
  }
}

export async function saveNoStudioGallery(body) {
  try {
    return await fetchJson("/api/no-studio/gallery", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body || {}),
    });
  } catch (error) {
    if (isUnavailableApiError(error)) {
      throw new Error("No-Gallery requires the local No-Studio server");
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
