import { getGifStyles, createGifJob, getGifJob } from "../api.js";
import { mountPunkPicker } from "../components/punk-picker.js";

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STAGE_ORDER = ["queued", "rendering", "optimizing", "ready"];

export function mountGifLabTool(root, ctx = {}) {
  root.innerHTML = `
    <section class="tool-grid tool-grid--gif">
      <section class="panel tool-panel gif-shell">
        <div class="panel-head panel-head--spread">
          <div>
            <p class="micro-label">Reveal Clean</p>
            <h3 class="panel-title">Minimal grayscale reveal</h3>
            <p class="panel-subtle">1024 GIF loop + PNG cover.</p>
          </div>
          <span class="spec-chip"><strong>1024x1024</strong><small>GIF + PNG</small></span>
        </div>

        <div class="gif-layout">
          <section class="gif-controls">
            <div class="subpanel">
              <div class="subpanel-head">
                <p class="micro-label">Styles</p>
                <span class="micro-note" data-role="styles-status">Loading styles…</span>
              </div>
              <div class="style-grid" data-role="style-grid"></div>
            </div>

            <div class="subpanel">
              <div class="subpanel-head">
                <p class="micro-label">Selection</p>
                <span class="micro-note" data-role="selection-requirement">Select a style</span>
              </div>
              <div class="selection-strip" data-role="selection-strip"></div>
              <div class="selection-actions">
                <button class="chip-btn chip-btn--accent" type="button" data-role="render-btn">Render GIF</button>
                <button class="chip-btn" type="button" data-role="clear-btn">Clear Selection</button>
              </div>
              <p class="micro-note" data-role="render-help">Pick a style and select a NoPunk.</p>
            </div>

            <div class="subpanel render-job">
              <div class="subpanel-head">
                <p class="micro-label">Render Job</p>
                <span class="micro-note" data-role="job-status">Idle</span>
              </div>
              <div class="job-tape" data-role="job-tape">
                <div class="job-step" data-stage="queued"><span>Queued</span></div>
                <div class="job-step" data-stage="rendering"><span>Rendering</span></div>
                <div class="job-step" data-stage="optimizing"><span>Optimizing</span></div>
                <div class="job-step" data-stage="ready"><span>Ready</span></div>
              </div>
              <div class="job-preview" data-role="job-preview">
                <div class="job-preview-empty">Render preview</div>
              </div>
            </div>
          </section>

          <div class="gif-picker-col" data-role="picker-root"></div>
        </div>
      </section>
    </section>
  `;

  const els = {
    pickerRoot: root.querySelector('[data-role="picker-root"]'),
    styleGrid: root.querySelector('[data-role="style-grid"]'),
    stylesStatus: root.querySelector('[data-role="styles-status"]'),
    selectionRequirement: root.querySelector('[data-role="selection-requirement"]'),
    selectionStrip: root.querySelector('[data-role="selection-strip"]'),
    renderBtn: root.querySelector('[data-role="render-btn"]'),
    clearBtn: root.querySelector('[data-role="clear-btn"]'),
    renderHelp: root.querySelector('[data-role="render-help"]'),
    jobStatus: root.querySelector('[data-role="job-status"]'),
    jobTape: root.querySelector('[data-role="job-tape"]'),
    jobPreview: root.querySelector('[data-role="job-preview"]'),
  };

  const state = {
    styles: [],
    styleMap: new Map(),
    selectedStyleId: null,
    selectedItems: [],
    seed: null,
    activeJob: null,
    pollTimer: null,
    disposed: false,
  };

  function setJobTape(stage = "queued") {
    els.jobTape.dataset.stage = stage;
    const stageIndex = STAGE_ORDER.indexOf(stage);
    els.jobTape.querySelectorAll(".job-step").forEach((step, index) => {
      step.classList.toggle("is-active", index <= stageIndex && stageIndex >= 0);
      step.classList.toggle("is-current", step.dataset.stage === stage);
    });
  }

  function getSelectedStyle() {
    return state.styleMap.get(state.selectedStyleId) || null;
  }

  function updateSelectionUI() {
    const style = getSelectedStyle();
    if (!style) {
      els.selectionRequirement.textContent = "Select a style";
      els.selectionStrip.innerHTML = `<div class="selection-empty">Choose a style to configure token inputs.</div>`;
      els.renderHelp.textContent = "Pick a style.";
      els.renderBtn.disabled = true;
      return;
    }

    els.selectionRequirement.textContent = style.mode === "multi"
      ? `Needs ${style.minIds}-${style.maxIds} NoPunks`
      : "Needs 1 NoPunk";

    const chips = state.selectedItems.map((item) => `
      <button class="selection-chip" type="button" data-remove-id="${item.id}">
        <img src="${item.previewUrl}" alt="" loading="lazy" decoding="async" />
        <span>#${item.id}</span>
        <b>✕</b>
      </button>
    `);
    els.selectionStrip.innerHTML = chips.length ? chips.join("") : `<div class="selection-empty">No NoPunks selected yet.</div>`;

    const count = state.selectedItems.length;
    const valid = count >= style.minIds && count <= style.maxIds;
    els.renderBtn.disabled = !valid;
    els.renderHelp.textContent = valid
      ? `Ready · ${style.label}`
      : `Select ${style.minIds}${style.maxIds !== style.minIds ? `-${style.maxIds}` : ""} NoPunk${style.maxIds > 1 ? "s" : ""}`;

    if (typeof ctx.setAccent === "function") {
      ctx.setAccent({ r: 164, g: 164, b: 164 });
    }
  }

  function renderStyleCards() {
    els.styleGrid.innerHTML = state.styles.map((style) => {
      const active = style.id === state.selectedStyleId;
      return `
        <button class="style-card${active ? " is-active" : ""}" type="button" data-style-id="${style.id}">
          <div class="style-meta">
            <span class="style-mode">${style.mode === "multi" ? `${style.minIds}-${style.maxIds}` : "1"}</span>
            <strong>${escapeHtml(style.label || style.name)}</strong>
          </div>
          <p>${escapeHtml(style.description || "")}</p>
        </button>
      `;
    }).join("");
  }

  function pruneSelectionToStyle() {
    const style = getSelectedStyle();
    if (!style) {
      state.selectedItems = [];
      return;
    }
    if (style.mode === "single") {
      state.selectedItems = state.selectedItems.slice(0, 1);
    } else if (state.selectedItems.length > style.maxIds) {
      state.selectedItems = state.selectedItems.slice(0, style.maxIds);
    }
  }

  function setStyle(styleId) {
    if (!state.styleMap.has(styleId)) return;
    state.selectedStyleId = styleId;
    pruneSelectionToStyle();
    renderStyleCards();
    updateSelectionUI();
    picker.refreshSelection();
    picker.setAutoSelectFirst(false);
  }

  function toggleSelectedItem(item) {
    const style = getSelectedStyle();
    if (!style) return;
    const existingIndex = state.selectedItems.findIndex((entry) => entry.id === item.id);
    if (style.mode === "single") {
      state.selectedItems = [item];
    } else if (existingIndex >= 0) {
      state.selectedItems = state.selectedItems.filter((entry) => entry.id !== item.id);
    } else if (state.selectedItems.length < style.maxIds) {
      state.selectedItems = [...state.selectedItems, item];
    } else {
      state.selectedItems = [...state.selectedItems.slice(1), item];
    }
    updateSelectionUI();
    picker.refreshSelection();
  }

  function setJobState(job, message = null) {
    state.activeJob = job;
    const stage = job && job.stage ? job.stage : "queued";
    setJobTape(stage);
    els.jobStatus.textContent = message || (job ? `${job.status} · ${stage}` : "Idle");

    if (!job) {
      els.jobPreview.innerHTML = `<div class="job-preview-empty">Render preview</div>`;
      return;
    }

    if (job.status === "failed") {
      els.jobPreview.innerHTML = `<div class="job-preview-empty is-error">${escapeHtml(job.error || "Render failed")}</div>`;
      return;
    }

    if (job.status !== "ready" || !Array.isArray(job.files)) {
      els.jobPreview.innerHTML = `<div class="job-preview-empty">${escapeHtml(job.stage || job.status)}</div>`;
      return;
    }

    const gifFile = job.files.find((f) => f.kind === "gif");
    const pngFile = job.files.find((f) => f.kind === "png");
    const actions = [];
    if (gifFile) actions.push(`<a class="chip-btn chip-btn--accent" href="${gifFile.url}?download=1">Download GIF</a>`);
    if (pngFile) actions.push(`<a class="chip-btn" href="${pngFile.url}?download=1">Download PNG Cover</a>`);

    els.jobPreview.innerHTML = `
      <div class="job-media-grid">
        ${gifFile ? `<figure class="job-media"><figcaption>GIF</figcaption><img src="${gifFile.url}" alt="Rendered GIF preview" /></figure>` : ""}
        ${pngFile ? `<figure class="job-media"><figcaption>PNG Cover</figcaption><img src="${pngFile.url}" alt="Rendered PNG cover" /></figure>` : ""}
      </div>
      <div class="job-downloads">${actions.join("")}</div>
    `;
  }

  async function pollJob(jobId) {
    try {
      const payload = await getGifJob(jobId);
      if (state.disposed) return;
      setJobState(payload.job);
      if (payload.job.status === "ready" || payload.job.status === "failed") {
        stopPolling();
      }
    } catch (error) {
      if (state.disposed) return;
      stopPolling();
      setJobState(null, `Polling failed`);
    }
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling(jobId) {
    stopPolling();
    state.pollTimer = setInterval(() => pollJob(jobId), 1000);
  }

  async function submitJob() {
    const style = getSelectedStyle();
    if (!style) return;
    const tokenIds = state.selectedItems.map((item) => item.id);
    els.renderBtn.disabled = true;
    setJobState(null, "Submitting render job…");
    try {
      const payload = await createGifJob({
        styleId: style.id,
        tokenIds,
        seed: style.supportsSeed ? (state.seed ?? undefined) : undefined,
      });
      setJobState(payload.job || { id: payload.jobId, status: payload.status, stage: payload.stage || "queued", logs: [] }, "Job queued");
      startPolling(payload.jobId);
      pollJob(payload.jobId);
    } catch (error) {
      setJobState(null, "Render failed");
    } finally {
      updateSelectionUI();
    }
  }

  const picker = mountPunkPicker(els.pickerRoot, {
    title: "Select NoPunks",
    subtitle: "Thumbnails on black · grayscale reveal output",
    placeholder: "Search and click to add/remove NoPunks…",
    getSelectedIds: () => state.selectedItems.map((item) => item.id),
    autoSelectFirst: false,
    onPick: (item) => toggleSelectedItem(item),
  });

  async function loadStyles() {
    els.stylesStatus.textContent = "Loading…";
    try {
      const payload = await getGifStyles();
      state.styles = payload.styles || [];
      state.styleMap = new Map(state.styles.map((style) => [style.id, style]));
      renderStyleCards();
      if (state.styles[0]) {
        setStyle(state.styles[0].id);
      }
      els.stylesStatus.textContent = `${state.styles.length} styles`;
    } catch (error) {
      els.stylesStatus.textContent = `Error`;
      els.styleGrid.innerHTML = `<div class="selection-empty">GIF styles unavailable: ${escapeHtml(error.message)}</div>`;
    }
  }

  function onRootClick(event) {
    const styleButton = event.target.closest("[data-style-id]");
    if (styleButton) {
      setStyle(styleButton.getAttribute("data-style-id"));
      return;
    }
    const removeButton = event.target.closest("[data-remove-id]");
    if (removeButton) {
      const id = Number.parseInt(removeButton.getAttribute("data-remove-id"), 10);
      state.selectedItems = state.selectedItems.filter((item) => item.id !== id);
      updateSelectionUI();
      picker.refreshSelection();
      return;
    }
  }

  function onClear() {
    state.selectedItems = [];
    updateSelectionUI();
    picker.refreshSelection();
  }

  root.addEventListener("click", onRootClick);
  els.renderBtn.addEventListener("click", submitJob);
  els.clearBtn.addEventListener("click", onClear);

  setJobTape("queued");
  updateSelectionUI();
  loadStyles();

  if (typeof ctx.setToolMeta === "function") {
    ctx.setToolMeta({
      title: "Reveal Clean",
      subtitle: "Minimal grayscale reveal GIF loop. 1024x1024 GIF + PNG cover.",
    });
  }

  return () => {
    state.disposed = true;
    stopPolling();
    picker.destroy();
    root.removeEventListener("click", onRootClick);
    els.renderBtn.removeEventListener("click", submitJob);
    els.clearBtn.removeEventListener("click", onClear);
    root.innerHTML = "";
  };
}
