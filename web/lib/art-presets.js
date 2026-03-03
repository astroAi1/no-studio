// art-presets.js — creative preset systems for No-Palette Studio

// ── HSL ↔ RGB conversion ────────────────────────────────────────────

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r;
  let g;
  let b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

export function rgbToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`.toUpperCase();
}

export function hexToRgb(hex) {
  const clean = String(hex || "").replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ── Color Harmony Generators ────────────────────────────────────────

function complementary(h) {
  return [(h + 180) % 360];
}

function triadic(h) {
  return [(h + 120) % 360, (h + 240) % 360];
}

function analogous(h) {
  return [(h + 30) % 360, (h - 30 + 360) % 360];
}

function splitComplementary(h) {
  return [(h + 150) % 360, (h + 210) % 360];
}

const HARMONY_FNS = {
  complementary,
  triadic,
  analogous,
  "split-complementary": splitComplementary,
};

export function generateHarmony(baseHue, strategy, count = 4) {
  const fn = HARMONY_FNS[strategy] || complementary;
  const hues = [baseHue, ...fn(baseHue)];
  const out = [];
  for (let i = 0; out.length < count; i += 1) {
    out.push(hues[i % hues.length]);
  }
  return out;
}

// ── Relief Delta System ─────────────────────────────────────────────

export const DEFAULT_TONE_STEP = 4;

function normalizeToneStep(value) {
  const step = Math.round(Number(value) || DEFAULT_TONE_STEP);
  return Math.max(1, Math.min(36, step));
}

export function deriveOutline(bgRgb, toneStep = DEFAULT_TONE_STEP) {
  const step = normalizeToneStep(toneStep);
  return {
    r: Math.min(255, bgRgb.r + step),
    g: Math.min(255, bgRgb.g + step),
    b: Math.min(255, bgRgb.b + step),
  };
}

export function clampBgForOutline(bgRgb, toneStep = DEFAULT_TONE_STEP) {
  const step = normalizeToneStep(toneStep);
  const cap = 255 - step;
  return {
    r: Math.min(cap, bgRgb.r),
    g: Math.min(cap, bgRgb.g),
    b: Math.min(cap, bgRgb.b),
  };
}

function reliefFloorFromStep(toneStep) {
  return Math.max(8, normalizeToneStep(toneStep) * 2.5);
}

function buildColorContext(sourcePalette, options = {}) {
  const originalHex = new Set((sourcePalette || []).map((entry) => String(entry.hex || "").toUpperCase()));
  const usedHex = new Set();
  const step = normalizeToneStep(options.toneStep);
  const roleStep = normalizeToneStep(options.roleStep ?? step);
  return {
    toneStep: step,
    roleStep,
    originalHex,
    usedHex,
  };
}

function ensureUniqueCreativeRgb(rgb, context, minLuma) {
  let hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  let attempts = 0;
  const floor = Number.isFinite(minLuma) ? minLuma : 0;

  while (attempts < 24) {
    const candidate = hslToRgb(hsl.h, hsl.s, hsl.l);
    const luma = luminance(candidate.r, candidate.g, candidate.b);
    const hex = rgbToHex(candidate.r, candidate.g, candidate.b);
    if (luma >= floor && !context.usedHex.has(hex) && !context.originalHex.has(hex)) {
      context.usedHex.add(hex);
      return candidate;
    }
    hsl = {
      h: (hsl.h + 11 + (attempts * 3)) % 360,
      s: clamp01(hsl.s + (attempts % 2 === 0 ? 0.025 : -0.012)),
      l: clamp01(Math.max(hsl.l, floor / 255) + 0.022),
    };
    attempts += 1;
  }

  const fallback = hslToRgb(hsl.h, hsl.s, clamp01(Math.max(hsl.l, floor / 255)));
  const fallbackHex = rgbToHex(fallback.r, fallback.g, fallback.b);
  context.usedHex.add(fallbackHex);
  return fallback;
}

function registerRoleHexes(context, bgRgb, olRgb) {
  context.usedHex.add(rgbToHex(bgRgb.r, bgRgb.g, bgRgb.b));
  context.usedHex.add(rgbToHex(olRgb.r, olRgb.g, olRgb.b));
}

function sortSourceColors(sourcePalette) {
  return (sourcePalette || [])
    .filter((c) => c.role !== "background" && c.role !== "outline")
    .map((c) => {
      const rgb = hexToRgb(c.hex);
      return {
        ...c,
        rgb,
        luma: luminance(rgb.r, rgb.g, rgb.b),
      };
    })
    .sort((a, b) => a.luma - b.luma);
}

function finalizeMapping({ sourcePalette, mapping, bgRgb, olRgb }) {
  const bgHex = rgbToHex(bgRgb.r, bgRgb.g, bgRgb.b);
  const olHex = rgbToHex(olRgb.r, olRgb.g, olRgb.b);

  for (const c of sourcePalette) {
    if (c.role === "background") mapping[c.hex] = bgHex;
    if (c.role === "outline") mapping[c.hex] = olHex;
  }

  return {
    mapping,
    roles: {
      background: bgHex,
      outline: olHex,
    },
  };
}

function getOverrideBgRgb(options, roleStep) {
  const overrideHex = String(options?.backgroundHex || "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(overrideHex)) return null;
  return clampBgForOutline(hexToRgb(overrideHex), roleStep);
}

// ── Apply Preset to Palette ─────────────────────────────────────────

export function applyPreset(preset, sourcePalette, options = {}) {
  if (preset.type === "mono") {
    return applyMonoPreset(preset, sourcePalette, options);
  }
  if (preset.type === "delta-noir") {
    return applyDeltaNoirPreset(preset, sourcePalette, options);
  }
  if (preset.type === "reinhardt") {
    return applyReinhardtPreset(preset, sourcePalette, options);
  }
  return applyWarholPreset(preset, sourcePalette, options);
}

function applyWarholPreset(preset, sourcePalette, options = {}) {
  const context = buildColorContext(sourcePalette, options);
  const bgHue = (preset.baseHue + (preset.bgHueShift || 0) + 360) % 360;
  const bgLightness = clamp01(0.5 + ((preset.bgLightness - 0.5) * (preset.bgContrast || 1)));
  const bgRgb = getOverrideBgRgb(options, context.roleStep)
    || clampBgForOutline(hslToRgb(bgHue, preset.bgSaturation, bgLightness), context.roleStep);
  const olRgb = deriveOutline(bgRgb, context.roleStep);
  registerRoleHexes(context, bgRgb, olRgb);

  const outlineLuma = luminance(olRgb.r, olRgb.g, olRgb.b);
  const floor = outlineLuma + reliefFloorFromStep(context.toneStep);
  const harmonyHues = generateHarmony(preset.baseHue, preset.harmony, 8);
  const sorted = sortSourceColors(sourcePalette);
  const mapping = {};
  const contrast = preset.contrast || 1;
  const phase = preset.phase || 0;
  const hueDrift = preset.hueDrift || 0;
  const lumaSpread = preset.lumaSpread || 1;

  for (let i = 0; i < sorted.length; i += 1) {
    const baseT = sorted.length > 1 ? i / (sorted.length - 1) : 0.5;
    const t = clamp01(0.5 + ((baseT - 0.5) * contrast));
    const steppedT = Math.round(t * 3) / 3;
    const isAccent = sorted[i].role === "accent";
    const hueIndex = isAccent
      ? ((i * 2) + 1) % harmonyHues.length
      : (Math.floor(i / 2) % harmonyHues.length);
    const hue = (
      harmonyHues[hueIndex]
      + (Math.sin(((i + 1) * 0.85) + phase) * (isAccent ? hueDrift : hueDrift * 0.45))
      + 360
    ) % 360;
    const sat = clamp01((preset.colorSaturation || 0.84) + (isAccent ? 0.1 : 0.03));
    const lightStep = isAccent
      ? [0.3, 0.44, 0.58, 0.72][Math.min(3, Math.round(steppedT * 3))]
      : [0.22, 0.36, 0.5, 0.64][Math.min(3, Math.round(steppedT * 3))];
    const light = clamp01(
      lightStep
      + ((lumaSpread - 1) * 0.08)
      + (isAccent ? 0.03 : 0)
      + (Math.sin(((i + 1) * 1.4) + phase) * (isAccent ? 0.018 : 0.01)),
    );
    const rgb = ensureUniqueCreativeRgb(hslToRgb(hue, sat, light), context, floor);
    mapping[sorted[i].hex] = rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  return finalizeMapping({ sourcePalette, mapping, bgRgb, olRgb });
}

function applyMonoPreset(preset, sourcePalette, options = {}) {
  const context = buildColorContext(sourcePalette, options);
  const bgRgb = getOverrideBgRgb(options, context.roleStep)
    || clampBgForOutline(
      hslToRgb(preset.baseHue, preset.bgSaturation ?? 0.1, preset.bgLightness ?? 0.16),
      context.roleStep,
    );
  const olRgb = deriveOutline(bgRgb, context.roleStep);
  registerRoleHexes(context, bgRgb, olRgb);

  const outlineLuma = luminance(olRgb.r, olRgb.g, olRgb.b);
  const floor = outlineLuma + reliefFloorFromStep(context.toneStep);
  const sorted = sortSourceColors(sourcePalette);
  const mapping = {};
  const phase = preset.huePhase || 0;
  const contrast = preset.contrast || 1;
  const curve = preset.curve || 1;
  const hueDrift = Math.min(preset.hueDrift || 0, 5);
  const accentPulse = preset.accentPulse || 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const baseT = sorted.length > 1 ? i / (sorted.length - 1) : 0.5;
    const t = clamp01(Math.pow(baseT, curve));
    const adjustedT = clamp01(0.5 + ((t - 0.5) * contrast));
    const steppedT = Math.round(adjustedT * 4) / 4;
    const isAccent = sorted[i].role === "accent";
    const hue = (preset.baseHue
      + (Math.sin(((i + 1) * 1.3) + phase) * Math.min(preset.hueSwing || 0, 3))
      + (Math.cos(((i + 1) * 0.7) + phase) * hueDrift)
      + 360) % 360;
    const satBase = lerp(
      preset.bodySaturationMin ?? 0.04,
      isAccent ? (preset.accentSaturationMax ?? 0.2) : (preset.bodySaturationMax ?? 0.12),
      steppedT,
    );
    const sat = clamp01(satBase + (isAccent ? (Math.sin(((i + 1) * 0.9) + phase) * Math.min(accentPulse, 0.035)) : 0));
    const light = clamp01(
      (preset.bodyLightnessBase ?? 0.26)
      + (steppedT * (preset.bodyLightnessRange ?? 0.28))
      + (isAccent ? 0.03 : 0)
      + (Math.sin(((i + 1) * 0.85) + phase) * 0.018),
    );
    const rgb = ensureUniqueCreativeRgb(hslToRgb(hue, sat, light), context, floor);
    mapping[sorted[i].hex] = rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  return finalizeMapping({ sourcePalette, mapping, bgRgb, olRgb });
}

function applyDeltaNoirPreset(preset, sourcePalette, options = {}) {
  const context = buildColorContext(sourcePalette, options);
  const bgRgb = getOverrideBgRgb(options, context.roleStep)
    || clampBgForOutline(
      hslToRgb(preset.baseHue, preset.baseSaturation ?? 0.08, preset.baseLightness ?? 0.09),
      context.roleStep,
    );
  const olRgb = deriveOutline(bgRgb, context.roleStep);
  registerRoleHexes(context, bgRgb, olRgb);

  const outlineLuma = luminance(olRgb.r, olRgb.g, olRgb.b);
  const floor = outlineLuma + reliefFloorFromStep(context.toneStep);
  const sorted = sortSourceColors(sourcePalette);
  const mapping = {};
  const phase = preset.driftPhase || 0;
  const curve = preset.curve || 1;
  const depthBias = preset.depthBias || 0;
  const shadowBase = (preset.baseLightness ?? 0.09) + (preset.shadowLift ?? 0.05) + depthBias;

  for (let i = 0; i < sorted.length; i += 1) {
    const baseT = sorted.length > 1 ? i / (sorted.length - 1) : 0.5;
    const t = clamp01(Math.pow(baseT, curve));
    const isAccent = sorted[i].role === "accent";
    const hue = (preset.baseHue
      + (isAccent ? (preset.accentHueShift || 22) : (preset.bodyHueShift || 2))
      + (Math.sin(((i + 1) * 1.1) + phase) * (isAccent ? (preset.accentPulse || 0) : Math.min(preset.bodyPulse || 0, 1.4)))
      + 360) % 360;
    const sat = clamp01(
      (preset.baseSaturation ?? 0.05)
      + (isAccent ? (preset.accentSaturationLift ?? 0.16) : (preset.bodySaturationLift ?? 0.02))
      + (isAccent ? (t * 0.03) : (t * 0.01)),
    );
    const light = clamp01(
      shadowBase
      + (t * (isAccent ? (preset.accentLightnessRange ?? 0.28) : (preset.bodyLightnessRange ?? 0.08)))
      + (isAccent ? 0.035 : 0)
      + (Math.cos(((i + 1) * 0.7) + phase) * (isAccent ? 0.026 : 0.012)),
    );
    const rgb = ensureUniqueCreativeRgb(hslToRgb(hue, sat, light), context, floor);
    mapping[sorted[i].hex] = rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  return finalizeMapping({ sourcePalette, mapping, bgRgb, olRgb });
}

function applyReinhardtPreset(preset, sourcePalette, options = {}) {
  return applyDeltaNoirPreset({
    ...preset,
    type: "delta-noir",
    bodySaturationLift: 0.02,
    accentSaturationLift: 0.08,
    bodyLightnessRange: preset.lightnessRange || 0.06,
    accentLightnessRange: Math.max(0.1, (preset.lightnessRange || 0.06) * 2),
  }, sourcePalette, options);
}

// ── Dither Theory Builder ───────────────────────────────────────────

export function buildTheoryPalette(baseHex, strategy = "mono", options = {}) {
  const toneStep = normalizeToneStep(options.toneStep);
  const total = Math.max(2, Math.min(6, Math.round(options.count || 5)));
  const base = hexToRgb(baseHex);
  const baseHsl = rgbToHsl(base.r, base.g, base.b);
  const context = {
    toneStep,
    originalHex: new Set(),
    usedHex: new Set(),
  };

  const bgRgb = clampBgForOutline(
    hslToRgb(baseHsl.h, Math.max(0.03, baseHsl.s * 0.28), clamp01(0.05 + (baseHsl.l * 0.22))),
    toneStep,
  );
  const olRgb = deriveOutline(bgRgb, toneStep);
  registerRoleHexes(context, bgRgb, olRgb);

  const outlineLuma = luminance(olRgb.r, olRgb.g, olRgb.b);
  const floor = outlineLuma + reliefFloorFromStep(toneStep);
  const mode = strategy === "split" ? "split-complementary" : strategy;
  const hues = strategy === "mono"
    ? new Array(Math.max(0, total - 2)).fill(baseHsl.h)
    : generateHarmony(baseHsl.h, mode, Math.max(1, total - 2));

  const palette = [bgRgb, olRgb];
  for (let i = 0; palette.length < total; i += 1) {
    const t = total > 3 ? i / Math.max(1, total - 3) : 0.5;
    const hue = strategy === "mono"
      ? (baseHsl.h + (Math.sin((i + 1) * 1.2) * 6)) % 360
      : hues[i % hues.length];
    const sat = clamp01(strategy === "mono"
      ? Math.max(0.08, baseHsl.s * 0.35) + (t * 0.12)
      : 0.38 + (t * 0.28));
    const light = clamp01(0.28 + (t * 0.42));
    const rgb = ensureUniqueCreativeRgb(hslToRgb(hue, sat, light), context, floor);
    palette.push(rgb);
  }

  return palette;
}

function randomUnit() {
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  }
  return Math.random();
}

function randomBetween(min, max) {
  return min + ((max - min) * randomUnit());
}

function randomInt(min, max) {
  return Math.floor(randomBetween(min, max + 1));
}

function pickRandom(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[randomInt(0, list.length - 1)];
}

function pickAnchorHex({ activeHex, sourcePalette, excludeActiveHex = false }) {
  let candidateColors = (sourcePalette || [])
    .filter((entry) => entry.role !== "background" && entry.role !== "outline")
    .map((entry) => String(entry.hex || "").toUpperCase())
    .filter(Boolean);
  const normalizedActive = activeHex && /^#[0-9A-F]{6}$/i.test(activeHex)
    ? String(activeHex).toUpperCase()
    : null;

  if (excludeActiveHex && normalizedActive) {
    const filtered = candidateColors.filter((hex) => hex !== normalizedActive);
    if (filtered.length) candidateColors = filtered;
  }

  if (activeHex && /^#[0-9A-F]{6}$/i.test(activeHex)) {
    if (!excludeActiveHex) return String(activeHex).toUpperCase();
  }
  const fallbackHex = excludeActiveHex
    ? (candidateColors[0] || "#808080")
    : (activeHex || candidateColors[0] || "#808080");
  return String(pickRandom(candidateColors) || fallbackHex).toUpperCase();
}

function makeVariantName(family) {
  const words = {
    mono: ["Tone", "Field", "Ghost", "Stack", "Fold", "Echo", "Wash", "Plate"],
    noir: ["Noir", "Void", "Veil", "Night", "Coal", "Smoke", "Relief", "Shadow"],
    warhol: ["Flash", "Burst", "Signal", "Pop", "Voltage", "Chromatic", "Screen", "Panel"],
  };
  const pool = words[family] || ["Variant"];
  const a = pickRandom(pool);
  const b = pickRandom(pool.filter((word) => word !== a));
  return b ? `${a} ${b}` : a;
}

export function createRandomPreset(family, { activeHex = null, sourcePalette = [], excludeActiveHex = false } = {}) {
  const anchorHex = pickAnchorHex({ activeHex, sourcePalette, excludeActiveHex });
  const anchorRgb = hexToRgb(anchorHex);
  const anchorHsl = rgbToHsl(anchorRgb.r, anchorRgb.g, anchorRgb.b);
  const anchorHue = anchorHsl.h;

  if (family === "mono") {
    const baseHue = (anchorHue + randomBetween(-8, 8) + 360) % 360;
    const hueSwing = randomBetween(0.4, 3.2);
    const hueDrift = randomBetween(0.5, 4.5);
    const curve = randomBetween(0.82, 1.32);
    const contrast = randomBetween(0.92, 1.26);
    const huePhase = randomBetween(0, Math.PI * 2);
    const accentPulse = randomBetween(0.005, 0.03);
    const preset = {
      id: `mono-random-${Math.floor(randomUnit() * 1e9)}`,
      name: makeVariantName("mono"),
      type: "mono",
      baseHue,
      bgSaturation: randomBetween(0.03, 0.1),
      bgLightness: randomBetween(0.13, 0.22),
      bodySaturationMin: randomBetween(0.02, 0.07),
      bodySaturationMax: randomBetween(0.06, 0.14),
      accentSaturationMax: randomBetween(0.12, 0.24),
      bodyLightnessBase: randomBetween(0.24, 0.31),
      bodyLightnessRange: randomBetween(0.22, 0.32),
      hueSwing,
      hueDrift,
      curve,
      contrast,
      huePhase,
      accentPulse,
      ui: {
        family: "Mono",
        chips: [
          `Anchor ${anchorHex}`,
          `Hue ${Math.round(baseHue)}°`,
          `Swing ${Math.round(hueSwing)}° / Drift ${Math.round(hueDrift)}°`,
          `${Math.round(curve * 100)}% curve · ${Math.round(contrast * 100)}% contrast`,
        ],
      },
    };
    return preset;
  }

  if (family === "noir") {
    const baseHue = (anchorHue + randomBetween(-10, 10) + 360) % 360;
    const accentHueShift = randomBetween(18, 42);
    const curve = randomBetween(0.86, 1.36);
    const driftPhase = randomBetween(0, Math.PI * 2);
    const bodyPulse = randomBetween(0.2, 1.2);
    const accentPulse = randomBetween(3, 11);
    const depthBias = randomBetween(-0.02, 0.02);
    const preset = {
      id: `noir-random-${Math.floor(randomUnit() * 1e9)}`,
      name: makeVariantName("noir"),
      type: "delta-noir",
      baseHue,
      baseSaturation: randomBetween(0.02, 0.08),
      baseLightness: randomBetween(0.04, 0.08),
      bodyHueShift: randomBetween(0, 3),
      accentHueShift,
      bodySaturationLift: randomBetween(0.01, 0.03),
      accentSaturationLift: randomBetween(0.1, 0.22),
      bodyLightnessRange: randomBetween(0.05, 0.1),
      accentLightnessRange: randomBetween(0.22, 0.34),
      curve,
      driftPhase,
      bodyPulse,
      accentPulse,
      depthBias,
      ui: {
        family: "Noir",
        chips: [
          `Anchor ${anchorHex}`,
          `Base ${Math.round(baseHue)}°`,
          `Accent +${Math.round(accentHueShift)}° / Pulse ${Math.round(accentPulse)}°`,
          `${Math.round(curve * 100)}% curve · ${Math.round((depthBias + 0.05) * 100)}% lift`,
        ],
      },
    };
    return preset;
  }

  const harmonyOptions = ["complementary", "triadic", "split-complementary"];
  const harmony = pickRandom(harmonyOptions) || "complementary";
  const baseHue = (anchorHue + randomBetween(-48, 48) + 360) % 360;
  const contrast = randomBetween(1.05, 1.7);
  const phase = randomBetween(0, Math.PI * 2);
  const hueDrift = randomBetween(10, 56);
  const lumaSpread = randomBetween(1.02, 1.5);
  const bgHueShift = randomBetween(-38, 38);
  const bgContrast = randomBetween(0.95, 1.45);
  return {
    id: `warhol-random-${Math.floor(randomUnit() * 1e9)}`,
    name: makeVariantName("warhol"),
    type: "warhol",
    baseHue,
    bgSaturation: randomBetween(0.78, 0.98),
    bgLightness: randomBetween(0.32, 0.6),
    colorSaturation: randomBetween(0.82, 0.98),
    harmony,
    contrast,
    phase,
    hueDrift,
    lumaSpread,
    bgHueShift,
    bgContrast,
    ui: {
      family: "Pop",
      chips: [
        `Anchor ${anchorHex}`,
        `Hue ${Math.round(baseHue)}°`,
        `${harmony.replace("-", " ")} · ${Math.round(hueDrift)}° drift`,
        `${Math.round(contrast * 100)}% contrast · ${Math.round(lumaSpread * 100)}% spread`,
      ],
    },
  };
}

// ── Presets ────────────────────────────────────────────────────────

export const WARHOL_PRESETS = [
  {
    id: "marilyn-hot",
    name: "Marilyn Hot",
    type: "warhol",
    baseHue: 340,
    bgSaturation: 0.85,
    bgLightness: 0.55,
    colorSaturation: 0.8,
    harmony: "complementary",
  },
  {
    id: "marilyn-cyan",
    name: "Marilyn Cyan",
    type: "warhol",
    baseHue: 185,
    bgSaturation: 0.75,
    bgLightness: 0.45,
    colorSaturation: 0.75,
    harmony: "triadic",
  },
  {
    id: "marilyn-orange",
    name: "Marilyn Orange",
    type: "warhol",
    baseHue: 25,
    bgSaturation: 0.9,
    bgLightness: 0.52,
    colorSaturation: 0.82,
    harmony: "split-complementary",
  },
  {
    id: "electric-blue",
    name: "Electric Blue",
    type: "warhol",
    baseHue: 220,
    bgSaturation: 0.8,
    bgLightness: 0.48,
    colorSaturation: 0.78,
    harmony: "analogous",
  },
  {
    id: "acid-green",
    name: "Acid Green",
    type: "warhol",
    baseHue: 90,
    bgSaturation: 0.85,
    bgLightness: 0.42,
    colorSaturation: 0.8,
    harmony: "complementary",
  },
  {
    id: "purple-rain",
    name: "Purple Rain",
    type: "warhol",
    baseHue: 280,
    bgSaturation: 0.7,
    bgLightness: 0.38,
    colorSaturation: 0.72,
    harmony: "triadic",
  },
];

export const MONO_PRESETS = [
  {
    id: "mono-bone",
    name: "Bone Mono",
    type: "mono",
    baseHue: 34,
    bgSaturation: 0.08,
    bgLightness: 0.18,
    bodySaturationMin: 0.08,
    bodySaturationMax: 0.18,
    accentSaturationMax: 0.34,
    bodyLightnessBase: 0.26,
    bodyLightnessRange: 0.34,
    hueSwing: 4,
  },
  {
    id: "mono-cobalt",
    name: "Cobalt Mono",
    type: "mono",
    baseHue: 224,
    bgSaturation: 0.14,
    bgLightness: 0.15,
    bodySaturationMin: 0.12,
    bodySaturationMax: 0.24,
    accentSaturationMax: 0.42,
    bodyLightnessBase: 0.24,
    bodyLightnessRange: 0.36,
    hueSwing: 6,
  },
  {
    id: "mono-sage",
    name: "Sage Mono",
    type: "mono",
    baseHue: 132,
    bgSaturation: 0.1,
    bgLightness: 0.16,
    bodySaturationMin: 0.1,
    bodySaturationMax: 0.22,
    accentSaturationMax: 0.38,
    bodyLightnessBase: 0.25,
    bodyLightnessRange: 0.33,
    hueSwing: 5,
  },
  {
    id: "mono-oxide",
    name: "Oxide Mono",
    type: "mono",
    baseHue: 12,
    bgSaturation: 0.14,
    bgLightness: 0.15,
    bodySaturationMin: 0.12,
    bodySaturationMax: 0.24,
    accentSaturationMax: 0.4,
    bodyLightnessBase: 0.23,
    bodyLightnessRange: 0.34,
    hueSwing: 4,
  },
  {
    id: "mono-violet",
    name: "Violet Mono",
    type: "mono",
    baseHue: 274,
    bgSaturation: 0.13,
    bgLightness: 0.14,
    bodySaturationMin: 0.12,
    bodySaturationMax: 0.26,
    accentSaturationMax: 0.42,
    bodyLightnessBase: 0.24,
    bodyLightnessRange: 0.35,
    hueSwing: 7,
  },
];

export const NOIR_PRESETS = [
  {
    id: "noir-lacquer",
    name: "Lacquer Noir",
    type: "delta-noir",
    baseHue: 218,
    baseSaturation: 0.08,
    baseLightness: 0.08,
    bodyHueShift: 4,
    accentHueShift: 18,
    bodySaturationLift: 0.03,
    accentSaturationLift: 0.1,
    bodyLightnessRange: 0.12,
    accentLightnessRange: 0.22,
  },
  {
    id: "noir-oxblood",
    name: "Oxblood Noir",
    type: "delta-noir",
    baseHue: 356,
    baseSaturation: 0.08,
    baseLightness: 0.08,
    bodyHueShift: 5,
    accentHueShift: 14,
    bodySaturationLift: 0.04,
    accentSaturationLift: 0.14,
    bodyLightnessRange: 0.12,
    accentLightnessRange: 0.24,
  },
  {
    id: "noir-moss",
    name: "Moss Noir",
    type: "delta-noir",
    baseHue: 108,
    baseSaturation: 0.08,
    baseLightness: 0.08,
    bodyHueShift: 4,
    accentHueShift: 20,
    bodySaturationLift: 0.03,
    accentSaturationLift: 0.12,
    bodyLightnessRange: 0.12,
    accentLightnessRange: 0.22,
  },
  {
    id: "noir-ultra",
    name: "Ultra Noir",
    type: "delta-noir",
    baseHue: 264,
    baseSaturation: 0.08,
    baseLightness: 0.08,
    bodyHueShift: 6,
    accentHueShift: 24,
    bodySaturationLift: 0.04,
    accentSaturationLift: 0.15,
    bodyLightnessRange: 0.14,
    accentLightnessRange: 0.24,
  },
  {
    id: "noir-smoke",
    name: "Smoke Noir",
    type: "delta-noir",
    baseHue: 36,
    baseSaturation: 0.06,
    baseLightness: 0.09,
    bodyHueShift: 4,
    accentHueShift: 12,
    bodySaturationLift: 0.02,
    accentSaturationLift: 0.08,
    bodyLightnessRange: 0.1,
    accentLightnessRange: 0.2,
  },
];

export const REINHARDT_PRESETS = [
  {
    id: "blue-study",
    name: "Blue Study",
    type: "reinhardt",
    baseHue: 225,
    baseSaturation: 0.18,
    baseLightness: 0.08,
    lightnessRange: 0.06,
    lightnessSteps: 10,
  },
  {
    id: "red-study",
    name: "Red Study",
    type: "reinhardt",
    baseHue: 0,
    baseSaturation: 0.15,
    baseLightness: 0.07,
    lightnessRange: 0.05,
    lightnessSteps: 8,
  },
  {
    id: "green-study",
    name: "Green Study",
    type: "reinhardt",
    baseHue: 140,
    baseSaturation: 0.14,
    baseLightness: 0.07,
    lightnessRange: 0.06,
    lightnessSteps: 10,
  },
  {
    id: "violet-study",
    name: "Violet Study",
    type: "reinhardt",
    baseHue: 270,
    baseSaturation: 0.16,
    baseLightness: 0.06,
    lightnessRange: 0.05,
    lightnessSteps: 8,
  },
  {
    id: "black-study",
    name: "Black Study",
    type: "reinhardt",
    baseHue: 0,
    baseSaturation: 0.0,
    baseLightness: 0.04,
    lightnessRange: 0.04,
    lightnessSteps: 12,
  },
];

export const ALL_PRESETS = [...WARHOL_PRESETS, ...MONO_PRESETS, ...NOIR_PRESETS, ...REINHARDT_PRESETS];

export function getPresetById(id) {
  return ALL_PRESETS.find((p) => p.id === id) || null;
}

// ── Grid-Aware Preset Application ───────────────────────────────────

export function createGridPresetFn(preset, sourcePalette, options = {}) {
  if (preset.type === "mono") {
    return (col, row, blockIdx, totalBlocks) => {
      const phase = totalBlocks > 1 ? blockIdx / (totalBlocks - 1) : 0.5;
      const shifted = {
        ...preset,
        baseHue: (preset.baseHue + (phase * 24)) % 360,
        bgLightness: clamp01((preset.bgLightness || 0.15) + ((phase - 0.5) * 0.06)),
        bodyLightnessBase: clamp01((preset.bodyLightnessBase || 0.24) + ((phase - 0.5) * 0.05)),
      };
      return applyPreset(shifted, sourcePalette, options);
    };
  }

  if (preset.type === "delta-noir" || preset.type === "reinhardt") {
    return (col, row, blockIdx, totalBlocks) => {
      const phase = totalBlocks > 1 ? blockIdx / (totalBlocks - 1) : 0.5;
      const shifted = {
        ...preset,
        baseHue: (preset.baseHue + ((phase - 0.5) * 18)) % 360,
        baseLightness: clamp01((preset.baseLightness || 0.08) + ((phase - 0.5) * 0.03)),
      };
      return applyPreset(shifted, sourcePalette, options);
    };
  }

  return (col, row, blockIdx, totalBlocks) => {
    const hueRotation = (blockIdx / Math.max(1, totalBlocks)) * 360;
    const shifted = {
      ...preset,
      baseHue: (preset.baseHue + hueRotation) % 360,
      bgLightness: clamp01((preset.bgLightness || 0.45) + (Math.sin(blockIdx * 1.7) * 0.08)),
      colorSaturation: clamp01((preset.colorSaturation || 0.75) + (Math.cos(blockIdx * 2.3) * 0.1)),
    };
    return applyPreset(shifted, sourcePalette, options);
  };
}
