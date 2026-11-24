import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  GRID_COLS,
  GRID_ROWS,
  TOWER_FOOTPRINT,
  SIM_DT,
  CELL_FLAGS,
  BASE_TOWER_IDS,
  FUSION_TOWER_IDS,
  MAX_CREEPS,
  MAX_PROJECTILES,
  MAX_PARTICLES,
  SIM_EVENTS,
  BUILDER_MODES,
  TARGET_PRIORITIES,
} from '../src/contracts/types.js';
import { GameSim } from '../src/engine/ecs-sim.js';
import { generateWaveSchedule } from '../src/engine/waves-combat.js';
import { RagdollParticleSystem } from '../src/render/ragdoll-particles.js';
import { ProjectileVfxRenderer } from '../src/render/projectiles-vfx.js';
import { TerrainRenderer } from '../src/render/terrain-decals.js';

const BLOCKED_MASK = CELL_FLAGS.TOWER | CELL_FLAGS.OBSTACLE;

function createRng(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function assertAllFiniteAndInvariants(sim, particles, vfx, terrain, counters) {
  assert.ok(Number.isFinite(sim.gold) && sim.gold >= 0, `Invalid gold: ${sim.gold}`);
  assert.ok(Number.isFinite(sim.score) && sim.score >= 0, `Invalid score: ${sim.score}`);
  assert.ok(Number.isFinite(sim.lives) && sim.lives >= 0, `Invalid lives: ${sim.lives}`);
  assert.ok(Number.isFinite(sim.essence) && sim.essence >= 0, `Invalid essence: ${sim.essence}`);
  assert.ok(
    Number.isFinite(sim.builder.x) && Number.isFinite(sim.builder.y),
    `Invalid builder position: (${sim.builder.x}, ${sim.builder.y})`,
  );

  // Bounded pools
  assert.ok(sim.creeps.length <= MAX_CREEPS, `Creep pool exceeded ${MAX_CREEPS}: ${sim.creeps.length}`);
  assert.ok(
    sim.projectiles.length <= MAX_PROJECTILES,
    `Projectile pool exceeded ${MAX_PROJECTILES}: ${sim.projectiles.length}`,
  );
  assert.equal(particles.maxParticles, MAX_PARTICLES);
  assert.equal(particles.px.length, MAX_PARTICLES);
  assert.equal(particles.py.length, MAX_PARTICLES);
  assert.equal(particles.pz.length, MAX_PARTICLES);
  assert.ok(particles._highWater <= MAX_PARTICLES, `Particle highWater exceeded ${MAX_PARTICLES}`);
  assert.ok(particles.activeCount <= MAX_PARTICLES, `Particle activeCount exceeded ${MAX_PARTICLES}`);
  assert.equal(particles._rgbVals.length, 256);
  assert.equal(vfx._slots.length, 256);
  assert.equal(terrain.decalX.length, 256);

  // Tower numeric invariants
  for (let i = 0; i < sim.towers.length; i++) {
    const t = sim.towers[i];
    assert.ok(Number.isFinite(t.cx) && Number.isFinite(t.cy), `Tower ${t.id} NaN coords`);
    assert.ok(Number.isFinite(t.dmg) && t.dmg > 0, `Tower ${t.id} invalid dmg ${t.dmg}`);
    assert.ok(Number.isFinite(t.range) && t.range > 0, `Tower ${t.id} invalid range ${t.range}`);
    assert.ok(Number.isFinite(t.totalDamage), `Tower ${t.id} NaN totalDamage`);
  }

  // Projectile numeric invariants
  for (let i = 0; i < sim.projectiles.length; i++) {
    const p = sim.projectiles[i];
    assert.ok(
      Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
      `Projectile ${p.id} invalid pos (${p.x}, ${p.y}, ${p.z})`,
    );
    assert.ok(
      Number.isFinite(p.tx) && Number.isFinite(p.ty) && Number.isFinite(p.dmg),
      `Projectile ${p.id} invalid target/dmg`,
    );
  }

  // Creep numeric, walkability, and anti-corner-clipping invariants
  const flags = sim.flowField.flags;
  for (let i = 0; i < sim.creeps.length; i++) {
    const c = sim.creeps[i];
    assert.ok(
      Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z),
      `Creep ${c.id} invalid pos (${c.x}, ${c.y}, ${c.z})`,
    );
    assert.ok(
      Number.isFinite(c.vx) && Number.isFinite(c.vy) && Number.isFinite(c.vz),
      `Creep ${c.id} invalid vel (${c.vx}, ${c.vy}, ${c.vz})`,
    );
    assert.ok(
      Number.isFinite(c.hp) && Number.isFinite(c.maxHp) && Number.isFinite(c.shield),
      `Creep ${c.id} invalid hp/shield (${c.hp}/${c.maxHp}, shield=${c.shield})`,
    );
    assert.ok(c.x >= 0 && c.x <= GRID_COLS && c.y >= 0 && c.y <= GRID_ROWS, `Creep ${c.id} out of grid bounds (${c.x}, ${c.y})`);

    if (c.acidStacks > counters.maxAcidStacks) {
      counters.maxAcidStacks = c.acidStacks;
    }

    const isGround = !c.isFlying || c.earthboundTimer > 0;
    if (isGround) {
      const col = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(c.x)));
      const row = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(c.y)));
      assert.equal(
        flags[row * GRID_COLS + col] & BLOCKED_MASK,
        0,
        `Ground creep ${c.id} (${c.archetypeId}) stuck inside blocked cell (${col},${row}) at (${c.x.toFixed(3)}, ${c.y.toFixed(3)})`,
      );

      // Anti-corner-clipping check across single-tick normal traversal
      const stepDist = Math.hypot(c.x - c.prevX, c.y - c.prevY);
      if (stepDist > 0 && stepDist < 0.25) {
        const prevCol = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(c.prevX)));
        const prevRow = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(c.prevY)));
        if (col !== prevCol && row !== prevRow) {
          const adj1Blocked = (flags[prevRow * GRID_COLS + col] & BLOCKED_MASK) !== 0;
          const adj2Blocked = (flags[row * GRID_COLS + prevCol] & BLOCKED_MASK) !== 0;
          assert.equal(
            adj1Blocked && adj2Blocked,
            false,
            `Ground creep ${c.id} corner-clipped diagonally from (${prevCol},${prevRow}) to (${col},${row})`,
          );
        }
      }
    }
  }
}

