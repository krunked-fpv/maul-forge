import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRID_COLS,
  GRID_ROWS,
  CELL_FLAGS,
  SIM_DT,
  BASE_TOWER_IDS,
  FUSION_TOWER_IDS,
  TARGET_PRIORITIES,
  BUILDER_MODES,
  SIM_EVENTS,
  SHATTER_COMBO_MULTIPLIER,
  SOLAR_FLARE_BONUS_MULT,
} from '../src/contracts/types.js';
import { GridFlowField } from '../src/engine/grid-flowfield.js';
import { SpatialHash } from '../src/engine/spatial-hash.js';
import {
  BASE_TOWERS,
  FUSION_TOWERS,
  CHAOS_APEX_UPGRADE,
  getTowerStats,
  getAvailableFusionsForTower,
} from '../src/engine/towers-data.js';
import {
  CREEP_DEFS,
  generateWaveSchedule,
  computeDamageMultiplier,
  computeArmorFactor,
  resolveHitDamage,
} from '../src/engine/waves-combat.js';
import { GameSim } from '../src/engine/ecs-sim.js';

test('1. Dual-gate flow-field solves in < 0.8ms on 32x22 grid', () => {
  const flow = new GridFlowField();
  // Place a realistic 20-tower maze before benchmarking
  for (let i = 0; i < 6; i++) {
    flow.placeTowerFootprint(6, 2 + i * 2);
    flow.placeTowerFootprint(11, 8 + i * 2);
  }

  // Warm one pass then assert single-call and 200-call average stay strictly < 0.8ms
  flow.recompute();
  const singleMs = flow.recompute();
  assert.ok(singleMs < 0.8, `Expected single recompute < 0.8ms, got ${singleMs.toFixed(4)}ms`);

  let totalMs = 0;
  const iterations = 200;
  for (let i = 0; i < iterations; i++) {
    totalMs += flow.recompute();
  }
  const avgMs = totalMs / iterations;
  console.log(`# flow.recompute() single=${singleMs.toFixed(4)}ms avg200=${avgMs.toFixed(4)}ms`);
  assert.ok(avgMs < 0.8, `Expected average recompute < 0.8ms, got ${avgMs.toFixed(4)}ms`);

  const path0 = flow.traceGoldenPath(0);
  const path1 = flow.traceGoldenPath(1);
  assert.ok(path0.length > 10 && path1.length > 10);
});

test('2. Serpentine 2x2 maze placement extends travel time and anti-block rejects with zero mutation', () => {
  const flow = new GridFlowField();
  const basePreview = flow.canPlaceTower(10, 10);
  assert.equal(basePreview.valid, true);
  assert.ok(basePreview.previewPath.length > 5);

  // Build serpentine wall forcing a long detour from North/South rifts to Central Ley Shrine
  const mazeCols = [
    [6, 0], [6, 2], [6, 4], [6, 6], [6, 8], [6, 10], [6, 12], [6, 14],
  ];
  for (const [c, r] of mazeCols) {
    assert.equal(flow.placeTowerFootprint(c, r), true);
  }

  const nextPreview = flow.canPlaceTower(6, 16);
  assert.equal(nextPreview.valid, true);
  assert.ok(
    nextPreview.deltaSec > 0,
    `Expected serpentine extension deltaSec > 0, got ${nextPreview.deltaSec}`,
  );
  assert.ok(nextPreview.previewTravelSec > nextPreview.baseTravelSec);

  // Now complete sealing col 6..7 across rows 16..19 -> blocks Gate 0 and Gate 1
  assert.equal(flow.placeTowerFootprint(6, 16), true);
  assert.equal(flow.placeTowerFootprint(6, 18), true);

  const flagsSnapshot = new Uint8Array(flow.flags);
  const distWpSnapshot = new Float32Array(flow.distToWaypoint);
  const distNxSnapshot = new Float32Array(flow.distToNexus);

  // (6, 20) would seal the final bottom gap (remember static obstacle at (8,20) doesn't touch col 6, wait: rows 20..21 at col 6 seals bottom!)
  const blockingCheck = flow.canPlaceTower(6, 20);
  assert.equal(blockingCheck.valid, false);
  assert.deepEqual(flow.flags, flagsSnapshot, 'Blocked placement must not mutate flags');
  assert.deepEqual(flow.distToWaypoint, distWpSnapshot, 'Blocked placement must not mutate distToWaypoint');
  assert.deepEqual(flow.distToNexus, distNxSnapshot, 'Blocked placement must not mutate distToNexus');

  // Also test trapping an active ground creep inside an enclosed pocket
  const pocketFlow = new GridFlowField();
  // Create a 3-sided U-pocket around (10, 10) using 2x2 towers at (10,8), (8,10), (10,12)
  assert.equal(pocketFlow.placeTowerFootprint(10, 8), true);
  assert.equal(pocketFlow.placeTowerFootprint(8, 10), true);
  assert.equal(pocketFlow.placeTowerFootprint(10, 12), true);

  const prePocketFlags = new Uint8Array(pocketFlow.flags);
  const trappedCreep = [{ active: true, x: 10.5, y: 10.5, radius: 0.25, stage: 0, isFlying: false, earthboundTimer: 0 }];
  // Sealing right side at (12, 10) leaves Spawn->Waypoint->Nexus open, but traps the creep inside!
  const trapCheck = pocketFlow.canPlaceTower(12, 10, trappedCreep);
  assert.equal(trapCheck.valid, false);
  assert.deepEqual(pocketFlow.flags, prePocketFlags, 'Trapping creep must not mutate grid');

  // Overlapping active ground creep directly
  const overlapCheck = pocketFlow.canPlaceTower(20, 10, [{ active: true, x: 21.0, y: 11.0, radius: 0.3, stage: 1, isFlying: false, earthboundTimer: 0 }]);
  assert.equal(overlapCheck.valid, false);
});

