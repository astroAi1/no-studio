"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DEFAULT_V2_CONTRACT = "0xa62f65d503068684e7228df98090f94322b8ed54";
const DEFAULT_V1_CONTRACT = "0x4ed83635e2309a7c067d0f98efca47b920bf79b1";
const HASH_ALGO = crypto.getHashes().includes("sha3-256") ? "sha3-256" : "sha256";

const RECOVERY_STATES = [
  "Boot Drift",
  "False Sync",
  "Repair Fever",
  "Rollback Lock",
  "Overflow Prayer",
  "Integrity Loop",
];

const FAULT_CLASSES = [
  "Pointer Drift",
  "Checksum Spill",
  "Stride Tear",
  "Ghost Duplication",
  "Overmint Cascade",
  "Buffer Reentry",
];

const PRIMARY_STRUCTURES = [
  "Scan Scaffold",
  "Fracture Grid",
  "Offset Spine",
  "Rollback Ring",
  "Packet Lattice",
  "Collapse Field",
];

const COMPOSITION_BIASES = [
  "Upper Breach",
  "Lower Shear",
  "Left Lean",
  "Right Lean",
  "Radial Slip",
  "Cross-Axis Pull",
];

const REPAIR_METHODS = [
  "Patch Weave",
  "Ghost Stitch",
  "Channel Weld",
  "Rebuild Sweep",
  "Checksum Braids",
  "Null Fill",
];

const GHOST_DENSITIES = ["Trace", "Veil", "Swarm", "Flood"];
const PACKET_RAILS = ["Sparse", "Forked", "Dense", "Crossfire"];
const LOOP_CADENCES = ["Slow Lock", "Tense Cycle", "Surge Loop", "Riot Loop"];
const INTEGRITY_GATES = ["Stable", "Compromised", "Failing", "Recursive"];

