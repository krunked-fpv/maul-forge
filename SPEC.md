# Project MAUL-FORGE — Technical Specification & Frozen Contracts

All shared constants live in `src/contracts/types.js`. Every module MUST match the exact signatures, data shapes, and numeric parameters below.

---

## 1. Tower Lineages, Tiers (T1–T4), Hybrid Fusions & Chaos Apex

### 1.1 Base Tower Lineages (6 Lineages x 4 Tiers)
All towers have `2x2` tile footprint. Upgrade cost shown is incremental gold for that tier (`totalCost` = cumulative gold).

1. **`ballista` — Watchtower Ballista (`Pierce`, Hotkey `Q` / `1`)**
   - T1 *Watchtower Ballista*: cost `60`, range `4.8`, cd `0.85s`, dmg `28`, projSpeed `16.5`, splash `0`
   - T2 *Twin-Torsion Repeater*: cost `85`, range `5.2`, cd `0.62s`, dmg `48`, projSpeed `18.5`, burst `2` (or double-bolt visuals)
   - T3 *Gryphon Bolter*: cost `150`, range `5.8`, cd `0.48s`, dmg `92`, projSpeed `21.0`
   - T4 *Sky-Reaver Bastion*: cost `260`, range `6.5`, cd `0.34s`, dmg `180`, projSpeed `24.0`, bonusAirMult `1.25`
2. **`mortar` — Dwarven Steam Mortar (`Siege`, Hotkey `W` / `2`)**
   - T1 *Dwarven Steam Mortar*: cost `80`, range `6.2`, cd `2.10s`, dmg `56`, projSpeed `8.5`, splash `1.65`, minRange `1.2`, triggers Shatter vs Frozen (`3.0x`)
   - T2 *Blackpowder Howitzer*: cost `115`, range `6.8`, cd `1.85s`, dmg `98`, projSpeed `9.2`, splash `1.90`
   - T3 *Piston Bombard*: cost `195`, range `7.4`, cd `1.60s`, dmg `185`, projSpeed `10.0`, splash `2.15`
   - T4 *Earthshaker Juggernaut*: cost `330`, range `8.2`, cd `1.40s`, dmg `350`, projSpeed `11.0`, splash `2.45`, knockupSec `0.45`
3. **`frost` — Frostweaver Spire (`Elemental`, Hotkey `E` / `3`)**
   - T1 *Frostweaver Spire*: cost `70`, range `4.2`, cd `1.05s`, dmg `20`, projSpeed `13.5`, chillPct `0.28`, chillSec `2.8`
   - T2 *Rime Obelisk*: cost `100`, range `4.6`, cd `0.90s`, dmg `38`, projSpeed `14.5`, chillPct `0.36`, chillSec `3.2`, splash `1.0`
   - T3 *Glacier Conduit*: cost `170`, range `5.1`, cd `0.78s`, dmg `74`, projSpeed `15.5`, chillPct `0.44`, chillSec `3.6`, splash `1.25`, freezeAccum `0.45`
   - T4 *Absolute Zero Cryo-Pylon*: cost `290`, range `5.6`, cd `0.68s`, dmg `135`, projSpeed `17.0`, chillPct `0.52`, chillSec `4.0`, splash `1.5`, freezeAccum `0.65` (at `>= 1.0` freezeAccum -> **Deep Freeze** prism `1.8s`, boss diminishing returns)
4. **`tesla` — Arcane Tesla Conduit (`Magic`, Hotkey `R` / `4`)**
   - T1 *Arcane Tesla Conduit*: cost `75`, range `4.4`, cd `1.15s`, dmg `26`, instant chain `3` bounces (`0.78` falloff), chainRadius `2.6`
   - T2 *Storm Pylon*: cost `110`, range `4.8`, cd `1.00s`, dmg `48`, chain `4` bounces (`0.80` falloff), chainRadius `2.9`
   - T3 *Lindenmayer Spire*: cost `185`, range `5.3`, cd `0.85s`, dmg `92`, chain `5` bounces (`0.82` falloff), chainRadius `3.2`, microStunSec `0.15`
   - T4 *Tempest Archon Coil*: cost `310`, range `5.9`, cd `0.72s`, dmg `175`, chain `6` bounces (`0.85` falloff), chainRadius `3.6`, microStunSec `0.22`