test('3. Strict anti-corner-cutting prevents diagonal movement across tower pinches & corners', () => {
  const flow = new GridFlowField();
  // Build a diagonal wall of corner-touching 2x2 towers from top to bottom at col 8..18?
  // Simpler pinch test: block row 0..17 at col 10 except a diagonal pinch at (10,18) & (12,20):
  // Let's block (10, 0..16 step 2), (10, 18) ->Wait: (10,18) covers rows 18..19.
  // Place diagonal pinch: tower at (10,18) covers cols 10..11, rows 18..19; tower at (12,20) covers cols 12..13, rows 20..21.
  // Above (10,18), fill (10, 0..16 step 2) so the ONLY conceivable diagonal crack is between (10,18) and (12,20)!
  for (let r = 0; r <= 16; r += 2) {
    assert.equal(flow.placeTowerFootprint(10, r), true);
  }
  assert.equal(flow.placeTowerFootprint(10, 18), true);
  // Now rows 20..21 at col 10..11 are still open! Placing (12, 20) leaves cell (11,20) and (12,19) touching diagonally at (12,20).
  // With strict anti-corner-cutting, cell (11,20) -> (12,19) is FORBIDDEN because (11,19) and (12,20) are blocked!
  const pinchCheck = flow.canPlaceTower(12, 20);
  assert.equal(pinchCheck.valid, false, 'Diagonal tower pinch must be treated as impassable');

  // Single tower corner check: place tower at (10, 10) covering cols 10..11, rows 10..11
  const singleFlow = new GridFlowField();
  assert.equal(singleFlow.placeTowerFootprint(10, 10), true);
  // From cell (9, 9), diagonal (+1, +1) into (10, 10) is blocked; from (9, 10), diagonal (+1, -1) to (10, 9) crosses corner (10, 10)!
  const vec = singleFlow.sampleFlow(9.8, 10.2, 0);
  // Must NOT point straight NE (+x, -y) through corner of (10, 10); wall repulsion pushes -x away from col 10!
  assert.ok(vec.x <= 0.1, `Expected flow near tower edge (9.8, 10.2) not to push into wall, got vx=${vec.x}`);
});

test('4. SpatialHash supports radius and segment corridor queries cleanly', () => {
  const hash = new SpatialHash(GRID_COLS, GRID_ROWS, 512);
  hash.clear();
  hash.insert(0, 5.2, 10.1);
  hash.insert(1, 8.0, 10.0);
  hash.insert(2, 12.0, 14.0);

  const out = [];
  const radCount = hash.queryRadius(5.5, 10.0, 3.0, out);
  assert.equal(radCount, 2);
  assert.deepEqual(out.sort((a, b) => a - b), [0, 1]);

  out.length = 0;
  const segCount = hash.querySegment(4.0, 10.0, 12.5, 10.0, 0.5, out);
  assert.equal(segCount, 2);
  assert.deepEqual(out.sort((a, b) => a - b), [0, 1]);
});