const PALETTE_LIBRARY = [
  {
    id: "ember-fault",
    label: "Ember Fault",
    hue: 32,
    ground: "#050608",
    structure: ["#12161c", "#28303a", "#4e5a68"],
    accent: "#ffb347",
    corruption: "#ff5b36",
    void: "#020304",
  },
  {
    id: "acid-suture",
    label: "Acid Suture",
    hue: 98,
    ground: "#040705",
    structure: ["#101711", "#203129", "#4d705d"],
    accent: "#b8ff5d",
    corruption: "#7cff2d",
    void: "#010302",
  },
  {
    id: "cobalt-repair",
    label: "Cobalt Repair",
    hue: 214,
    ground: "#05070b",
    structure: ["#131923", "#1e2f47", "#4c6d96"],
    accent: "#77c3ff",
    corruption: "#2f7cff",
    void: "#020409",
  },
  {
    id: "violet-overflow",
    label: "Violet Overflow",
    hue: 272,
    ground: "#07050b",
    structure: ["#16111f", "#2c2240", "#665385"],
    accent: "#d2a3ff",
    corruption: "#9d5dff",
    void: "#030108",
  },
  {
    id: "rose-checksum",
    label: "Rose Checksum",
    hue: 344,
    ground: "#090507",
    structure: ["#1b1116", "#35212c", "#7b5468"],
    accent: "#ff95b8",
    corruption: "#ff4a7d",
    void: "#030203",
  },
  {
    id: "teal-rollback",
    label: "Teal Rollback",
    hue: 181,
    ground: "#040809",
    structure: ["#0f1719", "#1c3438", "#4a7a7d"],
    accent: "#7ff0e1",
    corruption: "#34c7cf",
    void: "#020405",
  },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAddress(value) {
  const raw = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(raw) ? raw : null;
}

function stableHash(parts) {
  const hash = crypto.createHash(HASH_ALGO);
  for (const part of parts) {
    hash.update(String(part || ""));
    hash.update("|");
  }
  return `0x${hash.digest("hex")}`;
}

function hashToSeed(hash, wordIndex) {
  const normalized = String(hash || "").replace(/^0x/, "").padEnd(64, "0");
  const start = clamp(Number(wordIndex) || 0, 0, 7) * 8;
  return Number.parseInt(normalized.slice(start, start + 8), 16) >>> 0;
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => Number(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function hexToRgb(hex) {
  const raw = String(hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return { r: 0, g: 0, b: 0 };
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function luminanceOfHex(hex) {
  const { r, g, b } = hexToRgb(hex);
  const srgb = [r, g, b].map((value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * srgb[0]) + (0.7152 * srgb[1]) + (0.0722 * srgb[2]);
}

function hueOfHex(hex) {
  const { r, g, b } = hexToRgb(hex);
  const nr = r / 255;
  const ng = g / 255;
  const nb = b / 255;
  const max = Math.max(nr, ng, nb);
  const min = Math.min(nr, ng, nb);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue = 0;
  if (max === nr) {
    hue = ((ng - nb) / delta) % 6;
  } else if (max === ng) {
    hue = ((nb - nr) / delta) + 2;
  } else {
    hue = ((nr - ng) / delta) + 4;
  }
  const normalized = hue * 60;
  return normalized < 0 ? normalized + 360 : normalized;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgba(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) return null;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let paletteTable = null;
  const idatParts = [];

  for (let offset = 8; offset + 8 <= buffer.length;) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const crcEnd = dataEnd + 4;
    if (dataEnd > buffer.length || crcEnd > buffer.length) return null;
    const chunkData = buffer.subarray(dataStart, dataEnd);

    if (chunkType === "IHDR" && chunkData.length >= 13) {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlace = chunkData[12];
    } else if (chunkType === "PLTE") {
      paletteTable = chunkData;
    } else if (chunkType === "IDAT") {
      idatParts.push(chunkData);
    } else if (chunkType === "IEND") {
      break;
    }

    offset = crcEnd;
  }

  if (!width || !height || !idatParts.length) return null;
  if (interlace !== 0 || bitDepth !== 8) return null;

  const bytesPerPixelByType = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4,
  };
  const bpp = bytesPerPixelByType[colorType];
  if (!bpp) return null;

  let inflated;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idatParts));
  } catch {
    return null;
  }

  const rowLen = width * bpp;
  const expectedMin = (rowLen + 1) * height;
  if (inflated.length < expectedMin) return null;

  const rgba = new Uint8Array(width * height * 4);
  let pos = 0;
  let prev = new Uint8Array(rowLen);

  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[pos];
    pos += 1;
    if (pos + rowLen > inflated.length) return null;
    const rowIn = inflated.subarray(pos, pos + rowLen);
    pos += rowLen;
    const rowOut = new Uint8Array(rowLen);

    for (let i = 0; i < rowLen; i += 1) {
      const raw = rowIn[i];
      const left = i >= bpp ? rowOut[i - bpp] : 0;
      const up = prev[i] || 0;
      const upLeft = i >= bpp ? (prev[i - bpp] || 0) : 0;
      if (filterType === 0) {
        rowOut[i] = raw;
      } else if (filterType === 1) {
        rowOut[i] = (raw + left) & 0xff;
      } else if (filterType === 2) {
        rowOut[i] = (raw + up) & 0xff;
      } else if (filterType === 3) {
        rowOut[i] = (raw + Math.floor((left + up) / 2)) & 0xff;
      } else if (filterType === 4) {
        rowOut[i] = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      } else {
        return null;
      }
    }

    for (let x = 0; x < width; x += 1) {
      const inBase = x * bpp;
      const outBase = ((y * width) + x) * 4;
      if (colorType === 6) {
        rgba[outBase] = rowOut[inBase];
        rgba[outBase + 1] = rowOut[inBase + 1];
        rgba[outBase + 2] = rowOut[inBase + 2];
        rgba[outBase + 3] = rowOut[inBase + 3];
      } else if (colorType === 2) {
        rgba[outBase] = rowOut[inBase];
        rgba[outBase + 1] = rowOut[inBase + 1];
        rgba[outBase + 2] = rowOut[inBase + 2];
        rgba[outBase + 3] = 255;
      } else if (colorType === 4) {
        rgba[outBase] = rowOut[inBase];
        rgba[outBase + 1] = rowOut[inBase];
        rgba[outBase + 2] = rowOut[inBase];
        rgba[outBase + 3] = rowOut[inBase + 1];
      } else if (colorType === 0) {
        rgba[outBase] = rowOut[inBase];
        rgba[outBase + 1] = rowOut[inBase];
        rgba[outBase + 2] = rowOut[inBase];
        rgba[outBase + 3] = 255;
      } else if (colorType === 3) {
        const paletteIndex = rowOut[inBase] * 3;
        if (!paletteTable || paletteIndex + 2 >= paletteTable.length) continue;
        rgba[outBase] = paletteTable[paletteIndex];
        rgba[outBase + 1] = paletteTable[paletteIndex + 1];
        rgba[outBase + 2] = paletteTable[paletteIndex + 2];
        rgba[outBase + 3] = 255;
      }
    }

    prev = rowOut;
  }

  return { width, height, rgba };
}

