"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const FAMILY_LABELS = {
  mono: "Mono",
  chrome: "Chrome",
  pop: "Pop",
  warhol: "Pop",
  acid: "Acid",
  pastel: "Pastel",
};

function sanitizeText(value, maxLength = 140) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeSignatureHandle(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .slice(0, 15);
  return cleaned ? `@${cleaned}` : "";
}

function sanitizeHexColor(value) {
  const raw = String(value || "").trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(raw) ? raw : null;
}

function sanitizePalette(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const dedupe = new Set();
  for (const entry of value) {
    const hex = sanitizeHexColor(entry);
    if (!hex || dedupe.has(hex)) continue;
    dedupe.add(hex);
    out.push(hex);
    if (out.length >= 64) break;
  }
  return out;
}

function sanitizeCuratedPaletteMap(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [source, target] of Object.entries(value)) {
    const sourceHex = sanitizeHexColor(source);
    const targetHex = sanitizeHexColor(target);
    if (!sourceHex || !targetHex) continue;
    out[sourceHex] = targetHex;
  }
  return out;
}

function normalizeFamilyId(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "noir") return "chrome";
  if (raw === "warhol") return "pop";
  return FAMILY_LABELS[raw] ? raw : "mono";
}

function normalizeMediaType(value) {
  return String(value || "").trim().toLowerCase() === "gif" ? "gif" : "png";
}

