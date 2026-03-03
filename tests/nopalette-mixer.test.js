"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addRgbDelta,
  computeMixerParams,
  deriveSeed,
  extractPaletteAndRoles,
  generatePaletteMapping,
  remapPixels24,
  rgbIntListFromMapping,
} = require("../server/lib/nopalette/mixer");

function buildSampleRgba({ variant = "a" } = {}) {
  const bytes = Buffer.alloc(24 * 24 * 4);
  const palette = [
    [4, 4, 4, 255],
    [109, 40, 217, 255],
    [236, 72, 153, 255],
    [16, 185, 129, 255],
    [245, 158, 11, 255],
  ];
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      const i = (y * 24 + x) * 4;
      if ((x + y) % 5 === 0 && !(x === 1 && y === 0)) {
        bytes[i] = 0;
        bytes[i + 1] = 0;
        bytes[i + 2] = 0;
        bytes[i + 3] = 0;
        continue;
      }
      const idxBase = variant === "a" ? (x + y) : (x * 3 + y * 2);
      const p = palette[idxBase % palette.length];
      bytes[i] = p[0];
      bytes[i + 1] = p[1];
      bytes[i + 2] = p[2];
      bytes[i + 3] = p[3];
    }
  }
  // Guarantee a visible #040404 role pixel exists in the fixture.
  bytes[0] = 4;
  bytes[1] = 4;
  bytes[2] = 4;
  bytes[3] = 255;
  return bytes;
}

function buildTwoRoleOnlyRgba({ variant = "a" } = {}) {
  const bytes = Buffer.alloc(24 * 24 * 4);
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      const i = (y * 24 + x) * 4;
      const draw = variant === "a"
        ? ((x + y) % 7 === 0 || (x >= 8 && x <= 15 && y === 12))
        : ((x * 2 + y * 5) % 11 === 0 || (y >= 6 && y <= 18 && x === 11));
      if (!draw) {
        bytes[i] = 0;
        bytes[i + 1] = 0;
        bytes[i + 2] = 0;
        bytes[i + 3] = 0;
        continue;
      }
      bytes[i] = 4;
      bytes[i + 1] = 4;
      bytes[i + 2] = 4;
      bytes[i + 3] = 255;
    }
  }
  // Guarantee at least one visible role pixel.
  bytes[0] = 4;
  bytes[1] = 4;
  bytes[2] = 4;
  bytes[3] = 255;
  return bytes;
}