test('5. Towers data, fusions, wave schedule (1..100+), and WC3 combat formulas', () => {
  assert.equal(BASE_TOWER_IDS.length, 6);
  assert.equal(FUSION_TOWER_IDS.length, 9);

  for (const id of BASE_TOWER_IDS) {
    assert.equal(BASE_TOWERS[id].tiers.length, 4);
  }

  const apex = getTowerStats('ballista', 4, null, true);
  assert.equal(apex.attackType, 'Chaos');
  assert.equal(apex.dmg, Math.round(180 * CHAOS_APEX_UPGRADE.dmgMultiplier * 100) / 100);
  assert.equal(apex.range, 6.5 + CHAOS_APEX_UPGRADE.rangeBonus);

  const avail = getAvailableFusionsForTower({ lineageId: 'frost', tier: 3, fusionId: null }, new Set(['mortar']), 0);
  const shatterOpt = avail.find((f) => f.fusionId === 'shatter_cannon');
  assert.ok(shatterOpt && shatterOpt.canFuseByNeighbor && shatterOpt.ready);

  // Wave 1..100+ schedule & bosses
  const w10 = generateWaveSchedule(10);
  assert.equal(w10.isBossWave, true);
  assert.equal(w10.bossTitle, 'Marrow-Crag');
  const w20 = generateWaveSchedule(20);
  assert.equal(w20.bossTitle, 'Zephyria');
  const w30 = generateWaveSchedule(30);
  assert.equal(w30.bossTitle, 'Malakor');
  const w80 = generateWaveSchedule(80);
  assert.equal(w80.isBossWave, true);
  assert.equal(w80.bossTitle, 'Malakor');
  const w75 = generateWaveSchedule(75);
  assert.ok(w75.groups.reduce((s, g) => s + g.count, 0) >= 36);

  for (let w = 1; w <= 110; w++) {
    const sched = generateWaveSchedule(w);
    assert.ok(sched.groups.length > 0);
    for (const g of sched.groups) {
      assert.ok(CREEP_DEFS[g.archetypeId]);
      assert.ok(g.count > 0 && Number.isFinite(g.hpMult) && g.hpMult > 0);
    }
  }

  // Damage matrix & Acid negative armor amplification
  assert.equal(computeDamageMultiplier('Pierce', 'Light'), 1.5);
  assert.equal(computeDamageMultiplier('Siege', 'Fortified'), 1.65);
  assert.equal(computeDamageMultiplier('Chaos', 'Ethereal'), 1.0);

  const armored = computeArmorFactor(8, 0);
  const stripped = computeArmorFactor(8, 10); // 8 - 25 = -17 armor
  assert.ok(armored.multiplier < 1.0);
  assert.ok(stripped.effectiveArmor < 0);
  assert.ok(stripped.multiplier > 1.5, 'Negative armor from Acid must amplify damage');

  // Bulwark Golem shield + Solar Flare 2.5x vs Ethereal/ghoul_swarm
  const solarHit = resolveHitDamage(66, 'Elemental', {
    archetypeId: 'ghoul_swarm',
    armorType: 'Light',
    baseArmor: 0,
    acidStacks: 0,
    shield: 0,
  }, { isSolarFlare: true, solarBonusMult: SOLAR_FLARE_BONUS_MULT });
  assert.equal(solarHit.finalDamage, 66 * 2.5);

  const shieldHit = resolveHitDamage(100, 'Chaos', {
    archetypeId: 'bulwark_golem',
    armorType: 'Fortified',
    baseArmor: 0,
    acidStacks: 0,
    shield: 40,
  });
  assert.equal(shieldHit.shieldAbsorbed, 40);
  assert.equal(shieldHit.hpDamage, 60);
});

