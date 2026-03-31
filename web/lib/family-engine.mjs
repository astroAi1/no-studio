import { hexLuma, mixHex } from "./color.js";
import {
  clampUnit,
  hexToOklch,
  normalizeHue,
  oklabDistance,
  oklchToHexGamutSafe,
} from "./oklch.mjs";
import {
  buildVariantSeed,
  createSeededRandom,
  makeCuratedPaletteSignature,
  makePaletteSignature,
  makeSourcePaletteSignature,
  normalizeHexPalette,
  sanitizeCuratedPaletteMap,
} from "./gallery-provenance.mjs";

export const BRAND_ROLE_BG = "#000000";
export const BRAND_ROLE_FG = "#040404";
const MAX_COLOR_ADJUST_ATTEMPTS = 12;
const MAX_FAMILY_CANDIDATES = 20;

export const FAMILY_IDS = ["mono", "chrome", "warhol", "acid", "pastel"];

export const FAMILY_LABELS = {
  mono: "Mono",
  chrome: "Chrome",
  warhol: "Pop",
  acid: "Acid",
  pastel: "Pastel",
};

const FAMILY_BACKGROUND_FALLBACKS = {
  mono: "#6B6B6B",
  chrome: "#94A1B6",
  warhol: "#D94B2B",
  acid: "#4E8F1B",
  pastel: "#E6D7E8",
};

const SCORE_WEIGHTS = {
  hue: 30,
  lightness: 22,
  chroma: 18,
  temperature: 10,
  accentCount: 10,
  plate: 5,
  roleSeparation: 5,
};

function normalizeFamilyId(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "noir") return "chrome";
  if (raw === "pop") return "warhol";
  return FAMILY_IDS.includes(raw) ? raw : "mono";
}

export const FAMILY_SPECS = {
  mono: {
    label: "Mono",
    description: "One hue spine, restrained chroma, long tonal ladders.",
    backgroundL: [0.18, 0.30],
    backgroundC: [0.004, 0.020],
    toneLadder: [0.28, 0.38, 0.48, 0.58, 0.68, 0.78, 0.86],
    bodyC: [0.010, 0.050],
    accentC: [0.040, 0.080],
    familyFitThreshold: 82,
    ambiguityMargin: 10,
    noveltyLocalMin: 0.075,
    noveltyGalleryMin: 0.070,
    diversity: { minPaletteDistance: 0.075, minColorDistance: 0.040 },
  },
  chrome: {
    label: "Chrome",
    description: "Reflective metallic ramps with cool steel bodies and bright candy glints.",
    backgroundL: [0.34, 0.70],
    backgroundC: [0.008, 0.060],
    toneLadder: [0.20, 0.34, 0.50, 0.64, 0.76, 0.88, 0.96],
    bodyC: [0.015, 0.120],
    accentC: [0.080, 0.220],
    familyFitThreshold: 81,
    ambiguityMargin: 10,
    noveltyLocalMin: 0.075,
    noveltyGalleryMin: 0.070,
    diversity: { minPaletteDistance: 0.075, minColorDistance: 0.040 },
  },
  warhol: {
    label: "Pop",
    description: "Poster and screenprint logic with plate separation and warm/cool contrast.",
    backgroundL: [0.24, 0.44],
    backgroundC: [0.050, 0.140],
    toneLadder: [0.22, 0.34, 0.48, 0.64, 0.80, 0.90],
    bodyC: [0.140, 0.240],
    accentC: [0.200, 0.300],
    familyFitThreshold: 83,
    ambiguityMargin: 10,
    noveltyLocalMin: 0.105,
    noveltyGalleryMin: 0.095,
    diversity: { minPaletteDistance: 0.105, minColorDistance: 0.050 },
  },
  acid: {
    label: "Acid",
    description: "Deep grounds, hostile complements, and high-chroma clash.",
    backgroundL: [0.10, 0.22],
    backgroundC: [0.040, 0.120],
    toneLadder: [0.16, 0.24, 0.34, 0.46, 0.58, 0.72, 0.84],
    bodyC: [0.180, 0.300],
    accentC: [0.240, 0.360],
    familyFitThreshold: 85,
    ambiguityMargin: 12,
    noveltyLocalMin: 0.115,
    noveltyGalleryMin: 0.105,
    diversity: { minPaletteDistance: 0.115, minColorDistance: 0.056 },
  },
  pastel: {
    label: "Pastel",
    description: "High-light analogous palettes with soft drift and powder lift.",
    backgroundL: [0.72, 0.88],
    backgroundC: [0.010, 0.050],
    toneLadder: [0.78, 0.84, 0.89, 0.93, 0.96],
    bodyC: [0.020, 0.090],
    accentC: [0.060, 0.120],
    familyFitThreshold: 82,
    ambiguityMargin: 10,
    noveltyLocalMin: 0.060,
    noveltyGalleryMin: 0.055,
    diversity: { minPaletteDistance: 0.060, minColorDistance: 0.032 },
  },
};

function clampRange(min, max, value) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function randomBetween(rng, min, max) {
  return min + ((max - min) * rng());
}