function buildSprawlingSerpentineMaze(sim) {
  // Verify Spirit Architect builder works first on initial tower before switching to Instant Forge for 40-tower bastion
  const firstPlace = sim.placeTower(5, 2, 'frost');
  assert.equal(firstPlace.ok, true, 'Initial Spirit placement at (5,2) must succeed');
  assert.equal(firstPlace.tower.buildState, 'queued');

  const initEvents = [];
  let sawBuilderSpark = false;
  let sawBuilderComplete = false;
  for (let i = 0; i < 160; i++) {
    sim.step(SIM_DT);
    for (const ev of sim.drainEvents(initEvents)) {
      if (ev.type === SIM_EVENTS.BUILDER_SPARK) sawBuilderSpark = true;
      if (ev.type === SIM_EVENTS.TOWER_COMPLETE) sawBuilderComplete = true;
    }
    initEvents.length = 0;
    if (sawBuilderComplete) break;
  }
  assert.equal(sawBuilderSpark, true, 'Spirit builder must emit BUILDER_SPARK during initial build');
  assert.equal(sawBuilderComplete, true, 'Spirit builder must complete initial tower');

  sim.setBuilderMode(BUILDER_MODES.INSTANT);

  const placeAndUpgrade = (col, row, lineageId, targetTier = 4, fusionId = null, ascendApex = false) => {
    let tower = sim.getTowerAtTile(col, row);
    if (!tower) {
      const res = sim.placeTower(col, row, lineageId);
      assert.equal(res.ok, true, `Failed placing ${lineageId} at (${col},${row}): ${res.reason}`);
      tower = res.tower;
    } else {
      assert.equal(tower.lineageId, lineageId);
    }
    while (tower.tier < targetTier && !tower.fusionId) {
      const up = sim.upgradeTower(tower.id);
      assert.equal(up.ok, true, `Failed upgrading ${tower.lineageId} at (${col},${row}): ${up.reason}`);
    }
    if (fusionId) {
      const fuse = sim.fuseTower(tower.id, fusionId, true);
      assert.equal(fuse.ok, true, `Failed fusing ${fusionId} at (${col},${row}): ${fuse.reason}`);
    }
    if (ascendApex) {
      const apex = sim.upgradeTower(tower.id);
      assert.equal(apex.ok, true, `Failed Chaos Apex ascension at (${col},${row}): ${apex.reason}`);
      assert.equal(tower.isChaosApex, true);
    }
    return tower;
  };

  // Wall A (col=5, gap at row=0..1): forces North & South rifts up to top gap
  // Places adjacent pairs so fusions naturally leverage neighbor catalysts
  placeAndUpgrade(5, 2, 'frost', 4, null, false);
  placeAndUpgrade(5, 4, 'mortar', 4, null, false);
  placeAndUpgrade(5, 6, 'frost', 3, 'shatter_cannon', true);   // Fusion 1 + Chaos Apex #1
  placeAndUpgrade(5, 8, 'venom', 4, null, false);
  placeAndUpgrade(5, 10, 'tesla', 4, null, true);              // Base T4 + Chaos Apex #2
  placeAndUpgrade(5, 12, 'venom', 3, 'plague_coil', false);    // Fusion 2
  placeAndUpgrade(5, 14, 'brazier', 4, null, false);
  placeAndUpgrade(5, 16, 'ballista', 4, null, false);
  placeAndUpgrade(5, 18, 'ballista', 3, 'viper_gatling', false); // Fusion 3
  placeAndUpgrade(5, 20, 'mortar', 3, 'hellfire_mortar', false); // Fusion 4

  // Wall B (col=10, gap at row=20..21): forces serpentine sweep down to bottom gap
  placeAndUpgrade(10, 2, 'tesla', 4, null, false);
  placeAndUpgrade(10, 0, 'frost', 3, 'glacial_obelisk', true); // Fusion 5 + Chaos Apex #3
  placeAndUpgrade(10, 4, 'ballista', 3, 'railgun_bastion', false); // Fusion 6
  placeAndUpgrade(10, 8, 'tesla', 4, null, false);
  placeAndUpgrade(10, 6, 'mortar', 3, 'singularity_catapult', false); // Fusion 7
  placeAndUpgrade(10, 10, 'brazier', 3, 'solar_flare', false);  // Fusion 8
  placeAndUpgrade(10, 14, 'frost', 4, null, false);
  placeAndUpgrade(10, 12, 'ballista', 3, 'windchill_flak', false); // Fusion 9
  placeAndUpgrade(10, 16, 'venom', 3, 'plague_coil', false);
  placeAndUpgrade(10, 18, 'mortar', 4, null, false);

  // Wall C (col=18, gap at row=0..1): forces post-Shrine upward switchback
  const wallCLineages = [
    ['frost', 4, null],
    ['mortar', 3, 'shatter_cannon'],
    ['venom', 4, null],
    ['tesla', 3, 'plague_coil'],
    ['brazier', 4, null],
    ['ballista', 3, 'windchill_flak'],
    ['frost', 3, 'glacial_obelisk'],
    ['mortar', 3, 'hellfire_mortar'],
    ['ballista', 4, null],
    ['tesla', 4, null],
  ];
  for (let i = 0; i < wallCLineages.length; i++) {
    const [lin, tier, fus] = wallCLineages[i];
    const t = placeAndUpgrade(18, 2 + i * 2, lin, tier, fus, false);
    if (i % 3 === 0) sim.setTowerPriority(t.id, TARGET_PRIORITIES[i % TARGET_PRIORITIES.length]);
  }

  // Wall D (col=24, gap at row=20..21): final switchback before Nexus
  const wallDLineages = [
    ['ballista', 3, 'railgun_bastion'],
    ['tesla', 4, null],
    ['venom', 3, 'viper_gatling'],
    ['brazier', 3, 'solar_flare'],
    ['frost', 4, null],
    ['mortar', 3, 'singularity_catapult'],
    ['ballista', 3, 'windchill_flak'],
    ['venom', 4, null],
    ['mortar', 4, null],
    ['brazier', 4, null],
  ];
  for (let i = 0; i < wallDLineages.length; i++) {
    const [lin, tier, fus] = wallDLineages[i];
    const t = placeAndUpgrade(24, i * 2, lin, tier, fus, false);
    if (i % 2 === 1) sim.setTowerPriority(t.id, TARGET_PRIORITIES[(i + 2) % TARGET_PRIORITIES.length]);
  }

  // Bay artillery & rapid-fire batteries for high concurrent projectile saturation
  placeAndUpgrade(7, 4, 'ballista', 3, 'viper_gatling', false);
  placeAndUpgrade(7, 16, 'mortar', 3, 'hellfire_mortar', false);
  placeAndUpgrade(12, 4, 'ballista', 3, 'viper_gatling', false);
  placeAndUpgrade(12, 16, 'mortar', 3, 'shatter_cannon', false);
  placeAndUpgrade(20, 4, 'ballista', 3, 'viper_gatling', false);
  placeAndUpgrade(20, 16, 'ballista', 3, 'windchill_flak', false);

  // Assert all 6 base lineages, all 9 fusions, T4, and >= 2 Chaos Apex towers exist
  const presentLineages = new Set(sim.towers.map((t) => t.lineageId));
  const presentFusions = new Set(sim.towers.map((t) => t.fusionId).filter(Boolean));
  const t4Count = sim.towers.filter((t) => t.tier >= 4).length;
  const apexCount = sim.towers.filter((t) => t.isChaosApex).length;

  for (const id of BASE_TOWER_IDS) {
    assert.equal(presentLineages.has(id), true, `Missing base lineage ${id}`);
  }
  for (const fid of FUSION_TOWER_IDS) {
    assert.equal(presentFusions.has(fid), true, `Missing fusion tower ${fid}`);
  }
  assert.ok(t4Count >= 6, `Expected >= 6 Tier-4 towers, got ${t4Count}`);
  assert.ok(apexCount >= 2, `Expected >= 2 Chaos Apex towers, got ${apexCount}`);

  // Verify the serpentine maze dramatically extends golden travel path
  const path0 = sim.flowField.traceGoldenPath(0);
  const path1 = sim.flowField.traceGoldenPath(1);
  assert.ok(path0.length > 80 && path1.length > 80, `Expected long serpentine maze paths, got lengths ${path0.length}, ${path1.length}`);
}

