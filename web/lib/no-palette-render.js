import { hexToRgb } from "./color.js";

function normalizeRgba24Bytes(bytes) {
  const source = bytes instanceof Uint8ClampedArray ? bytes : new Uint8ClampedArray(bytes || []);
  if (source.length !== 24 * 24 * 4) {
    throw new Error("Invalid 24x24 RGBA payload");
  }
  return source;
}

export function decodeRgba24B64(rgba24B64) {
  const raw = atob(String(rgba24B64 || ""));
  const out = new Uint8ClampedArray(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return normalizeRgba24Bytes(out);
}

export function encodeRgba24B64(bytes) {
  const normalized = normalizeRgba24Bytes(bytes);
  let raw = "";
  for (let i = 0; i < normalized.length; i += 1) {
    raw += String.fromCharCode(normalized[i]);
  }
  return btoa(raw);
}

export function imageDataFromRgba24(bytes) {
  const normalized = normalizeRgba24Bytes(bytes);
  return new ImageData(normalized, 24, 24);
}

export function createSourceImageDataFromImage(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 24;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 24, 24);
  ctx.drawImage(image, 0, 0, 24, 24);
  return ctx.getImageData(0, 0, 24, 24);
}

export function extractVisiblePaletteHexFromImageData(imageData) {
  const seen = new Set();
  const out = [];
  const data = imageData?.data || [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const hex = `#${data[i].toString(16).padStart(2, "0")}${data[i + 1].toString(16).padStart(2, "0")}${data[i + 2].toString(16).padStart(2, "0")}`.toUpperCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

export function drawSourcePreview(canvas, image) {
  if (!canvas || !image) return;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
}

export function applyNoPaletteMappingToImageData(sourceImageData, { mapping, roles }) {
  const width = sourceImageData.width;
  const height = sourceImageData.height;
  const src = sourceImageData.data;
  const out = new Uint8ClampedArray(src.length);
  const map = new Map(Object.entries(mapping || {}).map(([k, v]) => [String(k).toUpperCase(), hexToRgb(v)]));
  const bg = hexToRgb(roles.background || roles.backgroundHex);
  const ol = hexToRgb(roles.outline || roles.outlineHex);

  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) {
      out[i] = bg.r;
      out[i + 1] = bg.g;
      out[i + 2] = bg.b;
      out[i + 3] = 255;
      continue;
    }
    const key = `#${src[i].toString(16).padStart(2, "0")}${src[i + 1].toString(16).padStart(2, "0")}${src[i + 2].toString(16).padStart(2, "0")}`.toUpperCase();
    let rgb = map.get(key);
    if (!rgb) {
      if (key === "#040404") rgb = ol;
      else if (key === "#000000") rgb = bg;
      else rgb = { r: src[i], g: src[i + 1], b: src[i + 2] };
    }
    out[i] = rgb.r;
    out[i + 1] = rgb.g;
    out[i + 2] = rgb.b;
    out[i + 3] = 255;
  }

  return new ImageData(out, width, height);
}

export function drawPixelImageData(canvas, imageData) {
  if (!canvas || !imageData) return;
  const temp = document.createElement("canvas");
  temp.width = imageData.width;
  temp.height = imageData.height;
  temp.getContext("2d").putImageData(imageData, 0, 0);

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(temp, 0, 0, canvas.width, canvas.height);
}

export function drawRgba24ToCanvas(canvas, rgba24Bytes) {
  drawPixelImageData(canvas, imageDataFromRgba24(rgba24Bytes));
}

export function drawRgba24B64ToCanvas(canvas, rgba24B64) {
  drawRgba24ToCanvas(canvas, decodeRgba24B64(rgba24B64));
}

export function renderContactSheetFramesToCanvas(canvas, frames, { columns = 3, rows = 2 } = {}) {
  if (!canvas) return;
  const frameList = Array.isArray(frames) ? frames : [];
  const width = 24 * columns;
  const height = 24 * rows;
  const temp = document.createElement("canvas");
  temp.width = width;
  temp.height = height;
  const tempCtx = temp.getContext("2d");
  tempCtx.imageSmoothingEnabled = false;
  tempCtx.clearRect(0, 0, width, height);

  for (let i = 0; i < frameList.length && i < columns * rows; i += 1) {
    const item = frameList[i];
    const bytes = typeof item === "string" ? decodeRgba24B64(item) : decodeRgba24B64(item?.rgba24B64);
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = 24;
    frameCanvas.height = 24;
    frameCanvas.getContext("2d").putImageData(imageDataFromRgba24(bytes), 0, 0);
    const x = (i % columns) * 24;
    const y = Math.floor(i / columns) * 24;
    tempCtx.drawImage(frameCanvas, x, y, 24, 24);
  }

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(temp, 0, 0, canvas.width, canvas.height);
}

