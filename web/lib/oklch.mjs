import { clampByte, hexToRgb, rgbToHex } from "./color.js";

export function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function normalizeHue(value) {
  const hue = Number(value) || 0;
  return ((hue % 360) + 360) % 360;
}

function srgbToLinear(value) {
  const channel = Math.max(0, Math.min(255, Number(value) || 0)) / 255;
  if (channel <= 0.04045) return channel / 12.92;
  return Math.pow((channel + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value) {
  const channel = Math.max(0, Math.min(1, Number(value) || 0));
  if (channel <= 0.0031308) return clampByte(channel * 12.92 * 255);
  return clampByte(((1.055 * Math.pow(channel, 1 / 2.4)) - 0.055) * 255);
}

export function rgbToOklab(r, g, b) {
  const red = srgbToLinear(r);
  const green = srgbToLinear(g);
  const blue = srgbToLinear(b);
  const l = (0.4122214708 * red) + (0.5363325363 * green) + (0.0514459929 * blue);
  const m = (0.2119034982 * red) + (0.6806995451 * green) + (0.1073969566 * blue);
  const s = (0.0883024619 * red) + (0.2817188376 * green) + (0.6299787005 * blue);
  const lRoot = Math.cbrt(Math.max(0, l));
  const mRoot = Math.cbrt(Math.max(0, m));
  const sRoot = Math.cbrt(Math.max(0, s));
  return {
    L: (0.2104542553 * lRoot) + (0.7936177850 * mRoot) - (0.0040720468 * sRoot),
    a: (1.9779984951 * lRoot) - (2.4285922050 * mRoot) + (0.4505937099 * sRoot),
    b: (0.0259040371 * lRoot) + (0.7827717662 * mRoot) - (0.8086757660 * sRoot),
  };
}

export function oklabToRgb(L, a, b) {
  const l = Math.pow(L + (0.3963377774 * a) + (0.2158037573 * b), 3);
  const m = Math.pow(L - (0.1055613458 * a) - (0.0638541728 * b), 3);
  const s = Math.pow(L - (0.0894841775 * a) - (1.2914855480 * b), 3);
  return {
    r: linearToSrgb((4.0767416621 * l) - (3.3077115913 * m) + (0.2309699292 * s)),
    g: linearToSrgb((-1.2684380046 * l) + (2.6097574011 * m) - (0.3413193965 * s)),
    b: linearToSrgb((-0.0041960863 * l) - (0.7034186147 * m) + (1.7076147010 * s)),
  };
}

export function oklabToOklch(lab) {
  const chroma = Math.sqrt((lab.a * lab.a) + (lab.b * lab.b));
  return {
    L: clampUnit(lab.L),
    C: Math.max(0, chroma),
    H: normalizeHue((Math.atan2(lab.b, lab.a) * 180) / Math.PI),
  };
}

export function oklchToOklab(lch) {
  const hue = normalizeHue(lch.H);
  const radians = (hue * Math.PI) / 180;
  return {
    L: clampUnit(lch.L),
    a: (Number(lch.C) || 0) * Math.cos(radians),
    b: (Number(lch.C) || 0) * Math.sin(radians),
  };
}

export function hexToOklab(hex) {
  const rgb = hexToRgb(String(hex || "#000000").toUpperCase());
  return rgbToOklab(rgb.r, rgb.g, rgb.b);
}

export function hexToOklch(hex) {
  return oklabToOklch(hexToOklab(hex));
}

export function oklchToHex(lch) {
  const lab = oklchToOklab(lch);
  const rgb = oklabToRgb(lab.L, lab.a, lab.b);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

export function oklchToHexGamutSafe(lch, { chromaFloor = 0.002 } = {}) {
  const hue = normalizeHue(lch.H);
  let chroma = Math.max(0, Number(lch.C) || 0);
  const lightness = clampUnit(lch.L);
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const candidate = oklchToHex({ L: lightness, C: chroma, H: hue });
    const roundTrip = hexToOklch(candidate);
    if (Math.abs(roundTrip.L - lightness) < 0.045 && Math.abs(roundTrip.C - chroma) < 0.08) {
      return candidate;
    }
    chroma *= 0.88;
    if (chroma < chromaFloor) {
      return oklchToHex({ L: lightness, C: chromaFloor, H: hue });
    }
  }
  return oklchToHex({ L: lightness, C: chromaFloor, H: hue });
}

export function oklabDistance(a, b) {
  const labA = typeof a === "string" ? hexToOklab(a) : a;
  const labB = typeof b === "string" ? hexToOklab(b) : b;
  const dL = labA.L - labB.L;
  const da = labA.a - labB.a;
  const db = labA.b - labB.b;
  return Math.sqrt((dL * dL) + (da * da) + (db * db));
}

export function oklchDistance(a, b) {
  return oklabDistance(a, b);
}

export function interpolateHue(a, b, t) {
  const from = normalizeHue(a);
  const to = normalizeHue(b);
  let delta = to - from;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return normalizeHue(from + (delta * clampUnit(t)));
}

export function mixOklch(aHex, bHex, t) {
  const from = hexToOklch(aHex);
  const to = hexToOklch(bHex);
  return oklchToHexGamutSafe({
    L: from.L + ((to.L - from.L) * clampUnit(t)),
    C: Math.max(0.002, from.C + ((to.C - from.C) * clampUnit(t))),
    H: interpolateHue(from.H, to.H, t),
  });
}