function buildScaffoldFromPng(buffer) {
  const decoded = decodePngRgba(buffer);
  if (!decoded) {
    throw new Error("Unable to decode transparent NoPunk PNG");
  }

  const { width, height, rgba } = decoded;
  const points = [];
  const colorCounts = new Map();
  const rowCounts = new Array(height).fill(0);
  const colCounts = new Array(width).fill(0);
  const grid = Array.from({ length: height }, () => new Array(width).fill(false));

  let sumX = 0;
  let sumY = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = ((y * width) + x) * 4;
      const r = rgba[base];
      const g = rgba[base + 1];
      const b = rgba[base + 2];
      const a = rgba[base + 3];
      if (a === 0) continue;
      const hex = rgbToHex(r, g, b);
      grid[y][x] = true;
      rowCounts[y] += 1;
      colCounts[x] += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      points.push({
        x,
        y,
        nx: width > 1 ? x / (width - 1) : 0,
        ny: height > 1 ? y / (height - 1) : 0,
        hex,
        luminance: Number(luminanceOfHex(hex).toFixed(4)),
      });
      colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
    }
  }

  const visibleCount = points.length;
  if (!visibleCount) {
    throw new Error("Transparent NoPunk PNG contains no visible pixels");
  }

  const centroid = {
    x: sumX / visibleCount,
    y: sumY / visibleCount,
    nx: width > 1 ? (sumX / visibleCount) / (width - 1) : 0,
    ny: height > 1 ? (sumY / visibleCount) / (height - 1) : 0,
  };

  let edgeCount = 0;
  let componentCount = 0;
  const visited = Array.from({ length: height }, () => new Array(width).fill(false));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!grid[y][x]) continue;
      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !grid[ny][nx]) {
          edgeCount += 1;
        }
      }
      if (visited[y][x]) continue;
      componentCount += 1;
      const queue = [[x, y]];
      visited[y][x] = true;
      while (queue.length) {
        const [qx, qy] = queue.pop();
        const next = [
          [qx + 1, qy],
          [qx - 1, qy],
          [qx, qy + 1],
          [qx, qy - 1],
        ];
        for (const [nx, ny] of next) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!grid[ny][nx] || visited[ny][nx]) continue;
          visited[ny][nx] = true;
          queue.push([nx, ny]);
        }
      }
    }
  }

  const dominantColors = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex, count]) => ({
      hex,
      count,
      share: Number((count / visibleCount).toFixed(4)),
    }));

  const accentColors = dominantColors
    .filter((entry) => luminanceOfHex(entry.hex) > 0.11)
    .slice(0, 6)
    .map((entry) => entry.hex);

  const rowMax = Math.max(...rowCounts, 1);
  const colMax = Math.max(...colCounts, 1);
  const silhouetteHash = stableHash(points.map((point) => `${point.x},${point.y},${point.hex}`));

  return {
    width,
    height,
    visibleCount,
    bbox: {
      minX,
      minY,
      maxX,
      maxY,
      width: (maxX - minX) + 1,
      height: (maxY - minY) + 1,
    },
    centroid,
    componentCount,
    edgeCount,
    edgeDensity: Number((edgeCount / Math.max(1, visibleCount * 4)).toFixed(4)),
    rowWeights: rowCounts.map((count, index) => ({
      index,
      count,
      weight: Number((count / rowMax).toFixed(4)),
    })),
    colWeights: colCounts.map((count, index) => ({
      index,
      count,
      weight: Number((count / colMax).toFixed(4)),
    })),
    points,
    dominantColors,
    accentColors: accentColors.length ? accentColors : dominantColors.slice(0, 4).map((entry) => entry.hex),
    silhouetteHash,
  };
}

