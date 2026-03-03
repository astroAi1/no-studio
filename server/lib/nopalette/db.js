"use strict";

const fs = require("fs");
const path = require("path");
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function nowIso() {
  return new Date().toISOString();
}

function isUniqueConstraintError(error) {
  if (!error) return false;
  const msg = String(error.message || "");
  return msg.includes("UNIQUE constraint failed") || msg.includes("PRIMARY KEY");
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

class NoPaletteDatabase {
  constructor() {}
}

class SqliteNoPaletteDatabase extends NoPaletteDatabase {
  constructor(options = {}) {
    super();
    this.backend = "sqlite";
    this.dbPath = options.dbPath || path.join(process.cwd(), "apps/no-meta/data/no-palette.sqlite");
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 3000;");
    this.migrate();
    this.prepareStatements();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rarity_cache (
        token_id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        rarity_rank INTEGER,
        total_supply INTEGER,
        normalized_rarity REAL NOT NULL,
        raw_json TEXT,
        fetched_at TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        token_id INTEGER NOT NULL,
        user_seed TEXT NOT NULL,
        derived_seed TEXT NOT NULL,
        tool_version TEXT NOT NULL,
        palette_signature TEXT NOT NULL,
        output_24_hash TEXT NOT NULL,
        rarity_norm REAL NOT NULL,
        rarity_source TEXT NOT NULL,
        strict_mode INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        block_number INTEGER,
        mode_id TEXT,
        output_kind TEXT,
        state_signature TEXT
      );

      CREATE TABLE IF NOT EXISTS used_colors (
        token_id INTEGER NOT NULL,
        rgb_int INTEGER NOT NULL,
        generation_id TEXT NOT NULL,
        role TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (token_id, rgb_int)
      );
    `);

    this.ensureGenerationColumn("block_number", "INTEGER");
    this.ensureGenerationColumn("mode_id", "TEXT");
    this.ensureGenerationColumn("output_kind", "TEXT");
    this.ensureGenerationColumn("state_signature", "TEXT");

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_generations_token_id ON generations(token_id);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_used_colors_token_id ON used_colors(token_id);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_generations_mode_block ON generations(token_id, mode_id, block_number);");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_state_unique ON generations(token_id, mode_id, block_number, output_kind);");
  }

  ensureGenerationColumn(columnName, columnType) {
    const rows = this.db.prepare("PRAGMA table_info(generations)").all();
    if (rows.some((row) => row.name === columnName)) return;
    this.db.exec(`ALTER TABLE generations ADD COLUMN ${columnName} ${columnType}`);
  }

  prepareStatements() {
    this.stmts = {
      getRarityCache: this.db.prepare(
        `SELECT token_id, source, rarity_rank, total_supply, normalized_rarity, raw_json, fetched_at, expires_at
         FROM rarity_cache WHERE token_id = ?`
      ),
      upsertRarityCache: this.db.prepare(
        `INSERT INTO rarity_cache (
          token_id, source, rarity_rank, total_supply, normalized_rarity, raw_json, fetched_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          source = excluded.source,
          rarity_rank = excluded.rarity_rank,
          total_supply = excluded.total_supply,
          normalized_rarity = excluded.normalized_rarity,
          raw_json = excluded.raw_json,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at`
      ),
      listUsedColors: this.db.prepare(`SELECT rgb_int FROM used_colors WHERE token_id = ?`),
      insertGeneration: this.db.prepare(
        `INSERT INTO generations (
          id, token_id, user_seed, derived_seed, tool_version, palette_signature, output_24_hash,
          rarity_norm, rarity_source, strict_mode, created_at, block_number, mode_id, output_kind, state_signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      insertUsedColor: this.db.prepare(
        `INSERT INTO used_colors (token_id, rgb_int, generation_id, role, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ),
      listHistoryByToken: this.db.prepare(
        `SELECT id, token_id, user_seed, derived_seed, tool_version, palette_signature, output_24_hash,
                rarity_norm, rarity_source, strict_mode, created_at, block_number, mode_id, output_kind, state_signature
         FROM generations
         WHERE token_id = ?
         ORDER BY created_at DESC`
      ),
      getGeneration: this.db.prepare(
        `SELECT id, token_id, user_seed, derived_seed, tool_version, palette_signature, output_24_hash,
                rarity_norm, rarity_source, strict_mode, created_at, block_number, mode_id, output_kind, state_signature
         FROM generations WHERE id = ?`
      ),
      getGenerationByState: this.db.prepare(
        `SELECT id, token_id, user_seed, derived_seed, tool_version, palette_signature, output_24_hash,
                rarity_norm, rarity_source, strict_mode, created_at, block_number, mode_id, output_kind, state_signature
         FROM generations
         WHERE token_id = ? AND mode_id = ? AND block_number = ? AND output_kind = ?
         ORDER BY created_at DESC
         LIMIT 1`
      ),
      listStateWindowSignatures: this.db.prepare(
        `SELECT state_signature
         FROM generations
         WHERE token_id = ?
           AND mode_id = ?
           AND block_number BETWEEN ? AND ?
           AND state_signature IS NOT NULL`
      ),
    };
  }

  close() {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }
  }

  getRarityCache(tokenId) {
    const row = this.stmts.getRarityCache.get(Number(tokenId));
    if (!row) return null;
    return {
      tokenId: Number(row.token_id),
      source: row.source,
      rank: row.rarity_rank == null ? null : Number(row.rarity_rank),
      total: row.total_supply == null ? null : Number(row.total_supply),
      normalized: Number(row.normalized_rarity),
      rawJson: row.raw_json ? safeJsonParse(row.raw_json) : null,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
    };
  }

  upsertRarityCache(entry) {
    const fetchedAt = entry.fetchedAt || nowIso();
    this.stmts.upsertRarityCache.run(
      Number(entry.tokenId),
      String(entry.source),
      entry.rank == null ? null : Number(entry.rank),
      entry.total == null ? null : Number(entry.total),
      Number(entry.normalized),
      entry.rawJson == null ? null : JSON.stringify(entry.rawJson),
      fetchedAt,
      entry.expiresAt || null
    );
    return this.getRarityCache(entry.tokenId);
  }

  getUsedColorsForToken(tokenId) {
    const rows = this.stmts.listUsedColors.all(Number(tokenId));
    return new Set(rows.map((row) => Number(row.rgb_int) >>> 0));
  }

  saveGeneration(generation) {
    return this.transaction(() => {
      this.stmts.insertGeneration.run(
        String(generation.id),
        Number(generation.tokenId),
        String(generation.userSeed || ""),
        String(generation.derivedSeed || ""),
        String(generation.toolVersion),
        String(generation.paletteSignature),
        String(generation.output24Hash),
        Number(generation.rarityNorm),
        String(generation.raritySource),
        generation.strictMode ? 1 : 0,
        generation.createdAt || nowIso(),
        generation.blockNumber == null ? null : Number(generation.blockNumber),
        generation.modeId || null,
        generation.outputKind || null,
        generation.stateSignature || null
      );
      return { ok: true };
    });
  }

  commitGenerationWithReservedColors({ generation, colors }) {
    return this.transaction(() => {
      this.stmts.insertGeneration.run(
        String(generation.id),
        Number(generation.tokenId),
        String(generation.userSeed || ""),
        String(generation.derivedSeed || ""),
        String(generation.toolVersion),
        String(generation.paletteSignature),
        String(generation.output24Hash),
        Number(generation.rarityNorm),
        String(generation.raritySource),
        generation.strictMode ? 1 : 0,
        generation.createdAt || nowIso(),
        generation.blockNumber == null ? null : Number(generation.blockNumber),
        generation.modeId || null,
        generation.outputKind || null,
        generation.stateSignature || null
      );

      const createdAt = generation.createdAt || nowIso();
      for (const color of colors || []) {
        this.stmts.insertUsedColor.run(
          Number(generation.tokenId),
          Number(color.rgbInt) >>> 0,
          generation.id,
          color.role || null,
          color.createdAt || createdAt
        );
      }
      return { ok: true };
    });
  }

  getGenerationByState(tokenId, modeId, blockNumber, outputKind) {
    const row = this.stmts.getGenerationByState.get(
      Number(tokenId),
      String(modeId),
      Number(blockNumber),
      String(outputKind)
    );
    return row ? mapGenerationRow(row) : null;
  }

  listStateWindowSignatures(tokenId, modeId, blockNumber, window = 16) {
    const center = Number(blockNumber);
    const rows = this.stmts.listStateWindowSignatures.all(
      Number(tokenId),
      String(modeId),
      center - Math.max(0, Number(window) || 0),
      center + Math.max(0, Number(window) || 0)
    );
    return rows
      .map((row) => String(row.state_signature || "").trim())
      .filter(Boolean);
  }

  listHistory(tokenId, { mode = null, outputKind = null, limit = 12, offset = 0 } = {}) {
    const rows = this.stmts.listHistoryByToken.all(Number(tokenId)).map(mapGenerationRow);
    const filtered = rows.filter((row) => {
      if (mode && row.modeId !== String(mode)) return false;
      if (outputKind && row.outputKind !== String(outputKind)) return false;
      return true;
    });
    return filtered.slice(Number(offset), Number(offset) + Number(limit));
  }

  getGeneration(id) {
    const row = this.stmts.getGeneration.get(String(id));
    return row ? mapGenerationRow(row) : null;
  }
}

class JsonNoPaletteDatabase extends NoPaletteDatabase {
  constructor(options = {}) {
    super();
    this.backend = "json-fallback";
    const requestedPath = options.dbPath || path.join(process.cwd(), "apps/no-meta/data/no-palette.json");
    this.dbPath = String(requestedPath).endsWith(".sqlite")
      ? String(requestedPath).replace(/\.sqlite$/i, ".json")
      : requestedPath;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this._load();
  }

  _emptyState() {
    return {
      version: 2,
      rarity_cache: {},
      generations: {},
      used_colors: {},
    };
  }

  _load() {
    if (!fs.existsSync(this.dbPath)) {
      this.state = this._emptyState();
      this._save();
      return;
    }
    try {
      const raw = fs.readFileSync(this.dbPath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        ...this._emptyState(),
        ...(parsed && typeof parsed === "object" ? parsed : {}),
      };
      if (!this.state.rarity_cache || typeof this.state.rarity_cache !== "object") this.state.rarity_cache = {};
      if (!this.state.generations || typeof this.state.generations !== "object") this.state.generations = {};
      if (!this.state.used_colors || typeof this.state.used_colors !== "object") this.state.used_colors = {};
    } catch {
      const sidecarPath = `${this.dbPath}.json`;
      this.dbPath = sidecarPath;
      if (fs.existsSync(this.dbPath)) {
        try {
          this.state = JSON.parse(fs.readFileSync(this.dbPath, "utf8"));
          return;
        } catch {
          // continue to reset
        }
      }
      this.state = this._emptyState();
      this._save();
    }
  }

  _save() {
    const tmpPath = `${this.dbPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmpPath, this.dbPath);
  }

  close() {
    // no-op
  }

  transaction(fn) {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    try {
      const result = fn();
      this._save();
      return result;
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  getRarityCache(tokenId) {
    const row = this.state.rarity_cache[String(Number(tokenId))];
    if (!row) return null;
    return {
      tokenId: Number(row.token_id),
      source: row.source,
      rank: row.rarity_rank == null ? null : Number(row.rarity_rank),
      total: row.total_supply == null ? null : Number(row.total_supply),
      normalized: Number(row.normalized_rarity),
      rawJson: row.raw_json ? safeJsonParse(row.raw_json) : null,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
    };
  }

  upsertRarityCache(entry) {
    const fetchedAt = entry.fetchedAt || nowIso();
    const row = {
      token_id: Number(entry.tokenId),
      source: String(entry.source),
      rarity_rank: entry.rank == null ? null : Number(entry.rank),
      total_supply: entry.total == null ? null : Number(entry.total),
      normalized_rarity: Number(entry.normalized),
      raw_json: entry.rawJson == null ? null : JSON.stringify(entry.rawJson),
      fetched_at: fetchedAt,
      expires_at: entry.expiresAt || null,
    };
    this.state.rarity_cache[String(row.token_id)] = row;
    this._save();
    return this.getRarityCache(entry.tokenId);
  }

  getUsedColorsForToken(tokenId) {
    const tokenBucket = this.state.used_colors[String(Number(tokenId))] || {};
    return new Set(Object.keys(tokenBucket).map((key) => Number(key) >>> 0));
  }

  saveGeneration(generation) {
    return this.transaction(() => {
      const genId = String(generation.id);
      if (this.state.generations[genId]) {
        throw new Error("UNIQUE constraint failed: generations.id");
      }

      if (generation.blockNumber != null && generation.modeId && generation.outputKind) {
        const existing = this.getGenerationByState(generation.tokenId, generation.modeId, generation.blockNumber, generation.outputKind);
        if (existing) {
          throw new Error("UNIQUE constraint failed: generations.token_id, generations.mode_id, generations.block_number, generations.output_kind");
        }
      }

      this.state.generations[genId] = {
        id: genId,
        token_id: Number(generation.tokenId),
        user_seed: String(generation.userSeed || ""),
        derived_seed: String(generation.derivedSeed || ""),
        tool_version: String(generation.toolVersion),
        palette_signature: String(generation.paletteSignature),
        output_24_hash: String(generation.output24Hash),
        rarity_norm: Number(generation.rarityNorm),
        rarity_source: String(generation.raritySource),
        strict_mode: generation.strictMode ? 1 : 0,
        created_at: generation.createdAt || nowIso(),
        block_number: generation.blockNumber == null ? null : Number(generation.blockNumber),
        mode_id: generation.modeId || null,
        output_kind: generation.outputKind || null,
        state_signature: generation.stateSignature || null,
      };
      return { ok: true };
    });
  }

  commitGenerationWithReservedColors({ generation, colors }) {
    return this.transaction(() => {
      const genId = String(generation.id);
      if (this.state.generations[genId]) {
        throw new Error("UNIQUE constraint failed: generations.id");
      }

      this.state.generations[genId] = {
        id: genId,
        token_id: Number(generation.tokenId),
        user_seed: String(generation.userSeed || ""),
        derived_seed: String(generation.derivedSeed || ""),
        tool_version: String(generation.toolVersion),
        palette_signature: String(generation.paletteSignature),
        output_24_hash: String(generation.output24Hash),
        rarity_norm: Number(generation.rarityNorm),
        rarity_source: String(generation.raritySource),
        strict_mode: generation.strictMode ? 1 : 0,
        created_at: generation.createdAt || nowIso(),
        block_number: generation.blockNumber == null ? null : Number(generation.blockNumber),
        mode_id: generation.modeId || null,
        output_kind: generation.outputKind || null,
        state_signature: generation.stateSignature || null,
      };

      const tokenId = Number(generation.tokenId);
      const tokenKey = String(tokenId);
      const colorBucket = this.state.used_colors[tokenKey] || {};
      for (const color of colors || []) {
        const rgbKey = String(Number(color.rgbInt) >>> 0);
        if (colorBucket[rgbKey]) {
          throw new Error("UNIQUE constraint failed: used_colors.token_id, used_colors.rgb_int");
        }
      }

      for (const color of colors || []) {
        const rgbKey = String(Number(color.rgbInt) >>> 0);
        colorBucket[rgbKey] = {
          token_id: tokenId,
          rgb_int: Number(color.rgbInt) >>> 0,
          generation_id: String(generation.id),
          role: color.role || null,
          created_at: color.createdAt || generation.createdAt || nowIso(),
        };
      }
      this.state.used_colors[tokenKey] = colorBucket;
      return { ok: true };
    });
  }

  getGenerationByState(tokenId, modeId, blockNumber, outputKind) {
    const rows = Object.values(this.state.generations)
      .filter((row) => Number(row.token_id) === Number(tokenId))
      .filter((row) => row.mode_id === String(modeId))
      .filter((row) => Number(row.block_number) === Number(blockNumber))
      .filter((row) => row.output_kind === String(outputKind))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return rows[0] ? mapGenerationRow(rows[0]) : null;
  }

  listStateWindowSignatures(tokenId, modeId, blockNumber, window = 16) {
    const center = Number(blockNumber);
    const radius = Math.max(0, Number(window) || 0);
    return Object.values(this.state.generations)
      .filter((row) => Number(row.token_id) === Number(tokenId))
      .filter((row) => row.mode_id === String(modeId))
      .filter((row) => row.block_number != null)
      .filter((row) => Math.abs(Number(row.block_number) - center) <= radius)
      .map((row) => String(row.state_signature || "").trim())
      .filter(Boolean);
  }

  listHistory(tokenId, { mode = null, outputKind = null, limit = 12, offset = 0 } = {}) {
    const rows = Object.values(this.state.generations)
      .filter((row) => Number(row.token_id) === Number(tokenId))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const filtered = rows.filter((row) => {
      if (mode && row.mode_id !== String(mode)) return false;
      if (outputKind && row.output_kind !== String(outputKind)) return false;
      return true;
    });
    return filtered.slice(Number(offset), Number(offset) + Number(limit)).map(mapGenerationRow);
  }

  getGeneration(id) {
    const row = this.state.generations[String(id)];
    return row ? mapGenerationRow(row) : null;
  }
}

const NoPaletteDatabaseImpl = (DatabaseSync && process.env.NO_PALETTE_DB_BACKEND !== "json")
  ? SqliteNoPaletteDatabase
  : JsonNoPaletteDatabase;

function mapGenerationRow(row) {
  return {
    id: row.id,
    tokenId: Number(row.token_id),
    userSeed: row.user_seed,
    derivedSeed: row.derived_seed,
    toolVersion: row.tool_version,
    paletteSignature: row.palette_signature,
    output24Hash: row.output_24_hash,
    rarityNorm: Number(row.rarity_norm),
    raritySource: row.rarity_source,
    strictMode: Boolean(row.strict_mode),
    createdAt: row.created_at,
    blockNumber: row.block_number == null ? null : Number(row.block_number),
    modeId: row.mode_id || null,
    outputKind: row.output_kind || null,
    stateSignature: row.state_signature || null,
    legacySeeded: row.block_number == null || !row.mode_id,
  };
}

module.exports = {
  NoPaletteDatabase: NoPaletteDatabaseImpl,
  isUniqueConstraintError,
  nowIso,
};
