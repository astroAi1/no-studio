import {
  getNoStudioGalleryHome,
  getNoStudioGalleryWeek,
  voteNoStudioGallery,
} from "../api.js";

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
  return String(item?.signatureHandle || item?.signature || item?.twitterHandle || "").trim();
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
  return out;
}

function paletteSwatchesMarkup(palette, limit = 8) {
  if (!palette.length) return "";
  const preview = palette.slice(0, limit);
  const remaining = Math.max(0, palette.length - preview.length);
  return `
    <span class="no-gallery-palette-strip">
      ${preview.map((hex) => `<span class="no-gallery-palette-swatch" style="background:${escapeHtml(hex)}" title="${escapeHtml(hex)}"></span>`).join("")}
      ${remaining ? `<span class="no-gallery-palette-more">+${remaining}</span>` : ""}
    </span>
  `;
}

function reactionLabel(item) {
  const noCount = Number(item?.noCount ?? item?.voteCount) || 0;
  const yesCount = Number(item?.yesCount) || 0;
  return `NO ${noCount} · YES ${yesCount}`;
}

function buildReactionMarkup(item, storage = "sqlite") {
  const reaction = String(item?.viewerReaction || "").trim().toLowerCase();
  const disabled = storage !== "sqlite" && storage !== "browser";
  const locked = String(item?.weekState || "live") === "archived";
  return `
    <div class="no-gallery-reactions">
      <button
        class="no-gallery-react-btn${reaction === "no" ? " is-active" : ""}"
        type="button"
        data-react-id="${escapeHtml(item?.id || "")}"
        data-reaction="no"
        ${disabled || locked ? "disabled" : ""}
      >NO</button>
      <button
        class="no-gallery-react-btn${reaction === "yes" ? " is-active" : ""}"
        type="button"
        data-react-id="${escapeHtml(item?.id || "")}"
        data-reaction="yes"
        ${disabled || locked ? "disabled" : ""}
      >YES</button>
    </div>
  `;
}

function buildLiveCardMarkup(item, storage = "sqlite") {
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
  const stateLine = String(item?.viewerReaction || "").trim()
    ? `You chose ${String(item.viewerReaction).toUpperCase()}`
    : reactionLabel(item);
  return `
    <article class="no-gallery-card-shell">
      <a class="no-gallery-card" href="${escapeHtml(item?.viewUrl || mediaUrl || "#")}" target="_blank" rel="noreferrer">
        <img class="no-gallery-card-media" src="${escapeHtml(mediaUrl)}" alt="${escapeHtml(label)}" loading="lazy" />
        <span class="no-gallery-card-meta">
          <strong class="no-gallery-card-title">${escapeHtml(label)}</strong>
          <span class="no-gallery-card-sub">#${Number(item?.tokenId) || 0} · ${(item?.family || "studio").toUpperCase()} · ${mediaType.toUpperCase()}</span>
          <span class="no-gallery-card-sub">${pair}</span>
          <span class="no-gallery-card-sub">${escapeHtml(stateLine)}</span>
          ${paletteSwatchesMarkup(palette)}
          ${signature ? `<span class="no-gallery-card-sign">${escapeHtml(signature)}</span>` : ""}
        </span>
      </a>
      <div class="no-gallery-card-foot">
        ${buildReactionMarkup(item, storage)}
      </div>
    </article>
  `;
}

function buildArchiveCoverMarkup(week) {
  const covers = Array.isArray(week?.coverEntries) ? week.coverEntries.slice(0, 9) : [];
  if (!covers.length) {
    return `<div class="no-gallery-week-cover-empty">No cover</div>`;
  }
  return `
    <div class="no-gallery-week-cover-grid">
      ${covers.map((item) => `<img class="no-gallery-week-cover-tile" src="${escapeHtml(mediaUrlOf(item))}" alt="" loading="lazy" />`).join("")}
    </div>
  `;
}

