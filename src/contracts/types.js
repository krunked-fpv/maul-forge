/**
 * Frozen Shared Contracts & Constants for Project MAUL-FORGE.
 * Pure ES Module with zero external dependencies.
 * All parallel Phase 1-3 workers import shared symbols from this file.
 */

// --- PWA & Persistence ---
export const MAUL_FORGE_CACHE_V1 = 'maul-forge-v1.0.0';
export const COOKIE_VAULT_NAME = 'krunked-cookie-vault-v1';
export const COOKIE_VAULT_MAX_BYTES = 3500;
export const STORAGE_KEY_PRIMARY = 'maul-forge-state-v1';
export const IDB_DB_NAME = 'maul-forge-idb-v1';
export const IDB_STORE_NAME = 'bastion_vault';
export const CARTRIDGE_HASH_PREFIX = '#maze=';
export const CARTRIDGE_MAGIC_VERSION = 1;

// --- Grid, Camera & Timestep ---
export const GRID_COLS = 32;
export const GRID_ROWS = 22;
export const GRID_CELL_COUNT = GRID_COLS * GRID_ROWS; // 704
export const TOWER_FOOTPRINT = 2;

export const SIM_TICK_HZ = 60;
export const SIM_DT = 1 / SIM_TICK_HZ;

export const CAMERA_PITCH_Y = 0.80;
export const CAMERA_ELEV_SCALE = 0.72;

export const CELL_FLAGS = Object.freeze({
  EMPTY: 0,
  TOWER: 1,
  SPAWN: 2,
  WAYPOINT: 4,
  NEXUS: 8,
  OBSTACLE: 16,
});

export const SPAWN_GATES = Object.freeze([
  Object.freeze({ id: 0, name: 'North Rift', col: 1, row: 2, w: 2, h: 2, cx: 2.0, cy: 3.0 }),
  Object.freeze({ id: 1, name: 'South Rift', col: 1, row: 18, w: 2, h: 2, cx: 2.0, cy: 19.0 }),
]);

export const WAYPOINTS = Object.freeze([
  Object.freeze({ id: 0, name: 'Central Ley Shrine', col: 15, row: 10, w: 2, h: 2, cx: 16.0, cy: 11.0 }),
]);

export const NEXUS_CORE = Object.freeze({
  col: 29,
  row: 10,
  w: 2,
  h: 2,
  cx: 30.0,
  cy: 11.0,
});

export const STATIC_OBSTACLES = Object.freeze([
  Object.freeze({ col: 8, row: 0, w: 1, h: 2 }),
  Object.freeze({ col: 8, row: 20, w: 1, h: 2 }),
  Object.freeze({ col: 22, row: 0, w: 1, h: 2 }),
  Object.freeze({ col: 22, row: 20, w: 1, h: 2 }),
]);

// --- Towers, Fusions, Creeps & Combat ---
export const BASE_TOWER_IDS = Object.freeze([
  'ballista',
  'mortar',
  'frost',
  'tesla',
  'venom',
  'brazier',
]);

export const FUSION_TOWER_IDS = Object.freeze([
  'glacial_obelisk',
  'hellfire_mortar',
  'plague_coil',
  'shatter_cannon',
  'railgun_bastion',
  'viper_gatling',
  'singularity_catapult',
  'solar_flare',
  'windchill_flak',
]);

export const CREEP_ARCHETYPE_IDS = Object.freeze([
  'ghoul_swarm',
  'ironclad_grunt',
  'brood_arachnid',
  'sky_wyvern',
  'blood_shaman',
  'bulwark_golem',
  'void_splitter',
  'act_boss',
]);

export const ATTACK_TYPES = Object.freeze([
  'Pierce',
  'Siege',
  'Magic',
  'Elemental',
  'Chaos',
]);

export const ARMOR_TYPES = Object.freeze([
  'Light',
  'Medium',
  'Heavy',
  'Fortified',
  'Hero',
  'Ethereal',
]);

