"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FAMILY_ENGINE_URL = pathToFileURL(path.join(__dirname, "../web/lib/family-engine.mjs")).href;
const FAMILY_RAIL_URL = pathToFileURL(path.join(__dirname, "../web/lib/family-variant-rail.mjs")).href;
const NO_PALETTE_RENDER_URL = pathToFileURL(path.join(__dirname, "../web/lib/no-palette-render.js")).href;

const SAMPLE_CLASSIFIED = [
  { hex: "#000000", role: "background" },
  { hex: "#040404", role: "outline" },
  { hex: "#3A2F2A", role: "body" },
  { hex: "#6A5644", role: "body" },
  { hex: "#8B7A63", role: "neutral" },
  { hex: "#C89A61", role: "accent" },
  { hex: "#E0C796", role: "accent" },
];

function addRgbDelta(hex, step = 4) {
  const clean = String(hex || "").replace(/^#/, "");
  const r = Math.min(255, Number.parseInt(clean.slice(0, 2), 16) + step);
  const g = Math.min(255, Number.parseInt(clean.slice(2, 4), 16) + step);
  const b = Math.min(255, Number.parseInt(clean.slice(4, 6), 16) + step);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function buildBaseOptions() {
  return {
    tokenId: 7804,
    classified: SAMPLE_CLASSIFIED,
    globalModifiers: {
      toneCount: 5,
      contrast: 62,
      traitFocus: 54,
      paletteDrift: 28,
    },
    familyModifiers: {},
    noMinimalMode: "exact",
    selectedActiveHex: "#B48C63",
    useActiveBg: false,
    curatedPaletteMap: {},
    lockState: {
      background: false,
      accentBias: false,
      curatedMap: false,
    },
    lockSnapshot: {},
    pageIndex: 0,
    slotIndex: 0,
  };
}

test("family engine is deterministic and preserves strict role mapping", async () => {
  const { buildFamilyVariant, BRAND_ROLE_BG, BRAND_ROLE_FG } = await import(FAMILY_ENGINE_URL);
  const families = ["mono", "chrome", "warhol", "acid", "pastel"];
  const paletteSignatures = new Set();

  for (const family of families) {
    const a = buildFamilyVariant({
      ...buildBaseOptions(),
      family,
      noMinimalMode: "hard",
      familyModifiers: {
        mono: { hueDrift: 8, stepCompression: 56 },
        chrome: { shimmer: 70, polish: 62 },
        warhol: { flatness: 70, panelDivergence: 62 },
        acid: { clashAngle: 132, corrosion: 58 },
        pastel: { powderSoftness: 66, airLift: 60 },
      }[family],
    });
    const b = buildFamilyVariant({
      ...buildBaseOptions(),
      family,
      familyModifiers: {
        mono: { hueDrift: 8, stepCompression: 56 },
        chrome: { shimmer: 70, polish: 62 },
        warhol: { flatness: 70, panelDivergence: 62 },
        acid: { clashAngle: 132, corrosion: 58 },
        pastel: { powderSoftness: 66, airLift: 60 },
      }[family],
    });

    assert.equal(a.paletteSignature, b.paletteSignature, `${family} should be deterministic`);
    assert.equal(a.mapping[BRAND_ROLE_BG], a.roles.background, `${family} should keep background strict`);
    assert.equal(a.mapping[BRAND_ROLE_FG], a.roles.outline, `${family} should keep outline strict`);
    assert.equal(a.rolePair.roleStep, 4, `${family} cast role step should stay exact +4`);
    assert.equal(a.roles.outline, addRgbDelta(a.roles.background, 4), `${family} outline should remain background +4`);
    assert.equal(a.classification[0].family, family, `${family} should top-rank as itself`);
    assert.equal(a.score, a.scores.totalScore, `${family} score alias should remain stable`);
    paletteSignatures.add(a.paletteSignature);
  }

  assert.equal(paletteSignatures.size, 5, "families should remain distinct");
});

test("source role classification only reserves exact #000000 and #040404", async () => {
  const { classifyPixelRoles, normalizeNoPunkSourceImageData } = await import(NO_PALETTE_RENDER_URL);
  const imageData = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      0x00, 0x00, 0x00, 0xFF,
      0x0B, 0x0B, 0x0D, 0xFF,
      0x03, 0x01, 0x02, 0xFF,
      0xBC, 0x8C, 0x63, 0xFF,
    ]),
  };

  const roles = classifyPixelRoles(normalizeNoPunkSourceImageData(imageData));

  assert.equal(roles.get("0,0"), "background");
  assert.equal(roles.get("1,0"), "outline");
  assert.notEqual(roles.get("0,1"), "background", "dark non-role colors must not become background");
  assert.notEqual(roles.get("0,1"), "outline", "dark non-role colors must not become outline");
});