function hueDistance(a, b) {
  let delta = Math.abs(normalizeHue(a) - normalizeHue(b));
  if (delta > 180) delta = 360 - delta;
  return delta;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function circularMean(hues) {
  if (!hues.length) return 0;
  let x = 0;
  let y = 0;
  for (const hue of hues) {
    const radians = (normalizeHue(hue) * Math.PI) / 180;
    x += Math.cos(radians);
    y += Math.sin(radians);
  }
  return normalizeHue((Math.atan2(y, x) * 180) / Math.PI);
}

function compactTones(spec, toneCount) {
  const ladder = Array.isArray(spec.toneLadder) ? spec.toneLadder : FAMILY_SPECS.mono.toneLadder;
  const wanted = Math.max(3, Math.min(ladder.length, Math.round(Number(toneCount) || 5)));
  if (wanted >= ladder.length) return ladder.slice();
  const out = [];
  for (let idx = 0; idx < wanted; idx += 1) {
    const pick = Math.round((idx / Math.max(1, wanted - 1)) * (ladder.length - 1));
    out.push(ladder[pick]);
  }
  return out;
}

function sortNonRoleEntries(classified) {
  return (Array.isArray(classified) ? classified : [])
    .filter((entry) => entry && entry.hex && entry.hex !== BRAND_ROLE_BG && entry.hex !== BRAND_ROLE_FG)
    .slice()
    .sort((a, b) => {
      const weight = (entry) => {
        if (entry.role === "accent") return 3;
        if (entry.role === "neutral") return 1;
        return 2;
      };
      const delta = weight(b) - weight(a);
      if (delta) return delta;
      return hexLuma(String(a.hex || "")) - hexLuma(String(b.hex || ""));
    });
}

function createUsedHexSet(rolePair) {
  return new Set([rolePair.background, rolePair.figure].filter(Boolean));
}

function chooseAnchorHex(classified, family, fallbackHex) {
  const nonRole = sortNonRoleEntries(classified);
  if (!nonRole.length) return fallbackHex;
  if (family === "mono" || family === "acid" || family === "chrome") {
    return String(nonRole[0].hex || fallbackHex).toUpperCase();
  }
  if (family === "pastel") {
    return String(nonRole[nonRole.length - 1].hex || fallbackHex).toUpperCase();
  }
  return String(nonRole[Math.floor((nonRole.length - 1) * 0.5)]?.hex || fallbackHex).toUpperCase();
}

function defaultFamilyBackgroundAnchorHex(family) {
  return String(FAMILY_BACKGROUND_FALLBACKS[normalizeFamilyId(family)] || FAMILY_BACKGROUND_FALLBACKS.mono).toUpperCase();
}

function strictRolePairFromBackground(backgroundHex) {
  const lch = hexToOklch(backgroundHex);
  const safeBg = oklchToHexGamutSafe({
    L: clampRange(0.02, 0.95, lch.L),
    C: Math.max(0.002, lch.C),
    H: lch.H,
  });
  const roundTrip = hexToOklch(safeBg);
  const safeL = Math.min(0.97, roundTrip.L + 0.015);
  const outline = oklchToHexGamutSafe({
    L: safeL,
    C: Math.max(roundTrip.C * 0.6, 0.004),
    H: roundTrip.H,
  });
  const bg = safeBg;
  const bgRgb = hexToRgbTuple(bg);
  const pairBg = tupleToHex({
    r: Math.min(251, bgRgb.r),
    g: Math.min(251, bgRgb.g),
    b: Math.min(251, bgRgb.b),
  });
  const pairBgTuple = hexToRgbTuple(pairBg);
  return {
    background: pairBg,
    figure: tupleToHex({
      r: pairBgTuple.r + 4,
      g: pairBgTuple.g + 4,
      b: pairBgTuple.b + 4,
    }),
    roleStep: 4,
  };
}

function strictRolePairFromOutline(outlineHex) {
  const tuple = hexToRgbTuple(outlineHex);
  return strictRolePairFromBackground(tupleToHex({
    r: Math.max(0, tuple.r - 4),
    g: Math.max(0, tuple.g - 4),
    b: Math.max(0, tuple.b - 4),
  }));
}

function hexToRgbTuple(hex) {
  const clean = String(hex || "#000000").replace(/^#/, "").padEnd(6, "0");
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function tupleToHex({ r, g, b }) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function adjustDistinctHex(candidateHex, usedHexes, spec, rolePair, rng) {
  let current = String(candidateHex || "#808080").toUpperCase();
  const used = usedHexes instanceof Set ? usedHexes : new Set();
  const minColorDistance = spec?.diversity?.minColorDistance || 0.04;
  for (let attempt = 0; attempt < MAX_COLOR_ADJUST_ATTEMPTS; attempt += 1) {
    const tooClose = [rolePair.background, rolePair.figure, ...used].some((existing) => oklabDistance(current, existing) < minColorDistance);
    if (!used.has(current) && !tooClose) {
      used.add(current);
      return current;
    }
    const lch = hexToOklch(current);
    current = oklchToHexGamutSafe({
      L: clampRange(0.05, 0.98, lch.L + (((attempt % 2 === 0) ? 1 : -1) * (0.024 + (attempt * 0.004)))),
      C: Math.max(0.008, lch.C + (0.01 + (rng() * 0.02))),
      H: normalizeHue(lch.H + 14 + (attempt * 9)),
    });
  }
  used.add(current);
  return current;
}

function applyCuratedLocks(mapping, curatedPaletteMap) {
  const next = { ...(mapping || {}) };
  for (const [sourceHex, targetHex] of Object.entries(curatedPaletteMap || {})) {
    next[sourceHex] = targetHex;
  }
  return next;
}

function groupHueFamilies(lchEntries, threshold = 28) {
  const clusters = [];
  for (const entry of lchEntries) {
    let placed = false;
    for (const cluster of clusters) {
      if (hueDistance(cluster.hue, entry.H) <= threshold) {
        cluster.values.push(entry);
        cluster.hue = circularMean(cluster.values.map((value) => value.H));
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ hue: entry.H, values: [entry] });
    }
  }
  return clusters.sort((a, b) => b.values.length - a.values.length);
}

function countAccentFamilies(nonRoleLch, chromaThreshold = 0.12) {
  return groupHueFamilies(nonRoleLch.filter((entry) => entry.C >= chromaThreshold), 30).length;
}

function estimatePlateCount(values, tolerance = 0.055) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const groups = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    if (Math.abs(sorted[i] - groups[groups.length - 1]) > tolerance) {
      groups.push(sorted[i]);
    }
  }
  return groups.length;
}

