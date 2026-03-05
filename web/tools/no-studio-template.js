// no-studio-template.js — HTML template for No-Studio tool

export function createStudioTemplate() {
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
          <p class="sidebar-hero-copy">Every render starts from the original.</p>
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
          <div class="palette-curation">
            <div class="palette-curation-readout" data-role="palette-curation-readout">
              Pick a source swatch, then map it to your active color.
            </div>
            <div class="palette-curation-actions">
              <button class="preset-btn" type="button" data-role="curation-map-active">Map Active</button>
              <button class="preset-btn" type="button" data-role="curation-clear-mapping">Clear Map</button>
            </div>
            <div class="palette-curation-actions">
              <button class="preset-btn preset-btn--hero" type="button" data-role="curation-apply">Apply Curated Palette</button>
              <button class="preset-btn" type="button" data-role="curation-reset-all">Reset Curation</button>
            </div>
          </div>
        </div>

        <!-- Studio Dock -->
        <div class="sidebar-section studio-dock-section" data-role="studio-dock-section">
          <div class="sidebar-heading">Studio Deck</div>
          <span class="deck-family-kicker" data-role="deck-family-kicker">Mono</span>
          <div class="studio-hero-actions">
            <button class="preset-btn preset-btn--hero" type="button" data-role="surprise-btn" title="Machine-random family and cast from original source">Cast</button>
            <button class="preset-btn preset-btn--signature" type="button" data-role="hero-no-minimal" title="Reduce the punk to just 2 tones: a background colour and a near-identical outline. The signature NoPunks look.">No-Minimalism</button>
          </div>
          <label class="gallery-signature-field" for="gallery-signature-input">
            <span class="gallery-signature-label">Sign (optional)</span>
            <input id="gallery-signature-input" name="gallery_signature" class="gallery-signature-input" data-role="gallery-signature" type="text" placeholder="@yourhandle" maxlength="16" autocomplete="off" />
          </label>
          <div class="gallery-save-actions">
            <button class="preset-btn preset-btn--gallery" type="button" data-role="save-gallery-png" disabled>Save PNG To No-Gallery</button>
            <button class="preset-btn preset-btn--gallery" type="button" data-role="save-gallery-gif" disabled>Save GIF To No-Gallery</button>
            <a class="preset-btn preset-btn--gallery-link" data-role="open-gallery-link" href="/tools/no-gallery">Open No-Gallery</a>
          </div>
          <div class="role-pair-readout hero-role-pair" data-role="hero-role-pair"></div>
          <div class="deck-palette-label">Palette family</div>
          <div class="preset-tabs">
            <button class="preset-tab is-active" data-preset-tab="mono" title="Single-hue tonal range. Clean and restrained.">Mono</button>
            <button class="preset-tab" data-preset-tab="noir" title="Dark-first palette. Deep shadows, minimal highlights.">Noir</button>
            <button class="preset-tab" data-preset-tab="warhol" title="Bold graphic colour. Warhol-pop palette.">Pop</button>
            <button class="preset-tab" data-preset-tab="acid" title="High-contrast synthetic hues. Uncomfortable and sharp.">Acid</button>
            <button class="preset-tab" data-preset-tab="pastel" title="Soft powder tones. Gentle, light, low contrast.">Pastel</button>
          </div>
          <details class="dock-advanced" data-role="dock-advanced">
            <summary class="dock-advanced-summary">Studio Modifiers</summary>
            <div class="dock-advanced-body">
              <div class="modifier-group">
                <div class="dock-sub-heading">Global</div>
                <div class="mini-note">These apply in fixed order to every family pass.</div>
                <div class="color-slider-row">
                  <span class="color-slider-label">Tone</span>
                  <input type="range" class="color-slider" data-role="global-tone-count" min="2" max="8" value="5" />
                  <span class="color-slider-value" data-role="global-tone-count-value">5</span>
                </div>
                <div class="color-slider-row">
                  <span class="color-slider-label">Cont</span>
                  <input type="range" class="color-slider" data-role="global-contrast" min="0" max="100" value="62" />
                  <span class="color-slider-value" data-role="global-contrast-value">62%</span>
                </div>
                <div class="color-slider-row">
                  <span class="color-slider-label">Trait</span>
                  <input type="range" class="color-slider" data-role="global-trait-focus" min="0" max="100" value="54" />
                  <span class="color-slider-value" data-role="global-trait-focus-value">54%</span>
                </div>
                <div class="color-slider-row">
                  <span class="color-slider-label">Drift</span>
                  <input type="range" class="color-slider" data-role="global-palette-drift" min="0" max="100" value="28" />
                  <span class="color-slider-value" data-role="global-palette-drift-value">28%</span>
                </div>
                <div class="dock-sub-heading">Twin Lift</div>
                <div class="mini-note">Outline tracking mode. Exact = fixed offset. Soft = drift. Hard = max separation.</div>
                <div class="theory-rail" data-role="no-minimal-mode-rail">
                  <button class="theory-btn is-active" type="button" data-minimal-mode="exact">Exact</button>
                  <button class="theory-btn" type="button" data-minimal-mode="soft">Soft</button>
                  <button class="theory-btn" type="button" data-minimal-mode="hard">Hard</button>
                </div>
              </div>
              <div class="modifier-divider"></div>
              <div class="modifier-group">
                <div class="dock-sub-heading">Family Specific</div>
                <div class="mini-note">Each family has two dedicated controls that affect unique stages.</div>
                <div data-role="family-modifiers-panel"></div>
              </div>
              <div class="modifier-divider"></div>
              <div class="modifier-group">
                <div class="dock-sub-heading">Finish</div>
                <div class="mini-note">Film-like grain on the 1024px export. The 24\u00d724 source stays clean.</div>
                <div class="theory-rail noise-target-rail" data-role="noise-target-rail">
                  <button class="theory-btn is-active" type="button" data-noise-target="background" title="Grain on background only">BG</button>
                  <button class="theory-btn" type="button" data-noise-target="active" title="Grain on the outline band">Band</button>
                  <button class="theory-btn" type="button" data-noise-target="figure" title="Grain on the punk figure">Figure</button>
                </div>
                <div class="color-slider-row">
                  <span class="color-slider-label">N</span>
                  <input type="range" class="color-slider" data-role="noise-amount" min="0" max="100" value="28" />
                  <span class="color-slider-value" data-role="noise-amount-value">28%</span>
                </div>
                <button class="export-btn export-btn--full" data-role="apply-noise">Apply Grain</button>
              </div>
              <button class="preset-btn" type="button" data-role="active-bg-toggle">Use Active Color As Background \u00b7 Off</button>
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
            <div class="gallery-head-actions">
              <button class="gallery-refresh" type="button" data-role="gallery-refresh">Refresh</button>
              <a class="gallery-open-link" href="/tools/no-gallery">Open</a>
            </div>
          </div>
          <div class="gallery-list" data-role="gallery-list">
            <div class="gallery-empty">Cast something worth keeping, then save it here.</div>
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
