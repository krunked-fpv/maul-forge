import {
  BASE_TOWER_IDS,
  FUSION_TOWER_IDS,
  FUSION_RECIPES,
  SOLAR_FLARE_BONUS_MULT,
} from '../contracts/types.js';

export const CHAOS_APEX_UPGRADE = Object.freeze({
  cost: 420,
  dmgMultiplier: 1.45,
  rangeBonus: 0.6,
});

function buildTiers(lineageId, attackType, hotkey, rawTiers) {
  let cumulative = 0;
  const tiers = rawTiers.map((t, idx) => {
    cumulative += t.cost;
    return Object.freeze({
      lineageId,
      attackType,
      hotkey,
      tier: idx + 1,
      totalCost: cumulative,
      splash: 0,
      ...t,
    });
  });
  return Object.freeze({
    id: lineageId,
    attackType,
    hotkey,
    tiers: Object.freeze(tiers),
  });
}

export const BASE_TOWERS = Object.freeze({
  ballista: buildTiers('ballista', 'Pierce', 'Q', [
    {
      name: 'Watchtower Ballista',
      cost: 60,
      range: 4.8,
      cd: 0.85,
      dmg: 28,
      projSpeed: 16.5,
      splash: 0,
    },
    {
      name: 'Twin-Torsion Repeater',
      cost: 85,
      range: 5.2,
      cd: 0.62,
      dmg: 48,
      projSpeed: 18.5,
      burst: 2,
    },
    {
      name: 'Gryphon Bolter',
      cost: 150,
      range: 5.8,
      cd: 0.48,
      dmg: 92,
      projSpeed: 21.0,
    },
    {
      name: 'Sky-Reaver Bastion',
      cost: 260,
      range: 6.5,
      cd: 0.34,
      dmg: 180,
      projSpeed: 24.0,
      bonusAirMult: 1.25,
    },
  ]),

  mortar: buildTiers('mortar', 'Siege', 'W', [
    {
      name: 'Dwarven Steam Mortar',
      cost: 80,
      range: 6.2,
      cd: 2.10,
      dmg: 56,
      projSpeed: 8.5,
      splash: 1.65,
      minRange: 1.2,
      triggersShatter: true,
    },
    {
      name: 'Blackpowder Howitzer',
      cost: 115,
      range: 6.8,
      cd: 1.85,
      dmg: 98,
      projSpeed: 9.2,
      splash: 1.90,
      minRange: 1.2,
      triggersShatter: true,
    },
    {
      name: 'Piston Bombard',
      cost: 195,
      range: 7.4,
      cd: 1.60,
      dmg: 185,
      projSpeed: 10.0,
      splash: 2.15,
      minRange: 1.2,
      triggersShatter: true,
    },
    {
      name: 'Earthshaker Juggernaut',
      cost: 330,
      range: 8.2,
      cd: 1.40,
      dmg: 350,
      projSpeed: 11.0,
      splash: 2.45,
      minRange: 1.2,
      knockupSec: 0.45,
      triggersShatter: true,
    },
  ]),

  frost: buildTiers('frost', 'Elemental', 'E', [
    {
      name: 'Frostweaver Spire',
      cost: 70,
      range: 4.2,
      cd: 1.05,
      dmg: 20,
      projSpeed: 13.5,
      chillPct: 0.28,
      chillSec: 2.8,
    },
    {
      name: 'Rime Obelisk',
      cost: 100,
      range: 4.6,
      cd: 0.90,
      dmg: 38,
      projSpeed: 14.5,
      chillPct: 0.36,
      chillSec: 3.2,
      splash: 1.0,
    },
    {
      name: 'Glacier Conduit',
      cost: 170,
      range: 5.1,
      cd: 0.78,
      dmg: 74,
      projSpeed: 15.5,
      chillPct: 0.44,
      chillSec: 3.6,
      splash: 1.25,
      freezeAccum: 0.45,
      frozenSec: 1.8,
    },
    {
      name: 'Absolute Zero Cryo-Pylon',
      cost: 290,
      range: 5.6,
      cd: 0.68,
      dmg: 135,
      projSpeed: 17.0,
      chillPct: 0.52,
      chillSec: 4.0,
      splash: 1.5,
      freezeAccum: 0.65,
      frozenSec: 1.8,
    },
  ]),

  tesla: buildTiers('tesla', 'Magic', 'R', [
    {
      name: 'Arcane Tesla Conduit',
      cost: 75,
      range: 4.4,
      cd: 1.15,
      dmg: 26,
      chainBounces: 3,
      chainFalloff: 0.78,
      chainRadius: 2.6,
    },
    {
      name: 'Storm Pylon',
      cost: 110,
      range: 4.8,
      cd: 1.00,
      dmg: 48,
      chainBounces: 4,
      chainFalloff: 0.80,
      chainRadius: 2.9,
    },
    {
      name: 'Lindenmayer Spire',
      cost: 185,
      range: 5.3,
      cd: 0.85,
      dmg: 92,
      chainBounces: 5,
      chainFalloff: 0.82,
      chainRadius: 3.2,
      microStunSec: 0.15,
    },
    {
      name: 'Tempest Archon Coil',
      cost: 310,
      range: 5.9,
      cd: 0.72,
      dmg: 175,
      chainBounces: 6,
      chainFalloff: 0.85,
      chainRadius: 3.6,
      microStunSec: 0.22,
    },
  ]),

  venom: buildTiers('venom', 'Elemental', 'F', [
    {
      name: 'Alchemical Venom Vat',
      cost: 65,
      range: 4.0,
      cd: 0.95,
      dmg: 16,
      projSpeed: 13.0,
      acidStacks: 1,
      acidSec: 5.0,
      dotDps: 10,
    },
    {
      name: 'Corrosion Press',
      cost: 95,
      range: 4.4,
      cd: 0.82,
      dmg: 30,
      projSpeed: 14.0,
      acidStacks: 2,
      acidSec: 5.0,
      dotDps: 20,
    },
    {
      name: 'Plague Alembic',
      cost: 165,
      range: 4.9,
      cd: 0.70,
      dmg: 56,
      projSpeed: 15.5,
      acidStacks: 2,
      acidSec: 5.0,
      dotDps: 38,
      splash: 0.9,
    },
    {
      name: 'Blight-Press Distillery',
      cost: 280,
      range: 5.4,
      cd: 0.58,
      dmg: 104,
      projSpeed: 17.0,
      acidStacks: 3,
      acidSec: 5.0,
      dotDps: 68,
      splash: 1.2,
    },
  ]),

  brazier: buildTiers('brazier', 'Elemental', 'V', [
    {
      name: 'Hellfire Brazier',
      cost: 70,
      range: 3.8,
      cd: 0.90,
      dmg: 24,
      projSpeed: 14.0,
      igniteDps: 18,
      igniteSec: 3.5,
    },
    {
      name: 'Slag Furnace',
      cost: 105,
      range: 4.2,
      cd: 0.80,
      dmg: 44,
      projSpeed: 15.0,
      igniteDps: 34,
      igniteSec: 4.0,
      splash: 0.85,
    },
    {
      name: 'Magma Crucible',
      cost: 175,
      range: 4.6,
      cd: 0.70,
      dmg: 86,
      projSpeed: 16.0,
      igniteDps: 64,
      igniteSec: 4.5,
      splash: 1.15,
    },
    {
      name: 'Cinder-Forge Inferno',
      cost: 300,
      range: 5.1,
      cd: 0.58,
      dmg: 160,
      projSpeed: 17.5,
      igniteDps: 115,
      igniteSec: 5.0,
      splash: 1.45,
    },
  ]),
});

