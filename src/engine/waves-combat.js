import {
  CREEP_ARCHETYPE_IDS,
  DAMAGE_MATRIX,
  ACID_ARMOR_STRIP_PER_STACK,
  ACID_MAX_STACKS,
  SHATTER_COMBO_MULTIPLIER,
  SOLAR_FLARE_BONUS_MULT,
} from '../contracts/types.js';

export const CREEP_DEFS = Object.freeze({
  ghoul_swarm: Object.freeze({
    id: 'ghoul_swarm',
    name: 'Ghoul Swarm',
    armorType: 'Light',
    baseHp: 46,
    speed: 2.35,
    baseArmor: 0,
    bounty: 5,
    radius: 0.24,
    isFlying: false,
    isBoss: false,
  }),
  ironclad_grunt: Object.freeze({
    id: 'ironclad_grunt',
    name: 'Ironclad Grunt',
    armorType: 'Heavy',
    baseHp: 120,
    speed: 1.55,
    baseArmor: 8,
    bounty: 9,
    radius: 0.30,
    isFlying: false,
    isBoss: false,
  }),
  brood_arachnid: Object.freeze({
    id: 'brood_arachnid',
    name: 'Brood-Arachnid',
    armorType: 'Medium',
    baseHp: 88,
    speed: 1.95,
    baseArmor: 3,
    bounty: 7,
    radius: 0.28,
    isFlying: false,
    isBoss: false,
  }),
  sky_wyvern: Object.freeze({
    id: 'sky_wyvern',
    name: 'Sky-Wyvern',
    armorType: 'Light',
    baseHp: 92,
    speed: 2.05,
    baseArmor: 2,
    bounty: 10,
    radius: 0.30,
    isFlying: true,
    isBoss: false,
  }),
  blood_shaman: Object.freeze({
    id: 'blood_shaman',
    name: 'Blood-Ward Shaman',
    armorType: 'Medium',
    baseHp: 135,
    speed: 1.65,
    baseArmor: 4,
    bounty: 12,
    radius: 0.28,
    isFlying: false,
    isBoss: false,
    healPct: 0.06,
    healIntervalSec: 2.6,
    healRadius: 2.4,
  }),
  bulwark_golem: Object.freeze({
    id: 'bulwark_golem',
    name: 'Runed Bulwark Golem',
    armorType: 'Fortified',
    baseHp: 245,
    speed: 1.18,
    baseArmor: 12,
    bounty: 16,
    radius: 0.34,
    isFlying: false,
    isBoss: false,
    shieldPct: 0.25,
    shieldRegenDelaySec: 3.0,
  }),
  void_splitter: Object.freeze({
    id: 'void_splitter',
    name: 'Void Wraith',
    armorType: 'Ethereal',
    baseHp: 110,
    speed: 1.80,
    baseArmor: 2,
    bounty: 11,
    radius: 0.28,
    isFlying: false,
    isBoss: false,
    splitCount: 3,
  }),
  act_boss: Object.freeze({
    id: 'act_boss',
    name: 'Act Boss',
    armorType: 'Hero',
    baseHp: 1150,
    speed: 1.12,
    baseArmor: 14,
    bounty: 120,
    radius: 0.42,
    isFlying: false,
    isBoss: true,
    stunResistMult: 0.40,
  }),
});

const AIR_WAVES = new Set([5, 12, 18, 24, 32, 42, 48]);

const CURATED_ROTATION = [
  ['ghoul_swarm', 'brood_arachnid'],
  ['ironclad_grunt', 'ghoul_swarm'],
  ['brood_arachnid', 'blood_shaman'],
  ['bulwark_golem', 'ironclad_grunt'],
  ['void_splitter', 'ghoul_swarm'],
  ['ironclad_grunt', 'blood_shaman', 'brood_arachnid'],
  ['bulwark_golem', 'void_splitter'],
];

function getBossMetadata(waveNumber) {
  if (waveNumber < 10 || waveNumber % 10 !== 0) {
    return { isBossWave: false, bossTitle: '', bossArmorType: 'Hero' };
  }
  const mod50 = waveNumber % 50;
  let bossTitle = 'Malakor';
  if (mod50 === 10) bossTitle = 'Marrow-Crag';
  else if (mod50 === 20 || mod50 === 40) bossTitle = 'Zephyria';
  else bossTitle = 'Malakor';

  const actIdx = Math.floor(waveNumber / 10);
  const bossArmorType = actIdx % 2 === 0 ? 'Fortified' : 'Hero';
  return { isBossWave: true, bossTitle, bossArmorType };
}

