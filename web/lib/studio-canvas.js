import { classifyPixelRoles } from "./no-palette-render.js";
import { hexToRgb as hexToRgbLocal, rgbToHex as rgbToHexLocal } from "./color.js";

const SIZE = 24;
const CELL_COUNT = SIZE * SIZE;
const BUFFER_LEN = CELL_COUNT * 4;
const MAX_UNDO = 50;
const VALID_SUBDIVISIONS = [1, 2, 3, 4, 6, 8, 12, 24];
const BRAND_ROLE_BG = "#000000";
const BRAND_ROLE_FG = "#040404";
const DEFAULT_SHEET_STYLE = {
  frameFill: "#EBD8B8",
  frameStroke: "rgba(28, 20, 12, 0.35)",
};

function clampByte(value, max = 255) {
  return Math.max(0, Math.min(max, Math.round(Number(value) || 0)));
}

function normalizeHex(hex, fallback = "#000000") {
  const raw = String(hex || "").trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(raw) ? raw : fallback;
}

function cloneContentGrid(grid) {
  return Array.isArray(grid) ? grid.slice(0, CELL_COUNT).map((entry) => (entry ? normalizeHex(entry, null) : null)) : Array(CELL_COUNT).fill(null);
}

function cloneRoleGrid(grid) {
  const out = Array(CELL_COUNT).fill("b");
  if (Array.isArray(grid)) {
    for (let i = 0; i < Math.min(CELL_COUNT, grid.length); i += 1) {
      out[i] = grid[i] === "o" || grid[i] === "c" ? grid[i] : "b";
    }
  }
  return out;
}

function cloneNoiseMask(mask) {
  const out = new Uint8Array(CELL_COUNT);
  if (Array.isArray(mask) || mask instanceof Uint8Array) {
    for (let i = 0; i < Math.min(CELL_COUNT, mask.length); i += 1) {
      out[i] = Number(mask[i]) ? 1 : 0;
    }
  }
  return out;
}

function cloneNoiseRoleTargets(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    background: Boolean(source.background),
    outline: Boolean(source.outline),
    content: Boolean(source.content),
  };
}

function normalizeSheetStyle(style) {
  const source = style && typeof style === "object" ? style : {};
  return {
    frameFill: normalizeHex(source.frameFill, DEFAULT_SHEET_STYLE.frameFill),
    frameStroke: typeof source.frameStroke === "string" && source.frameStroke.trim()
      ? source.frameStroke.trim()
      : DEFAULT_SHEET_STYLE.frameStroke,
  };
}

function decodeRolePairFromBackground(backgroundHex) {
  const bg = hexToRgbLocal(normalizeHex(backgroundHex, BRAND_ROLE_BG));
  const safeBg = {
    r: clampByte(bg.r, 251),
    g: clampByte(bg.g, 251),
    b: clampByte(bg.b, 251),
  };
  return {
    background: rgbToHexLocal(safeBg.r, safeBg.g, safeBg.b),
    outline: rgbToHexLocal(safeBg.r + 4, safeBg.g + 4, safeBg.b + 4),
  };
}

function decodeRolePairFromOutline(outlineHex) {
  const outline = hexToRgbLocal(normalizeHex(outlineHex, BRAND_ROLE_FG));
  const safeOutline = {
    r: clampByte(outline.r, 255),
    g: clampByte(outline.g, 255),
    b: clampByte(outline.b, 255),
  };
  return decodeRolePairFromBackground(
    rgbToHexLocal(
      clampByte(safeOutline.r - 4, 251),
      clampByte(safeOutline.g - 4, 251),
      clampByte(safeOutline.b - 4, 251),
    ),
  );
}

function imageDataToRoleMap(imageData) {
  return classifyPixelRoles(new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height));
}

function buildInitialComposition(imageData) {
  const roleMap = imageDataToRoleMap(imageData);
  const roleGrid = Array(CELL_COUNT).fill("b");
  const contentGrid = Array(CELL_COUNT).fill(null);
  let backgroundHex = BRAND_ROLE_BG;
  let outlineHex = BRAND_ROLE_FG;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const index = y * SIZE + x;
      const offset = index * 4;
      const alpha = imageData.data[offset + 3];
      if (!alpha) {
        roleGrid[index] = "b";
        continue;
      }
      const hex = rgbToHexLocal(imageData.data[offset], imageData.data[offset + 1], imageData.data[offset + 2]);
      const role = roleMap.get(`${x},${y}`) || "body";
      if (role === "background" || hex === BRAND_ROLE_BG) {
        roleGrid[index] = "b";
        backgroundHex = hex;
      } else if (role === "outline" || hex === BRAND_ROLE_FG) {
        roleGrid[index] = "o";
        outlineHex = hex;
      } else {
        roleGrid[index] = "c";
        contentGrid[index] = hex;
      }
    }
  }

  const globalRolePair = decodeRolePairFromBackground(backgroundHex);
  if (normalizeHex(outlineHex, BRAND_ROLE_FG) !== globalRolePair.outline) {
    return {
      roleGrid,
      contentGrid,
      noiseMask: new Uint8Array(CELL_COUNT),
      globalRolePair,
    };
  }

  return {
    roleGrid,
    contentGrid,
    noiseMask: new Uint8Array(CELL_COUNT),
    globalRolePair: {
      background: normalizeHex(backgroundHex, globalRolePair.background),
      outline: normalizeHex(outlineHex, globalRolePair.outline),
    },
  };
}

function createSnapshot(state) {
  return {
    roleGrid: state.roleGrid.slice(),
    contentGrid: state.contentGrid.slice(),
    noiseMask: new Uint8Array(state.noiseMask),
    noiseRoleTargets: cloneNoiseRoleTargets(state.noiseRoleTargets),
    globalRolePair: { ...state.globalRolePair },
  };
}

function equalHex(a, b) {
  return normalizeHex(a, "") === normalizeHex(b, "");
}

