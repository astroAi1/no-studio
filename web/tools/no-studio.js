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
  applyPreset, createGridPresetFn,
  createRandomPreset, DEFAULT_TONE_STEP,
} from "../lib/art-presets.js";
import {
  hslToRgb, rgbToHsl, rgbToHex, hexToRgb,
  hexLuma, lerp, mixHex, distanceRgb,
} from "../lib/color.js";
import { deriveNoMinimalismPair, deriveRolePair } from "../lib/studio-signature.js";
import { getStudioProgram, listStudioPrograms } from "../lib/studio-programs.js";
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

function clampToneStep(value) {
  const step = Math.round(Number(value) || DEFAULT_TONE_STEP);
  return Math.max(1, Math.min(36, step));
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

function ensureDistinctHex(hex, used, { floor = -1 } = {}) {
  const taken = used || new Set();
  let current = String(hex || "#000000").toUpperCase();
  let attempts = 0;
  while (attempts < 16) {
    if (!taken.has(current) && hexLuma(current) > floor) {
      taken.add(current);
      return current;
    }
    current = mixHex(current, "#FFFFFF", 0.14 + (attempts * 0.04));
    attempts += 1;
  }
  taken.add(current);
  return current;
}

const SUBDIVISIONS = [
  { value: 1, label: "1x1" },
  { value: 2, label: "2x2" },
  { value: 4, label: "4x4" },
  { value: 6, label: "6x6" },
  { value: 8, label: "8x8" },
  { value: 12, label: "12" },
  { value: 24, label: "24" },
];

export function mountNoStudioTool(root, shellApi = {}) {

  root.innerHTML = createStudioTemplate({
    subdivisions: SUBDIVISIONS,
    defaultToneStep: DEFAULT_TONE_STEP,
  });

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
    surpriseBtn: q("surprise-btn"),
    heroNoMinimal: q("hero-no-minimal"),
    heroRolePair: q("hero-role-pair"),
    programRail: q("program-rail"),
    presetList: q("preset-list"),
    presetGridLabel: q("preset-grid-label"),
    dockAdvanced: q("dock-advanced"),
    toneStepSlider: q("tone-step-slider"),
    toneStepValue: q("tone-step-value"),
    minimalSlider: q("minimal-slider"),
    minimalValue: q("minimal-value"),
    noMinimalModeRail: q("no-minimal-mode-rail"),
    activeBgToggle: q("active-bg-toggle"),
    noiseTargetRail: q("noise-target-rail"),
    noiseAmount: q("noise-amount"),
    noiseAmountValue: q("noise-amount-value"),
    applyNoise: q("apply-noise"),
    exportPng: q("export-png"),
    exportGif: q("export-gif"),
    saveGallery: q("save-gallery"),
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
    galleryMessage: "",
    activeTool: "pointer",
    activePresetTab: "mono",
    noFieldCore: "auto",
    toneStep: DEFAULT_TONE_STEP,
    essentialTones: 4,
    noMinimalDeltaMode: "exact",
    useActiveBg: false,
    activeTheory: "contour",
    activeDitherEngine: "quiet",
    activeNoiseTarget: "background",
    noiseAmount: 28,
    noisePass: 0,
    lastReductionMode: "none",
    lastProgramId: "",
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
    ditherPalette: [
      { r: 255, g: 255, b: 255 },
      { r: 0, g: 0, b: 0 },
    ],
    reliefFieldSeed: 0,
    userSubdivision: 1,
    activeColor: { h: 0, s: 0, l: 100 },
    activeColorHex: "#FFFFFF",
    noMinimalPreviewPair: null,
    noFieldIntensity: 62,
    noFieldField: 54,
    noFieldFinish: 28,
    noFieldSerial: false,
    noFieldLastFamily: "noir",
    popSheetLayout: "2x2",
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
        userSubdivision: state.userSubdivision,
        toneStep: state.toneStep,
        essentialTones: state.essentialTones,
        noMinimalDeltaMode: state.noMinimalDeltaMode,
        useActiveBg: state.useActiveBg,
        activeNoiseTarget: state.activeNoiseTarget,
        noiseAmount: state.noiseAmount,
        noFieldIntensity: state.noFieldIntensity,
        noFieldField: state.noFieldField,
        noFieldFinish: state.noFieldFinish,
        popSheetLayout: state.popSheetLayout,
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
    while (state.sessionSignatureOrder.length > 96) {
      const old = state.sessionSignatureOrder.shift();
      if (old) state.sessionSignatures.delete(old);
    }
  }

  function rememberOutputSignature(signature) {
    if (!signature || state.outputSignatures.has(signature)) return false;
    state.outputSignatures.add(signature);
    state.outputSignatureOrder.push(signature);
    while (state.outputSignatureOrder.length > 96) {
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
      state.activeDitherEngine,
      state.activeTheory,
      state.useActiveBg ? 1 : 0,
      state.noMinimalDeltaMode,
      state.toneStep,
      state.essentialTones,
      canvas.subdivision,
      canvas.getCurrentPalette().join(","),
    ].join(":");
  }

  function makeVariantSessionSignature(family, preset) {
    if (!preset) return null;
    const parts = [
      family,
      Math.round(Number(preset.baseHue || 0)),
      Math.round(Number((preset.bgLightness ?? preset.baseLightness ?? 0) * 100)),
      Math.round(Number((preset.bgSaturation ?? preset.baseSaturation ?? 0) * 100)),
      Math.round(Number((preset.colorSaturation ?? preset.accentSaturationLift ?? 0) * 100)),
      Math.round(Number(preset.hueSwing || preset.accentHueShift || 0)),
      Math.round(Number((preset.hueDrift || preset.bodyPulse || 0) * 10)),
      Math.round(Number((preset.curve || 0) * 100)),
      Math.round(Number((preset.contrast || 0) * 100)),
      Math.round(Number((preset.phase || preset.huePhase || preset.driftPhase || 0) * 100)),
      String(preset.harmony || ""),
      state.toneStep,
      state.essentialTones,
      canvas.subdivision,
    ];
    return parts.join(":");
  }

  function createUniqueVariant(family, sourcePalette) {
    const userAnchorHex = selectedActiveHex();
    const excludeActiveHex = family !== "warhol";
    let fallback = null;
    for (let i = 0; i < 24; i += 1) {
      const preset = createRandomPreset(family, {
        activeHex: userAnchorHex,
        sourcePalette,
        excludeActiveHex,
      });
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

  function setSubdivisionValue(value, { userDriven = false } = {}) {
    canvas.setSubdivision(value);
    topbar.querySelectorAll("[data-subdiv]").forEach((b) => b.classList.remove("is-active"));
    const active = topbar.querySelector(`[data-subdiv="${value}"]`);
    if (active) active.classList.add("is-active");
    const sub = SUBDIVISIONS.find((s) => s.value === value);
    els.presetGridLabel.textContent = `(grid: ${sub ? sub.label : value})`;
    if (userDriven) {
      state.userSubdivision = value;
    }
  }

  function setActivePresetTab(tabId) {
    state.activePresetTab = tabId;
    if (tabId === "mono" || tabId === "noir" || tabId === "warhol" || tabId === "acid" || tabId === "pastel") {
      state.noFieldCore = tabId;
    }
    root.querySelectorAll(".preset-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.presetTab === tabId));
    renderPresetList();
    const label = tabId === "warhol"
      ? "Pop"
      : tabId.charAt(0).toUpperCase() + tabId.slice(1);
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

  function syncToneStepUI() {
    state.toneStep = clampToneStep(state.toneStep);
    els.toneStepSlider.value = String(state.toneStep);
    els.toneStepValue.textContent = String(state.toneStep);
    setTopbarStatus(`Relief Δ${state.toneStep} · ${state.essentialTones} tones · ${canvas.subdivision}x${canvas.subdivision} grid`);
  }

  els.toneStepSlider.addEventListener("input", () => {
    state.toneStep = clampToneStep(els.toneStepSlider.value);
    syncToneStepUI();
  });

  function syncMinimalUI() {
    state.essentialTones = clampEssentialTones(state.essentialTones);
    els.minimalSlider.value = String(state.essentialTones);
    els.minimalValue.textContent = String(state.essentialTones);
    setTopbarStatus(`Relief Δ${state.toneStep} · ${state.essentialTones} tones · ${canvas.subdivision}x${canvas.subdivision} grid`);
  }

  els.minimalSlider.addEventListener("input", () => {
    state.essentialTones = clampEssentialTones(els.minimalSlider.value);
    syncMinimalUI();
  });

  syncToneStepUI();
  syncMinimalUI();

  function syncActiveBgToggle() {
    if (!els.activeBgToggle) return;
    els.activeBgToggle.classList.toggle("is-active", state.useActiveBg);
    els.activeBgToggle.textContent = `Active BG for Pop · ${state.useActiveBg ? "On" : "Off"}`;
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
    setTopbarStatus(state.useActiveBg ? "Pop uses the active background" : "Pop uses a machine-picked background");
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
    renderNoiseTargetRail();
    setTopbarStatus(`Noise target ${state.activeNoiseTarget}`);
  });

  els.noiseAmount?.addEventListener("input", () => {
    state.noiseAmount = Math.max(0, Math.min(100, Number(els.noiseAmount.value) || 0));
    if (els.noiseAmountValue) {
      els.noiseAmountValue.textContent = `${state.noiseAmount}%`;
    }
  });

  if (els.noiseAmountValue) {
    els.noiseAmountValue.textContent = `${state.noiseAmount}%`;
  }

  // ── Palette grid ──────────────────────────────────────────────

  function updatePaletteGrid() {
    const colors = state.sourcePaletteHexes.length ? state.sourcePaletteHexes : canvas.getCurrentPalette();
    els.paletteGrid.innerHTML = colors.map((hex) =>
      `<button class="palette-swatch" data-hex="${escapeHtml(hex)}" style="background:${escapeHtml(hex)}" title="${escapeHtml(hex)}"></button>`
    ).join("") || '<span style="font-size:11px;color:var(--text-dim)">Select a punk</span>';
  }

  els.paletteGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-hex]");
    if (!btn) return;
    const pickedHex = String(btn.dataset.hex || "").toUpperCase();
    setActiveColorFromHex(pickedHex);
    setTopbarStatus(`Active color ${pickedHex} armed`);

    if (!state.useActiveBg) {
      renderHeroRolePair();
    }
  });

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

  // ── Subdivision (the creative axis) ───────────────────────────

  const topbar = root.querySelector(".studio-topbar");
  topbar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-subdiv]");
    if (!btn) return;
    const value = Number(btn.dataset.subdiv);
    setSubdivisionValue(value, { userDriven: true });
    const sub = SUBDIVISIONS.find((s) => s.value === value);
    setTopbarStatus(`Relief Δ${state.toneStep} · ${sub ? sub.label : value} grid`);
  });

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

    // 1-7 for subdivision
    const n = parseInt(key);
    if (n >= 1 && n <= 7 && SUBDIVISIONS[n - 1]) {
      const sub = SUBDIVISIONS[n - 1];
      setSubdivisionValue(sub.value, { userDriven: true });
      setTopbarStatus(`Relief Δ${state.toneStep} · ${sub.label} grid`);
    }
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
            <div class="shortcut-row"><kbd>1</kbd> – <kbd>7</kbd><span>Grid Subdivision</span></div>
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

  // ── Presets — Grid-Aware ──────────────────────────────────────
  // When grid > 1x1, presets create multi-panel compositions.
  // Each block gets a rotated/shifted version of the preset.

  function activeCreativeFamily() {
    if (state.activePresetTab === "noir") return "noir";
    if (state.activePresetTab === "warhol") return "warhol";
    if (state.activePresetTab === "acid") return "acid";
    if (state.activePresetTab === "pastel") return "pastel";
    return "mono";
  }

  function activeRoleStep() {
    const family = activeCreativeFamily();
    if (family === "mono" || family === "noir" || family === "pastel") return 4;
    return state.toneStep;
  }

  function selectedActiveHex() {
    const raw = String(state.activeColorHex || els.colorHex.value || "").trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(raw)) return raw;
    const rgb = hslToRgb(state.activeColor.h, state.activeColor.s / 100, state.activeColor.l / 100);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  function originalAnchorHex(sourcePalette) {
    const source = Array.isArray(sourcePalette) ? sourcePalette : [];
    const activeHex = selectedActiveHex();
    const sourceHexes = new Set(source.map((entry) => String(entry?.hex || "").toUpperCase()));
    if (sourceHexes.has(activeHex)) return activeHex;

    const ranked = source
      .filter((entry) => entry && entry.role !== "background" && entry.role !== "outline")
      .slice()
      .sort((a, b) => {
        const aAccent = a.role === "accent" ? 1 : 0;
        const bAccent = b.role === "accent" ? 1 : 0;
        if (aAccent !== bAccent) return bAccent - aAccent;
        return hexLuma(String(b.hex || "#000000")) - hexLuma(String(a.hex || "#000000"));
      });

    if (ranked[0]?.hex) return String(ranked[0].hex).toUpperCase();
    if (source[0]?.hex) return String(source[0].hex).toUpperCase();
    return activeHex || "#808080";
  }

  function activeAnchorHex() {
    const raw = String(state.activeColorHex || els.colorHex.value || "").trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(raw)) return raw;
    const palette = state.sourcePaletteHexes.length ? state.sourcePaletteHexes : canvas.getCurrentPalette();
    return palette[0] || "#808080";
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
    const hue = (anchorHsl.h + randomInt(-90, 90) + 360) % 360;
    const sat = Math.max(0.18, Math.min(0.92, (anchorHsl.s * 0.9) + ((Math.random() * 0.36) - 0.08)));
    const light = Math.max(0.12, Math.min(0.72, (anchorHsl.l * 0.72) + ((Math.random() * 0.34) - 0.08)));
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

  function buildReactiveDitherPalette() {
    const engine = state.activeDitherEngine || "diffusion";
    const bgHex = state.useActiveBg ? selectedActiveHex() : currentBackgroundHex();
    const activeHex = selectedActiveHex();
    const rolePair = deriveRolePair(bgHex, activeRoleStep());
    const used = new Set([rolePair.background]);
    const floor = hexLuma(rolePair.figure);
    const reactiveHexes = [ensureDistinctHex(rolePair.figure, used, { floor: hexLuma(rolePair.background) })];
    const sourceHexes = state.ditherPalette.map((source) => rgbToHex(source.r, source.g, source.b));

    if (engine === "bayer") {
      const orderedHexes = [
        mixHex(rolePair.figure, activeHex, 0.18),
        mixHex(rolePair.figure, activeHex, 0.42),
        mixHex(activeHex, "#FFFFFF", 0.14),
        mixHex(sourceHexes[0] || activeHex, "#FFFFFF", 0.08),
      ];
      orderedHexes.forEach((hex) => reactiveHexes.push(ensureDistinctHex(hex, used, { floor })));
    } else if (engine === "cluster") {
      const clusteredHexes = [
        mixHex(rolePair.figure, sourceHexes[0] || activeHex, 0.24),
        mixHex(rolePair.figure, sourceHexes[1] || activeHex, 0.46),
        mixHex(sourceHexes[2] || activeHex, bgHex, 0.1),
      ];
      clusteredHexes.forEach((hex) => reactiveHexes.push(ensureDistinctHex(hex, used, { floor })));
    } else if (engine === "scan") {
      const scanHexes = [
        mixHex(rolePair.figure, activeHex, 0.2),
        mixHex(sourceHexes[0] || activeHex, rolePair.figure, 0.3),
        mixHex(sourceHexes[1] || activeHex, "#FFFFFF", 0.1),
        mixHex(sourceHexes[2] || activeHex, activeHex, 0.26),
      ];
      scanHexes.forEach((hex) => reactiveHexes.push(ensureDistinctHex(hex, used, { floor })));
    } else {
      for (let i = 0; i < sourceHexes.length; i += 1) {
        const sourceHex = sourceHexes[i];
        let nextHex = mixHex(sourceHex, bgHex, 0.18 + ((i % 3) * 0.06));
        if (hexLuma(nextHex) <= floor) {
          nextHex = mixHex(rolePair.figure, sourceHex, 0.35 + ((i % 2) * 0.08));
        }
        reactiveHexes.push(ensureDistinctHex(nextHex, used, { floor }));
      }
    }

    return reactiveHexes.slice(0, 6).map((hex) => hexToRgb(hex));
  }

  function ditherStrengthForEngine(baseStrength) {
    const base = Math.max(0, Math.min(1, Number(baseStrength) || 0));
    if (state.activeDitherEngine === "bayer") return Math.min(1, (base * 1.16) + 0.04);
    if (state.activeDitherEngine === "cluster") return Math.min(1, (base * 1.08) + 0.02);
    if (state.activeDitherEngine === "scan") return Math.min(1, (base * 1.12) + 0.05);
    return Math.max(0, base * 0.88);
  }

  function buildEngineOccupiedSet(imageData) {
    const fallback = canvas.getOccupied();
    if (!state.originalRoleMap || canvas.subdivision > 1) return fallback;
    const selected = new Set();
    for (let y = 0; y < imageData.height; y += 1) {
      for (let x = 0; x < imageData.width; x += 1) {
        const key = `${x},${y}`;
        if (!fallback.has(key)) continue;
        const role = state.originalRoleMap.get(key) || "body";
        if (state.activeDitherEngine === "diffusion") {
          if (role === "outline") continue;
          selected.add(key);
          continue;
        }
        if (state.activeDitherEngine === "cluster") {
          if (role === "accent") continue;
          selected.add(key);
          continue;
        }
        if (state.activeDitherEngine === "scan") {
          if (role === "accent") continue;
          if (role === "body" || role === "outline" || role === "neutral") selected.add(key);
          continue;
        }
        selected.add(key);
      }
    }
    return selected.size ? selected : fallback;
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
      els.galleryList.innerHTML = `<div class="gallery-empty">No-Gallery is only available on the local No-Studio server.</div>`;
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
    els.galleryList.innerHTML = state.galleryItems.map((item) => `
      <a class="gallery-card" href="${escapeHtml(item.viewUrl || item.pngUrl || "#")}" target="_blank" rel="noreferrer">
        <img class="gallery-thumb" src="${escapeHtml(item.pngUrl || "")}" alt="${escapeHtml(item.label || "No-Gallery entry")}" loading="lazy" />
        <span class="gallery-meta">
          <span class="gallery-title">${escapeHtml(item.label || `No-Studio #${item.tokenId || 0}`)}</span>
          <span class="gallery-subline">#${Number(item.tokenId) || 0} · ${(item.family || "studio").toUpperCase()}</span>
          <span class="gallery-subline">${item.rolePair?.background || "—"} → ${item.rolePair?.figure || "—"}</span>
        </span>
      </a>
    `).join("");
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

  async function saveCurrentToGallery() {
    if (!state.selected || state.gallerySaving) return;
    if (!state.noGalleryAvailable) {
      setTopbarStatus("No-Gallery is local-server only");
      return;
    }
    state.gallerySaving = true;
    updateExportButtons();
    const originalLabel = els.saveGallery ? els.saveGallery.textContent : "";
    if (els.saveGallery) {
      els.saveGallery.disabled = true;
      els.saveGallery.textContent = "Saving...";
    }
    try {
      const pngDataUrl = canvas.exportPng1024().toDataURL("image/png");
      const payload = await saveNoStudioGallery({
        tokenId: state.selected.id,
        family: state.activePresetTab === "warhol" ? "pop" : state.activePresetTab,
        label: els.topbarStatus.textContent || `No-Studio #${state.selected.id}`,
        rolePair: {
          background: state.noMinimalPreviewPair?.background || currentBackgroundHex(),
          figure: state.noMinimalPreviewPair?.figure || "—",
          mode: state.noMinimalDeltaMode,
        },
        pngDataUrl,
      });
      if (payload?.item) {
        state.galleryItems = [payload.item, ...state.galleryItems.filter((entry) => entry.id !== payload.item.id)].slice(0, 12);
      }
      state.galleryMessage = "";
      renderGallery();
      setTopbarStatus("Saved to No-Gallery");
    } catch (error) {
      setTopbarStatus(error.message || "Save to No-Gallery failed");
    } finally {
      state.gallerySaving = false;
      if (els.saveGallery) {
        els.saveGallery.textContent = originalLabel || "Save To No-Gallery";
      }
      updateExportButtons();
    }
  }

  function applyStudioCut(modeId) {
    if (!state.selected || !state.originalRoleMap) return;
    const current = canvas.exportImageData();
    const next = new Uint8ClampedArray(current.data);
    const occupied = state.originalOccupied || canvas.getOccupied();
    const roleMap = state.originalRoleMap;
    const bgHex = state.useActiveBg ? selectedActiveHex() : currentBackgroundHex();
    const rolePair = deriveRolePair(bgHex, activeRoleStep());
    const palette = canvas.getCurrentPalette().filter((hex) => hex !== rolePair.background && hex !== rolePair.figure)
      .sort((a, b) => hexLuma(a) - hexLuma(b));
    const brightHex = palette[palette.length - 1] || mixHex(rolePair.figure, "#FFFFFF", 0.42);
    const midHex = palette[Math.floor(palette.length / 2)] || mixHex(rolePair.figure, brightHex, 0.34);
    const plateBaseHex = mixHex(rolePair.figure, midHex, 0.28);
    const plateShiftHex = mixHex(midHex, brightHex, 0.24);
    const hotPlateHex = mixHex(brightHex, "#FFFFFF", 0.14);
    const fieldLowHex = mixHex(rolePair.background, rolePair.figure, 0.34);
    const fieldMidHex = mixHex(rolePair.background, rolePair.figure, 0.52);
    const innerFieldHex = mixHex(rolePair.figure, brightHex, 0.12);

    const cutLabels = {
      "plate-shift": "Plate Shift",
      "relief-field": "Relief Field",
    };
    const cutLabel = cutLabels[modeId] || modeId;

    for (let y = 0; y < current.height; y += 1) {
      for (let x = 0; x < current.width; x += 1) {
        const i = (y * current.width + x) * 4;
        const key = `${x},${y}`;
        let targetHex = rolePair.background;
        if (!occupied.has(key)) {
          if (modeId === "relief-field") {
            const wave = (x * 3) + (y * 5) + state.toneStep;
            const band = ((Math.floor(wave / 4) % 3) + 3) % 3;
            targetHex = band === 0 ? rolePair.background : (band === 1 ? fieldLowHex : fieldMidHex);
          }
        } else {
          const role = roleMap.get(key) || "body";
          if (role === "outline") {
            targetHex = rolePair.figure;
          } else if (modeId === "plate-shift") {
            const stripe = ((x + (y * 2) + state.toneStep) % 4 + 4) % 4;
            if (role === "accent") {
              targetHex = stripe >= 2 ? hotPlateHex : brightHex;
            } else if (role === "neutral") {
              targetHex = stripe % 2 === 0 ? plateShiftHex : midHex;
            } else {
              targetHex = stripe <= 1 ? plateBaseHex : plateShiftHex;
            }
          } else if (modeId === "relief-field") {
            targetHex = role === "accent" ? brightHex : (role === "neutral" ? innerFieldHex : fieldMidHex);
          } else {
            targetHex = role === "accent" ? brightHex : plateBaseHex;
          }
        }
        const rgb = hexToRgb(targetHex);
        next[i] = rgb.r;
        next[i + 1] = rgb.g;
        next[i + 2] = rgb.b;
        next[i + 3] = 255;
      }
    }

    const roleStep = activeRoleStep();
    const roleTag = roleStep === 4 && ["mono", "noir", "pastel"].includes(activeCreativeFamily()) ? "Δ4 role lock" : `Δ${state.toneStep}`;
    state.lastReductionMode = modeId;
    canvas.applyImageData(new ImageData(next, current.width, current.height));
    setTopbarStatus(`${cutLabel} · ${roleTag} · ${state.essentialTones} tones`);
    pulseStudio(modeId === "relief-field" ? "surprise" : "variant");
  }

  function applySerialSheet() {
    if (!state.selected) return;
    const classified = state.sourceClassifiedPalette || canvas.getClassifiedPalette();
    const family = activeCreativeFamily();
    const previousSubdiv = canvas.subdivision;
    setSubdivisionValue(2);
    const serialVariants = Array.from({ length: 4 }, () => createUniqueVariant(family, classified));
    canvas.applyGridMapping((col, row, blockIdx) => {
      const preset = serialVariants[blockIdx] || serialVariants[(row * 2) + col] || serialVariants[0];
      const result = collapsePresetResult(
        classified,
        applyPreset(preset, classified, {
          toneStep: state.toneStep,
          roleStep: activeRoleStep(),
          backgroundHex: state.useActiveBg && family === "warhol" ? selectedActiveHex() : null,
        }),
        family === "warhol" ? Math.max(6, state.essentialTones) : Math.max(4, state.essentialTones),
      );
      return result;
    });
    state.variantByFamily[family] = serialVariants[0];
    renderVariantPanel();
    const familyLabel = family === "warhol" ? "Pop Sheet" : "Serial Sheet";
    setTopbarStatus(`${familyLabel} · 2x2 serial print · ${family === "warhol" ? Math.max(6, state.essentialTones) : Math.max(4, state.essentialTones)} tones${previousSubdiv !== 2 ? " · grid locked to 2x2" : ""}`);
    pulseStudio("surprise");
  }

  function getPopSheetSpec(layoutId) {
    const specs = {
      "2x2": { cols: 2, rows: 2, label: "2x2" },
      "3x3": { cols: 3, rows: 3, label: "3x3" },
      "4x4": { cols: 4, rows: 4, label: "4x4" },
    };
    return specs[layoutId] || specs["2x2"];
  }

  function applyPopSheet(layoutId = state.popSheetLayout) {
    if (!state.selected || !state.originalImageData) return;

    const { cols, rows, label } = getPopSheetSpec(layoutId);
    const source = state.originalImageData;
    const classified = state.sourceClassifiedPalette || canvas.getClassifiedPalette();
    const panelCount = cols * rows;
    const toneTarget = Math.max(6, state.essentialTones);

    const panelResults = Array.from({ length: panelCount }, () => {
      const preset = createUniqueVariant("warhol", classified);
      const result = collapsePresetResult(
        classified,
        applyPreset(preset, classified, {
          toneStep: state.toneStep,
          roleStep: state.toneStep,
          backgroundHex: null,
        }),
        toneTarget,
      );
      return {
        preset,
        mapping: new Map(Object.entries(result.mapping || {}).map(([k, v]) => [String(k).toUpperCase(), String(v).toUpperCase()])),
        roles: result.roles,
      };
    });

    const tiles = panelResults.map((panel) => {
      const tile = new Uint8ClampedArray(source.data.length);
      for (let y = 0; y < source.height; y += 1) {
        for (let x = 0; x < source.width; x += 1) {
          const idx = (y * source.width + x) * 4;
          const alpha = source.data[idx + 3];
          let targetHex = panel.roles?.background || "#000000";
          if (alpha > 0) {
            const origHex = rgbToHex(source.data[idx], source.data[idx + 1], source.data[idx + 2]).toUpperCase();
            if (origHex === "#040404") {
              targetHex = panel.roles?.outline || targetHex;
            } else if (origHex === "#000000") {
              targetHex = panel.roles?.background || targetHex;
            } else {
              targetHex = panel.mapping.get(origHex) || origHex;
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
    state.lastReductionMode = "pop-sheet";
    canvas.setSheetTiles(tiles, cols, rows);
    renderVariantPanel();
    setTopbarStatus(`Pop Sheet · ${label} serial print · full 24×24 tile per panel`);
    pulseStudio("surprise");
  }

  function noFieldToneTarget() {
    const intensity = Math.max(0, Math.min(100, Number(state.noFieldIntensity) || 0)) / 100;
    return clampEssentialTones(Math.round(lerp(7, 3, intensity)));
  }

  function chooseNoFieldFamily() {
    if (state.noFieldCore === "mono" || state.noFieldCore === "noir" || state.noFieldCore === "warhol" || state.noFieldCore === "acid" || state.noFieldCore === "pastel") {
      return state.noFieldCore;
    }
    const intensity = Math.max(0, Math.min(100, Number(state.noFieldIntensity) || 0)) / 100;
    const field = Math.max(0, Math.min(100, Number(state.noFieldField) || 0)) / 100;
    if (state.noFieldSerial) return "warhol";
    if (field >= 0.72) return pickOne(["noir", "acid", "warhol"]) || "noir";
    if (intensity >= 0.72) return pickOne(["noir", "acid", "pastel"]) || "noir";
    if (intensity <= 0.28 && field <= 0.42) return pickOne(["warhol", "pastel"]) || "warhol";
    return pickOne(["noir", "mono", "warhol", "acid", "pastel"]) || "noir";
  }

  function buildNoFieldSingle(classified, family, backgroundHex, toneTarget) {
    const preset = createUniqueVariant(family, classified);
    state.variantByFamily[family] = preset;
    const base = applyPreset(preset, classified, {
      toneStep: state.toneStep,
      roleStep: family === "mono" || family === "noir" || family === "pastel" ? 4 : state.toneStep,
      backgroundHex,
    });
    const result = collapsePresetResult(classified, base, toneTarget);
    syncHeroPairFromRoles(result.roles, family === "mono" || family === "noir" || family === "pastel" ? 4 : state.toneStep);
    canvas.applyColorMapping(result.mapping, result.roles);
    return preset;
  }

  function buildNoFieldSerial(classified, family, backgroundHex, toneTarget) {
    const previousSubdiv = canvas.subdivision;
    setSubdivisionValue(2);
    const variants = Array.from({ length: 4 }, () => createUniqueVariant(family, classified));
    const previewResult = collapsePresetResult(
      classified,
      applyPreset(variants[0], classified, {
        toneStep: state.toneStep,
        roleStep: family === "mono" || family === "noir" || family === "pastel" ? 4 : state.toneStep,
        backgroundHex,
      }),
      toneTarget,
    );
    syncHeroPairFromRoles(previewResult.roles, family === "mono" || family === "noir" || family === "pastel" ? 4 : state.toneStep);
    canvas.applyGridMapping((col, row, blockIdx) => {
      const preset = variants[blockIdx] || variants[(row * 2) + col] || variants[0];
      return collapsePresetResult(
        classified,
        applyPreset(preset, classified, {
          toneStep: state.toneStep,
          roleStep: family === "mono" || family === "noir" || family === "pastel" ? 4 : state.toneStep,
          backgroundHex,
        }),
        toneTarget,
      );
    });
    state.variantByFamily[family] = variants[0];
    return previousSubdiv;
  }

  function runNoFieldPass({ family, holdWorld = false, serial = state.noFieldSerial, statusPrefix = "Studio" } = {}) {
    if (!state.selected) {
      setServerStatus("Select a NoPunk first.");
      return null;
    }

    if (!serial && canvas.subdivision !== state.userSubdivision) {
      setSubdivisionValue(state.userSubdivision);
    }

    const classified = state.sourceClassifiedPalette || canvas.getClassifiedPalette();
    const pair = holdWorld ? ensureNoMinimalPreviewPair() : null;
    const backgroundHex = holdWorld ? pair.background : (state.useActiveBg && family === "warhol" ? selectedActiveHex() : null);
    const toneTarget = family === "warhol"
      ? Math.max(6, noFieldToneTarget())
      : family === "acid"
        ? Math.max(5, noFieldToneTarget())
        : noFieldToneTarget();
    const fieldLevel = Math.max(0, Math.min(100, Number(state.noFieldField) || 0));
    const finishLevel = Math.max(0, Math.min(100, Number(state.noFieldFinish) || 0));

    let previousSubdiv = null;
    if (serial) {
      previousSubdiv = buildNoFieldSerial(classified, family, backgroundHex, toneTarget);
    } else {
      buildNoFieldSingle(classified, family, backgroundHex, toneTarget);
    }

    if (fieldLevel >= 58) {
      applyStudioCut(fieldLevel >= 76 ? "relief-field" : "plate-shift");
    }

    state.noFieldLastFamily = family;
    renderHeroRolePair();
    renderVariantPanel();
    const familyLabel = family === "warhol" ? "Pop" : family.charAt(0).toUpperCase() + family.slice(1);
    const serialNote = serial ? ` · serial 2x2${previousSubdiv !== 2 ? " locked" : ""}` : "";
    setTopbarStatus(`${statusPrefix} · ${familyLabel} · intensity ${state.noFieldIntensity}% · field ${state.noFieldField}% · finish ${state.noFieldFinish}%${serialNote}`);
    pulseStudio(holdWorld ? "variant" : "surprise");
    return { family, pair: state.noMinimalPreviewPair, toneTarget, serial, previousSubdiv };
  }

  function applyNoField({ holdWorld = false } = {}) {
    const family = chooseNoFieldFamily();
    runNoFieldPass({ family, holdWorld, serial: state.noFieldSerial, statusPrefix: "Cast" });
  }

  function applyNoMinimalism() {
    if (!state.selected || !state.originalRoleMap) return;

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
    const current = state.variantByFamily[state.noFieldLastFamily] || null;
    const familyLabel = state.noFieldLastFamily === "warhol"
      ? "Pop"
      : state.noFieldLastFamily.charAt(0).toUpperCase() + state.noFieldLastFamily.slice(1);
    const activeTab = state.activePresetTab;
    const toneTarget = activeTab === "warhol"
      ? Math.max(6, noFieldToneTarget())
      : activeTab === "acid"
        ? Math.max(5, noFieldToneTarget())
        : noFieldToneTarget();
    const world = ensureNoMinimalPreviewPair();
    const selectedTool = activeTab === "warhol"
      ? "Pop"
      : activeTab.charAt(0).toUpperCase() + activeTab.slice(1);
    const toolNote = {
      mono: "Machine-picked monotone fields. Poster compression without losing the twin-lift.",
      noir: "Dark relief-first casting. Twin-lift stays strict while the mass compresses.",
      warhol: "Graphic serial color lanes. Build single-frame pop or multi-panel sheets with a unique palette in each cell.",
      acid: "Synthetic, unstable, corrosive colour tension. High-contrast shifts and sharper, less comfortable harmony.",
      pastel: "Soft, airy, powder-like colour. Light worlds, gentle separation and restrained contrast.",
    }[activeTab] || "Original-source recast. Every pass starts from the loaded punk.";
    const toolActions = `
        <div class="variant-action-grid">
          <button class="preset-btn" type="button" data-action="render-core" data-family="${activeTab === "warhol" ? "warhol" : activeTab}">Cast ${escapeHtml(selectedTool)}</button>
          ${activeTab === "warhol"
            ? `
              <button class="preset-btn" type="button" data-action="build-pop-sheet">Build Pop Sheet</button>
            `
            : '<button class="preset-btn" type="button" data-action="hold">Hold World</button>'}
        </div>
      `;
    const popSheetControls = activeTab === "warhol"
      ? `
        <div class="variant-title">Sheet Layout</div>
        <div class="theory-rail pop-sheet-rail">
          <button class="theory-btn${state.popSheetLayout === "2x2" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="2x2">2x2</button>
          <button class="theory-btn${state.popSheetLayout === "3x3" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="3x3">3x3</button>
          <button class="theory-btn${state.popSheetLayout === "4x4" ? " is-active" : ""}" type="button" data-action="set-pop-sheet" data-layout="4x4">4x4</button>
        </div>
        <div class="mini-note no-field-guidance">Each panel uses the original 24×24 punk as a full tile with its own pop palette. The sheet does not resize the punk down inside the tile.</div>
      `
      : "";
    els.presetList.innerHTML = `
      <div class="variant-panel no-field-panel">
        <div class="variant-title">Current Cast</div>
        <div class="variant-chips">
          <span class="variant-chip">Original-source render</span>
          <span class="variant-chip">Twin-lift active</span>
          <span class="variant-chip">${escapeHtml(selectedTool)} family</span>
          <span class="variant-chip">Live pass · ${escapeHtml(familyLabel)}</span>
          <span class="variant-chip">${toneTarget} tones</span>
        </div>
        <div class="mini-note no-field-guidance">${escapeHtml(toolNote)}</div>
        <div class="role-pair-readout">Role pair · ${escapeHtml(world.background)} → ${escapeHtml(world.figure)} · ${world.roleStep} lift</div>
        <div class="mini-note no-field-guidance">Cast uses your current grid. A sheet only runs when you explicitly build one.</div>
        <div class="no-field-meters">
          <label class="no-field-meter">
            <span class="no-field-meter-label">Intensity</span>
            <input type="range" class="color-slider" data-action="set-intensity" min="0" max="100" value="${state.noFieldIntensity}" />
            <span class="color-slider-value">${state.noFieldIntensity}%</span>
          </label>
          <label class="no-field-meter">
            <span class="no-field-meter-label">Field</span>
            <input type="range" class="color-slider" data-action="set-field" min="0" max="100" value="${state.noFieldField}" />
            <span class="color-slider-value">${state.noFieldField}%</span>
          </label>
          <label class="no-field-meter">
            <span class="no-field-meter-label">Finish</span>
            <input type="range" class="color-slider" data-action="set-finish" min="0" max="100" value="${state.noFieldFinish}" />
            <span class="color-slider-value">${state.noFieldFinish}%</span>
          </label>
        </div>
        ${toolActions}
        ${popSheetControls}
        <button class="preset-btn" type="button" data-action="refresh-pair">Recast World</button>
        <div class="variant-title">${escapeHtml(current?.name || "Original-source render ready")}</div>
        <div class="variant-chips">
          ${variantChipsMarkup(current)}
        </div>
      </div>
    `;
  }

  function applyCreativeVariant({ maximal = false } = {}) {
    if (!state.selected) return;
    const family = activeCreativeFamily();
    const classified = state.sourceClassifiedPalette || canvas.getClassifiedPalette();
    const preset = createUniqueVariant(family, classified);
    state.variantByFamily[family] = preset;
    const presetOptions = {
      toneStep: state.toneStep,
      roleStep: activeRoleStep(),
      backgroundHex: state.useActiveBg && family === "warhol" ? selectedActiveHex() : null,
    };
    let toneTarget = maximal ? 3 : state.essentialTones;
    if (family === "warhol") {
      toneTarget = Math.max(toneTarget, 6);
    } else if (family === "acid") {
      toneTarget = Math.max(toneTarget, 5);
    }

    if (canvas.subdivision <= 1) {
      const base = applyPreset(preset, classified, presetOptions);
      const result = collapsePresetResult(classified, base, toneTarget);
      canvas.applyColorMapping(result.mapping, result.roles);
    } else {
      const baseGridFn = createGridPresetFn(preset, classified, presetOptions);
      canvas.applyGridMapping((...args) => {
        const result = baseGridFn(...args);
        return collapsePresetResult(classified, result, toneTarget);
      });
    }

    const roleTag = presetOptions.roleStep === 4 && ["mono", "noir", "pastel"].includes(family) ? "Δ4 role lock" : `Δ${state.toneStep}`;
    state.lastReductionMode = "none";
    renderVariantPanel();
    setTopbarStatus(`${preset.name} · ${roleTag} · ${toneTarget} tones · ${canvas.subdivision}x${canvas.subdivision}`);
    pulseStudio("variant");
  }

  function syncStudioDeckVisibility() {
    if (els.activeBgToggle) {
      els.activeBgToggle.style.display = state.activePresetTab === "warhol" ? "block" : "none";
    }
  }

  function renderPresetList() {
    syncStudioDeckVisibility();
    renderVariantPanel();
  }

  els.presetList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "hold") {
      applyNoField({ holdWorld: true });
      return;
    }
    if (btn.dataset.action === "render-core") {
      const family = btn.dataset.family || activeCreativeFamily();
      runNoFieldPass({ family, holdWorld: false, serial: false, statusPrefix: `Render ${family === "warhol" ? "Pop" : family.charAt(0).toUpperCase() + family.slice(1)}` });
      return;
    }
    if (btn.dataset.action === "build-pop-sheet") {
      applyPopSheet(state.popSheetLayout);
      return;
    }
    if (btn.dataset.action === "set-pop-sheet") {
      state.popSheetLayout = btn.dataset.layout || "2x2";
      renderVariantPanel();
      setTopbarStatus(`Pop Sheet ${state.popSheetLayout} armed`);
      return;
    }
    if (btn.dataset.action === "refresh-pair") {
      refreshNoMinimalPreviewPair();
      renderHeroRolePair();
      renderVariantPanel();
      setTopbarStatus("World recast");
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
    if (target.dataset.action === "set-intensity") {
      state.noFieldIntensity = Math.max(0, Math.min(100, Number(target.value) || 0));
      scheduleVariantPanelRender();
      return;
    }
    if (target.dataset.action === "set-field") {
      state.noFieldField = Math.max(0, Math.min(100, Number(target.value) || 0));
      scheduleVariantPanelRender();
      return;
    }
    if (target.dataset.action === "set-finish") {
      state.noFieldFinish = Math.max(0, Math.min(100, Number(target.value) || 0));
      scheduleVariantPanelRender();
    }
  });

  function executeStudioProgram(programId) {
    const sourcePalette = state.sourcePaletteHexes.length ? state.sourcePaletteHexes : canvas.getCurrentPalette();
    const weightedSubdivisions = [1, 2, 4, 4, 6, 6, 8, 8, 12, 12, 24];
    const families = ["mono", "noir", "warhol", "acid", "pastel"];
    const theories = ["contour", "plate", "halo", "drift"];
    const engines = ["quiet", "balanced", "signal", "flood"];

    function randomizeActiveFromPalette() {
      const picked = pickOne(sourcePalette);
      if (picked) {
        setActiveColorFromHex(picked);
        return;
      }
      const rgb = hslToRgb(randomInt(0, 359), randomInt(22, 90) / 100, randomInt(20, 78) / 100);
      setActiveColorFromHex(rgbToHex(rgb.r, rgb.g, rgb.b));
    }

    function pickFamily(program) {
      if (program.familyBias === "pop") return "warhol";
      if (program.familyBias === "dither") return "acid";
      if (program.familyBias === "acid" || program.familyBias === "pastel") return program.familyBias;
      if (program.familyBias === "noir" || program.familyBias === "mono") return program.familyBias;
      return pickOne(families) || "mono";
    }

    function pickEngine(program) {
      if (program.ditherBias === "diffuse") return "quiet";
      if (program.ditherBias === "mixed" || !program.ditherBias) return pickOne(engines) || "quiet";
      if (program.ditherBias === "bayer") return "balanced";
      if (program.ditherBias === "cluster") return "signal";
      if (program.ditherBias === "scan") return "flood";
      return "quiet";
    }

    function tuneIntensity(program) {
      if (program.intensityBand === "low") {
        state.toneStep = randomInt(2, 8);
        state.essentialTones = randomInt(3, 4);
        return;
      }
      if (program.intensityBand === "high") {
        state.toneStep = randomInt(8, 24);
        state.essentialTones = randomInt(4, 7);
        return;
      }
      state.toneStep = randomInt(4, 16);
      state.essentialTones = randomInt(3, 6);
    }

    const program = getStudioProgram(programId);
    const family = pickFamily(program);
    const theory = pickOne(theories) || "mono";
    const engine = pickEngine(program);
    const subdivision = pickOne(weightedSubdivisions) || 1;

    randomizeActiveFromPalette();
    state.useActiveBg = Math.random() < program.useActiveBgChance;
    tuneIntensity(program);
    state.activeTheory = theory;
    state.activeDitherEngine = engine;
    syncToneStepUI();
    syncMinimalUI();
    syncActiveBgToggle();
    setSubdivisionValue(subdivision);

    const applyProgramDither = (strengthMin, strengthMax) => {
      buildTheoryFromActiveColor();
      performDither({ strength: strengthMin + (Math.random() * (strengthMax - strengthMin)), addGrain: false });
    };

    if (program.id === "monolith") {
      setActivePresetTab(pickOne(["mono", "noir", "pastel"]) || family);
      state.essentialTones = 3;
      syncMinimalUI();
      applyCreativeVariant({ maximal: true });
      applyStudioCut("relief-field");
    } else if (program.id === "signal") {
      setActivePresetTab(pickOne(["noir", "warhol", "acid"]) || family);
      applyCreativeVariant({ maximal: false });
      applyStudioCut("plate-shift");
      applyProgramDither(0.68, 0.92);
    } else if (program.id === "fracture") {
      setSubdivisionValue(pickOne([6, 8, 12, 24]) || 8);
      setActivePresetTab(family);
      applyCreativeVariant({ maximal: false });
      applyStudioCut("plate-shift");
      applyProgramDither(0.54, 0.84);
    } else if (program.id === "echo") {
      setActivePresetTab(pickOne(["noir", "mono"]) || family);
      applyCreativeVariant({ maximal: false });
      applyStudioCut("relief-field");
    } else if (program.id === "veil") {
      setActivePresetTab("pastel");
      state.essentialTones = 3;
      syncMinimalUI();
      applyCreativeVariant({ maximal: true });
      applyStudioCut("relief-field");
    } else if (program.id === "pulse") {
      setActivePresetTab("warhol");
      applyCreativeVariant({ maximal: false });
      applyProgramDither(0.66, 0.88);
    } else if (program.id === "afterimage") {
      setActivePresetTab("noir");
      applyCreativeVariant({ maximal: false });
      applyStudioCut(pickOne(["relief-field", "plate-shift"]) || "relief-field");
      applyProgramDither(0.3, 0.5);
    } else {
      setActivePresetTab(family);
      state.essentialTones = randomInt(3, 5);
      syncMinimalUI();
      applyCreativeVariant({ maximal: Math.random() < 0.4 });
      applyStudioCut(pickOne(["plate-shift", "relief-field"]) || "plate-shift");
      if (Math.random() < 0.45) applyProgramDither(0.42, 0.7);
    }

    state.lastProgramId = program.id;
    return program;
  }

  function surpriseMe() {
    if (!state.selected) {
      setServerStatus("Select a NoPunk first.", "warn");
      return;
    }
    const programs = listStudioPrograms();
    let accepted = false;
    let chosenProgram = getStudioProgram("poster");
    for (let attempt = 0; attempt < 9; attempt += 1) {
      chosenProgram = executeStudioProgram((pickOne(programs) || chosenProgram).id);
      const signature = makeCanvasOutputSignature();
      if (rememberOutputSignature(signature)) {
        accepted = true;
        break;
      }
    }

    if (!accepted) {
      rememberOutputSignature(makeCanvasOutputSignature());
    }

    setTopbarStatus(`Program: ${chosenProgram.label} · Δ${state.toneStep} · ${state.essentialTones} tones · ${canvas.subdivision}x${canvas.subdivision}`);
    pulseStudio("surprise");
  }

  els.programRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-program]");
    if (!button) return;
    if (!state.selected) {
      setServerStatus("Select a NoPunk first.", "warn");
      return;
    }
    const program = executeStudioProgram(button.dataset.program);
    rememberOutputSignature(makeCanvasOutputSignature());
    setTopbarStatus(`Program: ${program.label} · artist pass`);
    pulseStudio("surprise");
  });

  els.surpriseBtn?.addEventListener("click", () => applyNoField({ holdWorld: false }));
  els.heroNoMinimal?.addEventListener("click", () => applyNoMinimalism());

  renderPresetList();

  // ── Relief Field ──────────────────────────────────────────────

  function reliefTheoryLabel() {
    const labels = {
      contour: "Contour",
      plate: "Plate",
      halo: "Halo",
      drift: "Drift",
    };
    return labels[state.activeTheory] || "Contour";
  }

  function reliefBiasLabel() {
    const labels = {
      quiet: "Quiet",
      balanced: "Balanced",
      signal: "Signal",
      flood: "Flood",
    };
    return labels[state.activeDitherEngine] || "Quiet";
  }

  function buildTheoryFromActiveColor() {
    refreshNoMinimalPreviewPair();
    renderHeroRolePair();
    setTopbarStatus(`Relief Field retuned · ${reliefTheoryLabel()} · ${reliefBiasLabel()}`);
  }

  function performDither({ strength = null, addGrain = false } = {}) {
    if (!state.selected) return;
    const rawAmount = strength == null
      ? 0.58
      : Math.max(0, Math.min(1, Number(strength)));

    const fieldCut = (state.activeTheory === "plate" || state.activeTheory === "drift")
      ? "plate-shift"
      : "relief-field";
    applyStudioCut(fieldCut);

    const amount = Math.max(0, Math.min(1, rawAmount));
    if (addGrain) {
      const target = state.activeDitherEngine === "signal" ? "figure" : "background";
      let grainAmount = 0.04 + (amount * 0.14);
      if (state.activeDitherEngine === "quiet") grainAmount *= 0.7;
      if (state.activeDitherEngine === "balanced") grainAmount *= 0.92;
      if (state.activeDitherEngine === "flood") grainAmount *= 1.28;

      applyDisplayGrain({
        enabled: grainAmount > 0.02,
        target,
        amount: Math.min(0.28, grainAmount),
        activeHex: target === "figure" ? nearestPaletteHex(selectedActiveHex()) : null,
        seed: ++state.noisePass,
      });
    }

    setTopbarStatus(`Relief Field · ${reliefTheoryLabel()} · ${reliefBiasLabel()} · ${Math.round(amount * 100)}% depth`);
    pulseStudio("dither");
  }
  els.applyNoise?.addEventListener("click", applyNoise);

  // ── Export ────────────────────────────────────────────────────

  function updateExportButtons() {
    const ok = state.selected != null;
    const grain = canvas.getDisplayGrain();
    els.exportPng.disabled = !ok;
    els.exportGif.disabled = !ok || !grain.enabled || !(grain.amount > 0);
    if (els.saveGallery) {
      els.saveGallery.disabled = !ok || state.gallerySaving;
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

  async function exportNoiseGifInBrowser() {
    const grain = canvas.getDisplayGrain();
    const frames = [];
    const baseSeed = Math.max(0, Number(grain.seed) || 0);
    const totalFrames = 12;
    for (let i = 0; i < totalFrames; i += 1) {
      const frameCanvas = canvas.exportPng1024({
        grain: {
          ...grain,
          enabled: true,
          seed: baseSeed + i,
        },
      });
      const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
      const frameImage = frameCtx.getImageData(0, 0, 1024, 1024);
      frames.push(quantizeImageDataToRgb332(frameImage));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const gifBytes = encodeIndexedGif({
      width: 1024,
      height: 1024,
      frames,
      delayMs: Math.round(1000 / totalFrames),
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

      const browserGif = await exportNoiseGifInBrowser();
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

  els.saveGallery?.addEventListener("click", () => {
    saveCurrentToGallery();
  });

  els.galleryRefresh?.addEventListener("click", () => {
    refreshGallery();
  });

  // ── Sidebar toggle / dock drawer ──────────────────────────────

  els.sidebarToggle?.addEventListener("click", () => setSidebarOpen(!els.sidebar.classList.contains("is-open")));
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
    if (savedSession.userSubdivision != null) state.userSubdivision = savedSession.userSubdivision;
    if (savedSession.toneStep != null) state.toneStep = clampToneStep(savedSession.toneStep);
    if (savedSession.essentialTones != null) state.essentialTones = clampEssentialTones(savedSession.essentialTones);
    if (savedSession.noMinimalDeltaMode) state.noMinimalDeltaMode = savedSession.noMinimalDeltaMode;
    if (savedSession.useActiveBg != null) state.useActiveBg = savedSession.useActiveBg;
    if (savedSession.activeNoiseTarget) state.activeNoiseTarget = savedSession.activeNoiseTarget;
    if (savedSession.noiseAmount != null) state.noiseAmount = savedSession.noiseAmount;
    if (savedSession.noFieldIntensity != null) state.noFieldIntensity = savedSession.noFieldIntensity;
    if (savedSession.noFieldField != null) state.noFieldField = savedSession.noFieldField;
    if (savedSession.noFieldFinish != null) state.noFieldFinish = savedSession.noFieldFinish;
    if (savedSession.popSheetLayout) state.popSheetLayout = savedSession.popSheetLayout;
    syncColorUI();
    syncToneStepUI();
    syncMinimalUI();
    syncActiveBgToggle();
    renderNoMinimalModeRail();
    renderNoiseTargetRail();
    setSubdivisionValue(state.userSubdivision);
    setActivePresetTab(state.activePresetTab);
    if (els.noiseAmount) els.noiseAmount.value = String(state.noiseAmount);
    if (els.noiseAmountValue) els.noiseAmountValue.textContent = `${state.noiseAmount}%`;
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