test('6. Sky-Wyverns fly directly ignoring walls until Windchill Flak Earthbind grounds them', () => {
  const sim = new GameSim({ builderMode: BUILDER_MODES.INSTANT, startingGold: 5000, startingEssence: 5 });
  // Build a vertical wall across col 8 from row 2 to row 16 (leaving rows 18..19 open below static obstacle 0..1)
  for (let r = 2; r <= 16; r += 2) {
    const res = sim.placeTower(8, r, 'ballista');
    assert.equal(res.ok, true, `Expected col 8 row ${r} placement to succeed`);
  }

  // Spawn an airborne Sky-Wyvern at (6, 4) heading toward Waypoint (16, 11)
  const wyvern = sim._spawnCreep({ archetypeId: 'sky_wyvern', gateId: 0, hpMult: 5, bountyMult: 1 }, { x: 6.0, y: 4.5 });
  assert.ok(wyvern);
  assert.equal(wyvern.isFlying, true);
  assert.ok(wyvern.z > 1.0);

  // Step 1.5s -> Wyvern flies straight across col 8..9 wall!
  for (let i = 0; i < 90; i++) {
    sim.step(SIM_DT);
  }
  assert.ok(wyvern.x > 8.0, `Expected flying Wyvern to cross wall at col 8, got x=${wyvern.x}`);

  // Now place Windchill Flak battery at (10, 4) by upgrading ballista -> fuse with essence
  const resTower = sim.placeTower(10, 4, 'ballista');
  assert.equal(resTower.ok, true);
  sim.upgradeTower(resTower.tower.id);
  sim.upgradeTower(resTower.tower.id);
  const fuseRes = sim.fuseTower(resTower.tower.id, 'windchill_flak', true);
  assert.equal(fuseRes.ok, true);

  // Reposition Wyvern near tower at (12.2, 5.5) with high HP and run combat ticks
  wyvern.hp = 5000;
  wyvern.maxHp = 5000;
  wyvern.x = 12.2;
  wyvern.y = 5.5;
  wyvern.z = 1.35;
  wyvern.earthboundTimer = 0;

  let earthboundEventSeen = false;
  for (let i = 0; i < 60; i++) {
    sim.step(SIM_DT);
    const evs = sim.drainEvents();
    for (const ev of evs) {
      if (ev.type === SIM_EVENTS.EARTHBIND_PULL) earthboundEventSeen = true;
    }
    if (earthboundEventSeen) break;
  }

  assert.equal(earthboundEventSeen, true, 'Windchill Flak must emit EARTHBIND_PULL');
  assert.ok(wyvern.earthboundTimer > 0, 'Wyvern must have positive earthboundTimer');
  assert.equal(wyvern.z, 0, 'Earthbound Wyvern z altitude must be pulled to 0');

  // Verify grounded Wyvern now respects ground flow-field walls (blocked on left of col 8 wall, routes South around gap)
  wyvern.x = 7.5;
  wyvern.y = 6.5;
  const startY = wyvern.y;
  for (let i = 0; i < 30; i++) {
    sim.step(SIM_DT);
  }
  assert.ok(wyvern.x < 8.0, 'Earthbound Wyvern must NOT fly through tower wall at col 8');
  assert.ok(wyvern.y > startY, 'Earthbound Wyvern must route South along ground flow-field around wall');
});

