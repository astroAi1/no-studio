"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const { createServer } = require("../server/index");

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAHoX6wAAAAASUVORK5CYII=";

async function withTempApp(fn, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-gallery-api-"));
  const galleryRoot = path.join(dir, "gallery");
  const galleryDbPath = path.join(dir, "gallery.sqlite");
  const galleryIndexPath = path.join(dir, "gallery.json");
  const previousEnv = {
    GLOBAL_GALLERY_ENABLED: process.env.GLOBAL_GALLERY_ENABLED,
    GALLERY_RATE_LIMIT_MAX: process.env.GALLERY_RATE_LIMIT_MAX,
    GALLERY_RATE_LIMIT_WINDOW_MS: process.env.GALLERY_RATE_LIMIT_WINDOW_MS,
  };
  process.env.GLOBAL_GALLERY_ENABLED = env.GLOBAL_GALLERY_ENABLED ?? "1";
  process.env.GALLERY_RATE_LIMIT_MAX = env.GALLERY_RATE_LIMIT_MAX ?? "12";
  process.env.GALLERY_RATE_LIMIT_WINDOW_MS = env.GALLERY_RATE_LIMIT_WINDOW_MS ?? "60000";

  const app = createServer({
    galleryRoot,
    galleryDbPath,
    galleryIndexPath,
  });

  try {
    return await fn(app, {
      dir,
      galleryRoot,
      galleryDbPath,
      galleryIndexPath,
    });
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function requestApp(app, { method = "GET", url = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {
      host: "127.0.0.1",
      accept: "application/json",
      ...headers,
    };
    req.socket = {
      remoteAddress: "127.0.0.1",
    };
    req.destroy = () => {};

    let status = 200;
    let responseHeaders = {};
    const chunks = [];
    const res = {
      writeHead(code, headerMap) {
        status = code;
        responseHeaders = { ...responseHeaders, ...(headerMap || {}) };
      },
      write(chunk) {
        if (chunk != null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
      },
      end(chunk) {
        if (chunk != null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({
          status,
          headers: responseHeaders,
          body: text,
          json,
        });
      },
    };

    Promise.resolve(app.handleRequest(req, res)).catch(reject);
    process.nextTick(() => {
      if (body != null) {
        const raw = typeof body === "string" ? body : JSON.stringify(body);
        req.emit("data", raw);
      }
      req.emit("end");
    });
  });
}

test("gallery api exposes live week home and direct NO/YES reactions", async () => withTempApp(async (app) => {
  const post = await requestApp(app, {
    method: "POST",
    url: "/api/no-studio/gallery",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: {
      tokenId: 7804,
      family: "acid",
      mediaType: "png",
      mediaDataUrl: PNG_DATA_URL,
      signatureHandle: "@dan",
      palette: ["#112233", "#AABBCC", "#FF66CC"],
      rolePair: {
        background: "#010203",
        figure: "#050607",
        mode: "exact",
      },
      provenance: {
        variantSeed: "seed-api",
        variantPage: 1,
        curatedPaletteMap: {
          "#C89A61": "#FF66CC",
        },
        familyModifiers: {
          corrosion: 58,
        },
        globalModifiers: {
          contrast: 62,
        },
        sourcePaletteSignature: "source-api",
        outputSignature: "output-api",
      },
    },
  });

  assert.equal(post.status, 200);
  assert.equal(post.json.ok, true);
  assert.equal(post.json.global, true);
  assert.equal(post.json.item.family, "acid");
  assert.equal(post.json.item.voteCount, 0);

  const home = await requestApp(app, {
    method: "GET",
    url: "/api/no-studio/gallery/home?sort=new&liveLimit=12",
    headers: {
      "x-no-gallery-anon-id": "viewer-a",
    },
  });
  assert.equal(home.status, 200);
  assert.equal(home.json.global, true);
  assert.equal(home.json.liveWeek.items.length, 1);
  assert.equal(home.json.liveWeek.items[0].id, post.json.item.id);
  assert.equal(home.json.archiveWeeks.length, 0);

  const voteNo = await requestApp(app, {
    method: "POST",
    url: "/api/no-studio/gallery/react",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-no-gallery-anon-id": "viewer-a",
    },
    body: {
      id: post.json.item.id,
      reaction: "no",
    },
  });
  assert.equal(voteNo.status, 200);
  assert.equal(voteNo.json.item.noCount, 1);
  assert.equal(voteNo.json.item.yesCount, 0);
  assert.equal(voteNo.json.item.viewerReaction, "no");

  const voteYes = await requestApp(app, {
    method: "POST",
    url: "/api/no-studio/gallery/react",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-no-gallery-anon-id": "viewer-a",
    },
    body: {
      id: post.json.item.id,
      reaction: "yes",
    },
  });
  assert.equal(voteYes.status, 200);
  assert.equal(voteYes.json.item.noCount, 0);
  assert.equal(voteYes.json.item.yesCount, 1);
  assert.equal(voteYes.json.item.viewerReaction, "yes");

  const top = await requestApp(app, {
    method: "GET",
    url: `/api/no-studio/gallery/week/${encodeURIComponent(post.json.item.weekId)}?limit=12&sort=top`,
    headers: {
      "x-no-gallery-anon-id": "viewer-a",
    },
  });
  assert.equal(top.status, 200);
  assert.equal(top.json.items[0].yesCount, 1);
  assert.equal(top.json.items[0].viewerReaction, "yes");
}));

test("gallery api archives expired weeks and opens a new live week on the next save", async () => withTempApp(async (app, ctx) => {
  if (!DatabaseSync) {
    throw new Error("node:sqlite is required for weekly gallery API tests");
  }

  const first = await requestApp(app, {
    method: "POST",
    url: "/api/no-studio/gallery",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: {
      tokenId: 7804,
      family: "mono",
      mediaType: "png",
      mediaDataUrl: PNG_DATA_URL,
      palette: ["#112233", "#8899AA"],
      rolePair: {
        background: "#111111",
        figure: "#151515",
        mode: "exact",
      },
      provenance: {
        outputSignature: "week-api-a",
      },
    },
  });

  assert.equal(first.status, 200);
  const firstWeekId = first.json.item.weekId;

  const db = new DatabaseSync(ctx.galleryDbPath);
  try {
    db.prepare("UPDATE gallery_weeks SET ends_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", firstWeekId);
  } finally {
    db.close();
  }

  const archivedHome = await requestApp(app, {
    method: "GET",
    url: "/api/no-studio/gallery/home?sort=new&liveLimit=12&archiveLimit=12",
  });
  assert.equal(archivedHome.status, 200);
  assert.equal(archivedHome.json.liveWeek, null);
  assert.equal(archivedHome.json.archiveWeeks.length, 1);
  assert.equal(archivedHome.json.archiveWeeks[0].weekId, firstWeekId);

  const second = await requestApp(app, {
    method: "POST",
    url: "/api/no-studio/gallery",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: {
      tokenId: 52,
      family: "pastel",
      mediaType: "png",
      mediaDataUrl: PNG_DATA_URL,
      palette: ["#DDEEFF", "#AACCEE"],
      rolePair: {
        background: "#F1F1F1",
        figure: "#F5F5F5",
        mode: "exact",
      },
      provenance: {
        outputSignature: "week-api-b",
      },
    },
  });

  assert.equal(second.status, 200);
  assert.notEqual(second.json.item.weekId, firstWeekId);

  const liveHome = await requestApp(app, {
    method: "GET",
    url: "/api/no-studio/gallery/home?sort=new&liveLimit=12&archiveLimit=12",
  });
  assert.equal(liveHome.status, 200);
  assert.equal(liveHome.json.liveWeek.weekId, second.json.item.weekId);
  assert.equal(liveHome.json.archiveWeeks[0].weekId, firstWeekId);

  const archivedWeek = await requestApp(app, {
    method: "GET",
    url: `/api/no-studio/gallery/week/${encodeURIComponent(firstWeekId)}?sort=top&limit=12`,
  });
  assert.equal(archivedWeek.status, 200);
  assert.equal(archivedWeek.json.week.weekState, "archived");
  assert.equal(archivedWeek.json.items[0].id, first.json.item.id);

  const archivedReaction = await requestApp(app, {
    method: "POST",
    url: "/api/no-studio/gallery/react",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-no-gallery-anon-id": "viewer-archive",
    },
    body: {
      id: first.json.item.id,
      reaction: "no",
    },
  });
  assert.equal(archivedReaction.status, 409);
  assert.match(archivedReaction.json.error, /read-only/i);
}));

