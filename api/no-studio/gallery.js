"use strict";

const {
  listGalleryEntries,
  parseJsonBody,
  saveGalleryEntry,
} = require("../_gallery-shared");

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

module.exports = async function handler(req, res) {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return sendJson(res, 503, {
        ok: false,
        error: "Shared No-Gallery is not configured (BLOB_READ_WRITE_TOKEN missing)",
      });
    }

    if (req.method === "GET") {
      const limit = Number(req.query?.limit || 120);
      const items = await listGalleryEntries(limit);
      return sendJson(res, 200, {
        ok: true,
        count: items.length,
        items,
        storage: "shared",
      });
    }

    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      const item = await saveGalleryEntry(body || {});
      return sendJson(res, 200, {
        ok: true,
        item,
        storage: "shared",
      });
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("allow", "GET,POST,OPTIONS");
      res.end();
      return;
    }

    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : "Shared No-Gallery request failed",
    });
  }
};