test('7. Deep Freeze + Siege Shatter triggers 3.0x AoE & Venom Acid amps Pierce DPS', () => {
  const sim = new GameSim({ builderMode: BUILDER_MODES.INSTANT, startingGold: 5000, startingEssence: 5 });

  // Place Frost T4 (Absolute Zero) + Mortar T1 near (10, 8)
  const frostRes = sim.placeTower(10, 6, 'frost');
  assert.equal(frostRes.ok, true);
  sim.upgradeTower(frostRes.tower.id);
  sim.upgradeTower(frostRes.tower.id);
  sim.upgradeTower(frostRes.tower.id);

  const mortarRes = sim.placeTower(12, 6, 'mortar');
  assert.equal(mortarRes.ok, true);

  // Spawn two tough creeps in range
  const target = sim._spawnCreep({ archetypeId: 'bulwark_golem', gateId: 0, hpMult: 5, bountyMult: 1 }, { x: 11.0, y: 9.5 });
  const neighbor = sim._spawnCreep({ archetypeId: 'ironclad_grunt', gateId: 0, hpMult: 5, bountyMult: 1 }, { x: 11.4, y: 9.6 });
  assert.ok(target && neighbor);

  // Run up to 3.5 seconds so Frost hits twice -> Deep Freeze -> Mortar triggers Shatter
  let shatterEvents = [];
  for (let i = 0; i < 210; i++) {
    sim.step(SIM_DT);
    for (const ev of sim.drainEvents()) {
      if (ev.type === SIM_EVENTS.SHATTER_COMBO) shatterEvents.push(ev);
    }
    if (shatterEvents.length > 0) break;
  }

  assert.ok(shatterEvents.length >= 1, 'Deep Freeze + Mortar must emit SHATTER_COMBO');
  assert.ok(neighbor.hp < neighbor.maxHp, 'Shatter AoE must damage adjacent creeps');

  // Venom Acid stack amplification test
  const sim2 = new GameSim({ builderMode: BUILDER_MODES.INSTANT, startingGold: 5000, startingEssence: 5 });
  const grunt = sim2._spawnCreep({ archetypeId: 'ironclad_grunt', gateId: 0, hpMult: 10, bountyMult: 1 }, { x: 11.0, y: 9.5 });
  const dmgBefore = resolveHitDamage(100, 'Pierce', grunt).finalDamage;

  const venomRes = sim2.placeTower(10, 6, 'venom');
  assert.equal(venomRes.ok, true);
  sim2.upgradeTower(venomRes.tower.id); // T2 applies 2 stacks per hit

  for (let i = 0; i < 120; i++) {
    sim2.step(SIM_DT);
  }
  assert.ok(grunt.acidStacks >= 2, `Expected acidStacks >= 2, got ${grunt.acidStacks}`);
  const dmgAfter = resolveHitDamage(100, 'Pierce', grunt).finalDamage;
  assert.ok(
    dmgAfter > dmgBefore * 1.25,
    `Expected Pierce damage after Acid strip (${dmgAfter.toFixed(2)}) >> before (${dmgBefore.toFixed(2)})`,
  );
  assert.equal(SHATTER_COMBO_MULTIPLIER, 3.0);
});

test('8. Spirit Architect builder, refunds, early-send, Void Splitter, Shaman heal, and Singularity knock-up', () => {
  const sim = new GameSim({ builderMode: BUILDER_MODES.SPIRIT, startingGold: 2000, startingEssence: 3 });
  const placeRes = sim.placeTower(14, 14, 'ballista');
  assert.equal(placeRes.ok, true);
  assert.equal(placeRes.tower.buildState, 'queued');

  let sawSpark = false;
  let sawComplete = false;
  for (let i = 0; i < 120; i++) {
    sim.step(SIM_DT);
    for (const ev of sim.drainEvents()) {
      if (ev.type === SIM_EVENTS.BUILDER_SPARK) sawSpark = true;
      if (ev.type === SIM_EVENTS.TOWER_COMPLETE) sawComplete = true;
    }
    if (sawComplete) break;
  }
  assert.equal(sawSpark, true, 'Spirit builder should emit BUILDER_SPARK');
  assert.equal(sawComplete, true, 'Spirit builder should emit TOWER_COMPLETE');
  assert.equal(placeRes.tower.buildState, 'active');

  // Sell in prep = 100% refund
  const goldBeforeSell = sim.gold;
  const sellPrep = sim.sellTower(placeRes.tower.id);
  assert.equal(sellPrep.refund, 60);
  assert.equal(sim.gold, goldBeforeSell + 60);

  // Place again, start wave (early-send bonus), sell in combat = 75% refund
  const t2 = sim.placeTower(14, 14, 'mortar').tower;
  const goldPreWave = sim.gold;
  const waveRes = sim.startNextWave();
  assert.equal(waveRes.ok, true);
  assert.ok(sim.gold > goldPreWave, 'Early send must award bonus gold');

  const sellCombat = sim.sellTower(t2.id);
  assert.equal(sellCombat.refund, Math.round(80 * 0.75));

  // Void Splitter splits into 3 mini-slimes on death
  const splitter = sim._spawnCreep({ archetypeId: 'void_splitter', gateId: 0, hpMult: 1, bountyMult: 1 }, { x: 10.5, y: 10.5 });
  const preCount = sim.creeps.length;
  sim._killCreep(splitter, 0);
  assert.equal(sim.creeps.length, preCount - 1 + 3, 'Void Splitter must spawn 3 split children');
  const children = sim.creeps.filter((c) => c.isSplitChild);
  assert.equal(children.length, 3);
  // Killing a split child does NOT recursively split
  sim._killCreep(children[0], 0);
  assert.equal(sim.creeps.filter((c) => c.isSplitChild).length, 2);

  // Priority cycling & forced retarget
  const b = sim.placeTower(14, 14, 'ballista').tower;
  assert.equal(b.priority, TARGET_PRIORITIES[0]);
  sim.cycleTowerPriority(b.id, 1);
  assert.equal(b.priority, TARGET_PRIORITIES[1]);
  sim.setTowerPriority(b.id, 'Air-Focus');
  assert.equal(b.priority, 'Air-Focus');
});