5. **`venom` — Alchemical Venom Vat (`Elemental`, Hotkey `F` / `5`)**
   - T1 *Alchemical Venom Vat*: cost `65`, range `4.0`, cd `0.95s`, dmg `16`, projSpeed `13.0`, acidStacks `1` (`-2.5` armor/stack up to `10`, `5.0s`), dotDps `10`
   - T2 *Corrosion Press*: cost `95`, range `4.4`, cd `0.82s`, dmg `30`, projSpeed `14.0`, acidStacks `2`, dotDps `20`
   - T3 *Plague Alembic*: cost `165`, range `4.9`, cd `0.70s`, dmg `56`, projSpeed `15.5`, acidStacks `2`, dotDps `38`, splash `0.9`
   - T4 *Blight-Press Distillery*: cost `280`, range `5.4`, cd `0.58s`, dmg `104`, projSpeed `17.0`, acidStacks `3`, dotDps `68`, splash `1.2`
6. **`brazier` — Hellfire Brazier (`Elemental`, Hotkey `V` / `6`)**
   - T1 *Hellfire Brazier*: cost `70`, range `3.8`, cd `0.90s`, dmg `24`, projSpeed `14.0`, igniteDps `18`, igniteSec `3.5`
   - T2 *Slag Furnace*: cost `105`, range `4.2`, cd `0.80s`, dmg `44`, projSpeed `15.0`, igniteDps `34`, igniteSec `4.0`, splash `0.85`
   - T3 *Magma Crucible*: cost `175`, range `4.6`, cd `0.70s`, dmg `86`, projSpeed `16.0`, igniteDps `64`, igniteSec `4.5`, splash `1.15`
   - T4 *Cinder-Forge Inferno*: cost `300`, range `5.1`, cd `0.58s`, dmg `160`, projSpeed `17.5`, igniteDps `115`, igniteSec `5.0`, splash `1.45`

### 1.2 Hybrid Elemental Fusions (9 Fusions, Unlocked at Tier >= 3)
Requires source tower at `tier >= 3` AND either an adjacent (Chebyshev tile edge distance `<= 3` centers) active catalyst tower matching the partner lineage OR spending `1` Fusion Essence (`useEssence = true`).

| Fusion ID | Name | Recipe | Attack | Cost | Range | CD | Dmg | Signature Mechanic |
|---|---|---|---|---|---|---|---|---|
| `glacial_obelisk` | Glacial Obelisk | `frost` + `tesla` | `Magic` | `340` | `6.0` | `1.15s` | `215` | Piercing cryo-lance encasing targets in **Deep Freeze** prism (`2.2s`), `chillPct: 0.55` |
| `hellfire_mortar` | Hellfire Mortar | `brazier` + `mortar` | `Siege` | `370` | `8.0` | `1.55s` | `360` | Napalm cluster shells (`splash: 2.4`), persistent burning slag decal + `140` ignite DPS |
| `plague_coil` | Plague Coil | `venom` + `tesla` | `Elemental` | `350` | `5.8` | `0.80s` | `155` | Emerald chain-lightning (`7` bounces, `3.6` radius) applying `2` Acid Sundering stacks/bounce |
| `shatter_cannon` | Shatter-Cannon | `frost` + `mortar` | `Siege` | `365` | `7.6` | `1.45s` | `310` | Cryo-howitzer (`splash: 2.2`, `chillPct: 0.45`) auto-detonating **Shatter (`3.0x`)** AoE vs Chilled/Frozen |
| `railgun_bastion` | Railgun Bastion | `ballista` + `tesla` | `Pierce` | `355` | `7.4` | `1.35s` | `295` | Hyper-velocity line slug punching straight corridor (`width: 0.65`, `len: 8.5`) piercing all targets |
| `viper_gatling` | Viper Gatling | `ballista` + `venom` | `Pierce` | `345` | `5.8` | `0.18s` | `54` | 6-barrel rotary toxin needles stripping `1` Acid stack per hit; melts Heavy/Hero armor |
| `singularity_catapult` | Singularity Catapult | `tesla` + `mortar` | `Magic` | `380` | `7.8` | `1.80s` | `280` | Dark-matter orb (`splash: 2.5`) pulling creeps inward + `0.70s` **Earthshaker Knock-Up** |
| `solar_flare` | Solar Flare Conduit | `brazier` + `tesla` | `Elemental` | `365` | `6.2` | `0.20s` | `66` | Continuous radiant beam (`2.5x` vs `Ethereal`/`ghoul_swarm`), leaves burning trail & `95` ignite DPS |
| `windchill_flak` | Windchill Flak Battery | `ballista` + `frost` | `Pierce` | `335` | `6.6` | `0.55s` | `145` | Quad cryo-harpoons (`splash: 1.3`, `chillPct: 0.40`); **Earthbinds Sky-Wyverns** (`4.5s`) to ground maze + `+50%` Air dmg |

