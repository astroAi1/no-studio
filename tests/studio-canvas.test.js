"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const STUDIO_CANVAS_URL = pathToFileURL(path.join(__dirname, "../web/lib/studio-canvas.js")).href;

class FakeImageData {
  constructor(data, width, height) {
    this.data = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data || []);
    this.width = Number(width) || 0;
    this.height = Number(height) || 0;
  }
}

class FakeContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.imageSmoothingEnabled = false;
    this.fillStyle = "#000000";
    this.strokeStyle = "#000000";
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this._imageData = new FakeImageData(new Uint8ClampedArray(canvas.width * canvas.height * 4), canvas.width, canvas.height);
    this._fillRects = [];
  }

  clearRect() {}
  fillRect(x, y, width, height) {
    this._fillRects.push({ x, y, width, height, fillStyle: this.fillStyle });
  }
  drawImage() {}
  strokeRect() {}
  save() {}
  restore() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  stroke() {}

  putImageData(imageData) {
    this._imageData = new FakeImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  }

  getImageData(x, y, width, height) {
    return new FakeImageData(new Uint8ClampedArray((width || this.canvas.width) * (height || this.canvas.height) * 4), width || this.canvas.width, height || this.canvas.height);
  }

  createImageData(width, height) {
    return new FakeImageData(new Uint8ClampedArray(width * height * 4), width, height);
  }
}

class FakeCanvas {
  constructor(width = 24, height = 24) {
    this.width = width;
    this.height = height;
    this.style = {};
    this._context = new FakeContext2D(this);
  }

  getContext() {
    return this._context;
  }

  addEventListener() {}
  removeEventListener() {}

  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      width: this.width || 24,
      height: this.height || 24,
    };
  }
}

function installCanvasDom() {
  global.ImageData = FakeImageData;
  global.document = {
    createElement(tag) {
      if (tag === "canvas") return new FakeCanvas(24, 24);
      return {};
    },
  };
}

function buildSampleImageData() {
  const data = new Uint8ClampedArray(24 * 24 * 4);
  for (let index = 0; index < 24 * 24; index += 1) {
    const offset = index * 4;
    data[offset] = 0x00;
    data[offset + 1] = 0x00;
    data[offset + 2] = 0x00;
    data[offset + 3] = 0xFF;
  }

  const outlineIndex = (0 * 24) + 1;
  data[(outlineIndex * 4)] = 0x04;
  data[(outlineIndex * 4) + 1] = 0x04;
  data[(outlineIndex * 4) + 2] = 0x04;

  const contentIndex = (0 * 24) + 2;
  data[(contentIndex * 4)] = 0xC8;
  data[(contentIndex * 4) + 1] = 0x9A;
  data[(contentIndex * 4) + 2] = 0x61;

  return new FakeImageData(data, 24, 24);
}

test("studio canvas merges semantic grain targets with the manual mask", async () => {
  installCanvasDom();
  const { StudioCanvas } = await import(STUDIO_CANVAS_URL);

  const display = new FakeCanvas(240, 240);
  const canvas = new StudioCanvas(display);
  canvas.loadImageData(buildSampleImageData());

  assert.deepEqual(canvas.getNoiseMaskCoordinates(), []);

  canvas.setNoiseRoleTargets({ background: true });
  const backgroundCoords = canvas.getNoiseMaskCoordinates();
  assert.ok(backgroundCoords.includes("0,0"));
  assert.ok(!backgroundCoords.includes("1,0"));
  assert.ok(!backgroundCoords.includes("2,0"));

  canvas.setTool("noise-paint");
  canvas.paintPixel(2, 0);
  canvas.setNoiseRoleTargets({ background: false, outline: true, content: false });
  const mixedCoords = canvas.getNoiseMaskCoordinates();
  assert.ok(mixedCoords.includes("1,0"));
  assert.ok(mixedCoords.includes("2,0"));

  canvas.clearNoiseMask();
  const outlineOnly = canvas.getNoiseMaskCoordinates();
  assert.ok(outlineOnly.includes("1,0"));
  assert.ok(!outlineOnly.includes("2,0"));
});