test("gallery api rate limits non-deduped write bursts", async () => withTempApp(async (app) => {
  const first = await requestApp(app, {
    method: "POST",
    url: "/api/no-studio/gallery",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: {
      tokenId: 7804,
      family: "mono",
      mediaType: "png",
      mediaDataUrl: PNG_DATA_URL,
      palette: ["#112233", "#8899AA"],
      rolePair: {
        background: "#111111",
        figure: "#151515",
        mode: "exact",
      },
      provenance: {
        outputSignature: "rate-limit-a",
      },
    },
  });
  assert.equal(first.status, 200);

  const second = await requestApp(app, {
    method: "POST",
    url: "/api/no-studio/gallery",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: {
      tokenId: 7804,
      family: "mono",
      mediaType: "png",
      mediaDataUrl: PNG_DATA_URL,
      palette: ["#223344", "#99AABB"],
      rolePair: {
        background: "#212121",
        figure: "#252525",
        mode: "exact",
      },
      provenance: {
        outputSignature: "rate-limit-b",
      },
    },
  });

  assert.equal(second.status, 429);
  assert.match(second.json.error, /rate limit/i);
}, {
  GLOBAL_GALLERY_ENABLED: "1",
  GALLERY_RATE_LIMIT_MAX: "1",
  GALLERY_RATE_LIMIT_WINDOW_MS: "60000",
}));