function publicLabel(tokenId, familyId, signatureHandle) {
  const familyLabel = FAMILY_LABELS[familyId] || "Studio";
  const handle = sanitizeSignatureHandle(signatureHandle);
  return handle
    ? `#${Number(tokenId) || 0} · ${familyLabel} · ${handle}`
    : `#${Number(tokenId) || 0} · ${familyLabel}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashString(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hashBuffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((entry) => Number(entry).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function extractPaletteFromPng(buffer, limit = 64) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return [];
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) return [];

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let paletteTable = null;
  const idatParts = [];

  for (let offset = 8; offset + 8 <= buffer.length;) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const crcEnd = dataEnd + 4;
    if (dataEnd > buffer.length || crcEnd > buffer.length) return [];
    const chunkData = buffer.subarray(dataStart, dataEnd);
    if (chunkType === "IHDR" && chunkData.length >= 13) {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlace = chunkData[12];
    } else if (chunkType === "PLTE") {
      paletteTable = chunkData;
    } else if (chunkType === "IDAT") {
      idatParts.push(chunkData);
    } else if (chunkType === "IEND") {
      break;
    }
    offset = crcEnd;
  }

  if (!width || !height || !idatParts.length || interlace !== 0 || bitDepth !== 8) return [];
  const bytesPerPixel = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4,
  }[colorType];
  if (!bytesPerPixel) return [];

  let inflated;
  try {
    inflated = require("zlib").inflateSync(Buffer.concat(idatParts));
  } catch {
    return [];
  }
  const rowLen = width * bytesPerPixel;
  const expectedMin = (rowLen + 1) * height;
  if (inflated.length < expectedMin) return [];

  const out = [];
  const seen = new Set();
  const addHex = (r, g, b, alpha = 255) => {
    if (alpha === 0) return;
    const hex = rgbToHex(r, g, b);
    if (seen.has(hex)) return;
    seen.add(hex);
    out.push(hex);
  };

  let pos = 0;
  let prev = new Uint8Array(rowLen);
  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[pos];
    pos += 1;
    if (pos + rowLen > inflated.length) return [];
    const rowIn = inflated.subarray(pos, pos + rowLen);
    pos += rowLen;
    const rowOut = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i += 1) {
      const raw = rowIn[i];
      const left = i >= bytesPerPixel ? rowOut[i - bytesPerPixel] : 0;
      const up = prev[i] || 0;
      const upLeft = i >= bytesPerPixel ? (prev[i - bytesPerPixel] || 0) : 0;
      if (filterType === 0) rowOut[i] = raw;
      else if (filterType === 1) rowOut[i] = (raw + left) & 0xff;
      else if (filterType === 2) rowOut[i] = (raw + up) & 0xff;
      else if (filterType === 3) rowOut[i] = (raw + Math.floor((left + up) / 2)) & 0xff;
      else if (filterType === 4) rowOut[i] = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      else return [];
    }

    for (let x = 0; x < width; x += 1) {
      const base = x * bytesPerPixel;
      if (colorType === 6) addHex(rowOut[base], rowOut[base + 1], rowOut[base + 2], rowOut[base + 3]);
      else if (colorType === 2) addHex(rowOut[base], rowOut[base + 1], rowOut[base + 2], 255);
      else if (colorType === 4) addHex(rowOut[base], rowOut[base], rowOut[base], rowOut[base + 1]);
      else if (colorType === 0) addHex(rowOut[base], rowOut[base], rowOut[base], 255);
      else if (colorType === 3) {
        const idx = rowOut[base] * 3;
        if (!paletteTable || idx + 2 >= paletteTable.length) continue;
        addHex(paletteTable[idx], paletteTable[idx + 1], paletteTable[idx + 2], 255);
      }
      if (out.length >= limit) return out;
    }
    prev = rowOut;
  }
  return out;
}

function inferPaletteFromMediaBuffer(buffer, mediaType) {
  if (normalizeMediaType(mediaType) === "png") {
    return sanitizePalette(extractPaletteFromPng(buffer, 64));
  }
  return [];
}

function parseMediaDataUrl(value) {
  const match = /^data:image\/(png|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(String(value || "").trim());
  if (!match) return null;
  return {
    mediaType: normalizeMediaType(match[1]),
    buffer: Buffer.from(match[2], "base64"),
  };
}

function galleryItemUrls(fileName, useNoStudioPrefix) {
  const prefix = useNoStudioPrefix ? "/api/no-studio" : "/api/no-palette";
  const encoded = encodeURIComponent(fileName);
  const mediaUrl = `${prefix}/gallery/files/${encoded}`;
  const mediaType = normalizeMediaType(path.extname(fileName).slice(1));
  return {
    previewUrl: mediaUrl,
    mediaUrl,
    thumbUrl: mediaUrl,
    viewUrl: mediaUrl,
    pngUrl: mediaType === "png" ? mediaUrl : null,
    gifUrl: mediaType === "gif" ? mediaUrl : null,
    mediaType,
  };
}

const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const VIEWER_BATCH_SIZE = 120;

function safeJsonParseArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonParseObject(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isoAfterMs(value, ms) {
  const base = Date.parse(String(value || ""));
  const safeBase = Number.isFinite(base) ? base : Date.now();
  return new Date(safeBase + ms).toISOString();
}

function weekStateFromRow(row) {
  return row && row.week_closed_at ? "archived" : "live";
}

function archiveCoverEntriesFromRow(row) {
  return safeJsonParseArray(row?.cover_entry_ids_json).map((value) => String(value || "")).filter(Boolean);
}

function rowToItem(row, useNoStudioPrefix, viewerReactions = null) {
  const fileName = String(row.file_name || "");
  const familyId = normalizeFamilyId(row.family_id);
  const palette = sanitizePalette(safeJsonParseArray(row.palette_json));
  const rolePair = row.role_pair_background || row.role_pair_figure
    ? {
        background: sanitizeHexColor(row.role_pair_background),
        figure: sanitizeHexColor(row.role_pair_figure),
        mode: sanitizeText(row.role_pair_mode, 16) || "exact",
      }
    : null;
  const viewerReaction = viewerReactions instanceof Map ? viewerReactions.get(String(row.id)) || null : null;
  const noCount = Number(row.no_count) || 0;
  const yesCount = Number(row.yes_count) || 0;
  const score = noCount - yesCount;
  return {
    id: String(row.id),
    tokenId: Number(row.token_id) || 0,
    family: familyId,
    familyId,
    label: publicLabel(row.token_id, familyId, row.signature_handle),
    title: publicLabel(row.token_id, familyId, row.signature_handle),
    createdAt: row.created_at,
    signatureHandle: sanitizeSignatureHandle(row.signature_handle),
    voteCount: noCount,
    noCount,
    yesCount,
    score,
    viewerReaction,
    viewerHasVoted: Boolean(viewerReaction),
    palette,
    paletteSignature: String(row.palette_signature || ""),
    sourcePaletteSignature: String(row.source_palette_signature || ""),
    weekId: sanitizeText(row.week_id, 64),
    weekState: weekStateFromRow(row),
    weekStartedAt: row.week_started_at || null,
    weekEndsAt: row.week_ends_at || null,
    weekClosedAt: row.week_closed_at || null,
    rolePair,
    variantSeed: String(row.variant_seed || ""),
    variantPage: Number(row.variant_page) || 0,
    schemaVersion: 4,
    global: true,
    provenance: {
      variantSeed: String(row.variant_seed || ""),
      variantPage: Number(row.variant_page) || 0,
      curatedPaletteMap: sanitizeCuratedPaletteMap(safeJsonParseObject(row.curated_map_json)),
      familyModifiers: safeJsonParseObject(row.family_modifiers_json),
      globalModifiers: safeJsonParseObject(row.global_modifiers_json),
      sourcePaletteSignature: String(row.source_palette_signature || ""),
      outputSignature: String(row.output_signature || ""),
    },
    ...galleryItemUrls(fileName, useNoStudioPrefix),
  };
}

class GalleryStore {
  constructor(options = {}) {
    if (!DatabaseSync) {
      throw new Error("node:sqlite is required for the shared global gallery");
    }
    this.dbPath = options.dbPath;
    this.galleryRoot = options.galleryRoot;
    this.maxEntries = Math.max(120, Number(options.maxEntries) || 4000);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.mkdirSync(this.galleryRoot, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.migrate();
    this.prepare();
    this._migrateLegacyWeeks();
    this._recountReactionTotals();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gallery_weeks (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        closed_at TEXT,
        cover_file_name TEXT,
        cover_generated_at TEXT,
        cover_entry_ids_json TEXT NOT NULL DEFAULT '[]'
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gallery_entries (
        id TEXT PRIMARY KEY,
        week_id TEXT,
        token_id INTEGER NOT NULL,
        family_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        file_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        signature_handle TEXT,
        palette_json TEXT NOT NULL,
        palette_signature TEXT NOT NULL,
        source_palette_signature TEXT,
        role_pair_background TEXT,
        role_pair_figure TEXT,
        role_pair_mode TEXT,
        variant_seed TEXT,
        variant_page INTEGER,
        curated_map_json TEXT,
        family_modifiers_json TEXT,
        global_modifiers_json TEXT,
        output_signature TEXT,
        no_count INTEGER NOT NULL DEFAULT 0,
        yes_count INTEGER NOT NULL DEFAULT 0,
        vote_count INTEGER NOT NULL DEFAULT 0,
        dedupe_key TEXT NOT NULL UNIQUE,
        FOREIGN KEY(week_id) REFERENCES gallery_weeks(id) ON DELETE SET NULL
      );
    `);
    try {
      this.db.exec("ALTER TABLE gallery_entries ADD COLUMN week_id TEXT;");
    } catch {}
    try {
      this.db.exec("ALTER TABLE gallery_entries ADD COLUMN no_count INTEGER NOT NULL DEFAULT 0;");
    } catch {}
    try {
      this.db.exec("ALTER TABLE gallery_entries ADD COLUMN yes_count INTEGER NOT NULL DEFAULT 0;");
    } catch {}
    try {
      this.db.exec("ALTER TABLE gallery_entries ADD COLUMN vote_count INTEGER NOT NULL DEFAULT 0;");
    } catch {}
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gallery_votes (
        entry_id TEXT NOT NULL,
        viewer_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (entry_id, viewer_id),
        FOREIGN KEY(entry_id) REFERENCES gallery_entries(id) ON DELETE CASCADE
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gallery_reactions (
        entry_id TEXT NOT NULL,
        viewer_id TEXT NOT NULL,
        reaction TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (entry_id, viewer_id),
        FOREIGN KEY(entry_id) REFERENCES gallery_entries(id) ON DELETE CASCADE
      );
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_created_at ON gallery_entries(created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_week_id ON gallery_entries(week_id, created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_votes_count ON gallery_entries(vote_count DESC, created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_reaction_score ON gallery_entries((no_count - yes_count) DESC, no_count DESC, created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_family_id ON gallery_entries(family_id, created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_token_id ON gallery_entries(token_id, created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_media_type ON gallery_entries(media_type, created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_signature_handle ON gallery_entries(signature_handle, created_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_weeks_started_at ON gallery_weeks(started_at DESC);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_reactions_viewer ON gallery_reactions(viewer_id, entry_id);");
    this.db.exec("UPDATE gallery_entries SET no_count = vote_count WHERE (no_count IS NULL OR no_count = 0) AND vote_count > 0;");
    try {
      this.db.exec(`
        INSERT OR IGNORE INTO gallery_reactions (entry_id, viewer_id, reaction, created_at, updated_at)
        SELECT entry_id, viewer_id, 'no', created_at, created_at
        FROM gallery_votes
      `);
    } catch {}
  }

  prepare() {
    this.stmts = {
      insertWeek: this.db.prepare(`
        INSERT INTO gallery_weeks (
          id, started_at, ends_at, closed_at, cover_file_name, cover_generated_at, cover_entry_ids_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      findLiveWeek: this.db.prepare(`
        SELECT *
        FROM gallery_weeks
        WHERE closed_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
      `),
      getWeekById: this.db.prepare(`
        SELECT *
        FROM gallery_weeks
        WHERE id = ?
        LIMIT 1
      `),
      closeWeek: this.db.prepare(`
        UPDATE gallery_weeks
        SET closed_at = ?, cover_generated_at = ?, cover_entry_ids_json = ?
        WHERE id = ?
      `),
      countArchivedWeeks: this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM gallery_weeks
        WHERE closed_at IS NOT NULL
      `),
      listArchivedWeeks: this.db.prepare(`
        SELECT
          w.*,
          COUNT(e.id) AS entry_count,
          MAX(e.no_count) AS top_no_count
        FROM gallery_weeks w
        LEFT JOIN gallery_entries e ON e.week_id = w.id
        WHERE w.closed_at IS NOT NULL
        GROUP BY w.id
        ORDER BY w.started_at DESC
        LIMIT ? OFFSET ?
      `),
      insertEntry: this.db.prepare(`
        INSERT INTO gallery_entries (
          id, week_id, token_id, family_id, media_type, file_name, created_at, signature_handle,
          palette_json, palette_signature, source_palette_signature, role_pair_background,
          role_pair_figure, role_pair_mode, variant_seed, variant_page, curated_map_json,
          family_modifiers_json, global_modifiers_json, output_signature, no_count, yes_count, vote_count, dedupe_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      findByDedupeKey: this.db.prepare(`
        SELECT * FROM gallery_entries WHERE dedupe_key = ? LIMIT 1
      `),
      countWeekFiltered: this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM gallery_entries
        WHERE week_id = ?
          AND (? IS NULL OR family_id = ?)
          AND (? IS NULL OR token_id = ?)
          AND (? IS NULL OR media_type = ?)
          AND (? IS NULL OR signature_handle = ?)
      `),
      listWeekFiltered: this.db.prepare(`
        SELECT
          e.*,
          w.started_at AS week_started_at,
          w.ends_at AS week_ends_at,
          w.closed_at AS week_closed_at
        FROM gallery_entries e
        JOIN gallery_weeks w ON w.id = e.week_id
        WHERE e.week_id = ?
          AND (? IS NULL OR e.family_id = ?)
          AND (? IS NULL OR e.token_id = ?)
          AND (? IS NULL OR e.media_type = ?)
          AND (? IS NULL OR e.signature_handle = ?)
        ORDER BY e.created_at DESC
        LIMIT ? OFFSET ?
      `),
      listWeekFilteredTop: this.db.prepare(`
        SELECT
          e.*,
          w.started_at AS week_started_at,
          w.ends_at AS week_ends_at,
          w.closed_at AS week_closed_at
        FROM gallery_entries e
        JOIN gallery_weeks w ON w.id = e.week_id
        WHERE e.week_id = ?
          AND (? IS NULL OR e.family_id = ?)
          AND (? IS NULL OR e.token_id = ?)
          AND (? IS NULL OR e.media_type = ?)
          AND (? IS NULL OR e.signature_handle = ?)
        ORDER BY (e.no_count - e.yes_count) DESC, e.no_count DESC, e.created_at DESC
        LIMIT ? OFFSET ?
      `),
      topWeekEntries: this.db.prepare(`
        SELECT
          e.*,
          w.started_at AS week_started_at,
          w.ends_at AS week_ends_at,
          w.closed_at AS week_closed_at
        FROM gallery_entries e
        JOIN gallery_weeks w ON w.id = e.week_id
        WHERE e.week_id = ?
        ORDER BY (e.no_count - e.yes_count) DESC, e.no_count DESC, e.created_at DESC
        LIMIT 9
      `),
      getEntryWithWeek: this.db.prepare(`
        SELECT
          e.*,
          w.started_at AS week_started_at,
          w.ends_at AS week_ends_at,
          w.closed_at AS week_closed_at
        FROM gallery_entries e
        LEFT JOIN gallery_weeks w ON w.id = e.week_id
        WHERE e.id = ?
        LIMIT 1
      `),
      findReaction: this.db.prepare(`
        SELECT reaction
        FROM gallery_reactions
        WHERE entry_id = ? AND viewer_id = ?
        LIMIT 1
      `),
      upsertReaction: this.db.prepare(`
        INSERT INTO gallery_reactions (entry_id, viewer_id, reaction, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(entry_id, viewer_id)
        DO UPDATE SET reaction = excluded.reaction, updated_at = excluded.updated_at
      `),
      selectReactionsForViewer: this.db.prepare(`
        SELECT entry_id, reaction
        FROM gallery_reactions
        WHERE viewer_id = ?
          AND entry_id IN (${Array.from({ length: VIEWER_BATCH_SIZE }, () => "?").join(",")})
      `),
      setEntryCounts: this.db.prepare(`
        UPDATE gallery_entries
        SET no_count = ?, yes_count = ?, vote_count = ?
        WHERE id = ?
      `),
      deleteOverflow: this.db.prepare(`
        SELECT id, file_name
        FROM gallery_entries
        ORDER BY created_at DESC
        LIMIT -1 OFFSET ?
      `),
      deleteById: this.db.prepare(`DELETE FROM gallery_entries WHERE id = ?`),
      selectAll: this.db.prepare(`SELECT * FROM gallery_entries ORDER BY created_at DESC`),
      legacyEntriesWithoutWeek: this.db.prepare(`
        SELECT MIN(created_at) AS first_created_at, COUNT(*) AS count
        FROM gallery_entries
        WHERE week_id IS NULL OR week_id = ''
      `),
      assignLegacyWeek: this.db.prepare(`
        UPDATE gallery_entries
        SET week_id = ?
        WHERE week_id IS NULL OR week_id = ''
      `),
    };
  }

  close() {
    this.db.close();
  }

  _migrateLegacyWeeks() {
    const row = this.stmts?.legacyEntriesWithoutWeek?.get();
    const count = Number(row?.count) || 0;
    if (!count) return;
    const startedAt = row?.first_created_at || new Date().toISOString();
    const id = `legacy-${hashString(startedAt).slice(0, 12)}`;
    if (!this.stmts.getWeekById.get(id)) {
      this.stmts.insertWeek.run(
        id,
        startedAt,
        isoAfterMs(startedAt, WEEK_WINDOW_MS),
        new Date().toISOString(),
        null,
        new Date().toISOString(),
        JSON.stringify([]),
      );
    }
    this.stmts.assignLegacyWeek.run(id);
  }

  _recountReactionTotals() {
    this.db.exec(`
      UPDATE gallery_entries
      SET
        no_count = COALESCE((
          SELECT COUNT(*)
          FROM gallery_reactions r
          WHERE r.entry_id = gallery_entries.id
            AND r.reaction = 'no'
        ), 0),
        yes_count = COALESCE((
          SELECT COUNT(*)
          FROM gallery_reactions r
          WHERE r.entry_id = gallery_entries.id
            AND r.reaction = 'yes'
        ), 0)
    `);
    this.db.exec("UPDATE gallery_entries SET vote_count = no_count;");
  }

  buildDedupeKey(payload) {
    return hashString(stableStringify({
      weekId: String(payload.weekId || ""),
      tokenId: Number(payload.tokenId) || 0,
      familyId: normalizeFamilyId(payload.familyId),
      mediaType: normalizeMediaType(payload.mediaType),
      paletteSignature: String(payload.paletteSignature || ""),
      sourcePaletteSignature: String(payload.sourcePaletteSignature || ""),
      rolePair: payload.rolePair || null,
      variantSeed: String(payload.variantSeed || ""),
      variantPage: Number(payload.variantPage) || 0,
      curatedPaletteMap: sanitizeCuratedPaletteMap(payload.curatedPaletteMap),
      outputSignature: String(payload.outputSignature || ""),
      mediaHash: String(payload.mediaHash || ""),
    }));
  }

  _ensureLiveWeek({ createIfMissing = false } = {}) {
    const nowIso = new Date().toISOString();
    const liveWeek = this.stmts.findLiveWeek.get();
    if (liveWeek) {
      const endsAtMs = Date.parse(String(liveWeek.ends_at || ""));
      if (Number.isFinite(endsAtMs) && Date.now() >= endsAtMs) {
        this._closeWeek(String(liveWeek.id));
      } else {
        return liveWeek;
      }
    }
    if (!createIfMissing) return null;
    const id = `week-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const startedAt = nowIso;
    const endsAt = isoAfterMs(startedAt, WEEK_WINDOW_MS);
    this.stmts.insertWeek.run(
      id,
      startedAt,
      endsAt,
      null,
      null,
      null,
      JSON.stringify([]),
    );
    return this.stmts.getWeekById.get(id);
  }

  _closeWeek(weekId) {
    const row = this.stmts.getWeekById.get(weekId);
    if (!row || row.closed_at) return row;
    const coverEntries = this.stmts.topWeekEntries.all(weekId);
    const coverEntryIds = coverEntries.map((entry) => String(entry.id || "")).filter(Boolean).slice(0, 9);
    const closedAt = row.ends_at || new Date().toISOString();
    const generatedAt = new Date().toISOString();
    this.stmts.closeWeek.run(closedAt, generatedAt, JSON.stringify(coverEntryIds), weekId);
    return this.stmts.getWeekById.get(weekId);
  }

  _listViewerReactions(entryIds = [], viewerId = "") {
    const safeViewerId = sanitizeText(viewerId, 128);
    if (!safeViewerId || !entryIds.length) return null;
    const paddedIds = entryIds.map((id) => String(id || "")).slice(0, VIEWER_BATCH_SIZE);
    while (paddedIds.length < VIEWER_BATCH_SIZE) paddedIds.push("");
    return new Map(
      this.stmts.selectReactionsForViewer
        .all(safeViewerId, ...paddedIds)
        .map((row) => [String(row.entry_id || ""), String(row.reaction || "")]),
    );
  }

  _listWeekEntries(weekId, {
    limit = 18,
    offset = 0,
    family = null,
    tokenId = null,
    mediaType = null,
    signature = null,
    sort = "new",
    viewerId = null,
    useNoStudioPrefix = true,
  } = {}) {
    if (!weekId) {
      return {
        ok: true,
        count: 0,
        offset: 0,
        nextOffset: null,
        items: [],
        global: true,
        storage: "sqlite",
        sort: String(sort || "new"),
      };
    }
    const normalizedFamily = family == null ? null : normalizeFamilyId(family);
    const normalizedTokenId = tokenId == null ? null : Number(tokenId);
    const normalizedMediaType = mediaType == null ? null : normalizeMediaType(mediaType);
    const normalizedSignature = signature == null ? null : sanitizeSignatureHandle(signature);
    const normalizedSort = String(sort || "new").toLowerCase() === "top" ? "top" : "new";
    const max = Math.max(1, Math.min(120, Number(limit) || 18));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const countRow = this.stmts.countWeekFiltered.get(
      weekId,
      normalizedFamily, normalizedFamily,
      normalizedTokenId, normalizedTokenId,
      normalizedMediaType, normalizedMediaType,
      normalizedSignature, normalizedSignature,
    );
    const rows = (normalizedSort === "top" ? this.stmts.listWeekFilteredTop : this.stmts.listWeekFiltered).all(
      weekId,
      normalizedFamily, normalizedFamily,
      normalizedTokenId, normalizedTokenId,
      normalizedMediaType, normalizedMediaType,
      normalizedSignature, normalizedSignature,
      max, safeOffset,
    );
    const viewerReactions = this._listViewerReactions(rows.map((row) => row.id), viewerId);
    const items = rows.map((row) => rowToItem(row, useNoStudioPrefix, viewerReactions));
    const count = Number(countRow?.count) || 0;
    return {
      ok: true,
      count,
      offset: safeOffset,
      nextOffset: safeOffset + items.length < count ? safeOffset + items.length : null,
      items,
      global: true,
      storage: "sqlite",
      sort: normalizedSort,
    };
  }

  ensureWithinLimit() {
    const overflow = this.stmts.deleteOverflow.all(this.maxEntries);
    for (const row of overflow) {
      const fileName = String(row.file_name || "");
      const filePath = path.join(this.galleryRoot, fileName);
      this.stmts.deleteById.run(String(row.id));
      if (filePath.startsWith(this.galleryRoot) && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore cleanup failures
        }
      }
    }
  }

  listEntries({ limit = 18, offset = 0, family = null, tokenId = null, mediaType = null, signature = null, sort = "new", viewerId = null, useNoStudioPrefix = true } = {}) {
    const liveWeek = this._ensureLiveWeek({ createIfMissing: false });
    const payload = this._listWeekEntries(liveWeek?.id || null, {
      limit,
      offset,
      family,
      tokenId,
      mediaType,
      signature,
      sort,
      viewerId,
      useNoStudioPrefix,
    });
    return {
      ...payload,
      liveWeek: liveWeek
        ? {
            weekId: String(liveWeek.id),
            startedAt: liveWeek.started_at,
            endsAt: liveWeek.ends_at,
            closedAt: liveWeek.closed_at || null,
            weekState: "live",
          }
        : null,
    };
  }

  getHome({ sort = "new", viewerId = null, liveLimit = 120, archiveLimit = 24, useNoStudioPrefix = true } = {}) {
    const liveWeek = this._ensureLiveWeek({ createIfMissing: false });
    const livePayload = liveWeek
      ? this._listWeekEntries(liveWeek.id, {
          limit: liveLimit,
          sort,
          viewerId,
          useNoStudioPrefix,
        })
      : {
          ok: true,
          count: 0,
          items: [],
          sort: String(sort || "new").toLowerCase() === "top" ? "top" : "new",
        };
    const safeArchiveLimit = Math.max(1, Math.min(52, Number(archiveLimit) || 24));
    const rows = this.stmts.listArchivedWeeks.all(safeArchiveLimit, 0);
    const archiveWeeks = rows.map((row) => {
      const coverEntryIds = archiveCoverEntriesFromRow(row);
      const coverRows = coverEntryIds.length
        ? coverEntryIds.map((entryId) => this.stmts.getEntryWithWeek.get(entryId)).filter(Boolean)
        : this.stmts.topWeekEntries.all(String(row.id));
      return {
        weekId: String(row.id),
        startedAt: row.started_at,
        endsAt: row.ends_at,
        closedAt: row.closed_at,
        weekState: "archived",
        coverUrl: null,
        coverEntries: coverRows.map((entry) => rowToItem(entry, useNoStudioPrefix)),
        entryCount: Number(row.entry_count) || 0,
        topNoCount: Number(row.top_no_count) || 0,
      };
    });
    return {
      ok: true,
      storage: "sqlite",
      global: true,
      count: livePayload.count || 0,
      items: livePayload.items || [],
      sort: livePayload.sort || (String(sort || "new").toLowerCase() === "top" ? "top" : "new"),
      liveWeek: liveWeek
        ? {
          weekId: String(liveWeek.id),
          startedAt: liveWeek.started_at,
          endsAt: liveWeek.ends_at,
            closedAt: liveWeek.closed_at || null,
            weekState: "live",
            count: livePayload.count,
            sort: livePayload.sort,
            items: livePayload.items,
          }
        : null,
      activeWeek: liveWeek
        ? {
          weekId: String(liveWeek.id),
          startedAt: liveWeek.started_at,
          endsAt: liveWeek.ends_at,
          closedAt: liveWeek.closed_at || null,
          weekState: "live",
        }
        : null,
      archiveWeeks,
      archives: archiveWeeks,
    };
  }

  getWeekDetail(weekId, {
    sort = "new",
    limit = 120,
    offset = 0,
    viewerId = null,
    useNoStudioPrefix = true,
  } = {}) {
    const safeWeekId = sanitizeText(weekId, 64);
    const week = this.stmts.getWeekById.get(safeWeekId);
    if (!week) {
      const error = new Error("Gallery week not found");
      error.statusCode = 404;
      throw error;
    }
    if (!week.closed_at) {
      const refreshed = this._ensureLiveWeek({ createIfMissing: false });
      if (!refreshed || String(refreshed.id) !== safeWeekId) {
        const closed = this._closeWeek(safeWeekId);
        if (closed) {
          return this.getWeekDetail(safeWeekId, { sort, limit, offset, viewerId, useNoStudioPrefix });
        }
      }
    }
    const payload = this._listWeekEntries(safeWeekId, {
      sort,
      limit,
      offset,
      viewerId,
      useNoStudioPrefix,
    });
    return {
      ...payload,
      week: {
        weekId: String(week.id),
        startedAt: week.started_at,
        endsAt: week.ends_at,
        closedAt: week.closed_at || null,
        weekState: week.closed_at ? "archived" : "live",
      },
    };
  }

  saveEntry(body = {}, { useNoStudioPrefix = true } = {}) {
    const media = parseMediaDataUrl(body.mediaDataUrl || body.pngDataUrl || body.gifDataUrl || "");
    if (!media) {
      throw new Error("Invalid media payload");
    }
    if (!media.buffer.length) {
      throw new Error("Empty media payload");
    }
    if (media.mediaType === "gif" && media.buffer.length > 24_000_000) {
      throw new Error("GIF too large");
    }
    if (media.mediaType === "png" && media.buffer.length > 8_000_000) {
      throw new Error("PNG too large");
    }

    const tokenId = Number(body.tokenId) || 0;
    const familyId = normalizeFamilyId(body.family);
    const signatureHandle = sanitizeSignatureHandle(body.signatureHandle || body.signature || body.twitterHandle || "");
    const provenance = body.provenance && typeof body.provenance === "object" ? body.provenance : {};
    const palette = sanitizePalette(body.palette || body.paletteHexes || inferPaletteFromMediaBuffer(media.buffer, media.mediaType));
    const rolePair = body.rolePair && typeof body.rolePair === "object"
      ? {
          background: sanitizeHexColor(body.rolePair.background),
          figure: sanitizeHexColor(body.rolePair.figure),
          mode: sanitizeText(body.rolePair.mode, 16) || "exact",
        }
      : null;
    const paletteSignature = hashString(palette.join("|"));
    const mediaHash = hashBuffer(media.buffer);
    const sourcePaletteSignature = sanitizeText(provenance.sourcePaletteSignature, 128);
    const variantSeed = sanitizeText(provenance.variantSeed, 128);
    const variantPage = Math.max(0, Number(provenance.variantPage) || 0);
    const curatedPaletteMap = sanitizeCuratedPaletteMap(provenance.curatedPaletteMap);
    const familyModifiers = provenance.familyModifiers && typeof provenance.familyModifiers === "object" ? provenance.familyModifiers : {};
    const globalModifiers = provenance.globalModifiers && typeof provenance.globalModifiers === "object" ? provenance.globalModifiers : {};
    const outputSignature = sanitizeText(provenance.outputSignature, 255);
    const liveWeek = this._ensureLiveWeek({ createIfMissing: true });
    const weekId = String(liveWeek?.id || "");

    const dedupeKey = this.buildDedupeKey({
      weekId,
      tokenId,
      familyId,
      mediaType: media.mediaType,
      paletteSignature,
      sourcePaletteSignature,
      rolePair,
      variantSeed,
      variantPage,
      curatedPaletteMap,
      outputSignature,
      mediaHash,
    });

    const existing = this.stmts.findByDedupeKey.get(dedupeKey);
    if (existing) {
      return {
        ok: true,
        item: rowToItem(existing, useNoStudioPrefix),
        deduped: true,
        global: true,
      };
    }

    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const fileName = `no-gallery-${id}.${media.mediaType}`;
    const filePath = path.join(this.galleryRoot, fileName);
    if (!filePath.startsWith(this.galleryRoot)) {
      throw new Error("Invalid gallery path");
    }
    fs.writeFileSync(filePath, media.buffer);
    const createdAt = new Date().toISOString();

    this.stmts.insertEntry.run(
      id,
      weekId,
      tokenId,
      familyId,
      media.mediaType,
      fileName,
      createdAt,
      signatureHandle,
      JSON.stringify(palette),
      paletteSignature,
      sourcePaletteSignature || "",
      rolePair?.background || null,
      rolePair?.figure || null,
      rolePair?.mode || null,
      variantSeed || "",
      variantPage,
      JSON.stringify(curatedPaletteMap),
      JSON.stringify(familyModifiers),
      JSON.stringify(globalModifiers),
      outputSignature || "",
      0,
      0,
      0,
      dedupeKey,
    );
    this.ensureWithinLimit();
    return {
      ok: true,
      item: rowToItem(this.stmts.getEntryWithWeek.get(id), useNoStudioPrefix),
      global: true,
    };
  }

  reactEntry(id, viewerId, reaction = "no", { useNoStudioPrefix = true } = {}) {
    const entryId = sanitizeText(id, 128);
    const safeViewerId = sanitizeText(viewerId, 128);
    const safeReaction = String(reaction || "").trim().toLowerCase() === "yes" ? "yes" : "no";
    if (!entryId) {
      const error = new Error("Missing gallery id");
      error.statusCode = 400;
      throw error;
    }
    if (!safeViewerId) {
      const error = new Error("Missing viewer id");
      error.statusCode = 400;
      throw error;
    }
    const existingEntry = this.stmts.getEntryWithWeek.get(entryId);
    if (!existingEntry) {
      const error = new Error("Gallery entry not found");
      error.statusCode = 404;
      throw error;
    }
    if (existingEntry.week_closed_at) {
      const error = new Error("Archived weeks are read-only");
      error.statusCode = 409;
      throw error;
    }
    const existingReaction = this.stmts.findReaction.get(entryId, safeViewerId);
    const previous = existingReaction ? String(existingReaction.reaction || "") : null;
    const nextNoCount = Math.max(0, Number(existingEntry.no_count) || 0)
      + (previous === "no" ? -1 : 0)
      + (safeReaction === "no" ? 1 : 0);
    const nextYesCount = Math.max(0, Number(existingEntry.yes_count) || 0)
      + (previous === "yes" ? -1 : 0)
      + (safeReaction === "yes" ? 1 : 0);
    const now = new Date().toISOString();
    if (previous !== safeReaction) {
      this.stmts.upsertReaction.run(entryId, safeViewerId, safeReaction, now, now);
      this.stmts.setEntryCounts.run(nextNoCount, nextYesCount, nextNoCount, entryId);
    }
    const viewerReactions = new Map([[entryId, safeReaction]]);
    return {
      ok: true,
      item: rowToItem(this.stmts.getEntryWithWeek.get(entryId), useNoStudioPrefix, viewerReactions),
      deduped: previous === safeReaction,
      global: true,
    };
  }

  voteEntry(id, viewerId, { useNoStudioPrefix = true } = {}) {
    return this.reactEntry(id, viewerId, "no", { useNoStudioPrefix });
  }

  migrateJsonIndex({ jsonPath, useNoStudioPrefix = true } = {}) {
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      return { migrated: 0, skipped: 0 };
    }
    const parsed = readJson(jsonPath);
    const entries = Array.isArray(parsed) ? parsed : [];
    let migrated = 0;
    let skipped = 0;

    for (const entry of entries) {
      const fileName = String(entry.fileName || "");
      if (!/^[a-zA-Z0-9._-]+\.(png|gif)$/i.test(fileName)) {
        skipped += 1;
        continue;
      }
      const filePath = path.join(this.galleryRoot, fileName);
      if (!filePath.startsWith(this.galleryRoot) || !fs.existsSync(filePath)) {
        skipped += 1;
        continue;
      }
      const mediaBuffer = fs.readFileSync(filePath);
      const mediaType = normalizeMediaType(path.extname(fileName).slice(1));
      const tokenId = Number(entry.tokenId) || 0;
      const familyId = normalizeFamilyId(entry.family);
      const signatureHandle = sanitizeSignatureHandle(entry.signatureHandle || entry.signature || entry.twitterHandle || "");
      const palette = sanitizePalette(entry.palette || entry.paletteHexes || inferPaletteFromMediaBuffer(mediaBuffer, mediaType));
      const rolePair = entry.rolePair && typeof entry.rolePair === "object"
        ? {
            background: sanitizeHexColor(entry.rolePair.background),
            figure: sanitizeHexColor(entry.rolePair.figure),
            mode: sanitizeText(entry.rolePair.mode, 16) || "exact",
          }
        : null;
      const mediaHash = hashBuffer(mediaBuffer);
      const paletteSignature = hashString(palette.join("|"));
      const legacyWeekId = `legacy-${hashString(String(entry.createdAt || "legacy")).slice(0, 12)}`;
      if (!this.stmts.getWeekById.get(legacyWeekId)) {
        const startedAt = entry.createdAt || new Date().toISOString();
        this.stmts.insertWeek.run(
          legacyWeekId,
          startedAt,
          isoAfterMs(startedAt, WEEK_WINDOW_MS),
          new Date().toISOString(),
          null,
          new Date().toISOString(),
          JSON.stringify([]),
        );
      }
      const dedupeKey = this.buildDedupeKey({
        weekId: legacyWeekId,
        tokenId,
        familyId,
        mediaType,
        paletteSignature,
        sourcePaletteSignature: "",
        rolePair,
        variantSeed: "",
        variantPage: 0,
        curatedPaletteMap: {},
        outputSignature: "",
        mediaHash,
      });
      if (this.stmts.findByDedupeKey.get(dedupeKey)) {
        skipped += 1;
        continue;
      }
      const id = sanitizeText(entry.id, 64) || `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      this.stmts.insertEntry.run(
        id,
        legacyWeekId,
        tokenId,
        familyId,
        mediaType,
        fileName,
        entry.createdAt || new Date().toISOString(),
        signatureHandle,
        JSON.stringify(palette),
        paletteSignature,
        "",
        rolePair?.background || null,
        rolePair?.figure || null,
        rolePair?.mode || null,
        "",
        0,
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify({}),
        "",
        0,
        0,
        0,
        dedupeKey,
      );
      migrated += 1;
    }
    this.ensureWithinLimit();
    return {
      migrated,
      skipped,
      global: true,
      sample: migrated ? rowToItem(this.stmts.selectAll.all()[0], useNoStudioPrefix) : null,
    };
  }
}

module.exports = {
  GalleryStore,
  sanitizeSignatureHandle,
};
