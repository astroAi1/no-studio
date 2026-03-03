"use strict";

const MODES = [
  {
    id: "canonical-machine",
    label: "Machine",
    descriptionShort: "Block-driven canonical state",
    exportKinds: ["single"],
  },
  {
    id: "dither-study",
    label: "Texture",
    descriptionShort: "Structured texture on the 24x24 grid",
    exportKinds: ["single"],
  },
  {
    id: "serial-pop",
    label: "Serial",
    descriptionShort: "Six nearby block states as a series",
    exportKinds: ["single", "contact-sheet"],
  },
];

const MODE_MAP = new Map(MODES.map((mode) => [mode.id, mode]));

function listModes() {
  return MODES.map((mode) => ({ ...mode }));
}

function getMode(modeId) {
  return MODE_MAP.get(String(modeId || "").trim()) || null;
}

function normalizeMode(modeId) {
  return getMode(modeId) || MODE_MAP.get("canonical-machine");
}

function normalizeOutputKind(mode, outputKind) {
  const desired = String(outputKind || "single").trim();
  if (mode && Array.isArray(mode.exportKinds) && mode.exportKinds.includes(desired)) {
    return desired;
  }
  return "single";
}

module.exports = {
  getMode,
  listModes,
  normalizeMode,
  normalizeOutputKind,
};
