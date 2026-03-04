import { listNoStudioGallery } from "../api.js";

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function mediaTypeOf(item) {
  return String(item?.mediaType || "").toLowerCase() === "gif" ? "gif" : "png";
}

function mediaUrlOf(item) {
  return item?.mediaUrl || item?.viewUrl || item?.thumbUrl || item?.pngUrl || item?.gifUrl || "";
}

function signatureOf(item) {
  const value = String(item?.signatureHandle || item?.signature || item?.twitterHandle || "").trim();
  return value;
}

function paletteOf(item) {
  const source = Array.isArray(item?.palette) ? item.palette : (Array.isArray(item?.paletteHexes) ? item.paletteHexes : []);
  const dedupe = new Set();
  const out = [];
  for (const value of source) {
    const hex = String(value || "").trim().toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex) || dedupe.has(hex)) continue;
    dedupe.add(hex);
    out.push(hex);
    if (out.length >= 64) break;
  }
  if (!out.length) {
    const bg = String(item?.rolePair?.background || "").trim().toUpperCase();
    const fg = String(item?.rolePair?.figure || "").trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(bg)) {
      out.push(bg);
      dedupe.add(bg);
    }
    if (/^#[0-9A-F]{6}$/.test(fg) && !dedupe.has(fg)) {
      out.push(fg);
    }
  }
  return out;
}

function paletteSwatchesMarkup(palette, limit = null) {
  if (!palette.length) return "";
  const hasLimit = Number.isFinite(limit);
  const preview = hasLimit ? palette.slice(0, limit) : palette;
  const remaining = Math.max(0, palette.length - preview.length);
  return `
    <span class="no-gallery-palette-strip">
      ${preview.map((hex) => `<span class="no-gallery-palette-swatch" style="background:${escapeHtml(hex)}" title="${escapeHtml(hex)}"></span>`).join("")}
      ${remaining ? `<span class="no-gallery-palette-more">+${remaining}</span>` : ""}
    </span>
  `;
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => Number(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function extractPaletteFromMedia(url, max = 16) {
  if (!url) return Promise.resolve([]);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.onload = () => {
      try {
        const sampleSize = 24;
        const canvas = document.createElement("canvas");
        canvas.width = sampleSize;
        canvas.height = sampleSize;
        const ctx = canvas.getContext("2d", { alpha: true });
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, sampleSize, sampleSize);
        ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
        const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;
        const counts = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a === 0) continue;
          const hex = rgbToHex(data[i], data[i + 1], data[i + 2]);
          counts.set(hex, (counts.get(hex) || 0) + 1);
        }
        const palette = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([hex]) => hex)
          .slice(0, max);
        resolve(palette);
      } catch {
        resolve([]);
      }
    };
    img.onerror = () => resolve([]);
    img.src = url;
  });
}

function buildCardMarkup(item) {
  const mediaUrl = mediaUrlOf(item);
  const mediaType = mediaTypeOf(item);
  const label = item?.label || `No-Studio #${Number(item?.tokenId) || 0}`;
  const signature = signatureOf(item);
  const palette = paletteOf(item);
  const bg = item?.rolePair?.background || "";
  const fg = item?.rolePair?.figure || "";
  const pair = bg && fg
    ? `${escapeHtml(bg)} → ${escapeHtml(fg)}`
    : "Role pair unavailable";
  return `
    <button type="button" class="no-gallery-card" data-gallery-open="${escapeHtml(item?.id || "")}">
      <img class="no-gallery-card-media" src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(label)}" loading="lazy" />
      <span class="no-gallery-card-meta">
        <strong class="no-gallery-card-title">${escapeHtml(label)}</strong>
        <span class="no-gallery-card-sub">#${Number(item?.tokenId) || 0} · ${(item?.family || "studio").toUpperCase()} · ${mediaType.toUpperCase()}</span>
        <span class="no-gallery-card-sub">${pair}</span>
        ${paletteSwatchesMarkup(palette, 8)}
        ${signature ? `<span class="no-gallery-card-sign">${escapeHtml(signature)}</span>` : ""}
      </span>
    </button>
  `;
}

