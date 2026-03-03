"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { isUniqueConstraintError, nowIso } = require("./db");
const { inspectNoPunkImage, renderNoPaletteGrid, renderNoPaletteImage } = require("./imageWorker");
const { listModes, normalizeMode, normalizeOutputKind } = require("./modes");
const {
  TOOL_VERSION_DEFAULT,
  addRgbDelta,
  canonicalPaletteSignature,
  deriveStateSeed,
  extractPaletteAndRoles,
  generatePaletteMapping,
  intToHex,
  remapPixels24,
  rgbIntToTuple,
  sha256Hex,
  stateSignature,
} = require("./mixer");

const SERIAL_OFFSETS = [-2, -1, 0, 1, 2, 3];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function safeRmdir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function buildCanonicalOriginalPaletteHex(originalPaletteHex) {
  const seen = new Set();
  const out = [];
  for (const hex of ["#000000", "#040404", ...(originalPaletteHex || [])]) {
    const clean = String(hex || "").toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function extremenessLabel(norm) {
  const n = Number(norm);
  if (!Number.isFinite(n)) return "Awaiting";
  if (n >= 0.92) return "Aggressive";
  if (n >= 0.72) return "Wide";
  if (n >= 0.45) return "Balanced";
  return "Conservative";
}

function ensureBlockNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.floor(num);
}

function cloneBuffer(buf) {
  return Buffer.from(Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []));
}

function rgba24ToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

function decodePixel24(buffer) {
  const out = [];
  for (let i = 0; i < buffer.length; i += 4) {
    out.push({
      index: i / 4,
      x: (i / 4) % 24,
      y: Math.floor((i / 4) / 24),
      r: buffer[i],
      g: buffer[i + 1],
      b: buffer[i + 2],
      a: buffer[i + 3],
    });
  }
  return out;
}

function tupleToInt({ r, g, b }) {
  return ((r << 16) | (g << 8) | b) >>> 0;
}

function luminanceInt(rgbInt) {
  const rgb = rgbIntToTuple(rgbInt >>> 0);
  return (0.2126 * rgb.r) + (0.7152 * rgb.g) + (0.0722 * rgb.b);
}