function shareWithinHueCorridor(nonRoleLch, anchorHue, width) {
  if (!nonRoleLch.length) return 0;
  return nonRoleLch.filter((entry) => hueDistance(entry.H, anchorHue) <= width).length / nonRoleLch.length;
}

function shareInRanges(nonRoleLch, ranges) {
  if (!nonRoleLch.length) return 0;
  return nonRoleLch.filter((entry) => ranges.some(([start, end]) => hueInRange(entry.H, start, end))).length / nonRoleLch.length;
}

function hueInRange(hue, start, end) {
  const safeHue = normalizeHue(hue);
  const safeStart = normalizeHue(start);
  const safeEnd = normalizeHue(end);
  if (safeStart <= safeEnd) return safeHue >= safeStart && safeHue <= safeEnd;
  return safeHue >= safeStart || safeHue <= safeEnd;
}

function bestComplementDistance(clusters) {
  if (clusters.length < 2) return 0;
  let best = 0;
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      best = Math.max(best, hueDistance(clusters[i].hue, clusters[j].hue));
    }
  }
  return best;
}

function normalizeHistoryVariants(list = []) {
  return (Array.isArray(list) ? list : []).map((entry) => ({
    family: normalizeFamilyId(entry?.family || entry?.familyId || ""),
    palette: normalizeHexPalette(entry?.palette || entry?.paletteHexes || []),
  })).filter((entry) => entry.palette.length);
}

function paletteDistance(aPalette, bPalette) {
  const paletteA = normalizeHexPalette(aPalette);
  const paletteB = normalizeHexPalette(bPalette);
  if (!paletteA.length || !paletteB.length) return 0;
  let total = 0;
  for (const colorA of paletteA) {
    let best = Infinity;
    for (const colorB of paletteB) {
      best = Math.min(best, oklabDistance(colorA, colorB));
    }
    total += best;
  }
  return total / paletteA.length;
}

function computeCandidateMetrics(candidate) {
  const palette = normalizeHexPalette(candidate.palette);
  const nonRole = palette.filter((hex) => hex !== candidate.rolePair.background && hex !== candidate.rolePair.figure);
  const nonRoleLch = nonRole.map((hex) => ({ hex, ...hexToOklch(hex) }));
  const background = hexToOklch(candidate.rolePair.background);
  const outline = hexToOklch(candidate.rolePair.figure);
  const hueAnchor = nonRoleLch.length ? circularMean(nonRoleLch.map((entry) => entry.H)) : background.H;
  const hueClusters = groupHueFamilies(nonRoleLch, 30);
  const warmShare = nonRoleLch.filter((entry) => entry.H < 90 || entry.H >= 330).length / Math.max(1, nonRoleLch.length);
  const coolShare = nonRoleLch.filter((entry) => entry.H >= 150 && entry.H < 285).length / Math.max(1, nonRoleLch.length);
  const avgC = mean(nonRoleLch.map((entry) => entry.C));
  const avgL = mean(nonRoleLch.map((entry) => entry.L));
  const maxC = nonRoleLch.length ? Math.max(...nonRoleLch.map((entry) => entry.C)) : 0;
  const maxL = nonRoleLch.length ? Math.max(...nonRoleLch.map((entry) => entry.L)) : 0;
  const minL = nonRoleLch.length ? Math.min(...nonRoleLch.map((entry) => entry.L)) : 0;
  const plateCount = estimatePlateCount(nonRoleLch.map((entry) => entry.L));
  const accentFamilies = countAccentFamilies(nonRoleLch);
  const roleSeparation = nonRole.length
    ? Math.min(...nonRole.map((hex) => Math.min(oklabDistance(hex, candidate.rolePair.background), oklabDistance(hex, candidate.rolePair.figure))))
    : 0;
  return {
    palette,
    nonRole,
    nonRoleLch,
    background,
    outline,
    hueAnchor,
    hueClusters,
    warmShare,
    coolShare,
    avgC,
    avgL,
    maxC,
    maxL,
    minL,
    plateCount,
    accentFamilies,
    roleSeparation,
    complementDistance: bestComplementDistance(hueClusters),
  };
}