function lumFromHex(hex) {
  const clean = String(hex || "").replace(/^#/, "");
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

test("deriveSeed is deterministic and sensitive to RGBA bytes", () => {
  const rgbaA = buildSampleRgba({ variant: "a" });
  const rgbaB = buildSampleRgba({ variant: "b" }); // same visible palette, different structure

  const seedA1 = deriveSeed({ rgba24Bytes: rgbaA, userSeed: "123", toolVersion: "v1" });
  const seedA2 = deriveSeed({ rgba24Bytes: rgbaA, userSeed: "123", toolVersion: "v1" });
  const seedB = deriveSeed({ rgba24Bytes: rgbaB, userSeed: "123", toolVersion: "v1" });

  assert.equal(seedA1, seedA2);
  assert.notEqual(seedA1, seedB);
});

test("extractPaletteAndRoles returns visible palette in first-seen order", () => {
  const rgba = buildSampleRgba({ variant: "a" });
  const extracted = extractPaletteAndRoles(rgba);
  assert.ok(extracted.originalPalette.length >= 3);
  assert.ok(extracted.roles.hasOutlineRole, "expected visible #040404 outline role");
  assert.equal(extracted.visiblePixels < 24 * 24, true, "expected transparent pixels present");
});

test("generatePaletteMapping enforces strictness, uniqueness, and role rule deterministically", () => {
  const rgba = buildSampleRgba({ variant: "a" });
  const extracted = extractPaletteAndRoles(rgba);
  const derivedSeed = deriveSeed({ rgba24Bytes: rgba, userSeed: "42", toolVersion: "no-palette-v1" });

  const first = generatePaletteMapping({
    originalPalette: extracted.originalPalette,
    rarityNorm: 0.72,
    derivedSeed,
    registrySnapshot: new Set(),
    strict: true,
  });
  const second = generatePaletteMapping({
    originalPalette: extracted.originalPalette,
    rarityNorm: 0.72,
    derivedSeed,
    registrySnapshot: new Set(),
    strict: true,
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.mapping, second.mapping);
  assert.equal(first.roles.background, second.roles.background);
  assert.equal(first.roles.outline, second.roles.outline);

  const originalSet = new Set(extracted.originalPalette);
  for (const rgbInt of first.generatedPalette) {
    assert.equal(originalSet.has(rgbInt), false, `generated color reused original: ${rgbInt.toString(16)}`);
  }

  const uniqueGenerated = new Set(first.generatedPalette.map((n) => n >>> 0));
  assert.equal(uniqueGenerated.size, first.generatedPalette.length, "duplicate RGB in generated palette");
  assert.equal(first.roles.outline >>> 0, addRgbDelta(first.roles.background, 4) >>> 0);

  const outlineLum = lumFromHex(first.roles.outlineHex);
  for (const [srcHex, dstHex] of Object.entries(first.mapping)) {
    if (srcHex === "#000000" || srcHex === "#040404") continue;
    assert.ok(
      lumFromHex(dstHex) > outlineLum,
      `non-role mapped color undercut outline relief floor: ${srcHex} -> ${dstHex}`
    );
  }
});

test("rarity changes mixer behavior", () => {
  const low = computeMixerParams(0.1);
  const high = computeMixerParams(0.9);
  assert.ok(high.triMixChance > low.triMixChance);
  assert.ok(high.extraStageChance > low.extraStageChance);
  assert.ok(high.weightMin < low.weightMin);
  assert.ok(high.weightMax > low.weightMax);
  assert.ok(high.extrapolationChance > low.extrapolationChance);
  assert.ok(high.extrapolationMax > low.extrapolationMax);
  assert.ok(high.smallPaletteExtrapolationBoost > low.smallPaletteExtrapolationBoost);
});

test("two-role-only palettes exceed the convex 3-output cap at high rarity via extrapolated mixing", () => {
  const rgba = buildTwoRoleOnlyRgba({ variant: "a" });
  const extracted = extractPaletteAndRoles(rgba);
  assert.deepEqual(extracted.originalPalette, [0x040404], "fixture should only expose visible #040404");

  const backgrounds = new Set();
  const outlines = new Set();

  for (let seed = 0; seed < 64; seed += 1) {
    const derivedSeed = deriveSeed({
      rgba24Bytes: rgba,
      userSeed: `edge-${seed}`,
      toolVersion: "no-palette-v1",
    });
    const result = generatePaletteMapping({
      originalPalette: extracted.originalPalette,
      rarityNorm: 1,
      derivedSeed,
      registrySnapshot: new Set(),
      strict: true,
    });
    assert.equal(result.ok, true, `generation failed for seed ${seed}`);
    assert.equal(result.roles.outline >>> 0, addRgbDelta(result.roles.background, 4) >>> 0);
    backgrounds.add(result.roles.background >>> 0);
    outlines.add(result.roles.outline >>> 0);
  }

  // Pure convex 0/4 mixing under strict mode leaves only #010101/#020202/#030303 as backgrounds.
  assert.ok(backgrounds.size > 3, `expected >3 strict background tones, got ${backgrounds.size}`);
  assert.ok(outlines.size > 3, `expected >3 strict outline tones, got ${outlines.size}`);
});

test("remapPixels24 preserves pixel structure and produces opaque output", () => {
  const rgba = buildSampleRgba({ variant: "a" });
  const extracted = extractPaletteAndRoles(rgba);
  const derivedSeed = deriveSeed({ rgba24Bytes: rgba, userSeed: "abc", toolVersion: "no-palette-v1" });
  const mapping = generatePaletteMapping({
    originalPalette: extracted.originalPalette,
    rarityNorm: 0.5,
    derivedSeed,
    registrySnapshot: new Set(),
    strict: true,
  });
  assert.equal(mapping.ok, true);

  const out = remapPixels24({
    rgba24Bytes: rgba,
    mapping: mapping.mapping,
    roles: mapping.roles,
  });

  assert.equal(out.length, rgba.length);
  for (let i = 3; i < out.length; i += 4) {
    assert.equal(out[i], 255);
  }

  const reservedColors = rgbIntListFromMapping({ mapping: mapping.mapping, roles: mapping.roles });
  assert.ok(reservedColors.length >= 2);
});
