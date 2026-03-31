"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { GalleryStore } = require("../server/lib/galleryStore");

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAHoX6wAAAAASUVORK5CYII=";

function withTempStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-gallery-store-"));
  const galleryRoot = path.join(dir, "gallery");
  const dbPath = path.join(dir, "gallery.sqlite");
  const store = new GalleryStore({
    dbPath,
    galleryRoot,
    maxEntries: 100,
  });
  try {
    return fn(store, dir, galleryRoot);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("gallery store saves shared entries and dedupes identical submissions", () => withTempStore((store) => {
  const first = store.saveEntry({
    tokenId: 7804,
    family: "acid",
    mediaDataUrl: PNG_DATA_URL,
    signatureHandle: "@dan",
    palette: ["#112233", "#AABBCC", "#FF66CC"],
    rolePair: {
      background: "#010203",
      figure: "#050607",
      mode: "exact",
    },
    provenance: {
      variantSeed: "seed-1",
      variantPage: 2,
      curatedPaletteMap: {
        "#C89A61": "#FF66CC",
      },
      familyModifiers: {
        corrosion: 58,
      },
      globalModifiers: {
        contrast: 62,
      },
      sourcePaletteSignature: "source-sig",
      outputSignature: "output-sig",
    },
  }, { useNoStudioPrefix: true });

  assert.equal(first.ok, true);
  assert.equal(first.item.global, true);
  assert.equal(first.item.family, "acid");
  assert.match(first.item.label, /#7804 · Acid/);

  const duplicate = store.saveEntry({
    tokenId: 7804,
    family: "acid",
    mediaDataUrl: PNG_DATA_URL,
    signatureHandle: "@dan",
    palette: ["#112233", "#AABBCC", "#FF66CC"],
    rolePair: {
      background: "#010203",
      figure: "#050607",
      mode: "exact",
    },
    provenance: {
      variantSeed: "seed-1",
      variantPage: 2,
      curatedPaletteMap: {
        "#C89A61": "#FF66CC",
      },
      familyModifiers: {
        corrosion: 58,
      },
      globalModifiers: {
        contrast: 62,
      },
      sourcePaletteSignature: "source-sig",
      outputSignature: "output-sig",
    },
  }, { useNoStudioPrefix: true });

  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.item.id, first.item.id);

  const listed = store.listEntries({
    family: "acid",
    useNoStudioPrefix: true,
  });
  assert.equal(listed.count, 1);
  assert.equal(listed.items[0].id, first.item.id);
}));

test("gallery store migrates legacy json metadata without duplicating rows", () => withTempStore((store, dir, galleryRoot) => {
  const legacyFileName = "no-gallery-legacy.png";
  const legacyFilePath = path.join(galleryRoot, legacyFileName);
  fs.mkdirSync(galleryRoot, { recursive: true });
  fs.writeFileSync(legacyFilePath, Buffer.from(PNG_DATA_URL.split(",")[1], "base64"));

  const legacyJsonPath = path.join(galleryRoot, "gallery.json");
  fs.writeFileSync(legacyJsonPath, JSON.stringify([{
    id: "legacy-1",
    fileName: legacyFileName,
    tokenId: 52,
    family: "pastel",
    createdAt: "2026-03-01T00:00:00.000Z",
    signatureHandle: "@legacy",
    palette: ["#DDEEFF", "#AACCEE"],
    rolePair: {
      background: "#F1F1F1",
      figure: "#EDEDED",
      mode: "exact",
    },
  }], null, 2));

  const first = store.migrateJsonIndex({
    jsonPath: legacyJsonPath,
    useNoStudioPrefix: true,
  });
  assert.equal(first.migrated, 1);

  const second = store.migrateJsonIndex({
    jsonPath: legacyJsonPath,
    useNoStudioPrefix: true,
  });
  assert.equal(second.migrated, 0);
  assert.equal(second.skipped, 1);

  const home = store.getHome({ useNoStudioPrefix: true });
  assert.equal(home.count, 0);
  assert.equal(home.archiveWeeks.length, 1);

  const archivedWeek = store.getWeekDetail(home.archiveWeeks[0].weekId, { useNoStudioPrefix: true });
  assert.equal(archivedWeek.count, 1);
  assert.equal(archivedWeek.items[0].tokenId, 52);
  assert.equal(archivedWeek.items[0].family, "pastel");
  assert.equal(archivedWeek.items[0].voteCount, 0);
}));

test("gallery store supports NO/YES reactions, swaps, and top sorting", () => withTempStore((store) => {
  const first = store.saveEntry({
    tokenId: 7804,
    family: "acid",
    mediaDataUrl: PNG_DATA_URL,
    palette: ["#112233", "#AABBCC", "#FF66CC"],
    rolePair: {
      background: "#010203",
      figure: "#050607",
      mode: "exact",
    },
    provenance: {
      outputSignature: "vote-a",
    },
  }, { useNoStudioPrefix: true });

  const second = store.saveEntry({
    tokenId: 52,
    family: "pastel",
    mediaDataUrl: PNG_DATA_URL,
    palette: ["#DDEEFF", "#AACCEE"],
    rolePair: {
      background: "#F1F1F1",
      figure: "#F5F5F5",
      mode: "exact",
    },
    provenance: {
      outputSignature: "vote-b",
    },
  }, { useNoStudioPrefix: true });

  const firstNo = store.reactEntry(first.item.id, "viewer-a", "no", { useNoStudioPrefix: true });
  assert.equal(firstNo.item.noCount, 1);
  assert.equal(firstNo.item.yesCount, 0);
  assert.equal(firstNo.item.viewerReaction, "no");
  assert.equal(firstNo.item.viewerHasVoted, true);

  const swapToYes = store.reactEntry(first.item.id, "viewer-a", "yes", { useNoStudioPrefix: true });
  assert.equal(swapToYes.item.noCount, 0);
  assert.equal(swapToYes.item.yesCount, 1);
  assert.equal(swapToYes.item.score, -1);
  assert.equal(swapToYes.item.viewerReaction, "yes");

  store.reactEntry(second.item.id, "viewer-b", "no", { useNoStudioPrefix: true });

  const listedTop = store.listEntries({
    sort: "top",
    viewerId: "viewer-a",
    useNoStudioPrefix: true,
  });

  assert.equal(listedTop.items[0].id, second.item.id);
  assert.equal(listedTop.items[0].score, 1);
  assert.equal(listedTop.items[1].id, first.item.id);
  assert.equal(listedTop.items[1].viewerReaction, "yes");
  assert.equal(listedTop.items[1].yesCount, 1);
}));

test("gallery store rolls finished weeks into archive and starts a fresh live week on the next save", () => withTempStore((store) => {
  const first = store.saveEntry({
    tokenId: 7804,
    family: "mono",
    mediaDataUrl: PNG_DATA_URL,
    palette: ["#112233", "#8899AA"],
    rolePair: {
      background: "#111111",
      figure: "#151515",
      mode: "exact",
    },
    provenance: {
      outputSignature: "week-a",
    },
  }, { useNoStudioPrefix: true });

  const firstWeekId = String(first.item.weekId || "");
  assert.ok(firstWeekId);

  const expiredAt = "2000-01-01T00:00:00.000Z";
  store.db.prepare("UPDATE gallery_weeks SET ends_at = ? WHERE id = ?").run(expiredAt, firstWeekId);

  const archivedHome = store.getHome({ useNoStudioPrefix: true });
  assert.equal(archivedHome.liveWeek, null);
  assert.equal(archivedHome.archiveWeeks.length, 1);
  assert.equal(archivedHome.archiveWeeks[0].weekId, firstWeekId);
  assert.equal(archivedHome.archiveWeeks[0].coverEntries.length, 1);

  assert.throws(
    () => store.reactEntry(first.item.id, "viewer-archive", "no", { useNoStudioPrefix: true }),
    /read-only/i,
  );

  const second = store.saveEntry({
    tokenId: 52,
    family: "pastel",
    mediaDataUrl: PNG_DATA_URL,
    palette: ["#DDEEFF", "#AACCEE"],
    rolePair: {
      background: "#F1F1F1",
      figure: "#F5F5F5",
      mode: "exact",
    },
    provenance: {
      outputSignature: "week-b",
    },
  }, { useNoStudioPrefix: true });

  assert.notEqual(second.item.weekId, firstWeekId);

  const liveHome = store.getHome({ useNoStudioPrefix: true });
  assert.equal(liveHome.liveWeek.weekId, second.item.weekId);
  assert.equal(liveHome.archiveWeeks[0].weekId, firstWeekId);

  const archivedWeek = store.getWeekDetail(firstWeekId, { useNoStudioPrefix: true });
  assert.equal(archivedWeek.week.weekState, "archived");
  assert.equal(archivedWeek.items.length, 1);
  assert.equal(archivedWeek.items[0].id, first.item.id);
}));