### 1.3 Chaos Apex Ascension
- Any Tier 4 OR Hybrid Fusion tower can ascend once via `CHAOS_APEX_UPGRADE` (`cost: 420`, converts `attackType` to `'Chaos'` (`1.00x` across ALL 6 armor types), multiplies base damage `x 1.45`, `+0.6` range, golden Chaos halo).

---

## 2. Creep Archetypes & 50–100+ Wave Curve (`src/engine/waves-combat.js`)

| ID | Name | Armor | Base HP | Speed (t/s) | Base Armor | Bounty | Trait |
|---|---|---|---|---|---|---|---|
| `ghoul_swarm` | Ghoul Swarm | `Light` | `46` | `2.35` | `0` | `5` | High-count fast pack runners |
| `ironclad_grunt` | Ironclad Grunt | `Heavy` | `120` | `1.55` | `8` | `9` | Layered plates visibly stripped by Acid |
| `brood_arachnid` | Brood-Arachnid | `Medium` | `88` | `1.95` | `3` | `7` | 8-leg IK gait decelerating with Chill% |
| `sky_wyvern` | Sky-Wyvern | `Light` | `92` | `2.05` | `2` | `10` | `isFlying: true`; flies direct Spawn->Waypoint->Nexus unless Earthbound |
| `blood_shaman` | Blood-Ward Shaman | `Medium` | `135` | `1.65` | `4` | `12` | Pulses heal (`6%` maxHP every `2.6s`, radius `2.4`) to nearby creeps |
| `bulwark_golem` | Runed Bulwark Golem | `Fortified` | `245` | `1.18` | `12` | `16` | Hex barrier absorbs `25%` maxHP shield, regens after `3s` out of combat |
| `void_splitter` | Void Wraith / Splitter | `Ethereal` | `110` | `1.80` | `2` | `11` | Phasing wraith (`40%` dodge vs Siege/Pierce? No—uses `Ethereal` matrix `0.25x`), spawns `3` agile mini-slimes on death (`isSplitChild: true`) |
| `act_boss` | Act Boss | `Hero` (w10/30..), `Fortified` (w20/40..) | `1150` | `1.12` | `14` | `120` | Every 10th wave: `Marrow-Crag` (w10/60), `Zephyria` (w20/70), `Malakor` (w30/80+); stun/freeze diminishing returns (`0.40x` duration) |

- **Wave Scaling (`generateWaveSchedule(waveNumber)`)**:
  - HP Multiplier: `Math.pow(1.145, waveNumber - 1) * (1 + Math.max(0, waveNumber - 35) * 0.045)`
  - Bounty scaling: `Math.round(baseBounty * (1 + (waveNumber - 1) * 0.08))`
  - Waves `1..50`: curated cadence mixing swarm, heavy armor tests, Wyvern air waves (w5, w12, w18, w24, w32, w42, w48), Shaman heal waves, Bulwark siege checks, Void Splitter waves, and Bosses every 10 waves.
  - Waves `51..100+`: deterministic endless composer cycling combined multi-archetype packs with escalating spawn density (`18..48` creeps per gate) and Bosses every 10 waves (`w60..w100`).

---

## 3. Exact Module Exports & Data Shapes