test("variant rail avoids duplicates and honors background/curated locks", async () => {
  const { buildFamilyVariant } = await import(FAMILY_ENGINE_URL);
  const { buildFamilyVariantRailPage } = await import(FAMILY_RAIL_URL);

  const lockedBase = buildFamilyVariant({
    ...buildBaseOptions(),
    family: "acid",
    familyModifiers: { clashAngle: 132, corrosion: 58 },
  });

  const page = buildFamilyVariantRailPage({
    tokenId: 7804,
    family: "acid",
    classified: SAMPLE_CLASSIFIED,
    globalModifiers: {
      toneCount: 5,
      contrast: 62,
      traitFocus: 54,
      paletteDrift: 28,
    },
    familyModifiers: { clashAngle: 132, corrosion: 58 },
    noMinimalMode: "exact",
    selectedActiveHex: "#B48C63",
    useActiveBg: false,
    curatedPaletteMap: { "#C89A61": "#FF66CC" },
    lockState: {
      background: true,
      accentBias: true,
      curatedMap: true,
    },
    lockSnapshot: {
      backgroundHex: lockedBase.roles.background,
      accentHue: lockedBase.meta.accentHue,
      curatedPaletteMap: { "#C89A61": "#FF66CC" },
    },
    pageIndex: 1,
    pageSize: 8,
  });

  assert.equal(page.variants.length, 8);
  assert.equal(new Set(page.variants.map((variant) => variant.paletteSignature)).size, 8, "rail page should avoid duplicate variants");

  for (const variant of page.variants) {
    assert.equal(variant.roles.background, lockedBase.roles.background, "background lock should stabilize rail pages");
    assert.equal(variant.mapping["#C89A61"], "#FF66CC", "curated map lock should preserve exact curated targets");
  }
});

test("family engine uses novelty history to avoid near-duplicate accepted variants", async () => {
  const { buildFamilyVariant } = await import(FAMILY_ENGINE_URL);
  const base = buildFamilyVariant({
    ...buildBaseOptions(),
    family: "warhol",
    familyModifiers: { flatness: 70, panelDivergence: 62 },
  });

  const withHistory = buildFamilyVariant({
    ...buildBaseOptions(),
    family: "warhol",
    familyModifiers: { flatness: 70, panelDivergence: 62 },
    noveltyHistory: {
      localAcceptedVariants: [{
        family: "warhol",
        palette: base.palette,
      }],
      galleryHistory: [],
    },
  });

  assert.notEqual(withHistory.paletteSignature, base.paletteSignature, "history-aware generation should reject exact local duplicates");
  assert.match(String(withHistory.meta.intendedFamily || ""), /warhol/);
});

test("family casts ignore selected active hex when active background mode is off", async () => {
  const { buildFamilyVariant } = await import(FAMILY_ENGINE_URL);
  const classified = [
    { hex: "#000000", role: "background" },
    { hex: "#040404", role: "outline" },
  ];

  const a = buildFamilyVariant({
    ...buildBaseOptions(),
    family: "acid",
    classified,
    selectedActiveHex: "#FF0088",
    useActiveBg: false,
  });
  const b = buildFamilyVariant({
    ...buildBaseOptions(),
    family: "acid",
    classified,
    selectedActiveHex: "#00FFD0",
    useActiveBg: false,
  });

  assert.equal(a.paletteSignature, b.paletteSignature, "active swatch should not steer blank/minimal family casts when background anchoring is off");
  assert.equal(a.roles.background, b.roles.background, "family-picked backgrounds should stay stable when the active swatch changes");
});

test("rail context signature changes when novelty history changes", async () => {
  const { railContextSignature } = await import(FAMILY_RAIL_URL);
  const common = {
    tokenId: 7804,
    family: "mono",
    sourcePaletteSignature: "source-a",
    selectedActiveHex: "#B48C63",
    noMinimalMode: "exact",
    useActiveBg: false,
    lockState: {
      background: false,
      accentBias: false,
      curatedMap: false,
    },
    curatedMapSignature: "curated-a",
    globalModifiers: {
      toneCount: 5,
      contrast: 62,
      traitFocus: 54,
      paletteDrift: 28,
    },
    familyModifiers: {
      hueDrift: 8,
      stepCompression: 56,
    },
  };

  const a = railContextSignature({
    ...common,
    noveltyHistorySignature: "hist-a",
  });
  const b = railContextSignature({
    ...common,
    noveltyHistorySignature: "hist-b",
  });

  assert.notEqual(a, b);
});

test("rail context signature ignores selected active hex when active background mode is off", async () => {
  const { railContextSignature } = await import(FAMILY_RAIL_URL);
  const common = {
    tokenId: 7804,
    family: "mono",
    sourcePaletteSignature: "source-a",
    noMinimalMode: "exact",
    useActiveBg: false,
    lockState: {
      background: false,
      accentBias: false,
      curatedMap: false,
    },
    curatedMapSignature: "curated-a",
    noveltyHistorySignature: "hist-a",
    globalModifiers: {
      toneCount: 5,
      contrast: 62,
      traitFocus: 54,
      paletteDrift: 28,
    },
    familyModifiers: {
      hueDrift: 8,
      stepCompression: 56,
    },
  };

  const a = railContextSignature({
    ...common,
    selectedActiveHex: "#FF0088",
  });
  const b = railContextSignature({
    ...common,
    selectedActiveHex: "#00FFD0",
  });

  assert.equal(a, b);
});
