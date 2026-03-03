export const TONE_STEP = 4;

export function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function hexFromRgb(rgb) {
  if (!rgb) return "#000000";
  const toHex = (v) => clampByte(v).toString(16).padStart(2, "0");
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase();
}

export function collectVisiblePalette(imageData, darkCutoff = 20) {
  const counts = new Map();
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a <= 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = `${r},${g},${b}`;
    const existing = counts.get(key);
    const weight = Math.max(1, a);
    if (existing) {
      existing.weight += weight;
      existing.count += 1;
      continue;
    }
    const luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    counts.set(key, {
      r,
      g,
      b,
      weight,
      count: 1,
      luma,
      max,
      chroma: max - min,
      isDark: luma <= darkCutoff || max <= darkCutoff,
    });
  }

  const palette = [...counts.values()].sort((a, b) => b.weight - a.weight);
  const nonDark = palette.filter((item) => !item.isDark);
  return { palette, nonDark };
}

function weightedRandom(items) {
  if (!items.length) return null;
  const total = items.reduce((sum, item) => sum + Math.max(1, Number(item._pickWeight ?? item.weight) || 1), 0);
  let pick = Math.random() * total;
  for (const item of items) {
    pick -= Math.max(1, Number(item._pickWeight ?? item.weight) || 1);
    if (pick <= 0) return item;
  }
  return items[items.length - 1];
}

function withPickWeights(items) {
  return items.map((item) => {
    const chromaBoost = 1 + Math.min(2.4, (Number(item.chroma) || 0) / 18);
    const lumaPenalty = (Number(item.luma) || 0) > 230 ? 0.65 : 1;
    return {
      ...item,
      _pickWeight: Math.max(1, (Number(item.weight) || 1) * chromaBoost * lumaPenalty),
    };
  });
}

export function getNoMetaBackgroundCandidates(paletteBundle, limit = 14) {
  const pool = ((paletteBundle && paletteBundle.nonDark) || [])
    .filter((c) => c.r <= 251 && c.g <= 251 && c.b <= 251);

  const candidates = (pool.length ? pool : ((paletteBundle && paletteBundle.nonDark) || (paletteBundle && paletteBundle.palette) || []))
    .slice()
    .sort((a, b) => {
      if ((b.chroma || 0) !== (a.chroma || 0)) return (b.chroma || 0) - (a.chroma || 0);
      if ((b.weight || 0) !== (a.weight || 0)) return (b.weight || 0) - (a.weight || 0);
      return (b.luma || 0) - (a.luma || 0);
    })
    .slice(0, Math.max(1, limit));

  return candidates.map((c) => ({ r: c.r, g: c.g, b: c.b, chroma: c.chroma, weight: c.weight, luma: c.luma }));
}

export function pickNoMetaBackground(paletteBundle) {
  const pool = (paletteBundle && paletteBundle.nonDark) || [];
  const exactSafe = pool.filter((c) =>
    c.r <= (255 - TONE_STEP) &&
    c.g <= (255 - TONE_STEP) &&
    c.b <= (255 - TONE_STEP)
  );
  const vibrantExact = exactSafe.filter((c) => (c.chroma || 0) >= 14);
  const vibrant = pool.filter((c) => (c.chroma || 0) >= 14);
  const picked =
    weightedRandom(withPickWeights(vibrantExact)) ||
    weightedRandom(withPickWeights(exactSafe)) ||
    weightedRandom(withPickWeights(vibrant)) ||
    weightedRandom(withPickWeights(pool)) ||
    weightedRandom(withPickWeights((paletteBundle && paletteBundle.palette) || []));
  if (!picked) return { r: 8, g: 8, b: 8 };
  return { r: picked.r, g: picked.g, b: picked.b };
}

export function tone2FromBackground(background) {
  return {
    r: clampByte(background.r + TONE_STEP),
    g: clampByte(background.g + TONE_STEP),
    b: clampByte(background.b + TONE_STEP),
  };
}