function buildTraitSummary(traits) {
  const orderedKeys = ["Type", "Hair", "Eyes", "Beard", "Mouth", "Smoke", "Mask", "Neck", "Face", "Nose", "Ears"];
  const parts = [];
  const seen = new Set();
  for (const key of orderedKeys) {
    if (!traits[key]) continue;
    parts.push(`${key}: ${traits[key]}`);
    seen.add(key);
  }
  for (const [key, value] of Object.entries(traits || {})) {
    if (!value || seen.has(key)) continue;
    parts.push(`${key}: ${value}`);
  }
  return parts.join(" · ");
}

function deriveTraitMetrics(record, traitDbRaw) {
  const traits = record && record.traits ? record.traits : {};
  const total = Number(traitDbRaw?.total) || 10000;
  const counts = traitDbRaw?.trait_counts || {};
  const details = [];

  for (const [traitType, traitValue] of Object.entries(traits)) {
    const count = Number(counts?.[traitType]?.[traitValue]) || total;
    const rarity = clamp(1 - (count / total), 0, 1);
    details.push({
      traitType,
      traitValue,
      count,
      rarity,
    });
  }

  const avgRarity = details.length
    ? details.reduce((sum, entry) => sum + entry.rarity, 0) / details.length
    : 0;
  const peakRarity = details.length
    ? Math.max(...details.map((entry) => entry.rarity))
    : 0;

  return {
    totalTraits: details.length,
    avgRarity: Number(avgRarity.toFixed(4)),
    peakRarity: Number(peakRarity.toFixed(4)),
    details,
  };
}