function collectPaletteFamilies(buffer, roles) {
  const bg = roles.background >>> 0;
  const ol = roles.outline >>> 0;
  const counts = new Map();
  for (const px of decodePixel24(buffer)) {
    if (px.a === 0) continue;
    const value = tupleToInt(px);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const ordered = Array.from(counts.entries())
    .map(([rgbInt, count]) => ({ rgbInt: rgbInt >>> 0, count }))
    .filter((entry) => entry.rgbInt !== bg && entry.rgbInt !== ol)
    .sort((a, b) => (luminanceInt(a.rgbInt) - luminanceInt(b.rgbInt)) || (a.rgbInt - b.rgbInt));

  const body = ordered.slice(0, Math.min(3, ordered.length)).map((entry) => intToHex(entry.rgbInt));
  const accents = ordered.slice(Math.max(0, ordered.length - 3)).map((entry) => intToHex(entry.rgbInt));
  return {
    body,
    accents,
  };
}

function applyPaletteShift(baseBuffer, roles, shiftFn) {
  const pixels = decodePixel24(baseBuffer);
  const out = cloneBuffer(baseBuffer);
  const bg = roles.background >>> 0;
  const ol = roles.outline >>> 0;
  const nonRolePalette = Array.from(new Set(
    pixels
      .filter((px) => px.a > 0)
      .map((px) => tupleToInt(px))
      .filter((value) => value !== bg && value !== ol)
  )).sort((a, b) => (luminanceInt(a) - luminanceInt(b)) || (a - b));

  if (nonRolePalette.length <= 1) return out;
  const indexMap = new Map(nonRolePalette.map((value, index) => [value, index]));

  for (const px of pixels) {
    const current = tupleToInt(px);
    if (current === bg || current === ol) continue;
    const currentIndex = indexMap.get(current);
    const nextIndex = shiftFn({ ...px, current, currentIndex, palette: nonRolePalette });
    if (!Number.isFinite(nextIndex) || nextIndex === currentIndex) continue;
    const normalized = Math.max(0, Math.min(nonRolePalette.length - 1, Math.round(nextIndex)));
    const next = rgbIntToTuple(nonRolePalette[normalized]);
    const i = px.index * 4;
    out[i] = next.r;
    out[i + 1] = next.g;
    out[i + 2] = next.b;
    out[i + 3] = 255;
  }

  return out;
}

function applyDitherStudy(baseBuffer, roles, blockNumber, extremenessNorm, derivedState) {
  const phase = Number(blockNumber) % 4;
  const intensity = Number(extremenessNorm || 0);
  const strategyIndex = Number.parseInt(String(derivedState).slice(0, 2), 16) % 4;
  const step = intensity >= 0.85 ? 2 : 1;

  return applyPaletteShift(baseBuffer, roles, ({ x, y, currentIndex, palette }) => {
    const threshold = Math.max(0, Math.min(palette.length - 1, currentIndex));
    const lowZone = threshold < Math.ceil(palette.length / 2);
    const allowAccent = intensity >= 0.72;
    if (!lowZone && !allowAccent) return currentIndex;

    let active = false;
    switch (strategyIndex) {
      case 0:
        active = ((x + y + phase) % 2) === 0;
        break;
      case 1:
        active = (((x % 4) + (y % 4) + phase) % 3) === 0;
        break;
      case 2:
        active = ((x + phase) % 2) === ((y + phase) % 2);
        break;
      default:
        active = (((x * 3) + (y * 5) + phase) % 7) < Math.max(2, Math.round(intensity * 4));
        break;
    }

    if (!active) return currentIndex;
    const direction = ((x + phase) % 3) === 0 ? -1 : 1;
    return currentIndex + (direction * step);
  });
}

function applySerialPop(baseBuffer, roles, blockNumber, extremenessNorm) {
  const phase = Math.abs(Number(blockNumber) || 0) % 6;
  const intensity = Number(extremenessNorm || 0);
  return applyPaletteShift(baseBuffer, roles, ({ x, y, currentIndex, palette }) => {
    if (palette.length <= 1) return currentIndex;
    const band = (x + (y * 2) + phase) % 4;
    const maxJump = intensity >= 0.8 ? 2 : 1;
    if (band === 0) return Math.min(palette.length - 1, currentIndex + maxJump);
    if (band === 1) return Math.max(0, currentIndex - 1);
    if (band === 2 && intensity >= 0.55) {
      return Math.min(palette.length - 1, currentIndex + 1);
    }
    return currentIndex;
  });
}

function applyModeToBuffer({ mode, baseBuffer, roles, blockNumber, extremenessNorm, derivedState }) {
  if (mode.id === "dither-study") {
    return applyDitherStudy(baseBuffer, roles, blockNumber, extremenessNorm, derivedState);
  }
  if (mode.id === "serial-pop") {
    return applySerialPop(baseBuffer, roles, blockNumber, extremenessNorm);
  }
  return baseBuffer;
}

class NoPaletteGenerationService {
  constructor(options = {}) {
    this.db = options.db;
    this.rarityService = options.rarityService;
    this.blockSource = options.blockSource;
    this.workerScriptPath = options.workerScriptPath;
    this.outputRoot = options.outputRoot;
    this.toolVersion = options.toolVersion || TOOL_VERSION_DEFAULT;
    this.maxMappingRetries = Number(options.maxMappingRetries) || 24;
    this.recentCollisionWindow = Number(options.recentCollisionWindow) || 16;
    this.inspectCache = new Map();
    ensureDir(this.outputRoot);
  }

  async getConfig() {
    let head = null;
    if (this.blockSource && this.blockSource.hasLiveHead()) {
      try {
        head = await this.blockSource.getLatestHead();
      } catch {
        head = null;
      }
    }

    return {
      toolVersion: this.toolVersion,
      strictMode: true,
      blockMode: "ethereum-head",
      liveHeadAvailable: Boolean(head),
      head: head ? { latestBlockNumber: head.number } : {},
      outputs: {
        single: { width: 1024, height: 1024, format: "png", scale: "nearest" },
        contactSheet: { width: 1536, height: 1024, format: "png", scale: "nearest" },
        json: true,
      },
      roleRule: {
        background: "darkest role",
        outline: "clamp(background + #040404)",
        delta: "#040404",
      },
      extremeness: {
        source: "onchain-traits",
        normalizedRange: [0, 1],
      },
      block: {
        chainId: this.blockSource ? this.blockSource.chainId : 1,
      },
      modes: listModes(),
    };
  }

  async getHead() {
    const head = await this.blockSource.getLatestHead();
    return {
      number: head.number,
      chainId: head.chainId,
      source: head.source,
    };
  }

  async getRarity(tokenId) {
    const rarity = await this.rarityService.getRarity(tokenId);
    return {
      ...rarity,
      extremeness: extremenessLabel(rarity.normalized),
    };
  }

  getHistory(tokenId, options = {}) {
    const rows = this.db.listHistory(tokenId, options);
    return rows.map((row) => ({
      ...row,
      files: {
        pngUrl: `/api/no-palette/files/${encodeURIComponent(row.id)}/output.png`,
        jsonUrl: `/api/no-palette/files/${encodeURIComponent(row.id)}/output.json`,
      },
    }));
  }

  resolveFile(generationId, fileName) {
    const id = String(generationId || "").trim();
    const name = String(fileName || "").trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    if (!["output.png", "output.json"].includes(name)) return null;
    const filePath = path.join(this.outputRoot, id, name);
    if (!filePath.startsWith(this.outputRoot)) return null;
    if (!fs.existsSync(filePath)) return null;
    return {
      generationId: id,
      fileName: name,
      filePath,
    };
  }

  async inspectImageCached({ tokenId, imagePath }) {
    const stat = fs.statSync(imagePath);
    const cacheKey = `${tokenId}:${stat.mtimeMs}:${stat.size}`;
    const cached = this.inspectCache.get(cacheKey);
    if (cached) return cached;

    const inspect = await inspectNoPunkImage({
      workerScriptPath: this.workerScriptPath,
      inputPath: imagePath,
    });
    const rgba24Bytes = Buffer.from(inspect.rgba24B64, "base64");
    const extraction = extractPaletteAndRoles(rgba24Bytes);
    const result = { rgba24Bytes, inspect, extraction };

    this.inspectCache.clear();
    this.inspectCache.set(cacheKey, result);
    return result;
  }

  async resolveRequestedBlock(blockNumber) {
    const normalized = ensureBlockNumber(blockNumber);
    if (normalized !== null) {
      let headAtRequest = null;
      if (this.blockSource && this.blockSource.hasLiveHead()) {
        try {
          headAtRequest = await this.blockSource.getLatestHead();
        } catch {
          headAtRequest = null;
        }
      }
      return {
        blockNumber: normalized,
        headAtRequest: headAtRequest ? headAtRequest.number : normalized,
      };
    }

    const head = await this.blockSource.getLatestHead();
    return {
      blockNumber: head.number,
      headAtRequest: head.number,
    };
  }

  getCachedResponse(tokenId, mode, blockNumber, outputKind) {
    const cached = this.db.getGenerationByState(tokenId, mode.id, blockNumber, outputKind);
    if (!cached) return null;
    const jsonFile = this.resolveFile(cached.id, "output.json");
    const pngFile = this.resolveFile(cached.id, "output.png");
    if (!jsonFile || !pngFile) return null;
    const sidecar = readJsonIfExists(jsonFile.filePath);
    if (!sidecar) return null;
    return this.buildResponseFromSidecar(cached.id, sidecar);
  }

  async generate({ tokenId, mode: modeId, blockNumber, outputKind, imagePath }) {
    const mode = normalizeMode(modeId);
    const normalizedKind = normalizeOutputKind(mode, outputKind);
    const blockInfo = await this.resolveRequestedBlock(blockNumber);

    const cached = this.getCachedResponse(tokenId, mode, blockInfo.blockNumber, normalizedKind);
    if (cached) {
      return cached;
    }

    const inspectResult = await this.inspectImageCached({ tokenId, imagePath });
    const { rgba24Bytes, extraction } = inspectResult;
    const rarity = await this.rarityService.getRarity(tokenId);

    if (mode.id === "serial-pop" && normalizedKind === "contact-sheet") {
      return this.generateSerialContactSheet({
        tokenId,
        mode,
        blockInfo,
        imagePath,
        rgba24Bytes,
        extraction,
        rarity,
      });
    }

    return this.generateSingleState({
      tokenId,
      mode,
      blockInfo,
      imagePath,
      rgba24Bytes,
      extraction,
      rarity,
      outputKind: normalizedKind,
    });
  }

  async generateSingleState({ tokenId, mode, blockInfo, imagePath, rgba24Bytes, extraction, rarity, outputKind }) {
    const priorWindowSignatures = new Set(this.db.listStateWindowSignatures(tokenId, mode.id, blockInfo.blockNumber, this.recentCollisionWindow));
    const frame = this.generateFrameState({
      tokenId,
      mode,
      blockNumber: blockInfo.blockNumber,
      rgba24Bytes,
      extraction,
      extremenessNorm: rarity.normalized,
      priorWindowSignatures,
      outputKind,
    });

    if (!frame) {
      throw new Error("Generation exhausted under block constraints for this state.");
    }

    const generationId = crypto.randomUUID();
    const generationDir = path.join(this.outputRoot, generationId);
    ensureDir(generationDir);
    const pngPath = path.join(generationDir, "output.png");
    const jsonPath = path.join(generationDir, "output.json");

    try {
      const renderResult = await renderNoPaletteImage({
        workerScriptPath: this.workerScriptPath,
        outputPath: pngPath,
        size: 1024,
        rgba24Bytes: frame.output24,
      });

      const originalPaletteCanonicalHex = buildCanonicalOriginalPaletteHex(extraction.originalPaletteHex);
      const createdAt = nowIso();
      const sidecar = buildSingleSidecar({
        generationId,
        tokenId,
        mode,
        blockInfo,
        toolVersion: this.toolVersion,
        rarity,
        extraction,
        originalPaletteCanonicalHex,
        frame,
        createdAt,
        renderResult,
      });
      fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));

      this.db.saveGeneration({
        id: generationId,
        tokenId,
        userSeed: "",
        derivedSeed: frame.derivedState,
        toolVersion: this.toolVersion,
        paletteSignature: frame.paletteSignature,
        output24Hash: frame.output24Hash,
        rarityNorm: rarity.normalized,
        raritySource: rarity.source,
        strictMode: true,
        createdAt,
        blockNumber: blockInfo.blockNumber,
        modeId: mode.id,
        outputKind,
        stateSignature: frame.stateSig,
      });

      return this.buildResponseFromSidecar(generationId, sidecar);
    } catch (error) {
      safeUnlink(pngPath);
      safeUnlink(jsonPath);
      safeRmdir(generationDir);

      if (isUniqueConstraintError(error)) {
        const cached = this.getCachedResponse(tokenId, mode, blockInfo.blockNumber, outputKind);
        if (cached) return cached;
      }
      throw error;
    }
  }

  async generateSerialContactSheet({ tokenId, mode, blockInfo, imagePath, rgba24Bytes, extraction, rarity }) {
    const priorWindowSignatures = new Set(this.db.listStateWindowSignatures(tokenId, mode.id, blockInfo.blockNumber, this.recentCollisionWindow));
    const frames = [];
    const localSignatures = new Set();

    for (const offset of SERIAL_OFFSETS) {
      const frameBlock = Math.max(0, blockInfo.blockNumber + offset);
      const frame = this.generateFrameState({
        tokenId,
        mode,
        blockNumber: frameBlock,
        rgba24Bytes,
        extraction,
        extremenessNorm: rarity.normalized,
        priorWindowSignatures: new Set([...priorWindowSignatures, ...localSignatures]),
        outputKind: "single",
      });
      if (!frame) {
        throw new Error("Serial frame generation exhausted under block constraints.");
      }
      localSignatures.add(frame.stateSig);
      frames.push({
        offset,
        blockNumber: frameBlock,
        ...frame,
      });
    }

    const generationId = crypto.randomUUID();
    const generationDir = path.join(this.outputRoot, generationId);
    ensureDir(generationDir);
    const pngPath = path.join(generationDir, "output.png");
    const jsonPath = path.join(generationDir, "output.json");

    try {
      const renderResult = await renderNoPaletteGrid({
        workerScriptPath: this.workerScriptPath,
        outputPath: pngPath,
        cellSize: 512,
        columns: 3,
        rows: 2,
        frames: frames.map((frame) => frame.output24),
      });

      const originalPaletteCanonicalHex = buildCanonicalOriginalPaletteHex(extraction.originalPaletteHex);
      const createdAt = nowIso();
      const heroFrame = frames.find((frame) => frame.offset === 0) || frames[0];
      const combinedStateSignature = sha256Hex(frames.map((frame) => frame.stateSig).join("|"));
      const combinedOutputHash = sha256Hex(frames.map((frame) => frame.output24Hash).join("|"));
      const sidecar = buildSerialSidecar({
        generationId,
        tokenId,
        mode,
        blockInfo,
        toolVersion: this.toolVersion,
        rarity,
        extraction,
        originalPaletteCanonicalHex,
        frames,
        heroFrame,
        createdAt,
        renderResult,
        combinedStateSignature,
        combinedOutputHash,
      });
      fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));

      this.db.saveGeneration({
        id: generationId,
        tokenId,
        userSeed: "",
        derivedSeed: heroFrame.derivedState,
        toolVersion: this.toolVersion,
        paletteSignature: frames.map((frame) => frame.paletteSignature).join("|"),
        output24Hash: combinedOutputHash,
        rarityNorm: rarity.normalized,
        raritySource: rarity.source,
        strictMode: true,
        createdAt,
        blockNumber: blockInfo.blockNumber,
        modeId: mode.id,
        outputKind: "contact-sheet",
        stateSignature: combinedStateSignature,
      });

      return this.buildResponseFromSidecar(generationId, sidecar);
    } catch (error) {
      safeUnlink(pngPath);
      safeUnlink(jsonPath);
      safeRmdir(generationDir);

      if (isUniqueConstraintError(error)) {
        const cached = this.getCachedResponse(tokenId, mode, blockInfo.blockNumber, "contact-sheet");
        if (cached) return cached;
      }
      throw error;
    }
  }

  generateFrameState({ tokenId, mode, blockNumber, rgba24Bytes, extraction, extremenessNorm, priorWindowSignatures, outputKind }) {
    for (let nudge = 0; nudge < this.maxMappingRetries; nudge += 1) {
      const derivedState = deriveStateSeed({
        rgba24Bytes,
        tokenId,
        modeId: mode.id,
        blockNumber,
        toolVersion: this.toolVersion,
        nudge,
      });

      const mappingResult = generatePaletteMapping({
        originalPalette: extraction.originalPalette,
        rarityNorm: extremenessNorm,
        derivedSeed: derivedState,
        registrySnapshot: new Set(),
        strict: true,
        retryNonce: nudge,
      });
      if (!mappingResult.ok) continue;

      const baseOutput = remapPixels24({
        rgba24Bytes,
        mapping: mappingResult.mapping,
        roles: mappingResult.roles,
      });

      const finalOutput = applyModeToBuffer({
        mode,
        baseBuffer: baseOutput,
        roles: mappingResult.roles,
        blockNumber,
        extremenessNorm,
        derivedState,
      });
      const output24Hash = sha256Hex(finalOutput);
      const paletteSignature = mode.id === "canonical-machine"
        ? canonicalPaletteSignature({ mapping: mappingResult.mapping, roles: mappingResult.roles })
        : sha256Hex(`${mode.id}|${rgba24ToB64(finalOutput)}`);
      const stateSig = stateSignature({
        tokenId,
        modeId: mode.id,
        blockNumber,
        mapping: mappingResult.mapping,
        roles: mappingResult.roles,
        output24Hash,
        outputKind,
      });

      if (priorWindowSignatures && priorWindowSignatures.has(stateSig)) {
        continue;
      }

      return {
        derivedState,
        mappingResult,
        output24: finalOutput,
        output24B64: rgba24ToB64(finalOutput),
        output24Hash,
        paletteSignature,
        stateSig,
        paletteFamilies: collectPaletteFamilies(finalOutput, mappingResult.roles),
      };
    }
    return null;
  }

  buildResponseFromSidecar(generationId, sidecar) {
    return {
      ok: true,
      generationId,
      tokenId: sidecar.tokenId,
      mode: sidecar.mode,
      block: sidecar.block,
      state: sidecar.state,
      extremeness: sidecar.extremeness,
      output: {
        kind: sidecar.output.kind,
        pngUrl: `/api/no-palette/files/${encodeURIComponent(generationId)}/output.png`,
        jsonUrl: `/api/no-palette/files/${encodeURIComponent(generationId)}/output.json`,
      },
      preview: sidecar.preview,
    };
  }
}