export function mountNoGalleryPage(root) {
  root.innerHTML = `
    <section class="no-gallery-page" data-role="no-gallery-page">
      <header class="no-gallery-topbar">
        <div class="no-gallery-brand">
          <span class="no-gallery-kicker">Noir de Noir</span>
          <h1 class="no-gallery-title">No-Gallery</h1>
          <p class="no-gallery-note">Saved curations from No-Studio. Click any piece to view at 1024×1024.</p>
        </div>
        <div class="no-gallery-actions">
          <a class="no-gallery-btn" href="/tools/no-studio">Back To Studio</a>
          <button class="no-gallery-btn" type="button" data-role="gallery-refresh">Refresh</button>
        </div>
      </header>
      <main class="no-gallery-grid-shell">
        <div class="no-gallery-grid" data-role="gallery-grid">
          <div class="no-gallery-empty">Loading No-Gallery...</div>
        </div>
      </main>
      <div class="no-gallery-modal" data-role="gallery-modal" hidden>
        <div class="no-gallery-modal-backdrop" data-role="gallery-modal-close"></div>
        <article class="no-gallery-modal-panel">
          <header class="no-gallery-modal-head">
            <div class="no-gallery-modal-title" data-role="gallery-modal-title">No-Gallery Piece</div>
            <button class="no-gallery-btn" type="button" data-role="gallery-modal-close">Close</button>
          </header>
          <div class="no-gallery-modal-media-wrap">
            <img class="no-gallery-modal-media" data-role="gallery-modal-media" alt="No-Gallery preview" />
          </div>
          <footer class="no-gallery-modal-foot">
            <div class="no-gallery-modal-meta">
              <div class="no-gallery-modal-sign" data-role="gallery-modal-sign"></div>
              <div class="no-gallery-modal-palette" data-role="gallery-modal-palette"></div>
            </div>
            <a class="no-gallery-btn" data-role="gallery-modal-open-file" target="_blank" rel="noreferrer">Open File</a>
          </footer>
        </article>
      </div>
    </section>
  `;

  const els = {
    grid: root.querySelector("[data-role='gallery-grid']"),
    refresh: root.querySelector("[data-role='gallery-refresh']"),
    modal: root.querySelector("[data-role='gallery-modal']"),
    modalTitle: root.querySelector("[data-role='gallery-modal-title']"),
    modalMedia: root.querySelector("[data-role='gallery-modal-media']"),
    modalSign: root.querySelector("[data-role='gallery-modal-sign']"),
    modalPalette: root.querySelector("[data-role='gallery-modal-palette']"),
    modalOpenFile: root.querySelector("[data-role='gallery-modal-open-file']"),
  };

  const state = {
    items: [],
    loading: false,
    activeItemId: null,
    paletteHydratePass: 0,
  };

  function closeModal() {
    if (!els.modal) return;
    state.activeItemId = null;
    els.modal.hidden = true;
    if (els.modalMedia) {
      els.modalMedia.removeAttribute("src");
    }
  }

  function openModal(item) {
    if (!els.modal || !els.modalMedia || !item) return;
    const mediaUrl = mediaUrlOf(item);
    const label = item.label || `No-Studio #${Number(item.tokenId) || 0}`;
    const signature = signatureOf(item);
    const palette = paletteOf(item);
    els.modalTitle.textContent = `${label} · ${mediaTypeOf(item).toUpperCase()}`;
    els.modalMedia.src = mediaUrl;
    els.modalMedia.alt = label;
    els.modalSign.textContent = signature;
    els.modalSign.classList.toggle("is-empty", !signature);
    if (els.modalPalette) {
      els.modalPalette.innerHTML = palette.length
        ? paletteSwatchesMarkup(palette)
        : "";
      els.modalPalette.classList.toggle("is-empty", !palette.length);
    }
    els.modalOpenFile.href = item.viewUrl || mediaUrl;
    state.activeItemId = String(item.id || "");
    els.modal.hidden = false;
  }

  function render() {
    if (!els.grid) return;
    if (state.loading && !state.items.length) {
      els.grid.innerHTML = `<div class="no-gallery-empty">Loading No-Gallery...</div>`;
      return;
    }
    if (!state.items.length) {
      els.grid.innerHTML = `<div class="no-gallery-empty">No curations saved yet.</div>`;
      return;
    }
    els.grid.innerHTML = state.items.map((item) => buildCardMarkup(item)).join("");
    hydrateCardPalettes();
  }

  async function hydrateCardPalettes() {
    if (!els.grid) return;
    const pass = ++state.paletteHydratePass;
    const cards = [...els.grid.querySelectorAll("[data-gallery-open]")];
    for (const card of cards) {
      if (pass !== state.paletteHydratePass) return;
      const id = String(card.getAttribute("data-gallery-open") || "");
      const item = state.items.find((entry) => String(entry?.id || "") === id);
      if (!item) continue;
      const existing = paletteOf(item);
      if (existing.length > 2) continue;
      const mediaUrl = mediaUrlOf(item);
      const inferred = await extractPaletteFromMedia(mediaUrl, 16);
      if (pass !== state.paletteHydratePass) return;
      if (!inferred.length || inferred.length <= existing.length) continue;
      item.palette = inferred;
      const meta = card.querySelector(".no-gallery-card-meta");
      if (!meta) continue;
      const oldStrip = meta.querySelector(".no-gallery-palette-strip");
      const markup = paletteSwatchesMarkup(inferred, 8);
      if (oldStrip) {
        oldStrip.outerHTML = markup;
      } else if (markup) {
        meta.insertAdjacentHTML("beforeend", markup);
      }
    }
  }

  async function loadGallery() {
    state.loading = true;
    render();
    try {
      const payload = await listNoStudioGallery({ limit: 120 });
      state.items = Array.isArray(payload?.items) ? payload.items : [];
    } catch (error) {
      state.items = [];
      if (els.grid) {
        els.grid.innerHTML = `<div class="no-gallery-empty">${escapeHtml(error.message || "No-Gallery unavailable")}</div>`;
      }
      state.loading = false;
      return;
    }
    state.loading = false;
    render();
  }

  function onGridClick(event) {
    const card = event.target.closest("[data-gallery-open]");
    if (!card) return;
    const id = card.getAttribute("data-gallery-open");
    const item = state.items.find((entry) => String(entry.id) === String(id));
    if (!item) return;
    openModal(item);
  }

  function onModalClick(event) {
    const closeTarget = event.target.closest("[data-role='gallery-modal-close']");
    if (!closeTarget) return;
    event.preventDefault();
    closeModal();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      closeModal();
    }
  }

  els.grid?.addEventListener("click", onGridClick);
  els.refresh?.addEventListener("click", loadGallery);
  els.modal?.addEventListener("click", onModalClick);
  document.addEventListener("keydown", onKeyDown);
  closeModal();

  loadGallery();

  return () => {
    els.grid?.removeEventListener("click", onGridClick);
    els.refresh?.removeEventListener("click", loadGallery);
    els.modal?.removeEventListener("click", onModalClick);
    document.removeEventListener("keydown", onKeyDown);
  };
}
