# CODEX.md — No-Palette v2 (Block-Seeded Infinite Machine)

You are Codex working inside `apps/no-meta`, the NoPunks creator app rebranded as **No-Palette**.

No-Palette is a single-tool product. It is not a multi-tool dashboard.

The product is an abundance-first generative machine:
- each NoPunk is its own machine
- one canonical state exists per `tokenId + mode + Ethereum block`
- the same state is always reproducible
- the work is explored over time, not “used up” as limited inventory

## Product Identity

- Product: `No-Palette`
- UI direction: `Noir de Noir` (black-on-black instrument shell)
- Core action label: `No-Generate`
- Core artifact: `1024x1024` PNG from `24x24` source truth
- Optional series artifact: `1536x1024` contact sheet for `serial-pop`
- JSON sidecar is required for provenance and state replay

## Non-Negotiables

1. **24x24 truth**
- All transforms happen on the canonical `24x24` RGBA grid first.
- The `24x24` bytes are the source of truth for hashing, palette extraction, and state derivation.

2. **Nearest-neighbor only**
- All upscaling must be nearest-neighbor only.
- No blur, antialiasing, smoothing, interpolation, or resampling.

3. **No invented pixels**
- No structural pixel changes.
- Modes may only remap or reassign colors on existing occupied pixels.
- No new geometry, no removed geometry.

4. **No text in outputs**
- Generated media must not contain labels, watermarks, captions, or UI overlays.

5. **Determinism**
- Same `tokenId + mode + blockNumber + toolVersion + source 24x24 bytes` must produce the same output.
- Randomness must come only from the derived canonical state seed.

6. **Abundance-first**
- Do not frame outputs as limited editions.
- No scarcity counters, no “remaining,” no supply-cap copy, no collectible-value messaging.

## Canonical NoPunks Role Logic

These rules are hard invariants across every mode.

### Role meanings
- `#000000` = original background role
- `#040404` = original outline role

Local cutout assets are acceptable as implementation detail, but:
- `alpha == 0` is treated as the implicit original `#000000` background role

### Role rule (exact)
For any generated state:
- `B = generated background`
- `O = clamp(B + (4,4,4))`

Constraints:
- `B` is always the darkest role
- `O` is always the outline role
- `O` is derived from `B`, never independently chosen
- non-role colors must remain above the outline relief floor

This preserves the NoPunks black-on-black relationship:
- background darkest
- outline next
- expressive regions above that

## Canonical State Model (v2)

The primary state is:
- `tokenId`
- `modeId`
- `blockNumber`
- `toolVersion`
- source `24x24 RGBA bytes`

### Derived state seed
Use:
- `derivedState = SHA256(rgba24Bytes || tokenId || modeId || blockNumber || toolVersion || nudge)`

Notes:
- `nudge` is optional and only used for deterministic collision nudging retries
- user-visible manual seed is no longer the primary concept in v2
- historical replay must produce the same result for the same state

## Block Model

### Canonical block behavior
- One canonical state exists per `tokenId + mode + blockNumber`
- Users can revisit any block and reproduce the same output
- Default UI behavior is to use the latest Ethereum head when available

### Block source
Primary source:
- `ETH_RPC_URL` via JSON-RPC `eth_blockNumber`

Optional env:
- `ETH_CHAIN_ID` (default `1`)

### Fallback behavior
If no RPC is configured or head lookup fails:
- live head is unavailable
- manual block input must still work
- the app remains usable without live head sync

## On-Chain Rarity as Artistic Signal

Rarity is still used, but not as user-facing scarcity framing.

### User-facing term
Use:
- `Extremeness`

Do not foreground:
- rarity rank
- scarcity language
- collectible value language

### Behavior
On-chain trait rarity (or fallback estimate) influences:
- extrapolation breadth
- chroma expansion
- mode boldness
- contrast tolerance
- pattern aggressiveness in dither mode

It never changes:
- determinism
- role logic
- pixel structure
- nearest-neighbor constraints

## Public Modes (v2)

Only these first-class modes ship publicly in v2.