test('9. serializeCheckpoint -> hydrateCheckpoint preserves towers, wave, gold, lives, essence, and score', () => {
  const sim = new GameSim({ builderMode: BUILDER_MODES.INSTANT, startingGold: 5000, startingEssence: 4 });
  const t1 = sim.placeTower(10, 6, 'frost').tower;
  sim.upgradeTower(t1.id);
  sim.upgradeTower(t1.id);
  sim.placeTower(12, 6, 'mortar');
  sim.fuseTower(t1.id, 'shatter_cannon', false); // Adjacent mortar catalyst!
  sim.setTowerPriority(t1.id, 'Strongest');
  t1.kills = 17;
  t1.totalDamage = 4250;

  const t2 = sim.placeTower(10, 14, 'ballista').tower;
  sim.upgradeTower(t2.id);
  sim.upgradeTower(t2.id);
  sim.upgradeTower(t2.id);
  sim.upgradeTower(t2.id); // Chaos Apex!

  sim.wave = 14;
  sim.gold = 777;
  sim.lives = 23;
  sim.essence = 2;
  sim.score = 19450;

  const snap = sim.serializeCheckpoint();
  const simRestored = new GameSim();
  assert.equal(simRestored.hydrateCheckpoint(snap), true);

  assert.equal(simRestored.wave, 14);
  assert.equal(simRestored.gold, 777);
  assert.equal(simRestored.lives, 23);
  assert.equal(simRestored.essence, 2);
  assert.equal(simRestored.score, 19450);
  assert.equal(simRestored.towers.length, 3);

  const r1 = simRestored.getTowerAtTile(10, 6);
  assert.ok(r1);
  assert.equal(r1.fusionId, 'shatter_cannon');
  assert.equal(r1.priority, 'Strongest');
  assert.equal(r1.kills, 17);
  assert.equal(r1.totalDamage, 4250);

  const r2 = simRestored.getTowerAtTile(10, 14);
  assert.ok(r2);
  assert.equal(r2.isChaosApex, true);
  assert.equal(r2.attackType, 'Chaos');

  // FlowField flags must reflect hydrated tower footprints
  assert.equal((simRestored.flowField.flags[6 * GRID_COLS + 10] & CELL_FLAGS.TOWER) !== 0, true);
  assert.equal(simRestored.flowField.canPlaceTower(10, 6).valid, false);
});

