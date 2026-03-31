"use strict";

const { parseJsonBody, reactGalleryEntry } = require("../../_gallery-shared");

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

    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      const id = body?.id || "";
      const reaction = body?.reaction || "no";
      const viewerId = req.headers?.["x-no-gallery-anon-id"] || "";
      const item = await reactGalleryEntry(id, viewerId, reaction);
      return sendJson(res, 200, { ok: true, item, storage: "shared" });
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("allow", "POST,OPTIONS");
      res.end();
      return;
    }

    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    return sendJson(res, statusCode, {
      ok: false,
      error: error && error.message ? error.message : "Reaction failed",
    });
  }
};
