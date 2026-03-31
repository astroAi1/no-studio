"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const API_MODULE_PATH = pathToFileURL(path.join(__dirname, "../web/api.js")).href;
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAHoX6wAAAAASUVORK5CYII=";

function installBrowserStubs() {
  const storage = new Map();
  global.localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(String(key), String(value));
    },
    removeItem(key) {
      storage.delete(String(key));
    },
  };
  delete global.indexedDB;
}

async function importApiModule() {
  return import(`${API_MODULE_PATH}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("gallery client returns unavailable state instead of browser-local fallback when shared gallery is not configured", async () => {
  installBrowserStubs();
  global.fetch = async () => ({
    ok: false,
    status: 503,
    async text() {
      return JSON.stringify({
        ok: false,
        error: "Shared No-Gallery is not configured",
      });
    },
  });

  const api = await importApiModule();
  const payload = await api.getNoStudioGalleryHome({ sort: "new", liveLimit: 12 });

  assert.equal(payload.storage, "unavailable");
  assert.equal(payload.unavailable, true);
  assert.equal(Array.isArray(payload.archives), true);
  assert.match(payload.message, /shared no-gallery/i);
});

test("gallery client save and react fail closed when shared gallery is unavailable", async () => {
  installBrowserStubs();
  global.fetch = async () => ({
    ok: false,
    status: 503,
    async text() {
      return JSON.stringify({
        ok: false,
        error: "Shared No-Gallery is not configured",
      });
    },
  });

  const api = await importApiModule();

  await assert.rejects(
    () => api.saveNoStudioGallery({
      tokenId: 7804,
      family: "mono",
      mediaType: "png",
      mediaDataUrl: PNG_DATA_URL,
    }),
    /shared no-gallery/i,
  );

  await assert.rejects(
    () => api.voteNoStudioGallery("entry-1", "no"),
    /shared no-gallery/i,
  );
});