test("studio canvas can build mapped image data from the live composition", async () => {
  installCanvasDom();
  const { StudioCanvas } = await import(STUDIO_CANVAS_URL);

  const display = new FakeCanvas(240, 240);
  const canvas = new StudioCanvas(display);
  canvas.loadImageData(buildSampleImageData());

  const mapped = canvas.buildMappedImageData({
    "#C89A61": "#FF66CC",
  }, {
    background: "#101010",
    outline: "#141414",
  });

  const pixelHex = (x, y) => {
    const offset = ((y * mapped.width) + x) * 4;
    return `#${[mapped.data[offset], mapped.data[offset + 1], mapped.data[offset + 2]]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
  };

  assert.equal(pixelHex(0, 0), "#101010");
  assert.equal(pixelHex(1, 0), "#141414");
  assert.equal(pixelHex(2, 0), "#FF66CC");
});

test("studio canvas can switch to silhouette and blank starts", async () => {
  installCanvasDom();
  const { StudioCanvas } = await import(STUDIO_CANVAS_URL);

  const display = new FakeCanvas(240, 240);
  const canvas = new StudioCanvas(display);
  canvas.loadImageData(buildSampleImageData());

  assert.equal(canvas.startSilhouette("#55AAFF"), true);
  let composition = canvas.exportCompositionState();
  assert.equal(composition.roleGrid[0], "b");
  assert.equal(composition.roleGrid[1], "c");
  assert.equal(composition.roleGrid[2], "c");
  assert.equal(composition.contentGrid[1], "#55AAFF");
  assert.equal(composition.contentGrid[2], "#55AAFF");
  assert.ok(composition.noiseMask.every((value) => value === 0));

  assert.equal(canvas.startBlankCanvas(), true);
  composition = canvas.exportCompositionState();
  assert.ok(composition.roleGrid.every((role) => role === "b"));
  assert.ok(composition.contentGrid.every((value) => value === null));
  assert.ok(composition.noiseMask.every((value) => value === 0));
});

test("studio canvas keeps the live composition export stable while sheet mode is active", async () => {
  installCanvasDom();
  const { StudioCanvas } = await import(STUDIO_CANVAS_URL);

  const display = new FakeCanvas(240, 240);
  const canvas = new StudioCanvas(display);
  canvas.loadImageData(buildSampleImageData());

  const magentaTile = canvas.buildMappedImageData({
    "#C89A61": "#FF00FF",
  }, {
    background: "#101010",
    outline: "#141414",
  });
  const cyanTile = canvas.buildMappedImageData({
    "#C89A61": "#00EEFF",
  }, {
    background: "#202020",
    outline: "#242424",
  });

  canvas.setSheetTiles([magentaTile, cyanTile], 2, 1, {
    frameFill: "#040404",
    frameStroke: "rgba(255,255,255,0.18)",
  });

  const composition = canvas.exportCompositionImageData();
  const offset = ((0 * composition.width) + 2) * 4;
  const exportedHex = `#${[composition.data[offset], composition.data[offset + 1], composition.data[offset + 2]]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;

  assert.equal(exportedHex, "#C89A61");
  assert.ok(canvas.getCompositionPalette().includes("#C89A61"));
  assert.ok(!canvas.getCompositionPalette().includes("#FF00FF"));
});

test("studio canvas touch fill and eyedropper work on mobile-sized canvases", async () => {
  installCanvasDom();
  const { StudioCanvas } = await import(STUDIO_CANVAS_URL);

  let pickedHex = null;
  const display = new FakeCanvas(240, 240);
  const canvas = new StudioCanvas(display, {
    onColorPick: (hex) => {
      pickedHex = hex;
    },
  });
  canvas.loadImageData(buildSampleImageData());

  const touchAt = (x, y) => ({
    preventDefault() {},
    touches: [{
      clientX: (x * 10) + 5,
      clientY: (y * 10) + 5,
    }],
  });

  canvas.setActiveColorHex("#AA00FF");
  canvas.setPaintTarget("content");
  canvas.setTool("fill");
  canvas._onTouchStart(touchAt(2, 0));
  assert.equal(canvas.getPixelHex(2, 0), "#AA00FF");

  canvas.setTool("eyedropper");
  canvas._onTouchStart(touchAt(2, 0));
  assert.equal(pickedHex, "#AA00FF");
});

test("studio canvas single frame state affects single-work export rendering", async () => {
  installCanvasDom();
  const { StudioCanvas } = await import(STUDIO_CANVAS_URL);

  const display = new FakeCanvas(240, 240);
  const canvas = new StudioCanvas(display);
  canvas.loadImageData(buildSampleImageData());

  const plainExport = canvas.exportPng1024();
  assert.equal(plainExport.getContext()._fillRects.length, 0);

  canvas.setSingleFrame({
    enabled: true,
    style: {
      frameFill: "#040404",
      frameStroke: "rgba(255,255,255,0.18)",
    },
  });

  const framedExport = canvas.exportPng1024();
  assert.ok(framedExport.getContext()._fillRects.length > 0);
  assert.equal(canvas.getSingleFrame().enabled, true);
  assert.equal(canvas.getSingleFrame().style.frameFill, "#040404");
});
