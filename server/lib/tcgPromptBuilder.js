"use strict";

const MASTER_TCG_PROMPT = `MASTER TCG PROMPT (DBZ STYLE LOCKED)

Create a professional Trading Card Game (TCG) card using the NFT image provided.

The card layout MUST follow this EXACT structural template every time.

⸻

🔒 FIXED CARD STRUCTURE (DO NOT DEVIATE)

• Vertical full trading card
• Thick outer frame border
• Full-width top header bar
• Card Name centered in header
• HP displayed inside a boxed segment in the top right of header
• Large centered artwork window directly below header
• Artwork window must have a thin inner border
• Rarity label in small caps at the bottom-right corner of the artwork frame
• Two identical rectangular attack boxes stacked vertically at bottom
• Attack boxes equal size and perfectly aligned
• Damage numbers right-aligned inside each attack box
• Serif fantasy-style font
• Clean symmetrical spacing
• No redesigning layout
• No moving elements
• No extra text outside the card

Only the following may change per card:
– Frame color & energy effects (based on rarity)
– Name
– HP
– Attacks
– Damage numbers

Layout must remain identical across all generations.

⸻

🎨 DRAGON BALL CARD STYLE LOCK (NEW)

The visual design MUST emulate modern Dragon Ball Super TCG cards:

• High-energy anime illustration style
• Glossy prismatic foil finish look
• Radiating aura bursts behind character
• Diagonal speed lines & power streaks
• Layered metallic frame borders
• Subtle sparkle / holographic texture
• Dramatic rim lighting around character
• Impact burst backgrounds with energy particles
• Slight motion blur or power distortion effects
• Bold, vibrant shonen anime color grading

This affects ONLY:
– Frame rendering
– Lighting
– Background energy
– Foil / holographic feel
– Aura intensity

Card layout and typography remain unchanged.

⸻

🎲 TRUE RARITY ROLL SYSTEM (LOCKED %)

First generate a random integer between 1 and 100.

Assign rarity STRICTLY using this mapping:

1–50 → Common (50%)
51–75 → Uncommon (25%)
76–90 → Rare (15%)
91–98 → Legendary (8%)
99–100 → Cursed (2%)

You MUST follow this bracket mapping exactly.
Do not override the roll.
Do not reveal the roll.
Commit fully to the result.

⸻

🎨 RARITY VISUAL RULES

COMMON
Light gray or neutral metallic frame
Soft anime glow

UNCOMMON
Blue or green metallic frame
Subtle aura particles

RARE
Purple or crimson metallic frame
Noticeable aura burst

LEGENDARY
Radiant gold layered frame
Explosive anime power aura + foil sparkle

CURSED
Black and red corrupted metallic frame
Glitch aura + distortion streaks

Rarity affects ONLY:
– Frame styling
– Lighting
– Energy effects
– HP range
– Attack damage scaling

Layout never changes.

⸻

⚔️ ATTACK RULES

Each card MUST include exactly TWO attacks.

Attack 1:
Basic ability
Lower damage appropriate to rarity

Attack 2:
Stronger special/spell
Higher damage appropriate to rarity

Attack formatting MUST be exactly:

Attack Name — XX DMG
Short flavor sentence.

⸻

✅ OUTPUT RULE

Output ONLY the completed card.
No explanations.
No commentary.
No extra formatting text.
must be fun for the user`;

function buildTcgPromptText(card) {
  const safe = card || {};
  const attacks = Array.isArray(safe.attacks) ? safe.attacks : [];
  const attackBlock = attacks.map((atk, idx) => [
    `Attack ${idx + 1}:`,
    `${atk.line}`,
    `${atk.flavor}`,
  ].join("\n")).join("\n\n");

  const traitPairs = Object.entries((safe.source && safe.source.traits) || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join(" | ");

  const promptData = [
    "\n\n=== GENERATED CARD FIELDS (LOCKED FOR THIS CARD) ===",
    `NoPunk: #${safe.tokenId}`,
    `Name: ${safe.displayName}`,
    `HP: ${safe.hp}`,
    `Rarity: ${safe.rarity}`,
    `Type Guide: ${safe.typeGuideId}`,
    `Traits: ${traitPairs}`,
    `Trait Summary: ${(safe.source && safe.source.traitSummary) || ""}`,
    "",
    attackBlock,
    "",
    "=== VISUAL HINTS ===",
    `Rarity Rule: ${(safe.promptHints && safe.promptHints.rarityVisualRule) || ""}`,
    `Type Visual Guide: ${(safe.promptHints && safe.promptHints.typeVisualGuide) || ""}`,
    `Trait Highlights: ${((safe.promptHints && safe.promptHints.traitHighlights) || []).join("; ")}`,
    "",
    "KEEP THE FIXED CARD STRUCTURE EXACTLY. DO NOT MOVE OR REDESIGN ANY LAYOUT ELEMENTS.",
  ].join("\n");

  return `${MASTER_TCG_PROMPT}\n${promptData}\n`;
}

module.exports = {
  MASTER_TCG_PROMPT,
  buildTcgPromptText,
};
