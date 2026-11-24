import {
  GRID_COLS,
  GRID_ROWS,
  TOWER_FOOTPRINT,
  SIM_DT,
  CELL_FLAGS,
  SPAWN_GATES,
  WAYPOINTS,
  NEXUS_CORE,
  BASE_TOWER_IDS,
  TARGET_PRIORITIES,
  BUILDER_MODES,
  MAX_CREEPS,
  MAX_PROJECTILES,
  SIM_EVENTS,
  INITIAL_RUN_CONFIG,
  ACID_MAX_STACKS,
} from '../contracts/types.js';
import { GridFlowField } from './grid-flowfield.js';
import { SpatialHash } from './spatial-hash.js';
import {
  BASE_TOWERS,
  FUSION_TOWERS,
  CHAOS_APEX_UPGRADE,
  getTowerStats,
} from './towers-data.js';
import {
  CREEP_DEFS,
  generateWaveSchedule,
  resolveHitDamage,
} from './waves-combat.js';

const BLOCKED_MASK = CELL_FLAGS.TOWER | CELL_FLAGS.OBSTACLE;
const BUILDER_SPEED = 18.0; // tiles/sec
const BUILD_DURATION = 0.35; // seconds
const MAX_EVENTS = 1024;

function createCreepSlot(slot) {
  return {
    active: false,
    id: 0,
    slot,
    archetypeId: 'ghoul_swarm',
    armorType: 'Light',
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    z: 0,
    vz: 0,
    vx: 0,
    vy: 0,
    yaw: 0,
    radius: 0.24,
    hp: 0,
    maxHp: 1,
    shield: 0,
    maxShield: 0,
    baseArmor: 0,
    speed: 1.8,
    stage: 0,
    gateId: 0,
    isFlying: false,
    isBoss: false,
    isSplitChild: false,
    bossTitle: '',
    bounty: 5,
    walkPhase: 0,
    chillPct: 0,
    chillTimer: 0,
    freezeAccum: 0,
    frozenTimer: 0,
    acidStacks: 0,
    acidTimer: 0,
    acidDps: 0,
    igniteDps: 0,
    igniteTimer: 0,
    shockTimer: 0,
    earthboundTimer: 0,
    knockupTimer: 0,
    healCooldown: 0,
    outOfCombatTimer: 0,
    pathDist: 0,
    stunResistMult: 1.0,
    _acidSourceTowerId: 0,
    _igniteSourceTowerId: 0,
  };
}

function createProjectileSlot(slot) {
  return {
    active: false,
    slot,
    id: 0,
    towerId: 0,
    lineageId: 'ballista',
    fusionId: null,
    attackType: 'Pierce',
    x: 0,
    y: 0,
    z: 0.5,
    startX: 0,
    startY: 0,
    tx: 0,
    ty: 0,
    targetId: -1,
    homing: true,
    speed: 16.5,
    arcHeight: 0,
    totalDist: 1,
    dmg: 28,
    splash: 0,
    bonusAirMult: 0,
    chillPct: 0,
    chillSec: 0,
    freezeAccum: 0,
    frozenSec: 0,
    instantFreeze: false,
    piercing: false,
    acidStacks: 0,
    acidSec: 0,
    dotDps: 0,
    igniteDps: 0,
    igniteSec: 0,
    slagSec: 0,
    triggersShatter: false,
    autoShatterOnChilled: false,
    pullRadius: 0,
    knockupSec: 0,
    earthbindSec: 0,
  };
}

export class GameSim {
  constructor(options = {}) {
    this.flowField = new GridFlowField();
    this.spatialHash = new SpatialHash(GRID_COLS, GRID_ROWS, MAX_CREEPS);

    this.creepPool = new Array(MAX_CREEPS);
    this._creepActivePos = new Int32Array(MAX_CREEPS);
    this._freeCreepSlots = new Int32Array(MAX_CREEPS);
    for (let i = 0; i < MAX_CREEPS; i++) {
      this.creepPool[i] = createCreepSlot(i);
      this._creepActivePos[i] = -1;
    }

    this.projectilePool = new Array(MAX_PROJECTILES);
    this._projActivePos = new Int32Array(MAX_PROJECTILES);
    this._freeProjSlots = new Int32Array(MAX_PROJECTILES);
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.projectilePool[i] = createProjectileSlot(i);
      this._projActivePos[i] = -1;
    }

    this.creeps = [];
    this.projectiles = [];
    this.towers = [];
    this._towerById = new Map();
    this._creepById = new Map();

    this._events = [];
    this._scratchQuery = [];
    this._splashSlots = new Int32Array(MAX_CREEPS);
    this._shatterSlots = new Int32Array(MAX_CREEPS);
    this._pierceSlots = new Int32Array(MAX_CREEPS);
    this._chainVisited = new Set();
    this._tmpFlowVec = { x: 0, y: 0, dist: 0 };

    this._spawnQueue = [];
    this._spawnCursor = 0;
    this._spawnTimer = 0;
    this._spawnIntervalSec = 0.5;

    this.highScore = 0;
    this.bestWave = 0;
    this._checkpointRev = 0;
    this.lastFlowSolveMs = 0;