### 3.1 `src/engine/grid-flowfield.js`
- `export class GridFlowField`:
  - `constructor()`
  - `flags` (`Uint8Array(704)`), `distToWaypoint` (`Float32Array(704)`), `distToNexus` (`Float32Array(704)`)
  - `reset()`
  - `canPlaceTower(col, row, activeGroundCreeps = [])` -> `{ valid: boolean, reason: string, baseTravelSec: number, previewTravelSec: number, deltaSec: number, previewPath: Array<{x:number,y:number}> }`
  - `placeTowerFootprint(col, row)` -> `boolean`
  - `removeTowerFootprint(col, row)` -> `boolean`
  - `recompute()` -> `number` (solve time in ms)
  - `sampleFlow(wx, wy, stage, outVec)` -> `{ x: number, y: number, dist: number }`
  - `traceGoldenPath(gateIndex = 0)` -> `Array<{x:number,y:number}>`
  - `findNearestWalkable(wx, wy)` -> `{ x: number, y: number }`

### 3.2 `src/engine/spatial-hash.js`
- `export class SpatialHash`:
  - `constructor(cols = GRID_COLS, rows = GRID_ROWS, maxEntities = MAX_CREEPS)`
  - `clear()`
  - `insert(idx, x, y)`
  - `queryRadius(x, y, radius, outIndices)` -> `number` (count appended to `outIndices`)
  - `querySegment(x1, y1, x2, y2, halfWidth, outIndices)` -> `number`

### 3.3 `src/engine/towers-data.js`
- `export const BASE_TOWERS` (dictionary keyed by `BASE_TOWER_IDS`)
- `export const FUSION_TOWERS` (dictionary keyed by `FUSION_TOWER_IDS`)
- `export const CHAOS_APEX_UPGRADE` (`{ cost: 420, dmgMultiplier: 1.45, rangeBonus: 0.6 }`)
- `export function getTowerStats(lineageId, tier, fusionId = null, isChaosApex = false)`
- `export function getAvailableFusionsForTower(tower, adjacentLineagesSet, fusionEssence = 0)` -> `Array<{ fusionId, name, partnerLineage, cost, canFuseByNeighbor, canFuseByEssence, ready }>`

### 3.4 `src/engine/waves-combat.js`
- `export const CREEP_DEFS`
- `export function generateWaveSchedule(waveNumber)` -> `{ waveNumber, isBossWave, bossTitle, spawnIntervalSec, groups: Array<{ archetypeId, count, gateId, hpMult, bountyMult }> }`
- `export function computeDamageMultiplier(attackType, armorType)` -> `number`
- `export function computeArmorFactor(baseArmor, acidStacks)` -> `{ effectiveArmor, multiplier }`
- `export function resolveHitDamage(rawDmg, attackType, creep, options = {})` -> `{ finalDamage, shieldAbsorbed, hpDamage, triggeredShatter, shatterAoeDmg }`

### 3.5 `src/engine/ecs-sim.js`
- `export class GameSim`:
  - Properties: `phase` (`'prep' | 'combat' | 'gameover'`), `wave`, `gold`, `lives`, `maxLives`, `essence`, `score`, `gameSpeed` (`1|2|3`), `builderMode` (`'spirit'|'instant'`), `towers` (`Array`), `creeps` (iterable active view or pool + `activeCreepIds`), `projectiles`, `builder` (`{ x, y, vx, vy, targetTowerId, mode, swingPhase, activeTask }`), `flowField` (`GridFlowField`), `spatialHash`, `lastFlowSolveMs`, `seed`.
  - Tower Object Shape: `{ id, col, row, cx, cy, lineageId, tier, fusionId, isChaosApex, buildState: 'queued'|'building'|'active', buildProgress, priority, cooldown, chargeGlow, recoil, yaw, targetCreepId, forcedCreepId, kills, totalDamage, dpsWindowDamage, currentDps, goldInvested, placedWave }`.
  - Creep Object Shape (pooled slots): `{ active, id, slot, archetypeId, armorType, x, y, prevX, prevY, z, vz, vx, vy, yaw, radius, hp, maxHp, shield, maxShield, baseArmor, speed, stage, gateId, isFlying, isBoss, isSplitChild, bounty, walkPhase, chillPct, chillTimer, freezeAccum, frozenTimer, acidStacks, acidTimer, igniteDps, igniteTimer, shockTimer, earthboundTimer, healCooldown, outOfCombatTimer, pathDist }`.
  - Methods: `previewTowerPlacement(col, row, lineageId)`, `placeTower(col, row, lineageId)`, `upgradeTower(towerId)`, `fuseTower(towerId, fusionId, useEssence = false)`, `sellTower(towerId)`, `cycleTowerPriority(towerId, dir = 1)`, `setTowerPriority(towerId, priority)`, `forceRetargetTower(towerId, creepId = -1)`, `rallyBuilder(wx, wy)`, `setBuilderMode(mode)`, `setGameSpeed(speed)`, `startNextWave()`, `step(dt = SIM_DT)`, `drainEvents(outArray = [])`, `getTowerById(id)`, `getTowerAtTile(col, row)`, `getCreepById(id)`, `getCreepAtWorld(wx, wy, pickRadius = 0.75)`, `getAdjacentLineages(tower)`, `serializeCheckpoint()`, `hydrateCheckpoint(snapshot)`, `resetRun(options = {})`.