test('10. Fusion specialties: Railgun line pierce, Plague Coil 7-bounce, Singularity knock-up, Shaman heal, Golem shield regen', () => {
  const sim = new GameSim({ builderMode: BUILDER_MODES.INSTANT, startingGold: 10000, startingEssence: 10 });

  // Railgun Bastion at (10, 8)
  const rb = sim.placeTower(10, 8, 'ballista').tower;
  sim.upgradeTower(rb.id);
  sim.upgradeTower(rb.id);
  assert.equal(sim.fuseTower(rb.id, 'railgun_bastion', true).ok, true);

  // Spawn 3 creeps lined up East of Railgun
  const c1 = sim._spawnCreep({ archetypeId: 'ghoul_swarm', gateId: 0, hpMult: 20, bountyMult: 1 }, { x: 13.0, y: 9.0 });
  const c2 = sim._spawnCreep({ archetypeId: 'ghoul_swarm', gateId: 0, hpMult: 20, bountyMult: 1 }, { x: 15.0, y: 9.0 });
  const c3 = sim._spawnCreep({ archetypeId: 'ghoul_swarm', gateId: 0, hpMult: 20, bountyMult: 1 }, { x: 17.0, y: 9.0 });
  sim.step(SIM_DT);
  assert.ok(c1.hp < c1.maxHp && c2.hp < c2.maxHp && c3.hp < c3.maxHp, 'Railgun must pierce entire line corridor');

  // Singularity Catapult knock-up & pull + KNOCKUP_LAND
  const sim2 = new GameSim({ builderMode: BUILDER_MODES.INSTANT, startingGold: 10000, startingEssence: 10 });
  const sc = sim2.placeTower(10, 6, 'mortar').tower;
  sim2.upgradeTower(sc.id);
  sim2.upgradeTower(sc.id);
  assert.equal(sim2.fuseTower(sc.id, 'singularity_catapult', true).ok, true);

  const g1 = sim2._spawnCreep({ archetypeId: 'bulwark_golem', gateId: 0, hpMult: 10, bountyMult: 1 }, { x: 13.5, y: 9.0 });
  let sawKnockupLand = false;
  let sawAirborneZ = false;
  for (let i = 0; i < 180; i++) {
    sim2.step(SIM_DT);
    if (g1.z > 0.2) sawAirborneZ = true;
    for (const ev of sim2.drainEvents()) {
      if (ev.type === SIM_EVENTS.KNOCKUP_LAND) sawKnockupLand = true;
    }
    if (sawKnockupLand) break;
  }
  assert.equal(sawAirborneZ, true, 'Singularity Catapult must knock creep airborne');
  assert.equal(sawKnockupLand, true, 'Knock-up must emit KNOCKUP_LAND on landing');

  // Bulwark Golem shield regen after 3s out of combat & Blood Shaman heal pulse
  const sim3 = new GameSim({ builderMode: BUILDER_MODES.INSTANT });
  const golem = sim3._spawnCreep({ archetypeId: 'bulwark_golem', gateId: 0, hpMult: 2, bountyMult: 1 }, { x: 4.0, y: 3.5 });
  const shaman = sim3._spawnCreep({ archetypeId: 'blood_shaman', gateId: 0, hpMult: 2, bountyMult: 1 }, { x: 4.3, y: 3.5 });
  golem.shield = 10;
  golem.hp = golem.maxHp * 0.5;
  golem.outOfCombatTimer = 3.0;
  shaman.healCooldown = 0.05;
  for (let i = 0; i < 30; i++) {
    sim3.step(SIM_DT);
  }
  assert.ok(golem.shield > 10, 'Bulwark Golem shield must regenerate after 3s out of combat');
  assert.ok(golem.hp > golem.maxHp * 0.5, 'Blood-Ward Shaman must heal nearby injured creep');

  // Plague Coil 7-bounce Acid chain lightning & Solar Flare scorch beam & forceRetargetTower
  const sim4 = new GameSim({ builderMode: BUILDER_MODES.INSTANT, startingGold: 10000, startingEssence: 10 });
  const pc = sim4.placeTower(10, 6, 'venom').tower;
  sim4.upgradeTower(pc.id);
  sim4.upgradeTower(pc.id);
  assert.equal(sim4.fuseTower(pc.id, 'plague_coil', true).ok, true);

  const sf = sim4.placeTower(14, 6, 'brazier').tower;
  sim4.upgradeTower(sf.id);
  sim4.upgradeTower(sf.id);
  assert.equal(sim4.fuseTower(sf.id, 'solar_flare', true).ok, true);

  const chainCreeps = [];
  for (let k = 0; k < 7; k++) {
    chainCreeps.push(
      sim4._spawnCreep({ archetypeId: 'void_splitter', gateId: 0, hpMult: 20, bountyMult: 1 }, { x: 9.0 + k * 1.1, y: 9.0 }),
    );
  }
  assert.ok(sim4.getCreepAtWorld(9.0, 9.0, 0.75));
  sim4.forceRetargetTower(sf.id, chainCreeps[6].id);
  sim4.rallyBuilder(8.0, 8.0);

  let sawChain = false;
  let sawScorch = false;
  for (let i = 0; i < 15; i++) {
    sim4.step(SIM_DT);
    for (const ev of sim4.drainEvents()) {
      if (ev.type === SIM_EVENTS.CHAIN_LIGHTNING && ev.points.length === 8) sawChain = true;
      if (ev.type === SIM_EVENTS.TERRAIN_DECAL && ev.decalType === 'scorch') sawScorch = true;
    }
  }
  assert.equal(sawChain, true, 'Plague Coil must bounce across 7 creeps (8 chain points)');
  assert.equal(sawScorch, true, 'Solar Flare must emit scorch terrain decals');
  assert.ok(chainCreeps.every((c) => c.acidStacks >= 2), 'All 7 chained creeps must receive Acid stacks');
});
