import {
  getNoStudioConfig,
  listNoStudioGallery,
  renderNoStudioNoiseGif,
  saveNoStudioGallery,
  searchPunks,
  voteNoStudioGallery,
} from "../api.js";
import { mountPunkPicker } from "../components/punk-picker.js";
import {
  createSourceImageDataFromImage,
  classifyPixelRoles,
  encodeRgba24B64,
  getOccupiedPixels,
} from "../lib/no-palette-render.js";
import { createStudioTemplate } from "./no-studio-template.js";
import { StudioCanvas } from "../lib/studio-canvas.js";
import {
  applyPreset,
  createRandomPreset, DEFAULT_TONE_STEP,
} from "../lib/art-presets.js";
import {
  hslToRgb, rgbToHsl, rgbToHex, hexToRgb,
  hexLuma, lerp, mixHex, distanceRgb,
} from "../lib/color.js";
import { deriveNoMinimalismPair } from "../lib/studio-signature.js";
import { exportCanvasPng } from "../lib/download.js";
import { encodeIndexedGif, quantizeImageDataToRgb332 } from "../lib/gif-encode.js";
import { buildFamilyVariantRailPage, createEmptyRailState, railContextSignature, DEFAULT_RAIL_PAGE_SIZE } from "../lib/family-variant-rail.mjs";
import {
  buildGalleryProvenance,
  makePaletteSignature,
  makeCuratedPaletteSignature,
  makeSourcePaletteSignature,
  sanitizeCuratedPaletteMap,
} from "../lib/gallery-provenance.mjs";

function escapeHtml(v) {
  return String(v || "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
}

async function loadImage(url) {
  const img = new Image();
  img.decoding = "async";
  img.loading = "eager";
  const loaded = new Promise((ok, fail) => { img.onload = ok; img.onerror = () => fail(new Error("Image load failed")); });
  img.src = url;
  try { if (img.decode) await img.decode(); else await loaded; } catch { await loaded; }
  return img;
}

const atlasImageCache = new Map();

async function loadSourceAsset(item) {
  if (item && item.previewAtlas) {
    const atlasUrl = item.previewAtlas.url;
    let atlas = atlasImageCache.get(atlasUrl);
    if (!atlas) {
      atlas = await loadImage(atlasUrl);
      atlasImageCache.set(atlasUrl, atlas);
    }
    const tileSize = Number(item.previewAtlas.tileSize || 24);
    const canvas = document.createElement("canvas");
    canvas.width = tileSize;
    canvas.height = tileSize;
    const ctx = canvas.getContext("2d", { alpha: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      atlas,
      Number(item.previewAtlas.x || 0),
      Number(item.previewAtlas.y || 0),
      tileSize,
      tileSize,
      0,
      0,
      tileSize,
      tileSize,
    );
    return {
      image: canvas,
      imageData: createSourceImageDataFromImage(canvas),
    };
  }

  const image = await loadImage(item.previewUrl);
  return {
    image,
    imageData: createSourceImageDataFromImage(image),
  };
}

function clampEssentialTones(value) {
  const tones = Math.round(Number(value) || 4);
  return Math.max(3, Math.min(8, tones));
}

function randomInt(min, max) {
  return Math.floor(min + (Math.random() * ((max - min) + 1)));
}

function pickOne(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[randomInt(0, list.length - 1)];
}

function normalizeHexPalette(list) {
  if (!Array.isArray(list)) return [];
  const dedupe = new Set();
  const out = [];
  for (const value of list) {
    const hex = String(value || "").trim().toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex) || dedupe.has(hex)) continue;
    dedupe.add(hex);
    out.push(hex);
  }
  return out;
}

function normalizeGalleryLabel(value, tokenId = 0) {
  const base = String(value || "").trim() || `No-Studio #${Number(tokenId) || 0}`;
  return base.replace(/\bsurprise\s+world\b/gi, "No-Curation");
}