function buildArchiveCardMarkup(week) {
  const startedAt = week?.startedAt ? new Date(week.startedAt).toLocaleDateString() : "Unknown";
  const endsAt = week?.endsAt ? new Date(week.endsAt).toLocaleDateString() : "Unknown";
  return `
    <button class="no-gallery-week-card" type="button" data-open-week="${escapeHtml(week?.weekId || "")}">
      <span class="no-gallery-week-cover">
        ${buildArchiveCoverMarkup(week)}
      </span>
      <span class="no-gallery-week-meta">
        <strong>Week ${escapeHtml(startedAt)} → ${escapeHtml(endsAt)}</strong>
        <span>${Number(week?.entryCount) || 0} curations</span>
        <span>Top NO ${Number(week?.topNoCount) || 0}</span>
      </span>
    </button>
  `;
}

function renderSortRail(sort = "new") {
  return `
    <div class="theory-rail no-gallery-sort-rail" data-role="gallery-sort-rail">
      <button class="theory-btn${sort === "new" ? " is-active" : ""}" type="button" data-sort="new">New</button>
      <button class="theory-btn${sort === "top" ? " is-active" : ""}" type="button" data-sort="top">Top</button>
    </div>
  `;
}

export function mountNoGalleryPage(root) {
  root.innerHTML = `
    <section class="no-gallery-page" data-role="no-gallery-page">
      <header class="no-gallery-topbar">
        <div class="no-gallery-brand">
          <span class="no-gallery-kicker">Noir de Noir</span>
          <h1 class="no-gallery-title">No-Gallery</h1>
          <p class="no-gallery-note">Live week on top. Archived weeks below. NO is the good vote here.</p>
        </div>
        <div class="no-gallery-actions">
          ${renderSortRail("new")}
          <a class="no-gallery-btn" href="/tools/no-studio">Back To Studio</a>
          <button class="no-gallery-btn" type="button" data-role="gallery-refresh">Refresh</button>
        </div>
      </header>
      <main class="no-gallery-grid-shell">
        <section class="no-gallery-section">
          <div class="no-gallery-section-head">
            <div>
              <p class="no-gallery-section-kicker">Live</p>
              <h2 class="no-gallery-section-title" data-role="live-week-title">This Week</h2>
            </div>
            <button class="no-gallery-btn" type="button" data-role="back-home" hidden>Back To Archive</button>
          </div>
          <div class="no-gallery-grid" data-role="live-grid">
            <div class="no-gallery-empty">Loading No-Gallery...</div>
          </div>
        </section>
        <section class="no-gallery-section" data-role="archive-section">
          <div class="no-gallery-section-head">
            <div>
              <p class="no-gallery-section-kicker">Archive</p>
              <h2 class="no-gallery-section-title">Past Weeks</h2>
            </div>
          </div>
          <div class="no-gallery-archive-grid" data-role="archive-grid"></div>
        </section>
      </main>
    </section>
  `;

  const els = {
    liveGrid: root.querySelector("[data-role='live-grid']"),
    archiveGrid: root.querySelector("[data-role='archive-grid']"),
    refresh: root.querySelector("[data-role='gallery-refresh']"),
    sortRail: root.querySelector("[data-role='gallery-sort-rail']"),
    backHome: root.querySelector("[data-role='back-home']"),
    archiveSection: root.querySelector("[data-role='archive-section']"),
    liveWeekTitle: root.querySelector("[data-role='live-week-title']"),
  };

  const state = {
    storage: "sqlite",
    mode: "home",
    sort: "new",
    home: null,
    week: null,
    loading: false,
  };

  function currentItems() {
    if (state.mode === "week" && state.week?.items) return state.week.items;
    return state.home?.liveWeek?.items || [];
  }

  function render() {
    if (els.sortRail) {
      els.sortRail.querySelectorAll("[data-sort]").forEach((button) => {
        button.classList.toggle("is-active", button.getAttribute("data-sort") === state.sort);
      });
    }
    if (state.loading && !state.home && !state.week) {
      if (els.liveGrid) els.liveGrid.innerHTML = `<div class="no-gallery-empty">Loading No-Gallery...</div>`;
      if (els.archiveGrid) els.archiveGrid.innerHTML = "";
      return;
    }

    if (state.mode === "week" && state.week?.week) {
      const week = state.week.week;
      if (els.liveWeekTitle) {
        const started = week.startedAt ? new Date(week.startedAt).toLocaleDateString() : "Unknown";
        const ended = week.endsAt ? new Date(week.endsAt).toLocaleDateString() : "Unknown";
        els.liveWeekTitle.textContent = `Week ${started} → ${ended}`;
      }
      if (els.backHome) els.backHome.hidden = false;
      if (els.archiveSection) els.archiveSection.hidden = true;
      const items = Array.isArray(state.week.items) ? state.week.items : [];
      if (els.liveGrid) {
        els.liveGrid.innerHTML = items.length
          ? items.map((item) => buildLiveCardMarkup(item, state.storage)).join("")
          : `<div class="no-gallery-empty">No curations in this week.</div>`;
      }
      return;
    }

    if (els.backHome) els.backHome.hidden = true;
    if (els.archiveSection) els.archiveSection.hidden = false;
    const liveWeek = state.home?.liveWeek || null;
    const liveItems = Array.isArray(liveWeek?.items) ? liveWeek.items : [];
    if (els.liveWeekTitle) {
      els.liveWeekTitle.textContent = liveWeek ? "This Week" : "No Live Week Yet";
    }
    if (els.liveGrid) {
      els.liveGrid.innerHTML = liveItems.length
        ? liveItems.map((item) => buildLiveCardMarkup(item, state.storage)).join("")
        : `<div class="no-gallery-empty">No live week yet. The next curation starts it.</div>`;
    }
    const archives = Array.isArray(state.home?.archives) ? state.home.archives : [];
    if (els.archiveGrid) {
      els.archiveGrid.innerHTML = archives.length
        ? archives.map((week) => buildArchiveCardMarkup(week)).join("")
        : `<div class="no-gallery-empty">No archived weeks yet.</div>`;
    }
  }

  async function loadHome() {
    state.loading = true;
    state.mode = "home";
    render();
    try {
      const payload = await getNoStudioGalleryHome({ sort: state.sort, liveLimit: 120, archiveLimit: 24 });
      state.home = payload;
      state.week = null;
      state.storage = String(payload?.storage || "sqlite");
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadWeek(weekId) {
    state.loading = true;
    render();
    try {
      const payload = await getNoStudioGalleryWeek(weekId, { sort: state.sort, limit: 120 });
      state.week = payload;
      state.mode = "week";
      state.storage = String(payload?.storage || state.home?.storage || "sqlite");
    } finally {
      state.loading = false;
      render();
    }
  }

  function replaceItem(nextItem) {
    if (!nextItem) return;
    if (state.home?.liveWeek?.items) {
      state.home.liveWeek.items = state.home.liveWeek.items.map((item) => String(item?.id || "") === String(nextItem.id) ? { ...item, ...nextItem } : item);
    }
    if (state.week?.items) {
      state.week.items = state.week.items.map((item) => String(item?.id || "") === String(nextItem.id) ? { ...item, ...nextItem } : item);
    }
    render();
  }

  root.addEventListener("click", async (event) => {
    const archiveButton = event.target.closest("[data-open-week]");
    if (archiveButton) {
      event.preventDefault();
      const weekId = String(archiveButton.getAttribute("data-open-week") || "");
      if (weekId) {
        await loadWeek(weekId);
      }
      return;
    }

    const reactionButton = event.target.closest("[data-react-id][data-reaction]");
    if (reactionButton) {
      event.preventDefault();
      const id = String(reactionButton.getAttribute("data-react-id") || "");
      const reaction = String(reactionButton.getAttribute("data-reaction") || "no");
      if (!id) return;
      const payload = await voteNoStudioGallery(id, reaction);
      replaceItem(payload?.item || null);
      return;
    }
  });

  els.refresh?.addEventListener("click", () => {
    if (state.mode === "week" && state.week?.week?.weekId) {
      loadWeek(state.week.week.weekId);
      return;
    }
    loadHome();
  });

  els.backHome?.addEventListener("click", () => {
    loadHome();
  });

  els.sortRail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (!button) return;
    const nextSort = button.getAttribute("data-sort") === "top" ? "top" : "new";
    if (nextSort === state.sort) return;
    state.sort = nextSort;
    if (state.mode === "week" && state.week?.week?.weekId) {
      loadWeek(state.week.week.weekId);
      return;
    }
    loadHome();
  });

  loadHome();

  return () => {};
}
