// no-studio-template.js — HTML template for No-Studio tool

export function createStudioTemplate({ subdivisions, defaultToneStep }) {
  const subdivBtns = subdivisions.map((s) =>
    `<button class="topbar-btn${s.value === 1 ? " is-active" : ""}" data-subdiv="${s.value}">${s.label}</button>`
  ).join("");

  return `
    <div class="studio" data-role="studio">
      <!-- Toolbar -->
      <div class="studio-toolbar">
        <button class="tool-btn is-active" data-tool="pointer" data-tool-label="Pointer" data-tool-key="V" title="Pointer (V)" aria-label="Pointer">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2l10 6-5 1-2 5z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
        </button>
        <button class="tool-btn" data-tool="paint" data-tool-label="Paint" data-tool-key="B" title="Paint (B)" aria-label="Paint">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="6" y="2" width="4" height="10" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M6 12h4v2H6z" fill="currentColor"/></svg>
        </button>
        <button class="tool-btn" data-tool="fill" data-tool-label="Fill Block" data-tool-key="G" title="Fill Block (G)" aria-label="Fill Block">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" opacity=".3"/></svg>
        </button>
        <button class="tool-btn" data-tool="eyedropper" data-tool-label="Eyedropper" data-tool-key="I" title="Eyedropper (I)" aria-label="Eyedropper">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 2l2 2-8 8-3 1 1-3z" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <div class="toolbar-sep"></div>
        <button class="tool-btn" data-tool="zoom-in" data-tool-label="Zoom In" data-tool-key="+" title="Zoom In" aria-label="Zoom In">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5"/><path d="M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
        <button class="tool-btn" data-tool="zoom-out" data-tool-label="Zoom Out" data-tool-key="-" title="Zoom Out" aria-label="Zoom Out">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.5"/><path d="M5 7h4" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
        <div class="toolbar-readout" data-role="tool-readout">
          <span class="toolbar-readout-label" data-role="tool-readout-label">Pointer</span>
          <span class="toolbar-readout-key" data-role="tool-readout-key">V</span>
        </div>
      </div>

      <!-- Topbar -->
      <div class="studio-topbar">
        <div class="topbar-brandlock">
          <span class="topbar-kicker">Noir de Noir</span>
          <span class="topbar-brand">NO-STUDIO</span>
          <span class="topbar-brand-note">Original source. Studio-grade casts.</span>
        </div>
        <div class="topbar-sep"></div>
        <div class="topbar-group topbar-group--grid">
          <span class="topbar-label">Grid</span>
          ${subdivBtns}
        </div>
        <div class="topbar-sep"></div>
        <div class="topbar-group topbar-group--history">
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
              <strong>Load a punk. Cast a world. Keep the good ones.</strong>
              <span class="canvas-empty-copy">Start with No-Minimalism, then cast Mono, Noir, Pop, Acid or Pastel from the original source. Save only the pieces worth keeping.</span>
            </div>
          </div>
          <div class="canvas-stage-foot">
            <span class="canvas-stage-chip">24\u00d724 truth</span>
            <span class="canvas-stage-chip">Twin-lift logic</span>
            <span class="canvas-stage-chip">Trait-first reduction</span>
          </div>
        </div>
      </div>

      <button class="mobile-dock-toggle" type="button" data-role="mobile-dock-toggle" aria-expanded="false">
        Open Studio Deck
      </button>

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
          <p class="sidebar-hero-copy">Every render starts from the original 24×24 punk. Keep the twin-lift intact, push the palette with intent, and save only the finished compositions.</p>
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
          <div class="sidebar-heading">Studio Deck <span style="font-weight:400;color:var(--text-dim);font-size:10px" data-role="preset-grid-label">(grid: 1x1)</span></div>
          <div class="mini-note">Every cast re-renders from the loaded punk. No stacked drift. No hidden palette carry-over.</div>
          <div class="studio-hero-actions">
            <button class="preset-btn preset-btn--hero" type="button" data-role="surprise-btn">Cast</button>
            <button class="preset-btn preset-btn--signature" type="button" data-role="hero-no-minimal">No-Minimalism</button>
          </div>
          <button class="preset-btn preset-btn--gallery" type="button" data-role="save-gallery" disabled>Save To No-Gallery</button>
          <div class="role-pair-readout hero-role-pair" data-role="hero-role-pair"></div>
          <div class="preset-tabs">
            <button class="preset-tab is-active" data-preset-tab="mono">Mono</button>
            <button class="preset-tab" data-preset-tab="noir">Noir</button>
            <button class="preset-tab" data-preset-tab="warhol">Pop</button>
            <button class="preset-tab" data-preset-tab="acid">Acid</button>
            <button class="preset-tab" data-preset-tab="pastel">Pastel</button>
          </div>
          <details class="dock-advanced" data-role="dock-advanced">
            <summary class="dock-advanced-summary">Studio Modifiers</summary>
            <div class="dock-advanced-body">
              <div class="theory-rail program-rail" data-role="program-rail">
                <button class="theory-btn" type="button" data-program="monolith">Monolith</button>
                <button class="theory-btn" type="button" data-program="veil">Veil</button>
                <button class="theory-btn" type="button" data-program="poster">Poster</button>
                <button class="theory-btn" type="button" data-program="signal">Signal</button>
              </div>
              <div class="color-slider-row">
                <span class="color-slider-label">\u0394</span>
                <input type="range" class="color-slider" data-role="tone-step-slider" min="1" max="24" value="${defaultToneStep}" />
                <span class="color-slider-value" data-role="tone-step-value">${defaultToneStep}</span>
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
              <button class="preset-btn" type="button" data-role="active-bg-toggle">Active BG for Pop \u00b7 Off</button>
              <div class="sidebar-heading" style="margin-top:10px;font-size:10px">Finish Grain</div>
              <div class="mini-note">Presentation-scale grain at 1024. The 24\u00d724 source never changes.</div>
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

        <!-- Export -->
        <div class="sidebar-section">
          <div class="sidebar-heading">Quick Export</div>
          <button class="export-btn export-btn--full" data-role="export-gif" disabled>GIF 1s \u00b7 Animated Grain</button>
          <div class="export-row">
            <button class="export-btn" data-role="export-png" disabled>PNG 1024</button>
            <button class="export-btn" data-role="export-reset" disabled>Reset</button>
          </div>
        </div>

        <div class="sidebar-section" data-role="gallery-section">
          <div class="gallery-head">
            <div class="sidebar-heading" style="margin-bottom:0">No-Gallery</div>
            <button class="gallery-refresh" type="button" data-role="gallery-refresh">Refresh</button>
          </div>
          <div class="mini-note">Only pieces you explicitly save land here. Anyone on this studio can browse the saved wall.</div>
          <div class="gallery-list" data-role="gallery-list">
            <div class="gallery-empty">No compositions saved yet.</div>
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
        <div class="status-item" data-role="status-role">\u2014</div>
      </div>
    </div>
  `;
}