/**
 * Generates deterministic wave composition for waves 1..50 (curated) and 51..100+ (endless).
 */
export function generateWaveSchedule(waveNumber) {
  const w = Math.max(1, Math.floor(waveNumber));
  const hpMult = Math.pow(1.145, w - 1) * (1 + Math.max(0, w - 35) * 0.045);
  const bountyMult = 1 + (w - 1) * 0.08;
  const spawnIntervalSec = Math.max(0.24, 0.68 - w * 0.008);

  const { isBossWave, bossTitle, bossArmorType } = getBossMetadata(w);
  const groups = [];

  if (isBossWave) {
    const escortCount = Math.min(24, 6 + Math.floor(w * 0.25));
    groups.push({
      archetypeId: 'act_boss',
      count: 1,
      gateId: 0,
      hpMult,
      bountyMult,
      armorType: bossArmorType,
    });
    groups.push({
      archetypeId: w >= 30 ? 'blood_shaman' : 'ironclad_grunt',
      count: Math.max(2, Math.floor(escortCount * 0.5)),
      gateId: 1,
      hpMult,
      bountyMult,
    });
    if (w >= 20) {
      groups.push({
        archetypeId: w >= 40 ? 'bulwark_golem' : 'ghoul_swarm',
        count: Math.max(3, Math.floor(escortCount * 0.5)),
        gateId: 0,
        hpMult,
        bountyMult,
      });
    }
  } else if (w <= 50) {
    if (w === 1) {
      groups.push({ archetypeId: 'ghoul_swarm', count: 6, gateId: 0, hpMult, bountyMult });
      groups.push({ archetypeId: 'ghoul_swarm', count: 6, gateId: 1, hpMult, bountyMult });
    } else if (w === 2) {
      groups.push({ archetypeId: 'brood_arachnid', count: 5, gateId: 0, hpMult, bountyMult });
      groups.push({ archetypeId: 'ghoul_swarm', count: 7, gateId: 1, hpMult, bountyMult });
    } else if (w === 3) {
      groups.push({ archetypeId: 'ironclad_grunt', count: 5, gateId: 0, hpMult, bountyMult });
      groups.push({ archetypeId: 'ironclad_grunt', count: 5, gateId: 1, hpMult, bountyMult });
    } else if (w === 4) {
      groups.push({ archetypeId: 'brood_arachnid', count: 7, gateId: 0, hpMult, bountyMult });
      groups.push({ archetypeId: 'ironclad_grunt', count: 5, gateId: 1, hpMult, bountyMult });
    } else if (AIR_WAVES.has(w)) {
      const airCount = 6 + Math.floor(w * 0.35);
      groups.push({ archetypeId: 'sky_wyvern', count: airCount, gateId: 0, hpMult, bountyMult });
      groups.push({ archetypeId: 'sky_wyvern', count: airCount, gateId: 1, hpMult, bountyMult });
      if (w >= 18) {
        groups.push({
          archetypeId: w >= 32 ? 'void_splitter' : 'brood_arachnid',
          count: Math.floor(airCount * 0.6),
          gateId: 0,
          hpMult,
          bountyMult,
        });
      }
    } else if (w === 6) {
      groups.push({ archetypeId: 'blood_shaman', count: 4, gateId: 0, hpMult, bountyMult });
      groups.push({ archetypeId: 'ironclad_grunt', count: 6, gateId: 1, hpMult, bountyMult });
    } else if (w === 7) {
      groups.push({ archetypeId: 'bulwark_golem', count: 4, gateId: 0, hpMult, bountyMult });
      groups.push({ archetypeId: 'brood_arachnid', count: 8, gateId: 1, hpMult, bountyMult });
    } else if (w === 8) {
      groups.push({ archetypeId: 'void_splitter', count: 5, gateId: 0, hpMult, bountyMult });
      groups.push({ archetypeId: 'ghoul_swarm', count: 10, gateId: 1, hpMult, bountyMult });
    } else {
      const pack = CURATED_ROTATION[w % CURATED_ROTATION.length];
      const basePerGate = Math.min(22, 6 + Math.floor(w * 0.34));
      for (let i = 0; i < pack.length; i++) {
        const arch = pack[i];
        const perGate = Math.max(3, Math.round(basePerGate / pack.length));
        groups.push({ archetypeId: arch, count: perGate, gateId: 0, hpMult, bountyMult });
        groups.push({ archetypeId: arch, count: perGate, gateId: 1, hpMult, bountyMult });
      }
    }
  } else {
    // Endless waves 51..100+: 18..48 creeps per gate across multi-archetype packs
    const perGateTotal = Math.min(48, 18 + Math.floor((w - 51) * 0.6));
    const nonBossPool = CREEP_ARCHETYPE_IDS.filter((id) => id !== 'act_boss');
    const a1 = nonBossPool[(w * 3) % nonBossPool.length];
    const a2 = nonBossPool[(w * 3 + 2) % nonBossPool.length];
    const a3 = nonBossPool[(w * 3 + 5) % nonBossPool.length];

    const c1 = Math.max(4, Math.floor(perGateTotal * 0.4));
    const c2 = Math.max(4, Math.floor(perGateTotal * 0.35));
    const c3 = Math.max(3, perGateTotal - c1 - c2);

    groups.push({ archetypeId: a1, count: c1, gateId: 0, hpMult, bountyMult });
    groups.push({ archetypeId: a2, count: c2, gateId: 0, hpMult, bountyMult });
    groups.push({ archetypeId: a3, count: c3, gateId: 0, hpMult, bountyMult });

    groups.push({ archetypeId: a2, count: c1, gateId: 1, hpMult, bountyMult });
    groups.push({ archetypeId: a3, count: c2, gateId: 1, hpMult, bountyMult });
    groups.push({ archetypeId: a1, count: c3, gateId: 1, hpMult, bountyMult });
  }

  return {
    waveNumber: w,
    isBossWave,
    bossTitle,
    spawnIntervalSec,
    groups,
  };
}