function buildSingleSidecar({
  generationId,
  tokenId,
  mode,
  blockInfo,
  toolVersion,
  rarity,
  extraction,
  originalPaletteCanonicalHex,
  frame,
  createdAt,
  renderResult,
}) {
  return {
    generationId,
    tokenId,
    mode: {
      id: mode.id,
      label: mode.label,
      descriptionShort: mode.descriptionShort,
    },
    block: {
      number: blockInfo.blockNumber,
      headAtRequest: blockInfo.headAtRequest,
    },
    state: {
      derivedState: frame.derivedState,
      canonical: true,
      signature: frame.stateSig,
    },
    extremeness: {
      normalized: rarity.normalized,
      label: extremenessLabel(rarity.normalized),
      source: "onchain-traits",
      rank: rarity.rank,
      total: rarity.total,
      fetchedAt: rarity.fetchedAt,
    },
    output: {
      kind: "single",
      width: renderResult.width,
      height: renderResult.height,
      outputSha256: renderResult.output1024Sha256,
    },
    createdAt,
    toolVersion,
    strict: true,
    originalPalette: originalPaletteCanonicalHex || extraction.originalPaletteHex,
    roles: {
      background: frame.mappingResult.roles.backgroundHex,
      outline: frame.mappingResult.roles.outlineHex,
      delta: "#040404",
    },
    mapping: frame.mappingResult.mapping,
    generatedPalette: frame.mappingResult.generatedPaletteHex,
    preview: {
      pixel24: {
        roles: {
          background: frame.mappingResult.roles.backgroundHex,
          outline: frame.mappingResult.roles.outlineHex,
        },
        mapping: frame.mappingResult.mapping,
        palette: frame.mappingResult.generatedPaletteHex,
        rgba24B64: frame.output24B64,
      },
      paletteRail: {
        body: frame.paletteFamilies.body,
        accents: frame.paletteFamilies.accents,
        modeFamily: mode.id,
      },
    },
    render: {
      output24Hash: frame.output24Hash,
      output1024Sha256: renderResult.output1024Sha256,
    },
    invariants: {
      nearestNeighbor: true,
      noInventedPixels: true,
      strictMode: true,
      sourceAssetInterpretation: "cutout-png-with-implicit-#000000-background-role",
    },
  };
}

