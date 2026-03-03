import { DEFAULT_TONE_STEP, hexToRgb, rgbToHex } from "./art-presets.js";

function clampStep(value) {
  const step = Math.round(Number(value) || DEFAULT_TONE_STEP);
  return Math.max(1, Math.min(36, step));
}

function clampDeltaMode(mode) {
  if (mode === "soft" || mode === "hard") return mode;
  return "exact";
}

function normalizeBackgroundForStep(backgroundHex, step) {
  const bg = hexToRgb(backgroundHex);
  const cap = 255 - step;
  return {
    r: Math.min(cap, bg.r),
    g: Math.min(cap, bg.g),
    b: Math.min(cap, bg.b),
  };
}

export function resolveRoleStep(step, deltaMode = "exact") {
  const base = clampStep(step);
  const mode = clampDeltaMode(deltaMode);
  if (mode === "soft") return Math.max(2, Math.min(3, base));
  if (mode === "hard") return Math.max(base, 8);
  return base;
}

export function deriveRolePair(backgroundHex, toneStep, deltaMode = "exact") {
  const roleStep = resolveRoleStep(toneStep, deltaMode);
  const clamped = normalizeBackgroundForStep(backgroundHex, roleStep);
  return {
    background: rgbToHex(clamped.r, clamped.g, clamped.b),
    figure: rgbToHex(clamped.r + roleStep, clamped.g + roleStep, clamped.b + roleStep),
    roleStep,
    deltaMode: clampDeltaMode(deltaMode),
  };
}

export function deriveNoMinimalismPair(backgroundHex, deltaMode = "exact") {
  return deriveRolePair(backgroundHex || "#000000", 4, deltaMode);
}
