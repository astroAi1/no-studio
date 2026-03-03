export function tcgRarityTone(rarity) {
  switch (String(rarity || "")) {
    case "Common": return "common";
    case "Uncommon": return "uncommon";
    case "Rare": return "rare";
    case "Legendary": return "legendary";
    case "Cursed": return "cursed";
    default: return "common";
  }
}

export function attackLineParts(attack) {
  const name = String((attack && attack.name) || "Attack");
  const damage = Number.parseInt(String((attack && attack.damage) || 0), 10) || 0;
  return { name, damage, line: `${name} — ${damage} DMG` };
}

export function compactTraitHighlights(card) {
  const arr = (((card || {}).promptHints || {}).traitHighlights) || [];
  return Array.isArray(arr) ? arr.slice(0, 4) : [];
}