// 5x6 Attack-vs-Armor Multiplier Matrix
// Columns: Light, Medium, Heavy, Fortified, Hero, Ethereal
export const DAMAGE_MATRIX = Object.freeze({
  Pierce: Object.freeze({
    Light: 1.50,
    Medium: 0.75,
    Heavy: 1.00,
    Fortified: 0.40,
    Hero: 0.60,
    Ethereal: 0.25,
  }),
  Siege: Object.freeze({
    Light: 0.65,
    Medium: 1.00,
    Heavy: 0.85,
    Fortified: 1.65,
    Hero: 0.65,
    Ethereal: 0.25,
  }),
  Magic: Object.freeze({
    Light: 1.15,
    Medium: 0.85,
    Heavy: 1.60,
    Fortified: 0.50,
    Hero: 0.70,
    Ethereal: 1.75,
  }),
  Elemental: Object.freeze({
    Light: 1.00,
    Medium: 1.35,
    Heavy: 1.00,
    Fortified: 0.85,
    Hero: 0.85,
    Ethereal: 1.40,
  }),
  Chaos: Object.freeze({
    Light: 1.00,
    Medium: 1.00,
    Heavy: 1.00,
    Fortified: 1.00,
    Hero: 1.00,
    Ethereal: 1.00,
  }),
});

export const ACID_ARMOR_STRIP_PER_STACK = 2.5;
export const ACID_MAX_STACKS = 10;
export const SHATTER_COMBO_MULTIPLIER = 3.0;
export const SOLAR_FLARE_BONUS_MULT = 2.5;

export const TARGET_PRIORITIES = Object.freeze([
  'First',
  'Last',
  'Strongest',
  'Weakest',
  'Closest',
  'Air-Focus',
]);

export const BUILDER_MODES = Object.freeze({
  SPIRIT: 'spirit',
  INSTANT: 'instant',
});

export const VOICE_POOL_LIMIT = 24;
export const MAX_PARTICLES = 2048;
export const MAX_CREEPS = 512;
export const MAX_PROJECTILES = 1024;
export const MAX_DECALS = 256;

export const SIM_EVENTS = Object.freeze({
  TOWER_PLACED: 'tower_placed',
  TOWER_COMPLETE: 'tower_complete',
  TOWER_UPGRADED: 'tower_upgraded',
  TOWER_FUSED: 'tower_fused',
  TOWER_SOLD: 'tower_sold',
  BUILD_INVALID: 'build_invalid',
  BUILDER_SPARK: 'builder_spark',
  TOWER_FIRE: 'tower_fire',
  PROJECTILE_HIT: 'projectile_hit',
  CHAIN_LIGHTNING: 'chain_lightning',
  SHATTER_COMBO: 'shatter_combo',
  EARTHBIND_PULL: 'earthbind_pull',
  KNOCKUP_LAND: 'knockup_land',
  TERRAIN_DECAL: 'terrain_decal',
  CREEP_KILLED: 'creep_killed',
  NEXUS_LEAK: 'nexus_leak',
  WAVE_STARTED: 'wave_started',
  WAVE_CLEARED: 'wave_cleared',
});

export const FUSION_RECIPES = Object.freeze({
  glacial_obelisk: Object.freeze(['frost', 'tesla']),
  hellfire_mortar: Object.freeze(['brazier', 'mortar']),
  plague_coil: Object.freeze(['venom', 'tesla']),
  shatter_cannon: Object.freeze(['frost', 'mortar']),
  railgun_bastion: Object.freeze(['ballista', 'tesla']),
  viper_gatling: Object.freeze(['ballista', 'venom']),
  singularity_catapult: Object.freeze(['tesla', 'mortar']),
  solar_flare: Object.freeze(['brazier', 'tesla']),
  windchill_flak: Object.freeze(['ballista', 'frost']),
});

export const INITIAL_RUN_CONFIG = Object.freeze({
  startingGold: 260,
  startingLives: 30,
  startingEssence: 1,
  earlySendBonusPerSec: 2,
  graceRefundRate: 1.0,
  combatRefundRate: 0.75,
});