function runAdversarialMidWaveStress(sim, rng, ephemeralIds, counters) {
  const illegalChokes = [
    [5, 0],
    [10, 20],
    [18, 0],
    [24, 20],
  ];
  const [blockCol, blockRow] = illegalChokes[counters.adversarialPasses % illegalChokes.length];

  // Snapshot grid & sim state before illegal placement attempts
  const flagsSnap = new Uint8Array(sim.flowField.flags);
  const wpSnap = new Float32Array(sim.flowField.distToWaypoint);
  const nxSnap = new Float32Array(sim.flowField.distToNexus);
  const towerCountBefore = sim.towers.length;
  const goldBefore = sim.gold;

  // 1. Attempt sealing the sole serpentine gap -> MUST be rejected with zero mutation
  const blockPreview = sim.previewTowerPlacement(blockCol, blockRow, 'ballista');
  assert.equal(blockPreview.valid, false, `Choke (${blockCol},${blockRow}) must be rejected`);
  const blockRes = sim.placeTower(blockCol, blockRow, 'ballista');
  assert.equal(blockRes.ok, false, `placeTower at choke (${blockCol},${blockRow}) must fail`);
  counters.illegalBlocksRejected++;

  // 2. Attempt placing directly on a live ground creep if one is present
  const groundCreep = sim.creeps.find((c) => c.active && (!c.isFlying || c.earthboundTimer > 0));
  if (groundCreep) {
    const cc = Math.max(0, Math.min(GRID_COLS - TOWER_FOOTPRINT, Math.floor(groundCreep.x)));
    const cr = Math.max(0, Math.min(GRID_ROWS - TOWER_FOOTPRINT, Math.floor(groundCreep.y)));
    const creepPreview = sim.previewTowerPlacement(cc, cr, 'mortar');
    assert.equal(creepPreview.valid, false, `Placing on active ground creep at (${cc},${cr}) must be rejected`);
    const creepRes = sim.placeTower(cc, cr, 'mortar');
    assert.equal(creepRes.ok, false);
    counters.illegalBlocksRejected++;
  }

  assert.deepEqual(sim.flowField.flags, flagsSnap, 'Illegal placement mutated flowField.flags');
  assert.deepEqual(sim.flowField.distToWaypoint, wpSnap, 'Illegal placement mutated distToWaypoint');
  assert.deepEqual(sim.flowField.distToNexus, nxSnap, 'Illegal placement mutated distToNexus');
  assert.equal(sim.towers.length, towerCountBefore, 'Illegal placement mutated tower list');
  assert.equal(sim.gold, goldBefore, 'Illegal placement deducted gold');

  // 3. Random placement trial across arbitrary grid cells (valid must agree with placeTower)
  for (let k = 0; k < 2; k++) {
    const rCol = Math.floor(rng() * (GRID_COLS - 1));
    const rRow = Math.floor(rng() * (GRID_ROWS - 1));
    const lin = BASE_TOWER_IDS[Math.floor(rng() * BASE_TOWER_IDS.length)];
    const prev = sim.previewTowerPlacement(rCol, rRow, lin);
    if (!prev.valid) {
      const failRes = sim.placeTower(rCol, rRow, lin);
      assert.equal(failRes.ok, false, `placeTower(${rCol},${rRow}) succeeded despite invalid preview`);
      counters.randomRejected++;
    } else if (ephemeralIds.length < 4) {
      const okRes = sim.placeTower(rCol, rRow, lin);
      assert.equal(okRes.ok, true, `placeTower(${rCol},${rRow}) failed despite valid preview: ${okRes.reason}`);
      ephemeralIds.push(okRes.tower.id);
      counters.midWavePlacements++;
    }
  }

  // 4. Mid-wave sell + rebuild re-mazing in open bay spur slots while creeps traverse corners
  if (ephemeralIds.length > 0) {
    const victimId = ephemeralIds.shift();
    const sellRes = sim.sellTower(victimId);
    assert.equal(sellRes.ok, true, `Mid-wave sellTower(${victimId}) failed`);
    counters.midWaveSells++;
  }

  const bayCandidates = [
    [7, 6], [7, 12], [12, 6], [12, 14],
    [20, 6], [20, 14], [26, 6], [26, 14],
  ];
  const pick = bayCandidates[(counters.adversarialPasses * 3 + Math.floor(rng() * bayCandidates.length)) % bayCandidates.length];
  const bayPreview = sim.previewTowerPlacement(pick[0], pick[1], BASE_TOWER_IDS[counters.adversarialPasses % BASE_TOWER_IDS.length]);
  if (bayPreview.valid && ephemeralIds.length < 4) {
    const bayPlace = sim.placeTower(pick[0], pick[1], BASE_TOWER_IDS[counters.adversarialPasses % BASE_TOWER_IDS.length]);
    assert.equal(bayPlace.ok, true, `Bay re-maze placement at (${pick[0]},${pick[1]}) failed`);
    ephemeralIds.push(bayPlace.tower.id);
    counters.midWavePlacements++;
  }

  counters.adversarialPasses++;
}

