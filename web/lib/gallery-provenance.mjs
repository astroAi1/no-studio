function normalizeHex(value) {
  const hex = String(value || "").trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(hex) ? hex : null;
}

export function normalizeHexPalette(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const dedupe = new Set();
  for (const entry of value) {
    const hex = normalizeHex(entry);
    if (!hex || dedupe.has(hex)) continue;
    dedupe.add(hex);
    out.push(hex);
  }
  return out;
}

export function sanitizeCuratedPaletteMap(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [source, target] of Object.entries(value)) {
    const sourceHex = normalizeHex(source);
    const targetHex = normalizeHex(target);
    if (!sourceHex || !targetHex) continue;
    out[sourceHex] = targetHex;
  }
  return out;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashString32(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function makeSourcePaletteSignature(classified) {
  const entries = Array.isArray(classified) ? classified : [];
  return hashString32(entries.map((entry) => {
    const hex = normalizeHex(entry?.hex) || "#000000";
    const role = String(entry?.role || "body");
    return `${hex}:${role}`;
  }).join("|"));
}

export function makePaletteSignature(palette) {
  return hashString32(normalizeHexPalette(palette).join("|"));
}

export function makeCuratedPaletteSignature(map) {
  return hashString32(stableStringify(sanitizeCuratedPaletteMap(map)));
}

export function makeLockSignature(lockState) {
  return hashString32(stableStringify({
    background: Boolean(lockState?.background),
    accentBias: Boolean(lockState?.accentBias),
    curatedMap: Boolean(lockState?.curatedMap),
  }));
}

export function buildVariantSeed({
  tokenId,
  family,
  sourcePaletteSignature,
  curatedMapSignature,
  lockState,
  pageIndex,
  slotIndex,
}) {
  return hashString32([
    Number(tokenId) || 0,
    String(family || "mono"),
    String(sourcePaletteSignature || ""),
    String(curatedMapSignature || ""),
    makeLockSignature(lockState),
    Number(pageIndex) || 0,
    Number(slotIndex) || 0,
  ].join(":"));
}

export function buildGalleryProvenance({
  variant = null,
  curatedPaletteMap = {},
  familyModifiers = {},
  globalModifiers = {},
  outputSignature = "",
  sourcePaletteSignature = "",
}) {
  const safeVariant = variant && typeof variant === "object" ? variant : {};
  return {
    variantSeed: String(safeVariant.variantSeed || ""),
    variantPage: Number(safeVariant.pageIndex) || 0,
    curatedPaletteMap: sanitizeCuratedPaletteMap(curatedPaletteMap),
    familyModifiers: { ...(familyModifiers || {}) },
    globalModifiers: { ...(globalModifiers || {}) },
    sourcePaletteSignature: String(sourcePaletteSignature || safeVariant.sourcePaletteSignature || ""),
    outputSignature: String(outputSignature || ""),
  };
}

export function createSeededRandom(seed) {
  const hashA = parseInt(hashString32(`${seed}:a`), 16) >>> 0;
  const hashB = parseInt(hashString32(`${seed}:b`), 16) >>> 0;
  let state = hashA ^ hashB ^ 0x9E3779B9;
  return function random() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
