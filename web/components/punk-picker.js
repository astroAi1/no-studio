import { searchPunks } from "../api.js";

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

export function mountPunkPicker(root, options) {
  const config = {
    title: "Find NoPunks",
    subtitle: "Search by id, type, or trait",
    placeholder: "Search by id, type, trait…",
    multi: false,
    autoSelectFirst: false,
    maxResults: 24,
    getSelectedIds: () => [],
    onPick: () => {},
    ...options,
  };

  root.innerHTML = `
    <section class="panel tool-panel picker-shell">
      <div class="panel-head">
        <div>
          <p class="micro-label">Source Picker</p>
          <h3 class="panel-title">${escapeHtml(config.title)}</h3>
          <p class="panel-subtle">${escapeHtml(config.subtitle)}</p>
        </div>
        <p class="picker-status" data-role="status">Loading…</p>
      </div>
      <form class="picker-search" data-role="form" autocomplete="off">
        <label class="sr-only" for="punk-picker-input">Search NoPunks</label>
        <input id="punk-picker-input" name="punk-search" data-role="input" type="search" placeholder="${escapeHtml(config.placeholder)}" spellcheck="false" autocomplete="off" />
        <button class="chip-btn" data-role="submit" type="submit">Search</button>
      </form>
      <div class="picker-results" data-role="results"></div>
    </section>
  `;

  const statusEl = root.querySelector('[data-role="status"]');
  const formEl = root.querySelector('[data-role="form"]');
  const inputEl = root.querySelector('[data-role="input"]');
  const resultsEl = root.querySelector('[data-role="results"]');

  let disposed = false;
  let lastResults = [];
  let searchToken = 0;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function renderResults(items) {
    const selectedIds = new Set((config.getSelectedIds() || []).map(Number));
    if (!items.length) {
      resultsEl.innerHTML = `
      <div class="picker-empty">
          <strong>No matches</strong>
          <span>Try #7804, alien, pipe.</span>
        </div>
      `;
      return;
    }

    resultsEl.innerHTML = items.map((item) => {
      const selected = selectedIds.has(Number(item.id));
      const atlas = item.previewAtlas;
      const thumb = atlas
        ? (() => {
            const scale = 28 / Number(atlas.tileSize || 24);
            const bgWidth = Math.round(Number(atlas.atlasWidth || 2400) * scale);
            const bgHeight = Math.round(Number(atlas.atlasHeight || 2400) * scale);
            const posX = Math.round(Number(atlas.x || 0) * scale) * -1;
            const posY = Math.round(Number(atlas.y || 0) * scale) * -1;
            return `<span class="picker-thumb" aria-hidden="true" style="background-image:url('${escapeHtml(atlas.url)}');background-size:${bgWidth}px ${bgHeight}px;background-position:${posX}px ${posY}px;"></span>`;
          })()
        : `<img class="picker-thumb" src="${item.previewUrl}" alt="" loading="lazy" decoding="async" />`;
      return `
        <button type="button" class="picker-result${selected ? " is-selected" : ""}" data-id="${item.id}">
          ${thumb}
          <span class="picker-copy">
            <strong>${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(item.traitSummary || item.type || "")}</small>
          </span>
          <span class="picker-id">#${item.id}</span>
        </button>
      `;
    }).join("");
  }

  async function runSearch(query) {
    const token = ++searchToken;
    const q = String(query || "").trim();
    setStatus(q ? `Searching "${q}"…` : "Loading…");
    try {
      const payload = await searchPunks(q, config.maxResults);
      if (disposed || token !== searchToken) return;
      lastResults = payload.items || [];
      renderResults(lastResults);
      setStatus(`${payload.count} result${payload.count === 1 ? "" : "s"}${q ? ` · "${q}"` : ""}`);

      if (config.autoSelectFirst && !(config.getSelectedIds() || []).length && lastResults[0]) {
        config.onPick(lastResults[0]);
      }
    } catch (error) {
      if (disposed || token !== searchToken) return;
      setStatus(error.message || "Search failed");
      const detail = error && error.url ? `${error.url}` : "Search API error";
      resultsEl.innerHTML = `
        <div class="picker-empty">
          <strong>Search failed</strong>
          <span>${escapeHtml(error.message || "Unknown error")}</span>
          <span>${escapeHtml(detail)}</span>
        </div>
      `;
    }
  }

  const debouncedSearch = debounce(() => runSearch(inputEl.value), 160);

  function onSubmit(event) {
    event.preventDefault();
    runSearch(inputEl.value);
  }

  function onClick(event) {
    const button = event.target.closest("[data-id]");
    if (!button) return;
    const id = Number.parseInt(button.getAttribute("data-id"), 10);
    if (!Number.isFinite(id)) return;
    const item = lastResults.find((entry) => Number(entry.id) === id);
    if (!item) return;
    config.onPick(item);
  }

  formEl.addEventListener("submit", onSubmit);
  inputEl.addEventListener("input", debouncedSearch);
  resultsEl.addEventListener("click", onClick);

  runSearch("");

  return {
    refreshSelection() {
      renderResults(lastResults);
    },
    setMode(nextMode) {
      config.multi = nextMode === "multi";
      renderResults(lastResults);
    },
    setAutoSelectFirst(value) {
      config.autoSelectFirst = Boolean(value);
    },
    focus() {
      inputEl.focus();
    },
    destroy() {
      disposed = true;
      formEl.removeEventListener("submit", onSubmit);
      inputEl.removeEventListener("input", debouncedSearch);
      resultsEl.removeEventListener("click", onClick);
      root.innerHTML = "";
    },
  };
}
