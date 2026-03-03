import { getNoStudioConfig, getNoStudioHead, generateNoStudio, renderNoStudioNoiseGif } from "../api.js";
import { mountPunkPicker } from "../components/punk-picker.js";
import {
  createSourceImageDataFromImage,
  classifyPixelRoles,
  decodeRgba24B64,
  encodeRgba24B64,
  getOccupiedPixels,
  imageDataFromRgba24,
} from "../lib/no-palette-render.js";
import { StudioCanvas } from "../lib/studio-canvas.js";
import {
  applyPreset, createGridPresetFn,
  buildTheoryPalette, createRandomPreset, DEFAULT_TONE_STEP,
  hslToRgb, rgbToHsl, rgbToHex, hexToRgb,
} from "../lib/art-presets.js";
import { deriveNoMinimalismPair, deriveRolePair } from "../lib/studio-signature.js";
import { getStudioProgram, listStudioPrograms } from "../lib/studio-programs.js";
import { applyStudioDither, previewDitherEngineLabel } from "../lib/floyd-steinberg.js";
import { exportCanvasPng } from "../lib/download.js";

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

function createFallbackModes() {
  return [
    { id: "canonical-machine", label: "Machine", descriptionShort: "Block-driven canonical state", exportKinds: ["single"] },
    { id: "dither-study", label: "Texture", descriptionShort: "Structured texture on 24x24", exportKinds: ["single"] },
    { id: "serial-pop", label: "Serial", descriptionShort: "Six nearby block states", exportKinds: ["single", "contact-sheet"] },
  ];
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

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

function pickOne(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[randomInt(0, list.length - 1)];
}

function hexLuma(hex) {
  const rgb = hexToRgb(hex);
  return (0.2126 * rgb.r) + (0.7152 * rgb.g) + (0.0722 * rgb.b);
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

function mixHex(aHex, bHex, t) {
  const a = hexToRgb(aHex);
  const b = hexToRgb(bHex);
  const n = Math.max(0, Math.min(1, Number(t) || 0));
  return rgbToHex(
    a.r + ((b.r - a.r) * n),
    a.g + ((b.g - a.g) * n),
    a.b + ((b.b - a.b) * n),
  );
}

function distanceRgb(aHex, bHex) {
  const a = hexToRgb(aHex);
  const b = hexToRgb(bHex);
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
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

  root.innerHTML = `
    <div class="studio" data-role="studio">
      <!-- Toolbar -->
      <div class="studio-toolbar">
        <button class="tool-btn is-active" data-tool="pointer" title="Pointer (V)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2l10 6-5 1-2 5z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
        </button>
        <button class="tool-btn" data-tool="paint" title="Paint (B)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="6" y="2" width="4" height="10" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M6 12h4v2H6z" fill="currentColor"/></svg>
        </button>
        <button class="tool-btn" data-tool="fill" title="Fill Block (G)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" opacity=".3"/></svg>
        </button>
        <button class="tool-btn" data-tool="eyedropper" title="Eyedropper (I)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 2l2 2-8 8-3 1 1-3z" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <div class="toolbar-sep"></div>
        <button class="tool-btn" data-tool="zoom-in" title="Zoom In">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5"/><path d="M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
        <button class="tool-btn" data-tool="zoom-out" title="Zoom Out">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5"/><path d="M5 7h4" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
      </div>

      <!-- Topbar -->
      <div class="studio-topbar">
        <div class="topbar-brandlock">
          <span class="topbar-kicker">Noir de Noir</span>
          <span class="topbar-brand">NO-STUDIO</span>
          <span class="topbar-brand-note">Reduce Form. Let Traits Carry.</span>
        </div>
        <div class="topbar-sep"></div>
        <div class="topbar-group">
          <span class="topbar-label">Grid</span>
          ${SUBDIVISIONS.map((s) => `<button class="topbar-btn${s.value === 1 ? " is-active" : ""}" data-subdiv="${s.value}">${s.label}</button>`).join("")}
        </div>
        <div class="topbar-sep"></div>
        <div class="topbar-group">
          <button class="topbar-btn" data-role="undo-btn" disabled>Undo</button>
          <button class="topbar-btn" data-role="redo-btn" disabled>Redo</button>
        </div>
        <span class="topbar-spacer"></span>
        <button class="topbar-btn sidebar-toggle" data-role="sidebar-toggle">Hide Studio Deck</button>
        <div class="topbar-status-shell">
          <span class="topbar-status-label">State</span>
          <span class="topbar-status" data-role="topbar-status"></span>
        </div>
      </div>

      <!-- Canvas -->
      <div class="studio-canvas" data-role="canvas-area">
        <div class="canvas-stage-shell">
          <div class="canvas-stage-head">
            <span class="canvas-stage-kicker">Noir de Noir</span>
            <span class="canvas-stage-title" data-role="stage-title">Traits speak in relief</span>
          </div>
          <div class="canvas-stage-surface" data-role="canvas-stage-surface">
            <canvas data-role="display-canvas" width="600" height="600"></canvas>
            <div class="canvas-empty" data-role="canvas-empty">
              <span class="canvas-empty-kicker">Noir de Noir</span>
              <strong>Strip the mass until the traits carry it</strong>
              <span class="canvas-empty-copy">Start with No-Minimalism. Hold the twin-lift. Add tone, pattern and grain only when they make the traits hit harder.</span>
            </div>
          </div>
          <div class="canvas-stage-foot">
            <span class="canvas-stage-chip">24×24 truth</span>
            <span class="canvas-stage-chip">Twin-lift logic</span>
            <span class="canvas-stage-chip">Trait-first reduction</span>
          </div>
        </div>
      </div>

      <div class="studio-dock-scrim" data-role="dock-scrim" aria-hidden="true"></div>

      <!-- Sidebar -->
      <div class="studio-sidebar is-open" data-role="sidebar">
        <div class="sidebar-hero" data-role="sidebar-hero">
          <div class="sidebar-hero-head">
            <div class="sidebar-hero-copyblock">
              <span class="sidebar-hero-kicker">Noir de Noir</span>
              <strong class="sidebar-hero-title">Traits Speak In Relief</strong>
            </div>
            <button class="dock-dismiss" type="button" data-role="dock-dismiss" aria-label="Close studio dock">Close</button>
          </div>
          <p class="sidebar-hero-copy">Build from the original punk every time. Strip mass, keep the twin-lift, and push colour, pattern and reduction until the traits do the work.</p>
        </div>
        <!-- Source Picker -->
        <div class="sidebar-section" data-role="source-section">
          <div class="sidebar-heading">Source</div>
          <div data-role="picker-host"></div>
        </div>

        <!-- Active Color -->
        <div class="sidebar-section" data-role="color-section">
          <div class="sidebar-heading">Color</div>
          <div class="color-sliders">
            <div class="color-slider-row">
              <span class="color-slider-label">H</span>
              <input type="range" class="color-slider" data-role="hue-slider" min="0" max="360" value="0" />
              <span class="color-slider-value" data-role="hue-value">0</span>
            </div>
            <div class="color-slider-row">
              <span class="color-slider-label">S</span>
              <input type="range" class="color-slider" data-role="sat-slider" min="0" max="100" value="0" />
              <span class="color-slider-value" data-role="sat-value">0%</span>
            </div>
            <div class="color-slider-row">
              <span class="color-slider-label">L</span>
              <input type="range" class="color-slider" data-role="lit-slider" min="0" max="100" value="100" />
              <span class="color-slider-value" data-role="lit-value">100%</span>
            </div>
          </div>
          <div class="color-hex-row">
            <div class="color-preview" data-role="color-preview" style="background:#FFFFFF"></div>
            <input type="text" class="color-hex-input" data-role="color-hex" value="#FFFFFF" maxlength="7" spellcheck="false" autocomplete="off" />
          </div>
        </div>

        <!-- Punk Palette -->
        <div class="sidebar-section" data-role="palette-section">
          <div class="sidebar-heading">Palette</div>
          <div class="palette-grid" data-role="palette-grid"></div>
        </div>

        <!-- Studio Dock -->
        <div class="sidebar-section studio-dock-section" data-role="studio-dock-section">
          <div class="sidebar-heading">Control Deck <span style="font-weight:400;color:var(--text-dim);font-size:10px" data-role="preset-grid-label">(grid: 1x1)</span></div>
          <div class="mini-note">One engine. Every cast starts from the original punk, then re-casts the field, mass and finish.</div>
          <div class="studio-hero-actions">
            <button class="preset-btn preset-btn--hero" type="button" data-role="surprise-btn">Cast</button>
            <button class="preset-btn preset-btn--signature" type="button" data-role="hero-no-minimal">No-Minimalism</button>
          </div>
          <div class="role-pair-readout hero-role-pair" data-role="hero-role-pair"></div>
          <div class="preset-tabs">
            <button class="preset-tab is-active" data-preset-tab="mono">Mono</button>
            <button class="preset-tab" data-preset-tab="noir">Noir</button>
            <button class="preset-tab" data-preset-tab="warhol">Pop</button>
            <button class="preset-tab" data-preset-tab="dither">Pattern</button>
          </div>
          <details class="dock-advanced" data-role="dock-advanced">
            <summary class="dock-advanced-summary">Field Modifiers</summary>
            <div class="dock-advanced-body">
              <div class="theory-rail program-rail" data-role="program-rail">
                <button class="theory-btn" type="button" data-program="monolith">Monolith</button>
                <button class="theory-btn" type="button" data-program="veil">Veil</button>
                <button class="theory-btn" type="button" data-program="poster">Poster</button>
                <button class="theory-btn" type="button" data-program="signal">Signal</button>
              </div>
              <div class="color-slider-row">
                <span class="color-slider-label">Δ</span>
                <input type="range" class="color-slider" data-role="tone-step-slider" min="1" max="24" value="${DEFAULT_TONE_STEP}" />
                <span class="color-slider-value" data-role="tone-step-value">${DEFAULT_TONE_STEP}</span>
              </div>
              <div class="color-slider-row">
                <span class="color-slider-label">Min</span>
                <input type="range" class="color-slider" data-role="minimal-slider" min="3" max="8" value="4" />
                <span class="color-slider-value" data-role="minimal-value">4</span>
              </div>
              <div class="sidebar-heading" style="margin-top:8px;font-size:10px">Twin Lift</div>
              <div class="theory-rail" data-role="no-minimal-mode-rail">
                <button class="theory-btn is-active" type="button" data-minimal-mode="exact">Exact</button>
                <button class="theory-btn" type="button" data-minimal-mode="soft">Soft</button>
                <button class="theory-btn" type="button" data-minimal-mode="hard">Hard</button>
              </div>
              <button class="preset-btn" type="button" data-role="active-bg-toggle">Use Active Color As BG · legacy only · Off</button>
              <div class="sidebar-heading" style="margin-top:8px;font-size:10px">Pattern Layer</div>
              <div class="mini-note">Pattern finishing for the current No-Field world. It reacts to the live role pair.</div>
              <div data-role="dither-controls">
                <div class="theory-rail" data-role="theory-rail">
                  <button class="theory-btn is-active" type="button" data-theory="mono">Mono</button>
                  <button class="theory-btn" type="button" data-theory="complementary">Comp</button>
                  <button class="theory-btn" type="button" data-theory="triadic">Triad</button>
                  <button class="theory-btn" type="button" data-theory="split">Split</button>
                </div>
                <div class="sidebar-heading" style="margin-top:8px;font-size:10px">Pattern Engine</div>
                <div class="theory-rail" data-role="dither-engine-rail">
                  <button class="theory-btn is-active" type="button" data-engine="diffusion">Diffuse</button>
                  <button class="theory-btn" type="button" data-engine="bayer">Bayer</button>
                  <button class="theory-btn" type="button" data-engine="cluster">Cluster</button>
                  <button class="theory-btn" type="button" data-engine="scan">Scan</button>
                </div>
                <button class="export-btn export-btn--full" data-role="build-theory" style="margin-top:8px">Retune Pattern</button>
                <div class="sidebar-heading" style="margin-top:8px;font-size:10px">Pattern Palette (shift-click swatches to add)</div>
                <div class="dither-colors" data-role="dither-colors"></div>
                <div class="color-slider-row" style="margin-top:6px">
                  <span class="color-slider-label" style="font-size:10px">Str</span>
                  <input type="range" class="color-slider" data-role="dither-strength" min="0" max="100" value="100" />
                  <span class="color-slider-value" data-role="dither-strength-value">100%</span>
                </div>
                <button class="export-btn export-btn--full" data-role="apply-dither" style="margin-top:8px">Apply Pattern</button>
              </div>
              <div class="sidebar-heading" style="margin-top:10px;font-size:10px">Finish Grain</div>
              <div class="mini-note">Presentation-scale grain at 1024. The 24×24 source never changes.</div>
              <div class="theory-rail noise-target-rail" data-role="noise-target-rail">
                <button class="theory-btn is-active" type="button" data-noise-target="background">BG</button>
                <button class="theory-btn" type="button" data-noise-target="active">Band</button>
                <button class="theory-btn" type="button" data-noise-target="figure">Figure</button>
              </div>
              <div class="color-slider-row" style="margin-top:6px">
                <span class="color-slider-label" style="font-size:10px">N</span>
                <input type="range" class="color-slider" data-role="noise-amount" min="0" max="100" value="28" />
                <span class="color-slider-value" data-role="noise-amount-value">28%</span>
              </div>
              <button class="export-btn export-btn--full" data-role="apply-noise" style="margin-top:8px">Apply Grain</button>
            </div>
          </details>
          <div class="preset-list" data-role="preset-list"></div>
        </div>

        <!-- Machine Drawer -->
        <details class="sidebar-section machine-drawer" data-role="machine-drawer">
          <summary class="machine-drawer-summary">
            <span class="sidebar-heading" style="margin:0">Machine Drawer</span>
            <span class="mini-note">Canonical block-state render</span>
          </summary>
          <div class="machine-drawer-body">
            <div class="server-mode-rail" data-role="server-mode-rail"></div>
            <div class="server-block-row">
              <input type="text" class="server-block-input" data-role="block-input" placeholder="Block #" inputmode="numeric" spellcheck="false" autocomplete="off" />
              <button class="topbar-btn" data-role="latest-btn">Latest</button>
            </div>
            <button class="server-generate-btn" data-role="generate-btn" disabled>Generate Canonical</button>
            <p class="server-status" data-role="server-status"></p>
          </div>
        </details>

        <!-- Export -->
        <div class="sidebar-section">
          <div class="sidebar-heading">Quick Export</div>
          <button class="export-btn export-btn--full" data-role="export-gif" disabled>GIF 1s · Animated Grain</button>
          <div class="export-row">
            <button class="export-btn" data-role="export-png" disabled>PNG 1024</button>
            <button class="export-btn" data-role="export-reset" disabled>Reset</button>
          </div>
        </div>
      </div>

      <!-- Statusbar -->
      <div class="studio-statusbar">
        <div class="status-item" data-role="status-pos">0, 0</div>
        <div class="status-sep"></div>
        <div class="status-item">
          <div class="status-swatch" data-role="status-swatch" style="background:#000000"></div>
          <span data-role="status-hex">#000000</span>
        </div>
        <div class="status-sep"></div>
        <div class="status-item" data-role="status-zoom">100%</div>
        <div class="status-sep"></div>
        <div class="status-item" data-role="status-role">—</div>
      </div>
    </div>
  `;

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
    toneStepSlider: q("tone-step-slider"),
    toneStepValue: q("tone-step-value"),
    minimalSlider: q("minimal-slider"),
    minimalValue: q("minimal-value"),
    noMinimalModeRail: q("no-minimal-mode-rail"),
    activeBgToggle: q("active-bg-toggle"),
    ditherControls: q("dither-controls"),
    theoryRail: q("theory-rail"),
    ditherEngineRail: q("dither-engine-rail"),
    buildTheory: q("build-theory"),
    ditherColors: q("dither-colors"),
    ditherStrength: q("dither-strength"),
    ditherStrengthValue: q("dither-strength-value"),
    applyDither: q("apply-dither"),
    noiseTargetRail: q("noise-target-rail"),
    noiseAmount: q("noise-amount"),
    noiseAmountValue: q("noise-amount-value"),
    applyNoise: q("apply-noise"),
    serverModeRail: q("server-mode-rail"),
    blockInput: q("block-input"),
    latestBtn: q("latest-btn"),
    generateBtn: q("generate-btn"),
    serverStatus: q("server-status"),
    exportPng: q("export-png"),
    exportGif: q("export-gif"),
    exportReset: q("export-reset"),
    undoBtn: q("undo-btn"), redoBtn: q("redo-btn"),
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
    modes: createFallbackModes(),
    activeMode: "canonical-machine",
    liveHeadAvailable: false,
    latestHead: null,
    machineDrawerEnabled: true,
    noiseGifAvailable: true,
    activePresetTab: "mono",
    noFieldCore: "auto",
    toneStep: DEFAULT_TONE_STEP,
    essentialTones: 4,
    noMinimalDeltaMode: "exact",
    useActiveBg: false,
    activeTheory: "mono",
    activeDitherEngine: "diffusion",
    activeNoiseTarget: "background",
    noiseAmount: 28,
    noisePass: 0,
    lastReductionMode: "none",
    lastProgramId: "",
    variantByFamily: {
      mono: null,
      noir: null,
      warhol: null,
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
    userSubdivision: 1,
    activeColor: { h: 0, s: 0, l: 100 },
    activeColorHex: "#FFFFFF",
    noMinimalPreviewPair: null,
    noFieldIntensity: 62,
    noFieldField: 54,
    noFieldFinish: 28,
    noFieldSerial: false,
    noFieldLastFamily: "noir",
  };

  const mobileDockQuery = window.matchMedia("(max-width: 900px)");
  const handleDockMediaChange = (event) => setSidebarOpen(!event.matches);

  function setSidebarOpen(open) {
    const isOpen = Boolean(open);
    els.sidebar.classList.toggle("is-open", isOpen);
    studioEl.classList.toggle("is-dock-open", isOpen);
    els.sidebarToggle.classList.toggle("is-active", isOpen);
    els.sidebarToggle.textContent = isOpen ? "Hide Studio Deck" : "Open Studio Deck";
    els.sidebarToggle.setAttribute("aria-expanded", String(isOpen));
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
    const excludeActiveHex = family === "mono" || family === "noir";
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
    root.querySelectorAll(".preset-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.presetTab === tabId));
    renderPresetList();
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
    els.activeBgToggle.textContent = `Use Active Color As BG · legacy only · ${state.useActiveBg ? "On" : "Off"}`;
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
    setTopbarStatus(state.useActiveBg ? "Active background anchor armed" : "Machine-selected background anchor armed");
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
    setTopbarStatus(`No-Field ${state.noMinimalDeltaMode} twin · world armed`);
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

    // In dither mode, shift-click adds the picked color to the dither palette.
    if (state.activePresetTab === "dither" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      const rgb = hexToRgb(pickedHex);
      if (state.ditherPalette.length < 6) {
        state.ditherPalette.push(rgb);
        renderDitherColors();
        setTopbarStatus(`Added ${pickedHex} to dither palette`);
      }
      return;
    }

    if (state.activePresetTab === "dither") {
      setTopbarStatus(`Active color ${pickedHex} · shift-click to add to dither palette`);
      return;
    }

    if (!state.useActiveBg) {
      renderHeroRolePair();
    }
  });

  // ── Tool selection ────────────────────────────────────────────

  const toolbarEl = root.querySelector(".studio-toolbar");
  toolbarEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tool]");
    if (!btn) return;
    const tool = btn.dataset.tool;
    if (tool === "zoom-in") { canvas.zoomIn(); updateZoomStatus(); return; }
    if (tool === "zoom-out") { canvas.zoomOut(); updateZoomStatus(); return; }
    toolbarEl.querySelectorAll(".tool-btn[data-tool]").forEach((b) => {
      if (!["zoom-in","zoom-out"].includes(b.dataset.tool)) b.classList.remove("is-active");
    });
    btn.classList.add("is-active");
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
    canvas.setTool(tool);
  }

  document.addEventListener("keydown", onKeyDown);

  // ── Presets — Grid-Aware ──────────────────────────────────────
  // When grid > 1x1, presets create multi-panel compositions.
  // Each block gets a rotated/shifted version of the preset.

  function activeCreativeFamily() {
    if (state.activePresetTab === "noir") return "noir";
    if (state.activePresetTab === "warhol") return "warhol";
    return "mono";
  }

  function activeRoleStep() {
    const family = activeCreativeFamily();
    if (family === "mono" || family === "noir") return 4;
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
    const roleTag = roleStep === 4 && activeCreativeFamily() !== "warhol" ? "Δ4 role lock" : `Δ${state.toneStep}`;
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

  function noFieldToneTarget() {
    const intensity = Math.max(0, Math.min(100, Number(state.noFieldIntensity) || 0)) / 100;
    return clampEssentialTones(Math.round(lerp(7, 3, intensity)));
  }

  function chooseNoFieldFamily() {
    if (state.noFieldCore === "mono" || state.noFieldCore === "noir" || state.noFieldCore === "warhol") {
      return state.noFieldCore;
    }
    const intensity = Math.max(0, Math.min(100, Number(state.noFieldIntensity) || 0)) / 100;
    const field = Math.max(0, Math.min(100, Number(state.noFieldField) || 0)) / 100;
    if (state.noFieldSerial) return "warhol";
    if (field >= 0.72) return pickOne(["noir", "mono", "warhol"]) || "noir";
    if (intensity >= 0.72) return pickOne(["mono", "noir"]) || "mono";
    if (intensity <= 0.28 && field <= 0.42) return pickOne(["warhol", "mono"]) || "warhol";
    return pickOne(["noir", "mono", "warhol"]) || "noir";
  }

  function buildNoFieldSingle(classified, family, backgroundHex, toneTarget) {
    const preset = createUniqueVariant(family, classified);
    state.variantByFamily[family] = preset;
    const base = applyPreset(preset, classified, {
      toneStep: state.toneStep,
      roleStep: family === "mono" || family === "noir" ? 4 : state.toneStep,
      backgroundHex,
    });
    const result = collapsePresetResult(classified, base, toneTarget);
    canvas.applyColorMapping(result.mapping, result.roles);
    return preset;
  }

  function buildNoFieldSerial(classified, family, backgroundHex, toneTarget) {
    const previousSubdiv = canvas.subdivision;
    setSubdivisionValue(2);
    const variants = Array.from({ length: 4 }, () => createUniqueVariant(family, classified));
    canvas.applyGridMapping((col, row, blockIdx) => {
      const preset = variants[blockIdx] || variants[(row * 2) + col] || variants[0];
      return collapsePresetResult(
        classified,
        applyPreset(preset, classified, {
          toneStep: state.toneStep,
          roleStep: family === "mono" || family === "noir" ? 4 : state.toneStep,
          backgroundHex,
        }),
        toneTarget,
      );
    });
    state.variantByFamily[family] = variants[0];
    return previousSubdiv;
  }

  function applyNoField({ holdWorld = false } = {}) {
    if (!state.selected) {
      setServerStatus("Select a NoPunk first.", "warn");
      return;
    }

    if (!state.noFieldSerial && canvas.subdivision !== state.userSubdivision) {
      setSubdivisionValue(state.userSubdivision);
    }

    const classified = state.sourceClassifiedPalette || canvas.getClassifiedPalette();
    const pair = holdWorld ? ensureNoMinimalPreviewPair() : refreshNoMinimalPreviewPair();
    const family = chooseNoFieldFamily();
    const toneTarget = family === "warhol"
      ? Math.max(6, noFieldToneTarget())
      : noFieldToneTarget();
    const fieldLevel = Math.max(0, Math.min(100, Number(state.noFieldField) || 0));
    const finishLevel = Math.max(0, Math.min(100, Number(state.noFieldFinish) || 0));

    let previousSubdiv = null;
    if (state.noFieldSerial) {
      previousSubdiv = buildNoFieldSerial(classified, family, pair.background, toneTarget);
    } else {
      buildNoFieldSingle(classified, family, pair.background, toneTarget);
    }

    if (fieldLevel >= 58) {
      applyStudioCut(fieldLevel >= 76 ? "relief-field" : "plate-shift");
    }

    const finishNorm = finishLevel / 100;
    applyDisplayGrain({
      enabled: finishNorm > 0.02,
      target: fieldLevel >= 60 ? "background" : "figure",
      amount: (finishNorm * 0.26) + 0.02,
      activeHex: nearestPaletteHex(selectedActiveHex()),
      seed: ++state.noisePass,
    });

    state.noFieldLastFamily = family;
    renderHeroRolePair();
    renderVariantPanel();
    const familyLabel = family === "warhol" ? "pop" : family;
    const serialNote = state.noFieldSerial ? ` · serial 2x2${previousSubdiv !== 2 ? " locked" : ""}` : "";
    setTopbarStatus(`No-Field · ${familyLabel} core · intensity ${state.noFieldIntensity}% · field ${state.noFieldField}% · finish ${state.noFieldFinish}%${serialNote}`);
    pulseStudio(holdWorld ? "variant" : "surprise");
  }

  function applyNoMinimalism() {
    if (!state.selected || !state.originalRoleMap) return;

    const current = canvas.exportImageData();
    const next = new Uint8ClampedArray(current.data);
    const occupied = state.originalOccupied || canvas.getOccupied();
    const pair = ensureNoMinimalPreviewPair();

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
    refreshNoMinimalPreviewPair();
    renderHeroRolePair();
    setTopbarStatus(`No-Minimalism ${state.noMinimalDeltaMode} · ${pair.background} → ${pair.figure} · ${pair.roleStep} lift · 2 tones`);
    pulseStudio("reduce");
  }

  function renderVariantPanel() {
    const current = state.variantByFamily[state.noFieldLastFamily] || null;
    const familyLabel = state.noFieldLastFamily === "warhol"
      ? "Pop"
      : state.noFieldLastFamily.charAt(0).toUpperCase() + state.noFieldLastFamily.slice(1);
    const toneTarget = noFieldToneTarget();
    const world = ensureNoMinimalPreviewPair();
    const coreLabel = state.noFieldCore === "auto"
      ? "Auto"
      : (state.noFieldCore === "warhol" ? "Pop" : state.noFieldCore.charAt(0).toUpperCase() + state.noFieldCore.slice(1));
    els.presetList.innerHTML = `
      <div class="variant-panel no-field-panel">
        <div class="variant-title">No-Field</div>
        <div class="variant-chips">
          <span class="variant-chip">One engine</span>
          <span class="variant-chip">Twin-lift world</span>
          <span class="variant-chip">${escapeHtml(coreLabel)} core</span>
          <span class="variant-chip">Live pass · ${escapeHtml(familyLabel)}</span>
          <span class="variant-chip">${toneTarget} tones</span>
        </div>
        <div class="theory-rail no-field-core-rail">
          <button class="theory-btn${state.noFieldCore === "auto" ? " is-active" : ""}" type="button" data-action="set-core" data-core="auto">Auto</button>
          <button class="theory-btn${state.noFieldCore === "noir" ? " is-active" : ""}" type="button" data-action="set-core" data-core="noir">Noir</button>
          <button class="theory-btn${state.noFieldCore === "mono" ? " is-active" : ""}" type="button" data-action="set-core" data-core="mono">Mono</button>
          <button class="theory-btn${state.noFieldCore === "warhol" ? " is-active" : ""}" type="button" data-action="set-core" data-core="warhol">Pop</button>
        </div>
        <div class="role-pair-readout">World armed · ${escapeHtml(world.background)} → ${escapeHtml(world.figure)} · ${world.roleStep} lift</div>
        <div class="mini-note no-field-guidance">Cast uses the current user grid. Serial only runs when you arm it explicitly.</div>
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
        <div class="variant-action-grid">
          <button class="preset-btn" type="button" data-action="hold">Hold World</button>
          <button class="preset-btn" type="button" data-action="toggle-serial">Serial ${state.noFieldSerial ? "On" : "Off"}</button>
        </div>
        <button class="preset-btn" type="button" data-action="refresh-pair">New World</button>
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

    const roleTag = presetOptions.roleStep === 4 && family !== "warhol" ? "Δ4 role lock" : `Δ${state.toneStep}`;
    state.lastReductionMode = "none";
    renderVariantPanel();
    setTopbarStatus(`${preset.name} · ${roleTag} · ${toneTarget} tones · ${canvas.subdivision}x${canvas.subdivision}`);
    pulseStudio("variant");
  }

  function renderPresetList() {
    if (els.ditherControls) {
      els.ditherControls.style.display = "block";
    }
    renderVariantPanel();
  }

  els.presetList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "set-core") {
      state.noFieldCore = btn.dataset.core || "auto";
      renderVariantPanel();
      setTopbarStatus(`No-Field core · ${state.noFieldCore === "warhol" ? "Pop" : (state.noFieldCore || "auto")}`);
      return;
    }
    if (btn.dataset.action === "cast") {
      applyNoField({ holdWorld: false });
      return;
    }
    if (btn.dataset.action === "hold") {
      applyNoField({ holdWorld: true });
      return;
    }
    if (btn.dataset.action === "toggle-serial") {
      state.noFieldSerial = !state.noFieldSerial;
      renderVariantPanel();
      setTopbarStatus(`No-Field serial ${state.noFieldSerial ? "armed" : "off"}`);
      return;
    }
    if (btn.dataset.action === "refresh-pair") {
      refreshNoMinimalPreviewPair();
      renderHeroRolePair();
      renderVariantPanel();
      setTopbarStatus("No-Field world refreshed");
    }
  });

  els.presetList.addEventListener("input", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    if (target.dataset.action === "set-intensity") {
      state.noFieldIntensity = Math.max(0, Math.min(100, Number(target.value) || 0));
      renderVariantPanel();
      return;
    }
    if (target.dataset.action === "set-field") {
      state.noFieldField = Math.max(0, Math.min(100, Number(target.value) || 0));
      renderVariantPanel();
      return;
    }
    if (target.dataset.action === "set-finish") {
      state.noFieldFinish = Math.max(0, Math.min(100, Number(target.value) || 0));
      renderVariantPanel();
    }
  });

  function executeStudioProgram(programId) {
    const sourcePalette = state.sourcePaletteHexes.length ? state.sourcePaletteHexes : canvas.getCurrentPalette();
    const weightedSubdivisions = [1, 2, 4, 4, 6, 6, 8, 8, 12, 12, 24];
    const families = ["mono", "noir", "warhol", "dither"];
    const theories = ["mono", "complementary", "triadic", "split"];
    const engines = ["diffusion", "bayer", "cluster", "scan"];

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
      if (program.familyBias === "dither") return "dither";
      if (program.familyBias === "noir" || program.familyBias === "mono") return program.familyBias;
      return pickOne(families) || "mono";
    }

    function pickEngine(program) {
      if (program.ditherBias === "diffuse") return "diffusion";
      if (program.ditherBias === "mixed" || !program.ditherBias) return pickOne(engines) || "diffusion";
      return program.ditherBias;
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
    renderTheoryRail();
    renderDitherEngineRail();
    setSubdivisionValue(subdivision);

    const applyProgramDither = (strengthMin, strengthMax) => {
      buildTheoryFromActiveColor();
      performDither({ strength: strengthMin + (Math.random() * (strengthMax - strengthMin)) });
    };

    if (program.id === "monolith") {
      setActivePresetTab(pickOne(["mono", "noir"]) || family);
      state.essentialTones = 3;
      syncMinimalUI();
      applyCreativeVariant({ maximal: true });
      applyStudioCut("relief-field");
      applyDisplayGrain({ enabled: true, target: "background", amount: 0.12 + (Math.random() * 0.08), seed: ++state.noisePass });
    } else if (program.id === "signal") {
      setActivePresetTab(pickOne(["noir", "warhol"]) || family);
      applyCreativeVariant({ maximal: false });
      applyStudioCut("plate-shift");
      applyProgramDither(0.68, 0.92);
      applyDisplayGrain({ enabled: true, target: "figure", amount: 0.16 + (Math.random() * 0.08), seed: ++state.noisePass });
    } else if (program.id === "fracture") {
      setSubdivisionValue(pickOne([6, 8, 12, 24]) || 8);
      setActivePresetTab(family);
      applyCreativeVariant({ maximal: false });
      applyStudioCut("plate-shift");
      applyProgramDither(0.54, 0.84);
      applyDisplayGrain({ enabled: true, target: "figure", amount: 0.1 + (Math.random() * 0.06), seed: ++state.noisePass });
    } else if (program.id === "echo") {
      setActivePresetTab(pickOne(["noir", "mono"]) || family);
      applyCreativeVariant({ maximal: false });
      applyStudioCut("relief-field");
      applyDisplayGrain({ enabled: true, target: "active", amount: 0.08 + (Math.random() * 0.06), activeHex: nearestPaletteHex(selectedActiveHex()), seed: ++state.noisePass });
    } else if (program.id === "veil") {
      setActivePresetTab("mono");
      state.essentialTones = 3;
      syncMinimalUI();
      applyCreativeVariant({ maximal: true });
      applyStudioCut("relief-field");
      applyDisplayGrain({ enabled: true, target: "background", amount: 0.18 + (Math.random() * 0.1), seed: ++state.noisePass });
    } else if (program.id === "pulse") {
      setActivePresetTab("warhol");
      applyCreativeVariant({ maximal: false });
      applyProgramDither(0.66, 0.88);
      applyDisplayGrain({ enabled: true, target: "figure", amount: 0.14 + (Math.random() * 0.08), seed: ++state.noisePass });
    } else if (program.id === "afterimage") {
      setActivePresetTab("noir");
      applyCreativeVariant({ maximal: false });
      applyStudioCut(pickOne(["relief-field", "plate-shift"]) || "relief-field");
      applyProgramDither(0.3, 0.5);
      applyDisplayGrain({ enabled: true, target: "background", amount: 0.1 + (Math.random() * 0.06), seed: ++state.noisePass });
    } else {
      setActivePresetTab(family);
      state.essentialTones = randomInt(3, 5);
      syncMinimalUI();
      applyCreativeVariant({ maximal: Math.random() < 0.4 });
      applyStudioCut(pickOne(["plate-shift", "relief-field"]) || "plate-shift");
      if (Math.random() < 0.45) applyProgramDither(0.42, 0.7);
      applyDisplayGrain({ enabled: true, target: "background", amount: 0.1 + (Math.random() * 0.06), seed: ++state.noisePass });
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

  // ── Dither — Grid-Aware ───────────────────────────────────────

  function renderDitherColors() {
    els.ditherColors.innerHTML = state.ditherPalette.map((c, i) => {
      const hex = rgbToHex(c.r, c.g, c.b);
      return `<button class="dither-color-btn" data-dither-idx="${i}" style="background:${escapeHtml(hex)}" title="${escapeHtml(hex)} (click to remove)"></button>`;
    }).join("") + (state.ditherPalette.length < 6
      ? '<button class="dither-add-btn" data-role="add-dither-color" title="Add current color">+</button>'
      : "");
  }

  function renderTheoryRail() {
    if (!els.theoryRail) return;
    els.theoryRail.querySelectorAll("[data-theory]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.theory === state.activeTheory);
    });
  }

  function renderDitherEngineRail() {
    if (!els.ditherEngineRail) return;
    els.ditherEngineRail.querySelectorAll("[data-engine]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.engine === state.activeDitherEngine);
    });
  }

  function buildTheoryFromActiveColor() {
    const rgb = hslToRgb(state.activeColor.h, state.activeColor.s / 100, state.activeColor.l / 100);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    const count = Math.max(2, Math.min(6, state.essentialTones));
    const palette = buildTheoryPalette(hex, state.activeTheory, { toneStep: state.toneStep, count });
    state.ditherPalette = palette.map((c) => ({ r: c.r, g: c.g, b: c.b }));
    renderDitherColors();
    setTopbarStatus(`Theory ${state.activeTheory} · Δ${state.toneStep} · ${state.ditherPalette.length} tones`);
  }

  function performDither({ strength = null } = {}) {
    if (!state.selected || state.ditherPalette.length < 2) return;
    const rawAmount = strength == null ? (Number(els.ditherStrength.value) / 100) : Math.max(0, Math.min(1, Number(strength)));
    const amount = ditherStrengthForEngine(rawAmount);
    const reactivePalette = buildReactiveDitherPalette();
    if (strength != null) {
      els.ditherStrength.value = String(Math.round(rawAmount * 100));
      els.ditherStrengthValue.textContent = `${Math.round(rawAmount * 100)}%`;
    }

    if (canvas.subdivision <= 1) {
      const imageData = canvas.exportImageData();
      const occupied = buildEngineOccupiedSet(imageData);
      const result = applyStudioDither(imageData, reactivePalette, {
        occupiedPixels: occupied,
        strength: amount,
        engine: state.activeDitherEngine,
        phase: state.toneStep + canvas.subdivision + (state.activeDitherEngine === "bayer" ? 7 : state.activeDitherEngine === "cluster" ? 13 : state.activeDitherEngine === "scan" ? 19 : 3),
      });
      canvas.applyImageData(result);
    } else {
      canvas.applyGridDither((blockImageData, col, row, blockIdx, blockOccupied) => {
        if (blockOccupied.size === 0) return null;
        return applyStudioDither(blockImageData, reactivePalette, {
          occupiedPixels: blockOccupied,
          strength: amount,
          engine: state.activeDitherEngine,
          phase: blockIdx + state.toneStep + (state.activeDitherEngine === "bayer" ? 5 : state.activeDitherEngine === "cluster" ? 11 : state.activeDitherEngine === "scan" ? 17 : 2),
        });
      });
    }
    setTopbarStatus(`${previewDitherEngineLabel(state.activeDitherEngine)} pattern · bg reactive · ${reactivePalette.length} tones`);
    pulseStudio("dither");
  }

  els.ditherColors.addEventListener("click", (e) => {
    if (e.target.closest("[data-role='add-dither-color']")) {
      const rgb = hslToRgb(state.activeColor.h, state.activeColor.s / 100, state.activeColor.l / 100);
      if (state.ditherPalette.length < 6) {
        state.ditherPalette.push(rgb);
        renderDitherColors();
      }
      return;
    }
    const colorBtn = e.target.closest("[data-dither-idx]");
    if (colorBtn) {
      // Click to remove from dither palette
      const idx = Number(colorBtn.dataset.ditherIdx);
      if (state.ditherPalette.length > 2) {
        state.ditherPalette.splice(idx, 1);
        renderDitherColors();
      }
    }
  });

  els.theoryRail?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theory]");
    if (!btn) return;
    state.activeTheory = btn.dataset.theory;
    renderTheoryRail();
  });

  els.ditherEngineRail?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-engine]");
    if (!btn) return;
    state.activeDitherEngine = btn.dataset.engine;
    renderDitherEngineRail();
    setTopbarStatus(`${previewDitherEngineLabel(state.activeDitherEngine)} engine armed`);
  });

  els.buildTheory?.addEventListener("click", buildTheoryFromActiveColor);

  els.ditherStrength.addEventListener("input", () => {
    els.ditherStrengthValue.textContent = `${els.ditherStrength.value}%`;
  });

  els.applyDither.addEventListener("click", () => performDither());
  els.applyNoise?.addEventListener("click", applyNoise);

  renderDitherColors();
  renderTheoryRail();
  renderDitherEngineRail();

  // ── Server Modes ──────────────────────────────────────────────

  function renderServerModes() {
    els.serverModeRail.innerHTML = state.modes.map((mode) => `
      <button class="server-mode-btn${mode.id === state.activeMode ? " is-active" : ""}" data-mode="${escapeHtml(mode.id)}">
        ${escapeHtml(mode.label)}
        <small>${escapeHtml(mode.descriptionShort)}</small>
      </button>
    `).join("");
  }

  els.serverModeRail.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    state.activeMode = btn.dataset.mode;
    renderServerModes();
    setTopbarStatus(`Server ${btn.textContent.trim()}`);
  });

  els.latestBtn.addEventListener("click", () => refreshHead({ setBlock: true }));
  els.generateBtn.addEventListener("click", () => generate());
  els.blockInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); generate(); } });

  renderServerModes();

  function setServerStatus(text, mode = "") {
    els.serverStatus.textContent = text;
    els.serverStatus.dataset.mode = mode;
  }

  async function generate() {
    if (!state.machineDrawerEnabled) {
      setServerStatus("Canonical machine is disabled in static deploy.", "warn");
      return;
    }
    if (!state.selected) { setServerStatus("Select a NoPunk first.", "warn"); return; }

    let blockNumber = parseBlockInput();
    if (!Number.isFinite(blockNumber) && state.liveHeadAvailable) {
      await refreshHead({ setBlock: true });
      blockNumber = parseBlockInput();
    }
    if (!Number.isFinite(blockNumber)) { setServerStatus("Enter a block number or use Latest.", "warn"); return; }

    const token = ++state.requestToken;
    studioEl.classList.add("is-busy");
    els.generateBtn.disabled = true;
    const modeLabel = state.modes.find((m) => m.id === state.activeMode)?.label || "";
    setServerStatus(`Generating ${modeLabel}...`);

    try {
      const result = await generateNoStudio({
        tokenId: state.selected.id,
        mode: state.activeMode,
        blockNumber,
        outputKind: "single",
      });
      if (state.disposed || token !== state.requestToken) return;

      const pixel24 = result.preview?.pixel24 || {};
      if (pixel24.rgba24B64) {
        const bytes = decodeRgba24B64(pixel24.rgba24B64);
        canvas.applyImageData(imageDataFromRgba24(bytes));
      }
      if (result.block && Number.isFinite(Number(result.block.number))) {
        els.blockInput.value = String(result.block.number);
      }
      setServerStatus(`${modeLabel} · block ${blockNumber}`, "ready");
      setTopbarStatus(`${modeLabel} · block ${blockNumber}`);
    } catch (error) {
      if (state.disposed || token !== state.requestToken) return;
      setServerStatus(error.message || "Generation failed", "error");
    } finally {
      if (!state.disposed && token === state.requestToken) {
        studioEl.classList.remove("is-busy");
        els.generateBtn.disabled = !state.machineDrawerEnabled || !state.selected;
      }
    }
  }

  function parseBlockInput() {
    const raw = String(els.blockInput.value || "").trim();
    if (!/^\d+$/.test(raw)) return null;
    return parseInt(raw, 10);
  }

  async function refreshHead({ setBlock = false } = {}) {
    if (!state.machineDrawerEnabled) {
      state.liveHeadAvailable = false;
      return;
    }
    try {
      const payload = await getNoStudioHead();
      if (state.disposed) return;
      state.liveHeadAvailable = true;
      state.latestHead = Number(payload.block.number);
      if (setBlock || !els.blockInput.value.trim()) els.blockInput.value = String(payload.block.number);
    } catch {
      if (!state.disposed) state.liveHeadAvailable = false;
    }
  }

  // ── Export ────────────────────────────────────────────────────

  function updateExportButtons() {
    const ok = state.selected != null;
    const grain = canvas.getDisplayGrain();
    els.exportPng.disabled = !ok;
    els.exportGif.disabled = !state.noiseGifAvailable || !ok || !grain.enabled || !(grain.amount > 0);
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

  els.exportPng.addEventListener("click", () => {
    if (!state.selected) return;
    exportCanvasPng(canvas.exportPng1024(), `nopunk-${state.selected.id}-no-studio.png`);
  });

  els.exportGif.addEventListener("click", async () => {
    if (!state.selected) return;
    if (!state.noiseGifAvailable) {
      setTopbarStatus("Animated grain GIF export is local-server only");
      return;
    }
    const grain = canvas.getDisplayGrain();
    if (!grain.enabled || !(grain.amount > 0)) {
      setTopbarStatus("Animated GIF requires active grain");
      return;
    }

    const originalLabel = els.exportGif.textContent;
    els.exportGif.disabled = true;
    els.exportGif.textContent = "Rendering GIF...";
    setTopbarStatus("Rendering animated grain GIF...");

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
      const fileName = `nopunk-${state.selected.id}-no-studio-noise.gif`;
      downloadUrl(`${payload.output.gifUrl}?download=1`, fileName);
      setTopbarStatus(`Animated grain GIF · ${payload.output.frames} frames · 1s`);
    } catch (error) {
      setTopbarStatus(error.message || "Animated GIF export failed");
    } finally {
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
    state.originalRoleMap = null;
    state.originalOccupied = null;
    state.sourceClassifiedPalette = null;
    state.sourcePaletteHexes = [];
    state.noMinimalPreviewPair = null;
    canvas.clearDisplayGrain();
    state.variantByFamily = { mono: null, noir: null, warhol: null };
    state.outputSignatures.clear();
    state.outputSignatureOrder = [];
    renderPresetList();
    els.generateBtn.disabled = !state.machineDrawerEnabled || !state.selected;
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

  // ── Boot ──────────────────────────────────────────────────────

  getNoStudioConfig()
    .then((cfg) => {
      if (state.disposed) return;
      state.modes = Array.isArray(cfg.modes) && cfg.modes.length ? cfg.modes : createFallbackModes();
      state.activeMode = state.modes.find((m) => m.id === state.activeMode) ? state.activeMode : state.modes[0].id;
      renderServerModes();
      state.liveHeadAvailable = Boolean(cfg.liveHeadAvailable);
      state.machineDrawerEnabled = cfg.machineDrawerEnabled !== false;
      state.noiseGifAvailable = cfg.noiseGifAvailable !== false;
      els.machineDrawer.hidden = !state.machineDrawerEnabled;
      els.generateBtn.disabled = !state.machineDrawerEnabled || !state.selected;
      if (!state.noiseGifAvailable) {
        els.exportGif.title = "Animated grain GIF export is only available on the local No-Studio server.";
      }
      const latest = cfg.head?.latestBlockNumber;
      if (latest != null && Number.isFinite(Number(latest))) {
        state.latestHead = Number(latest);
        els.blockInput.value = String(latest);
      }
      updateExportButtons();
      setTopbarStatus(`${state.liveHeadAvailable ? "Live head synced" : "Studio mode"} · traits speak in relief`);
    })
    .catch(() => {});

  refreshHead({ setBlock: true });

  // ── Cleanup ───────────────────────────────────────────────────

  return () => {
    state.disposed = true;
    state.requestToken += 1;
    document.removeEventListener("keydown", onKeyDown);
    mobileDockQuery.removeEventListener("change", handleDockMediaChange);
    resizeObserver.disconnect();
    canvas.destroy();
    picker.destroy();
    root.innerHTML = "";
  };
}