function angularDistance(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function choosePalette(accentColors, seedOffset) {
  const usable = Array.isArray(accentColors) ? accentColors.filter(Boolean) : [];
  const meanHue = usable.length
    ? usable.map((hex) => hueOfHex(hex)).reduce((sum, value) => sum + value, 0) / usable.length
    : (seedOffset % 360);

  const ranked = PALETTE_LIBRARY
    .map((palette, index) => ({
      palette,
      score: angularDistance(meanHue, palette.hue) + (index * 0.25),
    }))
    .sort((a, b) => a.score - b.score);

  return ranked[0].palette;
}

function makeTraits(tokenId, record, scaffold, metrics, masterHash, palette) {
  const seedA = hashToSeed(masterHash, 0);
  const seedB = hashToSeed(masterHash, 1);
  const seedC = hashToSeed(masterHash, 2);
  const seedD = hashToSeed(masterHash, 3);
  const densityScore = (scaffold.visibleCount / (scaffold.width * scaffold.height));
  const overflowPressure = clamp(
    Math.round(
      (metrics.avgRarity * 45) +
      (metrics.peakRarity * 20) +
      (scaffold.componentCount * 5) +
      (scaffold.edgeDensity * 38) +
      (densityScore * 18) +
      (seedC % 11)
    ),
    0,
    99
  );

  const railCount = clamp(
    2 + Math.round((overflowPressure / 100) * 5) + (seedD % 2),
    2,
    9
  );

  const stateIndex = (Math.floor(metrics.avgRarity * 12) + scaffold.componentCount + (seedA % RECOVERY_STATES.length)) % RECOVERY_STATES.length;
  const faultIndex = (Math.round(scaffold.edgeDensity * 20) + scaffold.componentCount + (seedB % FAULT_CLASSES.length)) % FAULT_CLASSES.length;
  const structureIndex = (Math.round((scaffold.bbox.width + scaffold.bbox.height) / 2) + (seedC % PRIMARY_STRUCTURES.length)) % PRIMARY_STRUCTURES.length;
  const repairIndex = (metrics.totalTraits + scaffold.componentCount + (seedD % REPAIR_METHODS.length)) % REPAIR_METHODS.length;
  const ghostIndex = overflowPressure < 25 ? 0 : overflowPressure < 50 ? 1 : overflowPressure < 75 ? 2 : 3;
  const packetIndex = railCount <= 3 ? 0 : railCount <= 5 ? 1 : railCount <= 7 ? 2 : 3;
  const cadenceIndex = (Math.floor(scaffold.edgeDensity * 10) + (seedA % LOOP_CADENCES.length)) % LOOP_CADENCES.length;
  const integrityIndex = overflowPressure < 30 ? 0 : overflowPressure < 55 ? 1 : overflowPressure < 80 ? 2 : 3;

  let compositionBias = "Radial Slip";
  const dx = scaffold.centroid.nx - 0.5;
  const dy = scaffold.centroid.ny - 0.5;
  if (Math.abs(dx) > Math.abs(dy)) {
    compositionBias = dx < 0 ? "Left Lean" : "Right Lean";
  } else if (Math.abs(dy) > 0.08) {
    compositionBias = dy < 0 ? "Upper Breach" : "Lower Shear";
  } else if ((seedB % 3) === 0) {
    compositionBias = "Cross-Axis Pull";
  }

  return [
    { trait_type: "Source NoPunk", value: `#${tokenId}` },
    { trait_type: "Recovery State", value: RECOVERY_STATES[stateIndex] },
    { trait_type: "Fault Class", value: FAULT_CLASSES[faultIndex] },
    { trait_type: "Primary Structure", value: PRIMARY_STRUCTURES[structureIndex] },
    { trait_type: "Composition Bias", value: compositionBias },
    { trait_type: "Repair Method", value: REPAIR_METHODS[repairIndex] },
    { trait_type: "Ghost Density", value: GHOST_DENSITIES[ghostIndex] },
    { trait_type: "Overflow Pressure", value: overflowPressure },
    { trait_type: "Packet Rails", value: PACKET_RAILS[packetIndex] },
    { trait_type: "Palette Register", value: palette.label },
    { trait_type: "Loop Cadence", value: LOOP_CADENCES[cadenceIndex] },
    { trait_type: "Integrity Gate", value: INTEGRITY_GATES[integrityIndex] },
  ];
}

function buildRenderConfig(scaffold, masterHash, traits, palette) {
  const compositionSeed = hashToSeed(masterHash, 4);
  const motionSeed = hashToSeed(masterHash, 5);
  const corruptionSeed = hashToSeed(masterHash, 6);
  const glitchSeed = hashToSeed(masterHash, 7);
  const overflowPressure = Number(traits.find((entry) => entry.trait_type === "Overflow Pressure")?.value || 50);
  const packetLabel = String(traits.find((entry) => entry.trait_type === "Packet Rails")?.value || "Sparse");
  const cadenceLabel = String(traits.find((entry) => entry.trait_type === "Loop Cadence")?.value || "Tense Cycle");

  const packetRailCount = packetLabel === "Sparse" ? 3 : packetLabel === "Forked" ? 5 : packetLabel === "Dense" ? 7 : 9;
  const ghostCopies = overflowPressure < 35 ? 1 : overflowPressure < 60 ? 2 : overflowPressure < 80 ? 3 : 4;
  const loopMs = cadenceLabel === "Slow Lock" ? 6200 : cadenceLabel === "Tense Cycle" ? 5200 : cadenceLabel === "Surge Loop" ? 4400 : 3600;

  const focus = {
    x: clamp(0.28 + (scaffold.centroid.nx * 0.44) + (((compositionSeed % 9) - 4) * 0.015), 0.18, 0.82),
    y: clamp(0.25 + (scaffold.centroid.ny * 0.5) + (((motionSeed % 9) - 4) * 0.015), 0.16, 0.84),
  };

  return {
    schema: String(traits.find((entry) => entry.trait_type === "Primary Structure")?.value || "Scan Scaffold"),
    motionProfile: String(traits.find((entry) => entry.trait_type === "Recovery State")?.value || "Boot Drift"),
    loopMs,
    focus,
    packetRailCount,
    ghostCopies,
    overflowPressure,
    repairIntensity: clamp(0.28 + (overflowPressure / 140), 0.3, 0.95),
    scanAmplitude: clamp(0.06 + (scaffold.edgeDensity * 0.4), 0.08, 0.42),
    smearAmount: clamp(0.12 + (overflowPressure / 220), 0.12, 0.6),
    corruptionZones: 2 + (corruptionSeed % 3),
    grainField: 140 + (glitchSeed % 220),
    palette,
    seedStreams: {
      composition: compositionSeed,
      palette: hashToSeed(masterHash, 1),
      motion: motionSeed,
      corruption: corruptionSeed,
    },
  };
}

function pickPunkRecord(punks, tokenId) {
  const key = String(Number(tokenId));
  const entry = punks?.[key];
  if (!entry || typeof entry !== "object") return null;
  return {
    id: Number(tokenId),
    name: String(entry.name || `No-Punk #${tokenId}`),
    traits: entry.traits && typeof entry.traits === "object" ? { ...entry.traits } : {},
  };
}

function createRecoveryFaultsService({
  traitDbPath,
  transparentRoot,
  holderSnapshotPath,
  holderHistoryPath = null,
  v2Contract = DEFAULT_V2_CONTRACT,
  v1Contract = DEFAULT_V1_CONTRACT,
} = {}) {
  const holderCache = {
    mtimeMs: 0,
    snapshot: null,
    byAddress: new Map(),
  };
  let traitDbCache = null;

  function readTraitDb() {
    if (!traitDbCache) {
      traitDbCache = JSON.parse(fs.readFileSync(traitDbPath, "utf8"));
    }
    return traitDbCache;
  }

  function readHolderSnapshot() {
    if (!holderSnapshotPath || !fs.existsSync(holderSnapshotPath)) {
      return {
        generatedAt: null,
        summary: {},
        holders: [],
        byAddress: new Map(),
        source: {
          mode: "missing",
        },
      };
    }

    const stats = fs.statSync(holderSnapshotPath);
    if (holderCache.snapshot && holderCache.mtimeMs === stats.mtimeMs) {
      return {
        ...holderCache.snapshot,
        byAddress: holderCache.byAddress,
      };
    }

    const parsed = JSON.parse(fs.readFileSync(holderSnapshotPath, "utf8"));
    const holders = Array.isArray(parsed?.holders) ? parsed.holders : [];
    const byAddress = new Map();
    holders.forEach((holder) => {
      const address = normalizeAddress(holder?.address);
      if (!address) return;
      byAddress.set(address, {
        address,
        balance: Number(holder.balance) || (Array.isArray(holder.tokenIds) ? holder.tokenIds.length : 0),
        tokenIds: Array.isArray(holder.tokenIds) ? holder.tokenIds : [],
        lastActivity: holder.lastActivity || null,
      });
    });

    holderCache.mtimeMs = stats.mtimeMs;
    holderCache.snapshot = {
      generatedAt: parsed?.generatedAt || null,
      summary: parsed?.summary || {},
      holders,
      source: {
        ...(parsed?.source || {}),
        mode: "snapshot-file",
        path: holderSnapshotPath,
        historyPath: holderHistoryPath,
      },
    };
    holderCache.byAddress = byAddress;
    return {
      ...holderCache.snapshot,
      byAddress,
    };
  }

  function getHolder(address) {
    const normalized = normalizeAddress(address);
    if (!normalized) return null;
    const snapshot = readHolderSnapshot();
    return snapshot.byAddress.get(normalized) || null;
  }

  function getFeaturePack(tokenId) {
    const id = Number.parseInt(String(tokenId), 10);
    if (!Number.isInteger(id) || id < 0 || id > 9999) {
      const error = new Error("Invalid tokenId");
      error.statusCode = 400;
      throw error;
    }

    const traitDb = readTraitDb();
    const punk = pickPunkRecord(traitDb?.punks, id);
    if (!punk) {
      const error = new Error("NoPunk not found");
      error.statusCode = 404;
      throw error;
    }

    const pngPath = path.join(transparentRoot, `${id}.png`);
    if (!fs.existsSync(pngPath)) {
      const error = new Error("Transparent asset not found");
      error.statusCode = 404;
      throw error;
    }

    const scaffold = buildScaffoldFromPng(fs.readFileSync(pngPath));
    const metrics = deriveTraitMetrics(punk, traitDb);
    const snapshot = readHolderSnapshot();
    const snapshotId = snapshot.generatedAt || "snapshot-unavailable";
    const identityHash = stableHash([v2Contract, id, scaffold.silhouetteHash]);
    const faultHash = stableHash([v1Contract, id, scaffold.silhouetteHash, metrics.avgRarity]);
    const masterHash = stableHash([identityHash, faultHash, snapshotId]);
    const palette = choosePalette(scaffold.accentColors, hashToSeed(masterHash, 1));
    const traits = makeTraits(id, punk, scaffold, metrics, masterHash, palette);
    const render = buildRenderConfig(scaffold, masterHash, traits, palette);

    return {
      ok: true,
      tokenId: id,
      hashAlgorithm: HASH_ALGO,
      identityHash,
      faultHash,
      masterHash,
      sourceContracts: {
        v2: v2Contract,
        v1: v1Contract,
      },
      sourcePunk: {
        id,
        name: punk.name,
        traits: punk.traits,
        traitSummary: buildTraitSummary(punk.traits),
        previewUrl: `/transparent/${id}.png`,
      },
      snapshot: {
        generatedAt: snapshot.generatedAt,
        summary: snapshot.summary || {},
      },
      featurePack: {
        tokenId: id,
        seed: masterHash,
        traits,
        palette: {
          id: palette.id,
          label: palette.label,
          ground: palette.ground,
          structure: palette.structure,
          accent: palette.accent,
          corruption: palette.corruption,
          void: palette.void,
          sourceAccents: scaffold.accentColors,
        },
        render,
        scaffold: {
          width: scaffold.width,
          height: scaffold.height,
          visibleCount: scaffold.visibleCount,
          componentCount: scaffold.componentCount,
          edgeCount: scaffold.edgeCount,
          edgeDensity: scaffold.edgeDensity,
          bbox: scaffold.bbox,
          centroid: scaffold.centroid,
          rowWeights: scaffold.rowWeights,
          colWeights: scaffold.colWeights,
          points: scaffold.points,
          dominantColors: scaffold.dominantColors,
          silhouetteHash: scaffold.silhouetteHash,
        },
        metrics,
        contracts: {
          sourceCollection: v2Contract,
          exploitOrigin: v1Contract,
        },
        claim: {
          currentClaimContract: process.env.RECOVERY_FAULTS_CLAIM_CONTRACT || null,
          holderDiscovery: "snapshot-only",
          liveClaimAuthority: "sourceCollection.ownerOf(tokenId)",
        },
      },
    };
  }

  return {
    getConfig() {
      const snapshot = readHolderSnapshot();
      return {
        ok: true,
        product: "NoPunks Recovery Faults",
        contracts: {
          v2: v2Contract,
          v1: v1Contract,
          claim: process.env.RECOVERY_FAULTS_CLAIM_CONTRACT || null,
        },
        holderSnapshot: {
          generatedAt: snapshot.generatedAt,
          summary: snapshot.summary || {},
          source: snapshot.source || {},
        },
        hashAlgorithm: HASH_ALGO,
      };
    },
    getHolder,
    getFeaturePack,
  };
}

module.exports = {
  createRecoveryFaultsService,
  normalizeAddress,
};
