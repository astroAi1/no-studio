# CODEX.md — No-Studio v4

You are Codex working inside `apps/no-meta`, the NoPunks studio app.

`No-Studio` is now the primary surface for this app.

It is not a strict block-seeded machine anymore. It is a shared `24x24` pixel studio built around one NoPunk source image and a global NoPunks role rule.

## Product Identity

- Product: `No-Studio`
- Community surface: `No-Gallery`
- Core artifact: `1024x1024` nearest-neighbor PNG from a `24x24` composition
- Motion artifact: `1024x1024` masked-grain GIF
- Default route: `/tools/no-studio`

## Studio Contract

`No-Studio` is an open-canvas editor.

Users may:
- repaint any existing cell
- erase original source presence
- add new content cells anywhere on the `24x24` grid
- create new background shapes
- create new outline shapes
- use family casts as starting worlds, then keep editing manually

## Hard Constraints

1. `24x24 truth`
- All creative state lives on a canonical `24x24` grid.

2. `Nearest-neighbor only`
- All export upscaling is nearest-neighbor only.

3. `One global role pair`
- Background is global.
- Outline is global.
- Outline must always equal `background + (4,4,4)` in RGB.

4. `No text in outputs`
- Saved media must not contain UI, watermarks, or labels.

## Composition Model

The studio state is:
- `sourceBuffer`
- `roleGrid[576]` with values `b`, `o`, `c`
- `contentGrid[576]`
- `noiseMask[576]`
- `noiseRoleTargets`
- `globalRolePair`

Render rules:
- `b` uses global background
- `o` uses global outline
- `c` uses stored content color

The source NoPunk remains the reference layer and reset target, but not a geometry limit.

## Editing Rules

Tools:
- `Pointer`
- `Brush`
- `Fill`
- `Eyedropper`
- `Noise Paint`
- `Noise Erase`
- `Zoom In`
- `Zoom Out`

Paint targets:
- `Content`
- `Background`
- `Outline`
- `Erase`

Behavior:
- `Content` creates or recolors content anywhere
- `Background` converts touched cells to background and updates the global background color
- `Outline` converts touched cells to outline and back-derives the global background from the chosen outline
- `Erase` converts touched cells to background without changing the current role pair

## Effects

Effects are first-class, not hidden.

- Grain is driven by:
  - a manual `noiseMask`
  - optional semantic role targets for `background`, `outline`, and `content`
- Effective grain is `manual mask OR role-target mask`
- Users choose exactly which `24x24` cells get grain, or target full role classes
- GIF export replays masked grain over time
- The base `24x24` composition stays clean; grain is an export/display effect

## Family System

Public families:
- `Mono`
- `Chrome`
- `Pop`
- `Acid`
- `Pastel`

Families are launchpads, not locked destinations.

- `Cast` creates a family-led start state from the live canvas
- `Mutate` keeps moving from the current composition
- `Wildness` controls how far the palette engine can travel
- up to `2` pinned colors may stay fixed during mutation

Families are dynamic palette engines judged in `OKLCH/OKLab`, not fixed palette packs.

Every family cast must pass:
- family-fit classification
- ambiguity rejection against other families
- local novelty against recent accepted studio variants
- gallery novelty against recent shared saves

The goal is not just “looks good.” The goal is that saved outputs from different families are unmistakably different.

## Gallery

`No-Gallery` is shared when the local server is available.

- saves are global
- entries are view-only after save
- direct inline reactions live on gallery cards
- `NO` is the positive reaction
- `YES` is the negative reaction
- one active reaction is allowed per viewer, per entry
- gallery supports `New` and `Top`
- gallery runs in rolling `7` day live weeks
- finished weeks lock, archive, and surface as weekly cover thumbnails

If the app falls back to browser storage:
- it must be labeled `local-only`
- it must not pretend to be the shared community gallery

## Persistence

Studio sessions persist the composition model, not only a flattened buffer.

Fresh boot rule:
- `No-Studio` always opens with a clean NoPunk on the canvas
- saved local sessions never auto-take over the canvas
- restoration is explicit through `Restore Last Session`

Required session keys:
- `version`
- `selectedTokenId`
- `globalRolePair`
- `roleGrid`
- `contentGrid`
- `noiseMask`
- `noiseRoleTargets`
- `selectedFamily`
- `familyModifiers`
- `globalModifiers`
- `gallerySignature`

Gallery provenance should include:
- `family`
- `familyModifiers`
- `globalModifiers`
- `globalRolePair`
- `roleGrid`
- `contentGrid`
- `noiseMask`
- `noiseRoleTargets`
- `outputSignature`

## Legacy Boundary

The old server-side `No-Palette` deterministic block machine may still exist in the repo for legacy generation paths.

That is not the product contract for `No-Studio`.