### 3.6 Rendering Modules (`src/render/*`)
- `viewport-camera.js`: `export class ViewportCamera` (`resize`, `getScale`, `worldToScreen`, `screenToWorld`, `screenToTowerPlacement`, `panByScreenDelta`, `zoomAtScreenPoint`, `setCenter`, `getVisibleWorldBounds`).
- `terrain-decals.js`: `export class TerrainRenderer` (`addDecal`, `handleSimEvent`, `update`, `render(ctx, camera, sim, timeSec, ghostPreview)`).
- `tower-rigs.js`: `export class TowerRigRenderer` (`renderTowers(ctx, camera, towers, timeSec, selectedTowerId)`, `renderPortraitTower(ctx, width, height, tower, timeSec)`).
- `builder-rig.js`: `export class BuilderRigRenderer` (`handleSimEvent`, `update`, `render(ctx, camera, builder, timeSec)`).
- `postfx-webgl.js`: `export class PostFxCompositor` (`constructor(webglCanvas = null)`, `resize(w, h, dpr)`, `render(sourceCanvas2D, intensity, frostPulse, dangerPulse)`, `hasShaderErrors()`).
- `creep-rigs.js`: `export class CreepRigRenderer` (`renderCreeps(ctx, camera, sim, alpha, timeSec, selectedCreepId, statusOverlayRenderer)`, `renderPortraitCreep(ctx, width, height, creep, timeSec, statusOverlayRenderer)`).
- `status-overlays.js`: `export class StatusOverlayRenderer` (`renderCreepStatuses(ctx, screenX, screenY, groundY, scale, creep, timeSec)`).
- `projectiles-vfx.js`: `export class ProjectileVfxRenderer` (`handleSimEvent`, `update`, `render(ctx, camera, sim, alpha, timeSec)`).
- `ragdoll-particles.js`: `export class RagdollParticleSystem` (`constructor(maxParticles = MAX_PARTICLES)`, `spawn(opts)`, `handleSimEvent`, `update`, `render(ctx, camera)`).

### 3.7 Audio Modules (`src/audio/*`)
- `dsp-context.js`: `export class DspContext` (`unlock`, `setMuted`, `isMuted`, `setMasterVolume`, `getMasterVolume`, `acquireVoice`, `getActiveVoiceCount`, `getNoiseBuffer`).
- `foley-patches.js`: `export const FoleyPatches` (procedural Web Audio synth patches for all 16 game foley cues).
- `sound-director.js`: `export class SoundDirector` (`unlock`, `setMuted`, `toggleMute`, `isMuted`, `setMasterVolume`, `getMasterVolume`, `handleSimEvent(ev, worldWidth = GRID_COLS)`, `playUiClick()`).

