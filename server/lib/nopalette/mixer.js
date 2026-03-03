"use strict";

const crypto = require("crypto");

const ROLE_BACKGROUND = 0x000000;
const ROLE_OUTLINE = 0x040404;
const TOOL_VERSION_DEFAULT = "no-palette-v2";

function clampChannel(value) {
  const v = Number.isFinite(value) ? Math.round(value) : 0;
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function intToHex(rgbInt) {
  return `#${(rgbInt >>> 0).toString(16).padStart(6, "0").toUpperCase()}`;
}

function hexToInt(hex) {
  const clean = String(hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return Number.parseInt(clean, 16) >>> 0;
}

function rgbIntToTuple(rgbInt) {
  return {
    r: (rgbInt >>> 16) & 0xff,
    g: (rgbInt >>> 8) & 0xff,
    b: rgbInt & 0xff,
  };
}

function rgbTupleToInt({ r, g, b }) {
  return ((clampChannel(r) << 16) | (clampChannel(g) << 8) | clampChannel(b)) >>> 0;
}

function addRgbDelta(rgbInt, delta) {
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const { r, g, b } = rgbIntToTuple(rgbInt);
  return rgbTupleToInt({ r: r + d, g: g + d, b: b + d });
}

function isExactRoleLiftSafe(rgbInt, delta = 4) {
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const { r, g, b } = rgbIntToTuple(rgbInt);
  return (r + d) <= 255 && (g + d) <= 255 && (b + d) <= 255;
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function deriveSeed({ rgba24Bytes, userSeed, toolVersion = TOOL_VERSION_DEFAULT }) {
  const hash = crypto.createHash("sha256");
  hash.update(Buffer.isBuffer(rgba24Bytes) ? rgba24Bytes : Buffer.from(rgba24Bytes || []));
  hash.update("\x00");
  hash.update(String(userSeed ?? ""));
  hash.update("\x00");
  hash.update(String(toolVersion || TOOL_VERSION_DEFAULT));
  return hash.digest("hex");
}

function deriveStateSeed({
  rgba24Bytes,
  tokenId,
  modeId,
  blockNumber,
  toolVersion = TOOL_VERSION_DEFAULT,
  nudge = 0,
}) {
  return deriveSeed({
    rgba24Bytes,
    userSeed: `${Number(tokenId)}:${String(modeId || "canonical-machine")}:${Number(blockNumber)}:${Number(nudge)}`,
    toolVersion,
  });
}

function hashToUint32Parts(seedHex, streamTag = "") {
  const digest = sha256Hex(`${seedHex}:${streamTag}`);
  return [0, 8, 16, 24].map((offset) => Number.parseInt(digest.slice(offset, offset + 8), 16) >>> 0);
}

function createPrng(seedHex, streamTag = "") {
  const [a0, b0, c0, d0] = hashToUint32Parts(seedHex, streamTag);
  let a = a0 || 0x9e3779b9;
  let b = b0 || 0x243f6a88;
  let c = c0 || 0xb7e15162;
  let d = d0 || 0xdeadbeef;
  return function rand() {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return (t >>> 0) / 4294967296;
  };
}

function randomInt(rand, min, maxInclusive) {
  const lo = Math.min(min, maxInclusive);
  const hi = Math.max(min, maxInclusive);
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function pickOne(rand, list) {
  return list[randomInt(rand, 0, list.length - 1)];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function normalizeRarity(input) {
  if (input && typeof input === "object") {
    if (Number.isFinite(input.normalized)) return clamp01(input.normalized);
    if (Number.isFinite(input.rank) && Number.isFinite(input.total)) {
      const total = Number(input.total);
      const rank = Number(input.rank);
      if (total <= 1) return 1;
      return clamp01(1 - ((rank - 1) / (total - 1)));
    }
  }
  return clamp01(input);
}

function computeMixerParams(rarityNorm) {
  const r = normalizeRarity(rarityNorm);
  return {
    rarityNorm: r,
    weightMin: lerp(0.35, 0.05, r),
    weightMax: lerp(0.65, 0.95, r),
    triMixChance: lerp(0.1, 0.7, r),
    extraStageChance: lerp(0.05, 0.55, r),
    extrapolationChance: lerp(0.0, 0.92, r),
    // Epsilon moves weight mass from one source to another while preserving sum(weights)=1.
    // Tuned so 2-color role-only palettes can escape the convex [0..4] grey cap at high rarity
    // without constantly collapsing into hard-clamped extremes.
    extrapolationMax: lerp(0.0, 2.5, r),
    smallPaletteExtrapolationBoost: lerp(1.0, 4.0, r),
    // Keep common outputs conservative; add more drift only as rarity rises.
    perturbRange: lerp(0.0, 10, r),
  };
}

function extractPaletteAndRoles(rgba24Bytes) {
  const bytes = Buffer.isBuffer(rgba24Bytes) ? rgba24Bytes : Buffer.from(rgba24Bytes || []);
  if (!bytes.length || bytes.length % 4 !== 0) {
    throw new Error("Invalid RGBA byte array");
  }

  const palette = [];
  const counts = new Map();
  const seen = new Set();
  let hasVisibleBackgroundRole = false;
  let hasOutlineRole = false;
  let visiblePixels = 0;

  for (let i = 0; i < bytes.length; i += 4) {
    const a = bytes[i + 3];
    if (a === 0) continue;
    visiblePixels += 1;
    const rgbInt = ((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]) >>> 0;
    if (rgbInt === ROLE_BACKGROUND) hasVisibleBackgroundRole = true;
    if (rgbInt === ROLE_OUTLINE) hasOutlineRole = true;
    if (!seen.has(rgbInt)) {
      seen.add(rgbInt);
      palette.push(rgbInt);
    }
    counts.set(rgbInt, (counts.get(rgbInt) || 0) + 1);
  }

  return {
    originalPalette: palette,
    originalPaletteHex: palette.map(intToHex),
    counts,
    visiblePixels,
    roles: {
      backgroundSource: ROLE_BACKGROUND,
      outlineSource: ROLE_OUTLINE,
      hasVisibleBackgroundRole,
      hasOutlineRole,
    },
  };
}

function colorLuminance(rgbInt) {
  const { r, g, b } = rgbIntToTuple(rgbInt);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function colorChroma(rgbInt) {
  const { r, g, b } = rgbIntToTuple(rgbInt);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function sampleWeights(rand, n, minW, maxW) {
  const raw = [];
  for (let i = 0; i < n; i += 1) {
    raw.push(lerp(minW, maxW, rand()));
  }
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((w) => w / sum);
}

function extrapolateWeights(rand, weights, params, sourceCount) {
  if (!Array.isArray(weights) || weights.length < 2) return weights;
  if (!(rand() < (params.extrapolationChance || 0))) return weights;

  const next = weights.slice();
  let i = randomInt(rand, 0, next.length - 1);
  let j = randomInt(rand, 0, next.length - 1);
  if (j === i) j = (j + 1) % next.length;

  let maxExtra = Number(params.extrapolationMax || 0);
  if (sourceCount <= 2) {
    maxExtra *= Number(params.smallPaletteExtrapolationBoost || 1);
  }
  if (!(maxExtra > 0)) return next;

  const epsilon = rand() * maxExtra;
  if (rand() < 0.5) {
    next[i] += epsilon;
    next[j] -= epsilon;
  } else {
    next[i] -= epsilon;
    next[j] += epsilon;
  }
  // Sum is preserved exactly, which keeps the affine mix deterministic and derived from source colors.
  return next;
}

function mixColorsWeighted(colorInts, weights) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < colorInts.length; i += 1) {
    const c = rgbIntToTuple(colorInts[i]);
    const w = weights[i] || 0;
    r += c.r * w;
    g += c.g * w;
    b += c.b * w;
  }
  return rgbTupleToInt({ r, g, b });
}

function perturbColor(rand, rgbInt, range) {
  const span = Math.max(0, Number(range) || 0);
  if (span <= 0) return rgbInt >>> 0;
  const { r, g, b } = rgbIntToTuple(rgbInt);
  const delta = () => (rand() * 2 - 1) * span;
  return rgbTupleToInt({ r: r + delta(), g: g + delta(), b: b + delta() });
}

function chooseMixCandidate(rand, sourcePalette, params) {
  if (!sourcePalette.length) throw new Error("Source palette is empty");
  const tri = sourcePalette.length >= 3 && rand() < params.triMixChance;
  const count = tri ? 3 : Math.min(2, sourcePalette.length);
  const picks = [];
  const used = new Set();

  while (picks.length < count) {
    const candidate = pickOne(rand, sourcePalette);
    if (!used.has(candidate) || used.size === sourcePalette.length) {
      picks.push(candidate);
      used.add(candidate);
    }
  }

  const weights = extrapolateWeights(
    rand,
    sampleWeights(rand, count, params.weightMin, params.weightMax),
    params,
    sourcePalette.length
  );
  let mixed = mixColorsWeighted(picks, weights);

  if (rand() < params.extraStageChance && sourcePalette.length > 1) {
    const secondaryCount = sourcePalette.length >= 3 && rand() < 0.5 ? 3 : 2;
    const secondary = [];
    const secondaryUsed = new Set();
    while (secondary.length < Math.min(secondaryCount, sourcePalette.length)) {
      const candidate = pickOne(rand, sourcePalette);
      if (!secondaryUsed.has(candidate) || secondaryUsed.size === sourcePalette.length) {
        secondary.push(candidate);
        secondaryUsed.add(candidate);
      }
    }
    const secondaryWeights = extrapolateWeights(
      rand,
      sampleWeights(rand, secondary.length, params.weightMin, params.weightMax),
      params,
      sourcePalette.length
    );
    const mixedSecondary = mixColorsWeighted(secondary, secondaryWeights);
    const bridge = extrapolateWeights(
      rand,
      sampleWeights(rand, 2, params.weightMin, params.weightMax),
      params,
      sourcePalette.length
    );
    mixed = mixColorsWeighted([mixed, mixedSecondary], bridge);
  }

  return perturbColor(rand, mixed, params.perturbRange);
}

function validateNewColor(rgbInt, { originalSet, usedSet, localSet }) {
  if (!Number.isFinite(rgbInt)) return { ok: false, reason: "invalid" };
  const color = rgbInt >>> 0;
  if (originalSet.has(color)) return { ok: false, reason: "matches-original" };
  if (usedSet && usedSet.has(color)) return { ok: false, reason: "already-used" };
  if (localSet && localSet.has(color)) return { ok: false, reason: "duplicate-output" };
  return { ok: true };
}

function preservesRoleReliefFloor(candidate, outlineInt) {
  // Keep the NoPunks black-on-black relationship intact: all non-role colors
  // must sit above the outline tone so background remains darkest, outline next.
  return colorLuminance(candidate >>> 0) > (colorLuminance(outlineInt >>> 0) + 0.001);
}

function candidateSourcePalette(originalPalette) {
  const unique = Array.from(new Set((originalPalette || []).map((n) => n >>> 0)));
  return unique;
}

function buildMixSourcePalette(originalPalette) {
  const set = new Set([ROLE_BACKGROUND, ROLE_OUTLINE]);
  for (const color of originalPalette || []) set.add(color >>> 0);
  return Array.from(set.values());
}

function sortBySourceTone(a, b) {
  const lumDiff = colorLuminance(a) - colorLuminance(b);
  if (Math.abs(lumDiff) > 0.0001) return lumDiff;
  const chromaDiff = colorChroma(a) - colorChroma(b);
  if (Math.abs(chromaDiff) > 0.0001) return chromaDiff;
  return (a >>> 0) - (b >>> 0);
}

function sortByCandidateTone(a, b) {
  const lumDiff = colorLuminance(a) - colorLuminance(b);
  if (Math.abs(lumDiff) > 0.0001) return lumDiff;
  const chromaDiff = colorChroma(a) - colorChroma(b);
  if (Math.abs(chromaDiff) > 0.0001) return chromaDiff;
  return (a >>> 0) - (b >>> 0);
}

function scaleOffsetFromBlack(background, sourceColor, scale = 1) {
  const bg = rgbIntToTuple(background);
  const src = rgbIntToTuple(sourceColor);
  return rgbTupleToInt({
    r: bg.r + src.r * scale,
    g: bg.g + src.g * scale,
    b: bg.b + src.b * scale,
  });
}

function generatePaletteMapping(options) {
  const {
    originalPalette,
    rarityNorm,
    derivedSeed,
    registrySnapshot,
    strict = true,
    maxAttempts = 512,
    retryNonce = 0,
  } = options || {};

  if (!strict) throw new Error("No-Palette v1 enforces strict mode");
  const palette = candidateSourcePalette(originalPalette);
  if (!palette.length) throw new Error("No visible palette colors found");
  const mixPalette = buildMixSourcePalette(palette);

  const originalSet = new Set(palette);
  // Role colors are part of the canonical NoPunks relationship, even if background is transparent in source assets.
  originalSet.add(ROLE_BACKGROUND);
  originalSet.add(ROLE_OUTLINE);
  const usedSet = registrySnapshot instanceof Set
    ? registrySnapshot
    : new Set(Array.isArray(registrySnapshot) ? registrySnapshot.map((n) => n >>> 0) : []);
  const params = computeMixerParams(rarityNorm);
  const rand = createPrng(derivedSeed, `mapping:${retryNonce}`);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const localSet = new Set();
    const mapping = {};
    const mappingInts = new Map();

    const bgRand = createPrng(derivedSeed, `bg:${retryNonce}:${attempt}`);
    let background = null;
    for (let i = 0; i < 256; i += 1) {
      const candidate = chooseMixCandidate(bgRand, mixPalette, params) >>> 0;
      if (!isExactRoleLiftSafe(candidate, 4)) continue;
      const outline = addRgbDelta(candidate, 4) >>> 0;
      const bgValid = validateNewColor(candidate, { originalSet, usedSet, localSet });
      if (!bgValid.ok) continue;
      localSet.add(candidate);
      const outlineValid = validateNewColor(outline, { originalSet, usedSet, localSet });
      if (!outlineValid.ok) {
        localSet.delete(candidate);
        continue;
      }
      localSet.add(outline);
      background = candidate;
      break;
    }
    if (background === null) continue;

    const outline = addRgbDelta(background, 4) >>> 0;
    const outlineFloor = outline >>> 0;
    if (palette.includes(ROLE_BACKGROUND)) {
      mappingInts.set(ROLE_BACKGROUND, background);
    }
    if (palette.includes(ROLE_OUTLINE)) {
      mappingInts.set(ROLE_OUTLINE, outline);
    }
    const sources = palette.filter((sourceColor) => sourceColor !== ROLE_BACKGROUND && sourceColor !== ROLE_OUTLINE);
    const darkThreshold = lerp(18, 42, params.rarityNorm);
    const neutralChromaThreshold = lerp(22, 40, params.rarityNorm);
    const darkSources = [];
    const neutralSources = [];
    const accentSources = [];
    for (const sourceColor of sources) {
      const lum = colorLuminance(sourceColor);
      const chr = colorChroma(sourceColor);
      if (lum <= darkThreshold) darkSources.push(sourceColor);
      else if (chr <= neutralChromaThreshold) neutralSources.push(sourceColor);
      else accentSources.push(sourceColor);
    }

    darkSources.sort(sortBySourceTone);
    neutralSources.sort(sortBySourceTone);
    accentSources.sort(sortBySourceTone);

    // Preserve the black-on-black essence by tying dark shades to the chosen background.
    for (const sourceColor of darkSources) {
      const colorRand = createPrng(derivedSeed, `dark:${retryNonce}:${attempt}:${sourceColor}`);
      let resolved = null;
      for (let tries = 0; tries < 128; tries += 1) {
        const scale = lerp(0.85, 1.35, colorRand());
        let candidate = scaleOffsetFromBlack(background, sourceColor, scale) >>> 0;
        candidate = perturbColor(colorRand, candidate, params.perturbRange / 4) >>> 0;
        if (candidate === outline) continue;
        if (!preservesRoleReliefFloor(candidate, outlineFloor)) continue;
        const valid = validateNewColor(candidate, { originalSet, usedSet, localSet });
        if (!valid.ok) continue;
        localSet.add(candidate);
        resolved = candidate;
        break;
      }
      if (resolved === null) {
        background = null;
        break;
      }
      mappingInts.set(sourceColor, resolved);
    }
    if (background === null) continue;

    // Neutral grays and skin-like tones should stay close to the new background to keep the silhouette/readability.
    for (const sourceColor of neutralSources) {
      const colorRand = createPrng(derivedSeed, `neutral:${retryNonce}:${attempt}:${sourceColor}`);
      let resolved = null;
      for (let tries = 0; tries < 160; tries += 1) {
        const scale = lerp(0.72, 1.22, colorRand());
        let candidate = scaleOffsetFromBlack(background, sourceColor, scale) >>> 0;
        const sourceLum = colorLuminance(sourceColor);
        const targetLumBias = sourceLum < 140 ? lerp(-6, 8, colorRand()) : lerp(-14, 4, colorRand());
        candidate = addRgbDelta(candidate, Math.round(targetLumBias / 3)) >>> 0;
        candidate = perturbColor(colorRand, candidate, params.perturbRange / 5) >>> 0;
        if (candidate === outline) continue;
        if (!preservesRoleReliefFloor(candidate, outlineFloor)) continue;
        const valid = validateNewColor(candidate, { originalSet, usedSet, localSet });
        if (!valid.ok) continue;
        localSet.add(candidate);
        resolved = candidate;
        break;
      }
      if (resolved === null) {
        background = null;
        break;
      }
      mappingInts.set(sourceColor, resolved);
    }
    if (background === null) continue;

    // For accents, mix from the full canonical palette (including roles) and preserve tonal ranking.
    const accentMixPalette = (() => {
      const set = new Set([ROLE_BACKGROUND, ROLE_OUTLINE]);
      for (const c of accentSources) set.add(c);
      for (const c of neutralSources.slice(0, 2)) set.add(c);
      const arr = Array.from(set.values());
      return arr.length >= 2 ? arr : mixPalette;
    })();

    // Choose one or two global anchors so accent colors feel part of one palette family.
    const anchorRand = createPrng(derivedSeed, `anchors:${retryNonce}:${attempt}`);
    const accentAnchorA = chooseMixCandidate(anchorRand, accentMixPalette, params) >>> 0;
    const accentAnchorB = chooseMixCandidate(anchorRand, accentMixPalette, params) >>> 0;

    const accentCandidates = [];
    for (const sourceColor of accentSources) {
      const colorRand = createPrng(derivedSeed, `color:${retryNonce}:${attempt}:${sourceColor}`);
      let resolved = null;
      for (let tries = 0; tries < 256; tries += 1) {
        const mixed = chooseMixCandidate(colorRand, accentMixPalette, params) >>> 0;
        const sourceOffset = scaleOffsetFromBlack(background, sourceColor, lerp(0.75, 1.25, colorRand())) >>> 0;

        const anchorBlend = colorRand() < 0.5 ? accentAnchorA : accentAnchorB;
        const bridgeWeights = sampleWeights(colorRand, 3, params.weightMin, params.weightMax);
        let candidate = mixColorsWeighted([mixed, sourceOffset, anchorBlend], bridgeWeights) >>> 0;

        const sourceLum = colorLuminance(sourceColor);
        const sourceChr = colorChroma(sourceColor);
        const candLum = colorLuminance(candidate);
        const candChr = colorChroma(candidate);

        const lumBlend = lerp(0.12, 0.46, params.rarityNorm);
        candidate = addRgbDelta(candidate, Math.round(((sourceLum - candLum) * lumBlend) / 3)) >>> 0;

        // If chroma collapsed too much, push it back toward the source offset family.
        if (candChr < Math.max(18, sourceChr * 0.35)) {
          const recoverWeights = sampleWeights(colorRand, 2, params.weightMin, params.weightMax);
          candidate = mixColorsWeighted([candidate, sourceOffset], recoverWeights) >>> 0;
        }

        candidate = perturbColor(colorRand, candidate, params.perturbRange / 2.8) >>> 0;
        if (!preservesRoleReliefFloor(candidate, outlineFloor)) continue;

        const valid = validateNewColor(candidate, { originalSet, usedSet, localSet });
        if (!valid.ok) continue;
        resolved = candidate;
        break;
      }
      if (resolved === null) {
        background = null;
        break;
      }
      accentCandidates.push(resolved);
    }

    if (background === null) continue;

    accentCandidates.sort(sortByCandidateTone);
    for (let i = 0; i < accentSources.length; i += 1) {
      const candidate = accentCandidates[i];
      const valid = validateNewColor(candidate, { originalSet, usedSet, localSet });
      if (!valid.ok) {
        background = null;
        break;
      }
      localSet.add(candidate);
      mappingInts.set(accentSources[i], candidate);
    }

    if (background === null) continue;

    for (const [source, target] of mappingInts.entries()) {
      mapping[intToHex(source)] = intToHex(target);
    }

    return {
      ok: true,
      params,
      attempts: attempt + 1,
      retryNonce,
      roles: {
        background: background >>> 0,
        outline: outline >>> 0,
        backgroundHex: intToHex(background),
        outlineHex: intToHex(outline),
      },
      mappingInts,
      mapping,
      generatedPalette: Array.from(localSet.values()).sort(sortByCandidateTone),
      generatedPaletteHex: Array.from(localSet.values()).sort(sortByCandidateTone).map(intToHex),
    };
  }

  return {
    ok: false,
    error: "generation-exhausted",
    params,
    retryNonce,
  };
}

function remapPixels24({ rgba24Bytes, mapping, roles }) {
  const bytes = Buffer.isBuffer(rgba24Bytes) ? Buffer.from(rgba24Bytes) : Buffer.from(rgba24Bytes || []);
  if (bytes.length % 4 !== 0) throw new Error("Invalid RGBA bytes");

  const backgroundInt = typeof roles?.background === "number" ? (roles.background >>> 0) : hexToInt(roles?.backgroundHex);
  const outlineInt = typeof roles?.outline === "number" ? (roles.outline >>> 0) : hexToInt(roles?.outlineHex);
  const mapped = new Map();
  for (const [srcHex, dstHex] of Object.entries(mapping || {})) {
    mapped.set(hexToInt(srcHex), hexToInt(dstHex));
  }

  const out = Buffer.allocUnsafe(bytes.length);

  for (let i = 0; i < bytes.length; i += 4) {
    const a = bytes[i + 3];
    if (a === 0) {
      out[i] = (backgroundInt >>> 16) & 0xff;
      out[i + 1] = (backgroundInt >>> 8) & 0xff;
      out[i + 2] = backgroundInt & 0xff;
      out[i + 3] = 255;
      continue;
    }

    const src = ((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]) >>> 0;
    let dst = mapped.get(src);
    if (dst === undefined) {
      if (src === ROLE_OUTLINE) dst = outlineInt;
      else if (src === ROLE_BACKGROUND) dst = backgroundInt;
      else dst = src;
    }
    out[i] = (dst >>> 16) & 0xff;
    out[i + 1] = (dst >>> 8) & 0xff;
    out[i + 2] = dst & 0xff;
    out[i + 3] = 255;
  }

  return out;
}

function canonicalPaletteSignature({ mapping, roles }) {
  const entries = Object.entries(mapping || {})
    .map(([src, dst]) => `${src.toUpperCase()}:${String(dst).toUpperCase()}`)
    .sort();
  if (roles) {
    entries.push(`ROLE_BG:${intToHex(typeof roles.background === "number" ? roles.background : hexToInt(roles.backgroundHex))}`);
    entries.push(`ROLE_OL:${intToHex(typeof roles.outline === "number" ? roles.outline : hexToInt(roles.outlineHex))}`);
  }
  return entries.join("|");
}

function stateSignature({
  tokenId,
  modeId,
  blockNumber,
  mapping,
  roles,
  output24Hash,
  outputKind = "single",
}) {
  return sha256Hex([
    `t:${Number(tokenId)}`,
    `m:${String(modeId || "canonical-machine")}`,
    `b:${Number(blockNumber)}`,
    `k:${String(outputKind || "single")}`,
    `p:${canonicalPaletteSignature({ mapping, roles })}`,
    `h:${String(output24Hash || "")}`,
  ].join("|"));
}

function rgbIntListFromMapping({ mapping, roles }) {
  const set = new Set();
  if (roles) {
    set.add(typeof roles.background === "number" ? roles.background >>> 0 : hexToInt(roles.backgroundHex));
    set.add(typeof roles.outline === "number" ? roles.outline >>> 0 : hexToInt(roles.outlineHex));
  }
  for (const dstHex of Object.values(mapping || {})) {
    set.add(hexToInt(dstHex));
  }
  return Array.from(set.values());
}

module.exports = {
  ROLE_BACKGROUND,
  ROLE_OUTLINE,
  TOOL_VERSION_DEFAULT,
  addRgbDelta,
  canonicalPaletteSignature,
  clamp01,
  computeMixerParams,
  createPrng,
  deriveSeed,
  deriveStateSeed,
  extractPaletteAndRoles,
  generatePaletteMapping,
  hexToInt,
  intToHex,
  normalizeRarity,
  remapPixels24,
  rgbIntListFromMapping,
  rgbIntToTuple,
  rgbTupleToInt,
  sha256Hex,
  stateSignature,
};
