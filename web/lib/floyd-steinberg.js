// floyd-steinberg.js — client-side dither engines for 24x24 punk buffers

function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return (2 * dr * dr) + (4 * dg * dg) + (3 * db * db);
}

function nearestColor(r, g, b, palette) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const d = colorDistance(r, g, b, palette[i].r, palette[i].g, palette[i].b);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return palette[best];
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function wrapCoord(value, size) {
  if (!size) return 0;
  return ((value % size) + size) % size;
}

function buildOccupiedSet(data, width, height) {
  const set = new Set();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 0) set.add(`${x},${y}`);
    }
  }
  return set;
}

function cloneImageData(imageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

function paletteByLuminance(palette) {
  return [...palette].sort((a, b) => {
    const al = (0.2126 * a.r) + (0.7152 * a.g) + (0.0722 * a.b);
    const bl = (0.2126 * b.r) + (0.7152 * b.g) + (0.0722 * b.b);
    return al - bl;
  });
}

function ditherSharedSetup(imageData, targetPalette, options = {}) {
  if (!targetPalette || targetPalette.length < 2) {
    throw new Error("Dither requires at least 2 target colors");
  }
  const width = imageData.width;
  const height = imageData.height;
  const src = imageData.data;
  const occupied = options.occupiedPixels || buildOccupiedSet(src, width, height);
  const strength = Math.max(0, Math.min(1, options.strength ?? 1));
  const phase = Math.max(0, Math.floor(options.phase || 0));
  return { width, height, src, occupied, strength, phase, sortedPalette: paletteByLuminance(targetPalette) };
}

export function floydSteinbergDither(imageData, targetPalette, options = {}) {
  const { width, height, src, occupied, strength } = ditherSharedSetup(imageData, targetPalette, options);

  const rBuf = new Float32Array(width * height);
  const gBuf = new Float32Array(width * height);
  const bBuf = new Float32Array(width * height);
  const aBuf = new Uint8ClampedArray(width * height);

  for (let i = 0; i < width * height; i += 1) {
    rBuf[i] = src[i * 4];
    gBuf[i] = src[i * 4 + 1];
    bBuf[i] = src[i * 4 + 2];
    aBuf[i] = src[i * 4 + 3];
  }

  const nearestR = new Float32Array(width * height);
  const nearestG = new Float32Array(width * height);
  const nearestB = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!occupied.has(`${x},${y}`)) continue;
      const nc = nearestColor(rBuf[idx], gBuf[idx], bBuf[idx], targetPalette);
      nearestR[idx] = nc.r;
      nearestG[idx] = nc.g;
      nearestB[idx] = nc.b;
    }
  }

  const forwardOffsets = [
    { dx: 1, dy: 0, w: 7 / 16 },
    { dx: -1, dy: 1, w: 3 / 16 },
    { dx: 0, dy: 1, w: 5 / 16 },
    { dx: 1, dy: 1, w: 1 / 16 },
  ];
  const backwardOffsets = [
    { dx: -1, dy: 0, w: 7 / 16 },
    { dx: 1, dy: 1, w: 3 / 16 },
    { dx: 0, dy: 1, w: 5 / 16 },
    { dx: -1, dy: 1, w: 1 / 16 },
  ];
  const tonalPulse = 0.14 + (strength * 0.48);

  for (let y = 0; y < height; y += 1) {
    const forward = (y % 2) === 0;
    const offsets = forward ? forwardOffsets : backwardOffsets;
    const xStart = forward ? 0 : width - 1;
    const xEnd = forward ? width : -1;
    const xStep = forward ? 1 : -1;

    for (let x = xStart; x !== xEnd; x += xStep) {
      const idx = y * width + x;
      if (!occupied.has(`${x},${y}`)) continue;

      const oldR = rBuf[idx];
      const oldG = gBuf[idx];
      const oldB = bBuf[idx];
      const wave = ((((wrapCoord((x * 3) + (y * 5) + Math.round(strength * 11), 7) / 6) - 0.5) * 2));
      const nc = nearestColor(
        clampByte(oldR + (wave * tonalPulse * 24)),
        clampByte(oldG + (wave * tonalPulse * 18)),
        clampByte(oldB + (wave * tonalPulse * 14)),
        targetPalette,
      );
      rBuf[idx] = nc.r;
      gBuf[idx] = nc.g;
      bBuf[idx] = nc.b;

      const errR = (oldR - nc.r) * strength;
      const errG = (oldG - nc.g) * strength;
      const errB = (oldB - nc.b) * strength;

      for (const { dx, dy, w } of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (!occupied.has(`${nx},${ny}`)) continue;
        const ni = ny * width + nx;
        rBuf[ni] += errR * w;
        gBuf[ni] += errG * w;
        bBuf[ni] += errB * w;
      }
    }
  }

  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const x = i % width;
    const y = Math.floor(i / width);
    if (!occupied.has(`${x},${y}`)) {
      out[i * 4] = src[i * 4];
      out[i * 4 + 1] = src[i * 4 + 1];
      out[i * 4 + 2] = src[i * 4 + 2];
      out[i * 4 + 3] = src[i * 4 + 3];
      continue;
    }

    if (strength >= 1) {
      out[i * 4] = clampByte(rBuf[i]);
      out[i * 4 + 1] = clampByte(gBuf[i]);
      out[i * 4 + 2] = clampByte(bBuf[i]);
    } else {
      out[i * 4] = clampByte((nearestR[i] * (1 - strength)) + (rBuf[i] * strength));
      out[i * 4 + 1] = clampByte((nearestG[i] * (1 - strength)) + (gBuf[i] * strength));
      out[i * 4 + 2] = clampByte((nearestB[i] * (1 - strength)) + (bBuf[i] * strength));
    }
    out[i * 4 + 3] = aBuf[i];
  }

  return new ImageData(out, width, height);
}

