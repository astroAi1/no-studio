import { getPunk } from "../api.js";
import { mountPunkPicker } from "../components/punk-picker.js";
import { drawSourceOnBlack, applyNoMetaTwoToneMask, imageDataToCanvas, drawNearestScaled, PIXEL_SIZE } from "../lib/no-meta-transform.js";
import { collectVisiblePalette, getNoMetaBackgroundCandidates, pickNoMetaBackground, hexFromRgb, tone2FromBackground } from "../lib/palette.js";
import { buildExportCanvasFromPixelCanvas, exportCanvasPng } from "../lib/download.js";

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load NoPunk image"));
    img.src = src;
  });
}

export function mountNoGenerateTool(root, ctx = {}) {
  root.innerHTML = `
    <section class="tool-grid tool-grid--studio">
      <div class="tool-col tool-col--picker" data-role="picker-root"></div>
      <section class="panel tool-panel studio-shell" data-role="studio-root">
        <div class="panel-head panel-head--spread">
          <div>
            <p class="micro-label">No-Generate Studio</p>
            <h3 class="panel-title" data-role="selection-title">Select a NoPunk</h3>
            <p class="panel-subtle" data-role="selection-subtitle">Pick a NoPunk. Pull a color. Keep the relief.</p>
          </div>
          <div class="spec-chip" data-role="bg-chip" hidden>
            <span>Background</span>
            <strong data-role="bg-hex">#000000</strong>
          </div>
        </div>

        <div class="studio-stage" data-role="stage">
          <div class="stage-glow" aria-hidden="true"></div>
          <div class="stage-grid" aria-hidden="true"></div>
          <div class="studio-canvases">
            <figure class="shadowplate">
              <figcaption class="frame-caption">Source</figcaption>
              <canvas data-role="source-canvas" width="432" height="432" aria-label="Selected NoPunk on black"></canvas>
            </figure>
            <figure class="shadowplate shadowplate--output">
              <figcaption class="frame-caption">No-Generate</figcaption>
              <div class="scanline-overlay" aria-hidden="true"></div>
              <canvas data-role="output-canvas" width="432" height="432" aria-label="No-Generate output"></canvas>
            </figure>
          </div>
        </div>

        <div class="action-row">
          <button class="chip-btn chip-btn--accent" type="button" data-role="generate-btn">No-Generate</button>
          <button class="chip-btn" type="button" data-role="reroll-btn">Reroll Background</button>
          <button class="chip-btn" type="button" data-role="download-btn">Download 1024 PNG</button>
        </div>

        <div class="palette-bar">
          <div class="palette-bar__head">
            <p class="micro-label">NoPunk Palette</p>
            <button class="chip-btn chip-btn--quiet" type="button" data-role="auto-bg-btn">Auto Pick</button>
          </div>
          <div class="palette-strip" data-role="palette-strip">
            <div class="palette-empty">Select a NoPunk to sample colors.</div>
          </div>
        </div>

        <div class="meta-block">
          <div class="trait-chips" data-role="trait-chips"></div>
          <p class="spec-note" data-role="rule-note">2 tones only: bg and bg + #040404.</p>
        </div>
      </section>
    </section>
  `;

  const els = {
    pickerRoot: root.querySelector('[data-role="picker-root"]'),
    stage: root.querySelector('[data-role="stage"]'),
    sourceCanvas: root.querySelector('[data-role="source-canvas"]'),
    outputCanvas: root.querySelector('[data-role="output-canvas"]'),
    generateBtn: root.querySelector('[data-role="generate-btn"]'),
    rerollBtn: root.querySelector('[data-role="reroll-btn"]'),
    downloadBtn: root.querySelector('[data-role="download-btn"]'),
    autoBgBtn: root.querySelector('[data-role="auto-bg-btn"]'),
    paletteStrip: root.querySelector('[data-role="palette-strip"]'),
    bgChip: root.querySelector('[data-role="bg-chip"]'),
    bgHex: root.querySelector('[data-role="bg-hex"]'),
    selectionTitle: root.querySelector('[data-role="selection-title"]'),
    selectionSubtitle: root.querySelector('[data-role="selection-subtitle"]'),
    traitChips: root.querySelector('[data-role="trait-chips"]'),
    ruleNote: root.querySelector('[data-role="rule-note"]'),
  };

  const sourceCtx = els.sourceCanvas.getContext("2d");
  const outputCtx = els.outputCanvas.getContext("2d");
  sourceCtx.imageSmoothingEnabled = false;
  outputCtx.imageSmoothingEnabled = false;

  const offscreenCanvas = document.createElement("canvas");
  offscreenCanvas.width = PIXEL_SIZE;
  offscreenCanvas.height = PIXEL_SIZE;

  const state = {
    selected: null,
    sourceImage: null,
    sourceImageData: null,
    background: null,
    outputImageData: null,
    outputPixelCanvas: null,
    paletteCandidates: [],
    cutoff: 20,
    scale: 24,
    backgroundPinned: false,
  };

  function setAccent(rgb) {
    if (!rgb) return;
    const css = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
    els.stage.style.setProperty("--tool-accent-rgb", css);
    if (typeof ctx.setAccent === "function") ctx.setAccent(rgb);
  }

  function setButtons() {
    const ready = Boolean(state.selected && state.sourceImage);
    els.generateBtn.disabled = !ready;
    els.rerollBtn.disabled = !ready;
    els.autoBgBtn.disabled = !ready;
    els.downloadBtn.disabled = !(ready && state.outputPixelCanvas);
  }

  function setCanvasSizes() {
    const px = PIXEL_SIZE * state.scale;
    for (const canvas of [els.sourceCanvas, els.outputCanvas]) {
      if (canvas.width === px && canvas.height === px) continue;
      canvas.width = px;
      canvas.height = px;
    }
    renderSource();
    renderOutput();
  }

  function rgbKey(rgb) {
    if (!rgb) return "";
    return `${rgb.r},${rgb.g},${rgb.b}`;
  }

  function renderPaletteStrip() {
    if (!state.paletteCandidates.length) {
      els.paletteStrip.innerHTML = `<div class="palette-empty">Select a NoPunk to sample colors.</div>`;
      return;
    }
    const activeKey = rgbKey(state.background);
    els.paletteStrip.innerHTML = state.paletteCandidates.map((rgb, index) => {
      const key = rgbKey(rgb);
      const active = key === activeKey;
      return `
        <button
          type="button"
          class="palette-swatch${active ? " is-active" : ""}${state.backgroundPinned && active ? " is-pinned" : ""}"
          data-swatch="${key}"
          title="${hexFromRgb(rgb)}"
          aria-label="Use ${hexFromRgb(rgb)} as background"
        >
          <span style="--swatch-rgb:${rgb.r}, ${rgb.g}, ${rgb.b}"></span>
          <small>${index + 1}</small>
        </button>
      `;
    }).join("");
  }

  function renderTraits() {
    const item = state.selected;
    if (!item) {
      els.traitChips.innerHTML = "";
      return;
    }
    els.traitChips.innerHTML = Object.entries(item.traits || {})
      .slice(0, 6)
      .map(([k, v]) => `<span class="trait-chip"><b>${escapeHtml(k)}</b> ${escapeHtml(v)}</span>`)
      .join("");
  }

  function renderSource() {
    sourceCtx.save();
    sourceCtx.fillStyle = "#000";
    sourceCtx.fillRect(0, 0, els.sourceCanvas.width, els.sourceCanvas.height);
    sourceCtx.restore();
    if (!state.sourceImage) {
      sourceCtx.save();
      sourceCtx.fillStyle = "rgba(255,255,255,0.34)";
      sourceCtx.font = '13px "GeistMono", Menlo, monospace';
      sourceCtx.textAlign = "center";
      sourceCtx.fillText("Select a NoPunk", els.sourceCanvas.width / 2, els.sourceCanvas.height / 2);
      sourceCtx.restore();
      return;
    }
    state.sourceImageData = drawSourceOnBlack(sourceCtx, state.sourceImage, offscreenCanvas);
  }

  function renderOutput() {
    outputCtx.save();
    outputCtx.fillStyle = "#07090c";
    outputCtx.fillRect(0, 0, els.outputCanvas.width, els.outputCanvas.height);
    outputCtx.restore();
    if (!state.outputPixelCanvas) {
      outputCtx.save();
      outputCtx.fillStyle = "rgba(255,255,255,0.34)";
      outputCtx.font = '13px "GeistMono", Menlo, monospace';
      outputCtx.textAlign = "center";
      outputCtx.fillText("No-Generate output", els.outputCanvas.width / 2, els.outputCanvas.height / 2);
      outputCtx.restore();
      return;
    }
    drawNearestScaled(outputCtx, state.outputPixelCanvas);
  }

  function applyTransform({ reroll = false, backgroundOverride = null, pin = false } = {}) {
    if (!state.sourceImageData) return;
    const paletteBundle = collectVisiblePalette(state.sourceImageData, state.cutoff);
    state.paletteCandidates = getNoMetaBackgroundCandidates(paletteBundle, 12);

    let pickedRandom = false;
    if (backgroundOverride) {
      state.background = { r: backgroundOverride.r, g: backgroundOverride.g, b: backgroundOverride.b };
      state.backgroundPinned = Boolean(pin);
      setAccent(state.background);
    } else if (!state.background || reroll || !state.backgroundPinned) {
      state.background = pickNoMetaBackground(paletteBundle);
      state.backgroundPinned = false;
      pickedRandom = true;
      setAccent(state.background);
    } else {
      setAccent(state.background);
    }

    renderPaletteStrip();

    if (pickedRandom) {
      els.stage.classList.remove("is-roulette");
      void els.stage.offsetWidth;
      els.stage.classList.add("is-roulette");
      setTimeout(() => els.stage.classList.remove("is-roulette"), 260);
    }

    state.outputImageData = applyNoMetaTwoToneMask(state.sourceImageData, state.background);
    state.outputPixelCanvas = imageDataToCanvas(state.outputImageData);
    renderOutput();

    const bgHex = hexFromRgb(state.background);
    const tone2Hex = hexFromRgb(tone2FromBackground(state.background));
    els.bgHex.textContent = bgHex;
    els.bgChip.hidden = false;
    els.bgChip.style.setProperty("--chip-rgb", `${state.background.r}, ${state.background.g}, ${state.background.b}`);
    els.ruleNote.textContent =
      `${bgHex} / ${tone2Hex} · 1024 PNG`;
    setButtons();
  }

  async function selectPunk(item) {
    els.selectionTitle.textContent = `Loading #${item.id}...`;
    const payload = await getPunk(item.id);
    state.selected = payload.item;
    state.sourceImage = await loadImage(state.selected.previewUrl);
    state.background = null;
    state.backgroundPinned = false;
    state.paletteCandidates = [];
    state.outputPixelCanvas = null;
    state.outputImageData = null;
    renderTraits();
    els.selectionTitle.textContent = `${state.selected.name}`;
    els.selectionSubtitle.textContent = `#${state.selected.id} · ${state.selected.type}`;
    renderSource();
    applyTransform({ reroll: true });
    setButtons();
  }

  function downloadOutput() {
    if (!state.selected || !state.background || !state.outputPixelCanvas) return;
    const bgHex = hexFromRgb(state.background);
    const exportCanvas = buildExportCanvasFromPixelCanvas(state.outputPixelCanvas, bgHex, 1024);
    const fileName = `no-meta-${state.selected.id}-${bgHex.replace("#", "").toLowerCase()}-1024.png`;
    exportCanvasPng(exportCanvas, fileName);
  }

  const picker = mountPunkPicker(els.pickerRoot, {
    title: "Find Your NoPunk",
    subtitle: "Search by id, type, or trait",
    placeholder: "7804, alien, pipe, mohawk, clown eyes…",
    getSelectedIds: () => (state.selected ? [state.selected.id] : []),
    autoSelectFirst: true,
    onPick: (item) => {
      selectPunk(item).catch((error) => {
        els.selectionTitle.textContent = "Failed to load NoPunk";
        els.selectionSubtitle.textContent = error.message || "Try another result.";
      });
      picker.refreshSelection();
    },
  });

  const onGenerate = () => applyTransform({ reroll: true });
  const onReroll = () => applyTransform({ reroll: true });
  const onDownload = () => downloadOutput();
  const onAutoBg = () => {
    state.backgroundPinned = false;
    applyTransform({ reroll: true });
  };

  function onRootClick(event) {
    const swatch = event.target.closest("[data-swatch]");
    if (!swatch || !state.sourceImageData) return;
    const raw = swatch.getAttribute("data-swatch") || "";
    const parts = raw.split(",").map((v) => Number.parseInt(v, 10));
    if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return;
    applyTransform({
      backgroundOverride: { r: parts[0], g: parts[1], b: parts[2] },
      pin: true,
    });
  }

  els.generateBtn.addEventListener("click", onGenerate);
  els.rerollBtn.addEventListener("click", onReroll);
  els.downloadBtn.addEventListener("click", onDownload);
  els.autoBgBtn.addEventListener("click", onAutoBg);
  root.addEventListener("click", onRootClick);

  setCanvasSizes();
  renderTraits();
  renderPaletteStrip();
  setButtons();

  if (typeof ctx.setToolMeta === "function") {
    ctx.setToolMeta({
      title: "No-Generate Studio",
      subtitle: "Exact 2-tone #040404 relief. Click palette swatches or reroll.",
    });
  }

  return () => {
    picker.destroy();
    els.generateBtn.removeEventListener("click", onGenerate);
    els.rerollBtn.removeEventListener("click", onReroll);
    els.downloadBtn.removeEventListener("click", onDownload);
    els.autoBgBtn.removeEventListener("click", onAutoBg);
    root.removeEventListener("click", onRootClick);
    root.innerHTML = "";
  };
}
