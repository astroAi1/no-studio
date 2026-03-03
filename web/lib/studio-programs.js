const PROGRAMS = [
  { id: "monolith", label: "Monolith", familyBias: "mixed", reductionBias: "lock", ditherBias: "mixed", useActiveBgChance: 0.25, intensityBand: "low" },
  { id: "signal", label: "Signal", familyBias: "dither", reductionBias: "accent", ditherBias: "scan", useActiveBgChance: 0.55, intensityBand: "mid" },
  { id: "fracture", label: "Fracture", familyBias: "mixed", reductionBias: "mask", ditherBias: "cluster", useActiveBgChance: 0.45, intensityBand: "high" },
  { id: "echo", label: "Echo", familyBias: "noir", reductionBias: "lock", ditherBias: "diffuse", useActiveBgChance: 0.4, intensityBand: "mid" },
  { id: "poster", label: "Poster", familyBias: "pop", reductionBias: "accent", ditherBias: "mixed", useActiveBgChance: 0.5, intensityBand: "high" },
  { id: "veil", label: "Veil", familyBias: "mono", reductionBias: "mask", ditherBias: "bayer", useActiveBgChance: 0.35, intensityBand: "low" },
  { id: "pulse", label: "Pulse", familyBias: "mixed", reductionBias: "none", ditherBias: "scan", useActiveBgChance: 0.7, intensityBand: "high" },
  { id: "afterimage", label: "Afterimage", familyBias: "noir", reductionBias: "mask", ditherBias: "cluster", useActiveBgChance: 0.25, intensityBand: "mid" },
];

export function listStudioPrograms() {
  return PROGRAMS.slice();
}

export function getStudioProgram(programId) {
  return PROGRAMS.find((program) => program.id === programId) || PROGRAMS[0];
}