export const FUSION_TOWERS = Object.freeze({
  glacial_obelisk: Object.freeze({
    id: 'glacial_obelisk',
    name: 'Glacial Obelisk',
    recipe: FUSION_RECIPES.glacial_obelisk,
    attackType: 'Magic',
    cost: 340,
    range: 6.0,
    cd: 1.15,
    dmg: 215,
    projSpeed: 22.0,
    splash: 0,
    chillPct: 0.55,
    chillSec: 4.0,
    frozenSec: 2.2,
    instantFreeze: true,
    piercing: true,
  }),

  hellfire_mortar: Object.freeze({
    id: 'hellfire_mortar',
    name: 'Hellfire Mortar',
    recipe: FUSION_RECIPES.hellfire_mortar,
    attackType: 'Siege',
    cost: 370,
    range: 8.0,
    cd: 1.55,
    dmg: 360,
    projSpeed: 10.5,
    splash: 2.4,
    minRange: 1.2,
    igniteDps: 140,
    igniteSec: 5.0,
    slagSec: 5.5,
    triggersShatter: true,
  }),

  plague_coil: Object.freeze({
    id: 'plague_coil',
    name: 'Plague Coil',
    recipe: FUSION_RECIPES.plague_coil,
    attackType: 'Elemental',
    cost: 350,
    range: 5.8,
    cd: 0.80,
    dmg: 155,
    splash: 0,
    chainBounces: 7,
    chainFalloff: 0.85,
    chainRadius: 3.6,
    acidStacks: 2,
    acidSec: 5.5,
    dotDps: 56,
  }),

  shatter_cannon: Object.freeze({
    id: 'shatter_cannon',
    name: 'Shatter-Cannon',
    recipe: FUSION_RECIPES.shatter_cannon,
    attackType: 'Siege',
    cost: 365,
    range: 7.6,
    cd: 1.45,
    dmg: 310,
    projSpeed: 11.5,
    splash: 2.2,
    minRange: 1.2,
    chillPct: 0.45,
    chillSec: 3.6,
    autoShatterOnChilled: true,
    triggersShatter: true,
  }),

  railgun_bastion: Object.freeze({
    id: 'railgun_bastion',
    name: 'Railgun Bastion',
    recipe: FUSION_RECIPES.railgun_bastion,
    attackType: 'Pierce',
    cost: 355,
    range: 7.4,
    cd: 1.35,
    dmg: 295,
    splash: 0,
    corridorWidth: 0.65,
    corridorLength: 8.5,
    linePierce: true,
  }),

  viper_gatling: Object.freeze({
    id: 'viper_gatling',
    name: 'Viper Gatling',
    recipe: FUSION_RECIPES.viper_gatling,
    attackType: 'Pierce',
    cost: 345,
    range: 5.8,
    cd: 0.18,
    dmg: 54,
    projSpeed: 26.0,
    splash: 0,
    acidStacks: 1,
    acidSec: 5.0,
    dotDps: 26,
  }),

  singularity_catapult: Object.freeze({
    id: 'singularity_catapult',
    name: 'Singularity Catapult',
    recipe: FUSION_RECIPES.singularity_catapult,
    attackType: 'Magic',
    cost: 380,
    range: 7.8,
    cd: 1.80,
    dmg: 280,
    projSpeed: 10.0,
    splash: 2.5,
    minRange: 1.2,
    pullRadius: 2.5,
    knockupSec: 0.70,
  }),

  solar_flare: Object.freeze({
    id: 'solar_flare',
    name: 'Solar Flare Conduit',
    recipe: FUSION_RECIPES.solar_flare,
    attackType: 'Elemental',
    cost: 365,
    range: 6.2,
    cd: 0.20,
    dmg: 66,
    splash: 0,
    igniteDps: 95,
    igniteSec: 4.0,
    continuousBeam: true,
    solarBonusMult: SOLAR_FLARE_BONUS_MULT,
  }),

  windchill_flak: Object.freeze({
    id: 'windchill_flak',
    name: 'Windchill Flak Battery',
    recipe: FUSION_RECIPES.windchill_flak,
    attackType: 'Pierce',
    cost: 335,
    range: 6.6,
    cd: 0.55,
    dmg: 145,
    projSpeed: 21.0,
    splash: 1.3,
    chillPct: 0.40,
    chillSec: 3.2,
    earthbindSec: 4.5,
    bonusAirMult: 1.50,
  }),
});