function resolveGalleryPalette(item) {
  const fromPayload = normalizeHexPalette(item?.palette || item?.paletteHexes || []);
  if (fromPayload.length) return fromPayload;
  const fallback = [];
  const bg = String(item?.rolePair?.background || "").trim().toUpperCase();
  const fg = String(item?.rolePair?.figure || "").trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(bg)) fallback.push(bg);
  if (/^#[0-9A-F]{6}$/.test(fg) && fg !== bg) fallback.push(fg);
  return fallback;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  if (fileName) {
    link.download = fileName;
  }
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function collapsePresetResult(classified, presetResult, totalTones) {
  const toneCount = clampEssentialTones(totalTones);
  const nonRole = (classified || [])
    .filter((entry) => entry.role !== "background" && entry.role !== "outline")
    .map((entry) => ({
      sourceHex: entry.hex,
      mappedHex: String((presetResult?.mapping || {})[entry.hex] || entry.hex).toUpperCase(),
    }));

  const bandCount = Math.max(1, toneCount - 2);
  if (nonRole.length <= 1 || bandCount >= nonRole.length) {
    return presetResult;
  }

  const uniqueHex = Array.from(new Set(nonRole.map((entry) => entry.mappedHex)))
    .sort((a, b) => hexLuma(a) - hexLuma(b));
  if (uniqueHex.length <= bandCount) {
    return presetResult;
  }

  const bandHexes = [];
  if (bandCount === 1) {
    bandHexes.push(uniqueHex[Math.max(0, Math.round((uniqueHex.length - 1) * 0.66))]);
  } else {
    for (let i = 0; i < bandCount; i += 1) {
      const idx = Math.round((i / (bandCount - 1)) * (uniqueHex.length - 1));
      bandHexes.push(uniqueHex[idx]);
    }
  }

  const ranked = nonRole.slice().sort((a, b) => hexLuma(a.mappedHex) - hexLuma(b.mappedHex));
  const nextMapping = { ...(presetResult?.mapping || {}) };

  for (let i = 0; i < ranked.length; i += 1) {
    const bandIndex = bandCount === 1
      ? 0
      : Math.min(bandCount - 1, Math.floor((i / Math.max(1, ranked.length)) * bandCount));
    nextMapping[ranked[i].sourceHex] = bandHexes[bandIndex];
  }

  return {
    ...presetResult,
    mapping: nextMapping,
  };
}

function ensureDistinctHex(hex, used, { floor = -1, forbidden = null } = {}) {
  const taken = used || new Set();
  const blocked = forbidden instanceof Set ? forbidden : null;
  let current = String(hex || "#000000").toUpperCase();
  let attempts = 0;
  while (attempts < 16) {
    if (!taken.has(current) && (!blocked || !blocked.has(current)) && hexLuma(current) > floor) {
      taken.add(current);
      return current;
    }
    current = mixHex(current, "#FFFFFF", 0.14 + (attempts * 0.04));
    attempts += 1;
  }
  taken.add(current);
  return current;
}

const FAMILY_IDS = ["mono", "chrome", "warhol", "acid", "pastel"];
const FAMILY_LABELS = {
  mono: "Mono",
  chrome: "Chrome",
  warhol: "Pop",
  acid: "Acid",
  pastel: "Pastel",
};
const START_MODE_IDS = ["full", "blank"];
const POP_SHEET_STYLE_SOFT = "soft-poster";
const POP_SHEET_STYLE_POSTER = "poster-grid";
const POP_SHEET_STYLE_SCREENPRINT = "screenprint";
const GRID_HARMONY_PROFILES = {
  mono: { hueSpan: 8, satMul: [0.92, 1.02], lightMul: [0.9, 1.08], bgScale: 0.35 },
  chrome: { hueSpan: 12, satMul: [0.9, 1.06], lightMul: [0.92, 1.1], bgScale: 0.42 },
  warhol: { hueSpan: 18, satMul: [0.94, 1.1], lightMul: [0.92, 1.08], bgScale: 0.48 },
  acid: { hueSpan: 16, satMul: [0.96, 1.12], lightMul: [0.86, 1.04], bgScale: 0.44 },
  pastel: { hueSpan: 10, satMul: [0.86, 0.98], lightMul: [0.98, 1.1], bgScale: 0.3 },
};
const GRID_PANEL_STYLES = [
  {
    id: "hero",
    hueBias: 0,
    accentHueBias: 8,
    satMul: [0.94, 1.04],
    lightMul: [0.95, 1.05],
    bgBlend: 0.18,
    bgSatMul: 1.02,
    bgLightMul: 0.98,
    flatMix: 0.03,
    accentLift: 0.03,
  },
  {
    id: "split",
    hueBias: 34,
    accentHueBias: 52,
    satMul: [0.96, 1.1],
    lightMul: [0.9, 1.02],
    bgBlend: 0.36,
    bgSatMul: 1.08,
    bgLightMul: 0.94,
    flatMix: 0.06,
    accentLift: 0.04,
  },
  {
    id: "flip",
    hueBias: -46,
    accentHueBias: -70,
    satMul: [0.92, 1.1],
    lightMul: [0.88, 1.02],
    bgBlend: 0.44,
    bgSatMul: 1.1,
    bgLightMul: 0.92,
    flatMix: 0.08,
    accentLift: 0.05,
  },
  {
    id: "echo",
    hueBias: 18,
    accentHueBias: 26,
    satMul: [0.9, 1.03],
    lightMul: [0.98, 1.1],
    bgBlend: 0.26,
    bgSatMul: 0.98,
    bgLightMul: 1.06,
    flatMix: 0.02,
    accentLift: 0.03,
  },
  {
    id: "shadow",
    hueBias: -18,
    accentHueBias: -32,
    satMul: [0.88, 1],
    lightMul: [0.82, 0.98],
    bgBlend: 0.32,
    bgSatMul: 1,
    bgLightMul: 0.88,
    flatMix: 0.1,
    accentLift: -0.01,
  },
  {
    id: "duotone",
    hueBias: 72,
    accentHueBias: 104,
    satMul: [0.98, 1.14],
    lightMul: [0.9, 1.02],
    bgBlend: 0.52,
    bgSatMul: 1.12,
    bgLightMul: 0.94,
    flatMix: 0.14,
    accentLift: 0.06,
  },
];
const FAMILY_GRID_STYLE_ORDERS = {
  mono: [0, 3, 4, 1, 2, 5],
  chrome: [0, 1, 3, 5, 2, 4],
  warhol: [5, 1, 2, 0, 3, 4],
  acid: [2, 5, 4, 1, 0, 3],
  pastel: [3, 0, 1, 4, 2, 5],
};
const GRID_FRAME_TONES = {
  black: {
    label: "Black",
    frameFill: "#040404",
    frameStroke: "rgba(255,255,255,0.18)",
  },
  white: {
    label: "White",
    frameFill: "#F4F1EA",
    frameStroke: "rgba(32,24,16,0.18)",
  },
  cream: {
    label: "Off White",
    frameFill: "#EBD8B8",
    frameStroke: "rgba(28,20,12,0.35)",
  },
  stone: {
    label: "Stone",
    frameFill: "#C9C1B6",
    frameStroke: "rgba(34,28,24,0.28)",
  },
};
const BRAND_ROLE_BG = "#000000";
const BRAND_ROLE_FG = "#040404";
const POP_POSTER_BACKGROUNDS = [
  "#F6E7C8",
  "#FF6B6B",
  "#FFD84A",
  "#67D6FF",
  "#FF9F1C",
  "#7EE7C9",
  "#FF5EA8",
  "#B4F25B",
];
const POP_SCREENPRINT_BACKGROUNDS = [
  "#F6E7C8",
  "#EFD9B4",
  "#F2E6D0",
  "#E9D2BF",
];
const FAMILY_PROFILES = {
  mono: {
    bgSat: [0.04, 0.16],
    bgLight: [0.16, 0.34],
    hueShift: 16,
    sat: [0.03, 0.22],
    light: [0.22, 0.76],
    accentLift: 0.06,
    quantMin: 3,
    quantMax: 7,
  },
  chrome: {
    bgSat: [0.05, 0.22],
    bgLight: [0.34, 0.72],
    hueShift: 36,
    sat: [0.05, 0.34],
    light: [0.18, 0.92],
    accentLift: 0.1,
    quantMin: 4,
    quantMax: 7,
  },
  warhol: {
    bgSat: [0.62, 0.98],
    bgLight: [0.28, 0.68],
    hueShift: 210,
    sat: [0.66, 1],
    light: [0.2, 0.84],
    accentLift: 0.08,
    quantMin: 4,
    quantMax: 6,
  },
  acid: {
    bgSat: [0.78, 1],
    bgLight: [0.14, 0.38],
    hueShift: 260,
    sat: [0.8, 1],
    light: [0.14, 0.72],
    accentLift: 0.1,
    quantMin: 5,
    quantMax: 7,
  },
  pastel: {
    bgSat: [0.14, 0.36],
    bgLight: [0.66, 0.92],
    hueShift: 64,
    sat: [0.08, 0.36],
    light: [0.7, 0.94],
    accentLift: 0.05,
    quantMin: 4,
    quantMax: 7,
  },
};

const NOIR_COLOR_SCHEMES = [
  {
    id: "classic-noir",
    anchors: ["#0E0E0E", "#1A1A1A", "#2E2E2E", "#5B5B5B", "#D8D3C9"],
  },
  {
    id: "blood-noir",
    anchors: ["#0D0C0E", "#181618", "#2B171C", "#4A3036", "#DED1C7"],
  },
  {
    id: "cold-noir",
    anchors: ["#0C0E12", "#141923", "#273449", "#505C6E", "#D2D7DE"],
  },
  {
    id: "bruise-noir",
    anchors: ["#0E0B12", "#171420", "#2D2238", "#57505D", "#E0D8CF"],
  },
];

function normalizePopSheetStyle(value) {
  const style = String(value || "").trim().toLowerCase();
  if (style === POP_SHEET_STYLE_SOFT || style === "soft") return POP_SHEET_STYLE_SOFT;
  if (style === POP_SHEET_STYLE_SCREENPRINT) return POP_SHEET_STYLE_SCREENPRINT;
  if (style === "warhol" || style === POP_SHEET_STYLE_POSTER) return POP_SHEET_STYLE_POSTER;
  return POP_SHEET_STYLE_SOFT;
}

function popSheetStyleLabel(value) {
  const style = normalizePopSheetStyle(value);
  if (style === POP_SHEET_STYLE_SCREENPRINT) return "Screenprint";
  if (style === POP_SHEET_STYLE_POSTER) return "Poster Grid";
  return "Soft Poster";
}

function popSheetStyleStatusSlug(value) {
  const style = normalizePopSheetStyle(value);
  if (style === POP_SHEET_STYLE_SCREENPRINT) return "screenprint";
  if (style === POP_SHEET_STYLE_POSTER) return "poster-grid";
  return "soft-poster";
}

function createDefaultGlobalModifiers() {
  return {
    toneCount: 5,
    contrast: 62,
    traitFocus: 54,
    paletteDrift: 28,
    grainAmount: 28,
  };
}

function createDefaultFamilyModifiers() {
  return {
    mono: { hueDrift: 8, stepCompression: 56 },
    chrome: { shimmer: 70, polish: 62 },
    warhol: { flatness: 70, panelDivergence: 62 },
    acid: { clashAngle: 132, corrosion: 58 },
    pastel: { powderSoftness: 66, airLift: 60 },
  };
}

function createInitialVariantRailByFamily() {
  return {
    mono: createEmptyRailState(),
    chrome: createEmptyRailState(),
    warhol: createEmptyRailState(),
    acid: createEmptyRailState(),
    pastel: createEmptyRailState(),
  };
}

export function mountNoStudioTool(root, shellApi = {}) {

  root.innerHTML = createStudioTemplate();

  // ── Elements ──────────────────────────────────────────────────

  const studioEl = root.querySelector("[data-role='studio']");
  const q = (sel) => root.querySelector(`[data-role='${sel}']`);
  const els = {
    canvasArea: q("canvas-area"),
    canvasStageSurface: q("canvas-stage-surface"),
    displayCanvas: q("display-canvas"),
    canvasEmpty: q("canvas-empty"),
    stageTitle: q("stage-title"),
    stageColorPreview: q("stage-color-preview"),
    stageColorInput: q("stage-color-input"),
    stageColorHex: q("stage-color-hex"),
    stagePaintModeRail: q("stage-paint-mode-rail"),
    stageRoleTargetRail: q("stage-role-target-rail"),
    startModeRail: q("start-mode-rail"),
    openDockColors: q("open-dock-colors"),
    dockScrim: q("dock-scrim"),
    sidebarHero: q("sidebar-hero"),
    sidebar: q("sidebar"),
    sidebarToggle: q("sidebar-toggle"),
    mobileDockToggle: q("mobile-dock-toggle"),
    dockDismiss: q("dock-dismiss"),
    sourceSection: q("source-section"),
    colorSection: q("color-section"),
    paletteSection: q("palette-section"),
    studioDockSection: q("studio-dock-section"),
    pickerHost: q("picker-host"),
    hueSlider: q("hue-slider"), satSlider: q("sat-slider"), litSlider: q("lit-slider"),
    hueValue: q("hue-value"), satValue: q("sat-value"), litValue: q("lit-value"),
    colorPreview: q("color-preview"), colorHex: q("color-hex"),
    paletteGrid: q("palette-grid"),
    paletteCurationReadout: q("palette-curation-readout"),
    wildnessSlider: q("wildness-slider"),
    wildnessValue: q("wildness-value"),
    pinActiveColor: q("pin-active-color"),
    clearPalettePins: q("clear-palette-pins"),
    curationMapActive: q("curation-map-active"),
    curationClearMapping: q("curation-clear-mapping"),
    curationApply: q("curation-apply"),
    curationResetAll: q("curation-reset-all"),
    restoreLastSession: q("restore-last-session"),
    surpriseBtn: q("surprise-btn"),
    heroNoMinimal: q("hero-no-minimal"),
    heroRolePair: q("hero-role-pair"),
    paintModeRail: q("paint-mode-rail"),
    paintTargetRail: q("paint-target-rail"),
    showMask: q("show-mask"),
    clearMask: q("clear-mask"),
    sourceOverlayToggle: q("source-overlay-toggle"),
    presetList: q("preset-list"),
    dockAdvanced: q("dock-advanced"),
    globalToneCount: q("global-tone-count"),
    globalToneCountValue: q("global-tone-count-value"),
    globalContrast: q("global-contrast"),
    globalContrastValue: q("global-contrast-value"),
    globalTraitFocus: q("global-trait-focus"),
    globalTraitFocusValue: q("global-trait-focus-value"),
    globalPaletteDrift: q("global-palette-drift"),
    globalPaletteDriftValue: q("global-palette-drift-value"),
    familyModifiersPanel: q("family-modifiers-panel"),
    noMinimalModeRail: q("no-minimal-mode-rail"),
    activeBgToggle: q("active-bg-toggle"),
    noiseTargetRail: q("noise-target-rail"),
    noiseAmount: q("noise-amount"),
    noiseAmountValue: q("noise-amount-value"),
    applyNoise: q("apply-noise"),
    clearRoleGrain: q("clear-role-grain"),
    exportPng: q("export-png"),
    exportGif: q("export-gif"),
    saveGalleryPng: q("save-gallery-png"),
    saveGalleryGif: q("save-gallery-gif"),
    singleFrameRail: q("single-frame-rail"),
    singleFrameToneRail: q("single-frame-tone-rail"),
    gallerySignature: q("gallery-signature"),
    openGalleryLink: q("open-gallery-link"),
    exportReset: q("export-reset"),
    galleryRefresh: q("gallery-refresh"),
    galleryList: q("gallery-list"),
    undoBtn: q("undo-btn"), redoBtn: q("redo-btn"),
    toolReadout: q("tool-readout"),
    toolReadoutLabel: q("tool-readout-label"),
    toolReadoutKey: q("tool-readout-key"),
    topbarStatus: q("topbar-status"),
    statusPos: q("status-pos"), statusSwatch: q("status-swatch"),
    statusHex: q("status-hex"), statusZoom: q("status-zoom"), statusRole: q("status-role"),
  };

  // ── State ─────────────────────────────────────────────────────

  const state = {
    disposed: false,
    requestToken: 0,
    selected: null,
    selectedImage: null,
    originalImageData: null,
    noiseGifAvailable: true,
    noGalleryAvailable: true,
    galleryItems: [],
    galleryLoading: false,
    gallerySaving: false,
    gallerySavingKind: null,
    galleryMessage: "",
    galleryStorage: "sqlite",
    activeTool: "pointer",
    paintMode: "create",
    activePaintTarget: "content",
    lastRolePaintTarget: "background",
    activePresetTab: "mono",
    noMinimalDeltaMode: "exact",
    useActiveBg: false,
    noiseAmount: 28,
    noisePass: 0,
    showNoiseMask: false,
    sourceOverlayVisible: false,
    lastReductionMode: "none",
    globalModifiers: createDefaultGlobalModifiers(),
    familyModifiers: createDefaultFamilyModifiers(),
    variantByFamily: {
      mono: null,
      chrome: null,
      warhol: null,
      acid: null,
      pastel: null,
    },
    localAcceptedVariantsByFamily: {
      mono: [],
      chrome: [],
      warhol: [],
      acid: [],
      pastel: [],
    },
    variantRailByFamily: createInitialVariantRailByFamily(),
    variantRailLocks: {
      background: false,
      accentBias: false,
      curatedMap: false,
    },
    activeStudioVariant: null,
    activeStudioProvenance: null,
    globalGalleryEnabled: false,
    sessionSignatures: new Set(),
    sessionSignatureOrder: [],
    outputSignatures: new Set(),
    outputSignatureOrder: [],
    originalRoleMap: null,
    originalOccupied: null,
    sourceClassifiedPalette: null,
    sourcePaletteHexes: [],
    sourceRoleByHex: new Map(),
    curatedPaletteMap: {},
    palettePins: [],
    curationSourceHex: null,
    ditherPalette: [
      { r: 255, g: 255, b: 255 },
      { r: 0, g: 0, b: 0 },
    ],
    activeColor: { h: 0, s: 0, l: 100 },
    activeColorHex: "#FFFFFF",
    gallerySignature: "",
    startMode: "full",
    noMinimalPreviewPair: null,
    noFieldLastFamily: "chrome",
    popSheetLayout: "4x4",
    gridFrameTone: "cream",
    singleFrameEnabled: false,
    singleFrameTone: "black",
    popSheetStyle: POP_SHEET_STYLE_SOFT,
    popSheetBuildNonce: 0,
    lastPopSheetPanelSignatures: [],
    isSheetMode: false,
    presentationMode: "single",
    lastSingleCompositionSnapshot: null,
    recentGridSeriesHistory: new Map(),
    gridSeriesNonce: 0,
  };

  // ── Session persistence ──────────────────────────────────────

  const SESSION_KEY = "no-studio-session";
  let pendingCanvasSession = null;
  let restoreCanvasSession = null;
  let restoreSessionArmed = false;

  function persistSession() {
    try {
      const data = canvas.exportSessionState({
        selectedTokenId: state.selected?.id ?? null,
        activePresetTab: state.activePresetTab,
        activeColor: state.activeColor,
        activeColorHex: state.activeColorHex,
        paintMode: state.paintMode,
        noMinimalDeltaMode: state.noMinimalDeltaMode,
        useActiveBg: state.useActiveBg,
        activePaintTarget: state.activePaintTarget,
        showNoiseMask: state.showNoiseMask,
        sourceOverlayVisible: state.sourceOverlayVisible,
        globalModifiers: state.globalModifiers,
        familyModifiers: state.familyModifiers,
        popSheetLayout: state.popSheetLayout,
        gridFrameTone: state.gridFrameTone,
        singleFrameEnabled: state.singleFrameEnabled,
        singleFrameTone: state.singleFrameTone,
        popSheetStyle: state.popSheetStyle,
        startMode: state.startMode,
        selectedFamily: state.activePresetTab,
        presentationMode: state.presentationMode,
        gallerySignature: normalizeSignatureHandle(els.gallerySignature?.value || state.gallerySignature || ""),
        curatedPaletteMap: state.curatedPaletteMap,
        palettePins: state.palettePins,
        curationSourceHex: state.curationSourceHex,
        variantRailLocks: state.variantRailLocks,
      });
      localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch { /* quota or private mode — ignore */ }
  }

  function restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function isRestorableCanvasSession(session) {
    return Boolean(
      session
      && Array.isArray(session.roleGrid)
      && Array.isArray(session.contentGrid)
      && session.roleGrid.length
      && session.contentGrid.length,
    );
  }

  function syncRestoreSessionButton() {
    if (!els.restoreLastSession) return;
    const visible = isRestorableCanvasSession(restoreCanvasSession);
    els.restoreLastSession.hidden = !visible;
    if (visible && restoreCanvasSession?.selectedTokenId != null) {
      els.restoreLastSession.textContent = `Restore Last Session · #${Number(restoreCanvasSession.selectedTokenId) || 0}`;
      return;
    }
    els.restoreLastSession.textContent = "Restore Last Session";
  }

  const mobileDockQuery = window.matchMedia("(max-width: 900px)");
  const handleDockMediaChange = (event) => setSidebarOpen(!event.matches);

  function setSidebarOpen(open) {
    const isOpen = Boolean(open);
    els.sidebar.classList.toggle("is-open", isOpen);
    studioEl.classList.toggle("is-dock-open", isOpen);
    els.sidebarToggle.classList.toggle("is-active", isOpen);
    els.sidebarToggle.textContent = isOpen ? "Hide Studio Deck" : "Open Studio Deck";
    els.sidebarToggle.setAttribute("aria-expanded", String(isOpen));
    if (els.mobileDockToggle) {
      els.mobileDockToggle.classList.toggle("is-open", isOpen);
      els.mobileDockToggle.textContent = isOpen ? "Close Studio Deck" : "Open Studio Deck";
      els.mobileDockToggle.setAttribute("aria-expanded", String(isOpen));
    }
    const dockWidth = isOpen ? Math.ceil(els.sidebar.getBoundingClientRect().width) + 28 : 0;
    const stageShift = isOpen ? Math.max(72, Math.min(140, Math.round(dockWidth * 0.28))) : 0;
    studioEl.style.setProperty("--dock-width-offset", `${dockWidth}px`);
    studioEl.style.setProperty("--dock-stage-shift", `${stageShift}px`);
  }

  // ── Canvas setup ──────────────────────────────────────────────

  function resizeCanvas() {
    const rect = (els.canvasStageSurface || els.canvasArea).getBoundingClientRect();
    const size = Math.floor(Math.min(rect.width, rect.height));
    if (size > 0) {
      els.displayCanvas.width = size;
      els.displayCanvas.height = size;
      if (canvas) canvas.render();
    }
  }

  const resizeObserver = new ResizeObserver(resizeCanvas);
  resizeObserver.observe(els.canvasArea);

  const canvas = new StudioCanvas(els.displayCanvas, {
    onPixelHover: (info) => {
      els.statusPos.textContent = `${info.x}, ${info.y}`;
      els.statusHex.textContent = info.hex || "—";
      els.statusSwatch.style.background = info.hex || "#000";
      els.statusRole.textContent = info.role ? info.role.toUpperCase() : "—";
    },
    onColorPick: (hex) => setActiveColorFromHex(hex),
    onChange: () => {
      state.isSheetMode = canvas.hasSheet();
      state.presentationMode = state.isSheetMode ? "sheet" : "single";
      if (!state.isSheetMode) {
        captureSingleCompositionSnapshot({ force: true });
      }
      invalidateVariantRailState();
      updateUndoRedoButtons();
      updatePaletteGrid();
      renderHeroRolePair();
      renderNoiseTargetRail();
      syncSingleFrameUi();
      applySingleFrameState();
      updateExportButtons();
      persistSession();
    },
  });

  // Initial size
  requestAnimationFrame(resizeCanvas);

  if (els.sidebarHero && els.studioDockSection) {
    els.sidebarHero.insertAdjacentElement("afterend", els.studioDockSection);
  }
  if (els.paletteSection && els.sourceSection) {
    els.paletteSection.insertAdjacentElement("afterend", els.sourceSection);
  }

  setSidebarOpen(!mobileDockQuery.matches);

  function setTopbarStatus(text = "") {
    els.topbarStatus.textContent = text;
    if (els.stageTitle) els.stageTitle.textContent = text || "Traits speak in relief";
  }

  function setServerStatus(text) {
    setTopbarStatus(text);
  }

  let signalTimer = null;
  let statusHotTimer = null;

  function pulseStudio(mode = "variant") {
    const rgb = hslToRgb(state.activeColor.h, state.activeColor.s / 100, state.activeColor.l / 100);
    studioEl.style.setProperty("--signal-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    studioEl.classList.remove("is-signaling", "is-variant", "is-reduce", "is-trait", "is-dither", "is-surprise", "is-load");
    void studioEl.offsetWidth;
    studioEl.classList.add("is-signaling", `is-${mode}`);
    els.topbarStatus.classList.remove("is-hot");
    void els.topbarStatus.offsetWidth;
    els.topbarStatus.classList.add("is-hot");

    clearTimeout(signalTimer);
    clearTimeout(statusHotTimer);
    signalTimer = setTimeout(() => {
      studioEl.classList.remove("is-signaling", "is-variant", "is-reduce", "is-trait", "is-dither", "is-surprise", "is-load");
    }, 620);
    statusHotTimer = setTimeout(() => {
      els.topbarStatus.classList.remove("is-hot");
    }, 520);
  }

  function rememberSessionSignature(signature) {
    if (!signature || state.sessionSignatures.has(signature)) return;
    state.sessionSignatures.add(signature);
    state.sessionSignatureOrder.push(signature);
    while (state.sessionSignatureOrder.length > 2048) {
      const old = state.sessionSignatureOrder.shift();
      if (old) state.sessionSignatures.delete(old);
    }
  }

  function rememberOutputSignature(signature) {
    if (!signature || state.outputSignatures.has(signature)) return false;
    state.outputSignatures.add(signature);
    state.outputSignatureOrder.push(signature);
    while (state.outputSignatureOrder.length > 512) {
      const old = state.outputSignatureOrder.shift();
      if (old) state.outputSignatures.delete(old);
    }
    return true;
  }

  function makeCanvasOutputSignature() {
    const imageData = canvas.exportImageData();
    const data = imageData.data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      hash ^= data[i];
      hash = Math.imul(hash, 16777619);
      hash ^= data[i + 1];
      hash = Math.imul(hash, 16777619);
      hash ^= data[i + 2];
      hash = Math.imul(hash, 16777619);
    }
    return [
      hash >>> 0,
      state.activePresetTab,
      state.lastReductionMode,
      state.useActiveBg ? 1 : 0,
      state.noMinimalDeltaMode,
      state.globalModifiers.toneCount,
      state.globalModifiers.contrast,
      state.globalModifiers.traitFocus,
      state.globalModifiers.paletteDrift,
      state.isSheetMode ? state.popSheetLayout : "1x1",
      JSON.stringify(state.familyModifiers[state.activePresetTab] || {}),
      canvas.getCurrentPalette().join(","),
    ].join(":");
  }

  function cloneCompositionStateLocal(compositionState) {
    return {
      globalRolePair: {
        ...(compositionState?.globalRolePair || {}),
      },
      roleGrid: Array.isArray(compositionState?.roleGrid) ? compositionState.roleGrid.slice() : [],
      contentGrid: Array.isArray(compositionState?.contentGrid) ? compositionState.contentGrid.slice() : [],
      noiseMask: Array.isArray(compositionState?.noiseMask) ? compositionState.noiseMask.slice() : [],
      noiseRoleTargets: compositionState?.noiseRoleTargets ? { ...compositionState.noiseRoleTargets } : {},
    };
  }

  function hashImageDataSignature(imageData) {
    const data = imageData?.data || [];
    let hash = 2166136261;
    for (let index = 0; index < data.length; index += 4) {
      hash ^= data[index];
      hash = Math.imul(hash, 16777619);
      hash ^= data[index + 1];
      hash = Math.imul(hash, 16777619);
      hash ^= data[index + 2];
      hash = Math.imul(hash, 16777619);
      hash ^= data[index + 3];
      hash = Math.imul(hash, 16777619);
    }
    return String(hash >>> 0);
  }

  function captureSingleCompositionSnapshot({ force = false } = {}) {
    if (!state.selected) return null;
    if (!force && canvas.hasSheet()) {
      return state.lastSingleCompositionSnapshot;
    }
    const compositionState = canvas.exportCompositionState();
    const imageData = canvas.exportCompositionImageData();
    const rolePair = canvas.getGlobalRolePair();
    const palette = normalizeHexPalette(canvas.getCompositionPalette());
    const classified = currentCreativeClassification().map((entry) => ({ ...entry }));
    const baseCanvasOutputSignature = [
      hashImageDataSignature(imageData),
      rolePair.background,
      rolePair.outline,
      makePaletteSignature(palette),
      state.startMode,
    ].join(":");
    state.lastSingleCompositionSnapshot = {
      tokenId: Number(state.selected?.id) || 0,
      compositionState: cloneCompositionStateLocal(compositionState),
      imageData: cloneImageDataLocal(imageData),
      rolePair: {
        background: rolePair.background,
        outline: rolePair.outline,
      },
      palette,
      classified,
      baseCanvasOutputSignature,
    };
    state.presentationMode = "single";
    return state.lastSingleCompositionSnapshot;
  }

  function activeSingleCompositionSnapshot() {
    return state.lastSingleCompositionSnapshot || captureSingleCompositionSnapshot({ force: true });
  }

  function gridSeriesHistoryKey(snapshot, family, layoutId) {
    return [
      String(snapshot?.baseCanvasOutputSignature || "none"),
      String(family || activeCreativeFamily()),
      String(layoutId || state.popSheetLayout || "4x4"),
    ].join(":");
  }

  function recentGridSeriesHistoryForKey(key) {
    return Array.isArray(state.recentGridSeriesHistory.get(key))
      ? state.recentGridSeriesHistory.get(key)
      : [];
  }

  function buildGridSeriesRecord({ family, layoutId, panelResults, snapshot }) {
    const orderedPanelSignatures = panelResults.map((entry) => (
      panelVisualSignature(entry.variant, { style: `grid-${family}`, layout: layoutId })
    ));
    const orderedRolePairSignatures = panelResults.map((entry) => panelRolePairSignature(entry.variant));
    const orderedBackgroundHexes = panelResults.map((entry) => String(entry?.variant?.roles?.background || "").toUpperCase());
    return {
      family,
      layoutId,
      baseCanvasOutputSignature: String(snapshot?.baseCanvasOutputSignature || ""),
      orderedPanelSignatures,
      orderedRolePairSignatures,
      orderedBackgroundHexes,
      fullSeriesSignature: [
        String(snapshot?.baseCanvasOutputSignature || ""),
        String(family || ""),
        String(layoutId || ""),
        orderedPanelSignatures.join("||"),
        orderedRolePairSignatures.join("||"),
        orderedBackgroundHexes.join("||"),
      ].join("::"),
    };
  }

  function gridSeriesOverlapCount(candidate, prior) {
    const candidatePanels = Array.isArray(candidate?.orderedPanelSignatures) ? candidate.orderedPanelSignatures : [];
    const priorPanels = new Set(Array.isArray(prior?.orderedPanelSignatures) ? prior.orderedPanelSignatures : []);
    let overlap = 0;
    for (const value of candidatePanels) {
      if (priorPanels.has(value)) overlap += 1;
    }
    return overlap;
  }

  function isGridSeriesNovel(candidateRecord, history) {
    if (!candidateRecord?.fullSeriesSignature) return false;
    const panelCount = Math.max(1, candidateRecord.orderedPanelSignatures.length);
    for (const entry of history) {
      if (!entry) continue;
      if (entry.fullSeriesSignature === candidateRecord.fullSeriesSignature) {
        return false;
      }
      const overlap = gridSeriesOverlapCount(candidateRecord, entry);
      const sameRolePairs = (
        Array.isArray(entry.orderedRolePairSignatures)
        && entry.orderedRolePairSignatures.join("||") === candidateRecord.orderedRolePairSignatures.join("||")
      );
      if (sameRolePairs && overlap >= Math.max(2, panelCount - 1)) {
        return false;
      }
    }
    return true;
  }

  function scoreGridSeriesCandidate(candidateRecord, history) {
    if (!isGridSeriesNovel(candidateRecord, history)) return Number.NEGATIVE_INFINITY;
    const uniquePanels = new Set(candidateRecord.orderedPanelSignatures.filter(Boolean)).size;
    const uniquePairs = new Set(candidateRecord.orderedRolePairSignatures.filter(Boolean)).size;
    const uniqueBackgrounds = new Set(candidateRecord.orderedBackgroundHexes.filter(Boolean)).size;
    let minBackgroundDistance = 0.42;
    let maxOverlapRatio = 0;
    for (const prior of history) {
      if (!prior) continue;
      const overlap = gridSeriesOverlapCount(candidateRecord, prior);
      maxOverlapRatio = Math.max(maxOverlapRatio, overlap / Math.max(1, candidateRecord.orderedPanelSignatures.length));
      for (const backgroundHex of candidateRecord.orderedBackgroundHexes) {
        for (const priorBackground of prior.orderedBackgroundHexes || []) {
          if (!/^#[0-9A-F]{6}$/.test(backgroundHex) || !/^#[0-9A-F]{6}$/.test(priorBackground)) continue;
          minBackgroundDistance = Math.min(minBackgroundDistance, oklabDistance(backgroundHex, priorBackground));
        }
      }
    }
    return (
      (uniquePanels * 18)
      + (uniquePairs * 12)
      + (uniqueBackgrounds * 9)
      + (minBackgroundDistance * 180)
      + ((1 - maxOverlapRatio) * 48)
    );
  }

  function rememberRecentGridSeries(historyKey, record) {
    const current = recentGridSeriesHistoryForKey(historyKey).filter((entry) => entry?.fullSeriesSignature !== record?.fullSeriesSignature);
    current.unshift(record);
    if (current.length > 32) current.length = 32;
    state.recentGridSeriesHistory.set(historyKey, current);
  }

  function makeVariantSessionSignature(family, preset) {
    if (!preset) return null;
    const parts = [
      family,
      Math.round(Number(preset.baseHue || 0) * 10),
      Math.round(Number((preset.bgLightness ?? preset.baseLightness ?? 0) * 1000)),
      Math.round(Number((preset.bgSaturation ?? preset.baseSaturation ?? 0) * 1000)),
      Math.round(Number((preset.colorSaturation ?? preset.accentSaturationLift ?? 0) * 1000)),
      Math.round(Number((preset.hueSwing ?? preset.accentHueShift ?? 0) * 100)),
      Math.round(Number((preset.hueDrift ?? preset.bodyPulse ?? 0) * 100)),
      Math.round(Number((preset.curve || 0) * 1000)),
      Math.round(Number((preset.contrast || 0) * 1000)),
      Math.round(Number((preset.phase ?? preset.huePhase ?? preset.driftPhase ?? 0) * 1000)),
      Math.round(Number((preset.variantPhase ?? 0) * 1000)),
      Math.round(Number((preset.depthLayers ?? 0) * 100)),
      Math.round(Number((preset.chiaroscuro ?? 0) * 1000)),
      Math.round(Number((preset.voidBias ?? 0) * 1000)),
      String(preset.noirScheme || ""),
      Math.round(Number((preset.noirPhase ?? 0) * 1000)),
      String(preset.harmony || ""),
      state.globalModifiers.toneCount,
      state.globalModifiers.contrast,
      state.globalModifiers.traitFocus,
      state.globalModifiers.paletteDrift,
    ];
    return parts.join(":");
  }

  function createUniqueVariant(family, sourcePalette) {
    const userAnchorHex = selectedActiveHex();
    const excludeActiveHex = family !== "warhol";
    let fallback = null;
    for (let i = 0; i < 96; i += 1) {
      const basePreset = createRandomPreset(family, {
        activeHex: userAnchorHex,
        sourcePalette,
        excludeActiveHex,
      });
      const preset = basePreset;
      if (!fallback) fallback = preset;
      const signature = makeVariantSessionSignature(family, preset);
      if (!state.sessionSignatures.has(signature)) {
        rememberSessionSignature(signature);
        return preset;
      }
    }
    if (fallback) {
      rememberSessionSignature(makeVariantSessionSignature(family, fallback));
    }
    return fallback;
  }

  function setActivePresetTab(tabId) {
    state.activePresetTab = tabId;
    state.noFieldLastFamily = tabId;
    state.isSheetMode = false;
    canvas.setSubdivision(1);
    root.querySelectorAll(".preset-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.presetTab === tabId));
    renderPresetList();
    const label = FAMILY_LABELS[tabId] || "Studio";
    const kicker = root.querySelector("[data-role=\"deck-family-kicker\"]");
    if (kicker) kicker.textContent = label;
    setTopbarStatus(`${label} armed · live canvas launchpad`);
    persistSession();
  }

  // ── Color controls ────────────────────────────────────────────

  function setActiveColorFromHex(hex) {
    const normalizedHex = String(hex || "").trim().toUpperCase();
    const rgb = hexToRgb(normalizedHex);
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    state.activeColor = { h: Math.round(hsl.h), s: Math.round(hsl.s * 100), l: Math.round(hsl.l * 100) };
    state.activeColorHex = normalizedHex;
    syncColorUI();
    renderHeroRolePair();
    canvas.setActiveColorHex(normalizedHex);
    updatePaletteGrid();
  }

  function onColorSliderInput() {
    state.activeColor.h = Number(els.hueSlider.value);
    state.activeColor.s = Number(els.satSlider.value);
    state.activeColor.l = Number(els.litSlider.value);
    const rgb = hslToRgb(state.activeColor.h, state.activeColor.s / 100, state.activeColor.l / 100);
    state.activeColorHex = rgbToHex(rgb.r, rgb.g, rgb.b);
    syncColorUI();
    renderHeroRolePair();
    canvas.setActiveColor(rgb.r, rgb.g, rgb.b);
  }

  function syncColorUI() {
    const fallbackRgb = hslToRgb(state.activeColor.h, state.activeColor.s / 100, state.activeColor.l / 100);
    const hex = /^#[0-9A-F]{6}$/.test(String(state.activeColorHex || "").toUpperCase())
      ? String(state.activeColorHex).toUpperCase()
      : rgbToHex(fallbackRgb.r, fallbackRgb.g, fallbackRgb.b);
    state.activeColorHex = hex;
    els.hueSlider.value = state.activeColor.h;
    els.satSlider.value = state.activeColor.s;
    els.litSlider.value = state.activeColor.l;
    els.hueValue.textContent = state.activeColor.h;
    els.satValue.textContent = `${state.activeColor.s}%`;
    els.litValue.textContent = `${state.activeColor.l}%`;
    els.colorPreview.style.background = hex;
    els.colorHex.value = hex;
    if (els.stageColorPreview) els.stageColorPreview.style.background = hex;
    if (els.stageColorInput) els.stageColorInput.value = hex.toLowerCase();
    if (els.stageColorHex) els.stageColorHex.value = hex;
  }

  els.hueSlider.addEventListener("input", onColorSliderInput);
  els.satSlider.addEventListener("input", onColorSliderInput);
  els.litSlider.addEventListener("input", onColorSliderInput);
  els.colorHex.addEventListener("change", () => {
    let hex = els.colorHex.value.trim();
    if (!hex.startsWith("#")) hex = "#" + hex;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) setActiveColorFromHex(hex);
  });
  els.stageColorInput?.addEventListener("input", () => {
    setActiveColorFromHex(els.stageColorInput.value);
    persistSession();
  });
  els.stageColorHex?.addEventListener("change", () => {
    let hex = els.stageColorHex.value.trim();
    if (!hex.startsWith("#")) hex = `#${hex}`;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      setActiveColorFromHex(hex);
      persistSession();
    }
  });

  syncColorUI();
  canvas.setActiveColorHex(state.activeColorHex);
  applySingleFrameState();
  setPaintMode(state.paintMode, { quiet: true });

  function clampPercent(value) {
    return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  }

  function syncGlobalModifierUI() {
    state.globalModifiers.toneCount = Math.max(2, Math.min(8, Math.round(Number(state.globalModifiers.toneCount) || 5)));
    state.globalModifiers.contrast = clampPercent(state.globalModifiers.contrast);
    state.globalModifiers.traitFocus = clampPercent(state.globalModifiers.traitFocus);
    state.globalModifiers.paletteDrift = clampPercent(state.globalModifiers.paletteDrift);
    state.globalModifiers.grainAmount = clampPercent(state.globalModifiers.grainAmount);
    state.noiseAmount = state.globalModifiers.grainAmount;

    if (els.globalToneCount) els.globalToneCount.value = String(state.globalModifiers.toneCount);
    if (els.globalToneCountValue) els.globalToneCountValue.textContent = String(state.globalModifiers.toneCount);
    if (els.globalContrast) els.globalContrast.value = String(state.globalModifiers.contrast);
    if (els.globalContrastValue) els.globalContrastValue.textContent = `${state.globalModifiers.contrast}%`;
    if (els.globalTraitFocus) els.globalTraitFocus.value = String(state.globalModifiers.traitFocus);
    if (els.globalTraitFocusValue) els.globalTraitFocusValue.textContent = `${state.globalModifiers.traitFocus}%`;
    if (els.globalPaletteDrift) els.globalPaletteDrift.value = String(state.globalModifiers.paletteDrift);
    if (els.globalPaletteDriftValue) els.globalPaletteDriftValue.textContent = `${state.globalModifiers.paletteDrift}%`;
    if (els.wildnessSlider) els.wildnessSlider.value = String(state.globalModifiers.paletteDrift);
    if (els.wildnessValue) els.wildnessValue.textContent = `${state.globalModifiers.paletteDrift}%`;
    if (els.noiseAmount) els.noiseAmount.value = String(state.globalModifiers.grainAmount);
    if (els.noiseAmountValue) els.noiseAmountValue.textContent = `${state.globalModifiers.grainAmount}%`;
  }

  function currentFamilyModifiers() {
    return state.familyModifiers[state.activePresetTab] || {};
  }

  function renderFamilyModifierPanel() {
    if (!els.familyModifiersPanel) return;
    const family = state.activePresetTab;
    const values = currentFamilyModifiers();
    const blocks = {
      mono: [
        { key: "hueDrift", label: "Hue Drift", min: 0, max: 20, unit: "°", help: "Controls monochrome hue wandering." },
        { key: "stepCompression", label: "Step Compression", min: 0, max: 100, unit: "%", help: "Quantizes tonal ladder for harder mono bands." },
      ],
      chrome: [
        { key: "shimmer", label: "Shimmer", min: 0, max: 100, unit: "%", help: "Pushes brighter metallic lift through the palette." },
        { key: "polish", label: "Polish", min: 0, max: 100, unit: "%", help: "Sharpens cool-body contrast against candy glints." },
      ],
      warhol: [
        { key: "flatness", label: "Flatness", min: 0, max: 100, unit: "%", help: "Flattens light bands for graphic panel impact." },
        { key: "panelDivergence", label: "Panel Divergence", min: 0, max: 100, unit: "%", help: "Separates pop sheet panels with stronger palette splits." },
      ],
      acid: [
        { key: "clashAngle", label: "Clash Angle", min: 0, max: 180, unit: "°", help: "Controls hue conflict angle for acid tension." },
        { key: "corrosion", label: "Corrosion", min: 0, max: 100, unit: "%", help: "Adds synthetic separation and harsh local contrast." },
      ],
      pastel: [
        { key: "powderSoftness", label: "Powder Softness", min: 0, max: 100, unit: "%", help: "Softens saturation and edge contrast." },
        { key: "airLift", label: "Air Lift", min: 0, max: 100, unit: "%", help: "Raises lightness for airy pastel atmosphere." },
      ],
    }[family] || [];

    els.familyModifiersPanel.innerHTML = blocks.map((item) => {
      const value = Number(values[item.key] ?? item.min);
      return `
        <label class="no-field-meter">
          <span class="no-field-meter-label">${escapeHtml(item.label)}</span>
          <input type="range" class="color-slider" data-action="set-family-modifier" data-key="${escapeHtml(item.key)}" min="${item.min}" max="${item.max}" value="${value}" />
          <span class="color-slider-value">${value}${escapeHtml(item.unit)}</span>
          <span class="no-field-meter-hint">${escapeHtml(item.help)}</span>
        </label>
      `;
    }).join("");
  }

  if (els.globalToneCount) {
    els.globalToneCount.addEventListener("input", () => {
      state.globalModifiers.toneCount = Math.max(2, Math.min(8, Math.round(Number(els.globalToneCount.value) || 5)));
      syncGlobalModifierUI();
      invalidateVariantRailState();
      scheduleVariantPanelRender();
    });
  }
  if (els.globalContrast) {
    els.globalContrast.addEventListener("input", () => {
      state.globalModifiers.contrast = clampPercent(els.globalContrast.value);
      syncGlobalModifierUI();
      invalidateVariantRailState();
      scheduleVariantPanelRender();
    });
  }
  if (els.globalTraitFocus) {
    els.globalTraitFocus.addEventListener("input", () => {
      state.globalModifiers.traitFocus = clampPercent(els.globalTraitFocus.value);
      syncGlobalModifierUI();
      invalidateVariantRailState();
      scheduleVariantPanelRender();
    });
  }
  if (els.globalPaletteDrift) {
    els.globalPaletteDrift.addEventListener("input", () => {
      state.globalModifiers.paletteDrift = clampPercent(els.globalPaletteDrift.value);
      syncGlobalModifierUI();
      invalidateVariantRailState();
      scheduleVariantPanelRender();
    });
  }
  if (els.wildnessSlider) {
    els.wildnessSlider.addEventListener("input", () => {
      state.globalModifiers.paletteDrift = clampPercent(els.wildnessSlider.value);
      syncGlobalModifierUI();
      invalidateVariantRailState();
      scheduleVariantPanelRender();
      persistSession();
    });
  }

  syncGlobalModifierUI();

  function syncActiveBgToggle() {
    if (!els.activeBgToggle) return;
    els.activeBgToggle.classList.toggle("is-active", state.useActiveBg);
    els.activeBgToggle.textContent = `Use Active Color As Background · ${state.useActiveBg ? "On" : "Off"}`;
  }

  function renderHeroRolePair() {
    if (!els.heroRolePair) return;
    const livePair = state.selected ? canvas.getGlobalRolePair() : null;
    const pair = livePair
      ? { background: livePair.background, figure: livePair.outline }
      : ensureNoMinimalPreviewPair();
    els.heroRolePair.textContent = `BG ${pair.background} → FG ${pair.figure} · global +4 rule`;
  }

  function renderNoMinimalModeRail() {
    if (!els.noMinimalModeRail) return;
    els.noMinimalModeRail.querySelectorAll("[data-minimal-mode]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.minimalMode === state.noMinimalDeltaMode);
    });
  }

  function renderPaintModeRails() {
    const createMode = state.paintMode !== "role";
    const modeRails = [els.paintModeRail, els.stagePaintModeRail].filter(Boolean);
    modeRails.forEach((rail) => {
      rail.querySelectorAll("[data-paint-mode]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.paintMode === state.paintMode);
      });
    });

    const targetRails = [els.paintTargetRail, els.stageRoleTargetRail].filter(Boolean);
    targetRails.forEach((rail) => {
      rail.hidden = createMode;
      rail.querySelectorAll("[data-paint-target]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.paintTarget === state.activePaintTarget);
      });
    });
  }

  function currentSingleFrameStyle() {
    return GRID_FRAME_TONES[state.singleFrameTone] || GRID_FRAME_TONES.black;
  }

  function syncSingleFrameUi() {
    if (els.singleFrameRail) {
      els.singleFrameRail.querySelectorAll("[data-single-frame]").forEach((btn) => {
        const isOn = btn.dataset.singleFrame === "on";
        btn.classList.toggle("is-active", state.singleFrameEnabled === isOn);
      });
    }
    if (els.singleFrameToneRail) {
      els.singleFrameToneRail.querySelectorAll("[data-single-frame-tone]").forEach((btn) => {
        const isActive = btn.dataset.singleFrameTone === state.singleFrameTone;
        btn.classList.toggle("is-active", isActive);
        btn.disabled = !state.singleFrameEnabled;
      });
    }
  }

  function applySingleFrameState() {
    canvas.setSingleFrame({
      enabled: state.singleFrameEnabled && !state.isSheetMode,
      style: currentSingleFrameStyle(),
    });
  }

  function setPaintMode(mode = "create", { quiet = false } = {}) {
    const nextMode = mode === "role" ? "role" : "create";
    state.paintMode = nextMode;
    if (nextMode === "create") {
      state.activePaintTarget = "content";
    } else if (!["background", "outline", "erase"].includes(state.activePaintTarget)) {
      state.activePaintTarget = state.lastRolePaintTarget || "background";
    }
    if (["background", "outline", "erase"].includes(state.activePaintTarget)) {
      state.lastRolePaintTarget = state.activePaintTarget;
    }
    canvas.setPaintTarget(state.activePaintTarget);
    renderPaintModeRails();
    renderHeroRolePair();
    if (!quiet) {
      setTopbarStatus(nextMode === "create" ? "Create mode · brush and fill paint content" : `Role mode · ${state.activePaintTarget}`);
      persistSession();
    }
  }

  function renderPaintTargetRail() {
    const rails = [els.paintTargetRail, els.stageRoleTargetRail].filter(Boolean);
    rails.forEach((rail) => {
      rail.querySelectorAll("[data-paint-target]").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.paintTarget === state.activePaintTarget);
      });
    });
  }

  function renderNoiseTargetRail() {
    if (!els.noiseTargetRail) return;
    const targets = canvas.getNoiseRoleTargets();
    els.noiseTargetRail.querySelectorAll("[data-noise-target]").forEach((btn) => {
      const key = btn.dataset.noiseTarget || "";
      btn.classList.toggle("is-active", Boolean(targets[key]));
    });
  }

  function syncMaskUi() {
    if (els.showMask) {
      els.showMask.classList.toggle("is-active", state.showNoiseMask);
      els.showMask.textContent = `Show Mask · ${state.showNoiseMask ? "On" : "Off"}`;
    }
    if (els.sourceOverlayToggle) {
      els.sourceOverlayToggle.classList.toggle("is-active", state.sourceOverlayVisible);
      els.sourceOverlayToggle.textContent = `Show Source Overlay · ${state.sourceOverlayVisible ? "On" : "Off"}`;
    }
  }

  function renderStartModeRail() {
    if (!els.startModeRail) return;
    if (!START_MODE_IDS.includes(state.startMode)) {
      state.startMode = "full";
    }
    els.startModeRail.querySelectorAll("[data-start-mode]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.startMode === state.startMode);
    });
  }

  els.activeBgToggle?.addEventListener("click", () => {
    state.useActiveBg = !state.useActiveBg;
    syncActiveBgToggle();
    invalidateVariantRailState();
    setTopbarStatus(state.useActiveBg ? "All families use active color as background anchor" : "Families use family-picked background anchors");
  });

  syncActiveBgToggle();
  renderHeroRolePair();
  renderNoMinimalModeRail();
  renderPaintModeRails();
  renderNoiseTargetRail();
  renderStartModeRail();
  syncSingleFrameUi();
  syncMaskUi();

  els.noMinimalModeRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-minimal-mode]");
    if (!button) return;
    state.noMinimalDeltaMode = button.dataset.minimalMode || "exact";
    refreshNoMinimalPreviewPair();
    renderNoMinimalModeRail();
    renderHeroRolePair();
    invalidateVariantRailState();
    renderPresetList();
    setTopbarStatus(`No-Minimalism ${state.noMinimalDeltaMode} twin · world armed`);
  });

  const paintModeHandler = (event) => {
    const button = event.target.closest("[data-paint-mode]");
    if (!button) return;
    setPaintMode(button.dataset.paintMode || "create");
  };

  els.paintModeRail?.addEventListener("click", paintModeHandler);
  els.stagePaintModeRail?.addEventListener("click", paintModeHandler);

  els.paintTargetRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-paint-target]");
    if (!button) return;
    state.activePaintTarget = button.dataset.paintTarget || "background";
    state.lastRolePaintTarget = state.activePaintTarget;
    canvas.setPaintTarget(state.activePaintTarget);
    renderPaintModeRails();
    renderHeroRolePair();
    setTopbarStatus(`Paint target ${state.activePaintTarget}`);
    persistSession();
  });

  els.stageRoleTargetRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-paint-target]");
    if (!button) return;
    state.activePaintTarget = button.dataset.paintTarget || "background";
    state.lastRolePaintTarget = state.activePaintTarget;
    canvas.setPaintTarget(state.activePaintTarget);
    renderPaintModeRails();
    renderHeroRolePair();
    setTopbarStatus(`Paint target ${state.activePaintTarget}`);
    persistSession();
  });

  els.singleFrameRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-single-frame]");
    if (!button) return;
    state.singleFrameEnabled = button.dataset.singleFrame === "on";
    syncSingleFrameUi();
    applySingleFrameState();
    setTopbarStatus(state.singleFrameEnabled ? `Single frame ${currentSingleFrameStyle().label || "armed"}` : "Single frame off");
    persistSession();
  });

  els.singleFrameToneRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-single-frame-tone]");
    if (!button) return;
    const nextTone = button.dataset.singleFrameTone || "black";
    state.singleFrameTone = GRID_FRAME_TONES[nextTone] ? nextTone : "black";
    syncSingleFrameUi();
    applySingleFrameState();
    setTopbarStatus(`Single frame ${GRID_FRAME_TONES[state.singleFrameTone].label} armed`);
    persistSession();
  });

  els.openDockColors?.addEventListener("click", () => {
    setSidebarOpen(true);
    els.colorSection?.scrollIntoView({ block: "start", behavior: "smooth" });
  });

  function applyStartMode(mode = state.startMode, { quiet = false } = {}) {
    if (!state.selected) return false;
    const nextMode = START_MODE_IDS.includes(mode) ? mode : "full";
    state.startMode = nextMode;
    if (nextMode === "blank") {
      state.sourceOverlayVisible = false;
      canvas.setSourceOverlayVisible(false);
      syncMaskUi();
    }
    renderStartModeRail();
    let changed = false;
    if (nextMode === "full") {
      canvas.reset();
      changed = true;
    } else if (nextMode === "blank") {
      changed = canvas.startBlankCanvas();
    }
    updatePaletteGrid();
    renderHeroRolePair();
    if (!quiet) {
      setTopbarStatus(nextMode === "full"
        ? "Full source start restored"
        : "Blank 24x24 start armed");
    }
    persistSession();
    return changed;
  }

  els.startModeRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-start-mode]");
    if (!button) return;
    applyStartMode(button.dataset.startMode || "full");
  });

  els.openDockColors?.addEventListener("click", () => {
    setSidebarOpen(true);
    setTopbarStatus("Studio deck opened");
  });

  els.noiseTargetRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-noise-target]");
    if (!button) return;
    const key = button.dataset.noiseTarget || "";
    if (!["background", "outline", "content"].includes(key)) return;
    const currentTargets = canvas.getNoiseRoleTargets();
    const nextTargets = {
      ...currentTargets,
      [key]: !currentTargets[key],
    };
    canvas.setNoiseRoleTargets(nextTargets);
    renderNoiseTargetRail();
    setTopbarStatus(nextTargets[key] ? `Role grain armed for ${key}` : `Role grain cleared for ${key}`);
    persistSession();
  });

  els.clearRoleGrain?.addEventListener("click", () => {
    canvas.setNoiseRoleTargets({
      background: false,
      outline: false,
      content: false,
    });
    renderNoiseTargetRail();
    setTopbarStatus("Role grain cleared");
    persistSession();
  });

  els.noiseAmount?.addEventListener("input", () => {
    state.noiseAmount = Math.max(0, Math.min(100, Number(els.noiseAmount.value) || 0));
    state.globalModifiers.grainAmount = state.noiseAmount;
    if (els.noiseAmountValue) {
      els.noiseAmountValue.textContent = `${state.noiseAmount}%`;
    }
  });

  if (els.noiseAmountValue) {
    els.noiseAmountValue.textContent = `${state.noiseAmount}%`;
  }

  els.showMask?.addEventListener("click", () => {
    state.showNoiseMask = !state.showNoiseMask;
    canvas.setShowNoiseMask(state.showNoiseMask);
    syncMaskUi();
    setTopbarStatus(state.showNoiseMask ? "Noise mask overlay enabled" : "Noise mask overlay hidden");
    persistSession();
  });

  els.clearMask?.addEventListener("click", () => {
    const changed = canvas.clearNoiseMask();
    if (!changed) {
      setTopbarStatus("Manual noise mask already clear");
      return;
    }
    setTopbarStatus("Manual noise mask cleared");
  });

  els.sourceOverlayToggle?.addEventListener("click", () => {
    state.sourceOverlayVisible = !state.sourceOverlayVisible;
    canvas.setSourceOverlayVisible(state.sourceOverlayVisible);
    syncMaskUi();
    setTopbarStatus(state.sourceOverlayVisible ? "Source overlay enabled" : "Source overlay hidden");
    persistSession();
  });

  // ── Palette grid ──────────────────────────────────────────────

  function currentCreativeClassification() {
    if (!state.selected) return [];
    const pair = canvas.getGlobalRolePair();
    const palette = normalizeHexPalette(canvas.getCompositionPalette());
    const nonRole = palette
      .filter((hex) => hex !== pair.background && hex !== pair.outline)
      .sort((a, b) => hexLuma(a) - hexLuma(b));
    const classified = [
      { hex: pair.background, role: "background" },
      { hex: pair.outline, role: "outline" },
    ];
    if (!nonRole.length) return classified;
    for (let index = 0; index < nonRole.length; index += 1) {
      const ratio = nonRole.length === 1 ? 0 : index / Math.max(1, nonRole.length - 1);
      const role = ratio >= 0.66 ? "accent" : ratio >= 0.33 ? "neutral" : "body";
      classified.push({ hex: nonRole[index], role });
    }
    return classified;
  }

  function syncPinnedPaletteMap() {
    state.curatedPaletteMap = Object.fromEntries(
      (state.palettePins || []).map((hex) => [String(hex).toUpperCase(), String(hex).toUpperCase()]),
    );
  }

  function sourceRoleForHex(hex) {
    const key = String(hex || "").trim().toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(key)) return "body";
    const current = currentCreativeClassification().find((entry) => String(entry?.hex || "").toUpperCase() === key);
    return current?.role || state.sourceRoleByHex.get(key) || "body";
  }

  function renderPaletteCurationReadout() {
    if (!els.paletteCurationReadout) return;
    const selected = String(state.activeColorHex || "").toUpperCase();
    const pins = (state.palettePins || []).slice(0, 2);
    if (!/^#[0-9A-F]{6}$/.test(selected)) {
      els.paletteCurationReadout.textContent = pins.length
        ? `Pinned · ${pins.join(" · ")}`
        : "Tap a swatch to pick it up as your active color. Pin up to 2 colors.";
      return;
    }
    els.paletteCurationReadout.textContent = pins.length
      ? `Active ${selected} · Pinned ${pins.join(" · ")}`
      : `Active color · ${selected}`;
  }

  function updatePaletteGrid() {
    const colors = normalizeHexPalette(canvas.getCompositionPalette());
    const activeHex = selectedActiveHex();
    els.paletteGrid.innerHTML = colors.map((hex) => {
      const sourceHex = String(hex || "").toUpperCase();
      const role = sourceRoleForHex(sourceHex);
      const isActive = sourceHex === activeHex;
       const isPinned = (state.palettePins || []).includes(sourceHex);
      const classes = [
        "palette-swatch",
        isActive ? "is-active" : "",
        isPinned ? "is-pinned" : "",
      ].filter(Boolean).join(" ");
      const style = `background:${escapeHtml(sourceHex)};`;
      const title = `${sourceHex} (${role})${isPinned ? " · pinned" : ""}`;
      return `<button class="${classes}" data-hex="${escapeHtml(sourceHex)}" style="${style}" title="${escapeHtml(title)}"></button>`;
    }).join("") || '<span style="font-size:11px;color:var(--text-dim)">Select a punk</span>';
    renderPaletteCurationReadout();
  }

  els.paletteGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-hex]");
    if (!btn) return;
    const pickedHex = String(btn.dataset.hex || "").toUpperCase();
    setActiveColorFromHex(pickedHex);
    setTopbarStatus(`Active color ${pickedHex} armed`);
    updatePaletteGrid();
    persistSession();
  });

  function pinActiveColor() {
    const hex = selectedActiveHex();
    if (!/^#[0-9A-F]{6}$/.test(hex)) return;
    const next = (state.palettePins || []).filter((value) => value !== hex);
    next.unshift(hex);
    state.palettePins = next.slice(0, 2);
    syncPinnedPaletteMap();
    invalidateVariantRailState();
    updatePaletteGrid();
    setTopbarStatus(`Pinned ${hex}`);
    persistSession();
  }

  function clearPalettePins() {
    if (!state.palettePins.length) return;
    state.palettePins = [];
    syncPinnedPaletteMap();
    invalidateVariantRailState();
    updatePaletteGrid();
    setTopbarStatus("Palette pins cleared");
    persistSession();
  }

  els.pinActiveColor?.addEventListener("click", pinActiveColor);
  els.clearPalettePins?.addEventListener("click", clearPalettePins);

  function mapActiveColorToSelectedSource() {
    const sourceHex = String(state.curationSourceHex || "").toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(sourceHex)) {
      setTopbarStatus("Select a source palette swatch first");
      return;
    }
    const role = sourceRoleForHex(sourceHex);
    if (role === "background" || role === "outline") {
      setTopbarStatus("Role pair is locked. Map non-role colors only.");
      return;
    }
    const targetHex = selectedActiveHex();
    state.curatedPaletteMap[sourceHex] = targetHex;
    invalidateVariantRailState();
    updatePaletteGrid();
    setTopbarStatus(`Mapped ${sourceHex} → ${targetHex}`);
    persistSession();
  }

  function clearSelectedPaletteMapping() {
    const sourceHex = String(state.curationSourceHex || "").toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(sourceHex)) {
      setTopbarStatus("Select a source palette swatch first");
      return;
    }
    delete state.curatedPaletteMap[sourceHex];
    invalidateVariantRailState();
    updatePaletteGrid();
    setTopbarStatus(`Cleared mapping for ${sourceHex}`);
    persistSession();
  }

  function resetPaletteCuration() {
    state.curatedPaletteMap = {};
    state.curationSourceHex = null;
    invalidateVariantRailState();
    updatePaletteGrid();
    setTopbarStatus("Curated palette reset");
    persistSession();
  }

  function applyCuratedPaletteCast() {
    if (!state.selected) {
      setServerStatus("Select a NoPunk first.");
      return;
    }
    const family = activeCreativeFamily();
    const currentRail = railStateForFamily(family);
    const variant = state.variantByFamily[family]
      || loadVariantFromRail(
        family,
        Number(currentRail.pageIndex) || 0,
        currentRail.slotIndex >= 0 ? currentRail.slotIndex : 0,
        { statusPrefix: "Curated Cast" },
      );
    if (!variant) return;
    const nextMapping = { ...(variant.mapping || {}) };
    const used = new Set([
      String(variant.roles?.background || "").toUpperCase(),
      String(variant.roles?.outline || "").toUpperCase(),
    ]);

    for (const [sourceHexRaw, targetHexRaw] of Object.entries(state.curatedPaletteMap || {})) {
      const sourceHex = String(sourceHexRaw || "").toUpperCase();
      const targetHex = String(targetHexRaw || "").toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(sourceHex) || !/^#[0-9A-F]{6}$/.test(targetHex)) continue;
      const role = sourceRoleForHex(sourceHex);
      if (role === "background" || role === "outline") continue;
      let safeHex = targetHex.toUpperCase();
      if (used.has(safeHex)) {
        safeHex = ensureDistinctHex(safeHex, used, { floor: -1 });
      } else {
        used.add(safeHex);
      }
      nextMapping[sourceHex] = safeHex;
    }

    const curatedVariant = {
      ...variant,
      mapping: nextMapping,
      palette: normalizeHexPalette([
        variant.roles?.background,
        variant.roles?.outline,
        ...Object.values(nextMapping || {}),
      ]),
      paletteSignature: makePaletteSignature([
        variant.roles?.background,
        variant.roles?.outline,
        ...Object.values(nextMapping || {}),
      ]),
      ui: {
        ...(variant.ui || {}),
        chips: [...new Set([...(variant.ui?.chips || []), "curated map"])].slice(0, 5),
      },
    };

    state.variantByFamily[family] = curatedVariant;
    rememberAcceptedVariant(curatedVariant);
    state.activeStudioVariant = curatedVariant;
    syncHeroPairFromRoles(curatedVariant.roles, activeRoleStep());
    canvas.applyColorMapping(nextMapping, curatedVariant.roles);
    state.noFieldLastFamily = family;
    state.lastReductionMode = "curated";
    state.activeStudioProvenance = buildGalleryProvenance({
      variant: curatedVariant,
      curatedPaletteMap: state.curatedPaletteMap,
      familyModifiers: state.familyModifiers[family] || {},
      globalModifiers: state.globalModifiers,
      outputSignature: makeCanvasOutputSignature(),
      sourcePaletteSignature: curatedVariant.sourcePaletteSignature || currentSourcePaletteSignature(),
    });
    renderHeroRolePair();
    renderVariantPanel();
    updatePaletteGrid();
    setTopbarStatus(`Curated Cast · ${FAMILY_LABELS[family] || "Studio"} · live canvas mutation`);
    pulseStudio("variant");
    persistSession();
  }

  els.curationMapActive?.addEventListener("click", mapActiveColorToSelectedSource);
  els.curationClearMapping?.addEventListener("click", clearSelectedPaletteMapping);
  els.curationResetAll?.addEventListener("click", resetPaletteCuration);
  els.curationApply?.addEventListener("click", applyCuratedPaletteCast);

  // ── Tool selection ────────────────────────────────────────────

  const toolbarEl = root.querySelector(".studio-toolbar");
  const toolButtons = Array.from(toolbarEl.querySelectorAll(".tool-btn[data-tool]"));

  function setToolReadoutFromButton(button) {
    if (!button || !els.toolReadoutLabel || !els.toolReadoutKey) return;
    const label = String(button.dataset.toolLabel || button.getAttribute("title") || button.dataset.tool || "Tool");
    const key = String(button.dataset.toolKey || "").trim() || "—";
    els.toolReadoutLabel.textContent = label;
    els.toolReadoutKey.textContent = key;
  }

  function syncToolReadout(tool = state.activeTool) {
    const button = toolbarEl.querySelector(`.tool-btn[data-tool="${tool}"]`) || toolbarEl.querySelector('.tool-btn[data-tool="pointer"]');
    setToolReadoutFromButton(button);
  }

  toolButtons.forEach((button) => {
    button.addEventListener("mouseenter", () => setToolReadoutFromButton(button));
    button.addEventListener("focus", () => setToolReadoutFromButton(button));
    button.addEventListener("mouseleave", () => syncToolReadout());
    button.addEventListener("blur", () => {
      requestAnimationFrame(() => {
        const focused = document.activeElement instanceof Element ? document.activeElement.closest(".tool-btn[data-tool]") : null;
        if (focused) {
          setToolReadoutFromButton(focused);
          return;
        }
        syncToolReadout();
      });
    });
  });

  toolbarEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tool]");
    if (!btn) return;
    const tool = btn.dataset.tool;
    if (tool === "zoom-in") {
      setToolReadoutFromButton(btn);
      canvas.zoomIn();
      updateZoomStatus();
      return;
    }
    if (tool === "zoom-out") {
      setToolReadoutFromButton(btn);
      canvas.zoomOut();
      updateZoomStatus();
      return;
    }
    toolbarEl.querySelectorAll(".tool-btn[data-tool]").forEach((b) => {
      if (!["zoom-in","zoom-out"].includes(b.dataset.tool)) b.classList.remove("is-active");
    });
    btn.classList.add("is-active");
    state.activeTool = tool;
    syncToolReadout(tool);
    canvas.setTool(tool);
  });

  function updateZoomStatus() {
    els.statusZoom.textContent = `${Math.round(canvas.zoom * 100)}%`;
  }

  root.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-preset-tab]");
    if (!tab) return;
    setActivePresetTab(tab.dataset.presetTab || "mono");
  });

  // ── Undo/Redo ─────────────────────────────────────────────────

  function updateUndoRedoButtons() {
    els.undoBtn.disabled = !canvas.canUndo;
    els.redoBtn.disabled = !canvas.canRedo;
  }
  els.undoBtn.addEventListener("click", () => { canvas.undo(); updateUndoRedoButtons(); });
  els.redoBtn.addEventListener("click", () => { canvas.redo(); updateUndoRedoButtons(); });

  // ── Keyboard shortcuts ────────────────────────────────────────

  function onKeyDown(e) {
    if (state.disposed) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    const key = e.key.toLowerCase();

    // Undo/redo
    if ((e.metaKey || e.ctrlKey) && key === "z" && e.shiftKey) { canvas.redo(); updateUndoRedoButtons(); e.preventDefault(); return; }
    if ((e.metaKey || e.ctrlKey) && key === "z") { canvas.undo(); updateUndoRedoButtons(); e.preventDefault(); return; }
    if (key === "z" && !e.metaKey && !e.ctrlKey) { canvas.undo(); updateUndoRedoButtons(); return; }
    if (key === "y") { canvas.redo(); updateUndoRedoButtons(); return; }

    // Tools
    if (key === "v") selectTool("pointer");
    if (key === "b") selectTool("paint");
    if (key === "g") selectTool("fill");
    if (key === "i") selectTool("eyedropper");
    if (key === "n") selectTool("noise-paint");
    if (key === "e") selectTool("noise-erase");
    if (key === "=" || key === "+") { canvas.zoomIn(); updateZoomStatus(); }
    if (key === "-") { canvas.zoomOut(); updateZoomStatus(); }

    // Shortcut hints
    if (key === "?" || (e.shiftKey && key === "/")) { toggleShortcutHints(); return; }
    if (key === "escape" && shortcutOverlay) { hideShortcutHints(); return; }

  }

  function selectTool(tool) {
    toolbarEl.querySelectorAll(".tool-btn[data-tool]").forEach((b) => {
      if (!["zoom-in","zoom-out"].includes(b.dataset.tool)) b.classList.remove("is-active");
    });
    const btn = toolbarEl.querySelector(`[data-tool="${tool}"]`);
    if (btn) btn.classList.add("is-active");
    state.activeTool = tool;
    syncToolReadout(tool);
    canvas.setTool(tool);
  }

  syncToolReadout();

  let shortcutOverlay = null;

  function toggleShortcutHints() {
    if (shortcutOverlay) { hideShortcutHints(); return; }
    shortcutOverlay = document.createElement("div");
    shortcutOverlay.className = "shortcut-overlay";
    shortcutOverlay.innerHTML = `
      <div class="shortcut-overlay-inner">
        <div class="shortcut-overlay-title">Keyboard Shortcuts</div>
        <div class="shortcut-grid">
          <div class="shortcut-group">
            <div class="shortcut-group-title">Tools</div>
            <div class="shortcut-row"><kbd>V</kbd><span>Pointer</span></div>
            <div class="shortcut-row"><kbd>B</kbd><span>Brush</span></div>
            <div class="shortcut-row"><kbd>G</kbd><span>Fill</span></div>
            <div class="shortcut-row"><kbd>I</kbd><span>Eyedropper</span></div>
            <div class="shortcut-row"><kbd>N</kbd><span>Noise Paint</span></div>
            <div class="shortcut-row"><kbd>E</kbd><span>Noise Erase</span></div>
          </div>
          <div class="shortcut-group">
            <div class="shortcut-group-title">Canvas</div>
            <div class="shortcut-row"><kbd>+</kbd> / <kbd>-</kbd><span>Zoom In / Out</span></div>
            <div class="shortcut-row"><kbd>Z</kbd><span>Undo</span></div>
            <div class="shortcut-row"><kbd>Y</kbd><span>Redo</span></div>
            <div class="shortcut-row"><kbd>Cmd+Z</kbd><span>Undo</span></div>
            <div class="shortcut-row"><kbd>Cmd+Shift+Z</kbd><span>Redo</span></div>
          </div>
          <div class="shortcut-group">
            <div class="shortcut-group-title">UI</div>
            <div class="shortcut-row"><kbd>?</kbd><span>Toggle this overlay</span></div>
            <div class="shortcut-row"><kbd>Esc</kbd><span>Close overlay</span></div>
          </div>
        </div>
      </div>
    `;
    shortcutOverlay.addEventListener("click", (e) => {
      if (e.target === shortcutOverlay) hideShortcutHints();
    });
    studioEl.appendChild(shortcutOverlay);
  }

  function hideShortcutHints() {
    if (shortcutOverlay) {
      shortcutOverlay.remove();
      shortcutOverlay = null;
    }
  }

  document.addEventListener("keydown", onKeyDown);

  // ── Family Engines ─────────────────────────────────────────────

  function activeCreativeFamily() {
    if (state.activePresetTab === "chrome") return "chrome";
    if (state.activePresetTab === "warhol") return "warhol";
    if (state.activePresetTab === "acid") return "acid";
    if (state.activePresetTab === "pastel") return "pastel";
    return "mono";
  }

  function railStateForFamily(family = activeCreativeFamily()) {
    return state.variantRailByFamily[family] || createEmptyRailState();
  }

  function replaceRailState(family, nextState) {
    state.variantRailByFamily = {
      ...state.variantRailByFamily,
      [family]: nextState,
    };
  }

  function invalidateVariantRailState(family = null, { clearVariant = false } = {}) {
    if (family) {
      replaceRailState(family, createEmptyRailState());
      if (clearVariant) {
        state.variantByFamily[family] = null;
        if (state.activeStudioVariant?.family === family) {
          state.activeStudioVariant = null;
          state.activeStudioProvenance = null;
        }
      }
      return;
    }
    state.variantRailByFamily = createInitialVariantRailByFamily();
    if (clearVariant) {
      state.variantByFamily = { mono: null, chrome: null, warhol: null, acid: null, pastel: null };
      state.activeStudioVariant = null;
      state.activeStudioProvenance = null;
    }
  }

  function currentSourcePaletteSignature() {
    return makeSourcePaletteSignature(currentCreativeClassification());
  }

  function currentCuratedPaletteSignature() {
    return makeCuratedPaletteSignature(state.variantRailLocks.curatedMap ? state.curatedPaletteMap : {});
  }

  function recentGalleryHistoryForFamily(family) {
    return (Array.isArray(state.galleryItems) ? state.galleryItems : [])
      .filter((entry) => {
        const rawFamily = String(entry?.family || entry?.familyId || "").toLowerCase();
        const normalized = rawFamily === "pop" ? "warhol" : rawFamily === "noir" ? "chrome" : rawFamily;
        return normalized === family;
      })
      .slice(0, 48)
      .map((entry) => ({
        family,
        palette: normalizeHexPalette(entry?.palette || entry?.paletteHexes || []),
      }))
      .filter((entry) => entry.palette.length);
  }

  function localAcceptedHistoryForFamily(family) {
    return (state.localAcceptedVariantsByFamily[family] || []).slice(0, 24);
  }

  function currentNoveltyHistorySignature(family) {
    const local = localAcceptedHistoryForFamily(family).map((entry) => entry.paletteSignature || entry?.palette?.join("|") || "").join(":");
    const gallery = recentGalleryHistoryForFamily(family).map((entry) => entry.palette.join("|")).join(":");
    return `${local}::${gallery}`;
  }

  function rememberAcceptedVariant(variant) {
    const family = String(variant?.family || "").toLowerCase();
    if (!FAMILY_IDS.includes(family) || !variant?.paletteSignature) return;
    const current = state.localAcceptedVariantsByFamily[family] || [];
    if (current.some((entry) => entry.paletteSignature === variant.paletteSignature)) return;
    state.localAcceptedVariantsByFamily = {
      ...state.localAcceptedVariantsByFamily,
      [family]: [
        {
          family,
          palette: normalizeHexPalette(variant.palette || []),
          paletteSignature: String(variant.paletteSignature || ""),
        },
        ...current,
      ].slice(0, 24),
    };
  }

  function currentRailContextSignature(family) {
    const activeHexForFamilyCast = state.useActiveBg ? selectedActiveHex() : "";
    return railContextSignature({
      tokenId: state.selected?.id || 0,
      family,
      sourcePaletteSignature: currentSourcePaletteSignature(),
      selectedActiveHex: activeHexForFamilyCast,
      noMinimalMode: state.noMinimalDeltaMode,
      useActiveBg: state.useActiveBg,
      lockState: state.variantRailLocks,
      curatedMapSignature: currentCuratedPaletteSignature(),
      noveltyHistorySignature: currentNoveltyHistorySignature(family),
      globalModifiers: state.globalModifiers,
      familyModifiers: state.familyModifiers[family] || {},
    });
  }

  function buildRailLockSnapshot(family) {
    const current = state.variantByFamily[family] || state.activeStudioVariant || null;
    return {
      backgroundHex: current?.roles?.background || state.noMinimalPreviewPair?.background || null,
      accentHue: current?.meta?.accentHue ?? null,
      curatedPaletteMap: sanitizeCuratedPaletteMap(state.curatedPaletteMap),
    };
  }

  function ensureVariantRailPage(family, pageIndex, { force = false } = {}) {
    if (!state.selected || !state.originalImageData) return null;
    const currentContext = currentRailContextSignature(family);
    const rail = railStateForFamily(family);
    let nextRail = rail;
    if (rail.contextSignature !== currentContext) {
      nextRail = {
        ...createEmptyRailState(),
        contextSignature: currentContext,
      };
    }

    const key = String(Math.max(0, Number(pageIndex) || 0));
    if (!force && nextRail.pages[key]) {
      if (nextRail !== rail) replaceRailState(family, nextRail);
      return nextRail.pages[key];
    }

    const page = buildFamilyVariantRailPage({
      tokenId: state.selected.id,
      family,
      classified: currentCreativeClassification(),
      globalModifiers: state.globalModifiers,
      familyModifiers: state.familyModifiers[family] || {},
      noMinimalMode: state.noMinimalDeltaMode,
      selectedActiveHex: state.useActiveBg ? selectedActiveHex() : "",
      useActiveBg: state.useActiveBg,
      curatedPaletteMap: state.curatedPaletteMap,
      lockState: state.variantRailLocks,
      lockSnapshot: buildRailLockSnapshot(family),
      noveltyHistory: {
        localAcceptedVariants: localAcceptedHistoryForFamily(family),
        galleryHistory: recentGalleryHistoryForFamily(family),
      },
      pageIndex: Number(key),
      pageSize: DEFAULT_RAIL_PAGE_SIZE,
    });

    replaceRailState(family, {
      ...nextRail,
      contextSignature: currentContext,
      pages: {
        ...(nextRail.pages || {}),
        [key]: page,
      },
    });
    return page;
  }

  function applyFamilyVariant(variant, { statusPrefix = "Cast" } = {}) {
    if (!variant) return null;
    const family = variant.family || activeCreativeFamily();
    state.variantByFamily[family] = variant;
    rememberAcceptedVariant(variant);
    state.activeStudioVariant = variant;
    syncHeroPairFromRoles(variant.roles, activeRoleStep());
    canvas.applyColorMapping(variant.mapping, variant.roles);
    state.noFieldLastFamily = family;
      state.lastReductionMode = "none";
      state.activeStudioProvenance = buildGalleryProvenance({
      variant,
      curatedPaletteMap: state.variantRailLocks.curatedMap ? state.curatedPaletteMap : {},
      familyModifiers: state.familyModifiers[family] || {},
      globalModifiers: state.globalModifiers,
      outputSignature: makeCanvasOutputSignature(),
      sourcePaletteSignature: variant.sourcePaletteSignature || currentSourcePaletteSignature(),
    });
    renderHeroRolePair();
    renderVariantPanel();
    updatePaletteGrid();
    const familyLabel = FAMILY_LABELS[family] || "Studio";
    setTopbarStatus(`${statusPrefix} · ${familyLabel} · ${variant.score.toFixed(1)} fit · live canvas mutation`);
    pulseStudio("variant");
    persistSession();
    return variant;
  }

  function loadVariantFromRail(family, pageIndex, slotIndex, { statusPrefix = "Cast" } = {}) {
    const page = ensureVariantRailPage(family, pageIndex);
    if (!page || !page.variants.length) return null;
    const nextSlot = Math.max(0, Math.min(page.variants.length - 1, Number(slotIndex) || 0));
    const variant = page.variants[nextSlot];
    replaceRailState(family, {
      ...railStateForFamily(family),
      pageIndex,
      slotIndex: nextSlot,
      activeVariantId: variant.id,
    });
    return applyFamilyVariant(variant, { statusPrefix });
  }

  function activeRoleStep() {
    return 4;
  }

  function selectedActiveHex() {
    const raw = String(state.activeColorHex || els.colorHex.value || "").trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(raw)) return raw;
    const rgb = hslToRgb(state.activeColor.h, state.activeColor.s / 100, state.activeColor.l / 100);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  function activeAnchorHex() {
    const raw = String(state.activeColorHex || els.colorHex.value || "").trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(raw)) return raw;
    const palette = state.sourcePaletteHexes.length ? state.sourcePaletteHexes : canvas.getCompositionPalette();
    return palette[0] || "#808080";
  }

  function getFamilyProfile(family) {
    return FAMILY_PROFILES[family] || FAMILY_PROFILES.mono;
  }

  function pickFamilySourceAnchor(family = activeCreativeFamily()) {
    const source = Array.isArray(state.sourceClassifiedPalette) ? state.sourceClassifiedPalette : [];
    const ranked = source
      .filter((entry) => entry && entry.role !== "background" && entry.role !== "outline")
      .slice()
      .sort((a, b) => hexLuma(String(a.hex || BRAND_ROLE_BG)) - hexLuma(String(b.hex || BRAND_ROLE_BG)));
    if (!ranked.length) {
      return activeAnchorHex();
    }
    if (family === "chrome" || family === "mono" || family === "acid") {
      return String(ranked[0].hex || activeAnchorHex()).toUpperCase();
    }
    if (family === "pastel") {
      return String(ranked[ranked.length - 1].hex || activeAnchorHex()).toUpperCase();
    }
    const midIndex = Math.floor((ranked.length - 1) * 0.5);
    return String(ranked[midIndex]?.hex || activeAnchorHex()).toUpperCase();
  }

  function familyWorldBackgroundHex(family = activeCreativeFamily()) {
    const profile = getFamilyProfile(family);
    const anchorHex = pickFamilySourceAnchor(family);
    const anchorRgb = hexToRgb(anchorHex);
    const anchorHsl = rgbToHsl(anchorRgb.r, anchorRgb.g, anchorRgb.b);
    const unit = Math.random();

    const sat = Math.max(0, Math.min(1, profile.bgSat[0] + ((profile.bgSat[1] - profile.bgSat[0]) * unit)));
    const light = Math.max(0, Math.min(1, profile.bgLight[0] + ((profile.bgLight[1] - profile.bgLight[0]) * (1 - unit))));

    let hue = anchorHsl.h;
    if (family === "warhol") {
      const harmonies = [120, 180, 240, 300];
      hue = (anchorHsl.h + (pickOne(harmonies) || 180) + randomInt(-22, 22) + 720) % 360;
    } else if (family === "acid") {
      const polarity = Math.random() > 0.5 ? 1 : -1;
      hue = (anchorHsl.h + (profile.hueShift * polarity) + randomInt(-16, 16) + 720) % 360;
    } else if (family === "pastel") {
      hue = (anchorHsl.h + randomInt(-profile.hueShift, profile.hueShift) + 360) % 360;
    } else if (family === "mono") {
      hue = (anchorHsl.h + randomInt(-Math.round(profile.hueShift * 0.4), Math.round(profile.hueShift * 0.4)) + 360) % 360;
    } else {
      hue = (anchorHsl.h + randomInt(-profile.hueShift, profile.hueShift) + 360) % 360;
    }

    const rgb = hslToRgb(hue, sat, light);
    const rolePair = deriveNoMinimalismPair(rgbToHex(rgb.r, rgb.g, rgb.b), state.noMinimalDeltaMode);
    return rolePair.background;
  }

  function randomNoMinimalBackgroundHex() {
    const source = Array.isArray(state.sourceClassifiedPalette) ? state.sourceClassifiedPalette : [];
    const ranked = source
      .filter((entry) => entry && entry.role !== "background" && entry.role !== "outline")
      .slice()
      .sort((a, b) => {
        const aAccent = a.role === "accent" ? 1 : 0;
        const bAccent = b.role === "accent" ? 1 : 0;
        if (aAccent !== bAccent) return bAccent - aAccent;
        return hexLuma(String(b.hex || "#000000")) - hexLuma(String(a.hex || "#000000"));
      });

    const picked = pickOne(ranked);
    const anchorHex = String(picked?.hex || activeAnchorHex() || "#808080").toUpperCase();
    const anchorRgb = hexToRgb(anchorHex);
    const anchorHsl = rgbToHsl(anchorRgb.r, anchorRgb.g, anchorRgb.b);
    const hue = (anchorHsl.h + randomInt(-84, 84) + 360) % 360;
    const sat = Math.max(0.18, Math.min(0.88, (anchorHsl.s * 0.85) + ((Math.random() * 0.3) - 0.06)));
    const light = Math.max(0.12, Math.min(0.66, (anchorHsl.l * 0.65) + ((Math.random() * 0.26) - 0.06)));
    const rgb = hslToRgb(hue, sat, light);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  function generateNoMinimalPreviewPair() {
    return deriveNoMinimalismPair(randomNoMinimalBackgroundHex(), state.noMinimalDeltaMode);
  }

  function ensureNoMinimalPreviewPair() {
    if (!state.noMinimalPreviewPair) {
      state.noMinimalPreviewPair = generateNoMinimalPreviewPair();
    }
    return state.noMinimalPreviewPair;
  }

  function refreshNoMinimalPreviewPair() {
    state.noMinimalPreviewPair = generateNoMinimalPreviewPair();
    return state.noMinimalPreviewPair;
  }

  function ensureStudioCastPreviewPair() {
    const preview = ensureNoMinimalPreviewPair();
    return deriveNoMinimalismPair(preview.background, "exact");
  }

  function syncHeroPairFromRoles(roles, roleStep = activeRoleStep()) {
    const background = String(roles?.background || "").toUpperCase();
    const figure = String((roles?.outline || roles?.figure || "")).toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(background) || !/^#[0-9A-F]{6}$/.test(figure)) {
      return;
    }
    state.noMinimalPreviewPair = {
      background,
      figure,
      roleStep,
    };
  }

  function buildSourceForbiddenSet(classified = []) {
    return new Set((classified || []).map((entry) => String(entry?.hex || "").toUpperCase()));
  }

  function deriveValidRolePair(backgroundHex, forbiddenSet) {
    const blocked = forbiddenSet instanceof Set ? forbiddenSet : new Set();
    let current = String(backgroundHex || "#000000").toUpperCase();
    for (let i = 0; i < 32; i += 1) {
      const pair = deriveNoMinimalismPair(current, "exact");
      if (!blocked.has(pair.background) && !blocked.has(pair.figure)) {
        return pair;
      }
      const rgb = hexToRgb(pair.background);
      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      const next = hslToRgb(
        (hsl.h + 17 + (i * 3)) % 360,
        Math.max(0.04, Math.min(0.98, hsl.s + ((i % 2 === 0) ? 0.04 : -0.02))),
        Math.max(0.06, Math.min(0.9, hsl.l + ((i % 2 === 0) ? 0.05 : -0.03))),
      );
      current = rgbToHex(next.r, next.g, next.b);
    }
    return deriveNoMinimalismPair(current, "exact");
  }

  function enforceRolePairRules(result, classified, fallbackBgHex, family) {
    const mapping = { ...(result?.mapping || {}) };
    const roles = result?.roles || {};
    const sourceForbidden = buildSourceForbiddenSet(classified);
    let backgroundHex = String(
      roles.background
        || fallbackBgHex
        || familyWorldBackgroundHex(family)
        || "#000000",
    ).toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(backgroundHex)) {
      backgroundHex = familyWorldBackgroundHex(family);
    }
    const pair = deriveValidRolePair(backgroundHex, sourceForbidden);
    for (const entry of (classified || [])) {
      if (entry.role === "background") mapping[entry.hex] = pair.background;
      if (entry.role === "outline") mapping[entry.hex] = pair.figure;
    }
    return {
      mapping,
      roles: {
        background: pair.background,
        outline: pair.figure,
      },
    };
  }

  function variantChipsMarkup(variant) {
    const chips = Array.isArray(variant?.ui?.chips) ? variant.ui.chips : [];
    if (!chips.length) {
      return `<span class="variant-chip">Infinite variant generator</span>`;
    }
    return chips.map((chip) => `<span class="variant-chip">${escapeHtml(chip)}</span>`).join("");
  }

  function currentBackgroundHex() {
    return canvas.getGlobalRolePair().background;
  }

  function nearestPaletteHex(targetHex, palette = null) {
    const colors = Array.isArray(palette) && palette.length ? palette : canvas.getCompositionPalette();
    if (!colors.length) return null;
    let bestHex = colors[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const hex of colors) {
      const distance = distanceRgb(targetHex, hex);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestHex = hex;
      }
    }
    return bestHex;
  }

  function applyNoise() {
    if (!state.selected) return;

    const amountNorm = Math.max(0, Math.min(1, state.noiseAmount / 100));
    const noisePass = ++state.noisePass;
    applyDisplayGrain({
      enabled: amountNorm > 0,
      amount: amountNorm,
      seed: noisePass,
    });
    setTopbarStatus(`Grain live · ${state.noiseAmount}% · manual plus role masks`);
    pulseStudio("dither");
  }

  function applyDisplayGrain(options) {
    canvas.setDisplayGrain(options);
    updateExportButtons();
  }

  function renderGallery() {
    if (!els.galleryList) return;
    if (!state.noGalleryAvailable) {
      els.galleryList.innerHTML = `<div class="gallery-empty">No-Gallery is unavailable for this deployment.</div>`;
      if (els.galleryRefresh) els.galleryRefresh.disabled = true;
      return;
    }
    if (els.galleryRefresh) els.galleryRefresh.disabled = state.galleryLoading;
    if (state.galleryStorage === "unavailable" && !state.galleryLoading) {
      const message = state.galleryMessage || (state.globalGalleryEnabled
        ? "Shared No-Gallery is unavailable right now."
        : "Shared No-Gallery is not configured for this deployment.");
      els.galleryList.innerHTML = `<div class="gallery-empty">${escapeHtml(message)}</div>`;
      return;
    }
    if (state.galleryMessage) {
      els.galleryList.innerHTML = `<div class="gallery-empty">${escapeHtml(state.galleryMessage)}</div>`;
      return;
    }
    if (state.galleryLoading && !state.galleryItems.length) {
      els.galleryList.innerHTML = `<div class="gallery-empty">Loading No-Gallery...</div>`;
      return;
    }
    if (!state.galleryItems.length) {
      els.galleryList.innerHTML = `<div class="gallery-empty">No compositions saved yet.</div>`;
      return;
    }
    els.galleryList.innerHTML = `${state.galleryItems.map((item) => {
      const bg = item.rolePair?.background || "";
      const fg = item.rolePair?.figure || "";
      const mediaType = String(item.mediaType || "").toLowerCase() === "gif" ? "gif" : "png";
      const mediaUrl = item.thumbUrl || item.mediaUrl || item.viewUrl || item.pngUrl || item.gifUrl || "";
      const signature = String(item.signatureHandle || "").trim();
      const signatureResolved = signature
        || String(item.signature || item.twitterHandle || "").trim();
      const palette = resolveGalleryPalette(item);
      const palettePreview = palette.slice(0, 8);
      const colorPair = bg && fg && bg !== "—" && fg !== "—"
        ? `<span class="gallery-subline gallery-color-pair"><span class="gallery-color-dot" style="background:${escapeHtml(bg)}"></span><span class="gallery-color-dot" style="background:${escapeHtml(fg)}"></span> ${escapeHtml(bg)} → ${escapeHtml(fg)}</span>`
        : `<span class="gallery-subline">${escapeHtml(bg || "—")} → ${escapeHtml(fg || "—")}</span>`;
      const signatureLine = signatureResolved
        ? `<span class="gallery-subline gallery-signature">${escapeHtml(signatureResolved)}</span>`
        : "";
      const voteLine = `<div class="no-gallery-reactions">
        <button class="no-gallery-react-btn${item?.viewerReaction === "no" ? " is-active" : ""}" type="button" data-gallery-react="${escapeHtml(item.id || "")}" data-gallery-reaction="no" ${state.galleryStorage !== "sqlite" ? "disabled" : ""}>NO ${Number(item?.noCount ?? item?.voteCount) || 0}</button>
        <button class="no-gallery-react-btn${item?.viewerReaction === "yes" ? " is-active" : ""}" type="button" data-gallery-react="${escapeHtml(item.id || "")}" data-gallery-reaction="yes" ${state.galleryStorage !== "sqlite" ? "disabled" : ""}>YES ${Number(item?.yesCount) || 0}</button>
      </div>`;
      const paletteLine = palettePreview.length
        ? `<span class="gallery-palette-strip">${palettePreview.map((hex) => `<span class="gallery-palette-chip" style="background:${escapeHtml(hex)}" title="${escapeHtml(hex)}"></span>`).join("")}${palette.length > palettePreview.length ? `<span class="gallery-palette-count">+${palette.length - palettePreview.length}</span>` : ""}</span>`
        : "";
      return `
      <div class="gallery-card-shell">
        <a class="gallery-card" href="${escapeHtml(item.viewUrl || mediaUrl || "#")}" target="_blank" rel="noreferrer">
          <img class="gallery-thumb" src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(item.label || "No-Gallery entry")}" loading="lazy" />
          <span class="gallery-meta">
            <span class="gallery-title">${escapeHtml(item.label || `No-Studio #${item.tokenId || 0}`)}</span>
            <span class="gallery-subline">#${Number(item.tokenId) || 0} \u00b7 ${(item.family || "studio").toUpperCase()} \u00b7 ${mediaType.toUpperCase()}</span>
            ${colorPair}
            ${paletteLine}
            ${signatureLine}
          </span>
        </a>
        ${voteLine}
      </div>
    `;
    }).join("")}`;
  }

  async function refreshGallery({ silent = false } = {}) {
    if (!state.noGalleryAvailable) {
      renderGallery();
      return;
    }
    state.galleryLoading = true;
    state.galleryMessage = "";
    renderGallery();
    try {
      const payload = await listNoStudioGallery({ limit: 12 });
      state.galleryItems = Array.isArray(payload.items) ? payload.items : [];
      state.galleryStorage = String(payload?.storage || "sqlite");
      invalidateVariantRailState();
      state.galleryMessage = payload?.unavailable
        ? String(payload?.message || "Shared No-Gallery is unavailable right now.")
        : "";
      if (!silent) {
        setTopbarStatus(payload?.unavailable
          ? state.galleryMessage
          : `No-Gallery · ${state.galleryItems.length} saved`);
      }
    } catch (error) {
      state.galleryItems = [];
      state.galleryStorage = "unavailable";
      state.galleryMessage = error.message || "No-Gallery unavailable";
      if (!silent) setTopbarStatus(state.galleryMessage);
    } finally {
      state.galleryLoading = false;
      renderGallery();
      updateExportButtons();
    }
  }

  function normalizeSignatureHandle(value) {
    const cleaned = String(value || "")
      .trim()
      .replace(/^@+/, "")
      .replace(/[^a-zA-Z0-9_]/g, "")
      .slice(0, 15);
    return cleaned ? `@${cleaned}` : "";
  }

  async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read blob"));
      reader.readAsDataURL(blob);
    });
  }

  async function buildNoiseGifDataUrlForGallery() {
    const grain = canvas.getDisplayGrain();
    if (!grain.enabled || !(grain.amount > 0)) {
      throw new Error("Enable grain first to save GIF to No-Gallery");
    }
    setTopbarStatus("No-Render GIF (optimized)...");
    const browserGif = await exportNoiseGifInBrowser({
      size: 512,
      frames: 10,
      durationMs: 1000,
    });
    return await blobToDataUrl(browserGif.blob);
  }

  async function saveCurrentToGallery({ mediaKind = "png" } = {}) {
    if (!state.selected || state.gallerySaving) return;
    if (!state.noGalleryAvailable) {
      setTopbarStatus("No-Gallery is unavailable for this deployment");
      return;
    }
    if (!state.globalGalleryEnabled || state.galleryStorage === "unavailable") {
      setTopbarStatus("Shared No-Gallery is unavailable");
      return;
    }
    if (mediaKind !== "png" && mediaKind !== "gif") {
      setTopbarStatus("Unsupported gallery media type");
      return;
    }

    const signatureHandle = normalizeSignatureHandle(els.gallerySignature?.value || state.gallerySignature || "");
    state.gallerySignature = signatureHandle;
    if (els.gallerySignature) {
      els.gallerySignature.value = signatureHandle;
    }

    state.gallerySaving = true;
    state.gallerySavingKind = mediaKind;
    updateExportButtons();
    const saveButton = mediaKind === "gif" ? els.saveGalleryGif : els.saveGalleryPng;
    const originalLabel = saveButton ? saveButton.textContent : "";
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = mediaKind === "gif" ? "Saving GIF..." : "Saving PNG...";
    }
    try {
      let mediaDataUrl = "";
      if (mediaKind === "gif") {
        mediaDataUrl = await buildNoiseGifDataUrlForGallery();
      } else {
        mediaDataUrl = canvas.exportPng1024().toDataURL("image/png");
      }
      const familyId = state.activePresetTab === "warhol" ? "pop" : state.activePresetTab;
      const outputSignature = makeCanvasOutputSignature();
      const liveRolePair = canvas.getGlobalRolePair();
      const composition = canvas.exportCompositionState();
      const provenance = {
        ...buildGalleryProvenance({
        variant: state.activeStudioVariant || state.variantByFamily[state.activePresetTab] || null,
        curatedPaletteMap: state.curatedPaletteMap,
        familyModifiers: state.activeStudioProvenance?.familyModifiers || state.familyModifiers[state.activePresetTab] || {},
        globalModifiers: state.activeStudioProvenance?.globalModifiers || state.globalModifiers,
        outputSignature,
        sourcePaletteSignature: state.activeStudioProvenance?.sourcePaletteSignature || currentSourcePaletteSignature(),
        }),
        family: familyId,
        familyModifiers: state.activeStudioProvenance?.familyModifiers || state.familyModifiers[state.activePresetTab] || {},
        globalModifiers: state.activeStudioProvenance?.globalModifiers || state.globalModifiers,
        globalRolePair: composition.globalRolePair,
        roleGrid: composition.roleGrid,
        contentGrid: composition.contentGrid,
        noiseMask: composition.noiseMask,
        noiseRoleTargets: composition.noiseRoleTargets,
        presentationMode: state.presentationMode,
        singleFrameEnabled: state.singleFrameEnabled,
        singleFrameTone: state.singleFrameTone,
        outputSignature,
      };
      const payload = await saveNoStudioGallery({
        tokenId: state.selected.id,
        family: familyId,
        label: normalizeGalleryLabel(els.topbarStatus.textContent, state.selected.id),
        mediaType: mediaKind,
        mediaDataUrl,
        pngDataUrl: mediaKind === "png" ? mediaDataUrl : undefined,
        gifDataUrl: mediaKind === "gif" ? mediaDataUrl : undefined,
        signatureHandle,
        signature: signatureHandle,
        twitterHandle: signatureHandle,
        palette: normalizeHexPalette(canvas.getCurrentPalette()),
        paletteHexes: normalizeHexPalette(canvas.getCurrentPalette()),
        rolePair: {
          background: liveRolePair.background || currentBackgroundHex(),
          figure: liveRolePair.outline || "—",
          mode: state.noMinimalDeltaMode,
        },
        provenance,
      });
      state.galleryStorage = String(payload?.storage || state.galleryStorage || "sqlite");
      if (payload?.item) {
        state.galleryItems = [payload.item, ...state.galleryItems.filter((entry) => entry.id !== payload.item.id)].slice(0, 12);
        invalidateVariantRailState();
      }
      state.galleryMessage = "";
      renderGallery();
      if (payload?.deduped) {
        setTopbarStatus(`Already in No-Gallery · ${mediaKind.toUpperCase()}`);
      } else {
        setTopbarStatus(`Saved ${mediaKind.toUpperCase()} to No-Gallery`);
      }
    } catch (error) {
      setTopbarStatus(error.message || "Save to No-Gallery failed");
    } finally {
      state.gallerySaving = false;
      state.gallerySavingKind = null;
      if (saveButton) {
        saveButton.textContent = originalLabel || (mediaKind === "gif" ? "Save GIF To No-Gallery" : "Save PNG To No-Gallery");
      }
      updateExportButtons();
    }
  }

  function getPopSheetSpec(layoutId) {
    const specs = {
      "1x3": { cols: 3, rows: 1, label: "1x3" },
      "2x2": { cols: 2, rows: 2, label: "2x2" },
      "3x3": { cols: 3, rows: 3, label: "3x3" },
      "4x4": { cols: 4, rows: 4, label: "4x4" },
    };
    return specs[layoutId] || specs["2x2"];
  }

  function currentGridFrameStyle() {
    return GRID_FRAME_TONES[state.gridFrameTone] || GRID_FRAME_TONES.cream;
  }

  function cloneImageDataLocal(imageData) {
    return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  }

  function imageDataHexAt(imageData, index) {
    const offset = index * 4;
    return rgbToHex(
      imageData.data[offset],
      imageData.data[offset + 1],
      imageData.data[offset + 2],
    ).toUpperCase();
  }

  function tileKeepsArtworkVisible(tile, roleGrid = []) {
    if (!(tile instanceof ImageData) || !Array.isArray(roleGrid) || !roleGrid.length) return true;
    const occupiedIndexes = [];
    let backgroundIndex = -1;
    for (let index = 0; index < roleGrid.length; index += 1) {
      if (roleGrid[index] === "b") {
        if (backgroundIndex < 0) backgroundIndex = index;
        continue;
      }
      occupiedIndexes.push(index);
    }
    if (!occupiedIndexes.length) return true;
    const bgHex = imageDataHexAt(tile, Math.max(0, backgroundIndex));
    let visibleCount = 0;
    for (const index of occupiedIndexes) {
      if (imageDataHexAt(tile, index) === bgHex) continue;
      visibleCount += 1;
      if (visibleCount >= 4) return true;
    }
    return false;
  }

  function gridHarmonySignal(panelIndex, panelCount) {
    const progress = panelCount > 1 ? (panelIndex / Math.max(1, panelCount - 1)) : 0.5;
    const centered = progress - 0.5;
    const wave = Math.sin((panelIndex + 1) * 1.61803398875);
    const orbit = Math.cos((panelIndex + 1) * 0.9189385332);
    const ripple = Math.sin(((panelIndex + 1) * 0.72) + (panelCount * 0.11));
    return { progress, centered, wave, orbit, ripple };
  }

  function pickGridPanelStyle(family, panelIndex, attempt = 0, sheetNonce = 0) {
    const safeFamily = FAMILY_IDS.includes(family) ? family : activeCreativeFamily();
    const order = FAMILY_GRID_STYLE_ORDERS[safeFamily] || FAMILY_GRID_STYLE_ORDERS.chrome;
    const styleIndex = order[(panelIndex + attempt + sheetNonce) % order.length];
    return GRID_PANEL_STYLES[styleIndex] || GRID_PANEL_STYLES[0];
  }

  function computeGridPanelBackground({
    family,
    baseBackgroundHex,
    panelIndex,
    panelCount,
    attempt = 0,
    sheetNonce = 0,
    style,
    posterize = false,
  }) {
    const safeFamily = FAMILY_IDS.includes(family) ? family : activeCreativeFamily();
    const profile = GRID_HARMONY_PROFILES[safeFamily] || GRID_HARMONY_PROFILES.chrome;
    const panelStyle = style || pickGridPanelStyle(safeFamily, panelIndex, attempt, sheetNonce);
    const { centered, wave, orbit, ripple } = gridHarmonySignal(panelIndex + (attempt * 0.37), panelCount + Math.max(0, sheetNonce));
    const familySpan = profile.hueSpan * (
      safeFamily === "warhol" ? 2.9
      : safeFamily === "acid" ? 2.35
      : safeFamily === "chrome" ? 1.9
      : safeFamily === "pastel" ? 1.3
      : 1.4
    );
    const hueShift = (
      panelStyle.hueBias
      + (centered * familySpan)
      + (wave * familySpan * 0.72)
      + (orbit * familySpan * 0.46)
      + (ripple * familySpan * 0.28)
      + (attempt * 9)
    );
    const satMul = lerp(panelStyle.satMul[0], panelStyle.satMul[1], clampUnit(0.5 + (wave * 0.5))) * panelStyle.bgSatMul;
    const lightMul = lerp(panelStyle.lightMul[0], panelStyle.lightMul[1], clampUnit(0.5 - (centered * 0.5))) * panelStyle.bgLightMul;
    let shifted = shiftHexHue(
      baseBackgroundHex,
      hueShift * profile.bgScale,
      satMul,
      lightMul,
    );

    if (safeFamily === "warhol") {
      const bank = POP_POSTER_BACKGROUNDS[(panelIndex + attempt + sheetNonce) % POP_POSTER_BACKGROUNDS.length] || shifted;
      shifted = mixHex(shifted, bank, posterize ? 0.58 : 0.42);
    } else if (safeFamily === "acid") {
      shifted = mixHex(shifted, shiftHexHue(baseBackgroundHex, hueShift + 96, 1.16, 0.84), 0.26 + (Math.abs(orbit) * 0.12));
    } else if (safeFamily === "chrome") {
      shifted = mixHex(shifted, "#C8D6E5", 0.14 + (Math.abs(wave) * 0.08));
    } else if (safeFamily === "pastel") {
      shifted = mixHex(shifted, "#F4EFEA", 0.26 + (Math.max(0, centered) * 0.12));
    } else if (safeFamily === "mono") {
      shifted = mixHex(shifted, baseBackgroundHex, 0.34);
    }

    return canvas.enforceBgOutlineRule(shifted).background;
  }

  function tuneGridPanelResult(result, classified, {
    family,
    panelIndex,
    panelCount,
    attempt = 0,
    sheetNonce = 0,
    style = null,
    posterize = false,
  } = {}) {
    const safeFamily = FAMILY_IDS.includes(family) ? family : activeCreativeFamily();
    const panelStyle = style || pickGridPanelStyle(safeFamily, panelIndex, attempt, sheetNonce);
    const entries = Array.isArray(classified) ? classified : [];
    const mapping = { ...(result?.mapping || {}) };
    const baseRoles = result?.roles || {};
    const roles = canvas.enforceBgOutlineRule(computeGridPanelBackground({
      family: safeFamily,
      baseBackgroundHex: baseRoles.background || canvas.getGlobalRolePair().background,
      panelIndex,
      panelCount,
      attempt,
      sheetNonce,
      style: panelStyle,
      posterize,
    }));
    const forbidden = new Set(entries.map((entry) => String(entry?.hex || "").toUpperCase()));
    forbidden.add(BRAND_ROLE_BG);
    forbidden.add(BRAND_ROLE_FG);
    const used = new Set([roles.background, roles.outline]);
    const floor = hexLuma(roles.outline || BRAND_ROLE_FG) + 2;
    const profile = GRID_HARMONY_PROFILES[safeFamily] || GRID_HARMONY_PROFILES.chrome;
    const { centered, wave, orbit, ripple } = gridHarmonySignal(panelIndex + (sheetNonce * 0.21), panelCount);
    const mainShift = (
      panelStyle.hueBias
      + (centered * profile.hueSpan * 1.9)
      + (wave * profile.hueSpan * 0.82)
      + (orbit * profile.hueSpan * 0.56)
      + (ripple * profile.hueSpan * 0.24)
      + (attempt * 7)
    );

    for (const entry of entries) {
      const sourceHex = String(entry?.hex || "").toUpperCase();
      const role = entry?.role || "body";
      if (!/^#[0-9A-F]{6}$/.test(sourceHex) || role === "background" || role === "outline") continue;
      const baseHex = String(mapping[sourceHex] || sourceHex).toUpperCase();
      const roleHueShift = (
        mainShift * (role === "accent" ? 1.28 : role === "neutral" ? 0.76 : 1)
        + (role === "accent" ? panelStyle.accentHueBias : panelStyle.hueBias * 0.16)
      );
      const roleSatMul = lerp(panelStyle.satMul[0], panelStyle.satMul[1], clampUnit(0.5 + (orbit * 0.5)))
        * (role === "accent" ? 1.08 : role === "neutral" ? 0.96 : 1);
      const roleLightMul = lerp(panelStyle.lightMul[0], panelStyle.lightMul[1], clampUnit(0.5 - (centered * 0.5)))
        * (role === "accent" ? 1 + panelStyle.accentLift : 1);
      let candidate = shiftHexHue(baseHex, roleHueShift, roleSatMul, roleLightMul);
      if (panelStyle.flatMix > 0) {
        candidate = mixHex(
          candidate,
          role === "accent" ? roles.outline : roles.background,
          role === "accent" ? panelStyle.flatMix * 0.34 : panelStyle.flatMix,
        );
      }
      if (posterize && role === "accent") {
        candidate = mixHex(candidate, "#FFFFFF", 0.08 + (panelStyle.accentLift * 0.4));
      }
      if (candidate === roles.background) {
        candidate = mixHex(candidate, roles.outline, 0.18);
      }
      if (candidate === roles.outline) {
        candidate = mixHex(candidate, "#FFFFFF", 0.12);
      }
      mapping[sourceHex] = ensureDistinctHex(candidate, used, { floor, forbidden });
    }

    const palette = normalizeHexPalette([
      roles.background,
      roles.outline,
      ...Object.values(mapping),
    ]);

    return {
      ...result,
      family: safeFamily,
      mapping,
      roles,
      rolePair: {
        background: roles.background,
        figure: roles.outline,
        mode: state.noMinimalDeltaMode,
        roleStep: 4,
      },
      palette,
      paletteSignature: makePaletteSignature(palette),
      ui: {
        chips: [panelStyle.id, posterize ? "poster series" : "grid series"],
      },
    };
  }

  function buildHarmonicGridVariant({
    family,
    panelIndex,
    panelCount,
    posterize = false,
    attempt = 0,
    sheetNonce = 0,
    classified = null,
    baseBackgroundHex = null,
  }) {
    const safeFamily = FAMILY_IDS.includes(family) ? family : activeCreativeFamily();
    const effectiveClassified = Array.isArray(classified) && classified.length
      ? classified
      : currentCreativeClassification();
    const style = pickGridPanelStyle(safeFamily, panelIndex, attempt, sheetNonce);
    const preset = createUniqueVariant(safeFamily, effectiveClassified);
    const backgroundHex = computeGridPanelBackground({
      family: safeFamily,
      baseBackgroundHex: baseBackgroundHex || canvas.getGlobalRolePair().background,
      panelIndex,
      panelCount,
      attempt,
      sheetNonce,
      style,
      posterize,
    });
    const seeded = buildFamilyResult(effectiveClassified, safeFamily, {
      preset,
      backgroundHex,
      traitPhase: ((panelIndex + 1) * 0.37) + (attempt * 0.23) + (sheetNonce * 0.11),
      panelIndex: panelIndex + (attempt * panelCount) + (sheetNonce * panelCount * 3),
      panelCount: Math.max(2, panelCount * 2),
      popSheetStyle: posterize ? POP_SHEET_STYLE_POSTER : POP_SHEET_STYLE_SOFT,
    });
    const tuned = tuneGridPanelResult(seeded, effectiveClassified, {
      family: safeFamily,
      panelIndex,
      panelCount,
      attempt,
      sheetNonce,
      style,
      posterize,
    });

    return {
      ...tuned,
      id: `grid-${safeFamily}-${panelCount}-${panelIndex}-${sheetNonce}-${attempt}-${style.id}-${posterize ? "poster" : "series"}`,
      name: posterize
        ? `${FAMILY_LABELS[safeFamily] || "Studio"} Poster ${panelIndex + 1}`
        : `${FAMILY_LABELS[safeFamily] || "Studio"} Grid ${panelIndex + 1}`,
      sourcePaletteSignature: currentSourcePaletteSignature(),
      score: posterize ? 92.5 : 93.5,
    };
  }

function makePanelPaletteSignature(result) {
  const unique = new Set();
  const bg = String(result?.roles?.background || "").toUpperCase();
  const ol = String(result?.roles?.outline || "").toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(bg)) unique.add(bg);
  if (/^#[0-9A-F]{6}$/.test(ol)) unique.add(ol);
  for (const value of Object.values(result?.mapping || {})) {
    const hex = String(value || "").toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(hex)) unique.add(hex);
  }
  return [...unique].sort().join("|");
}

