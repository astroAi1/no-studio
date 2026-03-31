import {
  buildFamilyVariant,
  FAMILY_IDS,
  FAMILY_LABELS,
  FAMILY_SPECS,
  variantPaletteDistance,
} from "./family-engine.mjs";

export const DEFAULT_RAIL_PAGE_SIZE = 4;
const MAX_RAIL_ATTEMPTS = 8;

export function createEmptyRailState() {
  return {
    pageIndex: 0,
    slotIndex: -1,
    pages: {},
    contextSignature: "",
    activeVariantId: "",
  };
}

export function railContextSignature({
  tokenId,
  family,
  sourcePaletteSignature,
  selectedActiveHex,
  noMinimalMode,
  useActiveBg,
  lockState,
  curatedMapSignature,
  noveltyHistorySignature = "",
  globalModifiers,
  familyModifiers,
}) {
  const safeFamily = FAMILY_IDS.includes(family) ? family : "mono";
  const activeHexSignature = useActiveBg ? String(selectedActiveHex || "") : "";
  return [
    Number(tokenId) || 0,
    safeFamily,
    String(sourcePaletteSignature || ""),
    activeHexSignature,
    String(noMinimalMode || "exact"),
    useActiveBg ? 1 : 0,
    Boolean(lockState?.background) ? 1 : 0,
    Boolean(lockState?.accentBias) ? 1 : 0,
    Boolean(lockState?.curatedMap) ? 1 : 0,
    String(curatedMapSignature || ""),
    String(noveltyHistorySignature || ""),
    JSON.stringify(globalModifiers || {}),
    JSON.stringify(familyModifiers || {}),
  ].join(":");
}

export function buildFamilyVariantRailPage({
  tokenId,
  family,
  classified,
  globalModifiers,
  familyModifiers,
  noMinimalMode,
  selectedActiveHex,
  useActiveBg,
  curatedPaletteMap,
  lockState,
  lockSnapshot,
  noveltyHistory = {},
  pageIndex = 0,
  pageSize = DEFAULT_RAIL_PAGE_SIZE,
}) {
  const variants = [];
  const safeFamily = FAMILY_SPECS[family] ? family : "mono";
  const spec = FAMILY_SPECS[safeFamily];
  for (let slotIndex = 0; slotIndex < pageSize; slotIndex += 1) {
    let picked = null;
    for (let attempt = 0; attempt < MAX_RAIL_ATTEMPTS; attempt += 1) {
      const candidate = buildFamilyVariant({
        tokenId,
        family: safeFamily,
        classified,
        globalModifiers,
        familyModifiers,
        noMinimalMode,
        selectedActiveHex,
        useActiveBg,
        curatedPaletteMap,
        lockState,
        lockSnapshot,
        pageIndex,
        slotIndex: slotIndex + (attempt * pageSize),
        acceptedVariants: variants,
        noveltyHistory,
      });
      if (!candidate.accepted && attempt < MAX_RAIL_ATTEMPTS - 1) continue;
      if (variants.some((existing) => existing.paletteSignature === candidate.paletteSignature)) continue;
      const distance = variants.length
        ? Math.min(...variants.map((existing) => variantPaletteDistance(existing, candidate)))
        : 1;
      if (distance < spec.diversity.minPaletteDistance && attempt < MAX_RAIL_ATTEMPTS - 1) continue;
      picked = {
        ...candidate,
        slotIndex,
        pageIndex,
      };
      break;
    }
    if (!picked) {
      picked = buildFamilyVariant({
        tokenId,
        family: safeFamily,
        classified,
        globalModifiers,
        familyModifiers,
        noMinimalMode,
        selectedActiveHex,
        useActiveBg,
        curatedPaletteMap,
        lockState,
        lockSnapshot,
        pageIndex,
        slotIndex,
        acceptedVariants: variants,
        noveltyHistory,
      });
    }
    variants.push(picked);
  }

  return {
    family: safeFamily,
    familyLabel: FAMILY_LABELS[safeFamily] || "Studio",
    pageIndex,
    pageSize,
    variants,
  };
}