function buildSerialSidecar({
  generationId,
  tokenId,
  mode,
  blockInfo,
  toolVersion,
  rarity,
  extraction,
  originalPaletteCanonicalHex,
  frames,
  heroFrame,
  createdAt,
  renderResult,
  combinedStateSignature,
  combinedOutputHash,
}) {
  return {
    generationId,
    tokenId,
    mode: {
      id: mode.id,
      label: mode.label,
      descriptionShort: mode.descriptionShort,
    },
    block: {
      number: blockInfo.blockNumber,
      headAtRequest: blockInfo.headAtRequest,
    },
    state: {
      derivedState: heroFrame.derivedState,
      canonical: true,
      signature: combinedStateSignature,
    },
    extremeness: {
      normalized: rarity.normalized,
      label: extremenessLabel(rarity.normalized),
      source: "onchain-traits",
      rank: rarity.rank,
      total: rarity.total,
      fetchedAt: rarity.fetchedAt,
    },
    output: {
      kind: "contact-sheet",
      width: renderResult.width,
      height: renderResult.height,
      outputSha256: renderResult.outputSha256,
    },
    createdAt,
    toolVersion,
    strict: true,
    originalPalette: originalPaletteCanonicalHex || extraction.originalPaletteHex,
    roles: {
      background: heroFrame.mappingResult.roles.backgroundHex,
      outline: heroFrame.mappingResult.roles.outlineHex,
      delta: "#040404",
    },
    preview: {
      pixel24: {
        roles: {
          background: heroFrame.mappingResult.roles.backgroundHex,
          outline: heroFrame.mappingResult.roles.outlineHex,
        },
        mapping: heroFrame.mappingResult.mapping,
        palette: heroFrame.mappingResult.generatedPaletteHex,
        rgba24B64: heroFrame.output24B64,
      },
      frames: frames.map((frame) => ({
        blockNumber: frame.blockNumber,
        offset: frame.offset,
        rgba24B64: frame.output24B64,
        roles: {
          background: frame.mappingResult.roles.backgroundHex,
          outline: frame.mappingResult.roles.outlineHex,
        },
      })),
      paletteRail: {
        body: heroFrame.paletteFamilies.body,
        accents: heroFrame.paletteFamilies.accents,
        modeFamily: mode.id,
      },
      contactSheet: {
        columns: 3,
        rows: 2,
        cellSize: 512,
      },
    },
    frames: frames.map((frame) => ({
      blockNumber: frame.blockNumber,
      offset: frame.offset,
      derivedState: frame.derivedState,
      stateSignature: frame.stateSig,
      output24Hash: frame.output24Hash,
      roles: {
        background: frame.mappingResult.roles.backgroundHex,
        outline: frame.mappingResult.roles.outlineHex,
      },
      paletteRail: frame.paletteFamilies,
    })),
    render: {
      combinedOutputHash,
      outputSha256: renderResult.outputSha256,
    },
    invariants: {
      nearestNeighbor: true,
      noInventedPixels: true,
      strictMode: true,
      sourceAssetInterpretation: "cutout-png-with-implicit-#000000-background-role",
    },
  };
}

module.exports = {
  NoPaletteGenerationService,
};
