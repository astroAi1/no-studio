"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { EthereumBlockSource } = require("../server/lib/nopalette/blockSource");
const { NoPaletteDatabase, isUniqueConstraintError } = require("../server/lib/nopalette/db");
const { listModes, normalizeMode, normalizeOutputKind } = require("../server/lib/nopalette/modes");
const { deriveStateSeed } = require("../server/lib/nopalette/mixer");

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nopalette-v2-db-"));
  const dbPath = path.join(dir, "test.sqlite");
  const db = new NoPaletteDatabase({ dbPath });
  try {
    return fn(db, dir);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("deriveStateSeed is deterministic and changes across block and mode", () => {
  const rgba = Buffer.alloc(24 * 24 * 4, 17);
  const a = deriveStateSeed({
    rgba24Bytes: rgba,
    tokenId: 7804,
    modeId: "canonical-machine",
    blockNumber: 123,
    toolVersion: "v2",
  });
  const b = deriveStateSeed({
    rgba24Bytes: rgba,
    tokenId: 7804,
    modeId: "canonical-machine",
    blockNumber: 123,
    toolVersion: "v2",
  });
  const c = deriveStateSeed({
    rgba24Bytes: rgba,
    tokenId: 7804,
    modeId: "dither-study",
    blockNumber: 123,
    toolVersion: "v2",
  });
  const d = deriveStateSeed({
    rgba24Bytes: rgba,
    tokenId: 7804,
    modeId: "canonical-machine",
    blockNumber: 124,
    toolVersion: "v2",
  });

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test("mode catalog normalizes mode and output kinds", () => {
  assert.equal(listModes().length, 3);
  assert.equal(normalizeMode("unknown").id, "canonical-machine");
  assert.equal(normalizeOutputKind(normalizeMode("serial-pop"), "contact-sheet"), "contact-sheet");
  assert.equal(normalizeOutputKind(normalizeMode("canonical-machine"), "contact-sheet"), "single");
});

test("saveGeneration caches canonical state by token/mode/block/output", () => withTempDb((db) => {
  db.saveGeneration({
    id: "state-1",
    tokenId: 7804,
    userSeed: "",
    derivedSeed: "derived",
    toolVersion: "v2",
    paletteSignature: "sig-1",
    output24Hash: "hash-1",
    rarityNorm: 0.6,
    raritySource: "local-fallback",
    strictMode: true,
    createdAt: "2026-03-01T00:00:00.000Z",
    blockNumber: 22012345,
    modeId: "canonical-machine",
    outputKind: "single",
    stateSignature: "state-sig-1",
  });

  const cached = db.getGenerationByState(7804, "canonical-machine", 22012345, "single");
  assert.equal(cached.id, "state-1");
  assert.equal(cached.blockNumber, 22012345);
  assert.equal(cached.modeId, "canonical-machine");

  assert.throws(() => {
    db.saveGeneration({
      id: "state-2",
      tokenId: 7804,
      userSeed: "",
      derivedSeed: "derived-2",
      toolVersion: "v2",
      paletteSignature: "sig-2",
      output24Hash: "hash-2",
      rarityNorm: 0.7,
      raritySource: "local-fallback",
      strictMode: true,
      createdAt: "2026-03-01T00:01:00.000Z",
      blockNumber: 22012345,
      modeId: "canonical-machine",
      outputKind: "single",
      stateSignature: "state-sig-2",
    });
  }, (error) => isUniqueConstraintError(error));
}));

test("state window signatures returns nearby block signatures", () => withTempDb((db) => {
  for (let i = 0; i < 3; i += 1) {
    db.saveGeneration({
      id: `state-${i}`,
      tokenId: 7804,
      userSeed: "",
      derivedSeed: `derived-${i}`,
      toolVersion: "v2",
      paletteSignature: `sig-${i}`,
      output24Hash: `hash-${i}`,
      rarityNorm: 0.5,
      raritySource: "local-fallback",
      strictMode: true,
      createdAt: `2026-03-01T00:0${i}:00.000Z`,
      blockNumber: 22012345 + i,
      modeId: "dither-study",
      outputKind: "single",
      stateSignature: `window-${i}`,
    });
  }

  const signatures = db.listStateWindowSignatures(7804, "dither-study", 22012346, 1);
  assert.deepEqual(new Set(signatures), new Set(["window-0", "window-1", "window-2"]));
}));

test("block source without RPC reports live head unavailable", async () => {
  const source = new EthereumBlockSource({ rpcUrl: "" });
  assert.equal(source.hasLiveHead(), false);
  await assert.rejects(() => source.getLatestHead(), /live-head-unavailable/);
});