function panelRolePairSignature(result) {
  const bg = String(result?.roles?.background || "").toUpperCase();
  const fg = String(result?.roles?.outline || "").toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(bg) || !/^#[0-9A-F]{6}$/.test(fg)) return "";
  return `${bg}->${fg}`;
}

function panelSignature(result, { style, layout, panelSeed }) {
  const rolePair = panelRolePairSignature(result);
  const palette = makePanelPaletteSignature(result);
  if (!rolePair || !palette) return "";
  return `${style}|${layout}|${panelSeed}|${rolePair}|${palette}`;
}

function panelVisualSignature(result, { style, layout }) {
  const rolePair = panelRolePairSignature(result);
  const palette = makePanelPaletteSignature(result);
  if (!rolePair || !palette) return "";
  return `${style}|${layout}|${rolePair}|${palette}`;
}

function shiftHexHue(hex, hueShift = 0, satMul = 1, lightMul = 1) {
  const rgb = hexToRgb(String(hex || "#000000").toUpperCase());
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const next = hslToRgb(
    (hsl.h + hueShift + 360) % 360,
    Math.max(0, Math.min(1, hsl.s * satMul)),
    Math.max(0, Math.min(1, hsl.l * lightMul)),
  );
  return rgbToHex(next.r, next.g, next.b);
}

