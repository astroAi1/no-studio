import {
  getNoStudioConfig,
  listNoStudioGallery,
  renderNoStudioNoiseGif,
  saveNoStudioGallery,
  searchPunks,
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

const FAMILY_IDS = ["mono", "noir", "warhol", "acid", "pastel"];
const FAMILY_LABELS = {
  mono: "Mono",
  noir: "Noir",
  warhol: "Pop",
  acid: "Acid",
  pastel: "Pastel",
};
const POP_SHEET_STYLE_POSTER = "poster-grid";
const POP_SHEET_STYLE_SCREENPRINT = "screenprint";
const BRAND_ROLE_BG = "#000000";
const BRAND_ROLE_FG = "#040404";
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
  noir: {
    bgSat: [0.01, 0.08],
    bgLight: [0.015, 0.07],
    hueShift: 10,
    sat: [0.01, 0.14],
    light: [0.08, 0.34],
    accentLift: 0.08,
    quantMin: 3,
    quantMax: 5,
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
  if (style === POP_SHEET_STYLE_SCREENPRINT) return POP_SHEET_STYLE_SCREENPRINT;
  if (style === "warhol" || style === POP_SHEET_STYLE_POSTER) return POP_SHEET_STYLE_POSTER;
  return POP_SHEET_STYLE_POSTER;
}

function popSheetStyleLabel(value) {
  const style = normalizePopSheetStyle(value);
  return style === POP_SHEET_STYLE_SCREENPRINT ? "Screenprint" : "Poster Grid";
}

function popSheetStyleStatusSlug(value) {
  const style = normalizePopSheetStyle(value);
  return style === POP_SHEET_STYLE_SCREENPRINT ? "screenprint" : "poster-grid";
}

function createDefaultGlobalModifiers() {
  return {
    toneCount: 5,
    contrast: 62,
    traitFocus: 54,
    paletteDrift: 28,
    grainAmount: 28,
    grainTarget: "background",
  };
}

function createDefaultFamilyModifiers() {
  return {
    mono: { hueDrift: 8, stepCompression: 56 },
    noir: { shadowDepth: 72, accentGate: 38 },
    warhol: { flatness: 70, panelDivergence: 62 },
    acid: { clashAngle: 132, corrosion: 58 },
    pastel: { powderSoftness: 66, airLift: 60 },
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
    curationMapActive: q("curation-map-active"),
    curationClearMapping: q("curation-clear-mapping"),
    curationApply: q("curation-apply"),
    curationResetAll: q("curation-reset-all"),
    surpriseBtn: q("surprise-btn"),
    heroNoMinimal: q("hero-no-minimal"),
    heroRolePair: q("hero-role-pair"),
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
    exportPng: q("export-png"),
    exportGif: q("export-gif"),
    saveGalleryPng: q("save-gallery-png"),
    saveGalleryGif: q("save-gallery-gif"),
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
    activeTool: "pointer",
    activePresetTab: "mono",
    noMinimalDeltaMode: "exact",
    useActiveBg: false,
    activeNoiseTarget: "background",
    noiseAmount: 28,
    noisePass: 0,
    lastReductionMode: "none",
    globalModifiers: createDefaultGlobalModifiers(),
    familyModifiers: createDefaultFamilyModifiers(),
    variantByFamily: {
      mono: null,
      noir: null,
      warhol: null,
      acid: null,
      pastel: null,
    },
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
    curationSourceHex: null,
    ditherPalette: [
      { r: 255, g: 255, b: 255 },
      { r: 0, g: 0, b: 0 },
    ],
    activeColor: { h: 0, s: 0, l: 100 },
    activeColorHex: "#FFFFFF",
    gallerySignature: "",
    noMinimalPreviewPair: null,
    noFieldLastFamily: "noir",
    popSheetLayout: "2x2",
    popSheetStyle: POP_SHEET_STYLE_POSTER,
    isSheetMode: false,
  };

  // ── Session persistence ──────────────────────────────────────

  const SESSION_KEY = "no-studio-session";

  function persistSession() {
    try {
      const data = {
        selectedId: state.selected?.id ?? null,
        activePresetTab: state.activePresetTab,
        activeColor: state.activeColor,
        activeColorHex: state.activeColorHex,
        noMinimalDeltaMode: state.noMinimalDeltaMode,
        useActiveBg: state.useActiveBg,
        globalModifiers: state.globalModifiers,
        familyModifiers: state.familyModifiers,
        popSheetLayout: state.popSheetLayout,
        popSheetStyle: state.popSheetStyle,
        gallerySignature: normalizeSignatureHandle(els.gallerySignature?.value || state.gallerySignature || ""),
        curatedPaletteMap: state.curatedPaletteMap,
        curationSourceHex: state.curationSourceHex,
      };
      if (state.selected && canvas) {
        const imageData = canvas.exportImageData();
        data.canvasBuffer = encodeRgba24B64(imageData.data);
      }
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
      updateUndoRedoButtons();
      updatePaletteGrid();
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
      const preset = family === "noir"
        ? {
            ...basePreset,
            noirScheme: pickOne(NOIR_COLOR_SCHEMES)?.id || "classic-noir",
            noirPhase: Math.random(),
          }
        : basePreset;
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
    setTopbarStatus(`${label} armed · original-source rerender`);
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
    renderPresetList();
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
    renderPresetList();
    updatePaletteGrid();
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
  }

  els.hueSlider.addEventListener("input", onColorSliderInput);
  els.satSlider.addEventListener("input", onColorSliderInput);
  els.litSlider.addEventListener("input", onColorSliderInput);
  els.colorHex.addEventListener("change", () => {
    let hex = els.colorHex.value.trim();
    if (!hex.startsWith("#")) hex = "#" + hex;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) setActiveColorFromHex(hex);
  });

  syncColorUI();

  function clampPercent(value) {
    return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  }

  function syncGlobalModifierUI() {
    state.globalModifiers.toneCount = Math.max(2, Math.min(8, Math.round(Number(state.globalModifiers.toneCount) || 5)));
    state.globalModifiers.contrast = clampPercent(state.globalModifiers.contrast);
    state.globalModifiers.traitFocus = clampPercent(state.globalModifiers.traitFocus);
    state.globalModifiers.paletteDrift = clampPercent(state.globalModifiers.paletteDrift);
    state.globalModifiers.grainAmount = clampPercent(state.globalModifiers.grainAmount);
    state.globalModifiers.grainTarget = state.globalModifiers.grainTarget || "background";
    state.noiseAmount = state.globalModifiers.grainAmount;
    state.activeNoiseTarget = state.globalModifiers.grainTarget;

    if (els.globalToneCount) els.globalToneCount.value = String(state.globalModifiers.toneCount);
    if (els.globalToneCountValue) els.globalToneCountValue.textContent = String(state.globalModifiers.toneCount);
    if (els.globalContrast) els.globalContrast.value = String(state.globalModifiers.contrast);
    if (els.globalContrastValue) els.globalContrastValue.textContent = `${state.globalModifiers.contrast}%`;
    if (els.globalTraitFocus) els.globalTraitFocus.value = String(state.globalModifiers.traitFocus);
    if (els.globalTraitFocusValue) els.globalTraitFocusValue.textContent = `${state.globalModifiers.traitFocus}%`;
    if (els.globalPaletteDrift) els.globalPaletteDrift.value = String(state.globalModifiers.paletteDrift);
    if (els.globalPaletteDriftValue) els.globalPaletteDriftValue.textContent = `${state.globalModifiers.paletteDrift}%`;
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
      noir: [
        { key: "shadowDepth", label: "Shadow Depth", min: 0, max: 100, unit: "%", help: "Pushes black floor density and concealment." },
        { key: "accentGate", label: "Accent Gate", min: 0, max: 100, unit: "%", help: "Limits bright accents to fewer trait regions." },
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
      scheduleVariantPanelRender();
    });
  }
  if (els.globalContrast) {
    els.globalContrast.addEventListener("input", () => {
      state.globalModifiers.contrast = clampPercent(els.globalContrast.value);
      syncGlobalModifierUI();
      scheduleVariantPanelRender();
    });
  }
  if (els.globalTraitFocus) {
    els.globalTraitFocus.addEventListener("input", () => {
      state.globalModifiers.traitFocus = clampPercent(els.globalTraitFocus.value);
      syncGlobalModifierUI();
      scheduleVariantPanelRender();
    });
  }
  if (els.globalPaletteDrift) {
    els.globalPaletteDrift.addEventListener("input", () => {
      state.globalModifiers.paletteDrift = clampPercent(els.globalPaletteDrift.value);
      syncGlobalModifierUI();
      scheduleVariantPanelRender();
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
    const pair = ensureNoMinimalPreviewPair();
    els.heroRolePair.textContent = `BG ${pair.background} → FG ${pair.figure} · ${state.noMinimalDeltaMode}`;
  }

  function renderNoMinimalModeRail() {
    if (!els.noMinimalModeRail) return;
    els.noMinimalModeRail.querySelectorAll("[data-minimal-mode]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.minimalMode === state.noMinimalDeltaMode);
    });
  }

  function renderNoiseTargetRail() {
    if (!els.noiseTargetRail) return;
    els.noiseTargetRail.querySelectorAll("[data-noise-target]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.noiseTarget === state.activeNoiseTarget);
    });
  }

  els.activeBgToggle?.addEventListener("click", () => {
    state.useActiveBg = !state.useActiveBg;
    syncActiveBgToggle();
    setTopbarStatus(state.useActiveBg ? "All families use active color as background anchor" : "Families use machine-picked background anchors");
  });

  syncActiveBgToggle();
  renderHeroRolePair();
  renderNoMinimalModeRail();
  renderNoiseTargetRail();

  els.noMinimalModeRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-minimal-mode]");
    if (!button) return;
    state.noMinimalDeltaMode = button.dataset.minimalMode || "exact";
    refreshNoMinimalPreviewPair();
    renderNoMinimalModeRail();
    renderHeroRolePair();
    renderPresetList();
    setTopbarStatus(`No-Minimalism ${state.noMinimalDeltaMode} twin · world armed`);
  });

  els.noiseTargetRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-noise-target]");
    if (!button) return;
    state.activeNoiseTarget = button.dataset.noiseTarget || "background";
    state.globalModifiers.grainTarget = state.activeNoiseTarget;
    renderNoiseTargetRail();
    setTopbarStatus(`Noise target ${state.activeNoiseTarget}`);
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

  // ── Palette grid ──────────────────────────────────────────────

  function sourceRoleForHex(hex) {
    const key = String(hex || "").trim().toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(key)) return "body";
    return state.sourceRoleByHex.get(key) || "body";
  }

  function renderPaletteCurationReadout() {
    if (!els.paletteCurationReadout) return;
    const selected = String(state.curationSourceHex || "").toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(selected)) {
      els.paletteCurationReadout.textContent = "Pick a source swatch, then map it to your active color.";
      return;
    }
    const role = sourceRoleForHex(selected);
    const mapped = String(state.curatedPaletteMap[selected] || "").toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(mapped)) {
      els.paletteCurationReadout.textContent = `${selected} (${role}) → ${mapped}`;
      return;
    }
    els.paletteCurationReadout.textContent = `${selected} (${role}) is not mapped yet`;
  }

  function updatePaletteGrid() {
    const colors = state.sourcePaletteHexes.length ? state.sourcePaletteHexes : canvas.getCurrentPalette();
    const selectedSource = String(state.curationSourceHex || "").toUpperCase();
    const activeHex = selectedActiveHex();
    els.paletteGrid.innerHTML = colors.map((hex) => {
      const sourceHex = String(hex || "").toUpperCase();
      const mappedHex = String(state.curatedPaletteMap[sourceHex] || "").toUpperCase();
      const role = sourceRoleForHex(sourceHex);
      const isMapped = /^#[0-9A-F]{6}$/.test(mappedHex);
      const isSourceSelected = sourceHex === selectedSource;
      const isActive = sourceHex === activeHex;
      const classes = [
        "palette-swatch",
        isMapped ? "is-mapped" : "",
        isSourceSelected ? "is-source-selected" : "",
        isActive ? "is-active" : "",
      ].filter(Boolean).join(" ");
      const style = isMapped && mappedHex !== sourceHex
        ? `background:linear-gradient(135deg, ${escapeHtml(sourceHex)} 0%, ${escapeHtml(sourceHex)} 50%, ${escapeHtml(mappedHex)} 50%, ${escapeHtml(mappedHex)} 100%);`
        : `background:${escapeHtml(sourceHex)};`;
      const title = isMapped
        ? `${sourceHex} (${role}) → ${mappedHex}`
        : `${sourceHex} (${role})`;
      return `<button class="${classes}" data-hex="${escapeHtml(sourceHex)}" style="${style}" title="${escapeHtml(title)}"></button>`;
    }).join("") || '<span style="font-size:11px;color:var(--text-dim)">Select a punk</span>';
    renderPaletteCurationReadout();
  }

  els.paletteGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-hex]");
    if (!btn) return;
    const pickedHex = String(btn.dataset.hex || "").toUpperCase();
    state.curationSourceHex = pickedHex;
    setActiveColorFromHex(pickedHex);
    setTopbarStatus(`Active color ${pickedHex} armed`);

    if (!state.useActiveBg) {
      renderHeroRolePair();
    }
    updatePaletteGrid();
    persistSession();
  });

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
    updatePaletteGrid();
    setTopbarStatus(`Cleared mapping for ${sourceHex}`);
    persistSession();
  }

  function resetPaletteCuration() {
    state.curatedPaletteMap = {};
    state.curationSourceHex = null;
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
    const classified = state.sourceClassifiedPalette || canvas.getClassifiedPalette();
    const variant = state.variantByFamily[family] || createUniqueVariant(family, classified);
    const backgroundHex = resolveBackgroundForCast(family, { refreshWorld: true });
    const result = buildFamilyResult(classified, family, {
      preset: variant,
      backgroundHex,
      traitPhase: 0,
      panelIndex: 0,
      panelCount: 1,
      popSheetStyle: state.popSheetStyle,
    });
    const nextMapping = { ...(result.mapping || {}) };
    const floor = hexLuma(result.roles?.outline || "#040404");
    const used = new Set(Object.values(nextMapping).map((hex) => String(hex || "").toUpperCase()));
    used.add(String(result.roles?.background || "").toUpperCase());
    used.add(String(result.roles?.outline || "").toUpperCase());

    for (const [sourceHexRaw, targetHexRaw] of Object.entries(state.curatedPaletteMap || {})) {
      const sourceHex = String(sourceHexRaw || "").toUpperCase();
      const targetHex = String(targetHexRaw || "").toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(sourceHex) || !/^#[0-9A-F]{6}$/.test(targetHex)) continue;
      const role = sourceRoleForHex(sourceHex);
      if (role === "background" || role === "outline") continue;
      let safeHex = targetHex;
      if (hexLuma(safeHex) <= floor) {
        safeHex = mixHex(safeHex, "#FFFFFF", 0.18);
      }
      nextMapping[sourceHex] = ensureDistinctHex(safeHex, used, { floor });
    }

    state.variantByFamily[family] = variant;
    syncHeroPairFromRoles(result.roles, activeRoleStep());
    canvas.applyColorMapping(nextMapping, result.roles);
    state.noFieldLastFamily = family;
    state.lastReductionMode = "none";
    renderHeroRolePair();
    renderVariantPanel();
    updatePaletteGrid();
    setTopbarStatus(`Curated Cast · ${FAMILY_LABELS[family] || "Studio"} · original-source rerender`);
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
            <div class="shortcut-row"><kbd>B</kbd><span>Paint</span></div>
            <div class="shortcut-row"><kbd>G</kbd><span>Fill Block</span></div>
            <div class="shortcut-row"><kbd>I</kbd><span>Eyedropper</span></div>
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
    if (state.activePresetTab === "noir") return "noir";
    if (state.activePresetTab === "warhol") return "warhol";
    if (state.activePresetTab === "acid") return "acid";
    if (state.activePresetTab === "pastel") return "pastel";
    return "mono";
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
    const palette = state.sourcePaletteHexes.length ? state.sourcePaletteHexes : canvas.getCurrentPalette();
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
    if (family === "noir" || family === "mono" || family === "acid") {
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
    const imageData = canvas.exportImageData();
    const data = imageData.data;
    const occupied = state.originalOccupied || canvas.getOccupied();
    const counts = new Map();
    for (let y = 0; y < imageData.height; y += 1) {
      for (let x = 0; x < imageData.width; x += 1) {
        if (occupied.has(`${x},${y}`)) continue;
        const i = (y * imageData.width + x) * 4;
        const hex = rgbToHex(data[i], data[i + 1], data[i + 2]);
        counts.set(hex, (counts.get(hex) || 0) + 1);
      }
    }
    if (!counts.size) {
      const palette = canvas.getCurrentPalette().slice().sort((a, b) => hexLuma(a) - hexLuma(b));
      return palette[0] || "#000000";
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  function nearestPaletteHex(targetHex, palette = null) {
    const colors = Array.isArray(palette) && palette.length ? palette : canvas.getCurrentPalette();
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

    const palette = canvas.getCurrentPalette();
    const amountNorm = Math.max(0, Math.min(1, state.noiseAmount / 100));
    const noisePass = ++state.noisePass;
    const activeHex = nearestPaletteHex(selectedActiveHex(), palette);
    applyDisplayGrain({
      enabled: amountNorm > 0,
      target: state.activeNoiseTarget,
      amount: amountNorm,
      activeHex,
      seed: noisePass,
    });
    const targetLabel = state.activeNoiseTarget === "background"
      ? "background"
      : (state.activeNoiseTarget === "active" ? "selected band" : "figure");
    setTopbarStatus(`Grain ${targetLabel} · ${state.noiseAmount}% · display layer`);
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
    els.galleryList.innerHTML = state.galleryItems.map((item) => {
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
      const paletteLine = palettePreview.length
        ? `<span class="gallery-palette-strip">${palettePreview.map((hex) => `<span class="gallery-palette-chip" style="background:${escapeHtml(hex)}" title="${escapeHtml(hex)}"></span>`).join("")}${palette.length > palettePreview.length ? `<span class="gallery-palette-count">+${palette.length - palettePreview.length}</span>` : ""}</span>`
        : "";
      return `
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
    `;
    }).join("");
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
      state.galleryMessage = "";
      if (!silent) setTopbarStatus(`No-Gallery · ${state.galleryItems.length} saved`);
    } catch (error) {
      state.galleryItems = [];
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
      const payload = await saveNoStudioGallery({
        tokenId: state.selected.id,
        family: state.activePresetTab === "warhol" ? "pop" : state.activePresetTab,
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
          background: state.noMinimalPreviewPair?.background || currentBackgroundHex(),
          figure: state.noMinimalPreviewPair?.figure || "—",
          mode: state.noMinimalDeltaMode,
        },
      });
      if (payload?.item) {
        state.galleryItems = [payload.item, ...state.galleryItems.filter((entry) => entry.id !== payload.item.id)].slice(0, 12);
      }
      state.galleryMessage = "";
      renderGallery();
      setTopbarStatus(`Saved ${mediaKind.toUpperCase()} to No-Gallery`);
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
      "2x2": { cols: 2, rows: 2, label: "2x2" },
      "3x3": { cols: 3, rows: 3, label: "3x3" },
      "4x4": { cols: 4, rows: 4, label: "4x4" },
    };
    return specs[layoutId] || specs["2x2"];
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

  function applyPopSheet(layoutId = state.popSheetLayout, styleId = state.popSheetStyle) {
    if (!state.selected || !state.originalImageData) return;

    const { cols, rows, label } = getPopSheetSpec(layoutId);
    const source = state.originalImageData;
    const classified = state.sourceClassifiedPalette || canvas.getClassifiedPalette();
    const roleByHex = state.sourceRoleByHex instanceof Map ? state.sourceRoleByHex : new Map();
    const panelCount = cols * rows;
    const popStyle = normalizePopSheetStyle(styleId);
    const usedSignatures = new Set();

    const panelResults = Array.from({ length: panelCount }, (_, panelIndex) => {
      const backgroundHex = state.useActiveBg ? selectedActiveHex() : null;
      let selected = null;

      for (let attempt = 0; attempt < 96; attempt += 1) {
        const preset = createUniqueVariant("warhol", classified);
        const result = buildFamilyResult(classified, "warhol", {
          preset,
          backgroundHex,
          traitPhase: 0,
          panelIndex: panelIndex + (attempt * panelCount),
          panelCount: panelCount * 2,
          popSheetStyle: popStyle,
        });
        const signature = makePanelPaletteSignature(result);
        if (!signature || usedSignatures.has(signature)) {
          continue;
        }
        usedSignatures.add(signature);
        selected = {
          preset,
          mapping: new Map(Object.entries(result.mapping || {}).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
          roles: result.roles,
        };
        break;
      }

      if (selected) {
        return selected;
      }

      const fallbackPreset = createUniqueVariant("warhol", classified);
      const fallback = buildFamilyResult(classified, "warhol", {
        preset: fallbackPreset,
        backgroundHex,
        traitPhase: 0,
        panelIndex,
        panelCount,
        popSheetStyle: popStyle,
      });
      return {
        preset: fallbackPreset,
        mapping: new Map(Object.entries(fallback.mapping || {}).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
        roles: fallback.roles,
      };
    });

    const tiles = panelResults.map((panel, panelIndex) => {
      const tile = new Uint8ClampedArray(source.data.length);
      for (let y = 0; y < source.height; y += 1) {
        for (let x = 0; x < source.width; x += 1) {
          const idx = (y * source.width + x) * 4;
          const alpha = source.data[idx + 3];
          let targetHex = panel.roles?.background || "#000000";
          if (alpha > 0) {
            const origHex = rgbToHex(source.data[idx], source.data[idx + 1], source.data[idx + 2]).toUpperCase();
            const role = roleByHex.get(origHex) || "body";
            if (origHex === "#040404") {
              targetHex = panel.roles?.outline || targetHex;
            } else if (origHex === "#000000") {
              targetHex = panel.roles?.background || targetHex;
            } else {
              const mappedHex = panel.mapping.get(origHex);
              if (mappedHex) {
                targetHex = mappedHex;
              } else if (role === "accent") {
                targetHex = mixHex(panel.roles?.outline || targetHex, "#FFFFFF", 0.16);
              } else if (role === "neutral") {
                targetHex = mixHex(panel.roles?.background || targetHex, panel.roles?.outline || targetHex, 0.5);
              } else {
                targetHex = mixHex(panel.roles?.background || targetHex, panel.roles?.outline || targetHex, 0.34);
              }
            }

            if (popStyle === "screenprint" && role !== "background" && role !== "outline") {
              const shiftX = panelIndex % 2 === 0 ? 1 : -1;
              const shiftY = (panelIndex + 1) % 3 === 0 ? 1 : 0;
              const shouldMisregister = ((x * 3) + (y * 5) + panelIndex) % 11 < 3;
              if (shouldMisregister) {
                const sx = Math.max(0, Math.min(source.width - 1, x + shiftX));
                const sy = Math.max(0, Math.min(source.height - 1, y + shiftY));
                const sIdx = (sy * source.width + sx) * 4;
                if (source.data[sIdx + 3] > 0) {
                  const shiftedHex = rgbToHex(source.data[sIdx], source.data[sIdx + 1], source.data[sIdx + 2]).toUpperCase();
                  const shiftedRole = roleByHex.get(shiftedHex) || "body";
                  if (shiftedRole !== "background" && shiftedRole !== "outline") {
                    targetHex = panel.mapping.get(shiftedHex) || targetHex;
                  }
                }
              }

              const halftoneDot = ((x + (y * 2) + panelIndex) % 4) === 0 || (((x * 5) + (y * 3) + panelIndex) % 13) === 0;
              if (halftoneDot) {
                targetHex = mixHex(targetHex, panel.roles?.background || "#000000", 0.24);
              } else if (((x + y + panelIndex) % 7) === 0) {
                targetHex = mixHex(targetHex, "#FFFFFF", 0.08);
              }
            }
          }
          const rgb = hexToRgb(targetHex);
          tile[idx] = rgb.r;
          tile[idx + 1] = rgb.g;
          tile[idx + 2] = rgb.b;
          tile[idx + 3] = 255;
        }
      }
      return new ImageData(tile, source.width, source.height);
    });

    state.variantByFamily.warhol = panelResults[0]?.preset || null;
    state.noFieldLastFamily = "warhol";
    state.isSheetMode = true;
    state.lastReductionMode = "pop-sheet";
    canvas.setSheetTiles(tiles, cols, rows);
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
    const floor = hexLuma(roles.outline || BRAND_ROLE_FG) + 2;
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
          sat = clampUnit(0.46 + ((1 - flatness) * 0.24) + (role === "accent" ? 0.08 : 0));
          levels = 4;
          light = clampUnit(0.2 + (rank * 0.56) + (role === "accent" ? 0.05 : 0));
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
    const classified = state.sourceClassifiedPalette || canvas.getClassifiedPalette();
    const preset = createUniqueVariant(family, classified);
    const backgroundHex = resolveBackgroundForCast(family, { refreshWorld: true });

    const result = buildFamilyResult(classified, family, {
      preset,
      backgroundHex,
      traitPhase: 0,
      panelIndex: 0,
      panelCount: 1,
      popSheetStyle: state.popSheetStyle,
    });

    state.variantByFamily[family] = result.preset;
    syncHeroPairFromRoles(result.roles, activeRoleStep());
    canvas.applyColorMapping(result.mapping, result.roles);
    state.noFieldLastFamily = family;
    state.lastReductionMode = "none";
    renderHeroRolePair();
    renderVariantPanel();

    const familyLabel = FAMILY_LABELS[family] || "Studio";
    setTopbarStatus(`${statusPrefix} · ${familyLabel} · ${result.toneTarget} tones · original-source rerender`);
    pulseStudio("variant");
    return result;
  }

  function applyNoMinimalism() {
    if (!state.selected || !state.originalRoleMap) return;

    state.isSheetMode = false;
    canvas.setSubdivision(1);
    const current = canvas.exportImageData();
    const next = new Uint8ClampedArray(current.data);
    const occupied = state.originalOccupied || canvas.getOccupied();
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
    canvas.applyImageData(new ImageData(next, current.width, current.height));
    renderHeroRolePair();
    setTopbarStatus(`No-Minimalism ${state.noMinimalDeltaMode} · ${pair.background} → ${pair.figure} · ${pair.roleStep} lift · 2 tones`);
    pulseStudio("reduce");
  }

  function renderVariantPanel() {
    const activeTab = state.activePresetTab;
    const current = state.variantByFamily[activeTab] || null;
    const familyLabel = FAMILY_LABELS[activeTab] || "Studio";
    const toneTarget = familyToneTarget(activeTab);
    const world = ensureNoMinimalPreviewPair();
    const familyHint = {
      mono: "Tonal reduction and hue unity. Keep form while compressing colour variance.",
      noir: "Dark-floor casting with controlled accent reveals. Concealment first.",
      warhol: "Poster-pop casting with bold contrast for single renders and sheet builds.",
      acid: "Synthetic clash space with unstable complements and sharper tensions.",
      pastel: "Airy high-light render with powder softness and quiet separations.",
    }[activeTab] || "Every cast starts from the original source punk.";

    const popSheetControls = activeTab === "warhol"
      ? `
        <div class="variant-title">Pop Sheet Style</div>
        <div class="theory-rail pop-sheet-style-rail">
          <button class="theory-btn${state.popSheetStyle === POP_SHEET_STYLE_POSTER ? " is-active" : ""}" type="button" data-action="set-pop-sheet-style" data-style="${POP_SHEET_STYLE_POSTER}">Poster Grid</button>
          <button class="theory-btn${state.popSheetStyle === POP_SHEET_STYLE_SCREENPRINT ? " is-active" : ""}" type="button" data-action="set-pop-sheet-style" data-style="${POP_SHEET_STYLE_SCREENPRINT}">Screenprint</button>
        </div>
        <div class="variant-title">Pop Sheet</div>
        <div class="theory-rail pop-sheet-rail">
          <button class="theory-btn${state.popSheetLayout === "2x2" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="2x2">2x2</button>
          <button class="theory-btn${state.popSheetLayout === "3x3" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="3x3">3x3</button>
          <button class="theory-btn${state.popSheetLayout === "4x4" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="4x4">4x4</button>
        </div>
        <div class="variant-action-grid">
          <button class="preset-btn" type="button" data-action="build-pop-sheet">Build Pop Sheet</button>
        </div>
      `
      : "";

    els.presetList.innerHTML = `
      <div class="variant-panel no-field-panel">
        <div class="mini-note no-field-guidance">${escapeHtml(familyHint)}</div>
        <div class="role-pair-readout">Role pair · ${escapeHtml(world.background)} → ${escapeHtml(world.figure)} · ${world.roleStep} lift · ${toneTarget} tones</div>
        <div class="variant-action-grid">
          <button class="preset-btn" type="button" data-action="render-core" data-family="${activeTab}">Cast ${escapeHtml(familyLabel)}</button>
        </div>
        ${popSheetControls}
        <div class="variant-title">${escapeHtml(current?.name || "Original-source render ready")}</div>
        <div class="variant-chips">
          ${variantChipsMarkup(current)}
        </div>
      </div>
    `;
    renderFamilyModifierPanel();
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
      applyPopSheet(state.popSheetLayout, state.popSheetStyle);
      return;
    }
    if (btn.dataset.action === "set-pop-sheet") {
      state.popSheetLayout = btn.dataset.layout || "2x2";
      renderVariantPanel();
      setTopbarStatus(`Pop Sheet ${state.popSheetLayout} armed`);
      return;
    }
    if (btn.dataset.action === "set-pop-sheet-style") {
      const nextStyle = normalizePopSheetStyle(btn.dataset.style);
      state.popSheetStyle = nextStyle;
      renderVariantPanel();
      setTopbarStatus(`Pop Sheet style · ${popSheetStyleLabel(nextStyle)}`);
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
    els.exportPng.disabled = !ok;
    els.exportGif.disabled = !ok || !grain.enabled || !(grain.amount > 0);
    if (els.saveGalleryPng) {
      els.saveGalleryPng.disabled = !ok || state.gallerySaving;
    }
    if (els.saveGalleryGif) {
      els.saveGalleryGif.disabled = !ok || state.gallerySaving || !grain.enabled || !(grain.amount > 0);
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
      if (state.noiseGifAvailable) {
        try {
          const imageData = canvas.exportImageData();
          const rgba24B64 = encodeRgba24B64(imageData.data);
          const occupiedPixels = Array.from(state.originalOccupied || canvas.getOccupied());
          const payload = await renderNoStudioNoiseGif({
            tokenId: state.selected.id,
            rgba24B64,
            occupiedPixels,
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

  // ── Sidebar toggle / dock drawer ──────────────────────────────

  els.sidebarToggle?.addEventListener("click", () => setSidebarOpen(!els.sidebar.classList.contains("is-open")));
  els.mobileDockToggle?.addEventListener("click", () => setSidebarOpen(!els.sidebar.classList.contains("is-open")));
  els.dockDismiss?.addEventListener("click", () => setSidebarOpen(false));
  els.dockScrim?.addEventListener("click", () => setSidebarOpen(false));
  mobileDockQuery.addEventListener("change", handleDockMediaChange);

  // ── Punk Picker ───────────────────────────────────────────────

  const picker = mountPunkPicker(els.pickerHost, {
    title: "Source Drawer",
    subtitle: "Load a NoPunk, then reduce until the traits speak",
    placeholder: "Search #7804, alien, pipe...",
    autoSelectFirst: true,
    maxResults: 12,
    getSelectedIds: () => (state.selected ? [state.selected.id] : []),
    onPick: (item) => { setSelectedPunk(item); picker.refreshSelection(); },
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
    state.variantByFamily = { mono: null, noir: null, warhol: null, acid: null, pastel: null };
    state.outputSignatures.clear();
    state.outputSignatureOrder = [];
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
      state.sourceClassifiedPalette = canvas.getClassifiedPalette().map((entry) => ({ ...entry }));
      state.sourcePaletteHexes = canvas.getCurrentPalette().slice();
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
      refreshNoMinimalPreviewPair();
      renderHeroRolePair();
      updatePaletteGrid();
      updateExportButtons();
      setServerStatus(`#${state.selected.id} loaded`, "ready");
      setTopbarStatus(`#${state.selected.id} loaded · 24x24 truth`);
      if (mobileDockQuery.matches) setSidebarOpen(false);
      pulseStudio("load");
    } catch (error) {
      if (!state.disposed) setServerStatus(error.message || "Load failed", "error");
    }
  }

  // ── Restore session ──────────────────────────────────────────

  const savedSession = restoreSession();
  if (savedSession) {
    if (savedSession.activePresetTab) state.activePresetTab = savedSession.activePresetTab;
    if (savedSession.activeColor) state.activeColor = savedSession.activeColor;
    if (savedSession.activeColorHex) state.activeColorHex = savedSession.activeColorHex;
    if (savedSession.noMinimalDeltaMode) state.noMinimalDeltaMode = savedSession.noMinimalDeltaMode;
    if (savedSession.useActiveBg != null) state.useActiveBg = savedSession.useActiveBg;
    if (savedSession.globalModifiers && typeof savedSession.globalModifiers === "object") {
      state.globalModifiers = {
        ...state.globalModifiers,
        ...savedSession.globalModifiers,
      };
    }
    if (savedSession.familyModifiers && typeof savedSession.familyModifiers === "object") {
      state.familyModifiers = {
        ...state.familyModifiers,
        ...savedSession.familyModifiers,
      };
    }
    state.activeNoiseTarget = state.globalModifiers.grainTarget || state.activeNoiseTarget;
    state.noiseAmount = Number(state.globalModifiers.grainAmount ?? state.noiseAmount) || state.noiseAmount;
    if (savedSession.popSheetLayout) state.popSheetLayout = savedSession.popSheetLayout;
    if (savedSession.popSheetStyle === "warhol" || savedSession.popSheetStyle === "screenprint" || savedSession.popSheetStyle === POP_SHEET_STYLE_POSTER) {
      state.popSheetStyle = normalizePopSheetStyle(savedSession.popSheetStyle);
    } else if (savedSession.popSheetStyle === "serial") {
      state.popSheetStyle = POP_SHEET_STYLE_POSTER;
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
    if (/^#[0-9A-F]{6}$/.test(String(savedSession.curationSourceHex || "").toUpperCase())) {
      state.curationSourceHex = String(savedSession.curationSourceHex).toUpperCase();
    }
    syncColorUI();
    syncGlobalModifierUI();
    syncActiveBgToggle();
    renderNoMinimalModeRail();
    renderNoiseTargetRail();
    setActivePresetTab(state.activePresetTab);
    if (els.noiseAmount) els.noiseAmount.value = String(state.noiseAmount);
    if (els.noiseAmountValue) els.noiseAmountValue.textContent = `${state.noiseAmount}%`;
    if (els.gallerySignature) els.gallerySignature.value = state.gallerySignature;
    if (savedSession.selectedId != null) {
      searchPunks(String(savedSession.selectedId), 1)
        .then((payload) => {
          if (state.disposed) return;
          const item = (payload.items || []).find((i) => Number(i.id) === Number(savedSession.selectedId));
          if (item) {
            setSelectedPunk(item);
            picker.refreshSelection();
          }
        })
        .catch(() => {});
    }
  }

  // ── Boot ──────────────────────────────────────────────────────

  getNoStudioConfig()
    .then((cfg) => {
      if (state.disposed) return;
      state.noiseGifAvailable = cfg.noiseGifAvailable !== false;
      state.noGalleryAvailable = cfg.noGalleryAvailable !== false;
      if (!state.noiseGifAvailable) {
        els.exportGif.title = "Animated grain GIF will render in-browser on live deploys.";
      }
      renderGallery();
      refreshGallery({ silent: true });
      updateExportButtons();
      setTopbarStatus("Studio mode · traits speak in relief");
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
