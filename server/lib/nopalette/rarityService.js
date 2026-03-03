"use strict";

const { nowIso } = require("./db");
const { clamp01, normalizeRarity } = require("./mixer");

const DAY_MS = 24 * 60 * 60 * 1000;

function ttlIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function parseIsoMaybe(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : null;
}

function isFresh(cache) {
  if (!cache) return false;
  const expires = parseIsoMaybe(cache.expiresAt);
  if (expires == null) return true;
  return expires > Date.now();
}

function buildLocalRarityModel(traitDbRaw) {
  const total = Number(traitDbRaw && traitDbRaw.total) || 10000;
  const punks = (traitDbRaw && traitDbRaw.punks) || {};
  const traitCounts = (traitDbRaw && traitDbRaw.trait_counts) || {};

  const rawScores = new Map();
  let min = Infinity;
  let max = -Infinity;

  for (const [idKey, entry] of Object.entries(punks)) {
    const tokenId = Number.parseInt(idKey, 10);
    if (!Number.isFinite(tokenId)) continue;
    const traits = (entry && entry.traits) || {};
    const pairs = Object.entries(traits).filter(([, v]) => v != null && v !== "");
    if (!pairs.length) {
      rawScores.set(tokenId, 0);
      min = Math.min(min, 0);
      max = Math.max(max, 0);
      continue;
    }

    let score = 0;
    for (const [traitType, traitValue] of pairs) {
      const bucket = traitCounts[traitType] || {};
      const count = Number(bucket[traitValue]) || total;
      const freq = Math.max(1 / total, Math.min(1, count / total));
      score += -Math.log(freq);
    }

    // Slightly reward richer trait stacks without dominating trait rarity.
    score += Math.min(2, pairs.length / 8);
    rawScores.set(tokenId, score);
    min = Math.min(min, score);
    max = Math.max(max, score);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || rawScores.size === 0) {
    return {
      source: "local-fallback",
      total,
      getNormalized() {
        return 0.5;
      },
    };
  }

  const span = Math.max(1e-9, max - min);

  return {
    source: "local-fallback",
    total,
    getNormalized(tokenId) {
      const raw = rawScores.get(Number(tokenId));
      if (!Number.isFinite(raw)) return 0.5;
      return clamp01((raw - min) / span);
    },
  };
}

function extractRankTotal(payload) {
  if (!payload || typeof payload !== "object") return null;

  const candidates = [
    payload && payload.nft && payload.nft.rarity,
    payload && payload.nft && payload.nft.rarity_data,
    payload && payload.rarity,
  ].filter(Boolean);

  for (const item of candidates) {
    const rank = toNum(item.rank ?? item.rarity_rank ?? item.position);
    const total = toNum(item.total ?? item.total_supply ?? item.max_rank ?? item.collection_size);
    if (Number.isFinite(rank) && Number.isFinite(total) && total > 0) {
      return { rank: Math.round(rank), total: Math.round(total) };
    }
  }

  // Depth-limited scan for any object containing rank + total-like keys.
  const stack = [{ value: payload, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (!value || typeof value !== "object" || depth > 4) continue;
    const rank = toNum(value.rank ?? value.rarity_rank ?? value.position);
    const total = toNum(value.total ?? value.total_supply ?? value.max_rank ?? value.collection_size);
    if (Number.isFinite(rank) && Number.isFinite(total) && total > 0) {
      return { rank: Math.round(rank), total: Math.round(total) };
    }
    for (const next of Object.values(value)) {
      if (next && typeof next === "object") stack.push({ value: next, depth: depth + 1 });
    }
  }

  return null;
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

class NoPaletteRarityService {
  constructor(options = {}) {
    this.db = options.db;
    this.traitDbRaw = options.traitDbRaw;
    this.localModel = buildLocalRarityModel(options.traitDbRaw || {});
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.openSeaApiKey = process.env.OPENSEA_API_KEY || "";
    this.openSeaContract = process.env.NOPUNKS_CONTRACT_ADDRESS || process.env.OPENSEA_CONTRACT_ADDRESS || "";
    this.openSeaChain = process.env.OPENSEA_CHAIN || "ethereum";
    this.openSeaBaseUrl = process.env.OPENSEA_API_BASE || "https://api.opensea.io";
  }

  hasOpenSeaConfigured() {
    return Boolean(this.openSeaApiKey && this.openSeaContract && this.fetchImpl);
  }

  async getRarity(tokenId) {
    const id = Number(tokenId);
    if (!Number.isFinite(id)) throw new Error("Invalid tokenId");

    const cache = this.db.getRarityCache(id);
    if (cache && isFresh(cache)) {
      return this._withMeta(cache, { cached: true });
    }

    if (this.hasOpenSeaConfigured()) {
      try {
        const live = await this.fetchOpenSeaRarity(id);
        if (live) {
          const cached = this.db.upsertRarityCache({
            tokenId: id,
            source: "opensea",
            rank: live.rank,
            total: live.total,
            normalized: live.normalized,
            rawJson: live.rawJson,
            fetchedAt: nowIso(),
            expiresAt: ttlIso(DAY_MS),
          });
          return this._withMeta(cached, { cached: false });
        }
      } catch (error) {
        // fall through to cached stale or local fallback
        if (cache) {
          return this._withMeta(cache, { cached: true, stale: true, warning: error.message || "OpenSea fetch failed" });
        }
      }
    }

    if (cache) {
      return this._withMeta(cache, { cached: true, stale: true });
    }

    const fallbackNorm = this.localModel.getNormalized(id);
    const cached = this.db.upsertRarityCache({
      tokenId: id,
      source: "local-fallback",
      rank: null,
      total: this.localModel.total || 10000,
      normalized: fallbackNorm,
      rawJson: { method: "trait-frequency-v1" },
      fetchedAt: nowIso(),
      expiresAt: ttlIso(30 * DAY_MS),
    });
    return this._withMeta(cached, { cached: false });
  }

  async fetchOpenSeaRarity(tokenId) {
    if (!this.hasOpenSeaConfigured()) return null;
    const url = `${this.openSeaBaseUrl}/api/v2/chain/${encodeURIComponent(this.openSeaChain)}/contract/${encodeURIComponent(this.openSeaContract)}/nfts/${encodeURIComponent(String(tokenId))}`;
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "X-API-KEY": this.openSeaApiKey,
      },
    });
    if (!response.ok) {
      throw new Error(`OpenSea request failed (${response.status})`);
    }
    const payload = await response.json();
    const rankTotal = extractRankTotal(payload);
    if (!rankTotal) return null;
    return {
      rank: rankTotal.rank,
      total: rankTotal.total,
      normalized: normalizeRarity(rankTotal),
      rawJson: payload,
    };
  }

  _withMeta(cacheRecord, extra = {}) {
    const fetchedMs = parseIsoMaybe(cacheRecord.fetchedAt);
    const cacheAgeMs = fetchedMs == null ? null : Math.max(0, Date.now() - fetchedMs);
    return {
      tokenId: cacheRecord.tokenId,
      normalized: clamp01(cacheRecord.normalized),
      source: cacheRecord.source,
      rank: cacheRecord.rank,
      total: cacheRecord.total,
      fetchedAt: cacheRecord.fetchedAt,
      expiresAt: cacheRecord.expiresAt,
      cacheAgeMs,
      ...extra,
    };
  }
}

module.exports = {
  NoPaletteRarityService,
  buildLocalRarityModel,
  extractRankTotal,
};