function scaleRange(value, min, max) {
  if (max <= min) return value >= min ? 1 : 0;
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

function invertedRange(value, min, max) {
  return 1 - scaleRange(value, min, max);
}

function familyComponentScores(family, metrics) {
  const spec = FAMILY_SPECS[family];
  const bgWithinL = metrics.background.L >= spec.backgroundL[0] && metrics.background.L <= spec.backgroundL[1];
  const bgWithinC = metrics.background.C >= spec.backgroundC[0] && metrics.background.C <= spec.backgroundC[1];
  const bgScore = ((bgWithinL ? 0.65 : 0.25) + (bgWithinC ? 0.35 : 0.15));
  const corridorShare = shareWithinHueCorridor(metrics.nonRoleLch, metrics.hueAnchor, family === "pastel" ? 42 : family === "mono" ? 14 : 28);
  let hue = 0;
  let lightness = 0;
  let chroma = 0;
  let temperature = 0;
  let accentCount = 0;
  let plate = 0;

  if (family === "mono") {
    hue = corridorShare;
    lightness = Math.max(bgScore, scaleRange(metrics.maxL - metrics.minL, 0.28, 0.60));
    chroma = invertedRange(metrics.avgC, 0.03, 0.10) * 0.6 + invertedRange(metrics.maxC, 0.08, 0.14) * 0.4;
    temperature = invertedRange(metrics.hueClusters.length, 1.5, 3.5);
    accentCount = invertedRange(metrics.accentFamilies, 1.2, 3.2);
    plate = scaleRange(metrics.plateCount, 3, 6);
  } else if (family === "chrome") {
    const reflectiveRange = scaleRange(metrics.maxL - metrics.minL, 0.34, 0.68);
    const coolMetal = shareInRanges(metrics.nonRoleLch, [[175, 255]]);
    const brightShare = metrics.nonRoleLch.filter((entry) => entry.L >= 0.72).length / Math.max(1, metrics.nonRoleLch.length);
    hue = (coolMetal * 0.5) + (scaleRange(metrics.hueClusters.length, 1, 3) * 0.2) + (invertedRange(metrics.complementDistance, 95, 175) * 0.3);
    lightness = (bgScore * 0.4) + (reflectiveRange * 0.35) + (brightShare * 0.25);
    chroma = (scaleRange(metrics.avgC, 0.04, 0.16) * 0.6) + (invertedRange(metrics.maxC, 0.22, 0.30) * 0.4);
    temperature = coolMetal;
    accentCount = scaleRange(metrics.accentFamilies, 1, 3);
    plate = scaleRange(metrics.plateCount, 3, 6);
  } else if (family === "warhol") {
    const warmCool = Math.min(1, metrics.warmShare + metrics.coolShare);
    const posterClusters = scaleRange(metrics.hueClusters.length, 2, 4);
    hue = ((warmCool * 0.45) + (posterClusters * 0.30) + invertedRange(metrics.complementDistance, 160, 210) * 0.25) * bgScore;
    lightness = bgScore * scaleRange(metrics.plateCount, 3, 4);
    chroma = scaleRange(metrics.avgC, 0.14, 0.24);
    temperature = warmCool;
    accentCount = scaleRange(metrics.accentFamilies, 1, 3);
    plate = scaleRange(metrics.plateCount, 3, 4);
  } else if (family === "acid") {
    const complement = scaleRange(metrics.complementDistance, 130, 205);
    const highChromaShare = metrics.nonRoleLch.filter((entry) => entry.C >= 0.16).length / Math.max(1, metrics.nonRoleLch.length);
    hue = complement;
    lightness = bgScore * 0.7 + invertedRange(metrics.background.L, 0.22, 0.34) * 0.3;
    chroma = (scaleRange(metrics.avgC, 0.14, 0.28) * 0.45) + (highChromaShare * 0.55);
    temperature = Math.min(1, complement + (metrics.warmShare > 0.15 && metrics.coolShare > 0.15 ? 0.2 : 0));
    accentCount = scaleRange(metrics.accentFamilies, 1, 3);
    plate = scaleRange(metrics.plateCount, 3, 6);
  } else {
    const analogous = invertedRange(metrics.complementDistance, 55, 100);
    const highLightShare = metrics.nonRoleLch.filter((entry) => entry.L >= 0.78).length / Math.max(1, metrics.nonRoleLch.length);
    hue = analogous;
    lightness = (bgScore * 0.5) + (highLightShare * 0.5);
    chroma = invertedRange(metrics.maxC, 0.12, 0.16);
    temperature = analogous;
    accentCount = invertedRange(metrics.accentFamilies, 1.2, 2.8);
    plate = scaleRange(metrics.plateCount, 2, 5);
  }

  return {
    hue: clampUnit(hue),
    lightness: clampUnit(lightness),
    chroma: clampUnit(chroma),
    temperature: clampUnit(temperature),
    accentCount: clampUnit(accentCount),
    plate: clampUnit(plate),
    roleSeparation: clampUnit(scaleRange(metrics.roleSeparation, 0.04, 0.16)),
  };
}

function familyForbiddenOverlap(family, metrics) {
  if (family === "mono") {
    return metrics.nonRoleLch.some((entry) => hueDistance(entry.H, metrics.hueAnchor) > 18)
      || metrics.maxC > 0.10
      || metrics.accentFamilies > 1;
  }
  if (family === "chrome") {
    const coolMetal = shareInRanges(metrics.nonRoleLch, [[175, 255]]);
    return metrics.background.L < 0.28
      || metrics.background.L > 0.78
      || metrics.background.C > 0.09
      || metrics.avgC > 0.18
      || coolMetal < 0.35;
  }
  if (family === "warhol") {
    return metrics.background.L < 0.22 || metrics.plateCount < 3 || metrics.plateCount > 4 || (metrics.complementDistance >= 150 && metrics.complementDistance <= 205 && metrics.avgC > 0.24);
  }
  if (family === "acid") {
    const highChromaShare = metrics.nonRoleLch.filter((entry) => entry.C >= 0.16).length / Math.max(1, metrics.nonRoleLch.length);
    return metrics.background.L > 0.28 || highChromaShare < 0.45 || metrics.complementDistance < 130;
  }
  return metrics.maxC > 0.14 || metrics.complementDistance > 95 || metrics.nonRoleLch.filter((entry) => entry.L >= 0.78).length / Math.max(1, metrics.nonRoleLch.length) < 0.8;
}

function familyScore(family, metrics) {
  const components = familyComponentScores(family, metrics);
  const baseTotal = (
    (components.hue * SCORE_WEIGHTS.hue) +
    (components.lightness * SCORE_WEIGHTS.lightness) +
    (components.chroma * SCORE_WEIGHTS.chroma) +
    (components.temperature * SCORE_WEIGHTS.temperature) +
    (components.accentCount * SCORE_WEIGHTS.accentCount) +
    (components.plate * SCORE_WEIGHTS.plate) +
    (components.roleSeparation * SCORE_WEIGHTS.roleSeparation)
  );
  const forbiddenOverlap = familyForbiddenOverlap(family, metrics);
  const total = Math.max(0, baseTotal - (forbiddenOverlap ? 18 : 0));
  return {
    total: Number(total.toFixed(2)),
    components,
    forbiddenOverlap,
  };
}

function judgeCandidate(candidate, targetFamily, acceptedVariants, noveltyHistory) {
  const metrics = computeCandidateMetrics(candidate);
  const classification = FAMILY_IDS.map((family) => ({
    family,
    ...familyScore(family, metrics),
  })).sort((a, b) => b.total - a.total);
  const intended = classification.find((entry) => entry.family === targetFamily) || classification[0];
  const runnerUp = classification.find((entry) => entry.family !== targetFamily) || { total: 0 };
  const spec = FAMILY_SPECS[targetFamily];
  const localHistory = normalizeHistoryVariants(noveltyHistory?.localAcceptedVariants || []).filter((entry) => entry.family === targetFamily);
  const galleryHistory = normalizeHistoryVariants(noveltyHistory?.galleryHistory || []).filter((entry) => entry.family === targetFamily);
  const pageDistance = acceptedVariants.length
    ? Math.min(...acceptedVariants.map((entry) => paletteDistance(candidate.palette, entry.palette)))
    : 1;
  const localDistance = localHistory.length
    ? Math.min(...localHistory.map((entry) => paletteDistance(candidate.palette, entry.palette)))
    : 1;
  const galleryDistance = galleryHistory.length
    ? Math.min(...galleryHistory.map((entry) => paletteDistance(candidate.palette, entry.palette)))
    : 1;
  const accepted = (
    intended.total >= spec.familyFitThreshold &&
    (intended.total - runnerUp.total) >= spec.ambiguityMargin &&
    !intended.forbiddenOverlap &&
    localDistance >= spec.noveltyLocalMin &&
    galleryDistance >= spec.noveltyGalleryMin &&
    pageDistance >= spec.diversity.minPaletteDistance
  );
  const selectionScore = intended.total
    + (localDistance * 80)
    + (galleryDistance * 60)
    + (pageDistance * 40)
    - (intended.family !== targetFamily ? 22 : 0)
    - (intended.forbiddenOverlap ? 14 : 0);
  return {
    accepted,
    classification,
    intendedFamily: intended.family,
    intendedScore: intended.total,
    runnerUpFamily: runnerUp.family,
    runnerUpScore: runnerUp.total,
    pageDistance,
    localDistance,
    galleryDistance,
    selectionScore,
    metrics,
  };
}

function familyContext(family, rng, familyModifiers, globalModifiers, accentLockHue = null) {
  const modifiers = familyModifiers || {};
  const drift = clampUnit((Number(globalModifiers?.paletteDrift) || 0) / 100);
  if (family === "mono") {
    const anchorHue = accentLockHue == null ? randomBetween(rng, 0, 360) : accentLockHue;
    return {
      anchorHue,
      accentHue: anchorHue,
      hueDrift: (Number(modifiers.hueDrift) || 8) * (0.5 + drift),
      chips: ["single hue spine", "editorial ladder"],
    };
  }
  if (family === "chrome") {
    const glossModes = [
      { id: "magenta-flare", accentHue: randomBetween(rng, 314, 348), chips: ["metal gloss", "magenta flare"] },
      { id: "amber-flare", accentHue: randomBetween(rng, 34, 58), chips: ["metal gloss", "amber flare"] },
      { id: "ice-flare", accentHue: randomBetween(rng, 178, 204), chips: ["metal gloss", "ice flare"] },
    ];
    const picked = glossModes[Math.floor(rng() * glossModes.length)] || glossModes[0];
    const anchorHue = randomBetween(rng, 205, 235);
    return {
      schemeName: picked.id,
      anchorHue,
      secondaryHue: normalizeHue(anchorHue + randomBetween(rng, -18, 18)),
      tertiaryHue: normalizeHue(anchorHue + randomBetween(rng, -44, 44)),
      accentHue: accentLockHue == null ? picked.accentHue : accentLockHue,
      chips: picked.chips,
    };
  }
  if (family === "warhol") {
    const baseHue = accentLockHue == null ? randomBetween(rng, 0, 360) : accentLockHue;
    const harmony = rng() > 0.5 ? "triadic" : "split-poster";
    return {
      accentHue: baseHue,
      secondaryHue: normalizeHue(baseHue + (harmony === "triadic" ? randomBetween(rng, 110, 130) : randomBetween(rng, 145, 165))),
      tertiaryHue: normalizeHue(baseHue + (harmony === "triadic" ? randomBetween(rng, 230, 250) : randomBetween(rng, 35, 55))),
      harmony,
      chips: ["poster logic", harmony],
    };
  }
  if (family === "acid") {
    const baseHue = accentLockHue == null ? randomBetween(rng, 0, 360) : accentLockHue;
    const clashAngle = Number(modifiers.clashAngle) || randomBetween(rng, 150, 205);
    return {
      accentHue: baseHue,
      secondaryHue: normalizeHue(baseHue + clashAngle),
      tertiaryHue: normalizeHue(baseHue + randomBetween(rng, 90, 130)),
      chips: ["toxic clash", `axis ${Math.round(clashAngle)}°`],
    };
  }
  const baseHue = accentLockHue == null ? randomBetween(rng, 0, 360) : accentLockHue;
  return {
    anchorHue: baseHue,
    accentHue: baseHue,
    secondaryHue: normalizeHue(baseHue + randomBetween(rng, 22, 42)),
    tertiaryHue: normalizeHue(baseHue + randomBetween(rng, 55, 80)),
    chips: ["analog drift", "powder lift"],
  };
}

function makeBackgroundRolePair({
  family,
  spec,
  classified,
  rng,
  useActiveBg,
  selectedActiveHex,
  lockedBackgroundHex,
  context,
}) {
  const fallbackHex = defaultFamilyBackgroundAnchorHex(family);
  if (lockedBackgroundHex) {
    return strictRolePairFromBackground(lockedBackgroundHex);
  }
  if (useActiveBg && /^#[0-9A-F]{6}$/.test(String(selectedActiveHex || "").toUpperCase())) {
    return strictRolePairFromBackground(String(selectedActiveHex).toUpperCase());
  }
  const anchorHex = chooseAnchorHex(classified, family, fallbackHex);
  const anchor = hexToOklch(anchorHex);
  let hue = anchor.H;
  if (family === "mono") hue = normalizeHue(context.anchorHue + randomBetween(rng, -10, 10));
  if (family === "chrome") hue = normalizeHue((context.secondaryHue || context.anchorHue) + randomBetween(rng, -12, 12));
  if (family === "warhol") hue = normalizeHue(context.secondaryHue + randomBetween(rng, -18, 18));
  if (family === "acid") hue = normalizeHue(context.secondaryHue + randomBetween(rng, -18, 18));
  if (family === "pastel") hue = normalizeHue(context.anchorHue + randomBetween(rng, -16, 16));
  return strictRolePairFromBackground(oklchToHexGamutSafe({
    L: randomBetween(rng, spec.backgroundL[0], spec.backgroundL[1]),
    C: randomBetween(rng, spec.backgroundC[0], spec.backgroundC[1]),
    H: hue,
  }));
}

function hueForEntry(family, context, entry, rank, rng) {
  if (family === "mono") {
    return normalizeHue(context.anchorHue + randomBetween(rng, -Math.max(8, context.hueDrift), Math.max(8, context.hueDrift)));
  }
  if (family === "chrome") {
    if (entry.role === "accent") {
      const accentBank = [context.accentHue, context.tertiaryHue, context.secondaryHue].filter(Number.isFinite);
      return normalizeHue((accentBank[Math.floor(rng() * accentBank.length)] || context.accentHue) + randomBetween(rng, -10, 10));
    }
    const bodyBank = [context.anchorHue, context.secondaryHue, context.tertiaryHue].filter(Number.isFinite);
    return normalizeHue((bodyBank[Math.floor(rng() * bodyBank.length)] || context.anchorHue) + randomBetween(rng, -14, 14));
  }
  if (family === "warhol") {
    const bank = entry.role === "accent"
      ? [context.accentHue, context.secondaryHue, context.tertiaryHue]
      : [context.secondaryHue, context.tertiaryHue, context.accentHue];
    return normalizeHue((bank[Math.floor(rng() * bank.length)] || context.accentHue) + randomBetween(rng, -12, 12));
  }
  if (family === "acid") {
    const bank = entry.role === "accent"
      ? [context.accentHue, context.secondaryHue]
      : [context.secondaryHue, context.accentHue, context.tertiaryHue];
    return normalizeHue((bank[Math.floor(rng() * bank.length)] || context.accentHue) + randomBetween(rng, -16, 16));
  }
  if (entry.role === "accent") {
    return normalizeHue(context.tertiaryHue + randomBetween(rng, -10, 10));
  }
  return normalizeHue((rank > 0.65 ? context.secondaryHue : context.anchorHue) + randomBetween(rng, -12, 12));
}

function buildCandidateVariant({
  tokenId,
  family,
  classified,
  globalModifiers,
  familyModifiers,
  noMinimalMode,
  selectedActiveHex,
  useActiveBg,
  curatedPaletteMap,
  lockState,
  lockSnapshot,
  pageIndex,
  slotIndex,
  candidateIndex,
}) {
  const spec = FAMILY_SPECS[family];
  const sourcePaletteSignature = makeSourcePaletteSignature(classified);
  const curatedMapSignature = makeCuratedPaletteSignature(curatedPaletteMap);
  const variantSeed = buildVariantSeed({
    tokenId,
    family,
    sourcePaletteSignature,
    curatedMapSignature,
    lockState,
    pageIndex,
    slotIndex: (slotIndex * 100) + candidateIndex,
  });
  const rng = createSeededRandom(variantSeed);
  const accentLockHue = Boolean(lockState?.accentBias) && Number.isFinite(Number(lockSnapshot?.accentHue))
    ? Number(lockSnapshot.accentHue)
    : null;
  const context = familyContext(family, rng, familyModifiers, globalModifiers, accentLockHue);
  const lockedBackgroundHex = Boolean(lockState?.background) && /^#[0-9A-F]{6}$/.test(String(lockSnapshot?.backgroundHex || "").toUpperCase())
    ? String(lockSnapshot.backgroundHex).toUpperCase()
    : null;
  const rolePair = makeBackgroundRolePair({
    family,
    spec,
    classified,
    rng,
    useActiveBg,
    selectedActiveHex,
    lockedBackgroundHex,
    context,
  });
  const entries = sortNonRoleEntries(classified);
  const tones = compactTones(spec, globalModifiers?.toneCount);
  const usedHexes = createUsedHexSet(rolePair);
  const mapping = {};
  const total = Math.max(1, entries.length - 1);
  const contrast = clampUnit((Number(globalModifiers?.contrast) || 0) / 100);
  const traitFocus = clampUnit((Number(globalModifiers?.traitFocus) || 0) / 100);
  const drift = clampUnit((Number(globalModifiers?.paletteDrift) || 0) / 100);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const sourceHex = String(entry.hex || "").toUpperCase();
    if (curatedPaletteMap[sourceHex]) continue;
    const rank = index / total;
    const toneIndex = Math.min(tones.length - 1, Math.max(0, Math.round(rank * (tones.length - 1))));
    let L = tones[toneIndex];
    let C = randomBetween(rng, ...(entry.role === "accent" ? spec.accentC : spec.bodyC));
    let H = hueForEntry(family, context, entry, rank, rng);

    if (family === "mono") {
      const compression = clampUnit((Number(familyModifiers?.stepCompression) || 0) / 100);
      L = clampRange(0.22, 0.90, L - (compression * 0.08) + (entry.role === "accent" ? 0.03 : 0));
      C *= 0.7 + (traitFocus * 0.25);
    } else if (family === "chrome") {
      const shimmer = clampUnit((Number(familyModifiers?.shimmer) || 0) / 100);
      const polish = clampUnit((Number(familyModifiers?.polish) || 0) / 100);
      L = clampRange(
        0.16,
        0.98,
        L + (shimmer * 0.10) + (entry.role === "accent" ? 0.06 : 0.02) + ((rng() - 0.5) * 0.05),
      );
      C *= entry.role === "accent"
        ? (1.08 + (polish * 0.28))
        : (0.72 + (polish * 0.18));
    } else if (family === "warhol") {
      const flatness = clampUnit((Number(familyModifiers?.flatness) || 0) / 100);
      L = clampRange(0.18, 0.95, tones[Math.min(tones.length - 1, Math.round(rank * Math.min(tones.length - 1, 3)))] + (entry.role === "accent" ? 0.05 : 0) - (flatness * 0.06));
      C *= 1 + ((1 - flatness) * 0.16);
    } else if (family === "acid") {
      const corrosion = clampUnit((Number(familyModifiers?.corrosion) || 0) / 100);
      L = clampRange(0.12, 0.88, L + ((rng() - 0.5) * 0.08 * (1 + corrosion)));
      C *= 1.04 + (corrosion * 0.18);
    } else if (family === "pastel") {
      const softness = clampUnit((Number(familyModifiers?.powderSoftness) || 0) / 100);
      const airLift = clampUnit((Number(familyModifiers?.airLift) || 0) / 100);
      L = clampRange(0.70, 0.98, L + (airLift * 0.06) + (entry.role === "accent" ? 0.02 : 0));
      C *= 0.72 - (softness * 0.14);
    }

    L = clampRange(0.06, 0.98, L + ((entry.role === "accent" ? 1 : -1) * contrast * 0.03));
    C = clampRange(0.008, family === "acid" ? 0.36 : 0.30, C + (traitFocus * (entry.role === "accent" ? 0.02 : 0.008)) + (drift * 0.01));
    const candidateHex = oklchToHexGamutSafe({ L, C, H });
    mapping[sourceHex] = adjustDistinctHex(candidateHex, usedHexes, spec, rolePair, rng);
  }

  const finalMapping = applyCuratedLocks(mapping, curatedPaletteMap);
  finalMapping[BRAND_ROLE_BG] = rolePair.background;
  finalMapping[BRAND_ROLE_FG] = rolePair.figure;

  return {
    family,
    variantSeed,
    pageIndex,
    slotIndex,
    candidateIndex,
    sourcePaletteSignature,
    curatedMapSignature,
    mapping: finalMapping,
    roles: {
      background: rolePair.background,
      outline: rolePair.figure,
    },
    rolePair: {
      background: rolePair.background,
      figure: rolePair.figure,
      mode: noMinimalMode,
      roleStep: 4,
    },
    palette: normalizeHexPalette([
      rolePair.background,
      rolePair.figure,
      ...Object.values(finalMapping),
    ]),
    meta: {
      accentHue: context.accentHue,
      secondaryHue: context.secondaryHue || null,
      tertiaryHue: context.tertiaryHue || null,
      schemeName: context.schemeName || null,
      harmony: context.harmony || null,
      familyDescription: spec.description,
      lockedBackground: Boolean(lockState?.background),
      lockedAccentBias: Boolean(lockState?.accentBias),
      lockedCuratedMap: Boolean(lockState?.curatedMap),
    },
    ui: {
      chips: context.chips.slice(0, 4),
    },
  };
}

