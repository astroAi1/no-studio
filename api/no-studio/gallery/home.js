"use strict";

const { getGalleryHome } = require("../../_gallery-shared");

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
      const sort = req.query?.sort || "new";
      const liveLimit = Number(req.query?.liveLimit || 120);
      const archiveLimit = Number(req.query?.archiveLimit || 24);
      const viewerId = req.headers?.["x-no-gallery-anon-id"] || "";
      const payload = await getGalleryHome({ sort, liveLimit, archiveLimit, viewerId });
      return sendJson(res, 200, payload);
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("allow", "GET,OPTIONS");
      res.end();
      return;
    }

    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : "Gallery home request failed",
    });
  }
};
