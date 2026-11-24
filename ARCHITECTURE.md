# Project MAUL-FORGE — System Architecture

## 1. Design Philosophy & Zero-Backend Invariants
Project **MAUL-FORGE: Bastion TD** ("Obsidian Bastion & Living Clockwork Arcane") is a 100% client-side, zero-build-step native ES Module web application and installable WebAPK PWA targeting GitHub Pages subpath hosting (`https://krunked-fpv.github.io/<repo-slug>/` via strictly relative `./` paths). Zero external runtime CDNs, zero server APIs, and zero Node dependencies exist at runtime.

```
+-----------------------------------------------------------------------------+
| index.html + styles/hud.css (100dvw x 100dvh, zero-jitter CSS Grid HUD)    |
+-----------------------------------------------------------------------------+
| src/main.js (60Hz fixed-timestep accumulator + rAF interpolated render)     |
|   +--> src/ui/input-controller.js (Mouse, Hotkeys, Touch Pinch + 2-Step Tap)|
|   +--> src/ui/command-card.js (4x3 WC3 QWER/ASDF/ZXCV Command Deck)         |
|   +--> src/ui/portrait-minimap.js (Live 112x112 Portrait + Minimap Frustum) |
+-------------+-----------------------------+---------------------+-----------+
              |                             |                     |
              v                             v                     v
+-------------------------+   +---------------------------+  +----------------+
| src/engine/* (Pure Sim) |   | src/render/* (2.5D + GL2) |  | src/audio/*    |
| - grid-flowfield.js     |   | - viewport-camera.js      |  | - dsp-context  |
| - spatial-hash.js       |   | - terrain-decals.js       |  | - foley-patches|
| - towers-data.js        |   | - tower-rigs.js           |  | - sound-direct.|
| - waves-combat.js       |   | - builder-rig.js          |  +----------------+
| - ecs-sim.js            |   | - creep-rigs.js           |
+------------+------------+   | - status-overlays.js      |  +----------------+
             |                | - projectiles-vfx.js      |  | src/storage/*  |
             |                | - ragdoll-particles.js    |  | - cookie-vault |
             |                | - postfx-webgl.js         |  | - run-persist. |
             +----------------+---------------------------+->| - maze-cart.   |
                                                             +----------------+
All layers import frozen enums & contracts from src/contracts/types.js
```

## 2. Fixed-Timestep Simulation & Dual-Gate Flow-Field Engine
- **Tick Rate**: `SIM_TICK_HZ = 60` (`SIM_DT = 1/60s`). `src/main.js` accumulates `rAF` delta clamped to `50ms`, executing `1..4 * sim.gameSpeed` fixed ticks per frame, then passes interpolation factor `alpha` (`0..1`) to the renderer.
- **Sanctuary Sub-Grid**: `32 x 22` logical `1x1` cells (`704` total cells). Towers occupy `2 x 2` footprints snap-aligned on `1x1` integer coordinates (`0 <= col <= 30`, `0 <= row <= 20`), supporting classic Wintermaul half-offset switchbacks and diagonal sawtooth corridors.
- **Landmarks**:
  - Dual Spawn Portals: North Rift `(1, 2, 2x2)` and South Rift `(1, 18, 2x2)`.
  - Central Ley Shrine Waypoint: `(15, 10, 2x2)` — creeps enter at `stage = 0` seeking `WAYPOINTS[0]`, transition to `stage = 1` within `1.2` tiles of shrine center, then seek `NEXUS_CORE` `(29, 10, 2x2)`.
  - Four `1x2` Obsidian Pillar Obstacles at `(8,0)`, `(8,20)`, `(22,0)`, `(22,20)`.
- **Zero-Allocation Octile Dijkstra Flow-Field (`< 0.8ms`)**:
  - Two pre-allocated `Float32Array(704)` distance fields (`distToWaypoint`, `distToNexus`) and `Float32Array(1408)` flow vector fields (`dirToWaypoint`, `dirToNexus`) driven by a pre-allocated binary min-heap / bucket queue (`Int32Array(704)`).
  - **Strict Anti-Corner-Cutting**: Diagonal neighbor transitions `(dx, dy)` are permitted ONLY when both orthogonal neighbors `(x + dx, y)` and `(x, y + dy)` have `(flags & (TOWER | OBSTACLE)) === 0`. Wall-adjacent cells add gentle inward repulsion so ground creeps never clip tower corners or tunnel into walls.
  - **Dual-Gate Anti-Block Trial Pass**: `canPlaceTower(col, row, activeGroundCreeps)` writes the candidate `2x2` footprint into scratch `trialFlags`, runs two fast Dijkstra passes over `trialDistWaypoint` & `trialDistNexus`, and verifies:
    1. Every Spawn Portal reaches `WAYPOINTS[0]` and `WAYPOINTS[0]` reaches `NEXUS_CORE`.
    2. Every currently alive ground creep (`!creep.isFlying || creep.earthboundTimer > 0`) has finite distance in its active stage field (`stage === 0 ? trialDistWaypoint : trialDistNexus`) and does not physically overlap the `2x2` footprint.
