import { getPunk, getTcgConfig, createTcgCard } from "../api.js";
import { mountPunkPicker } from "../components/punk-picker.js";
import { loadImage, drawNoirCardPlaceholder } from "../lib/tcg-render-preview.js";
import { copyTextToClipboard, stringifyPrettyJson } from "../lib/tcg-copy.js";
import { attackLineParts, compactTraitHighlights, tcgRarityTone } from "../lib/tcg-format.js";

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function drawSourceOnBlack(canvas, img) {
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (img) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.font = '12px "GeistMono", monospace';
    ctx.textAlign = "center";
    ctx.fillText("Select a NoPunk", canvas.width / 2, canvas.height / 2);
  }
  ctx.restore();
}

export function mountTcgForgeTool(root, ctx = {}) {
  root.innerHTML = `
    <section class="tool-grid tool-grid--tcg">
      <div class="tool-col tool-col--picker" data-role="picker-root"></div>
      <section class="panel tool-panel tcg-shell">
        <div class="panel-head panel-head--spread">
          <div>
            <p class="micro-label">TCG Forge</p>
            <h3 class="panel-title" data-role="title">Select a NoPunk</h3>
            <p class="panel-subtle" data-role="subtitle">DBZ-style locked TCG layout. Noir shell, colorful card output.</p>
          </div>
          <div class="spec-cluster">
            <span class="spec-chip"><strong>1024×1432</strong><small>PNG Preview</small></span>
            <span class="spec-chip"><strong>Prompt + JSON</strong><small>AI-ready</small></span>
          </div>
        </div>

        <div class="tcg-workbench">
          <section class="tcg-stage-panel">
            <div class="tcg-stage-grid">
              <figure class="shadowplate tcg-source-plate">
                <figcaption class="frame-caption">Source</figcaption>
                <canvas data-role="source-canvas" width="288" height="288" aria-label="Selected NoPunk on black"></canvas>
              </figure>
              <figure class="shadowplate shadowplate--output tcg-card-plate" data-role="card-plate">
                <figcaption class="frame-caption">TCG Preview</figcaption>
                <canvas data-role="card-canvas" width="512" height="716" aria-label="TCG card preview placeholder"></canvas>
                <img data-role="card-image" alt="Generated TCG preview" hidden />
              </figure>
            </div>
            <div class="action-row">
              <button class="chip-btn chip-btn--accent" type="button" data-role="forge-btn">Forge Card</button>
              <button class="chip-btn" type="button" data-role="copy-prompt-btn" disabled>Copy Prompt</button>
              <button class="chip-btn" type="button" data-role="copy-json-btn" disabled>Copy JSON</button>
              <a class="chip-btn" data-role="download-preview" href="#" hidden>Download PNG</a>
              <a class="chip-btn" data-role="download-json" href="#" hidden>JSON</a>
              <a class="chip-btn" data-role="download-prompt" href="#" hidden>Prompt TXT</a>
            </div>
            <p class="spec-note tcg-status" data-role="status">Pick a NoPunk to forge a card.</p>
          </section>

          <section class="tcg-info-panel">
            <div class="subpanel tcg-meta-subpanel">
              <div class="subpanel-head">
                <p class="micro-label">Card Data</p>
                <span class="micro-note" data-role="rarity-roll-note">Deterministic rarity</span>
              </div>
              <div class="tcg-meta-grid" data-role="meta-grid">
                <div class="tcg-meta-empty">No card forged yet.</div>
              </div>
            </div>

            <div class="subpanel">
              <div class="subpanel-head">
                <p class="micro-label">Attacks</p>
                <span class="micro-note">Exactly 2</span>
              </div>
              <div class="tcg-attacks" data-role="attacks"></div>
            </div>

            <div class="subpanel">
              <div class="subpanel-head">
                <p class="micro-label">Prompt Hints</p>
                <span class="micro-note">Trait-driven</span>
              </div>
              <div class="trait-chips" data-role="prompt-hints"></div>
              <details class="tcg-prompt-panel">
                <summary>Prompt Preview</summary>
                <pre data-role="prompt-preview">No prompt yet.</pre>
              </details>
            </div>
          </section>
        </div>
      </section>
    </section>
  `;

  const els = {
    pickerRoot: root.querySelector('[data-role="picker-root"]'),
    title: root.querySelector('[data-role="title"]'),
    subtitle: root.querySelector('[data-role="subtitle"]'),
    sourceCanvas: root.querySelector('[data-role="source-canvas"]'),
    cardCanvas: root.querySelector('[data-role="card-canvas"]'),
    cardImage: root.querySelector('[data-role="card-image"]'),
    cardPlate: root.querySelector('[data-role="card-plate"]'),
    forgeBtn: root.querySelector('[data-role="forge-btn"]'),
    copyPromptBtn: root.querySelector('[data-role="copy-prompt-btn"]'),
    copyJsonBtn: root.querySelector('[data-role="copy-json-btn"]'),
    downloadPreview: root.querySelector('[data-role="download-preview"]'),
    downloadJson: root.querySelector('[data-role="download-json"]'),
    downloadPrompt: root.querySelector('[data-role="download-prompt"]'),
    status: root.querySelector('[data-role="status"]'),
    metaGrid: root.querySelector('[data-role="meta-grid"]'),
    attacks: root.querySelector('[data-role="attacks"]'),
    promptHints: root.querySelector('[data-role="prompt-hints"]'),
    promptPreview: root.querySelector('[data-role="prompt-preview"]'),
    rarityRollNote: root.querySelector('[data-role="rarity-roll-note"]'),
  };

  const state = {
    selected: null,
    sourceImage: null,
    forged: null,
    tcgConfig: null,
    busy: false,
    previewNonce: 0,
  };

  function setAccentNeutral() {
    if (typeof ctx.setAccent === "function") {
      ctx.setAccent({ r: 176, g: 176, b: 176 });
    }
  }

  function setStatus(text) {
    els.status.textContent = String(text || "");
  }

  function setBusy(flag) {
    state.busy = Boolean(flag);
    els.forgeBtn.disabled = !state.selected || state.busy;
  }

  function setDownloadLink(anchor, url, label) {
    if (!url) {
      anchor.hidden = true;
      anchor.removeAttribute("href");
      return;
    }
    anchor.hidden = false;
    anchor.href = url;
    if (label) anchor.textContent = label;
  }

  function renderPlaceholder() {
    drawNoirCardPlaceholder(els.cardCanvas, { sourceImage: state.sourceImage });
    els.cardCanvas.hidden = false;
    els.cardImage.hidden = true;
    els.cardImage.removeAttribute("src");
  }

  function renderSource() {
    drawSourceOnBlack(els.sourceCanvas, state.sourceImage);
  }

  function renderMeta() {
    const forged = state.forged;
    if (!forged || !forged.card) {
      els.metaGrid.innerHTML = `<div class="tcg-meta-empty">No card forged yet.</div>`;
      els.attacks.innerHTML = `<div class="selection-empty">Forge a card to generate attacks.</div>`;
      els.promptHints.innerHTML = "";
      els.promptPreview.textContent = "No prompt yet.";
      els.copyPromptBtn.disabled = true;
      els.copyJsonBtn.disabled = true;
      setDownloadLink(els.downloadPreview, null);
      setDownloadLink(els.downloadJson, null);
      setDownloadLink(els.downloadPrompt, null);
      els.rarityRollNote.textContent = "Deterministic rarity";
      return;
    }

    const { card, preview, exports: exportInfo, promptText } = forged;
    const rarityTone = tcgRarityTone(card.rarity);
    els.metaGrid.innerHTML = `
      <div class="tcg-meta-pill tcg-meta-pill--${rarityTone}"><span>Rarity</span><strong>${escapeHtml(card.rarity)}</strong></div>
      <div class="tcg-meta-pill"><span>HP</span><strong>${escapeHtml(String(card.hp))}</strong></div>
      <div class="tcg-meta-pill"><span>Type</span><strong>${escapeHtml(card.source.type || "Unknown")}</strong></div>
      <div class="tcg-meta-pill"><span>Guide</span><strong>${escapeHtml(card.typeGuideId)}</strong></div>
      <div class="tcg-meta-pill tcg-meta-pill--wide"><span>Name</span><strong>${escapeHtml(card.displayName)}</strong></div>
      <div class="tcg-meta-pill tcg-meta-pill--wide"><span>Template</span><strong>${escapeHtml(card.layout.templateVersion)}</strong></div>
    `;

    els.attacks.innerHTML = (card.attacks || []).map((attack, index) => {
      const parts = attackLineParts(attack);
      return `
        <article class="tcg-attack-card">
          <div class="tcg-attack-card__head">
            <span class="tcg-attack-slot">A${index + 1}</span>
            <strong>${escapeHtml(parts.name)}</strong>
            <span class="tcg-attack-dmg">${escapeHtml(String(parts.damage))} DMG</span>
          </div>
          <p>${escapeHtml(attack.flavor || "")}</p>
        </article>
      `;
    }).join("");

    const hints = compactTraitHighlights(card);
    els.promptHints.innerHTML = hints.map((h) => `<span class="trait-chip">${escapeHtml(h)}</span>`).join("");
    els.promptPreview.textContent = String(promptText || "").slice(0, 2800);
    els.copyPromptBtn.disabled = false;
    els.copyJsonBtn.disabled = false;
    setDownloadLink(els.downloadPreview, exportInfo && exportInfo.previewUrl, "Download PNG");
    setDownloadLink(els.downloadJson, exportInfo && exportInfo.jsonUrl, "JSON");
    setDownloadLink(els.downloadPrompt, exportInfo && exportInfo.promptUrl, "Prompt TXT");
    els.rarityRollNote.textContent = `Deterministic · ${card.hiddenRollVersion}`;

    if (preview && preview.url) {
      state.previewNonce += 1;
      els.cardImage.src = `${preview.url}${preview.url.includes("?") ? "&" : "?"}v=${state.previewNonce}`;
      els.cardImage.hidden = false;
      els.cardCanvas.hidden = true;
    }
  }

  async function selectPunk(item) {
    setStatus(`Loading #${item.id}…`);
    state.forged = null;
    renderMeta();
    renderPlaceholder();

    const payload = await getPunk(item.id);
    state.selected = payload.item;
    state.sourceImage = await loadImage(state.selected.previewUrl);
    els.title.textContent = `TCG Forge · #${state.selected.id}`;
    els.subtitle.textContent = `${state.selected.type} · Locked layout · deterministic rarity`;
    renderSource();
    renderPlaceholder();
    setStatus(`Ready to forge #${state.selected.id}`);
    setBusy(false);
  }

  async function forgeCard() {
    if (!state.selected || state.busy) return;
    setBusy(true);
    setStatus(`Forging #${state.selected.id}…`);
    try {
      const payload = await createTcgCard({ tokenId: state.selected.id, variant: "base" });
      state.forged = payload;
      renderMeta();
      setStatus(`Forged ${payload.card.rarity} · ${payload.card.displayName}`);
    } catch (error) {
      setStatus(error.message || "Forge failed");
      els.cardCanvas.hidden = false;
      els.cardImage.hidden = true;
    } finally {
      setBusy(false);
    }
  }

  async function copyPrompt() {
    try {
      await copyTextToClipboard((state.forged && state.forged.promptText) || "");
      setStatus("Prompt copied");
    } catch (error) {
      setStatus(error.message || "Copy failed");
    }
  }

  async function copyJson() {
    try {
      await copyTextToClipboard(stringifyPrettyJson((state.forged && state.forged.card) || {}));
      setStatus("JSON copied");
    } catch (error) {
      setStatus(error.message || "Copy failed");
    }
  }

  const picker = mountPunkPicker(els.pickerRoot, {
    title: "Select NoPunk",
    subtitle: "Traits drive card name, rarity, attacks",
    placeholder: "7804, alien, pipe, shades…",
    getSelectedIds: () => (state.selected ? [state.selected.id] : []),
    autoSelectFirst: false,
    onPick: (item) => {
      selectPunk(item).catch((error) => {
        setStatus(error.message || "Failed to load NoPunk");
      });
      picker.refreshSelection();
    },
  });

  function onImageLoad() {
    els.cardImage.hidden = false;
  }

  async function loadConfig() {
    try {
      state.tcgConfig = await getTcgConfig();
    } catch {
      state.tcgConfig = null;
    }
  }

  els.forgeBtn.addEventListener("click", forgeCard);
  els.copyPromptBtn.addEventListener("click", copyPrompt);
  els.copyJsonBtn.addEventListener("click", copyJson);
  els.cardImage.addEventListener("load", onImageLoad);

  renderSource();
  renderPlaceholder();
  renderMeta();
  setAccentNeutral();
  setBusy(false);
  loadConfig();

  if (typeof ctx.setToolMeta === "function") {
    ctx.setToolMeta({
      title: "TCG Forge",
      subtitle: "Locked DBZ-style TCG template. Deterministic rarity. PNG preview + prompt + JSON.",
    });
  }

  return () => {
    picker.destroy();
    els.forgeBtn.removeEventListener("click", forgeCard);
    els.copyPromptBtn.removeEventListener("click", copyPrompt);
    els.copyJsonBtn.removeEventListener("click", copyJson);
    els.cardImage.removeEventListener("load", onImageLoad);
    root.innerHTML = "";
  };
}