export class StudioCanvas {
  constructor(displayCanvas, options = {}) {
    this.display = displayCanvas;
    this.ctx = displayCanvas.getContext("2d");
    this.ctx.imageSmoothingEnabled = false;
    this.onPixelHover = options.onPixelHover || null;
    this.onColorPick = options.onColorPick || null;
    this.onChange = options.onChange || null;

    this.sourceBuffer = new Uint8ClampedArray(BUFFER_LEN);
    this.buffer = new Uint8ClampedArray(BUFFER_LEN);
    this.originalComposition = null;
    this.roleGrid = Array(CELL_COUNT).fill("b");
    this.contentGrid = Array(CELL_COUNT).fill(null);
    this.noiseMask = new Uint8Array(CELL_COUNT);
    this.noiseRoleTargets = cloneNoiseRoleTargets();
    this.globalRolePair = { background: BRAND_ROLE_BG, outline: BRAND_ROLE_FG };
    this.loaded = false;

    this.offscreen = document.createElement("canvas");
    this.offscreen.width = SIZE;
    this.offscreen.height = SIZE;
    this.offscreenCtx = this.offscreen.getContext("2d");

    this.sourceCanvas = document.createElement("canvas");
    this.sourceCanvas.width = SIZE;
    this.sourceCanvas.height = SIZE;
    this.sourceCtx = this.sourceCanvas.getContext("2d");

    this.grain = {
      enabled: false,
      amount: 0,
      seed: 0,
    };
    this.overlay = {
      sourceVisible: false,
      sourceOpacity: 0.18,
      showNoiseMask: false,
    };

    this.sheet = null;

    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.subdivision = 1;

    this.activeTool = "pointer";
    this.paintTarget = "content";
    this.activeColor = { r: 255, g: 255, b: 255 };

    this.undoStack = [];
    this.redoStack = [];

    this._sourceRoles = null;
    this._sourcePalette = null;
    this._originalPalette = null;
    this._isPanning = false;
    this._isPainting = false;
    this._strokePushed = false;
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
    this.display.addEventListener("contextmenu", (event) => event.preventDefault());
    this.display.addEventListener("touchstart", this._onTouchStart, { passive: false });
    this.display.addEventListener("touchmove", this._onTouchMove, { passive: false });
    this.display.addEventListener("touchend", this._onTouchEnd);
    this.display.addEventListener("touchcancel", this._onTouchEnd);

    this._touchState = { active: false, startDist: 0, startZoom: 1, lastCenter: null };
    this.display.style.cursor = "crosshair";
  }

  loadImageData(imageData) {
    if (imageData.width !== SIZE || imageData.height !== SIZE) {
      throw new Error("StudioCanvas requires 24x24 ImageData");
    }
    this.sourceBuffer.set(imageData.data);
    this.sourceCtx.putImageData(new ImageData(new Uint8ClampedArray(this.sourceBuffer), SIZE, SIZE), 0, 0);
    const composition = buildInitialComposition(imageData);
    this.roleGrid = composition.roleGrid;
    this.contentGrid = composition.contentGrid;
    this.noiseMask = composition.noiseMask;
    this.noiseRoleTargets = cloneNoiseRoleTargets();
    this.globalRolePair = composition.globalRolePair;
    this.originalComposition = createSnapshot(this);
    this.loaded = true;
    this.undoStack = [];
    this.redoStack = [];
    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.sheet = null;
    this._invalidateCaches();
    this._flattenComposition();
    this.render();
  }

  loadSessionState(session) {
    if (!this.loaded || !session || typeof session !== "object") return false;
    if (!Array.isArray(session.roleGrid) || !Array.isArray(session.contentGrid)) return false;
    this.roleGrid = cloneRoleGrid(session.roleGrid);
    this.contentGrid = cloneContentGrid(session.contentGrid);
    this.noiseMask = cloneNoiseMask(session.noiseMask);
    this.noiseRoleTargets = cloneNoiseRoleTargets(session.noiseRoleTargets);
    this.globalRolePair = decodeRolePairFromBackground(session.globalRolePair?.background || BRAND_ROLE_BG);
    this.sheet = null;
    this.undoStack = [];
    this.redoStack = [];
    this._flattenComposition();
    this.render();
    this.onChange?.();
    return true;
  }

  exportSessionState(extra = {}) {
    return {
      version: 3,
      globalRolePair: { ...this.globalRolePair },
      roleGrid: this.roleGrid.slice(),
      contentGrid: this.contentGrid.slice(),
      noiseMask: Array.from(this.noiseMask),
      noiseRoleTargets: cloneNoiseRoleTargets(this.noiseRoleTargets),
      ...extra,
    };
  }

  exportCompositionState() {
    return {
      globalRolePair: { ...this.globalRolePair },
      roleGrid: this.roleGrid.slice(),
      contentGrid: this.contentGrid.slice(),
      noiseMask: Array.from(this.noiseMask),
      noiseRoleTargets: cloneNoiseRoleTargets(this.noiseRoleTargets),
    };
  }