export function renderNoPalettePreviews({ sourceImage, mapping, roles, truthCanvas, outputCanvas, sourceCanvas }) {
  if (!sourceImage) return null;
  if (sourceCanvas) drawSourcePreview(sourceCanvas, sourceImage);
  const sourceImageData = createSourceImageDataFromImage(sourceImage);
  const remapped = applyNoPaletteMappingToImageData(sourceImageData, { mapping, roles });
  if (truthCanvas) drawPixelImageData(truthCanvas, remapped);
  if (outputCanvas) drawPixelImageData(outputCanvas, remapped);
  return { sourceImageData, remapped };
}

// ── Studio Helpers ──────────────────────────────────────────────────

/**
 * Get set of occupied pixel coordinates from ImageData.
 * Occupied = alpha > 0 (non-transparent).
 * @param {ImageData} imageData
 * @returns {Set<string>} Set of "x,y" strings
 */
export function getOccupiedPixels(imageData) {
  const set = new Set();
  const data = imageData.data;
  const w = imageData.width;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) {
      const px = (i / 4) % w;
      const py = Math.floor(i / 4 / w);
      set.add(`${px},${py}`);
    }
  }
  return set;
}

/**
 * Classify each occupied pixel's role based on color.
 * - #000000 → "background"
 * - #040404 → "outline"
 * - Others with luminance < 20 → "outline" (dark structural)
 * - Others → sorted by frequency: top 60% = "body", rest = "accent"
 * @param {ImageData} imageData
 * @returns {Map<string, string>} Map of "x,y" → role
 */
export function classifyPixelRoles(imageData) {
  const data = imageData.data;
  const w = imageData.width;
  const roles = new Map();
  const colorCounts = new Map();

  // First pass: count colors
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
    colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
  }

  // Determine body vs accent threshold
  const sorted = [...colorCounts.entries()]
    .filter(([hex]) => hex !== "#000000" && hex !== "#040404")
    .filter(([hex]) => {
      const rgb = hexToRgb(hex);
      return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) >= 20;
    })
    .sort((a, b) => b[1] - a[1]);

  const totalNonDark = sorted.reduce((s, [, c]) => s + c, 0);
  let cumulative = 0;
  const bodyColors = new Set();
  for (const [hex, count] of sorted) {
    cumulative += count;
    bodyColors.add(hex);
    if (cumulative >= totalNonDark * 0.6) break;
  }

  // Second pass: assign roles
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const px = (i / 4) % w;
    const py = Math.floor(i / 4 / w);
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    let role;
    if (hex === "#000000") role = "background";
    else if (hex === "#040404") role = "outline";
    else if (luma < 20) role = "outline";
    else if (bodyColors.has(hex)) role = "body";
    else role = "accent";

    roles.set(`${px},${py}`, role);
  }

  return roles;
}

/**
 * Build a color mapping from old palette to new palette, preserving luminance rank.
 * @param {string[]} oldPalette - Array of hex colors (source)
 * @param {string[]} newPalette - Array of hex colors (target)
 * @param {Map<string, string>} roles - Pixel role map (from classifyPixelRoles)
 * @returns {Object<string, string>} Mapping of old hex → new hex
 */
export function buildColorMapping(oldPalette, newPalette, roles) {
  // Get unique role assignments per color
  const colorRoles = new Map();
  for (const [, role] of roles) {
    // not needed per-pixel, just build from palette
  }

  // Sort both by luminance
  const lumaSort = (hexList) =>
    hexList
      .map((hex) => {
        const rgb = hexToRgb(hex);
        return { hex, luma: 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b };
      })
      .sort((a, b) => a.luma - b.luma);

  const oldSorted = lumaSort(oldPalette);
  const newSorted = lumaSort(newPalette);

  const mapping = {};
  for (let i = 0; i < oldSorted.length; i++) {
    const targetIdx = Math.min(newSorted.length - 1, Math.round((i / Math.max(1, oldSorted.length - 1)) * (newSorted.length - 1)));
    mapping[oldSorted[i].hex] = newSorted[targetIdx].hex;
  }

  return mapping;
}
