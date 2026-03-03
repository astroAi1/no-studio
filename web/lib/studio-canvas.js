// studio-canvas.js — Interactive 24x24 pixel canvas for No-Palette Studio
// Grid subdivision is the creative axis: presets and dithering apply per-block.

import { getOccupiedPixels, classifyPixelRoles } from "./no-palette-render.js";
import { hexToRgb as hexToRgbLocal, rgbToHex as rgbToHexLocal } from "./color.js";

const SIZE = 24;
const BUFFER_LEN = SIZE * SIZE * 4;
const MAX_UNDO = 50;
const VALID_SUBDIVISIONS = [1, 2, 3, 4, 6, 8, 12, 24];

export class StudioCanvas {
  constructor(displayCanvas, options = {}) {
    this.display = displayCanvas;
    this.ctx = displayCanvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.onPixelHover = options.onPixelHover || null;
    this.onColorPick = options.onColorPick || null;
    this.onChange = options.onChange || null;

    this.originalBuffer = new Uint8ClampedArray(BUFFER_LEN);
    this.buffer = new Uint8ClampedArray(BUFFER_LEN);
    this.loaded = false;

    this.offscreen = document.createElement("canvas");
    this.offscreen.width = SIZE;
    this.offscreen.height = SIZE;
    this.offscreenCtx = this.offscreen.getContext("2d");

    this.grain = {
      enabled: false,
      target: "background",
      amount: 0,
      activeHex: null,
      seed: 0,
    };

    this.sheet = null;

    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.subdivision = 1;

    this.activeTool = "pointer";
    this.activeColor = { r: 255, g: 255, b: 255 };

    this.undoStack = [];
    this.redoStack = [];

    this._occupied = null;
    this._roles = null;
    this._isPanning = false;
    this._isPainting = false;
    this._lastPanPos = null;

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);

    this.display.addEventListener("mousedown", this._onMouseDown);
    this.display.addEventListener("mousemove", this._onMouseMove);
    this.display.addEventListener("mouseup", this._onMouseUp);
    this.display.addEventListener("mouseleave", this._onMouseUp);
    this.display.addEventListener("wheel", this._onWheel, { passive: false });
    this.display.addEventListener("contextmenu", (e) => e.preventDefault());
    this.display.addEventListener("touchstart", this._onTouchStart, { passive: false });
    this.display.addEventListener("touchmove", this._onTouchMove, { passive: false });
    this.display.addEventListener("touchend", this._onTouchEnd);
    this.display.addEventListener("touchcancel", this._onTouchEnd);

    this._touchState = { active: false, startDist: 0, startZoom: 1, lastCenter: null };