### 1. `canonical-machine`
- Base deterministic block-state palette machine
- Role pair generated first
- Structurally faithful palette remap
- Output: `1024x1024` PNG

### 2. `dither-study`
- Deterministic texture study on the `24x24` grid
- Only reassigns colors on existing occupied pixels
- No geometry invention
- Background and outline roles remain intact
- Output: `1024x1024` PNG

### 3. `serial-pop`
- Six related nearby block states shown as a sequence
- Main state is still the selected block
- Nearby blocks become a coherent series
- Outputs:
  - `single` => `1024x1024` PNG
  - `contact-sheet` => `1536x1024` PNG, edge-to-edge `3x2`

## Mode Rules

### `canonical-machine`
- Generates a valid canonical palette mapping from the source palette
- Preserves role ordering and silhouette readability
- Uses block-derived state instead of user seed

### `dither-study`
- Build a valid canonical palette first
- Then apply deterministic pattern reassignment only on occupied pixels
- Allowlisted strategies:
  - `ordered-2x2`
  - `ordered-4x4`
  - `checker-phase`
  - `threshold-slice`
- Background role and outline role stay canonical

### `serial-pop`
- Build a series from nearby blocks
- Locked offsets relative to selected block:
  - `-2, -1, 0, +1, +2, +3`
- Each panel must preserve canonical role logic
- Panels should feel related but visibly distinct

## Uniqueness Model (v2)

The old permanent color-reservation model is no longer the live blocking rule.

### What changed
Previous behavior:
- `used_colors` permanently blocked exact RGB reuse per token across all time

v2 behavior:
- uniqueness is defined by canonical block-addressed state
- the primary uniqueness identity is:
  - `(tokenId, modeId, blockNumber, outputKind)`

### Practical uniqueness policy
Literal eternal non-repetition cannot be guaranteed in a finite color/pixel space.

Instead, the engine must:
- strongly bias away from short-range visual collisions
- compare recent nearby state signatures
- apply deterministic nudges when a short-range collision is detected

### Collision nudging
For a bounded recent window (recommended `±16` blocks):
- compare `state_signature`
- if collision is detected, retry with deterministic nudges such as:
  - palette phase shift
  - anchor re-selection
  - dither phase shift
  - accent rotation
- if bounded retries are exhausted:
  - fail with a deterministic error, or
  - accept a rare collision only when explicitly allowed by the implementation spec for that output class

## Persistence Model

The database is a cache and provenance layer, not a scarcity gate.

### Required tables
- `rarity_cache`
- `generations`
- `used_colors` (legacy / optional research only; not a live blocker)

### Required `generations` fields
- `id`
- `token_id`
- `derived_seed`
- `tool_version`
- `palette_signature`
- `output_24_hash`
- `rarity_norm`
- `rarity_source`
- `strict_mode`
- `created_at`
- `block_number`
- `mode_id`
- `output_kind`
- `state_signature`

### Canonical uniqueness key
Use:
- `UNIQUE(token_id, mode_id, block_number, output_kind)`

This guarantees:
- one cached artifact per canonical state
- repeated requests for the same state return the same cached output

### Legacy rows
- Older seed-based generations may remain in the DB
- They are legacy records, not v2 canonical state records

## Core Pipeline (Required Order)

1. Load the canonical NoPunk cutout asset
2. Interpret `alpha == 0` as implicit original `#000000` background role
3. Decode the canonical `24x24` RGBA bytes
4. Resolve canonical block number (explicit block or latest head)
5. Resolve extremeness from on-chain rarity cache/fallback
6. Derive the canonical state seed from source bytes + token + mode + block + tool version
7. Build the canonical role pair first (`B`, `O = B + #040404`)
8. Generate the mode-specific palette mapping / within-grid reassignment
9. Apply deterministic collision nudging if recent-window state signatures collide
10. Render the final `24x24` output
11. Upscale to target output size with nearest-neighbor only
12. Persist PNG + JSON sidecar + canonical generation row
13. Return API payload for the exact state

## API Contracts (v2)