const BAYER_8 = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21],
];

function luminanceIndexForPixel(r, g, b, sortedPalette, thresholdBias) {
  if (sortedPalette.length <= 1) return 0;
  const luma = ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) / 255;
  const scaled = (luma * (sortedPalette.length - 1)) + thresholdBias;
  return Math.max(0, Math.min(sortedPalette.length - 1, Math.round(scaled)));
}

function orderedMatrixDither(imageData, targetPalette, matrix, options = {}) {
  const { width, height, src, occupied, strength, phase, sortedPalette } = ditherSharedSetup(imageData, targetPalette, options);
  const out = new Uint8ClampedArray(src);
  const size = matrix.length;
  const maxVal = (size * size) - 1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!occupied.has(`${x},${y}`)) continue;
      const i = (y * width + x) * 4;
      const mx = wrapCoord((x * 2) + phase, size);
      const my = wrapCoord(y + phase, size);
      const threshold = ((matrix[my][mx] + 0.5) / (maxVal + 1)) - 0.5;
      const crossPulse = ((((wrapCoord(x + (y * 2) + phase, size) / Math.max(1, size - 1)) - 0.5) * 0.42) * strength);
      const idx = luminanceIndexForPixel(
        src[i],
        src[i + 1],
        src[i + 2],
        sortedPalette,
        (threshold * strength * 2.28) + crossPulse,
      );
      const picked = sortedPalette[idx];
      out[i] = picked.r;
      out[i + 1] = picked.g;
      out[i + 2] = picked.b;
      out[i + 3] = src[i + 3];
    }
  }

  return new ImageData(out, width, height);
}

function clusteredDotDither(imageData, targetPalette, options = {}) {
  const { width, height, src, occupied, strength, phase, sortedPalette } = ditherSharedSetup(imageData, targetPalette, options);
  const out = new Uint8ClampedArray(src);
  const cellSize = Math.max(5, Math.min(9, 5 + Math.round(strength * 4)));
  const stripeWidth = Math.max(2, Math.round(cellSize / 2.2));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!occupied.has(`${x},${y}`)) continue;
      const i = (y * width + x) * 4;
      const localX = (wrapCoord(x + phase, cellSize) / Math.max(1, cellSize - 1)) - 0.5;
      const localY = (wrapCoord(y + Math.floor(phase / 2), cellSize) / Math.max(1, cellSize - 1)) - 0.5;
      const pocket = 0.5 - Math.max(Math.abs(localX), Math.abs(localY));
      const steppedPocket = Math.sign(pocket) * Math.pow(Math.abs(pocket), 0.72);
      const stripe = (((wrapCoord(x + (y * 3) + phase, stripeWidth) / Math.max(1, stripeWidth - 1)) - 0.5) * 0.28);
      const idx = luminanceIndexForPixel(
        src[i],
        src[i + 1],
        src[i + 2],
        sortedPalette,
        ((steppedPocket * 2.65) + stripe) * strength,
      );
      const picked = sortedPalette[idx];
      out[i] = picked.r;
      out[i + 1] = picked.g;
      out[i + 2] = picked.b;
      out[i + 3] = src[i + 3];
    }
  }

  return new ImageData(out, width, height);
}

function scanBandDither(imageData, targetPalette, options = {}) {
  const { width, height, src, occupied, strength, phase, sortedPalette } = ditherSharedSetup(imageData, targetPalette, options);
  const out = new Uint8ClampedArray(src);
  const horizontal = (wrapCoord(phase, 4) < 2);
  const bandSize = Math.max(2, Math.min(8, Math.round(2 + (strength * 6))));
  const syncEvery = Math.max(3, Math.round(6 - (strength * 2)));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!occupied.has(`${x},${y}`)) continue;
      const i = (y * width + x) * 4;
      const majorAxis = horizontal ? y : x;
      const minorAxis = horizontal ? x : y;
      const stripeIndex = Math.floor((majorAxis + phase) / bandSize);
      const stripeBias = ((stripeIndex % 4) - 1.5) * 0.31;
      const syncDip = (stripeIndex % syncEvery === 0) ? -0.24 : 0;
      const sweep = (((wrapCoord((minorAxis * 2) + phase, bandSize * 2) / Math.max(1, (bandSize * 2) - 1)) - 0.5) * 0.5);
      const idx = luminanceIndexForPixel(
        src[i],
        src[i + 1],
        src[i + 2],
        sortedPalette,
        (stripeBias + syncDip + sweep) * strength * 1.34,
      );
      const picked = sortedPalette[idx];
      out[i] = picked.r;
      out[i + 1] = picked.g;
      out[i + 2] = picked.b;
      out[i + 3] = src[i + 3];
    }
  }

  return new ImageData(out, width, height);
}

export function applyStudioDither(imageData, targetPalette, options = {}) {
  const engine = String(options.engine || "diffusion");
  if (engine === "bayer") {
    return orderedMatrixDither(imageData, targetPalette, BAYER_8, options);
  }
  if (engine === "cluster") {
    return clusteredDotDither(imageData, targetPalette, options);
  }
  if (engine === "scan") {
    return scanBandDither(imageData, targetPalette, options);
  }
  return floydSteinbergDither(imageData, targetPalette, options);
}

export function previewDitherEngineLabel(engine) {
  const key = String(engine || "diffusion");
  if (key === "bayer") return "Bayer";
  if (key === "cluster") return "Cluster";
  if (key === "scan") return "Scan";
  return "Diffuse";
}

export function copyImageData(imageData) {
  return cloneImageData(imageData);
}
