"use strict";

const { getTokenRarity } = require("./tcgRarity");
const { getTypeGuide } = require("./tcgTypeGuides");
const { deriveTraitSignals, titleize } = require("./tcgTraitLexicon");

const HP_RANGES = {
  Common: [60, 100],
  Uncommon: [90, 130],
  Rare: [120, 170],
  Legendary: [160, 230],
  Cursed: [200, 300],
};

const DAMAGE_RULES = {
  Common: [[10, 28], [26, 48]],
  Uncommon: [[22, 42], [40, 68]],
  Rare: [[36, 62], [58, 92]],
  Legendary: [[58, 88], [86, 140]],
  Cursed: [[72, 112], [110, 180]],
};

const RARITY_VISUAL_RULES = {
  Common: "Light gray or neutral metallic frame with soft anime glow.",
  Uncommon: "Blue or green metallic frame with subtle aura particles.",
  Rare: "Purple or crimson metallic frame with noticeable aura burst.",
  Legendary: "Radiant gold layered frame with explosive aura and foil sparkle.",
  Cursed: "Black and red corrupted metallic frame with glitch aura and distortion streaks.",
};

function hashInt(seed) {
  let h = 2166136261;
  const text = String(seed);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickFrom(arr, seed) {
  if (!Array.isArray(arr) || !arr.length) return "";
  return arr[hashInt(seed) % arr.length];
}

function lerpInt(min, max, t) {
  return Math.round(min + ((max - min) * t));
}

function deriveHp({ rarity, tokenId, traitCount, typeGuide }) {
  const [min, max] = HP_RANGES[rarity] || HP_RANGES.Common;
  const seed = hashInt(`${tokenId}:hp:${typeGuide.id}`);
  const t = (seed % 1000) / 999;
  const typeBias = (hashInt(`${typeGuide.id}:bias`) % 7) - 3;
  const traitBias = Math.min(12, Math.max(-4, (traitCount - 2) * 4));
  const hp = lerpInt(min, max, t) + typeBias + traitBias;
  return Math.max(min, Math.min(max, hp));
}

function buildName({ record, typeGuide, signals }) {
  const stemA = pickFrom(typeGuide.nameStems, `${record.id}:stemA`) || "Noir";
  const primary = signals[0] || null;
  const secondary = signals[1] || null;
  const stemB = (primary && primary.noun) || (secondary && secondary.noun) || (pickFrom(typeGuide.attackVerbs, `${record.id}:verb`) || "Pulse");
  const stemC = (secondary && secondary.verb) || (primary && primary.verb) || "";
  let title = `${stemA} ${titleize(stemB)}`.replace(/\s+/g, " ").trim();
  if (title.length < 11 && stemC) {
    title = `${title} ${titleize(stemC)}`.replace(/\s+/g, " ").trim();
  }
  return title;
}

function clampDamage(value) {
  return Math.max(1, Math.min(999, Math.round(value)));
}

function attackDamage(rarity, slot, tokenId, signalWeight = 1) {
  const pair = (DAMAGE_RULES[rarity] || DAMAGE_RULES.Common)[slot] || [10, 30];
  const [min, max] = pair;
  const t = (hashInt(`${tokenId}:atk:${slot}:${signalWeight}`) % 1000) / 999;
  const bonus = Math.min(18, Math.max(0, (signalWeight - 1) * 4));
  return clampDamage(Math.min(max, lerpInt(min, max, t) + bonus));
}

function buildAttack({ slot, rarity, tokenId, typeGuide, signal }) {
  const leadVerb = signal ? signal.verb : (pickFrom(typeGuide.attackVerbs, `${tokenId}:verb:${slot}`) || "Strike");
  const noun = signal ? signal.noun : (pickFrom(["Burst", "Wave", "Drive", "Edge"], `${tokenId}:noun:${slot}`) || "Burst");
  const prefix = slot === 0 ? leadVerb : `${pickFrom(typeGuide.attackVerbs, `${tokenId}:verb2:${slot}`) || "Omega"}`;
  const name = `${titleize(prefix)} ${titleize(noun)}`.replace(/\s+/g, " ").trim();
  const damage = attackDamage(rarity, slot, tokenId, signal ? signal.weight : 1);
  const flavor = signal
    ? `${signal.flavor}`
    : (slot === 0 ? "A fast opener sets the pace of the duel." : "A heavier finishing strike detonates on contact.");
  return {
    name,
    damage,
    line: `${name} — ${damage} DMG`,
    flavor,
  };
}

function buildTcgCardSpec(record) {
  if (!record || typeof record !== "object") {
    throw new Error("Missing NoPunk record");
  }
  const tokenId = Number(record.id);
  const traits = record.traits || {};
  const typeGuide = getTypeGuide(traits.Type || record.type);
  const rarityBundle = getTokenRarity(tokenId);
  const signals = deriveTraitSignals(traits);
  const name = buildName({ record, typeGuide, signals });
  const displayName = name.length > 22 ? `NOPUNK #${tokenId}` : name;
  const hp = deriveHp({ rarity: rarityBundle.rarity, tokenId, traitCount: Object.keys(traits).length, typeGuide });
  const attacks = [
    buildAttack({ slot: 0, rarity: rarityBundle.rarity, tokenId, typeGuide, signal: signals[0] || null }),
    buildAttack({ slot: 1, rarity: rarityBundle.rarity, tokenId, typeGuide, signal: signals[1] || signals[0] || null }),
  ];

  return {
    tokenId,
    rarity: rarityBundle.rarity,
    hiddenRollVersion: rarityBundle.hiddenRollVersion,
    typeGuideId: typeGuide.id,
    name,
    displayName,
    hp,
    artwork: {
      source: "nopunk-transparent",
      previewUrl: record.previewUrl,
    },
    attacks,
    layout: {
      width: 1024,
      height: 1432,
      templateVersion: "tcg-dbz-locked-v1",
    },
    promptHints: {
      rarityVisualRule: RARITY_VISUAL_RULES[rarityBundle.rarity],
      typeVisualGuide: `${typeGuide.label}: ${typeGuide.frameMood}; aura motif: ${typeGuide.auraMotif}.`,
      traitHighlights: signals.slice(0, 4).map((s) => `${s.category}: ${s.value}`),
    },
    source: {
      id: tokenId,
      name: record.name,
      type: record.type,
      traitSummary: record.traitSummary,
      traits,
    },
    _internal: {
      hiddenRoll: rarityBundle._hiddenRollValue,
      typeGuide,
      signals,
    },
  };
}

module.exports = {
  buildTcgCardSpec,
  HP_RANGES,
  DAMAGE_RULES,
  RARITY_VISUAL_RULES,
};