function createVariantName(family, chips, slotIndex) {
  const label = FAMILY_LABELS[family] || "Studio";
  const lead = Array.isArray(chips) && chips.length ? chips[0] : "variant";
  return `${label} · ${lead} · v${slotIndex + 1}`;
}

export function buildFamilyVariant({
  tokenId,
  family = "mono",
  classified = [],
  globalModifiers = {},
  familyModifiers = {},
  noMinimalMode = "exact",
  selectedActiveHex = "#808080",
  useActiveBg = false,
  curatedPaletteMap = {},
  lockState = {},
  lockSnapshot = {},
  pageIndex = 0,
  slotIndex = 0,
  acceptedVariants = [],
  noveltyHistory = {},
}) {
  const safeFamily = normalizeFamilyId(family);
  const safeCuratedMap = sanitizeCuratedPaletteMap(Boolean(lockState?.curatedMap) ? curatedPaletteMap : {});
  let bestAccepted = null;
  let bestFallback = null;

  for (let candidateIndex = 0; candidateIndex < MAX_FAMILY_CANDIDATES; candidateIndex += 1) {
    const candidate = buildCandidateVariant({
      tokenId,
      family: safeFamily,
      classified,
      globalModifiers,
      familyModifiers,
      noMinimalMode,
      selectedActiveHex,
      useActiveBg,
      curatedPaletteMap: safeCuratedMap,
      lockState,
      lockSnapshot,
      pageIndex,
      slotIndex,
      candidateIndex,
    });
    const judgement = judgeCandidate(candidate, safeFamily, acceptedVariants, noveltyHistory);
    const chips = [...new Set([...(candidate.ui?.chips || []), FAMILY_LABELS[judgement.intendedFamily] || "Studio"])].slice(0, 4);
    const shaped = {
      ...candidate,
      id: `${safeFamily}-${candidate.variantSeed}-${candidateIndex}`,
      name: createVariantName(safeFamily, chips, slotIndex),
      paletteSignature: makePaletteSignature(candidate.palette),
      score: judgement.intendedScore,
      accepted: judgement.accepted,
      classification: judgement.classification,
      scores: {
        totalScore: judgement.intendedScore,
        familyFitScore: judgement.intendedScore,
        roleSeparationScore: Number((judgement.metrics.roleSeparation * 100).toFixed(2)),
        noveltyScore: Number((Math.min(judgement.localDistance, judgement.galleryDistance, judgement.pageDistance) * 100).toFixed(2)),
        localDistance: Number(judgement.localDistance.toFixed(4)),
        galleryDistance: Number(judgement.galleryDistance.toFixed(4)),
        pageDistance: Number(judgement.pageDistance.toFixed(4)),
      },
      ui: {
        chips,
      },
      meta: {
        ...candidate.meta,
        intendedFamily: judgement.intendedFamily,
        intendedScore: judgement.intendedScore,
        runnerUpFamily: judgement.runnerUpFamily,
        runnerUpScore: judgement.runnerUpScore,
        accepted: judgement.accepted,
      },
    };

    const scored = {
      ...shaped,
      selectionScore: judgement.selectionScore,
    };

    if (scored.accepted && (!bestAccepted || scored.selectionScore > bestAccepted.selectionScore)) {
      bestAccepted = scored;
    }
    if (!bestFallback || scored.selectionScore > bestFallback.selectionScore) {
      bestFallback = scored;
    }
  }

  const picked = bestAccepted || bestFallback;
  picked.mapping[BRAND_ROLE_BG] = picked.roles.background;
  picked.mapping[BRAND_ROLE_FG] = picked.roles.outline;
  return picked;
}

export function variantPaletteDistance(a, b) {
  return paletteDistance(a?.palette || [], b?.palette || []);
}