    this.display.style.cursor = "crosshair";
  }

  // ── Load ──────────────────────────────────────────────────────

  loadImageData(imageData) {
    if (imageData.width !== SIZE || imageData.height !== SIZE) {
      throw new Error("StudioCanvas requires 24x24 ImageData");
    }
    this.originalBuffer.set(imageData.data);
    this.buffer.set(imageData.data);
    this.loaded = true;
    this._invalidateCaches();
    this.undoStack = [];
    this.redoStack = [];
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.sheet = null;
    this.render();
  }

  // ── Pixel access ──────────────────────────────────────────────

  getPixel(x, y) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
    const i = (y * SIZE + x) * 4;
    return { r: this.buffer[i], g: this.buffer[i + 1], b: this.buffer[i + 2], a: this.buffer[i + 3] };
  }

  getPixelHex(x, y) {
    const p = this.getPixel(x, y);
    if (!p) return null;
    return rgbToHexLocal(p.r, p.g, p.b);
  }

  getOriginalPixelHex(x, y) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
    const i = (y * SIZE + x) * 4;
    if (this.originalBuffer[i + 3] === 0) return null;
    return rgbToHexLocal(this.originalBuffer[i], this.originalBuffer[i + 1], this.originalBuffer[i + 2]);
  }

  setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    const i = (y * SIZE + x) * 4;
    this.buffer[i] = r;
    this.buffer[i + 1] = g;
    this.buffer[i + 2] = b;
    this.buffer[i + 3] = a;
  }

  isOccupied(x, y) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return false;
    return this.originalBuffer[(y * SIZE + x) * 4 + 3] > 0;
  }

  // ── Tools ─────────────────────────────────────────────────────

  setTool(tool) {
    this.activeTool = tool;
    const cursors = { pointer: "default", paint: "crosshair", fill: "cell", eyedropper: "copy" };
    this.display.style.cursor = cursors[tool] || "crosshair";
  }

  setActiveColor(r, g, b) { this.activeColor = { r, g, b }; }

  setActiveColorHex(hex) {
    const rgb = hexToRgbLocal(hex);
    this.activeColor = rgb;
  }

  // ── Subdivision ───────────────────────────────────────────────

  setSubdivision(value) {
    if (VALID_SUBDIVISIONS.includes(value)) {
      this.subdivision = value;
      this.render();
    }
  }

  getBlockSize() { return SIZE / this.subdivision; }

  pixelToBlock(x, y) {
    const bs = this.getBlockSize();
    return { bx: Math.floor(x / bs) * bs, by: Math.floor(y / bs) * bs, size: bs };
  }

  /**
   * Get block index (col, row) for a pixel.
   */
  pixelToBlockIndex(x, y) {
    const bs = this.getBlockSize();
    return { col: Math.floor(x / bs), row: Math.floor(y / bs) };
  }

  /**
   * Iterate all blocks. Calls fn(bx, by, blockSize, col, row, blockIndex) for each.
   */
  forEachBlock(fn) {
    const bs = this.getBlockSize();
    const n = this.subdivision;
    let idx = 0;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        fn(col * bs, row * bs, bs, col, row, idx);
        idx++;
      }
    }
  }

  // ── Undo/Redo ─────────────────────────────────────────────────

  _pushUndo() {
    this.undoStack.push(new Uint8ClampedArray(this.buffer));
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(new Uint8ClampedArray(this.buffer));
    this.buffer.set(this.undoStack.pop());
    this._invalidateCaches();
    this.render();
    this.onChange?.();
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(new Uint8ClampedArray(this.buffer));
    this.buffer.set(this.redoStack.pop());
    this._invalidateCaches();
    this.render();
    this.onChange?.();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ── Paint operations ──────────────────────────────────────────

  paintPixel(x, y) {
    if (!this.isOccupied(x, y)) return;
    this._pushUndo();
    this.setPixel(x, y, this.activeColor.r, this.activeColor.g, this.activeColor.b);
    this.render();
    this.onChange?.();
  }

  fillBlock(x, y) {
    const block = this.pixelToBlock(x, y);
    this._pushUndo();
    let changed = false;
    for (let py = block.by; py < block.by + block.size && py < SIZE; py++) {
      for (let px = block.bx; px < block.bx + block.size && px < SIZE; px++) {
        if (!this.isOccupied(px, py)) continue;
        this.setPixel(px, py, this.activeColor.r, this.activeColor.g, this.activeColor.b);
        changed = true;
      }
    }
    if (changed) { this.render(); this.onChange?.(); }
    else { this.undoStack.pop(); }
  }

  // ── CRITICAL FIX: Presets always remap from ORIGINAL buffer ───

  /**
   * Apply a color mapping. ALWAYS reads from originalBuffer → writes to working buffer.
   * This means presets are idempotent and composable.
   */
  applyColorMapping(mapping, roles) {
    this._pushUndo();
    this.sheet = null;
    const map = new Map(Object.entries(mapping || {}).map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]));
    const bgRgb = hexToRgbLocal(roles.background || "#000000");
    const olRgb = hexToRgbLocal(roles.outline || "#040404");

    for (let i = 0; i < BUFFER_LEN; i += 4) {
      const origA = this.originalBuffer[i + 3];
      if (origA === 0) {
        // Transparent → background
        this.buffer[i] = bgRgb.r;
        this.buffer[i + 1] = bgRgb.g;
        this.buffer[i + 2] = bgRgb.b;
        this.buffer[i + 3] = 255;
        continue;
      }
      // Read from ORIGINAL, write to working
      const origHex = rgbToHexLocal(this.originalBuffer[i], this.originalBuffer[i + 1], this.originalBuffer[i + 2]);
      const mapped = map.get(origHex);
      if (mapped) {
        const rgb = hexToRgbLocal(mapped);
        this.buffer[i] = rgb.r;
        this.buffer[i + 1] = rgb.g;
        this.buffer[i + 2] = rgb.b;
      } else if (origHex === "#040404") {
        this.buffer[i] = olRgb.r;
        this.buffer[i + 1] = olRgb.g;
        this.buffer[i + 2] = olRgb.b;
      } else if (origHex === "#000000") {
        this.buffer[i] = bgRgb.r;
        this.buffer[i + 1] = bgRgb.g;
        this.buffer[i + 2] = bgRgb.b;
      } else {
        // Unmapped: keep original color
        this.buffer[i] = this.originalBuffer[i];
        this.buffer[i + 1] = this.originalBuffer[i + 1];
        this.buffer[i + 2] = this.originalBuffer[i + 2];
      }
      this.buffer[i + 3] = 255;
    }

    this._invalidateCaches();
    this.render();
    this.onChange?.();
  }

  /**
   * Grid-aware color mapping: each block gets a DIFFERENT mapping.
   * mappingFn(col, row, blockIndex, totalBlocks) → { mapping, roles }
   * This is what makes Warhol multi-panel and Reinhardt subtle-shift work.
   */
  applyGridMapping(mappingFn) {
    this._pushUndo();
    this.sheet = null;
    const totalBlocks = this.subdivision * this.subdivision;

    this.forEachBlock((bx, by, bs, col, row, blockIdx) => {
      const { mapping, roles } = mappingFn(col, row, blockIdx, totalBlocks);
      const map = new Map(Object.entries(mapping || {}).map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]));
      const bgRgb = hexToRgbLocal(roles.background || "#000000");
      const olRgb = hexToRgbLocal(roles.outline || "#040404");

      for (let py = by; py < by + bs && py < SIZE; py++) {
        for (let px = bx; px < bx + bs && px < SIZE; px++) {
          const i = (py * SIZE + px) * 4;
          const origA = this.originalBuffer[i + 3];

          if (origA === 0) {
            this.buffer[i] = bgRgb.r;
            this.buffer[i + 1] = bgRgb.g;
            this.buffer[i + 2] = bgRgb.b;
            this.buffer[i + 3] = 255;
            continue;
          }

          const origHex = rgbToHexLocal(this.originalBuffer[i], this.originalBuffer[i + 1], this.originalBuffer[i + 2]);
          const mapped = map.get(origHex);
          if (mapped) {
            const rgb = hexToRgbLocal(mapped);
            this.buffer[i] = rgb.r;
            this.buffer[i + 1] = rgb.g;
            this.buffer[i + 2] = rgb.b;
          } else if (origHex === "#040404") {
            this.buffer[i] = olRgb.r;
            this.buffer[i + 1] = olRgb.g;
            this.buffer[i + 2] = olRgb.b;
          } else if (origHex === "#000000") {
            this.buffer[i] = bgRgb.r;
            this.buffer[i + 1] = bgRgb.g;
            this.buffer[i + 2] = bgRgb.b;
          } else {
            this.buffer[i] = this.originalBuffer[i];
            this.buffer[i + 1] = this.originalBuffer[i + 1];
            this.buffer[i + 2] = this.originalBuffer[i + 2];
          }
          this.buffer[i + 3] = 255;
        }
      }
    });

    this._invalidateCaches();
    this.render();
    this.onChange?.();
  }

  /**
   * Grid-aware dithering: each block is independently dithered.
   * ditherFn(blockImageData, col, row, blockIndex, occupiedSet) → ImageData
   */
  applyGridDither(ditherFn) {
    this._pushUndo();
    this.sheet = null;
    const bs = this.getBlockSize();

    this.forEachBlock((bx, by, blockSize, col, row, blockIdx) => {
      // Extract block pixels from current buffer
      const blockData = new Uint8ClampedArray(blockSize * blockSize * 4);
      const blockOccupied = new Set();

      for (let py = 0; py < blockSize; py++) {
        for (let px = 0; px < blockSize; px++) {
          const srcX = bx + px;
          const srcY = by + py;
          const si = (srcY * SIZE + srcX) * 4;
          const di = (py * blockSize + px) * 4;
          blockData[di] = this.buffer[si];
          blockData[di + 1] = this.buffer[si + 1];
          blockData[di + 2] = this.buffer[si + 2];
          blockData[di + 3] = this.buffer[si + 3];
          if (this.originalBuffer[si + 3] > 0) {
            blockOccupied.add(`${px},${py}`);
          }
        }
      }

      const blockImageData = new ImageData(blockData, blockSize, blockSize);
      const result = ditherFn(blockImageData, col, row, blockIdx, blockOccupied);

      // Write back
      if (result) {
        for (let py = 0; py < blockSize; py++) {
          for (let px = 0; px < blockSize; px++) {
            const srcX = bx + px;
            const srcY = by + py;
            const si = (srcY * SIZE + srcX) * 4;
            const di = (py * blockSize + px) * 4;
            this.buffer[si] = result.data[di];
            this.buffer[si + 1] = result.data[di + 1];
            this.buffer[si + 2] = result.data[di + 2];
            this.buffer[si + 3] = result.data[di + 3];
          }
        }
      }
    });

    this._invalidateCaches();
    this.render();
    this.onChange?.();
  }

  applyImageData(imageData) {
    this._pushUndo();
    this.sheet = null;
    this.buffer.set(imageData.data);
    this._invalidateCaches();
    this.render();
    this.onChange?.();
  }

  reset() {
    this._pushUndo();
    this.sheet = null;
    this.buffer.set(this.originalBuffer);
    this._invalidateCaches();
    this.render();
    this.onChange?.();
  }

  setDisplayGrain({ enabled = true, target = "background", amount = 0.25, activeHex = null, seed = 0 } = {}) {
    this.grain = {
      enabled: Boolean(enabled),
      target: target || "background",
      amount: Math.max(0, Math.min(1, Number(amount) || 0)),
      activeHex: activeHex ? String(activeHex).toUpperCase() : null,
      seed: Math.max(0, Number(seed) || 0),
    };
    this.render();
  }

  clearDisplayGrain() {
    this.grain = {
      enabled: false,
      target: "background",
      amount: 0,
      activeHex: null,
      seed: 0,
    };
    this.render();
  }

  getDisplayGrain() {
    return {
      enabled: Boolean(this.grain.enabled),
      target: this.grain.target,
      amount: this.grain.amount,
      activeHex: this.grain.activeHex,
      seed: this.grain.seed,
    };
  }

  setSheetTiles(tiles = [], cols = 2, rows = 2) {
    const normalizedTiles = Array.isArray(tiles)
      ? tiles.filter((tile) => tile && tile.width === SIZE && tile.height === SIZE)
      : [];
    if (!normalizedTiles.length) return;
    this.sheet = {
      tiles: normalizedTiles.map((tile) => new ImageData(new Uint8ClampedArray(tile.data), tile.width, tile.height)),
      cols: Math.max(1, Number(cols) || 1),
      rows: Math.max(1, Number(rows) || 1),
    };
    const first = this.sheet.tiles[0];
    if (first) {
      this.buffer.set(first.data);
      this._invalidateCaches();
    }
    this.render();
    this.onChange?.();
  }

  clearSheet() {
    if (!this.sheet) return;
    this.sheet = null;
    this.render();
    this.onChange?.();
  }

  // ── Bg/Outline ────────────────────────────────────────────────

  enforceBgOutlineRule(bgHex) {
    const bg = hexToRgbLocal(bgHex);
    const clamped = { r: Math.min(251, bg.r), g: Math.min(251, bg.g), b: Math.min(251, bg.b) };
    const ol = { r: clamped.r + 4, g: clamped.g + 4, b: clamped.b + 4 };
    return { background: rgbToHexLocal(clamped.r, clamped.g, clamped.b), outline: rgbToHexLocal(ol.r, ol.g, ol.b) };
  }

  // ── Zoom/Pan ──────────────────────────────────────────────────

  setZoom(value) {
    this.zoom = Math.max(0.5, Math.min(4, value));
    this.render();
  }
  zoomIn() { this.setZoom(this.zoom * 1.25); }
  zoomOut() { this.setZoom(this.zoom / 1.25); }

  // ── Coordinate Mapping ────────────────────────────────────────

  screenToPixel(clientX, clientY) {
    const rect = this.display.getBoundingClientRect();
    // Account for CSS vs bitmap scaling
    const scaleX = this.display.width / rect.width;
    const scaleY = this.display.height / rect.height;
    const canvasX = (clientX - rect.left) * scaleX;
    const canvasY = (clientY - rect.top) * scaleY;

    const w = this.display.width;
    const h = this.display.height;
    const displaySize = Math.min(w, h);
    const scaledSize = displaySize * this.zoom;
    const offsetX = (w - scaledSize) / 2 + this.panX;
    const offsetY = (h - scaledSize) / 2 + this.panY;
    const pixelSize = scaledSize / SIZE;

    const px = Math.floor((canvasX - offsetX) / pixelSize);
    const py = Math.floor((canvasY - offsetY) / pixelSize);
    return { x: px, y: py };
  }

  // ── Export ────────────────────────────────────────────────────

  exportImageData() {
    return new ImageData(new Uint8ClampedArray(this.buffer), SIZE, SIZE);
  }

  exportPng1024() {
    const temp = document.createElement("canvas");
    temp.width = 1024;
    temp.height = 1024;
    const tctx = temp.getContext("2d");
    tctx.imageSmoothingEnabled = false;
    if (this.sheet) {
      tctx.fillStyle = "#040404";
      tctx.fillRect(0, 0, 1024, 1024);
      this._drawSheet(tctx, 0, 0, 1024);
      return temp;
    }
    const imageData = this.exportImageData();
    this.offscreenCtx.putImageData(imageData, 0, 0);
    tctx.drawImage(this.offscreen, 0, 0, 1024, 1024);
    this._drawGrain(tctx, 0, 0, 1024);
    return temp;
  }

  getCurrentPalette() {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < BUFFER_LEN; i += 4) {
      if (this.buffer[i + 3] === 0) continue;
      const hex = rgbToHexLocal(this.buffer[i], this.buffer[i + 1], this.buffer[i + 2]);
      if (!seen.has(hex)) { seen.add(hex); out.push(hex); }
    }
    return out;
  }

  getClassifiedPalette() {
    const imageData = new ImageData(new Uint8ClampedArray(this.originalBuffer), SIZE, SIZE);
    const roles = classifyPixelRoles(imageData);
    const palette = this.getOriginalPalette();
    const colorRoles = new Map();
    for (const [coord, role] of roles) {
      const hex = this._hexAtCoord(coord, this.originalBuffer);
      if (hex && !colorRoles.has(hex)) colorRoles.set(hex, role);
    }
    return palette.map((hex) => ({ hex, role: colorRoles.get(hex) || "body" }));
  }

  getOriginalPalette() {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < BUFFER_LEN; i += 4) {
      if (this.originalBuffer[i + 3] === 0) continue;
      const hex = rgbToHexLocal(this.originalBuffer[i], this.originalBuffer[i + 1], this.originalBuffer[i + 2]);
      if (!seen.has(hex)) { seen.add(hex); out.push(hex); }
    }
    return out;
  }

  getOccupied() {
    if (!this._occupied) {
      this._occupied = getOccupiedPixels(new ImageData(new Uint8ClampedArray(this.originalBuffer), SIZE, SIZE));
    }
    return this._occupied;
  }

  // ── Rendering ─────────────────────────────────────────────────

  render() {
    const w = this.display.width;
    const h = this.display.height;
    if (w === 0 || h === 0) return;

    this.ctx.clearRect(0, 0, w, h);
    this.ctx.fillStyle = "#040404";
    this.ctx.fillRect(0, 0, w, h);

    if (!this.loaded) return;

    const imageData = new ImageData(new Uint8ClampedArray(this.buffer), SIZE, SIZE);
    this.offscreenCtx.putImageData(imageData, 0, 0);

    const displaySize = Math.min(w, h);
    const scaledSize = displaySize * this.zoom;
    const offsetX = (w - scaledSize) / 2 + this.panX;
    const offsetY = (h - scaledSize) / 2 + this.panY;

    if (this.sheet) {
      this._drawSheet(this.ctx, offsetX, offsetY, scaledSize);
      this._drawSheetGrid(offsetX, offsetY, scaledSize);
      return;
    }

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.offscreen, offsetX, offsetY, scaledSize, scaledSize);
    this._drawGrain(this.ctx, offsetX, offsetY, scaledSize);

    // Grid overlay — always show pixel grid at high zoom, subdivision grid always
    this._drawGrid(offsetX, offsetY, scaledSize);
  }

  _drawGrain(targetCtx, offsetX, offsetY, scaledSize) {
    if (!this.grain.enabled || this.grain.amount <= 0 || !this.loaded || scaledSize <= 0) return;

    const grainSize = Math.max(24, Math.round(scaledSize));
    const grainCanvas = document.createElement("canvas");
    grainCanvas.width = grainSize;
    grainCanvas.height = grainSize;
    const grainCtx = grainCanvas.getContext("2d");
    const image = grainCtx.createImageData(grainSize, grainSize);
    const data = image.data;
    const pixelScale = grainSize / SIZE;
    const activeHex = this.grain.activeHex;

    for (let gy = 0; gy < grainSize; gy += 1) {
      const sy = Math.min(SIZE - 1, Math.floor(gy / pixelScale));
      for (let gx = 0; gx < grainSize; gx += 1) {
        const sx = Math.min(SIZE - 1, Math.floor(gx / pixelScale));
        if (!this._grainTargetMatches(sx, sy, activeHex)) continue;

        const n = noiseAtLocal(gx, gy, this.grain.seed, this.grain.target.length);
        const centered = (n - 0.5) * 2;
        const intensity = Math.abs(centered) * (0.08 + (this.grain.amount * 0.22));
        if (intensity < 0.012) continue;

        const idx = (gy * grainSize + gx) * 4;
        const isLift = centered > 0;
        data[idx] = isLift ? 255 : 0;
        data[idx + 1] = isLift ? 255 : 0;
        data[idx + 2] = isLift ? 255 : 0;
        data[idx + 3] = Math.round(Math.min(255, intensity * 255));
      }
    }

    grainCtx.putImageData(image, 0, 0);
    targetCtx.save();
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.drawImage(grainCanvas, offsetX, offsetY, scaledSize, scaledSize);
    targetCtx.restore();
  }

  _drawSheet(targetCtx, offsetX, offsetY, scaledSize) {
    if (!this.sheet || !this.sheet.tiles.length) return;
    const cols = this.sheet.cols;
    const rows = this.sheet.rows;
    const maxAxis = Math.max(cols, rows);
    const cellSize = scaledSize / maxAxis;
    const sheetWidth = cellSize * cols;
    const sheetHeight = cellSize * rows;
    const startX = offsetX + ((scaledSize - sheetWidth) / 2);
    const startY = offsetY + ((scaledSize - sheetHeight) / 2);

    targetCtx.save();
    targetCtx.imageSmoothingEnabled = false;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const tile = this.sheet.tiles[(row * cols) + col];
        if (!tile) continue;
        this.offscreenCtx.putImageData(tile, 0, 0);
        targetCtx.drawImage(this.offscreen, startX + (col * cellSize), startY + (row * cellSize), cellSize, cellSize);
      }
    }
    targetCtx.restore();
  }

  _drawSheetGrid(offsetX, offsetY, scaledSize) {
    if (!this.sheet) return;
    const cols = this.sheet.cols;
    const rows = this.sheet.rows;
    const maxAxis = Math.max(cols, rows);
    const cellSize = scaledSize / maxAxis;
    const sheetWidth = cellSize * cols;
    const sheetHeight = cellSize * rows;
    const startX = offsetX + ((scaledSize - sheetWidth) / 2);
    const startY = offsetY + ((scaledSize - sheetHeight) / 2);

    this.ctx.save();
    this.ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    for (let i = 0; i <= cols; i += 1) {
      const x = startX + (i * cellSize);
      this.ctx.moveTo(x, startY);
      this.ctx.lineTo(x, startY + sheetHeight);
    }
    for (let i = 0; i <= rows; i += 1) {
      const y = startY + (i * cellSize);
      this.ctx.moveTo(startX, y);
      this.ctx.lineTo(startX + sheetWidth, y);
    }
    this.ctx.stroke();
    this.ctx.restore();
  }

  _grainTargetMatches(x, y, activeHex) {
    const occupied = this.isOccupied(x, y);
    if (this.grain.target === "background") return !occupied;
    if (this.grain.target === "figure") return occupied;
    if (!occupied || !activeHex) return false;
    return this.getPixelHex(x, y) === activeHex;
  }

  _drawGrid(offsetX, offsetY, scaledSize) {
    const pixelPx = scaledSize / SIZE;

    // Pixel grid (subtle, only when zoomed enough to see it)
    if (pixelPx > 8) {
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
      this.ctx.lineWidth = 0.5;
      this.ctx.beginPath();
      for (let i = 0; i <= SIZE; i++) {
        const pos = offsetX + i * pixelPx;
        this.ctx.moveTo(pos, offsetY);
        this.ctx.lineTo(pos, offsetY + scaledSize);
      }
      for (let i = 0; i <= SIZE; i++) {
        const pos = offsetY + i * pixelPx;
        this.ctx.moveTo(offsetX, pos);
        this.ctx.lineTo(offsetX + scaledSize, pos);
      }
      this.ctx.stroke();
    }

    // Subdivision grid (stronger)
    if (this.subdivision > 1) {
      const bs = this.getBlockSize();
      const cellPx = pixelPx * bs;
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      for (let i = 0; i <= this.subdivision; i++) {
        const pos = offsetX + i * cellPx;
        this.ctx.moveTo(pos, offsetY);
        this.ctx.lineTo(pos, offsetY + scaledSize);
      }
      for (let i = 0; i <= this.subdivision; i++) {
        const pos = offsetY + i * cellPx;
        this.ctx.moveTo(offsetX, pos);
        this.ctx.lineTo(offsetX + scaledSize, pos);
      }
      this.ctx.stroke();
    }
  }

  // ── Events ────────────────────────────────────────────────────

  _onMouseDown(e) {
    e.preventDefault();
    if (!this.loaded) return;

    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      this._isPanning = true;
      this._lastPanPos = { x: e.clientX, y: e.clientY };
      this.display.style.cursor = "grabbing";
      return;
    }

    const pixel = this.screenToPixel(e.clientX, e.clientY);
    if (pixel.x < 0 || pixel.x >= SIZE || pixel.y < 0 || pixel.y >= SIZE) return;

    switch (this.activeTool) {
      case "paint":
        this._isPainting = true;
        this.paintPixel(pixel.x, pixel.y);
        break;
      case "fill":
        this.fillBlock(pixel.x, pixel.y);
        break;
      case "eyedropper": {
        const hex = this.getPixelHex(pixel.x, pixel.y);
        if (hex) this.onColorPick?.(hex);
        break;
      }
    }
  }

  _onMouseMove(e) {
    if (!this.loaded) return;

    if (this._isPanning) {
      const dx = e.clientX - this._lastPanPos.x;
      const dy = e.clientY - this._lastPanPos.y;
      // Scale pan delta by CSS→bitmap ratio
      const rect = this.display.getBoundingClientRect();
      this.panX += dx * (this.display.width / rect.width);
      this.panY += dy * (this.display.height / rect.height);
      this._lastPanPos = { x: e.clientX, y: e.clientY };
      this.render();
      return;
    }

    const pixel = this.screenToPixel(e.clientX, e.clientY);
    if (pixel.x >= 0 && pixel.x < SIZE && pixel.y >= 0 && pixel.y < SIZE) {
      const hex = this.getPixelHex(pixel.x, pixel.y);
      const roles = this._getRoles();
      this.onPixelHover?.({
        x: pixel.x,
        y: pixel.y,
        hex,
        role: roles.get(`${pixel.x},${pixel.y}`) || null,
      });

      if (this._isPainting && this.activeTool === "paint") {
        if (this.isOccupied(pixel.x, pixel.y)) {
          this.setPixel(pixel.x, pixel.y, this.activeColor.r, this.activeColor.g, this.activeColor.b);
          this.render();
        }
      }
    }
  }

  _onMouseUp() {
    if (this._isPanning) {
      this._isPanning = false;
      this._lastPanPos = null;
      const cursors = { pointer: "default", paint: "crosshair", fill: "cell", eyedropper: "copy" };
      this.display.style.cursor = cursors[this.activeTool] || "crosshair";
    }
    if (this._isPainting) {
      this._isPainting = false;
      this.onChange?.();
    }
  }

  _onTouchStart(e) {
    if (!this.loaded) return;
    if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      this._touchState = {
        active: true,
        startDist: Math.sqrt(dx * dx + dy * dy),
        startZoom: this.zoom,
        lastCenter: {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        },
      };
    } else if (e.touches.length === 1) {
      e.preventDefault();
      this._touchState = {
        active: true,
        startDist: 0,
        startZoom: this.zoom,
        lastCenter: { x: e.touches[0].clientX, y: e.touches[0].clientY },
      };
    }
  }

  _onTouchMove(e) {
    if (!this._touchState.active || !this.loaded) return;
    e.preventDefault();
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (this._touchState.startDist > 0) {
        const scale = dist / this._touchState.startDist;
        this.setZoom(this._touchState.startZoom * scale);
      }
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      if (this._touchState.lastCenter) {
        const rect = this.display.getBoundingClientRect();
        const ratio = this.display.width / rect.width;
        this.panX += (cx - this._touchState.lastCenter.x) * ratio;
        this.panY += (cy - this._touchState.lastCenter.y) * ratio;
      }
      this._touchState.lastCenter = { x: cx, y: cy };
      this.render();
    } else if (e.touches.length === 1 && this._touchState.lastCenter) {
      const rect = this.display.getBoundingClientRect();
      const ratio = this.display.width / rect.width;
      this.panX += (e.touches[0].clientX - this._touchState.lastCenter.x) * ratio;
      this.panY += (e.touches[0].clientY - this._touchState.lastCenter.y) * ratio;
      this._touchState.lastCenter = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      this.render();
    }
  }

  _onTouchEnd(e) {
    if (e.touches.length === 0) {
      this._touchState = { active: false, startDist: 0, startZoom: 1, lastCenter: null };
    }
  }

  _onWheel(e) {
    e.preventDefault();
    if (!this.loaded) return;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    this.setZoom(this.zoom * delta);
  }

  // ── Internal ──────────────────────────────────────────────────

  _invalidateCaches() { this._occupied = null; this._roles = null; }

  _getRoles() {
    if (!this._roles) {
      this._roles = classifyPixelRoles(new ImageData(new Uint8ClampedArray(this.originalBuffer), SIZE, SIZE));
    }
    return this._roles;
  }

  _hexAtCoord(coord, buffer) {
    const [xs, ys] = coord.split(",").map(Number);
    const i = (ys * SIZE + xs) * 4;
    if (buffer[i + 3] === 0) return null;
    return rgbToHexLocal(buffer[i], buffer[i + 1], buffer[i + 2]);
  }

  destroy() {
    this.display.removeEventListener("mousedown", this._onMouseDown);
    this.display.removeEventListener("mousemove", this._onMouseMove);
    this.display.removeEventListener("mouseup", this._onMouseUp);
    this.display.removeEventListener("mouseleave", this._onMouseUp);
    this.display.removeEventListener("wheel", this._onWheel);
    this.display.removeEventListener("touchstart", this._onTouchStart);
    this.display.removeEventListener("touchmove", this._onTouchMove);
    this.display.removeEventListener("touchend", this._onTouchEnd);
    this.display.removeEventListener("touchcancel", this._onTouchEnd);
  }
}

// Local hex utilities now imported from ./color.js

function noiseAtLocal(x, y, seed = 0, salt = 0) {
  let n = ((((x + 1) * 73856093) ^ ((y + 1) * 19349663) ^ ((seed + 1) * 83492791) ^ ((salt + 1) * 2654435761)) >>> 0);
  n ^= n << 13;
  n ^= n >>> 17;
  n ^= n << 5;
  return ((n >>> 0) % 10000) / 10000;
}