/**
 * Exact 5x6 WC3 attack-vs-armor multiplier.
 */
export function computeDamageMultiplier(attackType, armorType) {
  const row = DAMAGE_MATRIX[attackType];
  if (!row) return 1.0;
  return row[armorType] ?? 1.0;
}

/**
 * Computes effective armor after Acid stacks and resulting WC3 armor damage multiplier.
 */
export function computeArmorFactor(baseArmor, acidStacks = 0) {
  const stacks = Math.max(0, Math.min(ACID_MAX_STACKS, acidStacks || 0));
  const effectiveArmor = baseArmor - stacks * ACID_ARMOR_STRIP_PER_STACK;
  const multiplier =
    effectiveArmor >= 0
      ? 1 / (1 + 0.05 * effectiveArmor)
      : 2 - Math.pow(0.95, -effectiveArmor);
  return { effectiveArmor, multiplier };
}

/**
 * Resolves single-hit combat damage including 5x6 matrix, Acid armor factor,
 * Solar Flare bonus, Air bonus, Shatter 3.0x combo, and Bulwark Golem shield absorption.
 */
export function resolveHitDamage(rawDmg, attackType, creep, options = {}) {
  const typeMult = computeDamageMultiplier(attackType, creep.armorType);
  const { multiplier: armorMult } = computeArmorFactor(creep.baseArmor || 0, creep.acidStacks || 0);

  let dmg = rawDmg * typeMult * armorMult;

  if (options.bonusAirMult && (creep.isFlying || creep.earthboundTimer > 0 || creep.archetypeId === 'sky_wyvern')) {
    dmg *= options.bonusAirMult;
  }

  if (
    (options.isSolarFlare || options.solarBonusMult) &&
    (creep.armorType === 'Ethereal' || creep.archetypeId === 'ghoul_swarm')
  ) {
    dmg *= options.solarBonusMult || SOLAR_FLARE_BONUS_MULT;
  }

  const canShatter =
    !options.isShatterSplash &&
    (attackType === 'Siege' || Boolean(options.triggersShatter)) &&
    (creep.frozenTimer > 0 || (Boolean(options.autoShatterOnChilled) && creep.chillTimer > 0));

  let triggeredShatter = false;
  let shatterAoeDmg = 0;

  if (canShatter) {
    triggeredShatter = true;
    dmg *= SHATTER_COMBO_MULTIPLIER;
    shatterAoeDmg = dmg;
  }

  const finalDamage = Math.max(0, dmg);
  const shield = Math.max(0, creep.shield || 0);
  const shieldAbsorbed = Math.min(shield, finalDamage);
  const hpDamage = finalDamage - shieldAbsorbed;

  return {
    finalDamage,
    shieldAbsorbed,
    hpDamage,
    triggeredShatter,
    shatterAoeDmg,
  };
}