### 3.8 Storage, Cookie Vault & Cartridge Format (`src/storage/*`)
- **Binary Cartridge Layout (`#maze=<Base64URL>` & `krunked-cookie-vault-v1`)**:
  - Raw binary bytes before LZ + Base64URL:
    - Byte `0`: `CARTRIDGE_MAGIC_VERSION` (`1`)
    - Byte `1`: flags (`bit0`: hasActiveRun, `bit1`: audioMuted, `bit2`: instantBuilder)
    - Bytes `2..3` (Uint16LE): `wave`
    - Bytes `4..7` (Uint32LE): `gold`
    - Bytes `8..9` (Uint16LE): `lives`
    - Bytes `10..11` (Uint16LE): `essence`
    - Bytes `12..15` (Uint32LE): `highScore`
    - Bytes `16..17` (Uint16LE): `bestWave`
    - Bytes `18..21` (Uint32LE): `seed`
    - Byte `22`: `towerCount` (`0..255`)
    - Per Tower (`4` bytes packed = 32 bits):
      - `col` (5 bits `0..31`) | `row` (5 bits `0..21`) | `lineageIdx` (3 bits `0..5`) | `tier` (2 bits `1..4` -> `0..3`) | `fusionIdx` (4 bits `0=none, 1..9=FUSION_TOWER_IDS`) | `isChaosApex` (1 bit) | `priorityIdx` (3 bits `0..5`) | `killsClamped` (9 bits `0..511`, scaled/clamped)
    - Trailing 4 bytes: FNV-1a / CRC32 checksum over all preceding bytes.
  - At `80` endgame towers: `23 + 320 + 4 = 347` raw bytes -> LZ + Base64URL `<= ~480` characters (even with metadata envelope `< 700` bytes, far below `COOKIE_VAULT_MAX_BYTES = 3500`!).
- **Exports**:
  - `src/storage/maze-cartridge.js`: `encodeCartridge(checkpoint)`, `decodeCartridge(hashOrToken)`, `buildCartridgeHash(checkpoint)`, `exportBlueprintJson(checkpoint)`, `importBlueprintJson(jsonStr)`.
  - `src/storage/cookie-vault.js`: `writeCookieVault(snapshot, cookieAccessor)`, `readCookieVault(cookieAccessor)`, `clearCookieVault(cookieAccessor)`.
  - `src/storage/run-persistence.js`: `export class RunPersistence` (`constructor(env = {})`, `async bootAndHeal()`, `async saveState(snapshot)`, `async reconcileIfTampered(fallbackSnapshot)`, `async clearRunOnly()`).
  - Checkpoint Snapshot Shape: `{ version: 1, updatedAt, rev, highScore, bestWave, settings: { muted, masterVolume, builderMode }, run: { wave, gold, lives, essence, score, seed, towers: Array<{ col, row, lineageId, tier, fusionId, isChaosApex, priority, kills, totalDamage, goldInvested }> } }`.

### 3.9 PWA, Validation & HUD (`manifest.json`, `sw.js`, `index.html`, `styles/hud.css`, `src/ui/*`, `src/main.js`)
- `manifest.json`: `"name": "Maul-Forge: Bastion TD"`, `"short_name": "MaulForge"`, `"display": "standalone"`, `"orientation": "any"`, `"background_color": "#0b0d12"`, `"theme_color": "#d4a238"`, `"start_url": "./"`, `"scope": "./"`, icons `./assets/icons/icon-192.png` (`192x192`, `image/png`, `any maskable`) and `./assets/icons/icon-512.png` (`512x512`, `image/png`, `any maskable`).
- `sw.js`: `const MAUL_FORGE_CACHE_V1 = 'maul-forge-v1.0.0';`, pre-cache relative `./` shell on `install`, prune non-matching caches on `activate` + `clients.claim()`, active **network-first** `fetch` handler updating cache on `200 OK` and serving cached responses offline.
- `scripts/validate-static-pwa.mjs`: CLI validator verifying PNG magic bytes (`89 50 4E 47 0D 0A 1A 0A`) & big-endian IHDR `192x192` / `512x512`, `manifest.json`, `sw.js`, zero root `/` path leaks or external CDNs, and `index.html` links when present or with `--strict`.
- `window.__MAUL_FORGE__` debug/QA hook in `src/main.js`: `{ sim, camera, persistence, soundDirector, postFx, getFrameStats, syncVaultNow, exportCartridgeHash, loadCartridgeHash }`.
