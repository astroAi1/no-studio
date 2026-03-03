"use strict";

const crypto = require("crypto");

const RARITY_BRACKETS = [
  { min: 1, max: 50, rarity: "Common" },
  { min: 51, max: 75, rarity: "Uncommon" },
  { min: 76, max: 90, rarity: "Rare" },
  { min: 91, max: 98, rarity: "Legendary" },
  { min: 99, max: 100, rarity: "Cursed" },
];

function deterministicRoll100(tokenId, salt = "no-meta-tcg-v1") {
  const id = Number.parseInt(String(tokenId), 10);
  if (!Number.isFinite(id) || id < 0 || id > 9999) {
    throw new Error("Invalid tokenId for rarity roll");
  }
  const hash = crypto.createHash("sha256").update(`${salt}:${id}`).digest();
  const int32 = hash.readUInt32BE(0);
  return (int32 % 100) + 1;
}

function rarityFromRoll(roll) {
  const value = Number.parseInt(String(roll), 10);
  for (const bracket of RARITY_BRACKETS) {
    if (value >= bracket.min && value <= bracket.max) return bracket.rarity;
  }
  throw new Error(`Invalid rarity roll: ${roll}`);
}

function getTokenRarity(tokenId, salt) {
  const roll = deterministicRoll100(tokenId, salt);
  return {
    rarity: rarityFromRoll(roll),
    hiddenRollVersion: "v1-tokenid-seed",
    _hiddenRollValue: roll,
  };
}

module.exports = {
  RARITY_BRACKETS,
  deterministicRoll100,
  rarityFromRoll,
  getTokenRarity,
};