  getPixel(x, y) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
    const offset = ((y * SIZE) + x) * 4;
    return {
      r: this.buffer[offset],
      g: this.buffer[offset + 1],
      b: this.buffer[offset + 2],
      a: this.buffer[offset + 3],
    };
  }

  getPixelHex(x, y) {
    const pixel = this.getPixel(x, y);
    if (!pixel || pixel.a === 0) return null;
    return rgbToHexLocal(pixel.r, pixel.g, pixel.b);
  }

  getOriginalPixelHex(x, y) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
    const offset = ((y * SIZE) + x) * 4;
    if (!this.sourceBuffer[offset + 3]) return null;
    return rgbToHexLocal(this.sourceBuffer[offset], this.sourceBuffer[offset + 1], this.sourceBuffer[offset + 2]);
  }

  getRoleAt(x, y) {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return null;
    const role = this.roleGrid[(y * SIZE) + x];
    return role === "b" ? "background" : role === "o" ? "outline" : "content";
  }

  getGlobalRolePair() {
    return { ...this.globalRolePair };
  }

  setTool(tool) {
    this.activeTool = tool;
    const cursors = {
      pointer: "default",
      paint: "crosshair",
      brush: "crosshair",
      fill: "cell",
      eyedropper: "copy",
      "noise-paint": "crosshair",
      "noise-erase": "crosshair",
    };
    this.display.style.cursor = cursors[tool] || "crosshair";
  }

  setPaintTarget(target = "content") {
    this.paintTarget = ["content", "background", "outline", "erase"].includes(target) ? target : "content";
  }

  setActiveColor(r, g, b) {
    this.activeColor = {
      r: clampByte(r),
      g: clampByte(g),
      b: clampByte(b),
    };
  }

  setActiveColorHex(hex) {
    const rgb = hexToRgbLocal(normalizeHex(hex, "#FFFFFF"));
    this.setActiveColor(rgb.r, rgb.g, rgb.b);
  }

  setSubdivision(value) {
    if (VALID_SUBDIVISIONS.includes(value)) {
      this.subdivision = value;
      this.render();
    }
  }

  getBlockSize() {
    return SIZE / this.subdivision;
  }

  pixelToBlock(x, y) {
    const size = this.getBlockSize();
    return { bx: Math.floor(x / size) * size, by: Math.floor(y / size) * size, size };
  }

  pixelToBlockIndex(x, y) {
    const bs = this.getBlockSize();
    return { col: Math.floor(x / bs), row: Math.floor(y / bs) };
  }

  forEachBlock(fn) {
    const bs = this.getBlockSize();
    const n = this.subdivision;
    let idx = 0;
    for (let row = 0; row < n; row += 1) {
      for (let col = 0; col < n; col += 1) {
        fn(col * bs, row * bs, bs, col, row, idx);
        idx += 1;
      }
    }
  }

  _pushUndo() {
    this.undoStack.push(createSnapshot(this));
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  _restoreSnapshot(snapshot) {
    this.roleGrid = cloneRoleGrid(snapshot.roleGrid);
    this.contentGrid = cloneContentGrid(snapshot.contentGrid);
    this.noiseMask = cloneNoiseMask(snapshot.noiseMask);
    this.noiseRoleTargets = cloneNoiseRoleTargets(snapshot.noiseRoleTargets);
    this.globalRolePair = decodeRolePairFromBackground(snapshot.globalRolePair?.background || BRAND_ROLE_BG);
    this.sheet = null;
    this._flattenComposition();
    this.render();
    this.onChange?.();
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(createSnapshot(this));
    this._restoreSnapshot(this.undoStack.pop());
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(createSnapshot(this));
    this._restoreSnapshot(this.redoStack.pop());
    return true;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  paintPixel(x, y) {
    if (!this.loaded) return;
    this._pushUndo();
    if (this._applyPaintToCell(x, y, this.activeTool === "noise-erase" ? "noise-erase" : this.activeTool)) {
      this._afterMutation();
    } else {
      this.undoStack.pop();
    }
  }

  fillBlock(x, y) {
    if (!this.loaded) return;
    this._pushUndo();
    const changed = this.activeTool === "noise-paint" || this.activeTool === "noise-erase"
      ? this._fillNoiseRegion(x, y, this.activeTool === "noise-paint")
      : this._fillColorRegion(x, y);
    if (changed) {
      this._afterMutation();
    } else {
      this.undoStack.pop();
    }
  }

  applyColorMapping(mapping = {}, roles = {}) {
    if (!this.loaded) return;
    this._pushUndo();
    this.sheet = null;
    const safePair = roles?.outline
      ? decodeRolePairFromOutline(roles.outline)
      : decodeRolePairFromBackground(roles?.background || BRAND_ROLE_BG);
    const map = new Map(
      Object.entries(mapping || {}).map(([key, value]) => [
        normalizeHex(key, ""),
        normalizeHex(value, null),
      ]).filter(([, value]) => value),
    );
    const nextContentGrid = this.contentGrid.slice();
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (this.roleGrid[index] !== "c") {
        nextContentGrid[index] = null;
        continue;
      }
      const currentHex = normalizeHex(this.contentGrid[index], null);
      if (!currentHex) {
        nextContentGrid[index] = null;
        continue;
      }
      nextContentGrid[index] = normalizeHex(map.get(currentHex) || currentHex, currentHex);
    }

    this.contentGrid = nextContentGrid;
    this.globalRolePair = safePair;
    this._afterMutation();
  }

  applyImageData(imageData) {
    if (!this.loaded || imageData.width !== SIZE || imageData.height !== SIZE) return;
    this._pushUndo();
    this.sheet = null;
    const nextRoleGrid = Array(CELL_COUNT).fill("b");
    const nextContentGrid = Array(CELL_COUNT).fill(null);
    const bgHex = this.globalRolePair.background;
    const outlineHex = this.globalRolePair.outline;

    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const index = y * SIZE + x;
        const offset = index * 4;
        const alpha = imageData.data[offset + 3];
        const hex = alpha
          ? rgbToHexLocal(imageData.data[offset], imageData.data[offset + 1], imageData.data[offset + 2])
          : bgHex;
        if (!alpha || equalHex(hex, bgHex)) {
          nextRoleGrid[index] = "b";
        } else if (equalHex(hex, outlineHex)) {
          nextRoleGrid[index] = "o";
        } else {
          nextRoleGrid[index] = "c";
          nextContentGrid[index] = hex;
        }
      }
    }

    this.roleGrid = nextRoleGrid;
    this.contentGrid = nextContentGrid;
    this._afterMutation();
  }

  startSilhouette(fillHex = null) {
    if (!this.loaded || !this.originalComposition) return false;
    this._pushUndo();
    const nextRoleGrid = Array(CELL_COUNT).fill("b");
    const nextContentGrid = Array(CELL_COUNT).fill(null);
    const safeFill = normalizeHex(fillHex, this.globalRolePair.outline);

    for (let index = 0; index < CELL_COUNT; index += 1) {
      const sourceRole = this.originalComposition.roleGrid[index];
      if (sourceRole === "o" || sourceRole === "c") {
        nextRoleGrid[index] = "c";
        nextContentGrid[index] = safeFill;
      }
    }

    this.roleGrid = nextRoleGrid;
    this.contentGrid = nextContentGrid;
    this.noiseMask = new Uint8Array(CELL_COUNT);
    this.sheet = null;
    this._afterMutation();
    return true;
  }

  startBlankCanvas() {
    if (!this.loaded) return false;
    this._pushUndo();
    this.roleGrid = Array(CELL_COUNT).fill("b");
    this.contentGrid = Array(CELL_COUNT).fill(null);
    this.noiseMask = new Uint8Array(CELL_COUNT);
    this.sheet = null;
    this._afterMutation();
    return true;
  }

  reset() {
    if (!this.loaded || !this.originalComposition) return;
    this._pushUndo();
    this.roleGrid = cloneRoleGrid(this.originalComposition.roleGrid);
    this.contentGrid = cloneContentGrid(this.originalComposition.contentGrid);
    this.noiseMask = cloneNoiseMask(this.originalComposition.noiseMask);
    this.globalRolePair = decodeRolePairFromBackground(this.originalComposition.globalRolePair.background);
    this.sheet = null;
    this._afterMutation();
  }

  setDisplayGrain({ enabled = true, amount = 0.25, seed = 0 } = {}) {
    this.grain = {
      enabled: Boolean(enabled),
      amount: Math.max(0, Math.min(1, Number(amount) || 0)),
      seed: Math.max(0, Number(seed) || 0),
    };
    this.render();
  }

  clearDisplayGrain() {
    this.grain = { enabled: false, amount: 0, seed: 0 };
    this.render();
  }

  getDisplayGrain() {
    return { ...this.grain };
  }

  setShowNoiseMask(value) {
    this.overlay.showNoiseMask = Boolean(value);
    this.render();
  }

  getShowNoiseMask() {
    return Boolean(this.overlay.showNoiseMask);
  }

  clearNoiseMask() {
    if (!this.loaded || !this.noiseMask.some(Boolean)) return false;
    this._pushUndo();
    this.noiseMask = new Uint8Array(CELL_COUNT);
    this._afterMutation();
    return true;
  }

  setSourceOverlayVisible(value) {
    this.overlay.sourceVisible = Boolean(value);
    this.render();
  }

  getSourceOverlayVisible() {
    return Boolean(this.overlay.sourceVisible);
  }

  getNoiseMaskCoordinates() {
    const effective = this._buildEffectiveNoiseMask();
    const out = [];
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (!effective[index]) continue;
      const x = index % SIZE;
      const y = Math.floor(index / SIZE);
      out.push(`${x},${y}`);
    }
    return out;
  }

  setNoiseRoleTargets(value = {}) {
    const next = cloneNoiseRoleTargets(value);
    const changed = (
      next.background !== this.noiseRoleTargets.background ||
      next.outline !== this.noiseRoleTargets.outline ||
      next.content !== this.noiseRoleTargets.content
    );
    if (!changed) return false;
    this.noiseRoleTargets = next;
    this.render();
    this.onChange?.();
    return true;
  }

  getNoiseRoleTargets() {
    return cloneNoiseRoleTargets(this.noiseRoleTargets);
  }

  setSheetTiles(tiles = [], cols = 2, rows = 2, style = {}) {
    const normalizedTiles = Array.isArray(tiles)
      ? tiles.filter((tile) => tile && tile.width === SIZE && tile.height === SIZE)
      : [];
    if (!normalizedTiles.length) return;
    const safeCols = Math.max(1, Number(cols) || 1);
    const safeRows = Math.max(1, Number(rows) || 1);
    const sheetWidth = SIZE * safeCols;
    const sheetHeight = SIZE * safeRows;
    const composed = new Uint8ClampedArray(sheetWidth * sheetHeight * 4);
    for (let row = 0; row < safeRows; row += 1) {
      for (let col = 0; col < safeCols; col += 1) {
        const tile = normalizedTiles[(row * safeCols) + col];
        if (!tile) continue;
        for (let y = 0; y < SIZE; y += 1) {
          const sourceStart = y * SIZE * 4;
          const sourceEnd = sourceStart + (SIZE * 4);
          const targetStart = (((row * SIZE) + y) * sheetWidth * 4) + (col * SIZE * 4);
          composed.set(tile.data.slice(sourceStart, sourceEnd), targetStart);
        }
      }
    }
    const imageData = new ImageData(composed, sheetWidth, sheetHeight);
    const canvas = document.createElement("canvas");
    canvas.width = sheetWidth;
    canvas.height = sheetHeight;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(imageData, 0, 0);

    this.sheet = {
      tiles: normalizedTiles.map((tile) => new ImageData(new Uint8ClampedArray(tile.data), tile.width, tile.height)),
      cols: safeCols,
      rows: safeRows,
      width: sheetWidth,
      height: sheetHeight,
      style: normalizeSheetStyle(style),
      imageData,
      canvas,
    };
    const first = this.sheet.tiles[0];
    if (first) {
      this.buffer.set(first.data);
      this.offscreenCtx.putImageData(new ImageData(new Uint8ClampedArray(this.buffer), SIZE, SIZE), 0, 0);
      this.render();
      this.onChange?.();
    } else {
      this.render();
    }
  }

  clearSheet() {
    if (!this.sheet) return;
    this.sheet = null;
    this.render();
    this.onChange?.();
  }

  hasSheet() {
    return Boolean(this.sheet && Array.isArray(this.sheet.tiles) && this.sheet.tiles.length);
  }

  enforceBgOutlineRule(bgHex) {
    return decodeRolePairFromBackground(bgHex);
  }

  setZoom(value) {
    this.zoom = Math.max(0.5, Math.min(4, value));
    this.render();
  }

  zoomIn() {
    this.setZoom(this.zoom * 1.25);
  }

  zoomOut() {
    this.setZoom(this.zoom / 1.25);
  }

  screenToPixel(clientX, clientY) {
    const rect = this.display.getBoundingClientRect();
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
    return {
      x: Math.floor((canvasX - offsetX) / pixelSize),
      y: Math.floor((canvasY - offsetY) / pixelSize),
    };
  }

  exportImageData() {
    return new ImageData(new Uint8ClampedArray(this.buffer), SIZE, SIZE);
  }

  exportCompositionImageData() {
    return this.exportImageData();
  }

  exportPng1024(options = {}) {
    const grainOverride = Object.prototype.hasOwnProperty.call(options, "grain")
      ? options.grain
      : null;
    const temp = document.createElement("canvas");
    temp.width = 1024;
    temp.height = 1024;
    const ctx = temp.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    if (this.sheet) {
      ctx.fillStyle = "#040404";
      ctx.fillRect(0, 0, 1024, 1024);
      this._drawSheet(ctx, 0, 0, 1024);
      this._drawGrain(ctx, 0, 0, 1024, grainOverride);
      return temp;
    }
    this.offscreenCtx.putImageData(this.exportImageData(), 0, 0);
    ctx.drawImage(this.offscreen, 0, 0, 1024, 1024);
    this._drawGrain(ctx, 0, 0, 1024, grainOverride);
    return temp;
  }

  getCurrentPalette() {
    if (this.sheet?.imageData) {
      return uniquePaletteFromData(this.sheet.imageData.data);
    }
    return uniquePaletteFromData(this.buffer);
  }

  getCompositionPalette() {
    return uniquePaletteFromData(this.buffer);
  }

  getOriginalPalette() {
    if (!this._originalPalette) {
      this._originalPalette = uniquePaletteFromData(this.sourceBuffer).filter((hex) => hex !== BRAND_ROLE_BG && hex !== BRAND_ROLE_FG ? true : true);
    }
    return this._originalPalette.slice();
  }

  getClassifiedPalette() {
    if (!this._sourcePalette) {
      const roles = this._getSourceRoles();
      const seen = new Set();
      const out = [];
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const offset = ((y * SIZE) + x) * 4;
          if (!this.sourceBuffer[offset + 3]) continue;
          const hex = rgbToHexLocal(this.sourceBuffer[offset], this.sourceBuffer[offset + 1], this.sourceBuffer[offset + 2]);
          if (seen.has(hex)) continue;
          seen.add(hex);
          out.push({ hex, role: roles.get(`${x},${y}`) || "body" });
        }
      }
      this._sourcePalette = out;
    }
    return this._sourcePalette.map((entry) => ({ ...entry }));
  }

  getOccupied() {
    const out = new Set();
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (this.roleGrid[index] === "b") continue;
      out.add(`${index % SIZE},${Math.floor(index / SIZE)}`);
    }
    return out;
  }

  render() {
    const w = this.display.width;
    const h = this.display.height;
    if (!w || !h) return;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.fillStyle = "#040404";
    this.ctx.fillRect(0, 0, w, h);
    if (!this.loaded) return;

    this.offscreenCtx.putImageData(new ImageData(new Uint8ClampedArray(this.buffer), SIZE, SIZE), 0, 0);
    const displaySize = Math.min(w, h);
    const scaledSize = displaySize * this.zoom;
    const offsetX = (w - scaledSize) / 2 + this.panX;
    const offsetY = (h - scaledSize) / 2 + this.panY;

    if (this.sheet) {
      this._drawSheet(this.ctx, offsetX, offsetY, scaledSize);
      this._drawGrain(this.ctx, offsetX, offsetY, scaledSize);
      this._drawNoiseMaskOverlay(offsetX, offsetY, scaledSize);
      return;
    }

    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.offscreen, offsetX, offsetY, scaledSize, scaledSize);

    if (this.overlay.sourceVisible) {
      this.ctx.save();
      this.ctx.globalAlpha = this.overlay.sourceOpacity;
      this.ctx.drawImage(this.sourceCanvas, offsetX, offsetY, scaledSize, scaledSize);
      this.ctx.restore();
    }

    this._drawGrain(this.ctx, offsetX, offsetY, scaledSize);
    this._drawNoiseMaskOverlay(offsetX, offsetY, scaledSize);
    this._drawGrid(offsetX, offsetY, scaledSize);
  }

  _drawNoiseMaskOverlay(offsetX, offsetY, scaledSize) {
    if (!this.overlay.showNoiseMask || scaledSize <= 0) return;
    const effectiveMask = this._buildEffectiveNoiseMask();
    if (this.sheet) {
      const layout = this._getSheetLayout(offsetX, offsetY, scaledSize);
      if (!layout) return;
      const pixelSize = layout.cellSize / SIZE;
      this.ctx.save();
      this.ctx.fillStyle = "rgba(98, 232, 255, 0.26)";
      for (let row = 0; row < layout.rows; row += 1) {
        for (let col = 0; col < layout.cols; col += 1) {
          const tileX = layout.startX + (col * (layout.cellSize + layout.gutter));
          const tileY = layout.startY + (row * (layout.cellSize + layout.gutter));
          for (let index = 0; index < CELL_COUNT; index += 1) {
            if (!effectiveMask[index]) continue;
            const x = index % SIZE;
            const y = Math.floor(index / SIZE);
            this.ctx.fillRect(tileX + (x * pixelSize), tileY + (y * pixelSize), pixelSize, pixelSize);
          }
        }
      }
      this.ctx.restore();
      return;
    }
    const pixelSize = scaledSize / SIZE;
    this.ctx.save();
    this.ctx.fillStyle = "rgba(98, 232, 255, 0.26)";
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (!effectiveMask[index]) continue;
      const x = index % SIZE;
      const y = Math.floor(index / SIZE);
      this.ctx.fillRect(offsetX + (x * pixelSize), offsetY + (y * pixelSize), pixelSize, pixelSize);
    }
    this.ctx.restore();
  }

  _drawGrain(targetCtx, offsetX, offsetY, scaledSize, grainOverride = null) {
    const grain = grainOverride || this.grain;
    if (!grain?.enabled || !(grain.amount > 0) || scaledSize <= 0) return;
    const effectiveMask = this._buildEffectiveNoiseMask();
    if (!effectiveMask.some(Boolean)) return;
    if (this.sheet) {
      const layout = this._getSheetLayout(offsetX, offsetY, scaledSize);
      if (!layout) return;
      for (let row = 0; row < layout.rows; row += 1) {
        for (let col = 0; col < layout.cols; col += 1) {
          const tileX = layout.startX + (col * (layout.cellSize + layout.gutter));
          const tileY = layout.startY + (row * (layout.cellSize + layout.gutter));
          const grainCanvas = this._buildGrainCanvas(
            layout.cellSize,
            grain,
            (row * layout.cols) + col,
            effectiveMask,
          );
          this._drawGrainBlock(targetCtx, tileX, tileY, layout.cellSize, grainCanvas);
        }
      }
      return;
    }
    this._drawGrainBlock(targetCtx, offsetX, offsetY, scaledSize, this._buildGrainCanvas(scaledSize, grain, 0, effectiveMask));
  }

  _drawSheet(targetCtx, offsetX, offsetY, scaledSize) {
    if (!this.sheet || !this.sheet.tiles.length) return;
    const layout = this._getSheetLayout(offsetX, offsetY, scaledSize);
    if (!layout) return;
    const style = normalizeSheetStyle(this.sheet.style);
    targetCtx.save();
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.fillStyle = style.frameFill;
    targetCtx.fillRect(
      layout.startX - layout.outerPadding,
      layout.startY - layout.outerPadding,
      layout.sheetWidth + (layout.outerPadding * 2),
      layout.sheetHeight + (layout.outerPadding * 2),
    );
    targetCtx.strokeStyle = style.frameStroke;
    targetCtx.lineWidth = Math.max(1, Math.round(layout.cellSize * 0.025));
    for (let row = 0; row < layout.rows; row += 1) {
      for (let col = 0; col < layout.cols; col += 1) {
        if (!this.sheet.tiles[(row * layout.cols) + col]) continue;
        const tileX = layout.startX + (col * (layout.cellSize + layout.gutter));
        const tileY = layout.startY + (row * (layout.cellSize + layout.gutter));
        targetCtx.drawImage(this.sheet.canvas, col * SIZE, row * SIZE, SIZE, SIZE, tileX, tileY, layout.cellSize, layout.cellSize);
        targetCtx.strokeRect(tileX, tileY, layout.cellSize, layout.cellSize);
      }
    }
    targetCtx.restore();
  }

  _getSheetLayout(offsetX, offsetY, scaledSize) {
    if (!this.sheet || !this.sheet.tiles.length) return null;
    const cols = this.sheet.cols;
    const rows = this.sheet.rows;
    const outerPadding = Math.max(10, Math.round(scaledSize * 0.035));
    const gutter = Math.max(6, Math.round(scaledSize * 0.018));
    const usableWidth = Math.max(1, scaledSize - (outerPadding * 2) - (gutter * Math.max(0, cols - 1)));
    const usableHeight = Math.max(1, scaledSize - (outerPadding * 2) - (gutter * Math.max(0, rows - 1)));
    const cellSize = Math.max(1, Math.floor(Math.min(usableWidth / cols, usableHeight / rows)));
    const sheetWidth = (cellSize * cols) + (gutter * Math.max(0, cols - 1));
    const sheetHeight = (cellSize * rows) + (gutter * Math.max(0, rows - 1));
    const startX = Math.round(offsetX + ((scaledSize - sheetWidth) / 2));
    const startY = Math.round(offsetY + ((scaledSize - sheetHeight) / 2));
    return {
      cols,
      rows,
      outerPadding,
      gutter,
      cellSize,
      sheetWidth,
      sheetHeight,
      startX,
      startY,
    };
  }

  _buildGrainCanvas(scaledSize, grain, seedOffset = 0, effectiveMask = null) {
    const grainSize = Math.max(24, Math.round(scaledSize));
    const grainCanvas = document.createElement("canvas");
    grainCanvas.width = grainSize;
    grainCanvas.height = grainSize;
    const grainCtx = grainCanvas.getContext("2d");
    const image = grainCtx.createImageData(grainSize, grainSize);
    const data = image.data;
    const pixelScale = grainSize / SIZE;
    const grainSeed = Math.max(0, Number(grain.seed) || 0) + seedOffset;
    const mask = effectiveMask instanceof Uint8Array ? effectiveMask : this._buildEffectiveNoiseMask();

    for (let gy = 0; gy < grainSize; gy += 1) {
      const sy = Math.min(SIZE - 1, Math.floor(gy / pixelScale));
      for (let gx = 0; gx < grainSize; gx += 1) {
        const sx = Math.min(SIZE - 1, Math.floor(gx / pixelScale));
        if (!mask[(sy * SIZE) + sx]) continue;
        const noise = noiseAtLocal(gx, gy, grainSeed, 7);
        const centered = (noise - 0.5) * 2;
        const intensity = Math.abs(centered) * (0.08 + (grain.amount * 0.22));
        if (intensity < 0.012) continue;
        const index = (gy * grainSize + gx) * 4;
        const lift = centered > 0;
        data[index] = lift ? 255 : 0;
        data[index + 1] = lift ? 255 : 0;
        data[index + 2] = lift ? 255 : 0;
        data[index + 3] = Math.round(Math.min(255, intensity * 255));
      }
    }

    grainCtx.putImageData(image, 0, 0);
    return grainCanvas;
  }

  _drawGrainBlock(targetCtx, offsetX, offsetY, scaledSize, grainCanvas) {
    if (!grainCanvas) return;
    targetCtx.save();
    targetCtx.imageSmoothingEnabled = false;
    targetCtx.drawImage(grainCanvas, offsetX, offsetY, scaledSize, scaledSize);
    targetCtx.restore();
  }

  _buildEffectiveNoiseMask() {
    const out = new Uint8Array(CELL_COUNT);
    const targets = this.noiseRoleTargets || {};
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const role = this.roleGrid[index];
      const roleMatch = (
        (role === "b" && targets.background) ||
        (role === "o" && targets.outline) ||
        (role === "c" && targets.content)
      );
      out[index] = this.noiseMask[index] || roleMatch ? 1 : 0;
    }
    return out;
  }

  buildMappedImageData(mapping = {}, roles = {}) {
    const safePair = roles?.outline
      ? decodeRolePairFromOutline(roles.outline)
      : roles?.background
        ? decodeRolePairFromBackground(roles.background)
        : { ...this.globalRolePair };
    const map = new Map(
      Object.entries(mapping || {}).map(([key, value]) => [
        normalizeHex(key, ""),
        normalizeHex(value, null),
      ]).filter(([, value]) => value),
    );
    const out = new Uint8ClampedArray(BUFFER_LEN);
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const offset = index * 4;
      const role = this.roleGrid[index];
      let hex = safePair.background;
      if (role === "o") {
        hex = safePair.outline;
      } else if (role === "c") {
        const currentHex = normalizeHex(this.contentGrid[index], this.globalRolePair.outline);
        hex = normalizeHex(map.get(currentHex) || currentHex, currentHex);
      }
      const rgb = hexToRgbLocal(hex);
      out[offset] = rgb.r;
      out[offset + 1] = rgb.g;
      out[offset + 2] = rgb.b;
      out[offset + 3] = 255;
    }
    return new ImageData(out, SIZE, SIZE);
  }

  _drawGrid(offsetX, offsetY, scaledSize) {
    const pixelPx = scaledSize / SIZE;
    if (pixelPx > 8) {
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
      this.ctx.lineWidth = 0.5;
      this.ctx.beginPath();
      for (let i = 0; i <= SIZE; i += 1) {
        const pos = offsetX + (i * pixelPx);
        this.ctx.moveTo(pos, offsetY);
        this.ctx.lineTo(pos, offsetY + scaledSize);
      }
      for (let i = 0; i <= SIZE; i += 1) {
        const pos = offsetY + (i * pixelPx);
        this.ctx.moveTo(offsetX, pos);
        this.ctx.lineTo(offsetX + scaledSize, pos);
      }
      this.ctx.stroke();
    }

    if (this.subdivision > 1) {
      const bs = this.getBlockSize();
      const cellPx = pixelPx * bs;
      this.ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      for (let i = 0; i <= this.subdivision; i += 1) {
        const pos = offsetX + (i * cellPx);
        this.ctx.moveTo(pos, offsetY);
        this.ctx.lineTo(pos, offsetY + scaledSize);
      }
      for (let i = 0; i <= this.subdivision; i += 1) {
        const pos = offsetY + (i * cellPx);
        this.ctx.moveTo(offsetX, pos);
        this.ctx.lineTo(offsetX + scaledSize, pos);
      }
      this.ctx.stroke();
    }
  }

  _onMouseDown(event) {
    event.preventDefault();
    if (!this.loaded) return;

    if (event.button === 1 || (event.button === 0 && event.shiftKey)) {
      this._isPanning = true;
      this._lastPanPos = { x: event.clientX, y: event.clientY };
      this.display.style.cursor = "grabbing";
      return;
    }

    const pixel = this.screenToPixel(event.clientX, event.clientY);
    if (!this._pixelInBounds(pixel.x, pixel.y)) return;

    switch (this.activeTool) {
      case "paint":
      case "brush":
      case "noise-paint":
      case "noise-erase":
        this._pushUndo();
        this._strokePushed = true;
        this._isPainting = true;
        this._applyPaintToCell(pixel.x, pixel.y, this.activeTool);
        this._flattenComposition();
        this.render();
        break;
      case "fill":
        this.fillBlock(pixel.x, pixel.y);
        break;
      case "eyedropper": {
        const hex = this.getPixelHex(pixel.x, pixel.y);
        if (hex) this.onColorPick?.(hex);
        break;
      }
      default:
        break;
    }
  }

  _onMouseMove(event) {
    if (!this.loaded) return;
    if (this._isPanning) {
      const dx = event.clientX - this._lastPanPos.x;
      const dy = event.clientY - this._lastPanPos.y;
      const rect = this.display.getBoundingClientRect();
      this.panX += dx * (this.display.width / rect.width);
      this.panY += dy * (this.display.height / rect.height);
      this._lastPanPos = { x: event.clientX, y: event.clientY };
      this.render();
      return;
    }

    const pixel = this.screenToPixel(event.clientX, event.clientY);
    if (!this._pixelInBounds(pixel.x, pixel.y)) return;
    this.onPixelHover?.({
      x: pixel.x,
      y: pixel.y,
      hex: this.getPixelHex(pixel.x, pixel.y),
      role: this.getRoleAt(pixel.x, pixel.y),
    });

    if (this._isPainting) {
      if (this._applyPaintToCell(pixel.x, pixel.y, this.activeTool)) {
        this._flattenComposition();
        this.render();
      }
    }
  }

  _onMouseUp() {
    if (this._isPanning) {
      this._isPanning = false;
      this._lastPanPos = null;
      this.setTool(this.activeTool);
    }
    if (this._isPainting) {
      this._isPainting = false;
      this._strokePushed = false;
      this.onChange?.();
    }
  }

  _onTouchStart(event) {
    if (!this.loaded) return;
    if (event.touches.length === 2) {
      event.preventDefault();
      const dx = event.touches[0].clientX - event.touches[1].clientX;
      const dy = event.touches[0].clientY - event.touches[1].clientY;
      this._touchState = {
        active: true,
        startDist: Math.sqrt((dx * dx) + (dy * dy)),
        startZoom: this.zoom,
        lastCenter: {
          x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
          y: (event.touches[0].clientY + event.touches[1].clientY) / 2,
        },
      };
      return;
    }
    if (event.touches.length !== 1) return;
    event.preventDefault();
    const touch = event.touches[0];
    const pixel = this.screenToPixel(touch.clientX, touch.clientY);
    if (!this._pixelInBounds(pixel.x, pixel.y)) return;
    if (this.activeTool === "paint" || this.activeTool === "brush" || this.activeTool === "noise-paint" || this.activeTool === "noise-erase") {
      this._pushUndo();
      this._strokePushed = true;
      this._isPainting = true;
      this._applyPaintToCell(pixel.x, pixel.y, this.activeTool);
      this._flattenComposition();
      this.render();
    }
  }

  _onTouchMove(event) {
    if (!this._touchState.active || !this.loaded) return;
    if (event.touches.length === 2) {
      event.preventDefault();
      const dx = event.touches[0].clientX - event.touches[1].clientX;
      const dy = event.touches[0].clientY - event.touches[1].clientY;
      const dist = Math.sqrt((dx * dx) + (dy * dy));
      if (this._touchState.startDist > 0) {
        const scale = dist / this._touchState.startDist;
        this.setZoom(this._touchState.startZoom * scale);
      }
      const cx = (event.touches[0].clientX + event.touches[1].clientX) / 2;
      const cy = (event.touches[0].clientY + event.touches[1].clientY) / 2;
      if (this._touchState.lastCenter) {
        const rect = this.display.getBoundingClientRect();
        const ratio = this.display.width / rect.width;
        this.panX += (cx - this._touchState.lastCenter.x) * ratio;
        this.panY += (cy - this._touchState.lastCenter.y) * ratio;
      }
      this._touchState.lastCenter = { x: cx, y: cy };
      this.render();
      return;
    }
    if (event.touches.length === 1 && this._isPainting) {
      event.preventDefault();
      const touch = event.touches[0];
      const pixel = this.screenToPixel(touch.clientX, touch.clientY);
      if (!this._pixelInBounds(pixel.x, pixel.y)) return;
      if (this._applyPaintToCell(pixel.x, pixel.y, this.activeTool)) {
        this._flattenComposition();
        this.render();
      }
    }
  }

  _onTouchEnd(event) {
    if (event.touches.length === 0) {
      this._touchState = { active: false, startDist: 0, startZoom: 1, lastCenter: null };
      if (this._isPainting) {
        this._isPainting = false;
        this._strokePushed = false;
        this.onChange?.();
      }
    }
  }

  _onWheel(event) {
    event.preventDefault();
    if (!this.loaded) return;
    this.setZoom(this.zoom * (event.deltaY > 0 ? 0.9 : 1.1));
  }

  _pixelInBounds(x, y) {
    return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  }

  _afterMutation() {
    this._flattenComposition();
    this.render();
    this.onChange?.();
  }

  _cellIndex(x, y) {
    return (y * SIZE) + x;
  }

  _applyPaintToCell(x, y, tool) {
    if (!this._pixelInBounds(x, y)) return false;
    const index = this._cellIndex(x, y);
    if (tool === "noise-paint") {
      if (this.noiseMask[index] === 1) return false;
      this.noiseMask[index] = 1;
      return true;
    }
    if (tool === "noise-erase") {
      if (this.noiseMask[index] === 0) return false;
      this.noiseMask[index] = 0;
      return true;
    }

    const target = this.paintTarget;
    const colorHex = rgbToHexLocal(this.activeColor.r, this.activeColor.g, this.activeColor.b);
    if (target === "content") {
      const nextHex = normalizeHex(colorHex, "#FFFFFF");
      const changed = this.roleGrid[index] !== "c" || this.contentGrid[index] !== nextHex;
      if (!changed) return false;
      this.roleGrid[index] = "c";
      this.contentGrid[index] = nextHex;
      return true;
    }
    if (target === "background") {
      const nextPair = decodeRolePairFromBackground(colorHex);
      const changed = this.roleGrid[index] !== "b" || this.globalRolePair.background !== nextPair.background;
      if (!changed) return false;
      this.roleGrid[index] = "b";
      this.contentGrid[index] = null;
      this.globalRolePair = nextPair;
      return true;
    }
    if (target === "outline") {
      const nextPair = decodeRolePairFromOutline(colorHex);
      const changed = this.roleGrid[index] !== "o" || this.globalRolePair.background !== nextPair.background;
      if (!changed) return false;
      this.roleGrid[index] = "o";
      this.contentGrid[index] = null;
      this.globalRolePair = nextPair;
      return true;
    }
    if (target === "erase") {
      const changed = this.roleGrid[index] !== "b" || this.contentGrid[index] !== null;
      if (!changed) return false;
      this.roleGrid[index] = "b";
      this.contentGrid[index] = null;
      return true;
    }
    return false;
  }

  _fillNoiseRegion(x, y, enabled) {
    const startIndex = this._cellIndex(x, y);
    const source = this.noiseMask[startIndex];
    const target = enabled ? 1 : 0;
    if (source === target) return false;
    const queue = [[x, y]];
    const seen = new Set([`${x},${y}`]);
    let changed = false;
    while (queue.length) {
      const [cx, cy] = queue.shift();
      const index = this._cellIndex(cx, cy);
      if (this.noiseMask[index] !== source) continue;
      this.noiseMask[index] = target;
      changed = true;
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (!this._pixelInBounds(nx, ny)) continue;
        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push([nx, ny]);
      }
    }
    return changed;
  }

  _fillColorRegion(x, y) {
    const startRole = this.roleGrid[this._cellIndex(x, y)];
    const startHex = startRole === "c"
      ? this.contentGrid[this._cellIndex(x, y)]
      : (startRole === "o" ? this.globalRolePair.outline : this.globalRolePair.background);
    const queue = [[x, y]];
    const seen = new Set([`${x},${y}`]);
    let changed = false;
    while (queue.length) {
      const [cx, cy] = queue.shift();
      const index = this._cellIndex(cx, cy);
      const role = this.roleGrid[index];
      const hex = role === "c" ? this.contentGrid[index] : role === "o" ? this.globalRolePair.outline : this.globalRolePair.background;
      if (role !== startRole || !equalHex(hex, startHex)) continue;
      changed = this._applyPaintToCell(cx, cy, "fill") || changed;
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        if (!this._pixelInBounds(nx, ny)) continue;
        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push([nx, ny]);
      }
    }
    return changed;
  }

  _flattenComposition() {
    for (let index = 0; index < CELL_COUNT; index += 1) {
      const offset = index * 4;
      let hex = this.globalRolePair.background;
      const role = this.roleGrid[index];
      if (role === "o") {
        hex = this.globalRolePair.outline;
      } else if (role === "c") {
        hex = normalizeHex(this.contentGrid[index], this.globalRolePair.outline);
      }
      const rgb = hexToRgbLocal(hex);
      this.buffer[offset] = rgb.r;
      this.buffer[offset + 1] = rgb.g;
      this.buffer[offset + 2] = rgb.b;
      this.buffer[offset + 3] = 255;
    }
  }

  _invalidateCaches() {
    this._sourceRoles = null;
    this._sourcePalette = null;
    this._originalPalette = null;
  }

  _getSourceRoles() {
    if (!this._sourceRoles) {
      this._sourceRoles = imageDataToRoleMap(new ImageData(new Uint8ClampedArray(this.sourceBuffer), SIZE, SIZE));
    }
    return this._sourceRoles;
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

function uniquePaletteFromData(data) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const hex = rgbToHexLocal(data[i], data[i + 1], data[i + 2]);
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

function noiseAtLocal(x, y, seed = 0, salt = 0) {
  let n = ((((x + 1) * 73856093) ^ ((y + 1) * 19349663) ^ ((seed + 1) * 83492791) ^ ((salt + 1) * 2654435761)) >>> 0);
  n ^= n << 13;
  n ^= n >>> 17;
  n ^= n << 5;
  return ((n >>> 0) % 10000) / 10000;
}
