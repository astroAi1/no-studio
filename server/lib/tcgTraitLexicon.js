"use strict";

const CATEGORY_RULES = {
  Hair: {
    nouns: ["Crest", "Crown", "Helm", "Mane", "Edge"],
    verbs: ["Slice", "Spin", "Razor", "Surge", "Flicker"],
    flavors: [
      "A sharp style feint opens the guard.",
      "The silhouette snaps forward with clean timing.",
      "A crowned motion leaves a pressure trail.",
    ],
  },
  Eyes: {
    nouns: ["Gaze", "Sight", "Lens", "Focus", "Blink"],
    verbs: ["Lock", "Pierce", "Glare", "Stare", "Flash"],
    flavors: [
      "A locked stare compresses the air around the target.",
      "Vision pressure lands before the motion is seen.",
      "The look alone forces a stagger step.",
    ],
  },
  Mouth: {
    nouns: ["Grin", "Fang", "Bite", "Chant", "Snarl"],
    verbs: ["Bite", "Howl", "Spit", "Mock", "Break"],
    flavors: [
      "The strike lands with a taunting aftershock.",
      "A grim grin precedes the impact wave.",
      "Close-range pressure turns into a snapping burst.",
    ],
  },
  Beard: {
    nouns: ["Guard", "Warden", "Bristle", "Ironjaw", "Rook"],
    verbs: ["Brace", "Anchor", "Ram", "Drive", "Fortify"],
    flavors: [
      "A grounded stance converts force into momentum.",
      "The guard line hardens, then surges through.",
      "Impact rolls forward like a heavy wall.",
    ],
  },
  Smoke: {
    nouns: ["Smoke", "Ember", "Pipe", "Haze", "Ash"],
    verbs: ["Ignite", "Vapor", "Smolder", "Cinder", "Sear"],
    flavors: [
      "A clouded burst obscures the follow-up hit.",
      "Heat and haze fold into a sudden strike.",
      "The attack blooms out of drifting smoke.",
    ],
  },
  Face: {
    nouns: ["Mask", "Visage", "Mark", "Seal", "Shade"],
    verbs: ["Brand", "Veil", "Mirror", "Press", "Rift"],
    flavors: [
      "A marked pattern fractures the opponent's rhythm.",
      "The face line flickers, then the hit resolves.",
      "A veiled shift turns defense into an opening.",
    ],
  },
  Mask: {
    nouns: ["Mask", "Veil", "Shell", "Screen", "Shroud"],
    verbs: ["Shroud", "Mute", "Blank", "Seal", "Disrupt"],
    flavors: [
      "A masked burst wipes the read and lands clean.",
      "The target loses the line just before impact.",
      "A shrouded pulse silences the counter window.",
    ],
  },
  Neck: {
    nouns: ["Collar", "Chain", "Band", "Torque", "Link"],
    verbs: ["Clamp", "Torque", "Loop", "Snap", "Bind"],
    flavors: [
      "A binding line tightens into a crisp hit.",
      "Pressure wraps the lane before the strike drops.",
      "The chain of motion resolves in one clean snap.",
    ],
  },
  Nose: {
    nouns: ["Point", "Spike", "Needle", "Probe", "Prong"],
    verbs: ["Pierce", "Needle", "Probe", "Puncture", "Split"],
    flavors: [
      "A precise line shot finds a narrow opening.",
      "Needle focus breaks through the guard seam.",
      "A pin-point burst lands with surgical timing.",
    ],
  },
  Ears: {
    nouns: ["Ring", "Echo", "Chime", "Signal", "Resonance"],
    verbs: ["Echo", "Resound", "Ping", "Chime", "Pulse"],
    flavors: [
      "A resonance pulse returns harder than expected.",
      "A ringing echo offsets the opponent's timing.",
      "Signal feedback detonates on the second beat.",
    ],
  },
};

function titleize(value) {
  return String(value || "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function traitWeight(category, value) {
  const baseByCategory = {
    Smoke: 5,
    Mouth: 4,
    Eyes: 4,
    Hair: 3,
    Mask: 3,
    Face: 3,
    Beard: 2,
    Neck: 2,
    Nose: 1,
    Ears: 1,
  };
  const base = baseByCategory[category] || 1;
  return base + Math.min(3, slug(value).split(" ").filter(Boolean).length - 1);
}

function deriveTraitSignals(traits = {}) {
  const out = [];
  for (const [category, value] of Object.entries(traits)) {
    if (!value || category === "Type") continue;
    const rule = CATEGORY_RULES[category] || {
      nouns: [titleize(category), "Burst", "Edge"],
      verbs: ["Burst", "Shift", "Strike"],
      flavors: ["Trait pressure bends the exchange in your favor."],
    };
    out.push({
      category,
      value: String(value),
      displayValue: titleize(value),
      noun: rule.nouns[slug(value).length % rule.nouns.length],
      verb: rule.verbs[(slug(value).length + category.length) % rule.verbs.length],
      flavor: rule.flavors[(slug(value).length + String(value).length) % rule.flavors.length],
      weight: traitWeight(category, value),
      tags: [category.toLowerCase(), ...slug(value).split(" ").filter(Boolean)].slice(0, 4),
    });
  }
  out.sort((a, b) => b.weight - a.weight || a.category.localeCompare(b.category));
  return out;
}

module.exports = {
  deriveTraitSignals,
  titleize,
};
