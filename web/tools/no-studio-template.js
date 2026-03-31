export function createStudioTemplate() {
  return `
    <div class="studio" data-role="studio">
      <div class="studio-toolbar">
        <button class="tool-btn is-active" data-tool="pointer" data-tool-label="Pointer" data-tool-key="V" title="Pointer (V)" aria-label="Pointer">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2l10 6-5 1-2 5z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
        </button>
        <button class="tool-btn" data-tool="paint" data-tool-label="Brush" data-tool-key="B" title="Brush (B)" aria-label="Brush">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5 11l3-7 3 7" stroke="currentColor" stroke-width="1.5"/><path d="M4 12h8" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <button class="tool-btn" data-tool="fill" data-tool-label="Fill" data-tool-key="G" title="Fill (G)" aria-label="Fill">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 3h8v5l-4 5-4-5z" stroke="currentColor" stroke-width="1.5"/><path d="M4 11h8" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <button class="tool-btn" data-tool="eyedropper" data-tool-label="Eyedropper" data-tool-key="I" title="Eyedropper (I)" aria-label="Eyedropper">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 2l2 2-8 8-3 1 1-3z" stroke="currentColor" stroke-width="1.5"/></svg>
        </button>
        <div class="toolbar-sep"></div>
        <button class="tool-btn" data-tool="noise-paint" data-tool-label="Noise Paint" data-tool-key="N" title="Noise Paint (N)" aria-label="Noise Paint">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="5" cy="5" r="1.2" fill="currentColor"/><circle cx="10.5" cy="4.5" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="4.5" cy="10.5" r="1" fill="currentColor"/><circle cx="11" cy="11" r="1.2" fill="currentColor"/></svg>
        </button>
        <button class="tool-btn" data-tool="noise-erase" data-tool-label="Noise Erase" data-tool-key="E" title="Noise Erase (E)" aria-label="Noise Erase">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="5" r="1.1" fill="currentColor"/><circle cx="11" cy="5" r="1.1" fill="currentColor"/><circle cx="8" cy="10.5" r="1.1" fill="currentColor"/></svg>
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

      <div class="studio-topbar">
        <div class="topbar-brandlock">
          <span class="topbar-kicker">NoPunks HQ</span>
          <span class="topbar-brand">NO-STUDIO</span>
          <span class="topbar-brand-note">24×24 open canvas. One global role pair. Everything else is fair game.</span>
        </div>
        <div class="topbar-sep"></div>
        <div class="topbar-group topbar-group--history">
          <button class="topbar-btn" data-role="undo-btn" disabled>Undo</button>
          <button class="topbar-btn" data-role="redo-btn" disabled>Redo</button>
        </div>
        <span class="topbar-spacer"></span>
        <button class="topbar-btn sidebar-toggle" data-role="sidebar-toggle">Hide Studio Dock</button>
        <div class="topbar-status-shell">
          <span class="topbar-status-label">State</span>
          <span class="topbar-status" data-role="topbar-status"></span>
        </div>
      </div>

      <div class="studio-canvas" data-role="canvas-area">
        <div class="canvas-stage-shell">
          <div class="canvas-stage-head">
            <div class="canvas-stage-meta">
              <span class="canvas-stage-kicker">Creative Freedom</span>
              <span class="canvas-stage-title" data-role="stage-title">Open the grid. Keep the role rule.</span>
            </div>
            <div class="canvas-quickbar">
              <div class="canvas-quick-color">
                <span class="canvas-quick-label">Active</span>
                <div class="canvas-quick-swatch" data-role="stage-color-preview" style="background:#FFFFFF"></div>
                <input class="canvas-color-input" data-role="stage-color-input" type="color" value="#ffffff" aria-label="Quick color picker" />
                <input class="canvas-quick-hex" data-role="stage-color-hex" type="text" value="#FFFFFF" maxlength="7" spellcheck="false" autocomplete="off" />
                <button class="preset-btn canvas-quick-deck" type="button" data-role="open-dock-colors">Deck</button>
              </div>
              <div class="theory-rail canvas-quick-paint" data-role="stage-paint-target-rail">
                <button class="theory-btn is-active" type="button" data-paint-target="content">Content</button>
                <button class="theory-btn" type="button" data-paint-target="background">BG</button>
                <button class="theory-btn" type="button" data-paint-target="outline">OL</button>
                <button class="theory-btn" type="button" data-paint-target="erase">Erase</button>
              </div>
              <div class="theory-rail canvas-start-rail" data-role="start-mode-rail">
                <button class="theory-btn is-active" type="button" data-start-mode="full">Full</button>
                <button class="theory-btn" type="button" data-start-mode="silhouette">Silhouette</button>
                <button class="theory-btn" type="button" data-start-mode="blank">Blank</button>
              </div>
            </div>
          </div>
          <div class="canvas-stage-surface" data-role="canvas-stage-surface">
            <canvas data-role="display-canvas" width="600" height="600"></canvas>
            <div class="canvas-empty" data-role="canvas-empty">
              <span class="canvas-empty-kicker">No-Studio</span>
              <strong>Load a punk, then redraw the world around it.</strong>
              <span class="canvas-empty-copy">Paint new traits. Erase old ones. Recolor background and outline globally. Build effects with a manual noise mask and save the strong ones to No-Gallery.</span>
            </div>
          </div>
          <div class="canvas-stage-foot">
            <span class="canvas-stage-chip">24×24 truth</span>
            <span class="canvas-stage-chip">Open composition</span>
            <span class="canvas-stage-chip">Outline = background +4</span>
          </div>
        </div>
      </div>

      <button class="mobile-dock-toggle" type="button" data-role="mobile-dock-toggle" aria-expanded="false">
        Open Studio Dock
      </button>

      <div class="studio-dock-scrim" data-role="dock-scrim" aria-hidden="true"></div>

      <div class="studio-sidebar is-open" data-role="sidebar">
        <div class="sidebar-hero" data-role="sidebar-hero">
          <div class="sidebar-hero-head">
            <div class="sidebar-hero-copyblock">
              <span class="sidebar-hero-kicker">No-Studio v4</span>
              <strong class="sidebar-hero-title">Paint fast. Cast fast. Keep the good ones.</strong>
            </div>
            <button class="dock-dismiss" type="button" data-role="dock-dismiss" aria-label="Close studio dock">Close</button>
          </div>
          <p class="sidebar-hero-copy">The source is a start point. The grid is yours.</p>
        </div>

        <div class="sidebar-section" data-role="source-section">
          <div class="sidebar-heading">Create</div>
          <div class="studio-subheading">Source</div>
          <div data-role="picker-host"></div>
          <div class="palette-curation-actions">
            <button class="preset-btn" type="button" data-role="restore-last-session" hidden>Restore Last Session</button>
          </div>
          <div class="studio-subheading">Paint Target</div>
          <div class="theory-rail" data-role="paint-target-rail">
            <button class="theory-btn is-active" type="button" data-paint-target="content">Content</button>
            <button class="theory-btn" type="button" data-paint-target="background">Background</button>
            <button class="theory-btn" type="button" data-paint-target="outline">Outline</button>
            <button class="theory-btn" type="button" data-paint-target="erase">Erase</button>
          </div>
          <div class="mini-note">Background and outline always normalize back to the global +4 role pair.</div>
          <div class="role-pair-readout hero-role-pair" data-role="hero-role-pair"></div>
          <button class="preset-btn" type="button" data-role="source-overlay-toggle">Show Source Overlay · Off</button>
        </div>

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

        <div class="sidebar-section" data-role="palette-section">
          <div class="sidebar-heading">Palette</div>
          <div class="color-slider-row">
            <span class="color-slider-label">W</span>
            <input type="range" class="color-slider" data-role="wildness-slider" min="0" max="100" value="28" />
            <span class="color-slider-value" data-role="wildness-value">28%</span>
          </div>
          <div class="palette-grid" data-role="palette-grid"></div>
          <div class="palette-curation-actions">
            <button class="preset-btn" type="button" data-role="pin-active-color">Pin Active</button>
            <button class="preset-btn" type="button" data-role="clear-palette-pins">Clear Pins</button>
          </div>
          <div class="mini-note" data-role="palette-curation-readout">Tap a swatch to pick it up as your active color. Pin up to 2 colors to keep them during mutation.</div>
        </div>

        <div class="sidebar-section studio-dock-section" data-role="studio-dock-section">
          <div class="sidebar-heading">Families</div>
          <span class="deck-family-kicker" data-role="deck-family-kicker">Mono</span>
          <div class="studio-hero-actions">
            <button class="preset-btn preset-btn--hero" type="button" data-role="surprise-btn" title="Machine-random family and cast from original source">Surprise Me</button>
          </div>
          <div class="preset-tabs">
            <button class="preset-tab is-active" data-preset-tab="mono" title="Single-hue editorial ladders.">Mono</button>
            <button class="preset-tab" data-preset-tab="chrome" title="Metallic ramps with bright reflections.">Chrome</button>
            <button class="preset-tab" data-preset-tab="warhol" title="Poster and screenprint worlds.">Pop</button>
            <button class="preset-tab" data-preset-tab="acid" title="Toxic clash worlds.">Acid</button>
            <button class="preset-tab" data-preset-tab="pastel" title="Airy high-light worlds.">Pastel</button>
          </div>
          <div class="mini-note">Fast families. Fewer controls. More lucky accidents.</div>
          <div class="preset-list" data-role="preset-list"></div>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-heading">Effects</div>
          <div class="mini-note">Manual grain plus optional role grain. Use both if you want.</div>
          <div class="theory-rail" data-role="noise-target-rail">
            <button class="theory-btn" type="button" data-noise-target="background">Background</button>
            <button class="theory-btn" type="button" data-noise-target="outline">Outline</button>
            <button class="theory-btn" type="button" data-noise-target="content">Content</button>
          </div>
          <div class="color-slider-row">
            <span class="color-slider-label">N</span>
            <input type="range" class="color-slider" data-role="noise-amount" min="0" max="100" value="28" />
            <span class="color-slider-value" data-role="noise-amount-value">28%</span>
          </div>
          <div class="palette-curation-actions">
            <button class="preset-btn" type="button" data-role="apply-noise">Apply Grain</button>
            <button class="preset-btn" type="button" data-role="show-mask">Show Mask · Off</button>
          </div>
          <div class="palette-curation-actions">
            <button class="preset-btn" type="button" data-role="clear-role-grain">Clear Role Grain</button>
            <button class="preset-btn" type="button" data-role="clear-mask">Clear Mask</button>
            <button class="export-btn" data-role="export-gif" disabled>GIF 1s · Masked Grain</button>
          </div>
          <div class="export-row">
            <button class="export-btn" data-role="export-png" disabled>PNG 1024</button>
            <button class="export-btn" data-role="export-reset" disabled>Reset</button>
          </div>
        </div>

        <div class="sidebar-section" data-role="gallery-section">
          <div class="sidebar-heading">Share</div>
          <label class="gallery-signature-field" for="gallery-signature-input">
            <span class="gallery-signature-label">Sign (optional)</span>
            <input id="gallery-signature-input" name="gallery_signature" class="gallery-signature-input" data-role="gallery-signature" type="text" placeholder="@yourhandle" maxlength="16" autocomplete="off" />
          </label>
          <div class="gallery-save-actions">
            <button class="preset-btn preset-btn--gallery" type="button" data-role="save-gallery-png" disabled>Save PNG To No-Gallery</button>
            <button class="preset-btn preset-btn--gallery" type="button" data-role="save-gallery-gif" disabled>Save GIF To No-Gallery</button>
            <a class="preset-btn preset-btn--gallery-link" data-role="open-gallery-link" href="/tools/no-gallery">Open No-Gallery</a>
          </div>
          <div class="mini-note">Shared when available. Falls back to browser-local if the shared gallery is down.</div>
        </div>
      </div>

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
}
