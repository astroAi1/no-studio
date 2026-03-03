"use strict";

const TYPE_GUIDES = {
  alien: {
    id: "alien",
    label: "Alien Vanguard",
    archetype: "Cosmic pressure / psychic overload",
    frameMood: "Iridescent plasma armor with angular cosmic highlights",
    auraMotif: "violet starburst, neon plasma arcs, space dust",
    attackVerbs: ["Phase", "Warp", "Null", "Psionic", "Orbit"],
    nameStems: ["Void", "Astral", "Nova", "Zenith", "Cipher"],
  },
  ape: {
    id: "ape",
    label: "Primal Crusher",
    archetype: "Brute force / shock impact",
    frameMood: "Heavy plated frame with cracked metallic edges",
    auraMotif: "impact shards, dust bursts, feral shockwaves",
    attackVerbs: ["Crush", "Roar", "Rend", "Maul", "Shock"],
    nameStems: ["Titan", "Grit", "Ruin", "Iron", "Savage"],
  },
  zombie: {
    id: "zombie",
    label: "Corrupted Revenant",
    archetype: "Decay / curse / persistence",
    frameMood: "Corroded metallic frame with sick glow seams",
    auraMotif: "corruption haze, ash motes, cursed sigils",
    attackVerbs: ["Rot", "Hex", "Drain", "Grave", "Curse"],
    nameStems: ["Blight", "Grave", "Mire", "Wraith", "Ash"],
  },
  female: {
    id: "female",
    label: "Arcane Duelist",
    archetype: "Precision / elegant burst / control",
    frameMood: "Refined chrome frame with jewel-like highlights",
    auraMotif: "spiral aura threads, star sparks, precision streaks",
    attackVerbs: ["Lance", "Prism", "Gleam", "Charm", "Volt"],
    nameStems: ["Lumen", "Astra", "Vela", "Sable", "Nyra"],
  },
  male: {
    id: "male",
    label: "Street Catalyst",
    archetype: "Speed / technique / pressure",
    frameMood: "Layered chrome frame with battle-worn edges",
    auraMotif: "speed lines, pressure rings, kinetic sparks",
    attackVerbs: ["Drive", "Break", "Rush", "Flash", "Strike"],
    nameStems: ["Rift", "Volt", "Knox", "Axis", "Drift"],
  },
  unknown: {
    id: "unknown",
    label: "Noir Operative",
    archetype: "Adaptive / balance / unpredictable",
    frameMood: "Balanced metallic frame with neutral foil sheen",
    auraMotif: "power haze, clean streaks, foil dust",
    attackVerbs: ["Pulse", "Shift", "Burst", "Guard", "Arc"],
    nameStems: ["Noir", "Echo", "Prime", "Flux", "Shade"],
  },
};

function normalizeType(value) {
  return String(value || "unknown").trim().toLowerCase();
}

function getTypeGuide(typeValue) {
  const key = normalizeType(typeValue);
  return TYPE_GUIDES[key] || TYPE_GUIDES.unknown;
}

function getPublicTypeGuides() {
  return Object.values(TYPE_GUIDES).map((guide) => ({
    id: guide.id,
    label: guide.label,
    archetype: guide.archetype,
    frameMood: guide.frameMood,
    auraMotif: guide.auraMotif,
  }));
}

module.exports = {
  getTypeGuide,
  getPublicTypeGuides,
};
