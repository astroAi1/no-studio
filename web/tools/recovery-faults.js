import {
  getRecoveryFaultFeature,
  getRecoveryFaultHolder,
  getRecoveryFaultsConfig,
} from "../api.js";
import { mountRecoveryFaultEngine } from "../lib/recovery-fault-engine.js";

const TOOL_STYLE_ID = "recovery-faults-style";
const DEFAULT_TOKEN_ID = 7804;
const MAX_VISIBLE_HOLDINGS = 84;

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeAddress(value) {
  const raw = String(value || "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(raw) ? raw : "";
}

function ensureStyles() {
  if (document.getElementById(TOOL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = TOOL_STYLE_ID;
  style.textContent = `
    .rf-page {
      min-height: 100vh;
      padding: 28px;
      color: #edf1f7;
      background:
        radial-gradient(circle at 18% 18%, rgba(126, 205, 255, 0.12), transparent 26%),
        radial-gradient(circle at 82% 14%, rgba(255, 125, 102, 0.12), transparent 24%),
        linear-gradient(180deg, #040507 0%, #07090d 44%, #050608 100%);
    }

    .rf-shell {
      display: grid;
      grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
      gap: 22px;
      align-items: start;
    }

    .rf-panel,
    .rf-stage {
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(6, 8, 12, 0.82);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(20px);
    }

    .rf-panel {
      border-radius: 22px;
      padding: 20px 18px;
      position: sticky;
      top: 20px;
    }

    .rf-kicker {
      font: 11px/1.2 GeistMono, monospace;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: #7cd9ff;
      margin-bottom: 10px;
    }

    .rf-title {
      margin: 0;
      font: 600 30px/0.95 "Geist", "Helvetica Neue", sans-serif;
      letter-spacing: -0.05em;
    }

    .rf-subtitle {
      margin: 12px 0 0;
      font: 14px/1.6 "Geist", "Helvetica Neue", sans-serif;
      color: rgba(237, 241, 247, 0.78);
    }

    .rf-thesis {
      margin: 18px 0 0;
      padding: 14px 14px 14px 16px;
      border-left: 2px solid rgba(124, 217, 255, 0.55);
      background: rgba(255, 255, 255, 0.03);
      color: rgba(237, 241, 247, 0.78);
      font: 13px/1.55 GeistMono, monospace;
    }

    .rf-controls {
      margin-top: 20px;
      display: grid;
      gap: 10px;
    }

    .rf-row {
      display: flex;
      gap: 10px;
    }

    .rf-input {
      width: 100%;
      min-width: 0;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      color: #f5f7fb;
      padding: 12px 14px;
      font: 13px/1 GeistMono, monospace;
      outline: none;
    }

    .rf-input:focus {
      border-color: rgba(124, 217, 255, 0.65);
      box-shadow: 0 0 0 4px rgba(124, 217, 255, 0.08);
    }

    .rf-btn {
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      padding: 12px 14px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.03));
      color: #f3f6fa;
      font: 12px/1 GeistMono, monospace;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      cursor: pointer;
    }

    .rf-btn:hover:not(:disabled) {
      border-color: rgba(124, 217, 255, 0.42);
      transform: translateY(-1px);
    }

    .rf-btn:disabled {
      opacity: 0.45;
      cursor: default;
    }

    .rf-status,
    .rf-holder-meta,
    .rf-token-meta {
      margin-top: 14px;
      padding: 14px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
      font: 12px/1.6 GeistMono, monospace;
      color: rgba(237, 241, 247, 0.78);
    }

    .rf-status strong,
    .rf-holder-meta strong,
    .rf-token-meta strong {
      color: #ffffff;
    }

    .rf-token-grid {
      margin-top: 14px;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }

    .rf-token-chip {
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.025);
      padding: 8px;
      color: #f5f7fb;
      cursor: pointer;
      display: grid;
      gap: 6px;
      text-align: left;
    }

    .rf-token-chip.is-active {
      border-color: rgba(124, 217, 255, 0.7);
      box-shadow: inset 0 0 0 1px rgba(124, 217, 255, 0.25);
      background: rgba(124, 217, 255, 0.08);
    }

    .rf-token-chip img {
      width: 100%;
      aspect-ratio: 1 / 1;
      object-fit: contain;
      border-radius: 10px;
      background: #030405;
      image-rendering: pixelated;
    }

    .rf-token-chip span {
      font: 11px/1.3 GeistMono, monospace;
    }

    .rf-stage {
      border-radius: 28px;
      padding: 16px;
      overflow: hidden;
    }

    .rf-stage-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 14px;
    }

    .rf-stage-title {
      margin: 0;
      font: 600 24px/1 "Geist", "Helvetica Neue", sans-serif;
      letter-spacing: -0.04em;
    }

    .rf-stage-note {
      margin: 8px 0 0;
      color: rgba(237, 241, 247, 0.68);
      font: 12px/1.6 GeistMono, monospace;
      max-width: 720px;
    }

    .rf-stage-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .rf-viewport {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      gap: 16px;
      align-items: start;
    }

    .rf-canvas-wrap {
      border-radius: 24px;
      overflow: hidden;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)),
        #020304;
      border: 1px solid rgba(255, 255, 255, 0.08);
      min-height: 620px;
    }

    .rf-canvas {
      width: 100%;
      height: min(78vh, 960px);
      display: block;
    }

    .rf-sidecar {
      display: grid;
      gap: 14px;
    }

    .rf-card {
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.03);
      padding: 14px;
    }

    .rf-card h3 {
      margin: 0 0 10px;
      font: 600 13px/1 GeistMono, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #9fb6cf;
    }

    .rf-card p,
    .rf-card li {
      margin: 0;
      font: 12px/1.6 GeistMono, monospace;
      color: rgba(237, 241, 247, 0.8);
    }

    .rf-traits {
      display: grid;
      gap: 8px;
    }

    .rf-trait {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: start;
    }

    .rf-trait-key {
      color: rgba(159, 182, 207, 0.86);
    }

    .rf-trait-value {
      color: #ffffff;
      text-align: right;
    }

    .rf-palette {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .rf-swatch {
      width: 26px;
      height: 26px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .rf-mini {
      color: rgba(237, 241, 247, 0.6);
      font: 11px/1.5 GeistMono, monospace;
    }

    @media (max-width: 1120px) {
      .rf-shell,
      .rf-viewport {
        grid-template-columns: 1fr;
      }

      .rf-panel {
        position: static;
      }
    }

    @media (max-width: 720px) {
      .rf-page {
        padding: 16px;
      }

      .rf-token-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .rf-stage-actions,
      .rf-row {
        flex-direction: column;
      }

      .rf-canvas {
        height: min(64vh, 560px);
      }
    }
  `;
  document.head.appendChild(style);
}

function downloadDataUrl(dataUrl, fileName) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  link.click();
}

function renderTraitsMarkup(traits) {
  const list = Array.isArray(traits) ? traits : [];
  return list.map((entry) => `
    <div class="rf-trait">
      <span class="rf-trait-key">${escapeHtml(entry?.trait_type || "")}</span>
      <span class="rf-trait-value">${escapeHtml(entry?.value ?? "")}</span>
    </div>
  `).join("");
}

function renderPaletteMarkup(palette) {
  const chips = [
    palette?.ground,
    ...(Array.isArray(palette?.structure) ? palette.structure : []),
    palette?.accent,
    palette?.corruption,
    palette?.void,
    ...(Array.isArray(palette?.sourceAccents) ? palette.sourceAccents : []),
  ]
    .filter(Boolean)
    .slice(0, 12);

  return chips.map((hex) => `
    <span class="rf-swatch" title="${escapeHtml(hex)}" style="background:${escapeHtml(hex)}"></span>
  `).join("");
}

function querySeedToken() {
  const params = new URLSearchParams(window.location.search);
  const token = Number.parseInt(String(params.get("token") || DEFAULT_TOKEN_ID), 10);
  return Number.isInteger(token) && token >= 0 && token <= 9999 ? token : DEFAULT_TOKEN_ID;
}

function querySeedAddress() {
  const params = new URLSearchParams(window.location.search);
  return normalizeAddress(params.get("address") || "");
}

export function mountRecoveryFaultsTool(root) {
  ensureStyles();
  const initialToken = querySeedToken();
  const initialAddress = querySeedAddress();

  root.innerHTML = `
    <section class="rf-page">
      <div class="rf-shell">
        <aside class="rf-panel">
          <div class="rf-kicker">NoPunks Recovery Faults</div>
          <h1 class="rf-title">holder-claimed exploit-loop companions</h1>
          <p class="rf-subtitle">The source NoPunk stays intact. The companion piece is a failed recovery machine: it boots, aligns, almost repairs, overflows, rolls back, and starts again.</p>
          <div class="rf-thesis">
            Feel: cold, recursive, unstable.<br />
            Primary structure: an off-axis repair scaffold derived from the hidden NoPunk topology.<br />
            Disruption: packet rails, checksum scars, rollback ghosts, and stride tears from the V1 fault stream.<br />
            Failure state: literal portraits, centered slab boredom, or full-frame chaos with no hierarchy.
          </div>

          <div class="rf-controls">
            <div class="rf-row">
              <button class="rf-btn" type="button" data-role="connect-wallet">Connect Wallet</button>
              <button class="rf-btn" type="button" data-role="load-sample">Load Sample #${DEFAULT_TOKEN_ID}</button>
            </div>
            <input class="rf-input" data-role="holder-address" placeholder="0x holder address for snapshot lookup" value="${escapeHtml(initialAddress)}" />
            <div class="rf-row">
              <button class="rf-btn" type="button" data-role="lookup-holder">Lookup Holder</button>
              <input class="rf-input" data-role="manual-token" placeholder="token id" value="${escapeHtml(initialToken)}" />
            </div>
          </div>

          <div class="rf-status" data-role="status">Loading recovery-fault config...</div>
          <div class="rf-holder-meta" data-role="holder-meta">No holder snapshot loaded yet.</div>
          <div class="rf-token-meta" data-role="token-meta">Choose a token to derive a recovery-fault artifact.</div>
          <div class="rf-token-grid" data-role="token-grid"></div>
        </aside>

        <main class="rf-stage">
          <div class="rf-stage-head">
            <div>
              <h2 class="rf-stage-title" data-role="stage-title">Recovery Fault #${initialToken}</h2>
              <p class="rf-stage-note" data-role="stage-note">Rendering the token-specific repair loop. Claim discovery uses the local holder snapshot; live claim eligibility is still enforced onchain by the companion contract against V2 ownership.</p>
            </div>
            <div class="rf-stage-actions">
              <button class="rf-btn" type="button" data-role="save-poster">Save Poster PNG</button>
              <a class="rf-btn" data-role="open-source-png" href="/transparent/${initialToken}.png" target="_blank" rel="noreferrer">Open Source PNG</a>
            </div>
          </div>

          <div class="rf-viewport">
            <div class="rf-canvas-wrap">
              <canvas class="rf-canvas" data-role="artifact-canvas"></canvas>
            </div>
            <div class="rf-sidecar">
              <section class="rf-card">
                <h3>Public Traits</h3>
                <div class="rf-traits" data-role="traits"></div>
              </section>
              <section class="rf-card">
                <h3>Palette Register</h3>
                <div class="rf-palette" data-role="palette"></div>
                <p class="rf-mini" style="margin-top:10px" data-role="palette-note"></p>
              </section>
              <section class="rf-card">
                <h3>Source Scaffold</h3>
                <p data-role="scaffold-meta"></p>
              </section>
              <section class="rf-card">
                <h3>Hash & Claim</h3>
                <p data-role="hash-meta"></p>
              </section>
            </div>
          </div>
        </main>
      </div>
    </section>
  `;

  const els = {
    address: root.querySelector("[data-role='holder-address']"),
    manualToken: root.querySelector("[data-role='manual-token']"),
    connectWallet: root.querySelector("[data-role='connect-wallet']"),
    loadSample: root.querySelector("[data-role='load-sample']"),
    lookupHolder: root.querySelector("[data-role='lookup-holder']"),
    status: root.querySelector("[data-role='status']"),
    holderMeta: root.querySelector("[data-role='holder-meta']"),
    tokenMeta: root.querySelector("[data-role='token-meta']"),
    tokenGrid: root.querySelector("[data-role='token-grid']"),
    stageTitle: root.querySelector("[data-role='stage-title']"),
    stageNote: root.querySelector("[data-role='stage-note']"),
    traits: root.querySelector("[data-role='traits']"),
    palette: root.querySelector("[data-role='palette']"),
    paletteNote: root.querySelector("[data-role='palette-note']"),
    scaffoldMeta: root.querySelector("[data-role='scaffold-meta']"),
    hashMeta: root.querySelector("[data-role='hash-meta']"),
    savePoster: root.querySelector("[data-role='save-poster']"),
    openSourcePng: root.querySelector("[data-role='open-source-png']"),
    canvas: root.querySelector("[data-role='artifact-canvas']"),
  };

  const state = {
    config: null,
    holder: null,
    walletAddress: initialAddress,
    visibleTokenIds: [],
    selectedTokenId: initialToken,
    featurePayload: null,
    player: null,
  };

  function setStatus(message, tone = "neutral") {
    const accent = tone === "error"
      ? "#ff8c72"
      : tone === "success"
        ? "#8dffb1"
        : "#7cd9ff";
    els.status.innerHTML = `<strong style="color:${accent}">${escapeHtml(message)}</strong>`;
  }

  function renderHolderMeta() {
    if (!state.holder) {
      const snapshot = state.config?.holderSnapshot;
      els.holderMeta.innerHTML = snapshot?.generatedAt
        ? `Snapshot loaded from <strong>${escapeHtml(snapshot.generatedAt)}</strong>. Paste a wallet or connect one to pull token IDs.`
        : "Holder discovery snapshot is unavailable. Manual token preview still works.";
      return;
    }
    const snapshot = state.config?.holderSnapshot;
    els.holderMeta.innerHTML = `
      <strong>${escapeHtml(state.holder.address)}</strong><br />
      Balance: <strong>${escapeHtml(state.holder.balance)}</strong> NoPunks<br />
      Snapshot: <strong>${escapeHtml(snapshot?.generatedAt || "unknown")}</strong><br />
      This is discovery-only data. Live claim authority remains the V2 contract owner check.
    `;
  }

  function renderTokenGrid() {
    const ids = state.visibleTokenIds.slice(0, MAX_VISIBLE_HOLDINGS);
    if (!ids.length) {
      els.tokenGrid.innerHTML = "";
      return;
    }
    els.tokenGrid.innerHTML = ids.map((tokenId) => `
      <button type="button" class="rf-token-chip ${state.selectedTokenId === tokenId ? "is-active" : ""}" data-token-id="${tokenId}">
        <img src="/transparent/${tokenId}.png" alt="NoPunk #${tokenId}" loading="lazy" />
        <span>#${tokenId}</span>
      </button>
    `).join("");
  }

  function renderFeaturePayload() {
    const payload = state.featurePayload;
    if (!payload?.featurePack) {
      els.tokenMeta.textContent = "Choose a token to derive a recovery-fault artifact.";
      els.traits.innerHTML = "";
      els.palette.innerHTML = "";
      els.paletteNote.textContent = "";
      els.scaffoldMeta.textContent = "";
      els.hashMeta.textContent = "";
      return;
    }

    const featurePack = payload.featurePack;
    const sourcePunk = payload.sourcePunk;
    const scaffold = featurePack.scaffold;
    const palette = featurePack.palette;

    els.stageTitle.textContent = `${sourcePunk.name} · Recovery Fault`;
    els.stageNote.textContent = `${sourcePunk.traitSummary}. The visible piece is not the 24x24 source; it is a larger repair system driven by that hidden scaffold and the V1 fault stream.`;
    els.tokenMeta.innerHTML = `
      <strong>${escapeHtml(sourcePunk.name)}</strong><br />
      ${escapeHtml(sourcePunk.traitSummary)}<br />
      Visible pixels: <strong>${escapeHtml(scaffold.visibleCount)}</strong> · components: <strong>${escapeHtml(scaffold.componentCount)}</strong> · edge density: <strong>${escapeHtml(scaffold.edgeDensity)}</strong>
    `;
    els.traits.innerHTML = renderTraitsMarkup(featurePack.traits);
    els.palette.innerHTML = renderPaletteMarkup(palette);
    els.paletteNote.textContent = `${palette.label} · source accents ${Array.isArray(palette.sourceAccents) && palette.sourceAccents.length ? palette.sourceAccents.join(", ") : "not detected"}`;
    els.scaffoldMeta.textContent = `bbox ${scaffold.bbox.width}×${scaffold.bbox.height}, centroid ${scaffold.centroid.nx.toFixed(3)}, ${scaffold.centroid.ny.toFixed(3)}, silhouette ${scaffold.silhouetteHash.slice(0, 18)}...`;
    els.hashMeta.textContent = `master ${payload.masterHash.slice(0, 18)}... · identity ${payload.identityHash.slice(0, 14)}... · fault ${payload.faultHash.slice(0, 14)}...`;
    els.openSourcePng.href = `/transparent/${state.selectedTokenId}.png`;

    if (state.player) {
      state.player.update(featurePack);
    } else {
      state.player = mountRecoveryFaultEngine(els.canvas, featurePack);
    }
  }

  async function loadFeature(tokenId) {
    const normalized = Number.parseInt(String(tokenId || "").trim(), 10);
    if (!Number.isInteger(normalized) || normalized < 0 || normalized > 9999) {
      setStatus("Token ID must be between 0 and 9999.", "error");
      return;
    }
    state.selectedTokenId = normalized;
    els.manualToken.value = String(normalized);
    renderTokenGrid();
    setStatus(`Deriving recovery fault #${normalized}...`);
    try {
      state.featurePayload = await getRecoveryFaultFeature(normalized);
      renderFeaturePayload();
      setStatus(`Recovery fault #${normalized} loaded.`, "success");
    } catch (error) {
      state.featurePayload = null;
      renderFeaturePayload();
      setStatus(error.message || "Failed to derive feature pack.", "error");
    }
  }

  async function lookupHolder(address) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
      setStatus("Enter a valid 0x wallet address.", "error");
      return;
    }
    state.walletAddress = normalized;
    els.address.value = normalized;
    setStatus(`Looking up holder snapshot for ${normalized.slice(0, 10)}...`);
    try {
      const holder = await getRecoveryFaultHolder(normalized);
      state.holder = holder;
      state.visibleTokenIds = Array.isArray(holder.tokenIds) ? holder.tokenIds.slice() : [];
      renderHolderMeta();
      renderTokenGrid();
      setStatus(`Found ${holder.balance} NoPunks for ${normalized.slice(0, 10)}.`, "success");
      if (state.visibleTokenIds.length) {
        await loadFeature(state.visibleTokenIds[0]);
      }
    } catch (error) {
      state.holder = null;
      state.visibleTokenIds = [];
      renderHolderMeta();
      renderTokenGrid();
      setStatus(error.message || "Holder not found in snapshot.", "error");
    }
  }

  async function connectWallet() {
    if (!window.ethereum || typeof window.ethereum.request !== "function") {
      setStatus("No injected wallet found in this browser.", "error");
      return;
    }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const address = normalizeAddress(Array.isArray(accounts) ? accounts[0] : "");
      if (!address) {
        setStatus("Wallet returned no usable address.", "error");
        return;
      }
      await lookupHolder(address);
    } catch (error) {
      setStatus(error.message || "Wallet connection failed.", "error");
    }
  }

  async function boot() {
    try {
      state.config = await getRecoveryFaultsConfig();
      renderHolderMeta();
      setStatus(`Snapshot ${state.config?.holderSnapshot?.generatedAt || "unavailable"} loaded.`, "success");
    } catch (error) {
      setStatus(error.message || "Recovery-fault config unavailable.", "error");
    }

    if (initialAddress) {
      await lookupHolder(initialAddress);
      return;
    }

    await loadFeature(initialToken);
  }

  function onClick(event) {
    const tokenChip = event.target.closest("[data-token-id]");
    if (tokenChip) {
      const tokenId = Number.parseInt(tokenChip.getAttribute("data-token-id") || "", 10);
      if (Number.isInteger(tokenId)) {
        loadFeature(tokenId);
      }
    }
  }

  const handleLookupHolder = () => lookupHolder(els.address.value);
  const handleLoadSample = () => loadFeature(Number.parseInt(els.manualToken.value || DEFAULT_TOKEN_ID, 10) || DEFAULT_TOKEN_ID);
  const handleManualTokenKeydown = (event) => {
    if (event.key === "Enter") {
      loadFeature(els.manualToken.value);
    }
  };
  const handleAddressKeydown = (event) => {
    if (event.key === "Enter") {
      lookupHolder(els.address.value);
    }
  };
  const handleSavePoster = () => {
    if (!state.player) return;
    downloadDataUrl(state.player.snapshotDataUrl(), `nopunks-recovery-fault-${state.selectedTokenId}.png`);
  };

  els.lookupHolder.addEventListener("click", handleLookupHolder);
  els.connectWallet.addEventListener("click", connectWallet);
  els.loadSample.addEventListener("click", handleLoadSample);
  els.manualToken.addEventListener("keydown", handleManualTokenKeydown);
  els.address.addEventListener("keydown", handleAddressKeydown);
  els.savePoster.addEventListener("click", handleSavePoster);
  els.tokenGrid.addEventListener("click", onClick);

  boot();

  return () => {
    els.lookupHolder.removeEventListener("click", handleLookupHolder);
    els.connectWallet.removeEventListener("click", connectWallet);
    els.loadSample.removeEventListener("click", handleLoadSample);
    els.manualToken.removeEventListener("keydown", handleManualTokenKeydown);
    els.address.removeEventListener("keydown", handleAddressKeydown);
    els.savePoster.removeEventListener("click", handleSavePoster);
    els.tokenGrid.removeEventListener("click", onClick);
    if (state.player) state.player.destroy();
  };
}