function runStressSuite() {
  const rng = createRng(0x51a71c55);
  const sim = new GameSim({
    builderMode: BUILDER_MODES.SPIRIT,
    startingGold: 500000,
    startingLives: 50000,
    startingEssence: 100,
    seed: 0x100100aa,
  });

  const particles = new RagdollParticleSystem(MAX_PARTICLES);
  const vfx = new ProjectileVfxRenderer();
  const terrain = new TerrainRenderer();

  buildSprawlingSerpentineMaze(sim);

  // Validate deterministic schedule generation for all 100 waves up front
  for (let w = 1; w <= 100; w++) {
    const sched = generateWaveSchedule(w);
    assert.equal(sched.waveNumber, w);
    assert.ok(sched.groups.length > 0);
  }

  const counters = {
    wavesStarted: 0,
    wavesCleared: 0,
    shatterCount: 0,
    chainLightningCount: 0,
    maxChainPoints: 0,
    earthboundCount: 0,
    knockupLandCount: 0,
    bossKills: 0,
    maxAcidStacks: 0,
    peakCreeps: 0,
    peakCreepsDuringStress: 0,
    peakProjectiles: 0,
    peakActiveParticles: 0,
    adversarialPasses: 0,
    illegalBlocksRejected: 0,
    randomRejected: 0,
    midWavePlacements: 0,
    midWaveSells: 0,
  };

  const ephemeralTowerIds = [];
  const tickEvents = [];
  const stepTimings = [];

  // Step through all 100 waves:
  // - Waves 1..25: allow waves to clear cleanly (exercises WAVE_CLEARED, early bosses Marrow-Crag & Zephyria)
  // - Waves 26..100: overlap waves aggressively as soon as previous wave finishes spawning (keeping creeps < 360)
  //   so concurrent creeps saturate >= 180 while ground + flying creeps traverse serpentine corners!
  sim.startNextWave();
  counters.wavesStarted = sim.wave;

  const MAX_TOTAL_TICKS = 140000;
  let totalTicks = 0;

  while (totalTicks < MAX_TOTAL_TICKS) {
    totalTicks++;

    const t0 = performance.now();
    sim.step(SIM_DT);

    // Every ~2 simulated seconds (120 ticks) during active combat, execute adversarial mid-wave stress
    if (totalTicks % 120 === 0 && sim.phase === 'combat') {
      runAdversarialMidWaveStress(sim, rng, ephemeralTowerIds, counters);
      if (sim.creeps.length > counters.peakCreepsDuringStress) {
        counters.peakCreepsDuringStress = sim.creeps.length;
      }
    }

    const stepElapsedMs = performance.now() - t0;
    stepTimings.push(stepElapsedMs);

    // Drain events and drive VFX, terrain decals, and bounded 2048-slot particle pool
    sim.drainEvents(tickEvents);
    for (let i = 0; i < tickEvents.length; i++) {
      const ev = tickEvents[i];
      particles.handleSimEvent(ev);
      vfx.handleSimEvent(ev);
      terrain.handleSimEvent(ev);

      if (ev.type === SIM_EVENTS.SHATTER_COMBO) counters.shatterCount++;
      else if (ev.type === SIM_EVENTS.CHAIN_LIGHTNING) {
        counters.chainLightningCount++;
        if (ev.points && ev.points.length > counters.maxChainPoints) {
          counters.maxChainPoints = ev.points.length;
        }
      } else if (ev.type === SIM_EVENTS.EARTHBIND_PULL) counters.earthboundCount++;
      else if (ev.type === SIM_EVENTS.KNOCKUP_LAND) counters.knockupLandCount++;
      else if (ev.type === SIM_EVENTS.WAVE_CLEARED) counters.wavesCleared++;
      else if (ev.type === SIM_EVENTS.CREEP_KILLED && ev.isBoss) counters.bossKills++;
    }
    tickEvents.length = 0;

    particles.update(SIM_DT);
    vfx.update(SIM_DT);
    terrain.update(SIM_DT);

    if (sim.creeps.length > counters.peakCreeps) counters.peakCreeps = sim.creeps.length;
    if (sim.projectiles.length > counters.peakProjectiles) counters.peakProjectiles = sim.projectiles.length;
    if (particles.activeCount > counters.peakActiveParticles) counters.peakActiveParticles = particles.activeCount;

    // Assert full simulation & pool invariants on every tick
    assertAllFiniteAndInvariants(sim, particles, vfx, terrain, counters);

    assert.notEqual(sim.phase, 'gameover', `Run hit gameover prematurely at wave ${sim.wave}`);

    // Wave progression logic:
    if (sim.wave < 100) {
      if (sim.phase === 'prep') {
        const res = sim.startNextWave();
        assert.equal(res.ok, true, `Failed starting wave ${sim.wave + 1}: ${res.reason}`);
        counters.wavesStarted = sim.wave;
      } else if (
        sim.wave >= 25 &&
        sim._spawnCursor >= sim._spawnQueue.length &&
        sim.creeps.length < 360
      ) {
        const res = sim.startNextWave();
        assert.equal(res.ok, true, `Failed overlapping wave ${sim.wave + 1}: ${res.reason}`);
        counters.wavesStarted = sim.wave;
      }
    } else if (
      sim.wave === 100 &&
      sim._spawnCursor >= sim._spawnQueue.length &&
      sim.creeps.length === 0
    ) {
      break;
    }
  }

  assert.equal(sim.wave, 100, `Expected to reach wave 100, reached ${sim.wave}`);
  assert.equal(sim._spawnCursor, sim._spawnQueue.length, 'Wave 100 did not finish spawning all creeps');
  assert.equal(sim.creeps.length, 0, 'Wave 100 creeps did not finish clearing/exiting');

  // Compute exact step timing stats
  let sumMs = 0;
  for (let i = 0; i < stepTimings.length; i++) {
    sumMs += stepTimings[i];
  }
  const sorted = Float64Array.from(stepTimings).sort();
  const avgStepMs = sumMs / stepTimings.length;
  const p95StepMs = sorted[Math.floor((sorted.length - 1) * 0.95)];

  // Core quantitative assertions
  assert.ok(counters.peakCreeps >= 180, `Expected peakCreeps >= 180, got ${counters.peakCreeps}`);
  assert.ok(counters.peakCreepsDuringStress >= 150, `Expected mid-wave stress at >= 150 creeps, got ${counters.peakCreepsDuringStress}`);
  assert.ok(counters.peakProjectiles >= 25, `Expected active projectiles to peak cleanly, got ${counters.peakProjectiles}`);
  assert.ok(counters.peakActiveParticles > 0 && counters.peakActiveParticles <= MAX_PARTICLES);
  assert.ok(counters.shatterCount > 0, 'Expected deterministic Shatter combos (3.0x AoE on Frozen + Siege)');
  assert.ok(counters.maxAcidStacks >= 2, `Expected Acid armor stripping stacks >= 2, got ${counters.maxAcidStacks}`);
  assert.ok(counters.chainLightningCount > 0 && counters.maxChainPoints >= 4, 'Expected Chain Lightning bounces');
  assert.ok(counters.earthboundCount > 0, 'Expected Windchill Flak Earthbind pulls on Sky-Wyverns');
  assert.ok(counters.knockupLandCount > 0, 'Expected Singularity/Earthshaker knock-up landings');
  assert.ok(counters.bossKills >= 2, `Expected early Act Boss kills, got ${counters.bossKills}`);
  assert.ok(counters.wavesCleared >= 20, `Expected >= 20 wave clears, got ${counters.wavesCleared}`);
  assert.ok(counters.illegalBlocksRejected >= 20, 'Expected extensive illegal block rejections');
  assert.ok(counters.midWavePlacements > 0 && counters.midWaveSells > 0, 'Expected mid-wave re-mazing');
  assert.ok(avgStepMs < 3.5, `Expected avgStepMs < 3.5ms, got ${avgStepMs.toFixed(4)}ms`);

  // Verify bounded particle & decal arrays remain completely finite
  for (let i = 0; i < particles._highWater; i++) {
    assert.ok(
      Number.isFinite(particles.px[i]) &&
        Number.isFinite(particles.py[i]) &&
        Number.isFinite(particles.pz[i]) &&
        Number.isFinite(particles.vx[i]) &&
        Number.isFinite(particles.vy[i]) &&
        Number.isFinite(particles.vz[i]),
      `Non-finite particle slot ${i}`,
    );
  }
  for (let i = 0; i < terrain.decalLife.length; i++) {
    assert.ok(Number.isFinite(terrain.decalLife[i]), `Non-finite decal slot ${i}`);
  }

  console.log('=== MAUL-FORGE 100-WAVE ADVERSARIAL STRESS SUITE ===');
  console.log(`totalWavesSimulated = ${counters.wavesStarted}`);
  console.log(`totalTicks = ${totalTicks}`);
  console.log(`avgStepMs = ${avgStepMs.toFixed(4)}ms`);
  console.log(`p95StepMs = ${p95StepMs.toFixed(4)}ms`);
  console.log(`peakCreeps = ${counters.peakCreeps} (peakDuringAdversarialStress = ${counters.peakCreepsDuringStress})`);
  console.log(`peakProjectiles = ${counters.peakProjectiles}`);
  console.log(`peakActiveParticles = ${counters.peakActiveParticles} / ${MAX_PARTICLES}`);
  console.log(
    `combos: shatter=${counters.shatterCount}, chainLightning=${counters.chainLightningCount} (maxHops=${counters.maxChainPoints - 1}), maxAcidStacks=${counters.maxAcidStacks}, earthbind=${counters.earthboundCount}, knockup=${counters.knockupLandCount}, bossKills=${counters.bossKills}, wavesCleared=${counters.wavesCleared}`,
  );
  console.log(
    `adversarial: passes=${counters.adversarialPasses}, illegalBlocksRejected=${counters.illegalBlocksRejected}, randomRejected=${counters.randomRejected}, midWavePlacements=${counters.midWavePlacements}, midWaveSells=${counters.midWaveSells}`,
  );
  console.log('ALL 100-WAVE ADVERSARIAL INVARIANTS PASSED!');
}

runStressSuite();
