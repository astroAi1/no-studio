"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { NoPaletteDatabase, isUniqueConstraintError } = require("../server/lib/nopalette/db");

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nopalette-db-"));
  const dbPath = path.join(dir, "test.sqlite");
  const db = new NoPaletteDatabase({ dbPath });
  try {
    return fn(db, dir);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("rarity cache upsert/get works", () => withTempDb((db) => {
  const stored = db.upsertRarityCache({
    tokenId: 7804,
    source: "local-fallback",
    rank: null,
    total: 10000,
    normalized: 0.87,
    rawJson: { method: "trait-frequency-v1" },
    fetchedAt: "2026-02-25T00:00:00.000Z",
    expiresAt: "2026-03-01T00:00:00.000Z",
  });

  assert.equal(stored.tokenId, 7804);
  assert.equal(stored.source, "local-fallback");
  assert.equal(stored.normalized, 0.87);
  assert.equal(db.getRarityCache(7804).normalized, 0.87);
}));

test("used_colors unique guard blocks exact RGB reuse for same token", () => withTempDb((db) => {
  const generation = {
    id: "gen-1",
    tokenId: 7804,
    userSeed: "1",
    derivedSeed: "abc",
    toolVersion: "no-palette-v1",
    paletteSignature: "sig-1",
    output24Hash: "hash-1",
    rarityNorm: 0.5,
    raritySource: "local-fallback",
    strictMode: true,
    createdAt: "2026-02-25T00:00:00.000Z",
  };

  db.commitGenerationWithReservedColors({
    generation,
    colors: [
      { rgbInt: 0x112233, role: "background", createdAt: generation.createdAt },
      { rgbInt: 0x152637, role: "outline", createdAt: generation.createdAt },
    ],
  });

  assert.equal(db.getUsedColorsForToken(7804).has(0x112233), true);

  assert.throws(() => {
    db.commitGenerationWithReservedColors({
      generation: {
        ...generation,
        id: "gen-2",
        userSeed: "2",
        derivedSeed: "def",
        paletteSignature: "sig-2",
        output24Hash: "hash-2",
      },
      colors: [
        { rgbInt: 0x112233, role: "palette", createdAt: "2026-02-25T00:01:00.000Z" },
      ],
    });
  }, (error) => isUniqueConstraintError(error));
}));

test("same RGB can be used by different tokenIds", () => withTempDb((db) => {
  db.commitGenerationWithReservedColors({
    generation: {
      id: "gen-a",
      tokenId: 1,
      userSeed: "1",
      derivedSeed: "a",
      toolVersion: "v1",
      paletteSignature: "sig-a",
      output24Hash: "h-a",
      rarityNorm: 0.1,
      raritySource: "local-fallback",
      strictMode: true,
      createdAt: "2026-02-25T00:00:00.000Z",
    },
    colors: [{ rgbInt: 0x223344, role: "palette", createdAt: "2026-02-25T00:00:00.000Z" }],
  });

  db.commitGenerationWithReservedColors({
    generation: {
      id: "gen-b",
      tokenId: 2,
      userSeed: "1",
      derivedSeed: "b",
      toolVersion: "v1",
      paletteSignature: "sig-b",
      output24Hash: "h-b",
      rarityNorm: 0.2,
      raritySource: "local-fallback",
      strictMode: true,
      createdAt: "2026-02-25T00:00:01.000Z",
    },
    colors: [{ rgbInt: 0x223344, role: "palette", createdAt: "2026-02-25T00:00:01.000Z" }],
  });

  assert.equal(db.getUsedColorsForToken(1).has(0x223344), true);
  assert.equal(db.getUsedColorsForToken(2).has(0x223344), true);
}));