function srgbToLinear(channel) {
  const value = channel / 255;
  if (value <= 0.04045) return value / 12.92;
  return ((value + 0.055) / 1.055) ** 2.4;
}

function hexToOklab(hex) {
  const rgb = hexToRgb(String(hex || "#000000").toUpperCase());
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  const l = (0.4122214708 * r) + (0.5363325363 * g) + (0.0514459929 * b);
  const m = (0.2119034982 * r) + (0.6806995451 * g) + (0.1073969566 * b);
  const s = (0.0883024619 * r) + (0.2817188376 * g) + (0.6299787005 * b);
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  return {
    L: (0.2104542553 * lRoot) + (0.7936177850 * mRoot) - (0.0040720468 * sRoot),
    a: (1.9779984951 * lRoot) - (2.4285922050 * mRoot) + (0.4505937099 * sRoot),
    b: (0.0259040371 * lRoot) + (0.7827717662 * mRoot) - (0.8086757660 * sRoot),
  };
}

function oklabDistance(hexA, hexB) {
  const a = hexToOklab(hexA);
  const b = hexToOklab(hexB);
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt((dL * dL) + (da * da) + (db * db));
}

function isBackgroundSeparated(candidateHex, existingHexes, minimumDistance) {
  for (const existing of existingHexes) {
    if (oklabDistance(candidateHex, existing) < minimumDistance) {
      return false;
    }
  }
  return true;
}

