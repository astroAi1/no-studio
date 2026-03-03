"use strict";

const STYLE_CATALOG = [
  {
    id: "sleek-reveal",
    mode: "single",
    minIds: 1,
    maxIds: 1,
    pythonHandler: "sleek-reveal",
    supportsSeed: false,
    label: "Sleek Reveal",
    description: "Clean grayscale reveal loop.",
    previewKind: "reveal",
  },
];

const STYLE_MAP = new Map(STYLE_CATALOG.map((style) => [style.id, style]));

function cloneStyle(style) {
  return {
    id: style.id,
    mode: style.mode,
    minIds: style.minIds,
    maxIds: style.maxIds,
    label: style.label,
    name: style.label,
    description: style.description,
    previewKind: style.previewKind,
    supportsSeed: Boolean(style.supportsSeed),
  };
}

function getGifStyleCatalog() {
  return STYLE_CATALOG.map(cloneStyle);
}

function getGifStyleById(id) {
  return STYLE_MAP.get(String(id || "").trim()) || null;
}

function normalizeTokenIds(input) {
  const ids = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();

  for (const raw of ids) {
    const value = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(value)) continue;
    if (value < 0 || value > 9999) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}

function validateGifJobRequest(body) {
  const style = getGifStyleById(body && body.styleId);
  if (!style) {
    return { ok: false, error: "Unknown GIF style" };
  }

  const tokenIds = normalizeTokenIds(body && body.tokenIds);
  if (tokenIds.length < style.minIds || tokenIds.length > style.maxIds) {
    return {
      ok: false,
      error: `Style ${style.id} requires ${style.minIds}-${style.maxIds} token IDs`,
    };
  }

  const rawSeed = body && body.seed;
  const seed = rawSeed === undefined || rawSeed === null || rawSeed === ""
    ? null
    : Number.parseInt(String(rawSeed), 10);

  const size = 1024; // fixed v1 export size
  return {
    ok: true,
    style,
    payload: {
      styleId: style.id,
      tokenIds,
      seed: Number.isFinite(seed) ? seed : null,
      size,
      options: {},
    },
  };
}

module.exports = {
  getGifStyleCatalog,
  getGifStyleById,
  validateGifJobRequest,
};
