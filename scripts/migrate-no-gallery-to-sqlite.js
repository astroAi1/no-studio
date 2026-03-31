#!/usr/bin/env node
"use strict";

const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");
const DATA_ROOT = path.join(APP_ROOT, "data");
const NO_GALLERY_ROOT = path.join(DATA_ROOT, "no-gallery");
const LEGACY_JSON_PATH = path.join(NO_GALLERY_ROOT, "gallery.json");
const SQLITE_PATH = path.join(DATA_ROOT, "no-gallery.sqlite");

const { GalleryStore } = require("../server/lib/galleryStore");

function main() {
  const store = new GalleryStore({
    dbPath: SQLITE_PATH,
    galleryRoot: NO_GALLERY_ROOT,
  });

  try {
    const result = store.migrateJsonIndex({
      jsonPath: LEGACY_JSON_PATH,
      useNoStudioPrefix: true,
    });
    console.log(JSON.stringify({
      ok: true,
      sqlitePath: SQLITE_PATH,
      legacyJsonPath: LEGACY_JSON_PATH,
      ...result,
    }, null, 2));
  } finally {
    store.close();
  }
}

main();