    this.resetRun(options);
  }

  resetRun(options = {}) {
    this.flowField.reset();
    this.spatialHash.clear();
    this.lastFlowSolveMs = this.flowField.recompute();

    this.phase = 'prep';
    this.wave = 0;
    this.gold = options.startingGold ?? INITIAL_RUN_CONFIG.startingGold;
    this.lives = options.startingLives ?? INITIAL_RUN_CONFIG.startingLives;
    this.maxLives = options.startingLives ?? INITIAL_RUN_CONFIG.startingLives;
    this.essence = options.startingEssence ?? INITIAL_RUN_CONFIG.startingEssence;
    this.score = 0;
    this.gameSpeed = options.gameSpeed ?? 1;
    this.builderMode =
      options.builderMode === BUILDER_MODES.INSTANT
        ? BUILDER_MODES.INSTANT
        : BUILDER_MODES.SPIRIT;
    this.seed = options.seed ?? 0x4d41554c;
    this._rngState = (this.seed >>> 0) || 1;
    this.prepTimer = options.prepTimer ?? 12.0;
    this.autoStartWaves = Boolean(options.autoStartWaves);

    this.towers.length = 0;
    this._towerById.clear();
    this._creepById.clear();

    this.creeps.length = 0;
    this._freeCreepCount = MAX_CREEPS;
    for (let i = 0; i < MAX_CREEPS; i++) {
      this.creepPool[i].active = false;
      this._creepActivePos[i] = -1;
      this._freeCreepSlots[i] = MAX_CREEPS - 1 - i;
    }

    this.projectiles.length = 0;
    this._freeProjCount = MAX_PROJECTILES;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.projectilePool[i].active = false;
      this._projActivePos[i] = -1;
      this._freeProjSlots[i] = MAX_PROJECTILES - 1 - i;
    }

    this._events.length = 0;
    this._spawnQueue.length = 0;
    this._spawnCursor = 0;
    this._spawnTimer = 0;

    this._nextTowerId = 1;
    this._nextCreepId = 1;
    this._nextProjId = 1;
    this._dpsTimer = 0;

    this.builder = {
      x: WAYPOINTS[0].cx,
      y: WAYPOINTS[0].cy,
      vx: 0,
      vy: 0,
      targetTowerId: null,
      mode: this.builderMode,
      swingPhase: 0,
      activeTask: null,
      rallyX: null,
      rallyY: null,
      _sparkAccum: 0,
    };
  }

  _nextRand() {
    let x = this._rngState >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this._rngState = x >>> 0;
    return this._rngState / 4294967296;
  }

  _emit(ev) {
    if (this._events.length >= MAX_EVENTS) {
      this._events.shift();
    }
    this._events.push(ev);
  }

  drainEvents(outArray = []) {
    for (let i = 0; i < this._events.length; i++) {
      outArray.push(this._events[i]);
    }
    this._events.length = 0;
    return outArray;
  }

  getTowerById(id) {
    return this._towerById.get(id) || null;
  }

  getTowerAtTile(col, row) {
    for (let i = 0; i < this.towers.length; i++) {
      const t = this.towers[i];
      if (
        col >= t.col &&
        col < t.col + TOWER_FOOTPRINT &&
        row >= t.row &&
        row < t.row + TOWER_FOOTPRINT
      ) {
        return t;
      }
    }
    return null;
  }

  getCreepById(id) {
    return this._creepById.get(id) || null;
  }

  getCreepAtWorld(wx, wy, pickRadius = 0.75) {
    let best = null;
    let bestDistSq = pickRadius * pickRadius;
    for (let i = 0; i < this.creeps.length; i++) {
      const c = this.creeps[i];
      if (!c.active) continue;
      const dx = c.x - wx;
      const dy = c.y - wy;
      const dSq = dx * dx + dy * dy;
      if (dSq <= bestDistSq) {
        bestDistSq = dSq;
        best = c;
      }
    }
    return best;
  }

  getAdjacentLineages(tower) {
    const set = new Set();
    if (!tower) return set;
    for (let i = 0; i < this.towers.length; i++) {
      const other = this.towers[i];
      if (other.id === tower.id || other.buildState !== 'active' || other.fusionId) continue;
      const cheb = Math.max(Math.abs(other.cx - tower.cx), Math.abs(other.cy - tower.cy));
      if (cheb <= 3) {
        set.add(other.lineageId);
      }
    }
    return set;
  }

  previewTowerPlacement(col, row, lineageId = BASE_TOWER_IDS[0]) {
    const flowRes = this.flowField.canPlaceTower(col, row, this.creeps);
    const stats = getTowerStats(lineageId, 1);
    const canAfford = this.gold >= stats.cost;
    const valid = flowRes.valid && canAfford;
    let reason = flowRes.reason;
    if (flowRes.valid && !canAfford) {
      reason = 'Insufficient Gold';
    }
    return {
      col,
      row,
      lineageId,
      valid,
      flowValid: flowRes.valid,
      canAfford,
      reason,
      cost: stats.cost,
      range: stats.range,
      baseTravelSec: flowRes.baseTravelSec,
      previewTravelSec: flowRes.previewTravelSec,
      deltaSec: flowRes.deltaSec,
      previewPath: flowRes.previewPath,
    };
  }

  placeTower(col, row, lineageId) {
    if (this.phase === 'gameover') {
      return { ok: false, reason: 'Game Over', tower: null };
    }
    if (!BASE_TOWERS[lineageId]) {
      return { ok: false, reason: 'Unknown lineage', tower: null };
    }

    const stats = getTowerStats(lineageId, 1);
    if (this.gold < stats.cost) {
      this._emit({
        type: SIM_EVENTS.BUILD_INVALID,
        x: col + 1,
        y: row + 1,
        wx: col + 1,
        wy: row + 1,
        col,
        row,
        reason: 'Insufficient Gold',
      });
      return { ok: false, reason: 'Insufficient Gold', tower: null };
    }

    const flowRes = this.flowField.canPlaceTower(col, row, this.creeps);
    if (!flowRes.valid) {
      this._emit({
        type: SIM_EVENTS.BUILD_INVALID,
        x: col + 1,
        y: row + 1,
        wx: col + 1,
        wy: row + 1,
        col,
        row,
        reason: flowRes.reason,
      });
      return { ok: false, reason: flowRes.reason, tower: null };
    }

    const t0 = performance.now();
    this.flowField.placeTowerFootprint(col, row);
    this.lastFlowSolveMs = performance.now() - t0;

    this.gold -= stats.cost;
    const isInstant = this.builderMode === BUILDER_MODES.INSTANT;

    const tower = {
      id: this._nextTowerId++,
      col,
      row,
      cx: col + 1,
      cy: row + 1,
      lineageId,
      tier: 1,
      fusionId: null,
      isChaosApex: false,
      buildState: isInstant ? 'active' : 'queued',
      buildProgress: isInstant ? 1 : 0,
      priority: TARGET_PRIORITIES[0],
      cooldown: 0,
      chargeGlow: 0,
      recoil: 0,
      yaw: 0,
      targetCreepId: -1,
      forcedCreepId: -1,
      kills: 0,
      totalDamage: 0,
      dpsWindowDamage: 0,
      currentDps: 0,
      goldInvested: stats.cost,
      placedWave: this.wave,
      name: stats.name,
      attackType: stats.attackType,
      range: stats.range,
      dmg: stats.dmg,
      _burstPending: 0,
      _burstTimer: 0,
    };

    this.towers.push(tower);
    this._towerById.set(tower.id, tower);

    this._emit({
      type: SIM_EVENTS.TOWER_PLACED,
      towerId: tower.id,
      lineageId,
      col,
      row,
      x: tower.cx,
      y: tower.cy,
      wx: tower.cx,
      wy: tower.cy,
    });

    if (isInstant) {
      this._emit({
        type: SIM_EVENTS.TOWER_COMPLETE,
        towerId: tower.id,
        lineageId,
        x: tower.cx,
        y: tower.cy,
        wx: tower.cx,
        wy: tower.cy,
      });
    }

    return { ok: true, reason: 'ok', tower, flow: flowRes };
  }

  _syncTowerCachedStats(tower) {
    const stats = getTowerStats(tower.lineageId, tower.tier, tower.fusionId, tower.isChaosApex);
    tower.name = stats.name;
    tower.attackType = stats.attackType;
    tower.range = stats.range;
    tower.dmg = stats.dmg;
  }

  upgradeTower(towerId) {
    if (this.phase === 'gameover') return { ok: false, reason: 'Game Over' };
    const tower = this.getTowerById(towerId);
    if (!tower) return { ok: false, reason: 'Tower not found' };

    if (!tower.fusionId && tower.tier < 4) {
      const nextTier = tower.tier + 1;
      const nextStats = getTowerStats(tower.lineageId, nextTier);
      if (this.gold < nextStats.cost) {
        this._emit({
          type: SIM_EVENTS.BUILD_INVALID,
          x: tower.cx,
          y: tower.cy,
          wx: tower.cx,
          wy: tower.cy,
          reason: 'Insufficient Gold',
        });
        return { ok: false, reason: 'Insufficient Gold' };
      }

      this.gold -= nextStats.cost;
      tower.tier = nextTier;
      tower.goldInvested += nextStats.cost;
      this._syncTowerCachedStats(tower);

      this._emit({
        type: SIM_EVENTS.TOWER_UPGRADED,
        towerId: tower.id,
        tier: tower.tier,
        isChaosApex: tower.isChaosApex,
        x: tower.cx,
        y: tower.cy,
        wx: tower.cx,
        wy: tower.cy,
      });
      return { ok: true, tower };
    }

    if ((tower.tier >= 4 || tower.fusionId) && !tower.isChaosApex) {
      if (this.gold < CHAOS_APEX_UPGRADE.cost) {
        this._emit({
          type: SIM_EVENTS.BUILD_INVALID,
          x: tower.cx,
          y: tower.cy,
          wx: tower.cx,
          wy: tower.cy,
          reason: 'Insufficient Gold',
        });
        return { ok: false, reason: 'Insufficient Gold' };
      }

      this.gold -= CHAOS_APEX_UPGRADE.cost;
      tower.isChaosApex = true;
      tower.goldInvested += CHAOS_APEX_UPGRADE.cost;
      this._syncTowerCachedStats(tower);

      this._emit({
        type: SIM_EVENTS.TOWER_UPGRADED,
        towerId: tower.id,
        tier: tower.tier,
        isChaosApex: true,
        x: tower.cx,
        y: tower.cy,
        wx: tower.cx,
        wy: tower.cy,
      });
      return { ok: true, tower };
    }

    return { ok: false, reason: 'Max upgrade reached' };
  }

  fuseTower(towerId, fusionId, useEssence = false) {
    if (this.phase === 'gameover') return { ok: false, reason: 'Game Over' };
    const tower = this.getTowerById(towerId);
    if (!tower) return { ok: false, reason: 'Tower not found' };
    if (tower.fusionId) return { ok: false, reason: 'Already fused' };
    if (tower.tier < 3) return { ok: false, reason: 'Requires Tier 3 or higher' };

    const fusionDef = FUSION_TOWERS[fusionId];
    if (!fusionDef) return { ok: false, reason: 'Unknown fusion' };
    const [a, b] = fusionDef.recipe;
    if (a !== tower.lineageId && b !== tower.lineageId) {
      return { ok: false, reason: 'Incompatible tower lineage' };
    }

    const partnerLineage = a === tower.lineageId ? b : a;
    const adj = this.getAdjacentLineages(tower);
    const hasNeighbor = adj.has(partnerLineage);

    let spendEssence = false;
    if (!hasNeighbor) {
      if (!useEssence || this.essence < 1) {
        this._emit({
          type: SIM_EVENTS.BUILD_INVALID,
          x: tower.cx,
          y: tower.cy,
          wx: tower.cx,
          wy: tower.cy,
          reason: 'Requires adjacent catalyst or Fusion Essence',
        });
        return { ok: false, reason: 'Requires adjacent catalyst or Fusion Essence' };
      }
      spendEssence = true;
    }

    if (this.gold < fusionDef.cost) {
      this._emit({
        type: SIM_EVENTS.BUILD_INVALID,
        x: tower.cx,
        y: tower.cy,
        wx: tower.cx,
        wy: tower.cy,
        reason: 'Insufficient Gold',
      });
      return { ok: false, reason: 'Insufficient Gold' };
    }

    this.gold -= fusionDef.cost;
    if (spendEssence) this.essence -= 1;
    tower.fusionId = fusionId;
    tower.goldInvested += fusionDef.cost;
    this._syncTowerCachedStats(tower);

    this._emit({
      type: SIM_EVENTS.TOWER_FUSED,
      towerId: tower.id,
      fusionId,
      usedEssence: spendEssence,
      x: tower.cx,
      y: tower.cy,
      wx: tower.cx,
      wy: tower.cy,
    });

    return { ok: true, tower };
  }

  sellTower(towerId) {
    const idx = this.towers.findIndex((t) => t.id === towerId);
    if (idx === -1) return { ok: false, refund: 0 };

    const tower = this.towers[idx];
    const rate =
      this.phase === 'prep'
        ? INITIAL_RUN_CONFIG.graceRefundRate
        : INITIAL_RUN_CONFIG.combatRefundRate;
    const refund = Math.round(tower.goldInvested * rate);

    this.gold += refund;
    this.towers.splice(idx, 1);
    this._towerById.delete(tower.id);
    this.flowField.removeTowerFootprint(tower.col, tower.row);

    if (this.builder.targetTowerId === tower.id) {
      this.builder.targetTowerId = null;
      this.builder.activeTask = null;
    }

    this._emit({
      type: SIM_EVENTS.TOWER_SOLD,
      towerId: tower.id,
      refund,
      x: tower.cx,
      y: tower.cy,
      wx: tower.cx,
      wy: tower.cy,
    });

    return { ok: true, refund };
  }

  cycleTowerPriority(towerId, dir = 1) {
    const tower = this.getTowerById(towerId);
    if (!tower) return null;
    const len = TARGET_PRIORITIES.length;
    const idx = TARGET_PRIORITIES.indexOf(tower.priority);
    const nextIdx = (((idx >= 0 ? idx : 0) + dir) % len + len) % len;
    tower.priority = TARGET_PRIORITIES[nextIdx];
    return tower.priority;
  }

  setTowerPriority(towerId, priority) {
    const tower = this.getTowerById(towerId);
    if (!tower || !TARGET_PRIORITIES.includes(priority)) return false;
    tower.priority = priority;
    return true;
  }

  forceRetargetTower(towerId, creepId = -1) {
    const tower = this.getTowerById(towerId);
    if (!tower) return false;
    tower.forcedCreepId = creepId;
    tower.targetCreepId = creepId;
    return true;
  }

  rallyBuilder(wx, wy) {
    const rx = Math.max(0.5, Math.min(GRID_COLS - 0.5, wx));
    const ry = Math.max(0.5, Math.min(GRID_ROWS - 0.5, wy));
    this.builder.rallyX = rx;
    this.builder.rallyY = ry;
    this.builder.targetTowerId = null;
    this.builder.activeTask = { type: 'rally', towerId: null, x: rx, y: ry };
  }

  setBuilderMode(mode) {
    const nextMode =
      mode === BUILDER_MODES.INSTANT ? BUILDER_MODES.INSTANT : BUILDER_MODES.SPIRIT;
    this.builderMode = nextMode;
    this.builder.mode = nextMode;

    if (nextMode === BUILDER_MODES.INSTANT) {
      for (let i = 0; i < this.towers.length; i++) {
        const t = this.towers[i];
        if (t.buildState !== 'active') {
          t.buildState = 'active';
          t.buildProgress = 1;
          this._emit({
            type: SIM_EVENTS.TOWER_COMPLETE,
            towerId: t.id,
            lineageId: t.lineageId,
            x: t.cx,
            y: t.cy,
            wx: t.cx,
            wy: t.cy,
          });
        }
      }
      this.builder.targetTowerId = null;
      this.builder.activeTask = null;
    }
  }

  setGameSpeed(speed) {
    const clamped = Math.max(1, Math.min(3, Math.round(speed || 1)));
    this.gameSpeed = clamped;
    return this.gameSpeed;
  }

  startNextWave() {
    if (this.phase === 'gameover') {
      return { ok: false, reason: 'Game Over' };
    }
    if (this.phase === 'combat' && this._spawnCursor < this._spawnQueue.length) {
      return { ok: false, reason: 'Wave already spawning' };
    }

    const earlyBonus =
      this.phase === 'prep' && this.prepTimer > 0
        ? Math.round(this.prepTimer * INITIAL_RUN_CONFIG.earlySendBonusPerSec)
        : 0;

    if (earlyBonus > 0) {
      this.gold += earlyBonus;
      this.score += earlyBonus * 5;
    }

    this.wave += 1;
    this.phase = 'combat';
    this.prepTimer = 0;

    const schedule = generateWaveSchedule(this.wave);
    this._spawnIntervalSec = schedule.spawnIntervalSec;
    this._spawnQueue.length = 0;
    this._spawnCursor = 0;
    this._spawnTimer = 0;

    // Interleave gate groups deterministically so North & South portals stream concurrently
    const expandedGroups = schedule.groups.map((g) => ({
      ...g,
      remaining: g.count,
    }));
    let added = true;
    while (added) {
      added = false;
      for (let i = 0; i < expandedGroups.length; i++) {
        const g = expandedGroups[i];
        if (g.remaining > 0) {
          this._spawnQueue.push({
            archetypeId: g.archetypeId,
            gateId: g.gateId,
            hpMult: g.hpMult,
            bountyMult: g.bountyMult,
            armorType: g.armorType || null,
            bossTitle: schedule.bossTitle,
          });
          g.remaining--;
          added = true;
        }
      }
    }

    this._emit({
      type: SIM_EVENTS.WAVE_STARTED,
      wave: this.wave,
      isBossWave: schedule.isBossWave,
      bossTitle: schedule.bossTitle,
      earlyBonus,
      x: WAYPOINTS[0].cx,
      y: WAYPOINTS[0].cy,
      wx: WAYPOINTS[0].cx,
      wy: WAYPOINTS[0].cy,
    });

    return { ok: true, wave: this.wave, earlyBonus, schedule };
  }

  _spawnCreep(entry, overridePos = null, isSplitChild = false) {
    if (this._freeCreepCount <= 0) return null;
    const slot = this._freeCreepSlots[--this._freeCreepCount];
    const c = this.creepPool[slot];
    const def = CREEP_DEFS[entry.archetypeId] || CREEP_DEFS.ghoul_swarm;
    const gate = SPAWN_GATES[entry.gateId] || SPAWN_GATES[0];

    const jitterX = (this._nextRand() - 0.5) * 0.4;
    const jitterY = (this._nextRand() - 0.5) * 0.4;
    let startX = overridePos ? overridePos.x : gate.cx + jitterX;
    let startY = overridePos ? overridePos.y : gate.cy + jitterY;

    if (!def.isFlying) {
      const safe = this.flowField.findNearestWalkable(startX, startY);
      startX = safe.x;
      startY = safe.y;
    }

    const baseHp = def.baseHp * (entry.hpMult || 1);
    const maxHp = isSplitChild ? Math.max(12, Math.round(baseHp * 0.25)) : Math.round(baseHp);
    const maxShield = def.shieldPct ? Math.round(maxHp * def.shieldPct) : 0;

    c.active = true;
    c.id = this._nextCreepId++;
    c.archetypeId = def.id;
    c.armorType = entry.armorType || def.armorType;
    c.x = startX;
    c.y = startY;
    c.prevX = startX;
    c.prevY = startY;
    c.z = def.isFlying ? 1.35 : 0;
    c.vz = 0;
    c.vx = 0;
    c.vy = 0;
    c.yaw = 0;
    c.radius = isSplitChild ? 0.18 : def.radius;
    c.hp = maxHp;
    c.maxHp = maxHp;
    c.shield = maxShield;
    c.maxShield = maxShield;
    c.baseArmor = def.baseArmor;
    c.speed = isSplitChild ? def.speed * 1.25 : def.speed;
    c.stage = entry.stage ?? 0;
    c.gateId = entry.gateId ?? 0;
    c.isFlying = def.isFlying;
    c.isBoss = def.isBoss;
    c.isSplitChild = isSplitChild;
    c.bossTitle = def.isBoss ? entry.bossTitle || 'Act Boss' : '';
    c.bounty = isSplitChild
      ? Math.max(2, Math.round(def.bounty * (entry.bountyMult || 1) * 0.25))
      : Math.max(1, Math.round(def.bounty * (entry.bountyMult || 1)));
    c.walkPhase = this._nextRand() * Math.PI * 2;
    c.chillPct = 0;
    c.chillTimer = 0;
    c.freezeAccum = 0;
    c.frozenTimer = 0;
    c.acidStacks = 0;
    c.acidTimer = 0;
    c.acidDps = 0;
    c.igniteDps = 0;
    c.igniteTimer = 0;
    c.shockTimer = 0;
    c.earthboundTimer = 0;
    c.knockupTimer = 0;
    c.healCooldown = def.healIntervalSec ? 1.2 + this._nextRand() * 1.0 : 0;
    c.outOfCombatTimer = 0;
    c.pathDist = 30;
    c.stunResistMult = def.stunResistMult ?? 1.0;
    c._acidSourceTowerId = 0;
    c._igniteSourceTowerId = 0;

    this._creepActivePos[slot] = this.creeps.length;
    this.creeps.push(c);
    this._creepById.set(c.id, c);
    return c;
  }

  _despawnCreep(c) {
    if (!c.active) return;
    c.active = false;
    this._creepById.delete(c.id);

    const pos = this._creepActivePos[c.slot];
    const lastIdx = this.creeps.length - 1;
    if (pos >= 0 && pos <= lastIdx) {
      if (pos !== lastIdx) {
        const swapped = this.creeps[lastIdx];
        this.creeps[pos] = swapped;
        this._creepActivePos[swapped.slot] = pos;
      }
      this.creeps.pop();
    }
    this._creepActivePos[c.slot] = -1;
    this._freeCreepSlots[this._freeCreepCount++] = c.slot;
  }

  _killCreep(c, killerTowerId = 0) {
    if (!c.active) return;
    const x = c.x;
    const y = c.y;
    const z = c.z;
    const archetypeId = c.archetypeId;
    const bounty = c.bounty;
    const isBoss = c.isBoss;
    const isSplitChild = c.isSplitChild;
    const stage = c.stage;
    const gateId = c.gateId;
    const maxHp = c.maxHp;

    this.gold += bounty;
    this.score += bounty * 10 + (isBoss ? 500 : 0);
    if (isBoss) {
      this.essence += 1;
    }

    const killer = this.getTowerById(killerTowerId);
    if (killer) {
      killer.kills += 1;
    }

    this._emit({
      type: SIM_EVENTS.CREEP_KILLED,
      creepId: c.id,
      archetypeId,
      bounty,
      isBoss,
      isSplitChild,
      x,
      y,
      wx: x,
      wy: y,
      z,
    });

    this._despawnCreep(c);

    if (archetypeId === 'void_splitter' && !isSplitChild) {
      const count = CREEP_DEFS.void_splitter.splitCount || 3;
      const baseDef = CREEP_DEFS.void_splitter;
      const hpMult = maxHp / baseDef.baseHp;
      const bountyMult = bounty / baseDef.bounty;
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2;
        const ox = x + Math.cos(ang) * 0.32;
        const oy = y + Math.sin(ang) * 0.32;
        this._spawnCreep(
          {
            archetypeId: 'void_splitter',
            gateId,
            stage,
            hpMult,
            bountyMult,
          },
          { x: ox, y: oy },
          true,
        );
      }
    }
  }

  _spawnProjectile(opts) {
    if (this._freeProjCount <= 0) return null;
    const slot = this._freeProjSlots[--this._freeProjCount];
    const p = this.projectilePool[slot];

    p.active = true;
    p.id = this._nextProjId++;
    p.towerId = opts.towerId;
    p.lineageId = opts.lineageId;
    p.fusionId = opts.fusionId || null;
    p.attackType = opts.attackType;
    p.x = opts.x;
    p.y = opts.y;
    p.z = opts.z ?? 0.55;
    p.startX = opts.x;
    p.startY = opts.y;
    p.tx = opts.tx;
    p.ty = opts.ty;
    p.targetId = opts.targetId ?? -1;
    p.homing = opts.homing ?? true;
    p.speed = opts.speed || 15;
    p.arcHeight = opts.arcHeight || 0;
    p.totalDist = Math.max(0.1, Math.hypot(opts.tx - opts.x, opts.ty - opts.y));
    p.dmg = opts.dmg;
    p.splash = opts.splash || 0;
    p.bonusAirMult = opts.bonusAirMult || 0;
    p.chillPct = opts.chillPct || 0;
    p.chillSec = opts.chillSec || 0;
    p.freezeAccum = opts.freezeAccum || 0;
    p.frozenSec = opts.frozenSec || 0;
    p.instantFreeze = Boolean(opts.instantFreeze);
    p.piercing = Boolean(opts.piercing);
    p.acidStacks = opts.acidStacks || 0;
    p.acidSec = opts.acidSec || 0;
    p.dotDps = opts.dotDps || 0;
    p.igniteDps = opts.igniteDps || 0;
    p.igniteSec = opts.igniteSec || 0;
    p.slagSec = opts.slagSec || 0;
    p.triggersShatter = Boolean(opts.triggersShatter);
    p.autoShatterOnChilled = Boolean(opts.autoShatterOnChilled);
    p.pullRadius = opts.pullRadius || 0;
    p.knockupSec = opts.knockupSec || 0;
    p.earthbindSec = opts.earthbindSec || 0;

    this._projActivePos[slot] = this.projectiles.length;
    this.projectiles.push(p);
    return p;
  }

  _releaseProjectile(p) {
    if (!p.active) return;
    p.active = false;
    const pos = this._projActivePos[p.slot];
    const lastIdx = this.projectiles.length - 1;
    if (pos >= 0 && pos <= lastIdx) {
      if (pos !== lastIdx) {
        const swapped = this.projectiles[lastIdx];
        this.projectiles[pos] = swapped;
        this._projActivePos[swapped.slot] = pos;
      }
      this.projectiles.pop();
    }
    this._projActivePos[p.slot] = -1;
    this._freeProjSlots[this._freeProjCount++] = p.slot;
  }

  _updateBuilder(dt) {
    const b = this.builder;
    if (this.builderMode !== BUILDER_MODES.SPIRIT) return;

    let targetTower = b.targetTowerId ? this.getTowerById(b.targetTowerId) : null;
    if (!targetTower || targetTower.buildState === 'active') {
      targetTower = null;
      let bestDist = Infinity;
      for (let i = 0; i < this.towers.length; i++) {
        const t = this.towers[i];
        if (t.buildState === 'active') continue;
        const d = Math.hypot(t.cx - b.x, t.cy - b.y);
        if (d < bestDist) {
          bestDist = d;
          targetTower = t;
        }
      }
      b.targetTowerId = targetTower ? targetTower.id : null;
    }

    if (targetTower) {
      const dx = targetTower.cx - b.x;
      const dy = targetTower.cy - b.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 0.35) {
        const step = Math.min(dist, BUILDER_SPEED * dt);
        b.vx = (dx / dist) * BUILDER_SPEED;
        b.vy = (dy / dist) * BUILDER_SPEED;
        b.x += (dx / dist) * step;
        b.y += (dy / dist) * step;
        b.activeTask = { type: 'build', towerId: targetTower.id, x: targetTower.cx, y: targetTower.cy };
      } else {
        b.vx = 0;
        b.vy = 0;
        targetTower.buildState = 'building';
        targetTower.buildProgress = Math.min(1, targetTower.buildProgress + dt / BUILD_DURATION);
        b.swingPhase += dt * 14;
        b.activeTask = { type: 'build', towerId: targetTower.id, x: targetTower.cx, y: targetTower.cy };

        b._sparkAccum += dt;
        if (b._sparkAccum >= 0.08) {
          b._sparkAccum -= 0.08;
          this._emit({
            type: SIM_EVENTS.BUILDER_SPARK,
            towerId: targetTower.id,
            x: targetTower.cx,
            y: targetTower.cy,
            wx: targetTower.cx,
            wy: targetTower.cy,
          });
        }

        if (targetTower.buildProgress >= 1) {
          targetTower.buildState = 'active';
          targetTower.buildProgress = 1;
          this._emit({
            type: SIM_EVENTS.TOWER_COMPLETE,
            towerId: targetTower.id,
            lineageId: targetTower.lineageId,
            x: targetTower.cx,
            y: targetTower.cy,
            wx: targetTower.cx,
            wy: targetTower.cy,
          });
          b.targetTowerId = null;
          b.activeTask = null;
        }
      }
      return;
    }

    if (b.rallyX !== null && b.rallyY !== null) {
      const dx = b.rallyX - b.x;
      const dy = b.rallyY - b.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.25) {
        const step = Math.min(dist, BUILDER_SPEED * dt);
        b.vx = (dx / dist) * BUILDER_SPEED;
        b.vy = (dy / dist) * BUILDER_SPEED;
        b.x += (dx / dist) * step;
        b.y += (dy / dist) * step;
      } else {
        b.vx = 0;
        b.vy = 0;
        b.rallyX = null;
        b.rallyY = null;
        b.activeTask = null;
      }
    } else {
      b.vx = 0;
      b.vy = 0;
      b.activeTask = null;
    }
  }

  _clampGroundCreepOutOfWalls(c) {
    const r = c.radius;
    let x = Math.max(r, Math.min(GRID_COLS - r, c.x));
    let y = Math.max(r, Math.min(GRID_ROWS - r, c.y));

    const minC = Math.max(0, Math.floor(x - r - 0.1));
    const maxC = Math.min(GRID_COLS - 1, Math.floor(x + r + 0.1));
    const minR = Math.max(0, Math.floor(y - r - 0.1));
    const maxR = Math.min(GRID_ROWS - 1, Math.floor(y + r + 0.1));

    for (let row = minR; row <= maxR; row++) {
      const rowOffset = row * GRID_COLS;
      for (let col = minC; col <= maxC; col++) {
        if ((this.flowField.flags[rowOffset + col] & BLOCKED_MASK) === 0) continue;
        const cx = x < col ? col : x > col + 1 ? col + 1 : x;
        const cy = y < row ? row : y > row + 1 ? row + 1 : y;
        const dx = x - cx;
        const dy = y - cy;
        const distSq = dx * dx + dy * dy;
        if (distSq < r * r) {
          const dist = Math.sqrt(distSq);
          if (dist > 1e-5) {
            const push = r - dist;
            x += (dx / dist) * push;
            y += (dy / dist) * push;
          } else {
            const safe = this.flowField.findNearestWalkable(x, y);
            x = safe.x;
            y = safe.y;
          }
        }
      }
    }

    c.x = Math.max(0.2, Math.min(GRID_COLS - 0.2, x));
    c.y = Math.max(0.2, Math.min(GRID_ROWS - 0.2, y));
  }

  _applyDotDamage(c, rawDmg, sourceTowerId) {
    const abs = Math.min(c.shield, rawDmg);
    c.shield -= abs;
    const hpDmg = rawDmg - abs;
    c.hp -= hpDmg;
    c.outOfCombatTimer = 0;

    const tower = this.getTowerById(sourceTowerId);
    if (tower) {
      tower.totalDamage += rawDmg;
      tower.dpsWindowDamage += rawDmg;
    }
  }

  _updateCreeps(dt) {
    const wp = WAYPOINTS[0];
    const nx = NEXUS_CORE;

    for (let i = this.creeps.length - 1; i >= 0; i--) {
      const c = this.creeps[i];
      if (!c || !c.active) continue;

      c.prevX = c.x;
      c.prevY = c.y;
      c.outOfCombatTimer += dt;

      if (c.maxShield > 0 && c.shield < c.maxShield && c.outOfCombatTimer >= 3.0) {
        c.shield = Math.min(c.maxShield, c.shield + c.maxShield * 0.20 * dt);
      }

      if (c.acidTimer > 0) {
        if (c.acidDps > 0) {
          this._applyDotDamage(c, c.acidDps * dt, c._acidSourceTowerId);
        }
        c.acidTimer -= dt;
        if (c.acidTimer <= 0) {
          c.acidTimer = 0;
          c.acidStacks = 0;
          c.acidDps = 0;
        }
      }

      if (c.igniteTimer > 0 && c.active && c.hp > 0) {
        if (c.igniteDps > 0) {
          this._applyDotDamage(c, c.igniteDps * dt, c._igniteSourceTowerId);
        }
        c.igniteTimer -= dt;
        if (c.igniteTimer <= 0) {
          c.igniteTimer = 0;
          c.igniteDps = 0;
        }
      }

      if (c.hp <= 0) {
        const killerId = c._igniteSourceTowerId || c._acidSourceTowerId;
        this._killCreep(c, killerId);
        continue;
      }

      if (c.chillTimer > 0) {
        c.chillTimer -= dt;
        if (c.chillTimer <= 0) {
          c.chillTimer = 0;
          c.chillPct = 0;
        }
      }
      if (c.frozenTimer > 0) c.frozenTimer = Math.max(0, c.frozenTimer - dt);
      if (c.shockTimer > 0) c.shockTimer = Math.max(0, c.shockTimer - dt);

      if (c.earthboundTimer > 0) {
        c.earthboundTimer = Math.max(0, c.earthboundTimer - dt);
      }

      // Vertical Z / Knockup / Earthbound / Flying altitude
      if (c.knockupTimer > 0 || c.vz !== 0) {
        c.knockupTimer = Math.max(0, c.knockupTimer - dt);
        c.z += c.vz * dt;
        c.vz -= 18.0 * dt;
        if (c.z <= 0) {
          c.z = 0;
          c.vz = 0;
          c.knockupTimer = 0;
          this._emit({
            type: SIM_EVENTS.KNOCKUP_LAND,
            creepId: c.id,
            x: c.x,
            y: c.y,
            wx: c.x,
            wy: c.y,
          });
        }
      } else if (c.isFlying && c.earthboundTimer <= 0) {
        c.z += (1.35 - c.z) * Math.min(1, dt * 6.0);
      } else if (c.z > 0) {
        c.z = Math.max(0, c.z - 9.0 * dt);
      }

      const immobilized = c.frozenTimer > 0 || c.shockTimer > 0 || c.knockupTimer > 0;
      if (!immobilized) {
        const effSpeed = c.speed * (1 - Math.min(0.65, c.chillPct || 0));
        c.walkPhase += effSpeed * dt * 3.2;

        if (c.isFlying && c.earthboundTimer <= 0) {
          const target = c.stage === 0 ? wp : nx;
          const dx = target.cx - c.x;
          const dy = target.cy - c.y;
          const dist = Math.hypot(dx, dy);
          c.pathDist = dist + (c.stage === 0 ? 14 : 0);
          if (dist > 1e-5) {
            const ux = dx / dist;
            const uy = dy / dist;
            c.vx = ux * effSpeed;
            c.vy = uy * effSpeed;
            c.x += c.vx * dt;
            c.y += c.vy * dt;
            c.yaw = Math.atan2(c.vy, c.vx);
          }
        } else {
          const vec = this.flowField.sampleFlow(c.x, c.y, c.stage, this._tmpFlowVec);
          c.pathDist = (Number.isFinite(vec.dist) ? vec.dist : 30) + (c.stage === 0 ? 14 : 0);
          c.vx = vec.x * effSpeed;
          c.vy = vec.y * effSpeed;
          c.x += c.vx * dt;
          c.y += c.vy * dt;
          if (vec.x !== 0 || vec.y !== 0) {
            c.yaw = Math.atan2(vec.y, vec.x);
          }
          this._clampGroundCreepOutOfWalls(c);
        }

        if (c.stage === 0 && Math.hypot(wp.cx - c.x, wp.cy - c.y) <= 1.2) {
          c.stage = 1;
        } else if (c.stage === 1 && Math.hypot(nx.cx - c.x, nx.cy - c.y) <= 1.0) {
          const leakLives = c.isBoss ? 5 : 1;
          this.lives = Math.max(0, this.lives - leakLives);
          this._emit({
            type: SIM_EVENTS.NEXUS_LEAK,
            creepId: c.id,
            isBoss: c.isBoss,
            livesLost: leakLives,
            livesRemaining: this.lives,
            x: c.x,
            y: c.y,
            wx: c.x,
            wy: c.y,
          });
          this._despawnCreep(c);
          if (this.lives <= 0) {
            this.phase = 'gameover';
          }
        }
      } else {
        c.vx = 0;
        c.vy = 0;
      }
    }

    // Rebuild SpatialHash for all live creeps
    this.spatialHash.clear();
    for (let i = 0; i < this.creeps.length; i++) {
      const c = this.creeps[i];
      this.spatialHash.insert(c.slot, c.x, c.y);
    }

    // Blood-Ward Shaman periodic AoE mend pulse
    const healDef = CREEP_DEFS.blood_shaman;
    for (let i = 0; i < this.creeps.length; i++) {
      const c = this.creeps[i];
      if (c.archetypeId !== 'blood_shaman' || c.frozenTimer > 0 || c.shockTimer > 0) continue;
      c.healCooldown -= dt;
      if (c.healCooldown <= 0) {
        c.healCooldown = healDef.healIntervalSec;
        this._scratchQuery.length = 0;
        this.spatialHash.queryRadius(c.x, c.y, healDef.healRadius, this._scratchQuery);
        for (let j = 0; j < this._scratchQuery.length; j++) {
          const ally = this.creepPool[this._scratchQuery[j]];
          if (ally.active && ally.hp > 0 && ally.hp < ally.maxHp) {
            ally.hp = Math.min(ally.maxHp, ally.hp + ally.maxHp * healDef.healPct);
          }
        }
      }
    }
  }

  _acquireTowerTarget(tower, stats) {
    const minRangeSq = (stats.minRange || 0) * (stats.minRange || 0);
    const maxRangeSq = stats.range * stats.range;

    if (tower.forcedCreepId > 0) {
      const forced = this.getCreepById(tower.forcedCreepId);
      if (forced && forced.active) {
        const dSq = (forced.x - tower.cx) ** 2 + (forced.y - tower.cy) ** 2;
        if (dSq >= minRangeSq && dSq <= maxRangeSq) {
          return forced;
        }
      } else {
        tower.forcedCreepId = -1;
      }
    }

    this._scratchQuery.length = 0;
    this.spatialHash.queryRadius(tower.cx, tower.cy, stats.range, this._scratchQuery);
    if (this._scratchQuery.length === 0) return null;

    let best = null;
    let bestScore = Infinity;
    const priority = tower.priority;

    for (let i = 0; i < this._scratchQuery.length; i++) {
      const c = this.creepPool[this._scratchQuery[i]];
      if (!c.active || c.hp <= 0) continue;
      const dx = c.x - tower.cx;
      const dy = c.y - tower.cy;
      const dSq = dx * dx + dy * dy;
      if (dSq < minRangeSq || dSq > maxRangeSq) continue;

      let score;
      if (priority === 'First') {
        score = c.pathDist;
      } else if (priority === 'Last') {
        score = -c.pathDist;
      } else if (priority === 'Strongest') {
        score = -(c.hp + c.shield);
      } else if (priority === 'Weakest') {
        score = c.hp + c.shield;
      } else if (priority === 'Closest') {
        score = dSq;
      } else if (priority === 'Air-Focus') {
        const isAir = c.isFlying || c.earthboundTimer > 0 ? 0 : 10000;
        score = isAir + c.pathDist;
      } else {
        score = c.pathDist;
      }

      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }

    return best;
  }

  _applyHitToCreep(creep, hitOpts, tower, isShatterSplash = false) {
    if (!creep || !creep.active || creep.hp <= 0) return false;

    const res = resolveHitDamage(hitOpts.dmg, hitOpts.attackType, creep, {
      bonusAirMult: hitOpts.bonusAirMult,
      isSolarFlare: hitOpts.isSolarFlare,
      solarBonusMult: hitOpts.solarBonusMult,
      triggersShatter: hitOpts.triggersShatter,
      autoShatterOnChilled: hitOpts.autoShatterOnChilled,
      isShatterSplash,
    });

    creep.shield = Math.max(0, creep.shield - res.shieldAbsorbed);
    creep.hp -= res.hpDamage;
    creep.outOfCombatTimer = 0;

    if (tower) {
      tower.totalDamage += res.finalDamage;
      tower.dpsWindowDamage += res.finalDamage;
    }

    if (hitOpts.chillPct > 0) {
      creep.chillPct = Math.max(creep.chillPct, hitOpts.chillPct);
      creep.chillTimer = Math.max(creep.chillTimer, hitOpts.chillSec || 2.8);
    }

    if (hitOpts.instantFreeze) {
      const dur = (hitOpts.frozenSec || 2.2) * creep.stunResistMult;
      creep.frozenTimer = Math.max(creep.frozenTimer, dur);
      creep.freezeAccum = 0;
    } else if (hitOpts.freezeAccum > 0) {
      creep.freezeAccum += hitOpts.freezeAccum;
      if (creep.freezeAccum >= 1.0) {
        creep.freezeAccum = 0;
        const dur = (hitOpts.frozenSec || 1.8) * creep.stunResistMult;
        creep.frozenTimer = Math.max(creep.frozenTimer, dur);
      }
    }

    if (hitOpts.acidStacks > 0) {
      creep.acidStacks = Math.min(ACID_MAX_STACKS, creep.acidStacks + hitOpts.acidStacks);
      creep.acidTimer = Math.max(creep.acidTimer, hitOpts.acidSec || 5.0);
      creep.acidDps = Math.max(creep.acidDps, hitOpts.dotDps || 0);
      creep._acidSourceTowerId = tower ? tower.id : 0;
    }

    if (hitOpts.igniteDps > 0) {
      creep.igniteDps = Math.max(creep.igniteDps, hitOpts.igniteDps);
      creep.igniteTimer = Math.max(creep.igniteTimer, hitOpts.igniteSec || 3.5);
      creep._igniteSourceTowerId = tower ? tower.id : 0;
    }

    if (hitOpts.microStunSec > 0) {
      creep.shockTimer = Math.max(creep.shockTimer, hitOpts.microStunSec * creep.stunResistMult);
    }

    if (hitOpts.earthbindSec > 0 && creep.isFlying) {
      const wasAirborne = creep.earthboundTimer <= 0;
      creep.earthboundTimer = Math.max(creep.earthboundTimer, hitOpts.earthbindSec);
      creep.z = 0;
      creep.vz = 0;
      if (wasAirborne) {
        const safe = this.flowField.findNearestWalkable(creep.x, creep.y);
        creep.x = safe.x;
        creep.y = safe.y;
      }
      this._emit({
        type: SIM_EVENTS.EARTHBIND_PULL,
        creepId: creep.id,
        towerId: tower ? tower.id : 0,
        x: creep.x,
        y: creep.y,
        wx: creep.x,
        wy: creep.y,
      });
    }

    if (hitOpts.knockupSec > 0 && creep.knockupTimer <= 0) {
      const dur = hitOpts.knockupSec * creep.stunResistMult;
      creep.knockupTimer = dur;
      creep.vz = 5.4 * (dur / 0.7 + 0.3);
    }

    if (res.triggeredShatter) {
      creep.frozenTimer = 0;
      creep.freezeAccum = 0;
      const shatterRadius = Math.max(1.8, hitOpts.splash || 1.8);
      this._emit({
        type: SIM_EVENTS.SHATTER_COMBO,
        creepId: creep.id,
        towerId: tower ? tower.id : 0,
        x: creep.x,
        y: creep.y,
        wx: creep.x,
        wy: creep.y,
        radius: shatterRadius,
        damage: res.shatterAoeDmg,
      });

      // Propagate Shatter burst to neighboring creeps
      this._scratchQuery.length = 0;
      this.spatialHash.queryRadius(creep.x, creep.y, shatterRadius, this._scratchQuery);
      const shatterCount = Math.min(this._scratchQuery.length, MAX_CREEPS);
      for (let i = 0; i < shatterCount; i++) {
        this._shatterSlots[i] = this._scratchQuery[i];
      }
      for (let i = 0; i < shatterCount; i++) {
        const other = this.creepPool[this._shatterSlots[i]];
        if (!other.active || other.id === creep.id || other.hp <= 0) continue;
        const splashRes = resolveHitDamage(hitOpts.dmg * 2.0, hitOpts.attackType, other, {
          isShatterSplash: true,
        });
        other.shield = Math.max(0, other.shield - splashRes.shieldAbsorbed);
        other.hp -= splashRes.hpDamage;
        if (tower) {
          tower.totalDamage += splashRes.finalDamage;
          tower.dpsWindowDamage += splashRes.finalDamage;
        }
        if (other.hp <= 0) {
          this._killCreep(other, tower ? tower.id : 0);
        }
      }
    }

    if (creep.hp <= 0) {
      this._killCreep(creep, tower ? tower.id : 0);
    }

    return res.triggeredShatter;
  }

  _fireChainLightning(tower, stats, firstTarget) {
    this._chainVisited.clear();
    const points = [{ x: tower.cx, y: tower.cy }];
    let current = firstTarget;
    let dmg = stats.dmg;
    const bounces = stats.chainBounces || 3;

    for (let b = 0; b < bounces && current; b++) {
      this._chainVisited.add(current.id);
      points.push({ x: current.x, y: current.y });

      const curX = current.x;
      const curY = current.y;
      this._applyHitToCreep(
        current,
        {
          dmg,
          attackType: stats.attackType,
          microStunSec: stats.microStunSec || 0,
          acidStacks: stats.acidStacks || 0,
          acidSec: stats.acidSec || 0,
          dotDps: stats.dotDps || 0,
        },
        tower,
      );

      dmg *= stats.chainFalloff || 0.8;
      this._scratchQuery.length = 0;
      this.spatialHash.queryRadius(curX, curY, stats.chainRadius || 2.8, this._scratchQuery);

      let next = null;
      let bestDistSq = Infinity;
      for (let i = 0; i < this._scratchQuery.length; i++) {
        const cand = this.creepPool[this._scratchQuery[i]];
        if (!cand.active || cand.hp <= 0 || this._chainVisited.has(cand.id)) continue;
        const dSq = (cand.x - curX) ** 2 + (cand.y - curY) ** 2;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          next = cand;
        }
      }
      current = next;
    }

    this._emit({
      type: SIM_EVENTS.CHAIN_LIGHTNING,
      towerId: tower.id,
      fusionId: tower.fusionId,
      x: tower.cx,
      y: tower.cy,
      wx: tower.cx,
      wy: tower.cy,
      points,
    });
  }

  _fireTower(tower, stats, target) {
    tower.yaw = Math.atan2(target.y - tower.cy, target.x - tower.cx);
    tower.targetCreepId = target.id;
    tower.cooldown = stats.cd;
    tower.recoil = 1.0;
    tower.chargeGlow = 1.0;

    if (stats.chainBounces) {
      this._emit({
        type: SIM_EVENTS.TOWER_FIRE,
        towerId: tower.id,
        lineageId: tower.lineageId,
        fusionId: tower.fusionId,
        x: tower.cx,
        y: tower.cy,
        wx: tower.cx,
        wy: tower.cy,
        targetX: target.x,
        targetY: target.y,
        targetId: target.id,
      });
      this._fireChainLightning(tower, stats, target);
      return;
    }

    if (stats.linePierce) {
      const dx = target.x - tower.cx;
      const dy = target.y - tower.cy;
      const len = Math.hypot(dx, dy) || 1;
      const endX = tower.cx + (dx / len) * (stats.corridorLength || 8.5);
      const endY = tower.cy + (dy / len) * (stats.corridorLength || 8.5);

      this._emit({
        type: SIM_EVENTS.TOWER_FIRE,
        towerId: tower.id,
        lineageId: tower.lineageId,
        fusionId: tower.fusionId,
        x: tower.cx,
        y: tower.cy,
        wx: tower.cx,
        wy: tower.cy,
        targetX: endX,
        targetY: endY,
        targetId: target.id,
      });

      this._scratchQuery.length = 0;
      this.spatialHash.querySegment(
        tower.cx,
        tower.cy,
        endX,
        endY,
        (stats.corridorWidth || 0.65) * 0.5,
        this._scratchQuery,
      );
      for (let i = 0; i < this._scratchQuery.length; i++) {
        const c = this.creepPool[this._scratchQuery[i]];
        this._applyHitToCreep(c, { dmg: stats.dmg, attackType: stats.attackType }, tower);
      }
      return;
    }

    if (stats.continuousBeam) {
      this._emit({
        type: SIM_EVENTS.TOWER_FIRE,
        towerId: tower.id,
        lineageId: tower.lineageId,
        fusionId: tower.fusionId,
        x: tower.cx,
        y: tower.cy,
        wx: tower.cx,
        wy: tower.cy,
        targetX: target.x,
        targetY: target.y,
        targetId: target.id,
      });

      this._applyHitToCreep(
        target,
        {
          dmg: stats.dmg,
          attackType: stats.attackType,
          isSolarFlare: true,
          solarBonusMult: stats.solarBonusMult,
          igniteDps: stats.igniteDps,
          igniteSec: stats.igniteSec,
        },
        tower,
      );

      this._emit({
        type: SIM_EVENTS.TERRAIN_DECAL,
        decalType: 'scorch',
        x: target.x,
        y: target.y,
        wx: target.x,
        wy: target.y,
        radius: 0.65,
        lifeSec: 2.5,
      });
      return;
    }

    this._emit({
      type: SIM_EVENTS.TOWER_FIRE,
      towerId: tower.id,
      lineageId: tower.lineageId,
      fusionId: tower.fusionId,
      x: tower.cx,
      y: tower.cy,
      wx: tower.cx,
      wy: tower.cy,
      targetX: target.x,
      targetY: target.y,
      targetId: target.id,
    });

    const isMortar = tower.lineageId === 'mortar' || tower.fusionId === 'hellfire_mortar' || tower.fusionId === 'shatter_cannon' || tower.fusionId === 'singularity_catapult';
    const projDmg = stats.burst === 2 ? stats.dmg * 0.5 : stats.dmg;

    this._spawnProjectile({
      towerId: tower.id,
      lineageId: tower.lineageId,
      fusionId: tower.fusionId,
      attackType: stats.attackType,
      x: tower.cx,
      y: tower.cy,
      z: isMortar ? 0.8 : 0.55,
      tx: target.x,
      ty: target.y,
      targetId: target.id,
      homing: !isMortar,
      speed: stats.projSpeed || 15,
      arcHeight: isMortar ? 1.8 : 0,
      dmg: projDmg,
      splash: stats.splash || 0,
      bonusAirMult: stats.bonusAirMult || 0,
      chillPct: stats.chillPct || 0,
      chillSec: stats.chillSec || 0,
      freezeAccum: stats.freezeAccum || 0,
      frozenSec: stats.frozenSec || 0,
      instantFreeze: Boolean(stats.instantFreeze),
      piercing: Boolean(stats.piercing),
      acidStacks: stats.acidStacks || 0,
      acidSec: stats.acidSec || 0,
      dotDps: stats.dotDps || 0,
      igniteDps: stats.igniteDps || 0,
      igniteSec: stats.igniteSec || 0,
      slagSec: stats.slagSec || 0,
      triggersShatter: Boolean(stats.triggersShatter),
      autoShatterOnChilled: Boolean(stats.autoShatterOnChilled),
      pullRadius: stats.pullRadius || 0,
      knockupSec: stats.knockupSec || 0,
      earthbindSec: stats.earthbindSec || 0,
    });

    if (stats.burst === 2) {
      tower._burstPending = 1;
      tower._burstTimer = 0.08;
    }
  }

  _updateTowers(dt) {
    this._dpsTimer += dt;
    const resetDpsWindow = this._dpsTimer >= 1.0;
    if (resetDpsWindow) this._dpsTimer -= 1.0;

    for (let i = 0; i < this.towers.length; i++) {
      const t = this.towers[i];
      t.recoil = Math.max(0, t.recoil - dt * 5.0);
      t.chargeGlow = Math.max(0, t.chargeGlow - dt * 2.5);
      t.cooldown = Math.max(0, t.cooldown - dt);

      if (resetDpsWindow) {
        t.currentDps = t.dpsWindowDamage;
        t.dpsWindowDamage = 0;
      }

      if (t.buildState !== 'active') continue;
      const stats = getTowerStats(t.lineageId, t.tier, t.fusionId, t.isChaosApex);

      if (t._burstPending > 0) {
        t._burstTimer -= dt;
        if (t._burstTimer <= 0) {
          t._burstPending = 0;
          const burstTarget =
            this.getCreepById(t.targetCreepId) || this._acquireTowerTarget(t, stats);
          if (burstTarget && burstTarget.active) {
            this._spawnProjectile({
              towerId: t.id,
              lineageId: t.lineageId,
              fusionId: t.fusionId,
              attackType: stats.attackType,
              x: t.cx,
              y: t.cy,
              z: 0.55,
              tx: burstTarget.x,
              ty: burstTarget.y,
              targetId: burstTarget.id,
              homing: true,
              speed: stats.projSpeed || 18.5,
              dmg: stats.dmg * 0.5,
            });
          }
        }
      }

      if (t.cooldown > 0) continue;
      const target = this._acquireTowerTarget(t, stats);
      if (target) {
        this._fireTower(t, stats, target);
      } else {
        t.targetCreepId = -1;
      }
    }
  }

  _resolveProjectileImpact(p) {
    const tower = this.getTowerById(p.towerId);

    this._emit({
      type: SIM_EVENTS.PROJECTILE_HIT,
      towerId: p.towerId,
      lineageId: p.lineageId,
      fusionId: p.fusionId,
      x: p.tx,
      y: p.ty,
      wx: p.tx,
      wy: p.ty,
      splash: p.splash,
    });

    if (p.slagSec > 0) {
      this._emit({
        type: SIM_EVENTS.TERRAIN_DECAL,
        decalType: 'slag',
        x: p.tx,
        y: p.ty,
        wx: p.tx,
        wy: p.ty,
        radius: Math.max(1.0, p.splash * 0.75),
        lifeSec: p.slagSec,
      });
    } else if (p.igniteDps > 0) {
      this._emit({
        type: SIM_EVENTS.TERRAIN_DECAL,
        decalType: 'scorch',
        x: p.tx,
        y: p.ty,
        wx: p.tx,
        wy: p.ty,
        radius: Math.max(0.6, p.splash * 0.6),
        lifeSec: 3.0,
      });
    } else if (p.acidStacks > 0 && p.splash > 0) {
      this._emit({
        type: SIM_EVENTS.TERRAIN_DECAL,
        decalType: 'acid',
        x: p.tx,
        y: p.ty,
        wx: p.tx,
        wy: p.ty,
        radius: Math.max(0.6, p.splash * 0.6),
        lifeSec: 3.0,
      });
    } else if (p.chillPct > 0 && p.splash > 0) {
      this._emit({
        type: SIM_EVENTS.TERRAIN_DECAL,
        decalType: 'frost',
        x: p.tx,
        y: p.ty,
        wx: p.tx,
        wy: p.ty,
        radius: Math.max(0.6, p.splash * 0.6),
        lifeSec: 2.5,
      });
    }

    if (p.splash > 0) {
      this._scratchQuery.length = 0;
      this.spatialHash.queryRadius(p.tx, p.ty, p.splash, this._scratchQuery);
      // Copy indices to pre-allocated Int32Array since _applyHitToCreep (Shatter) reuses _scratchQuery
      const hitCount = Math.min(this._scratchQuery.length, MAX_CREEPS);
      for (let i = 0; i < hitCount; i++) {
        this._splashSlots[i] = this._scratchQuery[i];
      }
      for (let i = 0; i < hitCount; i++) {
        const c = this.creepPool[this._splashSlots[i]];
        if (!c.active || c.hp <= 0) continue;

        if (p.pullRadius > 0) {
          const pdx = p.tx - c.x;
          const pdy = p.ty - c.y;
          const pDist = Math.hypot(pdx, pdy);
          if (pDist > 0.15) {
            const pull = Math.min(pDist * 0.55, 0.9);
            c.x += (pdx / pDist) * pull;
            c.y += (pdy / pDist) * pull;
            if (!c.isFlying || c.earthboundTimer > 0) {
              this._clampGroundCreepOutOfWalls(c);
            }
          }
        }

        this._applyHitToCreep(c, p, tower, false);
      }
      return;
    }

    let primary = this.getCreepById(p.targetId);
    if (!primary || !primary.active) {
      primary = this.getCreepAtWorld(p.tx, p.ty, 0.55);
    }
    if (primary) {
      this._applyHitToCreep(primary, p, tower, false);
    }

    if (p.piercing) {
      const dirX = p.tx - p.startX;
      const dirY = p.ty - p.startY;
      const len = Math.hypot(dirX, dirY) || 1;
      const endX = p.tx + (dirX / len) * 1.8;
      const endY = p.ty + (dirY / len) * 1.8;
      this._scratchQuery.length = 0;
      this.spatialHash.querySegment(p.tx, p.ty, endX, endY, 0.5, this._scratchQuery);
      const pierceCount = Math.min(this._scratchQuery.length, MAX_CREEPS);
      for (let i = 0; i < pierceCount; i++) {
        this._pierceSlots[i] = this._scratchQuery[i];
      }
      let extra = 0;
      for (let i = 0; i < pierceCount && extra < 2; i++) {
        const c = this.creepPool[this._pierceSlots[i]];
        if (!c.active || (primary && c.id === primary.id)) continue;
        this._applyHitToCreep(c, p, tower, false);
        extra++;
      }
    }
  }

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (!p || !p.active) continue;

      if (p.homing && p.targetId > 0) {
        const target = this.getCreepById(p.targetId);
        if (target && target.active) {
          p.tx = target.x;
          p.ty = target.y;
        }
      }

      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const dist = Math.hypot(dx, dy);
      const stepDist = p.speed * dt;

      if (dist <= stepDist || dist < 0.2) {
        p.x = p.tx;
        p.y = p.ty;
        p.z = 0;
        this._resolveProjectileImpact(p);
        this._releaseProjectile(p);
      } else {
        p.x += (dx / dist) * stepDist;
        p.y += (dy / dist) * stepDist;
        if (p.arcHeight > 0) {
          const progress = Math.max(0, Math.min(1, 1 - dist / p.totalDist));
          p.z = 0.5 + Math.sin(progress * Math.PI) * p.arcHeight;
        }
      }
    }
  }

  step(dt = SIM_DT) {
    if (this.phase === 'gameover') return;

    if (this.phase === 'prep') {
      if (this.prepTimer > 0) {
        this.prepTimer = Math.max(0, this.prepTimer - dt);
        if (this.prepTimer === 0 && this.autoStartWaves) {
          this.startNextWave();
        }
      }
    } else if (this.phase === 'combat') {
      this._spawnTimer -= dt;
      while (this._spawnTimer <= 0 && this._spawnCursor < this._spawnQueue.length) {
        this._spawnCreep(this._spawnQueue[this._spawnCursor++]);
        this._spawnTimer += this._spawnIntervalSec;
      }
    }

    this._updateBuilder(dt);
    this._updateCreeps(dt);
    this._updateTowers(dt);
    this._updateProjectiles(dt);

    if (
      this.phase === 'combat' &&
      this._spawnCursor >= this._spawnQueue.length &&
      this.creeps.length === 0
    ) {
      this.bestWave = Math.max(this.bestWave, this.wave);
      this.highScore = Math.max(this.highScore, this.score);
      const bonusGold = 15 + this.wave * 3;
      this.gold += bonusGold;
      this.score += 100 + this.wave * 25;
      this.phase = 'prep';
      this.prepTimer = 15.0;
      this._emit({
        type: SIM_EVENTS.WAVE_CLEARED,
        wave: this.wave,
        bonusGold,
        x: NEXUS_CORE.cx,
        y: NEXUS_CORE.cy,
        wx: NEXUS_CORE.cx,
        wy: NEXUS_CORE.cy,
      });
    }
  }

  serializeCheckpoint() {
    this._checkpointRev += 1;
    return {
      version: 1,
      updatedAt: Date.now(),
      rev: this._checkpointRev,
      highScore: Math.max(this.highScore, this.score),
      bestWave: Math.max(this.bestWave, this.wave),
      settings: {
        muted: false,
        masterVolume: 0.7,
        builderMode: this.builderMode,
      },
      run: {
        wave: this.wave,
        gold: this.gold,
        lives: this.lives,
        essence: this.essence,
        score: this.score,
        seed: this.seed,
        towers: this.towers.map((t) => ({
          col: t.col,
          row: t.row,
          lineageId: t.lineageId,
          tier: t.tier,
          fusionId: t.fusionId,
          isChaosApex: t.isChaosApex,
          priority: t.priority,
          kills: t.kills,
          totalDamage: t.totalDamage,
          goldInvested: t.goldInvested,
        })),
      },
    };
  }

  hydrateCheckpoint(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const run = snapshot.run && typeof snapshot.run === 'object' ? snapshot.run : snapshot;
    const settings = snapshot.settings || {};

    this.resetRun({
      startingGold: run.gold ?? INITIAL_RUN_CONFIG.startingGold,
      startingLives: run.lives ?? INITIAL_RUN_CONFIG.startingLives,
      startingEssence: run.essence ?? INITIAL_RUN_CONFIG.startingEssence,
      seed: run.seed ?? this.seed,
      builderMode: settings.builderMode ?? this.builderMode,
    });

    this.wave = Number.isFinite(run.wave) ? Math.max(0, Math.floor(run.wave)) : 0;
    this.score = Number.isFinite(run.score) ? run.score : 0;
    this.highScore = Number.isFinite(snapshot.highScore)
      ? Math.max(snapshot.highScore, this.score)
      : this.score;
    this.bestWave = Number.isFinite(snapshot.bestWave)
      ? Math.max(snapshot.bestWave, this.wave)
      : this.wave;
    this._checkpointRev = Number.isFinite(snapshot.rev) ? snapshot.rev : this._checkpointRev;
    this.phase = this.lives > 0 ? 'prep' : 'gameover';

    const savedTowers = Array.isArray(run.towers) ? run.towers : [];
    for (let i = 0; i < savedTowers.length; i++) {
      const st = savedTowers[i];
      if (!st || !BASE_TOWERS[st.lineageId]) continue;
      const col = Math.floor(st.col);
      const row = Math.floor(st.row);
      if (col < 0 || row < 0 || col > GRID_COLS - TOWER_FOOTPRINT || row > GRID_ROWS - TOWER_FOOTPRINT) {
        continue;
      }

      let overlap = false;
      for (let dr = 0; dr < TOWER_FOOTPRINT && !overlap; dr++) {
        for (let dc = 0; dc < TOWER_FOOTPRINT; dc++) {
          if (this.flowField.flags[(row + dr) * GRID_COLS + (col + dc)] !== CELL_FLAGS.EMPTY) {
            overlap = true;
            break;
          }
        }
      }
      if (overlap) continue;

      for (let dr = 0; dr < TOWER_FOOTPRINT; dr++) {
        for (let dc = 0; dc < TOWER_FOOTPRINT; dc++) {
          this.flowField.flags[(row + dr) * GRID_COLS + (col + dc)] |= CELL_FLAGS.TOWER;
        }
      }

      const tier = Math.max(1, Math.min(4, Math.floor(st.tier || 1)));
      const fusionId = st.fusionId && FUSION_TOWERS[st.fusionId] ? st.fusionId : null;
      const isChaosApex = Boolean(st.isChaosApex);
      const stats = getTowerStats(st.lineageId, tier, fusionId, isChaosApex);

      let defaultInvested = 0;
      for (let k = 1; k <= tier; k++) {
        defaultInvested += getTowerStats(st.lineageId, k).cost;
      }
      if (fusionId) defaultInvested += FUSION_TOWERS[fusionId].cost;
      if (isChaosApex) defaultInvested += CHAOS_APEX_UPGRADE.cost;

      const tower = {
        id: this._nextTowerId++,
        col,
        row,
        cx: col + 1,
        cy: row + 1,
        lineageId: st.lineageId,
        tier,
        fusionId,
        isChaosApex,
        buildState: 'active',
        buildProgress: 1,
        priority: TARGET_PRIORITIES.includes(st.priority) ? st.priority : TARGET_PRIORITIES[0],
        cooldown: 0,
        chargeGlow: 0,
        recoil: 0,
        yaw: 0,
        targetCreepId: -1,
        forcedCreepId: -1,
        kills: st.kills || 0,
        totalDamage: st.totalDamage || 0,
        dpsWindowDamage: 0,
        currentDps: 0,
        goldInvested: st.goldInvested ?? defaultInvested,
        placedWave: this.wave,
        name: stats.name,
        attackType: stats.attackType,
        range: stats.range,
        dmg: stats.dmg,
        _burstPending: 0,
        _burstTimer: 0,
      };

      this.towers.push(tower);
      this._towerById.set(tower.id, tower);
    }

    this.lastFlowSolveMs = this.flowField.recompute();
    return true;
  }
}