/**
 * Resolves effective combat statistics for a base tower (tier 1..4) or hybrid fusion,
 * optionally ascended via Chaos Apex.
 */
export function getTowerStats(lineageId, tier = 1, fusionId = null, isChaosApex = false) {
  let stats;
  if (fusionId && FUSION_TOWERS[fusionId]) {
    const f = FUSION_TOWERS[fusionId];
    stats = {
      ...f,
      lineageId: lineageId || f.recipe[0],
      tier: Math.max(3, tier || 3),
      fusionId,
      isFusion: true,
      isChaosApex: false,
    };
  } else {
    const lineage = BASE_TOWERS[lineageId] || BASE_TOWERS[BASE_TOWER_IDS[0]];
    const idx = Math.max(0, Math.min(lineage.tiers.length - 1, (tier || 1) - 1));
    stats = {
      ...lineage.tiers[idx],
      fusionId: null,
      isFusion: false,
      isChaosApex: false,
    };
  }

  if (isChaosApex) {
    stats.attackType = 'Chaos';
    stats.dmg = Math.round(stats.dmg * CHAOS_APEX_UPGRADE.dmgMultiplier * 100) / 100;
    stats.range = Math.round((stats.range + CHAOS_APEX_UPGRADE.rangeBonus) * 100) / 100;
    stats.isChaosApex = true;
  }

  return stats;
}

/**
 * Lists all hybrid fusions available for `tower` given adjacent partner lineages and Fusion Essence.
 */
export function getAvailableFusionsForTower(tower, adjacentLineagesSet, fusionEssence = 0) {
  if (!tower || tower.fusionId || tower.tier < 3) {
    return [];
  }

  const hasLineage = (id) => {
    if (!adjacentLineagesSet) return false;
    if (typeof adjacentLineagesSet.has === 'function') return adjacentLineagesSet.has(id);
    if (Array.isArray(adjacentLineagesSet)) return adjacentLineagesSet.includes(id);
    return false;
  };

  const results = [];
  for (let i = 0; i < FUSION_TOWER_IDS.length; i++) {
    const fusionId = FUSION_TOWER_IDS[i];
    const def = FUSION_TOWERS[fusionId];
    const [a, b] = def.recipe;
    if (a !== tower.lineageId && b !== tower.lineageId) continue;

    const partnerLineage = a === tower.lineageId ? b : a;
    const canFuseByNeighbor = hasLineage(partnerLineage);
    const canFuseByEssence = fusionEssence > 0;
    results.push({
      fusionId,
      name: def.name,
      partnerLineage,
      cost: def.cost,
      canFuseByNeighbor,
      canFuseByEssence,
      ready: canFuseByNeighbor || canFuseByEssence,
    });
  }

  return results;
}