function deriveScreenprintInversePair(backgroundHex) {
  const rgb = hexToRgb(String(backgroundHex || "#404040").toUpperCase());
  const bg = {
    r: Math.max(4, Math.min(255, rgb.r)),
    g: Math.max(4, Math.min(255, rgb.g)),
    b: Math.max(4, Math.min(255, rgb.b)),
  };
  const fg = {
    r: bg.r - 4,
    g: bg.g - 4,
    b: bg.b - 4,
  };
  return {
    background: rgbToHex(bg.r, bg.g, bg.b),
    outline: rgbToHex(fg.r, fg.g, fg.b),
    roleStep: -4,
  };
}

function applyScreenprintInverseRoleRule(result, classified) {
  const inversePair = deriveScreenprintInversePair(result?.roles?.background || "#404040");
  const mapping = { ...(result?.mapping || {}) };
  const entries = Array.isArray(classified) ? classified : [];
  const used = new Set([inversePair.background, inversePair.outline]);
  const forbidden = new Set(entries.map((entry) => String(entry?.hex || "").toUpperCase()));
  const bgLuma = hexLuma(inversePair.background);
  const fgLuma = hexLuma(inversePair.outline);

  for (const entry of entries) {
    const sourceHex = String(entry?.hex || "").toUpperCase();
    const role = entry?.role || "body";
    if (!/^#[0-9A-F]{6}$/.test(sourceHex)) continue;
    if (role === "background") {
      mapping[sourceHex] = inversePair.background;
      continue;
    }
    if (role === "outline") {
      mapping[sourceHex] = inversePair.outline;
      continue;
    }

    let candidate = String(mapping[sourceHex] || "").toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(candidate)) {
      candidate = role === "accent"
        ? mixHex(inversePair.outline, "#FFFFFF", 0.25)
        : mixHex(inversePair.background, inversePair.outline, 0.52);
    }

    // Keep screenprint inks in a controlled band between inverse role anchors.
    const candidateLuma = hexLuma(candidate);
    if (Math.abs(candidateLuma - bgLuma) < 5) {
      candidate = mixHex(candidate, inversePair.outline, 0.28);
    }
    if (Math.abs(candidateLuma - fgLuma) < 3) {
      candidate = mixHex(candidate, "#FFFFFF", 0.18);
    }

    mapping[sourceHex] = ensureDistinctHex(candidate, used, { forbidden, floor: -1 });
  }

  return {
    mapping,
    roles: {
      background: inversePair.background,
      outline: inversePair.outline,
    },
  };
}