### `GET /api/no-palette/config`
Returns:
- `toolVersion`
- `strictMode`
- `blockMode` (`ethereum-head`)
- `liveHeadAvailable`
- `head.latestBlockNumber` when available
- `outputs`
- `roleRule`
- `extremeness` metadata
- `block.chainId`
- `modes`

### `GET /api/no-palette/block/head`
Returns:
- latest head block when live head is available

If unavailable:
- return explicit `live-head-unavailable`

### `GET /api/no-palette/rarity/:tokenId`
Returns:
- normalized intensity signal
- user-facing `extremeness` label
- provenance source
- optional rank/total for provenance only

### `POST /api/no-palette/generate`
Request:
- `tokenId`
- `mode`
- `blockNumber`
- `outputKind`

Rules:
- `mode` defaults to `canonical-machine` if omitted by older clients
- `blockNumber` uses latest head only when live head is available
- `outputKind` must match the selected mode’s allowlist

Response must include:
- `generationId`
- `tokenId`
- `mode`
- `block`
- `state`
- `extremeness`
- `output`
- `preview`

### `GET /api/no-palette/history/:tokenId`
Must support:
- `limit`
- `offset`
- `mode`
- `outputKind`

History rows must expose:
- `modeId`
- `blockNumber`
- `outputKind`
- file URLs
- `legacySeeded` marker where applicable

### `GET /api/no-palette/files/:generationId/:fileName`
Allowlisted files only:
- `output.png`
- `output.json`

## JSON Sidecar Requirements

Each generation sidecar must record:
- canonical state identity (`tokenId`, `mode`, `block`)
- `derivedState`
- `stateSignature`
- `toolVersion`
- `extremeness`
- original palette
- generated roles
- generated palette
- preview `24x24` bytes (or equivalent deterministic reconstruction data)
- output hashes
- invariants summary

For `serial-pop`, the sidecar must also include:
- all frame offsets
- per-frame block numbers
- per-frame state signatures
- contact sheet layout metadata

## UI Requirements

The UI is a stage-first instrument, not a dashboard.

### Required controls
- mode rail (`Machine`, `Dither`, `Serial`)
- block rail:
  - latest
  - block input
  - step backward / forward
  - jump / generate controls
- `No-Generate`
- download PNG
- download JSON
- contact sheet download when relevant

### Required displays
- large main output stage
- source preview on canonical black
- `24x24` truth preview
- palette rail showing:
  - `BG`
  - `OL`
  - body swatches
  - accent swatches
- sequence tag:
  - `#token · Block N · Mode`
- extremeness meter

### UI copy rules
Keep:
- `Per-Block Machine`
- `Canonical State`
- `Extremeness`
- `24×24 truth`

Do not use:
- supply cap framing
- scarcity framing
- edition framing
- visible “rarity” as the hero concept

## Testing Requirements

### State determinism
1. same `token + mode + block` => identical output
2. same `token + block`, different mode => distinct output
3. different token, same `mode + block` => distinct output

### Canonical role logic
4. background is darkest
5. outline is always `background + (4,4,4)`
6. non-role colors remain above the outline relief floor

### Dither mode
7. dither changes only color assignment on existing occupied pixels
8. no new pixels are invented
9. pattern phase changes across nearby blocks while remaining deterministic

### Serial mode
10. single output is `1024x1024`
11. contact sheet is exactly `1536x1024`
12. contact sheet uses the locked six block offsets
13. all panels are nearest-neighbor and unsmoothed

### Persistence / caching
14. repeated request for the same canonical state reuses the cached output
15. `used_colors` is not a live blocker in v2 generation
16. legacy seeded rows remain readable

## Failure Handling

### Invalid block
- reject with explicit validation error
- do not mutate current state

### Live head unavailable
- surface a quiet unavailable status
- keep manual block input usable

### Short-range collision exhaustion
- fail with deterministic error after bounded nudges
- do not partially persist files or rows

### Contact sheet frame failure
- fail the whole contact sheet
- do not persist partial series output

## Codex Response Format for Future Changes

When implementing changes in this app, respond with:
- what changed
- where it lives (route / file path)
- how to run locally
- how to verify (tests / smoke path)

No marketing copy.