- **Spatial Hash**: Pre-allocated flat `Int32Array` cell-head (`704` slots) + next-node (`512` slots) linked list cleared in `O(704)` each tick for `O(1)` average radius queries and ray/corridor checks.

## 3. Layered 2.5D Canvas2D + WebGL2 Post-FX Pipeline
- **Orthographic Pitched Camera**: World units map via `worldToScreen(wx, wy, wz)` using `CAMERA_PITCH_Y = 0.80` vertical foreshortening and `CAMERA_ELEV_SCALE = 0.72` Z-altitude lift, locked crisply to `Math.min(devicePixelRatio || 1, 2)`.
- **Performance Guardrails (Locked 60 FPS)**:
  - **Zero `ctx.shadowBlur` in inner entity loops**: Glows, runes, and ice prisms use layered low-alpha strokes/fills (`globalCompositeOperation = 'lighter'` where appropriate) to eliminate GPU Gaussian blur stalls.
  - **Cached Terrain Base**: Carved runic slate tiles, bevel borders, and ley-channel grooves cache onto an offscreen canvas invalidated only on zoom/resize.
  - **Ring-Buffered VFX**: Particles (`MAX_PARTICLES = 2048` Struct-of-Arrays) and Terrain Decals (`MAX_DECALS = 256` scorch/acid/frost/crack/slag) use fixed ring buffers with zero GC allocations.
  - **WebGL2 Half-Res Post-FX (`src/render/postfx-webgl.js`)**: Composites `#battle-canvas` onto `#postfx-canvas` with soft bloom highlight extraction and frost/danger edge vignettes. Automatically handles `webglcontextlost` and degrades cleanly to direct Canvas2D display if WebGL2 is unavailable.

## 4. Procedural Web Audio DSP Graph
- Lazy `AudioContext` instantiation strictly on user gesture (`unlock()`).
- Signal Graph: `[Per-Voice Source + Envelope Gain + BiquadFilter] -> StereoPannerNode (pan from screen X) -> MasterGain -> DynamicsCompressorNode -> destination`.
- Hard `VOICE_POOL_LIMIT = 24` voice cap with oldest/lowest-priority voice stealing and per-patch cooldown throttling (`18–50ms`) so 20+ towers firing concurrently never clip or leak AudioNodes.

## 5. `krunked-cookie-vault-v1` Bidirectional Auto-Healing Architecture
- State replicates identically across **3 independent browser stores**:
  1. `LocalStorage` (`STORAGE_KEY_PRIMARY = 'maul-forge-state-v1'`)
  2. `IndexedDB` (`IDB_DB_NAME = 'maul-forge-idb-v1'`, store `bastion_vault`)
  3. Shadow Cookie (`krunked-cookie-vault-v1=<LZ+Base64URL>; SameSite=Lax; path=./; max-age=31536000`), strictly capped under `3500` bytes (`COOKIE_VAULT_MAX_BYTES`) via bit-packed binary serialization + LZ byte compression.
- **Bidirectional Reconciliation (`bootAndHeal` & `reconcileIfTampered`)**:
  - Each snapshot carries a monotonic `updatedAt` timestamp and `rev` counter plus a 32-bit FNV-1a integrity checksum inside the binary vault payload.
  - **Primary Wipe Recovery**: If both `LocalStorage` and `IndexedDB` are cleared/empty while `krunked-cookie-vault-v1` exists, `bootAndHeal()` decodes the cookie vault, restores full meta-progression + active wave/tower checkpoint, and immediately re-hydrates `LocalStorage` and `IndexedDB`.
  - **Cookie Wipe Recovery**: If `krunked-cookie-vault-v1` is cleared while either `LocalStorage` or `IndexedDB` remains intact, `bootAndHeal()` / `reconcileIfTampered()` automatically regenerates `krunked-cookie-vault-v1` from the freshest surviving primary store.
  - **Link Sharing**: `#maze=<Base64URL>` shares exact tower grids, tiers, fusions, Chaos flags, and seed deterministically without any server.

## 6. Subpath-Safe WebAPK PWA Topology
- Every asset link, ES import, manifest `start_url`/`scope`, cookie `path=./`, and Service Worker registration `./sw.js` (`scope: './'`) uses pure relative `./` resolution so `https://krunked-fpv.github.io/maul-forge/`, local subpath `/maul-forge/`, and root `/` behave identically.
- `sw.js` uses `MAUL_FORGE_CACHE_V1 = 'maul-forge-v1.0.0'`, pre-caches core shell assets on `install`, purges obsolete caches on `activate`, and executes a **network-first** `fetch` handler with offline cache fallback.