function diversifyPanelResult(panelResult, panelIndex, classified) {
  const entries = Array.isArray(classified) ? classified : [];
  const hueShift = ((panelIndex + 1) * 23) % 360;
  const satMul = 0.92 + (((panelIndex % 4) + 1) * 0.03);
  const lightMul = 0.9 + (((panelIndex % 3) + 1) * 0.04);
  const roles = panelResult?.roles || {};
  const mapping = { ...(panelResult?.mapping || {}) };
  const shiftedRoles = {
    background: shiftHexHue(roles.background || "#404040", hueShift, satMul, lightMul),
    outline: shiftHexHue(roles.outline || "#3C3C3C", hueShift, satMul, lightMul),
  };
  for (const entry of entries) {
    const sourceHex = String(entry?.hex || "").toUpperCase();
    const role = entry?.role || "body";
    if (!/^#[0-9A-F]{6}$/.test(sourceHex)) continue;
    if (role === "background") {
      mapping[sourceHex] = shiftedRoles.background;
    } else if (role === "outline") {
      mapping[sourceHex] = shiftedRoles.outline;
    } else if (/^#[0-9A-F]{6}$/.test(String(mapping[sourceHex] || "").toUpperCase())) {
      mapping[sourceHex] = shiftHexHue(mapping[sourceHex], hueShift, satMul, lightMul);
    } else {
      mapping[sourceHex] = mixHex(shiftedRoles.background, shiftedRoles.outline, role === "accent" ? 0.65 : 0.48);
    }
  }
  return {
    ...panelResult,
    mapping,
    roles: shiftedRoles,
  };
}

function computePopPanelBackground({
  classified,
  popStyle,
  panelIndex,
  panelCount,
  attempt,
  sheetNonce = 0,
  activeBackgroundHex = null,
}) {
  if (activeBackgroundHex) {
    return String(activeBackgroundHex || "#6A6A6A").toUpperCase();
  }
  const posterBank = popStyle === POP_SHEET_STYLE_SCREENPRINT
    ? POP_SCREENPRINT_BACKGROUNDS
    : POP_POSTER_BACKGROUNDS;
  const picked = posterBank[(panelIndex + attempt + sheetNonce) % posterBank.length];
  if (picked) return picked;
  const anchorSource = activeBackgroundHex
    || classified.find((entry) => entry.role === "accent")?.hex
    || classified.find((entry) => entry.role !== "background" && entry.role !== "outline")?.hex
    || classified[0]?.hex
    || "#6A6A6A";
  const anchorRgb = hexToRgb(anchorSource);
  const anchorHsl = rgbToHsl(anchorRgb.r, anchorRgb.g, anchorRgb.b);
  const progress = panelCount > 1 ? (panelIndex / (panelCount - 1)) : 0;
  const phase = (((panelIndex + 1) * 37) + (attempt * 23) + (sheetNonce * 41)) % 360;

  if (popStyle === POP_SHEET_STYLE_SCREENPRINT) {
    const hue = (anchorHsl.h + (progress * 268) + phase + 360) % 360;
    const sat = clampUnit(0.36 + (0.28 * Math.abs(Math.sin(((panelIndex + 1) * 0.61) + (attempt * 0.39)))));
    const light = clampUnit(0.54 + (0.24 * Math.abs(Math.cos(((panelIndex + 1) * 0.47) + (attempt * 0.33)))));
    const rgb = hslToRgb(hue, sat, light);
    return rgbToHex(Math.max(4, rgb.r), Math.max(4, rgb.g), Math.max(4, rgb.b));
  }

  const hue = (anchorHsl.h + (progress * 324) + phase + 360) % 360;
  const sat = clampUnit(0.72 + (0.24 * Math.abs(Math.sin(((panelIndex + 1) * 0.55) + (attempt * 0.31)))));
  const light = clampUnit(0.36 + (0.3 * Math.abs(Math.cos(((panelIndex + 1) * 0.42) + (attempt * 0.27)))));
  const rgb = hslToRgb(hue, sat, light);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

function applyScreenprintInkMask(baseHex, panelRoles, x, y, panelIndex) {
  const backgroundHex = panelRoles?.background || "#4C4C4C";
  const figureHex = panelRoles?.outline || "#484848";
  const seed = (panelIndex * 29) + 11;
  const halftone = (((x + seed) % 4) === 0) && (((y + (seed % 3)) % 4) === 0);
  const dropout = (((x * 11) + (y * 7) + seed) % 53) === 0;
  const density = (((x * 5) + (y * 3) + seed) % 17) < 3;
  let next = baseHex;
  if (dropout) {
    next = mixHex(next, backgroundHex, 0.28);
  } else if (halftone) {
    next = mixHex(next, figureHex, 0.2);
  } else if (density) {
    next = mixHex(next, backgroundHex, 0.08);
  }
  return next;
}

  function collectGridVariants(family, wantedPanels, startPage = 0) {
    const safeFamily = FAMILY_IDS.includes(family) ? family : activeCreativeFamily();
    const wanted = Math.max(0, Number(wantedPanels) || 0);
    const out = [];
    const seen = new Set();
    let pageIndex = Math.max(0, Number(startPage) || 0);
    const maxPages = Math.max(2, Math.ceil(Math.max(1, wanted) / DEFAULT_RAIL_PAGE_SIZE) + 2);

    while (out.length < wanted && pageIndex < (startPage + maxPages)) {
      const page = ensureVariantRailPage(safeFamily, pageIndex);
      const variants = Array.isArray(page?.variants) ? page.variants : [];
      for (const variant of variants) {
        const signature = String(variant?.paletteSignature || variant?.id || "");
        if (!signature || seen.has(signature)) continue;
        seen.add(signature);
        out.push(variant);
        if (out.length >= wanted) break;
      }
      pageIndex += 1;
    }

    return out.slice(0, wanted);
  }

  function applyVariantGrid(layoutId = state.popSheetLayout, { family = activeCreativeFamily() } = {}) {
    if (!state.selected) return;

    const { cols, rows, label } = getPopSheetSpec(layoutId);
    const panelCount = cols * rows;
    const familyLabel = FAMILY_LABELS[family] || "Studio";
    const snapshot = activeSingleCompositionSnapshot();
    if (!snapshot?.compositionState || !snapshot?.imageData) {
      setTopbarStatus("Grid build needs a live single composition first");
      return;
    }
    const compositionState = snapshot.compositionState;
    const baseTile = cloneImageDataLocal(snapshot.imageData);
    const minimumBgDistance = family === "pastel" ? 0.045 : family === "mono" ? 0.038 : 0.055;
    const historyKey = gridSeriesHistoryKey(snapshot, family, layoutId);
    const history = recentGridSeriesHistoryForKey(historyKey);
    const candidateCount = 28;

    function buildSeriesCandidate(candidateIndex) {
      const usedRolePairs = new Set();
      const usedPaletteSignatures = new Set();
      const usedPanelSignatures = new Set();
      const usedBackgrounds = [];
      const sheetNonce = (Number(state.gridSeriesNonce) || 0) + 1 + candidateIndex;
      const panelResults = [];

      function acceptGridPanel(result, tile, panelIndex, attempt) {
        const rolePair = panelRolePairSignature(result);
        const paletteSig = makePanelPaletteSignature(result);
        const visualSig = panelVisualSignature(result, {
          style: `grid-${family}`,
          layout: layoutId,
        });
        const panelSig = panelSignature(result, {
          style: `grid-${family}`,
          layout: layoutId,
          panelSeed: panelIndex + (attempt * panelCount) + (sheetNonce * 997),
        });
        const backgroundHex = String(result?.roles?.background || "").toUpperCase();
        if (!rolePair || !paletteSig || !visualSig || !panelSig || !/^#[0-9A-F]{6}$/.test(backgroundHex)) return false;
        if (!tileKeepsArtworkVisible(tile, compositionState.roleGrid)) return false;
        if (usedRolePairs.has(rolePair)) return false;
        if (usedPaletteSignatures.has(paletteSig)) return false;
        if (usedPanelSignatures.has(panelSig)) return false;
        if (!isBackgroundSeparated(backgroundHex, usedBackgrounds, minimumBgDistance)) return false;
        usedRolePairs.add(rolePair);
        usedPaletteSignatures.add(paletteSig);
        usedPanelSignatures.add(panelSig);
        usedBackgrounds.push(backgroundHex);
        return true;
      }

      for (let panelIndex = 0; panelIndex < panelCount; panelIndex += 1) {
        let accepted = null;
        const maxAttempts = 14;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const variant = buildHarmonicGridVariant({
            family,
            panelIndex,
            panelCount,
            attempt: attempt + (candidateIndex * 2),
            sheetNonce: sheetNonce + (candidateIndex * 7),
            classified: snapshot.classified,
            baseBackgroundHex: snapshot.rolePair.background,
          });
          const tile = canvas.buildMappedImageDataForComposition(compositionState, variant.mapping, variant.roles);
          if (!acceptGridPanel(variant, tile, panelIndex, attempt)) continue;
          accepted = { variant, tile };
          break;
        }
        if (!accepted) {
          const fallback = buildHarmonicGridVariant({
            family,
            panelIndex,
            panelCount,
            attempt: 99 + panelIndex + (candidateIndex * 9),
            sheetNonce: sheetNonce + (candidateIndex * 11),
            classified: snapshot.classified,
            baseBackgroundHex: snapshot.rolePair.background,
          });
          const fallbackTile = canvas.buildMappedImageDataForComposition(compositionState, fallback.mapping, fallback.roles);
          accepted = {
            variant: fallback,
            tile: tileKeepsArtworkVisible(fallbackTile, compositionState.roleGrid)
              ? fallbackTile
              : cloneImageDataLocal(baseTile),
          };
        }
        panelResults.push(accepted);
      }

      const record = buildGridSeriesRecord({
        family,
        layoutId,
        panelResults,
        snapshot,
      });
      return {
        sheetNonce,
        panelResults,
        variants: panelResults.map((entry) => entry.variant).filter(Boolean),
        tiles: panelResults.map((entry) => entry.tile || cloneImageDataLocal(baseTile)),
        record,
        score: scoreGridSeriesCandidate(record, history),
      };
    }

    const candidates = Array.from({ length: candidateCount }, (_, index) => buildSeriesCandidate(index))
      .filter((candidate) => Number.isFinite(candidate.score));
    const selectedSeries = candidates.sort((a, b) => b.score - a.score)[0] || buildSeriesCandidate(candidateCount + 5);
    const variants = selectedSeries.variants;
    const tiles = selectedSeries.tiles;
    const record = selectedSeries.record;
    state.gridSeriesNonce = selectedSeries.sheetNonce;

    if (variants[0]) {
      state.variantByFamily[family] = variants[0];
      state.activeStudioVariant = variants[0];
      state.activeStudioProvenance = buildGalleryProvenance({
        variant: variants[0],
        curatedPaletteMap: state.variantRailLocks.curatedMap ? state.curatedPaletteMap : {},
        familyModifiers: state.familyModifiers[family] || {},
        globalModifiers: state.globalModifiers,
        outputSignature: makeCanvasOutputSignature(),
        sourcePaletteSignature: variants[0].sourcePaletteSignature || currentSourcePaletteSignature(),
      });
    } else {
      state.activeStudioVariant = null;
      state.activeStudioProvenance = null;
    }

    state.noFieldLastFamily = family;
    state.isSheetMode = true;
    state.presentationMode = "sheet";
    state.lastReductionMode = "grid";
    state.lastPopSheetPanelSignatures = record.orderedPanelSignatures.slice();
    rememberRecentGridSeries(historyKey, record);
    canvas.setSheetTiles(tiles, cols, rows, currentGridFrameStyle());
    renderVariantPanel();
    updatePaletteGrid();
    setTopbarStatus(`${familyLabel} grid · ${label} · fresh series locked`);
    pulseStudio("variant");
  }

  function applyPopSheet(layoutId = state.popSheetLayout, styleId = state.popSheetStyle) {
    if (!state.selected) return;

    const { cols, rows, label } = getPopSheetSpec(layoutId);
    const snapshot = activeSingleCompositionSnapshot();
    const classified = snapshot?.classified || currentCreativeClassification();
    const compositionState = snapshot?.compositionState || canvas.exportCompositionState();
    const baseTile = snapshot?.imageData ? cloneImageDataLocal(snapshot.imageData) : canvas.exportCompositionImageData();
    const panelCount = cols * rows;
    const popStyle = normalizePopSheetStyle(styleId);
    const sheetNonce = (Number(state.popSheetBuildNonce) || 0) + 1;
    state.popSheetBuildNonce = sheetNonce;
    const previousPanelSignatures = Array.isArray(state.lastPopSheetPanelSignatures)
      ? state.lastPopSheetPanelSignatures
      : [];
    const usedRolePairs = new Set();
    const usedPaletteSignatures = new Set();
    const usedPanelSignatures = new Set();
    const usedBackgrounds = [];
    const minimumBgDistance = popStyle === POP_SHEET_STYLE_SCREENPRINT ? 0.07 : 0.1;
    const activeBackgroundHex = state.useActiveBg
      ? deriveNoMinimalismPair(selectedActiveHex(), state.noMinimalDeltaMode).background
      : null;

    if (popStyle === POP_SHEET_STYLE_SOFT) {
      const panelResults = Array.from({ length: panelCount }, (_, panelIndex) => (
        buildHarmonicGridVariant({
          family: "warhol",
          panelIndex,
          panelCount,
          posterize: true,
          classified,
          baseBackgroundHex: snapshot?.rolePair?.background || canvas.getGlobalRolePair().background,
        })
      ));
      const tiles = panelResults.map((panel) => {
        const tile = canvas.buildMappedImageDataForComposition(compositionState, panel.mapping, panel.roles);
        return tileKeepsArtworkVisible(tile, compositionState.roleGrid) ? tile : cloneImageDataLocal(baseTile);
      });
      state.variantByFamily.warhol = {
        family: "warhol",
        id: `warhol-sheet-${sheetNonce}`,
        name: `Pop Sheet · ${label}`,
        palette: [],
        roles: panelResults[0]?.roles || {
          background: "#000000",
          outline: "#040404",
        },
        ui: {
          chips: ["pop sheet", popSheetStyleLabel(popStyle)],
        },
      };
      state.activeStudioVariant = null;
      state.activeStudioProvenance = null;
      state.noFieldLastFamily = "warhol";
      state.isSheetMode = true;
      state.presentationMode = "sheet";
      state.lastReductionMode = "pop-sheet";
      state.lastPopSheetPanelSignatures = panelResults.map((panel) => (
        panelVisualSignature(panel, { style: popStyle, layout: layoutId })
      ));
      canvas.setSheetTiles(tiles, cols, rows, currentGridFrameStyle());
      renderVariantPanel();
      setTopbarStatus(`Pop Sheet · ${label} ${popSheetStyleStatusSlug(popStyle)} · harmonic poster panels`);
      pulseStudio("surprise");
      return;
    }

    function acceptPanel(result, panelIndex, attempt) {
      const rolePair = panelRolePairSignature(result);
      const paletteSig = makePanelPaletteSignature(result);
      const visualSig = panelVisualSignature(result, {
        style: popStyle,
        layout: layoutId,
      });
      const panelSig = panelSignature(result, {
        style: popStyle,
        layout: layoutId,
        panelSeed: panelIndex + (attempt * panelCount) + (sheetNonce * 997),
      });
      const backgroundHex = String(result?.roles?.background || "").toUpperCase();
      if (!rolePair || !paletteSig || !visualSig || !panelSig || !/^#[0-9A-F]{6}$/.test(backgroundHex)) return false;
      if (usedRolePairs.has(rolePair)) return false;
      if (usedPaletteSignatures.has(paletteSig)) return false;
      if (usedPanelSignatures.has(panelSig)) return false;
      if (!isBackgroundSeparated(backgroundHex, usedBackgrounds, minimumBgDistance)) return false;
      usedRolePairs.add(rolePair);
      usedPaletteSignatures.add(paletteSig);
      usedPanelSignatures.add(panelSig);
      usedBackgrounds.push(backgroundHex);
      return true;
    }

    function buildPanelResult(panelIndex) {
      const maxAttempts = 14;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const preset = createUniqueVariant("warhol", classified);
        const backgroundHex = computePopPanelBackground({
          classified,
          popStyle,
          panelIndex,
          panelCount,
          attempt,
          sheetNonce,
          activeBackgroundHex,
        });
        let result = buildFamilyResult(classified, "warhol", {
          preset,
          backgroundHex,
          traitPhase: (attempt + 1 + sheetNonce) * 0.23,
          panelIndex: panelIndex + (attempt * panelCount) + (sheetNonce * panelCount * 3),
          panelCount: panelCount * 2,
          popSheetStyle: popStyle,
        });
        if (popStyle === POP_SHEET_STYLE_SCREENPRINT) {
          result = applyScreenprintInverseRoleRule(result, classified);
        }
        if (attempt > 0) {
          result = diversifyPanelResult(result, panelIndex + attempt, classified);
          if (popStyle === POP_SHEET_STYLE_SCREENPRINT) {
            result = applyScreenprintInverseRoleRule(result, classified);
          }
        }
        if (!acceptPanel(result, panelIndex, attempt)) continue;
        return {
          preset,
          mapping: new Map(Object.entries(result.mapping || {}).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
          roles: result.roles,
        };
      }

      // Deterministic divergence fallback: never return duplicate panel signatures.
      let fallbackPreset = createUniqueVariant("warhol", classified);
      let fallback = buildFamilyResult(classified, "warhol", {
        preset: fallbackPreset,
        backgroundHex: computePopPanelBackground({
          classified,
          popStyle,
          panelIndex,
          panelCount,
          attempt: 999 + panelIndex,
          sheetNonce,
          activeBackgroundHex,
        }),
        traitPhase: 0.17 + panelIndex + (sheetNonce * 0.11),
        panelIndex: panelIndex + (sheetNonce * panelCount * 5),
        panelCount,
        popSheetStyle: popStyle,
      });
      if (popStyle === POP_SHEET_STYLE_SCREENPRINT) {
        fallback = applyScreenprintInverseRoleRule(fallback, classified);
      }
      for (let force = 0; force < 10; force += 1) {
        let candidate = diversifyPanelResult(fallback, panelIndex + 11 + force, classified);
        if (popStyle === POP_SHEET_STYLE_SCREENPRINT) {
          candidate = applyScreenprintInverseRoleRule(candidate, classified);
        }
        if (!acceptPanel(candidate, panelIndex, 1000 + force)) continue;
        return {
          preset: fallbackPreset,
          mapping: new Map(Object.entries(candidate.mapping || {}).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
          roles: candidate.roles,
        };
      }

      // Hard uniqueness fallback: deterministic branch nonce until signatures diverge.
      for (let force = 0; force < 24; force += 1) {
        const forcedBg = computePopPanelBackground({
          classified,
          popStyle,
          panelIndex,
          panelCount,
          attempt: 777 + panelIndex + (force * 7),
          sheetNonce,
          activeBackgroundHex,
        });
        let forced = buildFamilyResult(classified, "warhol", {
          preset: fallbackPreset,
          backgroundHex: forcedBg,
          traitPhase: 2.1 + panelIndex + (force * 0.13) + (sheetNonce * 0.17),
          panelIndex: panelIndex + (panelCount * (9 + force)) + (sheetNonce * panelCount * 7),
          panelCount: panelCount * 4,
          popSheetStyle: popStyle,
        });
        forced = diversifyPanelResult(forced, panelIndex + 41 + force, classified);
        if (popStyle === POP_SHEET_STYLE_SCREENPRINT) {
          forced = applyScreenprintInverseRoleRule(forced, classified);
        }
        if (!acceptPanel(forced, panelIndex, 3000 + force)) continue;
        return {
          preset: fallbackPreset,
          mapping: new Map(Object.entries(forced.mapping || {}).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
          roles: forced.roles,
        };
      }

      throw new Error(`Unable to generate unique ${label} pop sheet panel ${panelIndex + 1}`);
    }

    let panelResults;
    try {
      panelResults = Array.from({ length: panelCount }, (_, panelIndex) => buildPanelResult(panelIndex));
    } catch (error) {
      setTopbarStatus(error.message || "Pop Sheet render failed");
      return;
    }

    const tiles = panelResults.map((panel, panelIndex) => {
      const tile = canvas.buildMappedImageDataForComposition(compositionState, Object.fromEntries(panel.mapping || []), panel.roles);
      if (popStyle === POP_SHEET_STYLE_SCREENPRINT) {
        for (let index = 0; index < compositionState.roleGrid.length; index += 1) {
          if (compositionState.roleGrid[index] !== "c") continue;
          const x = index % 24;
          const y = Math.floor(index / 24);
          const idx = index * 4;
          const currentHex = rgbToHex(tile.data[idx], tile.data[idx + 1], tile.data[idx + 2]).toUpperCase();
          const nextHex = applyScreenprintInkMask(currentHex, panel.roles, x, y, panelIndex);
          const rgb = hexToRgb(nextHex);
          tile.data[idx] = rgb.r;
          tile.data[idx + 1] = rgb.g;
          tile.data[idx + 2] = rgb.b;
        }
      }
      return tileKeepsArtworkVisible(tile, compositionState.roleGrid) ? tile : cloneImageDataLocal(baseTile);
    });

    state.variantByFamily.warhol = {
      family: "warhol",
      id: `warhol-sheet-${sheetNonce}`,
      name: `Pop Sheet · ${label}`,
      palette: [],
      roles: panelResults[0]?.roles || {
        background: "#000000",
        outline: "#040404",
      },
      ui: {
        chips: ["pop sheet", popSheetStyleLabel(popStyle)],
      },
    };
    state.activeStudioVariant = null;
    state.activeStudioProvenance = null;
    state.noFieldLastFamily = "warhol";
    state.isSheetMode = true;
    state.presentationMode = "sheet";
    state.lastReductionMode = "pop-sheet";
    state.lastPopSheetPanelSignatures = panelResults.map((panel) => (
      panelVisualSignature(panel, { style: popStyle, layout: layoutId })
    ));
    canvas.setSheetTiles(tiles, cols, rows, currentGridFrameStyle());
    renderVariantPanel();
    setTopbarStatus(`Pop Sheet · ${label} ${popSheetStyleStatusSlug(popStyle)} · full 24×24 tile per panel`);
    pulseStudio("surprise");
  }

  function clampUnit(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  function quantizeUnit(value, levels) {
    const maxLevel = Math.max(1, Math.round(levels) - 1);
    return Math.round(clampUnit(value) * maxLevel) / maxLevel;
  }

  function familyToneTarget(family) {
    const toneCount = Math.max(2, Math.min(8, Math.round(Number(state.globalModifiers.toneCount) || 5)));
    if (family === "warhol") return Math.max(4, toneCount);
    if (family === "acid") return Math.max(5, toneCount);
    if (family === "pastel") return Math.max(4, toneCount);
    return toneCount;
  }

  function createFamilyHueBank(family, bgHue, fm, panelIndex, panelCount, driftNorm, popSheetStyle = POP_SHEET_STYLE_POSTER) {
    if (family === "mono") {
      const drift = Number(fm.hueDrift) || 0;
      const spread = Math.max(4, drift * 0.9);
      return [bgHue, bgHue + spread, bgHue - spread];
    }
    if (family === "noir") {
      return [bgHue, bgHue + 10, bgHue - 10];
    }
    if (family === "warhol") {
      const divergence = clampUnit((Number(fm.panelDivergence) || 0) / 100);
      if (popSheetStyle === POP_SHEET_STYLE_SCREENPRINT) {
        const panelShift = panelCount > 1
          ? (((panelIndex / Math.max(1, panelCount - 1)) - 0.5) * 56 * divergence)
          : 0;
        return [
          bgHue + 22 + panelShift,
          bgHue + 164 + panelShift,
          bgHue + 304 + panelShift,
        ];
      }
      const panelShift = panelCount > 1
        ? (((panelIndex / Math.max(1, panelCount - 1)) - 0.5) * 140 * divergence)
        : 0;
      return [
        bgHue + 96 + panelShift,
        bgHue + 186 + panelShift,
        bgHue + 268 + panelShift,
        bgHue + 318 + panelShift,
      ];
    }
    if (family === "acid") {
      const clash = Number(fm.clashAngle) || 132;
      return [
        bgHue + clash,
        bgHue - clash,
        bgHue + 180,
      ];
    }
    return [
      bgHue + (22 + (driftNorm * 10)),
      bgHue - (18 + (driftNorm * 8)),
      bgHue + 52,
    ];
  }

  function applyStyledFamilyMapping(
    result,
    classified,
    family,
    { preset = null, traitPhase = 0, panelIndex = 0, panelCount = 1, popSheetStyle = POP_SHEET_STYLE_POSTER } = {},
  ) {
    const mapping = { ...(result?.mapping || {}) };
    const roles = result?.roles || {};
    const entries = (classified || []).filter((entry) => entry.role !== "background" && entry.role !== "outline");
    if (!entries.length) {
      return { mapping, roles };
    }

    const sortedEntries = entries.slice().sort((a, b) => hexLuma(a.hex) - hexLuma(b.hex));
    const used = new Set([String(roles.background || "").toUpperCase(), String(roles.outline || "").toUpperCase()]);
    const forbidden = new Set((classified || []).map((entry) => String(entry?.hex || "").toUpperCase()));
    forbidden.add(BRAND_ROLE_BG);
    forbidden.add(BRAND_ROLE_FG);
    // For screenprint, inks must render dark/rich against the background.
    // The outline is barely-different-from-bg (bg+4), so the normal luma-floor
    // would bleach all ink colours toward white — override it to a fixed low value.
    const outlineLuma = hexLuma(roles.outline || BRAND_ROLE_FG);
    const floor = (family === "warhol" && popSheetStyle === POP_SHEET_STYLE_SCREENPRINT)
      ? 2
      : outlineLuma + 2;
    const gm = state.globalModifiers;
    const fm = state.familyModifiers[family] || {};
    const profile = getFamilyProfile(family);
    const contrastNorm = clampUnit(gm.contrast / 100);
    const traitNorm = clampUnit(gm.traitFocus / 100);
    const driftNorm = clampUnit(gm.paletteDrift / 100);
    const total = Math.max(1, sortedEntries.length - 1);

    const bgRgb = hexToRgb(roles.background || "#000000");
    const bgHsl = rgbToHsl(bgRgb.r, bgRgb.g, bgRgb.b);
    const hueBank = createFamilyHueBank(family, bgHsl.h, fm, panelIndex, panelCount, driftNorm, popSheetStyle)
      .map((value) => ((value % 360) + 360) % 360);
    const targetTones = familyToneTarget(family);
    const toneLevels = Math.max(profile.quantMin, Math.min(profile.quantMax, targetTones));
    const midpoint = (profile.light[0] + profile.light[1]) / 2;
    const presetPhase = Number(preset?.variantPhase ?? preset?.phase ?? preset?.huePhase ?? preset?.driftPhase ?? 0);
    const presetContrast = clampUnit(Number(preset?.contrast ?? 1) / 2.2);

    for (let idx = 0; idx < sortedEntries.length; idx += 1) {
      const entry = sortedEntries[idx];
      const rank = idx / total;
      const role = entry.role || "body";
      const pulse = Math.sin(((idx + 1) * 1.17) + (traitPhase * 0.37) + (presetPhase * 0.6));
      const baseHue = hueBank[(idx + (role === "accent" ? 1 : 0)) % hueBank.length];
      let hue = (baseHue + (pulse * (6 + (driftNorm * 12))) + (panelIndex * 1.6) + 720) % 360;
      let sat = lerp(profile.sat[0], profile.sat[1], rank);
      let light = lerp(profile.light[0], profile.light[1], rank);
      let levels = toneLevels;

      if (family === "mono") {
        const hueDrift = (Number(fm.hueDrift) || 0) * (0.2 + (driftNorm * 0.7));
        const stepCompression = clampUnit((Number(fm.stepCompression) || 0) / 100);
        hue = (bgHsl.h + (pulse * hueDrift) + (driftNorm * 5) + 360) % 360;
        sat = clampUnit(lerp(0.02, 0.18, rank) + (role === "accent" ? (traitNorm * 0.06) : 0));
        levels = Math.max(2, Math.round(lerp(levels, 2, stepCompression)));
      } else if (family === "noir") {
        const shadowDepth = clampUnit((Number(fm.shadowDepth) || 0) / 100);
        const accentGate = clampUnit((Number(fm.accentGate) || 0) / 100);
        const depthLayers = Math.max(3, Math.min(8, Math.round(Number(preset?.depthLayers) || 4)));
        const layerIndex = idx % depthLayers;
        const layerT = layerIndex / Math.max(1, depthLayers - 1);
        const layerPulse = Math.sin((layerT * Math.PI * 2) + (presetPhase * 0.7) + (traitPhase * 0.23));
        const chiaroscuro = clampUnit(Number(preset?.chiaroscuro) || 0.5);
        const voidBias = clampUnit(Number(preset?.voidBias) || 0.42);
        const spectralTilt = Number(preset?.spectralTilt) || 0;
        const darkLift = Math.max(0.16, 0.34 - (shadowDepth * 0.14));
        const schemeId = String(preset?.noirScheme || "classic-noir");
        const scheme = NOIR_COLOR_SCHEMES.find((entry) => entry.id === schemeId) || NOIR_COLOR_SCHEMES[0];
        const anchors = Array.isArray(scheme.anchors) && scheme.anchors.length
          ? scheme.anchors
          : NOIR_COLOR_SCHEMES[0].anchors;
        const rampSpan = Math.max(1, anchors.length - 2);
        const rampIdx = Math.min(rampSpan, Math.max(0, Math.round(rank * rampSpan)));
        const anchorHex = role === "accent"
          ? anchors[anchors.length - 1]
          : anchors[rampIdx];
        const anchorRgb = hexToRgb(anchorHex);
        const anchorHsl = rgbToHsl(anchorRgb.r, anchorRgb.g, anchorRgb.b);
        const noirPhase = Number(preset?.noirPhase || 0);
        hue = (
          anchorHsl.h
          + (spectralTilt * (layerT - 0.5) * 0.35)
          + (pulse * (1.6 + (driftNorm * 1.8)))
          + ((noirPhase - 0.5) * 12)
          + 360
        ) % 360;
        sat = clampUnit(
          (anchorHsl.s * (0.64 + ((1 - accentGate) * 0.08)))
          + 0.012
          + (layerT * 0.05)
          + (Math.abs(layerPulse) * 0.016)
          + (role === "accent" ? ((1 - accentGate) * 0.075) : 0),
        );
        light = clampUnit(
          (anchorHsl.l * (0.66 + ((1 - shadowDepth) * 0.16)))
          + (rank * darkLift * (0.52 + (chiaroscuro * 0.28)))
          + (layerPulse * (0.012 + (chiaroscuro * 0.026)))
          + (role === "accent" ? ((1 - accentGate) * 0.082) : 0)
          + (voidBias * 0.012),
        );
        if (role !== "accent") {
          light = Math.min(0.56, light);
        }
        levels = Math.max(3, Math.min(5, levels));
      } else if (family === "warhol") {
        const flatness = clampUnit((Number(fm.flatness) || 0) / 100);
        if (popSheetStyle === POP_SHEET_STYLE_SCREENPRINT) {
          // Rich spot-ink palette: saturated enough to read against light paper ground
          sat = clampUnit(0.70 + ((1 - flatness) * 0.20) + (role === "accent" ? 0.10 : 0));
          levels = 3;
          light = clampUnit(0.15 + (rank * 0.42) + (role === "accent" ? 0.10 : 0));
        } else {
          const posterBand = Math.round(clampUnit(rank) * 2) / 2;
          sat = clampUnit(0.84 + ((1 - flatness) * 0.14) + (role === "accent" ? 0.08 : 0));
          levels = 3;
          light = clampUnit(
            0.18
            + (posterBand * 0.62)
            + (role === "accent" ? 0.08 : 0)
            + (Math.sin((panelIndex * 0.8) + idx) * 0.03),
          );
        }
      } else if (family === "acid") {
        const corrosion = clampUnit((Number(fm.corrosion) || 0) / 100);
        sat = clampUnit(0.82 + (corrosion * 0.16));
        light = clampUnit(0.14 + (rank * 0.58) + (pulse * 0.08 * corrosion) + (role === "accent" ? 0.06 : 0));
      } else if (family === "pastel") {
        const softness = clampUnit((Number(fm.powderSoftness) || 0) / 100);
        const airLift = clampUnit((Number(fm.airLift) || 0) / 100);
        sat = clampUnit(0.08 + ((1 - softness) * 0.22) + (role === "accent" ? 0.03 : 0));
        light = clampUnit(0.64 + (airLift * 0.24) + (rank * 0.18) - (softness * 0.06));
        levels = Math.max(3, Math.round(lerp(7, 4, softness)));
      }

      const contrastScale = lerp(0.72, 1.38, (contrastNorm * 0.7) + (presetContrast * 0.3));
      light = clampUnit(midpoint + ((light - midpoint) * contrastScale));
      if (role === "accent") {
        sat = clampUnit(sat + (traitNorm * 0.09));
        light = clampUnit(light + (traitNorm * profile.accentLift));
      } else if (role === "neutral") {
        sat = clampUnit(sat + (traitNorm * 0.03));
      }
      hue = (hue + (pulse * 14 * driftNorm) + 720) % 360;
      light = quantizeUnit(light, levels);

      const rgb = hslToRgb(hue, sat, light);
      let mappedHex = rgbToHex(rgb.r, rgb.g, rgb.b);
      if (hexLuma(mappedHex) <= floor) {
        mappedHex = mixHex(mappedHex, "#FFFFFF", 0.2 + (traitNorm * 0.1));
      }
      mapping[entry.hex] = ensureDistinctHex(mappedHex, used, { floor, forbidden });
    }

    return { mapping, roles };
  }

  function buildFamilyResult(classified, family, {
    preset,
    backgroundHex = null,
    traitPhase = 0,
    panelIndex = 0,
    panelCount = 1,
    popSheetStyle = POP_SHEET_STYLE_POSTER,
  } = {}) {
    const toneTarget = familyToneTarget(family);
    const effectivePreset = preset || createUniqueVariant(family, classified);
    const base = applyPreset(effectivePreset, classified, {
      toneStep: DEFAULT_TONE_STEP,
      roleStep: activeRoleStep(),
      backgroundHex,
    });
    const strictRoles = enforceRolePairRules(base, classified, backgroundHex, family);
    const collapsed = collapsePresetResult(classified, strictRoles, toneTarget);
    const styled = applyStyledFamilyMapping(collapsed, classified, family, {
      preset: effectivePreset,
      traitPhase,
      panelIndex,
      panelCount,
      popSheetStyle,
    });
    return {
      preset: effectivePreset,
      mapping: styled.mapping,
      roles: styled.roles,
      toneTarget,
    };
  }

  function resolveBackgroundForCast(family, { refreshWorld = true } = {}) {
    if (state.useActiveBg) {
      return deriveNoMinimalismPair(selectedActiveHex(), state.noMinimalDeltaMode).background;
    }
    if (!refreshWorld) {
      return ensureNoMinimalPreviewPair().background;
    }
    const worldBg = familyWorldBackgroundHex(family);
    state.noMinimalPreviewPair = deriveNoMinimalismPair(worldBg, state.noMinimalDeltaMode);
    return state.noMinimalPreviewPair.background;
  }

  function runNoFieldPass({ family = activeCreativeFamily(), statusPrefix = "Cast" } = {}) {
    if (!state.selected) {
      setServerStatus("Select a NoPunk first.");
      return null;
    }

    state.isSheetMode = false;
    canvas.setSubdivision(1);
    invalidateVariantRailState(family);
    return loadVariantFromRail(family, 0, 0, { statusPrefix });
  }

  function applyNoMinimalism() {
    if (!state.selected || !state.originalRoleMap) return;

    state.isSheetMode = false;
    canvas.setSubdivision(1);
    const current = canvas.exportImageData();
    const next = new Uint8ClampedArray(current.data);
    const occupied = canvas.getOccupied();
    const pair = refreshNoMinimalPreviewPair();

    for (let y = 0; y < current.height; y += 1) {
      for (let x = 0; x < current.width; x += 1) {
        const i = (y * current.width + x) * 4;
        let targetHex = pair.background;
        if (occupied.has(`${x},${y}`)) {
          targetHex = pair.figure;
        }
        const rgb = hexToRgb(targetHex);
        next[i] = rgb.r;
        next[i + 1] = rgb.g;
        next[i + 2] = rgb.b;
        next[i + 3] = 255;
      }
    }

    state.lastReductionMode = "no-minimalism";
    state.activeStudioVariant = null;
    state.activeStudioProvenance = null;
    canvas.applyImageData(new ImageData(next, current.width, current.height));
    renderHeroRolePair();
    setTopbarStatus(`No-Minimalism ${state.noMinimalDeltaMode} · ${pair.background} → ${pair.figure} · ${pair.roleStep} lift · 2 tones`);
    pulseStudio("reduce");
  }

  function renderVariantPanel() {
    const activeTab = state.activePresetTab;
    const current = state.variantByFamily[activeTab] || null;
    const familyLabel = FAMILY_LABELS[activeTab] || "Studio";
    const rail = railStateForFamily(activeTab);
    const currentPage = rail.pages[String(rail.pageIndex)] || null;
    const world = current?.rolePair || ensureStudioCastPreviewPair();
    const familyHint = {
      mono: "Single-hue ladders that keep the canvas tight but not repetitive.",
      chrome: "Reflective ramps with cleaner highlights and colder metallic lift.",
      warhol: "Poster-pop casting with stronger panel separation and warmer/cooler plate pressure.",
      acid: "Controlled clash pairs with deeper grounds and sharper toxic contrast.",
      pastel: "High-light analogous banks with softer drift and more breathing room.",
    }[activeTab] || "Families launch from the live canvas, not from a locked source rerender.";
    const railCards = currentPage?.variants?.length
      ? currentPage.variants.map((variant, slotIndex) => {
          const isActive = current?.id === variant.id || rail.activeVariantId === variant.id;
          const paletteStrip = (variant.palette || []).slice(0, 5).map((hex) => `<span class="variant-rail-swatch" style="background:${escapeHtml(hex)}" title="${escapeHtml(hex)}"></span>`).join("");
          const chip = String((variant.ui?.chips || [])[0] || "");
          return `
            <button class="variant-rail-card${isActive ? " is-active" : ""}" type="button" data-action="load-rail-variant" data-family="${activeTab}" data-page="${currentPage.pageIndex}" data-slot="${slotIndex}">
              <span class="variant-rail-head">
                <strong>${escapeHtml(variant.name || `${familyLabel} Variant`)}</strong>
                <span>${variant.score.toFixed(1)}</span>
              </span>
              <span class="variant-rail-strip">${paletteStrip}</span>
              <span class="variant-rail-chips">${chip ? `<span class="variant-rail-chip">${escapeHtml(chip)}</span>` : ""}</span>
            </button>
          `;
        }).join("")
      : `<div class="variant-rail-empty">Cast ${escapeHtml(familyLabel)} to open four fast options.</div>`;

    const gridAction = `
      <div class="theory-rail pop-sheet-rail">
        <button class="theory-btn${state.popSheetLayout === "1x3" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="1x3">1x3</button>
        <button class="theory-btn${state.popSheetLayout === "2x2" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="2x2">2x2</button>
        <button class="theory-btn${state.popSheetLayout === "3x3" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="3x3">3x3</button>
        <button class="theory-btn${state.popSheetLayout === "4x4" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="4x4">4x4</button>
      </div>
      <div class="theory-rail pop-sheet-rail">
        ${Object.entries(GRID_FRAME_TONES).map(([toneId, tone]) => `
          <button class="theory-btn${state.gridFrameTone === toneId ? " is-active" : ""}" type="button" data-action="set-grid-frame-tone" data-frame-tone="${toneId}">${escapeHtml(tone.label)}</button>
        `).join("")}
      </div>
      ${activeTab === "warhol" ? `
        <div class="theory-rail pop-sheet-rail">
          <button class="theory-btn${state.popSheetStyle === POP_SHEET_STYLE_SOFT ? " is-active" : ""}" type="button" data-action="set-pop-style" data-pop-style="${POP_SHEET_STYLE_SOFT}">Soft</button>
          <button class="theory-btn${state.popSheetStyle === POP_SHEET_STYLE_POSTER ? " is-active" : ""}" type="button" data-action="set-pop-style" data-pop-style="${POP_SHEET_STYLE_POSTER}">Poster</button>
          <button class="theory-btn${state.popSheetStyle === POP_SHEET_STYLE_SCREENPRINT ? " is-active" : ""}" type="button" data-action="set-pop-style" data-pop-style="${POP_SHEET_STYLE_SCREENPRINT}">Screen</button>
        </div>
      ` : ""}
      <div class="variant-action-grid">
        <button class="preset-btn" type="button" data-action="build-grid">Build Grid</button>
        ${activeTab === "warhol" ? `<button class="preset-btn" type="button" data-action="build-pop-sheet">Posterize</button>` : ""}
      </div>
    `;

    els.presetList.innerHTML = `
      <div class="variant-panel no-field-panel">
        <div class="mini-note no-field-guidance">${escapeHtml(familyHint)}</div>
        <div class="role-pair-readout">Role pair · ${escapeHtml(world.background)} → ${escapeHtml(world.figure)} · ${world.roleStep} lift</div>
        <div class="variant-action-grid variant-action-grid--rail">
          <button class="preset-btn" type="button" data-action="render-core" data-family="${activeTab}">Cast ${escapeHtml(familyLabel)}</button>
          <button class="preset-btn" type="button" data-action="rail-next" data-family="${activeTab}">Mutate</button>
        </div>
        ${gridAction}
        <div class="variant-title">${escapeHtml(current?.name || "Live canvas mutation ready")}</div>
        <div class="variant-chips">
          ${variantChipsMarkup(current)}
        </div>
        <div class="variant-title">Quick Picks</div>
        <div class="variant-rail-grid">
          ${railCards}
        </div>
      </div>
    `;
  }

  function renderPresetList() {
    renderVariantPanel();
  }

  els.presetList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "render-core") {
      const family = btn.dataset.family || activeCreativeFamily();
      runNoFieldPass({ family, statusPrefix: `Render ${FAMILY_LABELS[family] || "Studio"}` });
      return;
    }
    if (btn.dataset.action === "build-pop-sheet") {
      applyPopSheet(state.popSheetLayout || "4x4", POP_SHEET_STYLE_POSTER);
      return;
    }
    if (btn.dataset.action === "build-grid") {
      applyVariantGrid(state.popSheetLayout || "4x4", { family: activeCreativeFamily() });
      return;
    }
    if (btn.dataset.action === "set-pop-sheet") {
      state.popSheetLayout = btn.dataset.layout || "4x4";
      renderVariantPanel();
      setTopbarStatus(`Grid layout ${state.popSheetLayout} armed`);
      persistSession();
      return;
    }
    if (btn.dataset.action === "set-pop-style") {
      state.popSheetStyle = normalizePopSheetStyle(btn.dataset.popStyle || POP_SHEET_STYLE_SOFT);
      renderVariantPanel();
      setTopbarStatus(`Posterize style ${popSheetStyleLabel(state.popSheetStyle)} armed`);
      persistSession();
      return;
    }
    if (btn.dataset.action === "set-grid-frame-tone") {
      const nextTone = btn.dataset.frameTone || "cream";
      state.gridFrameTone = GRID_FRAME_TONES[nextTone] ? nextTone : "cream";
      renderVariantPanel();
      setTopbarStatus(`Grid frame ${GRID_FRAME_TONES[state.gridFrameTone].label} armed`);
      persistSession();
      return;
    }
    if (btn.dataset.action === "rail-next") {
      const family = btn.dataset.family || activeCreativeFamily();
      const rail = railStateForFamily(family);
      loadVariantFromRail(family, rail.pageIndex + 1, 0, { statusPrefix: "Mutate" });
      return;
    }
    if (btn.dataset.action === "load-rail-variant") {
      const family = btn.dataset.family || activeCreativeFamily();
      loadVariantFromRail(family, Number(btn.dataset.page) || 0, Number(btn.dataset.slot) || 0, { statusPrefix: "Cast" });
      return;
    }
  });

  let variantPanelRafId = 0;
  function scheduleVariantPanelRender() {
    if (variantPanelRafId) return;
    variantPanelRafId = requestAnimationFrame(() => {
      variantPanelRafId = 0;
      renderVariantPanel();
    });
  }

  els.presetList.addEventListener("input", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    if (target.dataset.action === "set-family-modifier") {
      const family = activeCreativeFamily();
      const key = String(target.dataset.key || "");
      if (!key) return;
      const next = { ...(state.familyModifiers[family] || {}) };
      next[key] = Number(target.value) || 0;
      state.familyModifiers = {
        ...state.familyModifiers,
        [family]: next,
      };
      invalidateVariantRailState(family);
      scheduleVariantPanelRender();
    }
  });

  function surpriseMe() {
    if (!state.selected) {
      setServerStatus("Select a NoPunk first.");
      return;
    }
    const families = FAMILY_IDS.slice();
    let accepted = false;
    let chosenFamily = activeCreativeFamily();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      chosenFamily = pickOne(families) || chosenFamily;
      setActivePresetTab(chosenFamily);
      runNoFieldPass({ family: chosenFamily, statusPrefix: "Cast" });
      const signature = makeCanvasOutputSignature();
      if (rememberOutputSignature(signature)) {
        accepted = true;
        break;
      }
    }

    if (!accepted) {
      rememberOutputSignature(makeCanvasOutputSignature());
    }

    setTopbarStatus(`Cast · ${FAMILY_LABELS[chosenFamily] || "Studio"} · surprise world`);
    pulseStudio("surprise");
  }

  els.surpriseBtn?.addEventListener("click", () => surpriseMe());
  els.heroNoMinimal?.addEventListener("click", () => applyNoMinimalism());

  renderPresetList();
  els.applyNoise?.addEventListener("click", applyNoise);

  // ── Export ────────────────────────────────────────────────────

  function updateExportButtons() {
    const ok = state.selected != null;
    const grain = canvas.getDisplayGrain();
    const hasNoiseMask = canvas.getNoiseMaskCoordinates().length > 0;
    const sharedGalleryReady = state.noGalleryAvailable && state.globalGalleryEnabled && state.galleryStorage !== "unavailable";
    els.exportPng.disabled = !ok;
    els.exportGif.disabled = !ok || !grain.enabled || !(grain.amount > 0) || !hasNoiseMask;
    if (els.saveGalleryPng) {
      els.saveGalleryPng.disabled = !ok || state.gallerySaving || !sharedGalleryReady;
    }
    if (els.saveGalleryGif) {
      els.saveGalleryGif.disabled = !ok || state.gallerySaving || !grain.enabled || !(grain.amount > 0) || !hasNoiseMask || !sharedGalleryReady;
    }
    els.exportReset.disabled = !ok;
  }

  function downloadUrl(url, fileName = "") {
    const link = document.createElement("a");
    link.href = url;
    if (fileName) {
      link.download = fileName;
    }
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function exportNoiseGifInBrowser({
    size = 1024,
    frames: frameCount = 12,
    durationMs = 1000,
  } = {}) {
    const grain = canvas.getDisplayGrain();
    const frames = [];
    const baseSeed = Math.max(0, Number(grain.seed) || 0);
    const totalFrames = Math.max(4, Math.min(24, Math.round(Number(frameCount) || 12)));
    const renderSize = Math.max(256, Math.min(1024, Math.round(Number(size) || 1024)));
    for (let i = 0; i < totalFrames; i += 1) {
      const sourceCanvas = canvas.exportPng1024({
        grain: {
          ...grain,
          enabled: true,
          seed: baseSeed + i,
        },
      });
      let frameCanvas = sourceCanvas;
      if (renderSize !== 1024) {
        frameCanvas = document.createElement("canvas");
        frameCanvas.width = renderSize;
        frameCanvas.height = renderSize;
        const frameScaleCtx = frameCanvas.getContext("2d");
        frameScaleCtx.imageSmoothingEnabled = false;
        frameScaleCtx.drawImage(sourceCanvas, 0, 0, renderSize, renderSize);
      }
      const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
      const frameImage = frameCtx.getImageData(0, 0, renderSize, renderSize);
      frames.push(quantizeImageDataToRgb332(frameImage));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const gifBytes = encodeIndexedGif({
      width: renderSize,
      height: renderSize,
      frames,
      delayMs: Math.max(20, Math.round((Number(durationMs) || 1000) / totalFrames)),
      loop: 0,
    });
    return {
      frames: totalFrames,
      blob: new Blob([gifBytes], { type: "image/gif" }),
    };
  }

  els.exportPng.addEventListener("click", () => {
    if (!state.selected) return;
    exportCanvasPng(canvas.exportPng1024(), `nopunk-${state.selected.id}-no-studio.png`);
  });

  els.exportGif.addEventListener("click", async () => {
    if (!state.selected) return;
    const grain = canvas.getDisplayGrain();
    if (!grain.enabled || !(grain.amount > 0)) {
      setTopbarStatus("Animated GIF requires active grain");
      return;
    }

    const originalLabel = els.exportGif.textContent;
    els.exportGif.disabled = true;
    els.exportGif.textContent = "Rendering GIF...";
    studioEl.classList.add("is-exporting");
    setTopbarStatus("Rendering animated grain GIF...");

    try {
      const fileName = `nopunk-${state.selected.id}-no-studio-noise.gif`;
      if (state.noiseGifAvailable && !canvas.hasSheet() && !state.singleFrameEnabled) {
        try {
          const imageData = canvas.exportCompositionImageData();
          const rgba24B64 = encodeRgba24B64(imageData.data);
          const noiseMask = canvas.getNoiseMaskCoordinates();
          const payload = await renderNoStudioNoiseGif({
            tokenId: state.selected.id,
            rgba24B64,
            noiseMask,
            grain,
          });
          downloadUrl(`${payload.output.gifUrl}?download=1`, fileName);
          setTopbarStatus(`Animated grain GIF · ${payload.output.frames} frames · 1s`);
          return;
        } catch (error) {
          if (!/requires the local No-Studio server/i.test(String(error.message || ""))) {
            throw error;
          }
        }
      }

      const browserGif = await exportNoiseGifInBrowser({
        size: 1024,
        frames: 12,
        durationMs: 1000,
      });
      downloadBlob(browserGif.blob, fileName);
      setTopbarStatus(`Animated grain GIF · ${browserGif.frames} frames · 1s`);
    } catch (error) {
      setTopbarStatus(error.message || "Animated GIF export failed");
    } finally {
      studioEl.classList.remove("is-exporting");
      els.exportGif.textContent = originalLabel;
      updateExportButtons();
    }
  });

  els.exportReset.addEventListener("click", () => {
    if (!state.selected) return;
    canvas.reset();
    canvas.clearDisplayGrain();
    updatePaletteGrid();
    updateExportButtons();
    setTopbarStatus("Stage reset · grain cleared");
  });

  els.saveGalleryPng?.addEventListener("click", () => {
    saveCurrentToGallery({ mediaKind: "png" });
  });

  els.saveGalleryGif?.addEventListener("click", () => {
    saveCurrentToGallery({ mediaKind: "gif" });
  });

  els.gallerySignature?.addEventListener("change", () => {
    const normalized = normalizeSignatureHandle(els.gallerySignature.value);
    state.gallerySignature = normalized;
    els.gallerySignature.value = normalized;
    persistSession();
  });

  els.galleryRefresh?.addEventListener("click", () => {
    refreshGallery();
  });

  els.galleryList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-gallery-react][data-gallery-reaction]");
    if (!button) return;
    event.preventDefault();
    const id = String(button.getAttribute("data-gallery-react") || "");
    const reaction = String(button.getAttribute("data-gallery-reaction") || "no");
    if (!id) return;
    try {
      const payload = await voteNoStudioGallery(id, reaction);
      if (!payload?.item) return;
      state.galleryItems = state.galleryItems.map((entry) => String(entry?.id || "") === String(payload.item.id)
        ? { ...entry, ...payload.item }
        : entry);
      renderGallery();
    } catch (error) {
      setTopbarStatus(error.message || "Vote failed");
    }
  });

  // ── Sidebar toggle / dock drawer ──────────────────────────────

  els.sidebarToggle?.addEventListener("click", () => setSidebarOpen(!els.sidebar.classList.contains("is-open")));
  els.mobileDockToggle?.addEventListener("click", () => setSidebarOpen(!els.sidebar.classList.contains("is-open")));
  els.dockDismiss?.addEventListener("click", () => setSidebarOpen(false));
  els.dockScrim?.addEventListener("click", () => setSidebarOpen(false));
  mobileDockQuery.addEventListener("change", handleDockMediaChange);

  // ── Punk Picker ───────────────────────────────────────────────

  const picker = mountPunkPicker(els.pickerHost, {
    title: "Source Drawer",
    subtitle: "Load a NoPunk, then build from a clean 24x24 start",
    placeholder: "Search #7804, alien, pipe...",
    autoSelectFirst: true,
    maxResults: 12,
    getSelectedIds: () => (state.selected ? [state.selected.id] : []),
    onPick: (item) => { setSelectedPunk(item); picker.refreshSelection(); },
  });

  syncRestoreSessionButton();

  els.restoreLastSession?.addEventListener("click", async () => {
    const saved = restoreCanvasSession;
    if (!isRestorableCanvasSession(saved)) return;
    if (state.selected && Number(saved.selectedTokenId) === Number(state.selected.id) && state.originalImageData) {
      canvas.loadSessionState(saved);
      renderNoiseTargetRail();
      updatePaletteGrid();
      setTopbarStatus(`Restored last session on #${state.selected.id}`);
      return;
    }
    if (saved.selectedTokenId == null) {
      setTopbarStatus("Saved session has no source token");
      return;
    }
    restoreSessionArmed = true;
    pendingCanvasSession = saved;
    try {
      const payload = await searchPunks(String(saved.selectedTokenId), 1);
      if (state.disposed) return;
      const item = (payload.items || []).find((entry) => Number(entry.id) === Number(saved.selectedTokenId));
      if (!item) {
        restoreSessionArmed = false;
        pendingCanvasSession = null;
        setTopbarStatus("Saved source punk was not found");
        return;
      }
      await setSelectedPunk(item);
      picker.refreshSelection();
    } catch (error) {
      restoreSessionArmed = false;
      pendingCanvasSession = null;
      setTopbarStatus(error.message || "Restore failed");
    }
  });

  async function setSelectedPunk(item) {
    state.selected = item || null;
    state.selectedImage = null;
    state.originalImageData = null;
    state.originalRoleMap = null;
    state.originalOccupied = null;
    state.sourceClassifiedPalette = null;
    state.sourcePaletteHexes = [];
    state.sourceRoleByHex = new Map();
    state.noMinimalPreviewPair = null;
    canvas.clearDisplayGrain();
    canvas.setShowNoiseMask(state.showNoiseMask);
    canvas.setSourceOverlayVisible(state.sourceOverlayVisible);
    canvas.setPaintTarget(state.activePaintTarget);
    state.variantByFamily = { mono: null, chrome: null, warhol: null, acid: null, pastel: null };
    state.variantRailByFamily = createInitialVariantRailByFamily();
    state.activeStudioVariant = null;
    state.activeStudioProvenance = null;
    state.outputSignatures.clear();
    state.outputSignatureOrder = [];
    state.popSheetBuildNonce = 0;
    state.lastPopSheetPanelSignatures = [];
    renderPresetList();
    updateExportButtons();

    if (!state.selected) {
      els.canvasEmpty.style.display = "grid";
      setTopbarStatus("Select a NoPunk to reduce");
      return;
    }

    els.canvasEmpty.style.display = "none";
    setServerStatus(`Loading #${state.selected.id}...`);

    try {
      const sourceAsset = await loadSourceAsset(state.selected);
      if (state.disposed || !state.selected || Number(state.selected.id) !== Number(item.id)) return;
      state.selectedImage = sourceAsset.image;
      const imageData = sourceAsset.imageData;
      state.originalImageData = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
      state.originalRoleMap = classifyPixelRoles(imageData);
      state.originalOccupied = getOccupiedPixels(imageData);
      canvas.loadImageData(imageData);
      applySingleFrameState();
      const restoredCanvasSession = restoreSessionArmed
        && pendingCanvasSession
        && Number(pendingCanvasSession.selectedTokenId) === Number(state.selected.id);
      if (restoredCanvasSession) {
        canvas.loadSessionState(pendingCanvasSession);
        pendingCanvasSession = null;
        restoreSessionArmed = false;
        setTopbarStatus(`Restored last session on #${state.selected.id}`);
      }
      state.sourceClassifiedPalette = canvas.getClassifiedPalette().map((entry) => ({ ...entry }));
      state.sourcePaletteHexes = canvas.getOriginalPalette().slice();
      state.sourceRoleByHex = new Map(
        (state.sourceClassifiedPalette || []).map((entry) => [String(entry.hex || "").toUpperCase(), String(entry.role || "body")]),
      );
      const validSourceHexes = new Set(state.sourcePaletteHexes.map((hex) => String(hex || "").toUpperCase()));
      const filteredMap = {};
      for (const [sourceHex, targetHex] of Object.entries(state.curatedPaletteMap || {})) {
        const source = String(sourceHex || "").toUpperCase();
        const target = String(targetHex || "").toUpperCase();
        if (!validSourceHexes.has(source)) continue;
        if (!/^#[0-9A-F]{6}$/.test(target)) continue;
        filteredMap[source] = target;
      }
      state.curatedPaletteMap = filteredMap;
      if (!validSourceHexes.has(String(state.curationSourceHex || "").toUpperCase())) {
        state.curationSourceHex = null;
      }
      if (!restoredCanvasSession && state.startMode !== "full") {
        applyStartMode(state.startMode, { quiet: true });
      }
      captureSingleCompositionSnapshot({ force: true });
      refreshNoMinimalPreviewPair();
      renderHeroRolePair();
      renderNoiseTargetRail();
      updatePaletteGrid();
      updateExportButtons();
      setServerStatus(`#${state.selected.id} loaded`, "ready");
      if (!restoredCanvasSession) {
        setTopbarStatus(`#${state.selected.id} loaded · clean 24x24 canvas`);
      }
      if (mobileDockQuery.matches) setSidebarOpen(false);
      pulseStudio("load");
    } catch (error) {
      if (!state.disposed) setServerStatus(error.message || "Load failed", "error");
    }
  }

  // ── Restore session ──────────────────────────────────────────

  const savedSession = restoreSession();
  if (savedSession) {
    if (savedSession.activePresetTab) {
      state.activePresetTab = savedSession.activePresetTab === "noir" ? "chrome" : savedSession.activePresetTab;
    }
    if (savedSession.activeColor) state.activeColor = savedSession.activeColor;
    if (savedSession.activeColorHex) state.activeColorHex = savedSession.activeColorHex;
    if (savedSession.paintMode === "role") state.paintMode = "role";
    if (savedSession.noMinimalDeltaMode) state.noMinimalDeltaMode = savedSession.noMinimalDeltaMode;
    if (savedSession.useActiveBg != null) state.useActiveBg = Boolean(savedSession.useActiveBg);
    if (savedSession.activePaintTarget) state.activePaintTarget = savedSession.activePaintTarget;
    if (["background", "outline", "erase"].includes(state.activePaintTarget)) {
      state.lastRolePaintTarget = state.activePaintTarget;
    }
    if (savedSession.globalModifiers && typeof savedSession.globalModifiers === "object") {
      state.globalModifiers = {
        ...state.globalModifiers,
        ...savedSession.globalModifiers,
      };
    }
    if (savedSession.familyModifiers && typeof savedSession.familyModifiers === "object") {
      const nextFamilyModifiers = { ...savedSession.familyModifiers };
      if (nextFamilyModifiers.noir && !nextFamilyModifiers.chrome) {
        nextFamilyModifiers.chrome = {
          shimmer: Number(nextFamilyModifiers.noir.shadowDepth) || 70,
          polish: 62,
        };
      }
      state.familyModifiers = {
        ...state.familyModifiers,
        ...nextFamilyModifiers,
      };
    }
    state.noiseAmount = Number(state.globalModifiers.grainAmount ?? state.noiseAmount) || state.noiseAmount;
    state.showNoiseMask = Boolean(savedSession.showNoiseMask);
    state.sourceOverlayVisible = Boolean(savedSession.sourceOverlayVisible);
    if (savedSession.popSheetLayout) state.popSheetLayout = savedSession.popSheetLayout;
    if (savedSession.gridFrameTone && GRID_FRAME_TONES[savedSession.gridFrameTone]) {
      state.gridFrameTone = savedSession.gridFrameTone;
    }
    if (savedSession.singleFrameEnabled != null) {
      state.singleFrameEnabled = Boolean(savedSession.singleFrameEnabled);
    }
    if (savedSession.singleFrameTone && GRID_FRAME_TONES[savedSession.singleFrameTone]) {
      state.singleFrameTone = savedSession.singleFrameTone;
    }
    if (
      savedSession.popSheetStyle === "warhol"
      || savedSession.popSheetStyle === "screenprint"
      || savedSession.popSheetStyle === POP_SHEET_STYLE_POSTER
      || savedSession.popSheetStyle === POP_SHEET_STYLE_SOFT
    ) {
      state.popSheetStyle = normalizePopSheetStyle(savedSession.popSheetStyle);
    } else if (savedSession.popSheetStyle === "serial") {
      state.popSheetStyle = POP_SHEET_STYLE_SOFT;
    }
    if (savedSession.gallerySignature) {
      state.gallerySignature = normalizeSignatureHandle(savedSession.gallerySignature);
    }
    if (savedSession.curatedPaletteMap && typeof savedSession.curatedPaletteMap === "object") {
      const nextMap = {};
      for (const [sourceHex, targetHex] of Object.entries(savedSession.curatedPaletteMap)) {
        const source = String(sourceHex || "").trim().toUpperCase();
        const target = String(targetHex || "").trim().toUpperCase();
        if (!/^#[0-9A-F]{6}$/.test(source) || !/^#[0-9A-F]{6}$/.test(target)) continue;
        nextMap[source] = target;
      }
      state.curatedPaletteMap = nextMap;
    }
    if (savedSession.variantRailLocks && typeof savedSession.variantRailLocks === "object") {
      state.variantRailLocks = {
        ...state.variantRailLocks,
        background: Boolean(savedSession.variantRailLocks.background),
        accentBias: Boolean(savedSession.variantRailLocks.accentBias),
        curatedMap: Boolean(savedSession.variantRailLocks.curatedMap),
      };
    }
    if (/^#[0-9A-F]{6}$/.test(String(savedSession.curationSourceHex || "").toUpperCase())) {
      state.curationSourceHex = String(savedSession.curationSourceHex).toUpperCase();
    }
    syncColorUI();
    syncGlobalModifierUI();
    if (!els.activeBgToggle) {
      state.useActiveBg = false;
    }
    syncActiveBgToggle();
    renderNoMinimalModeRail();
    renderPaintModeRails();
    renderNoiseTargetRail();
    renderStartModeRail();
    syncSingleFrameUi();
    syncMaskUi();
    applySingleFrameState();
    setPaintMode(state.paintMode, { quiet: true });
    canvas.setShowNoiseMask(state.showNoiseMask);
    canvas.setSourceOverlayVisible(state.sourceOverlayVisible);
    setActivePresetTab(state.activePresetTab);
    if (els.noiseAmount) els.noiseAmount.value = String(state.noiseAmount);
    if (els.noiseAmountValue) els.noiseAmountValue.textContent = `${state.noiseAmount}%`;
    if (els.gallerySignature) els.gallerySignature.value = state.gallerySignature;
    if (isRestorableCanvasSession(savedSession)) {
      restoreCanvasSession = savedSession;
      syncRestoreSessionButton();
    }
  }

  // ── Boot ──────────────────────────────────────────────────────

  getNoStudioConfig()
    .then((cfg) => {
      if (state.disposed) return;
      state.noiseGifAvailable = cfg.noiseGifAvailable !== false;
      state.noGalleryAvailable = cfg.noGalleryAvailable !== false;
      state.globalGalleryEnabled = cfg.globalGalleryEnabled === true;
      state.galleryStorage = state.globalGalleryEnabled ? "sqlite" : "unavailable";
      if (!state.noiseGifAvailable) {
        els.exportGif.title = "Animated grain GIF will render in-browser on live deploys.";
      }
      if (els.galleryList) {
        renderGallery();
        refreshGallery({ silent: true });
      }
      updateExportButtons();
      setTopbarStatus(state.globalGalleryEnabled
        ? "Studio mode · traits speak in relief"
        : "Studio mode · shared No-Gallery offline");
    })
    .catch(() => {});

  // ── Cleanup ───────────────────────────────────────────────────

  return () => {
    state.disposed = true;
    state.requestToken += 1;
    document.removeEventListener("keydown", onKeyDown);
    mobileDockQuery.removeEventListener("change", handleDockMediaChange);
    resizeObserver.disconnect();
    hideShortcutHints();
    if (variantPanelRafId) cancelAnimationFrame(variantPanelRafId);
    canvas.destroy();
    picker.destroy();
    root.innerHTML = "";
  };
}
