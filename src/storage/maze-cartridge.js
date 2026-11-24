import {
  BASE_TOWER_IDS,
  BUILDER_MODES,
  CARTRIDGE_HASH_PREFIX,
  CARTRIDGE_MAGIC_VERSION,
  FUSION_TOWER_IDS,
  GRID_COLS,
  GRID_ROWS,
  TARGET_PRIORITIES,
} from '../contracts/types.js';

const HEADER_BYTES = 23;
const CHECKSUM_BYTES = 4;
const TOWER_BYTES = 4;
const MAX_TOWERS = 255;
const MAX_KILLS_PACKED = 511;
const MAX_DECOMPRESSED_BYTES = 65536;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
  BASE64URL_LOOKUP[BASE64URL_ALPHABET.charCodeAt(i)] = i;
}

const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

const COMP_RAW = 0x00;
const COMP_LZ77 = 0x01;

function clampInt(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  const floored = Math.floor(num);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSettings(settings) {
  const src = isPlainObject(settings) ? settings : {};
  const muted = Boolean(src.muted);
  const rawVol = Number(src.masterVolume);
  const masterVolume = Number.isFinite(rawVol) ? Math.max(0, Math.min(1, rawVol)) : 1;
  const builderMode =
    src.builderMode === BUILDER_MODES.INSTANT ? BUILDER_MODES.INSTANT : BUILDER_MODES.SPIRIT;
  return { muted, masterVolume, builderMode };
}

function normalizeTower(tower) {
  const src = isPlainObject(tower) ? tower : {};
  const col = clampInt(src.col, 0, GRID_COLS - 1);
  const row = clampInt(src.row, 0, GRID_ROWS - 1);
  const lineageId = BASE_TOWER_IDS.includes(src.lineageId) ? src.lineageId : BASE_TOWER_IDS[0];
  const tier = clampInt(src.tier ?? 1, 1, 4);
  const fusionId =
    src.fusionId && FUSION_TOWER_IDS.includes(src.fusionId) ? src.fusionId : null;
  const isChaosApex = Boolean(src.isChaosApex);
  const priority = TARGET_PRIORITIES.includes(src.priority)
    ? src.priority
    : TARGET_PRIORITIES[0];
  const kills = clampInt(src.kills ?? 0, 0, 0x7fffffff);
  const totalDamage = Number.isFinite(Number(src.totalDamage))
    ? Math.max(0, Number(src.totalDamage))
    : 0;
  const goldInvested = Number.isFinite(Number(src.goldInvested))
    ? Math.max(0, Number(src.goldInvested))
    : 0;

  return {
    col,
    row,
    lineageId,
    tier,
    fusionId,
    isChaosApex,
    priority,
    kills,
    totalDamage,
    goldInvested,
  };
}

/**
 * Normalizes either a nested checkpoint snapshot (`{ run: { ... } }`) or a
 * flat run/blueprint object into canonical checkpoint shape.
 */
export function normalizeCheckpoint(snapshot) {
  const src = isPlainObject(snapshot) ? snapshot : {};
  const hasExplicitRunKey = Object.prototype.hasOwnProperty.call(src, 'run');
  let runSrc = null;

  if (hasExplicitRunKey) {
    runSrc = isPlainObject(src.run) ? src.run : null;
  } else if (
    Array.isArray(src.towers) ||
    src.wave !== undefined ||
    src.gold !== undefined ||
    src.lives !== undefined ||
    src.essence !== undefined
  ) {
    runSrc = src;
  }

  const settings = normalizeSettings(src.settings);
  const highScore = clampInt(src.highScore ?? 0, 0, 0xffffffff);
  const bestWave = clampInt(src.bestWave ?? 0, 0, 0xffff);
  const rev = clampInt(src.rev ?? 0, 0, 0xffffffff);
  const updatedAt = Number.isFinite(Number(src.updatedAt))
    ? Math.max(0, Math.floor(Number(src.updatedAt)))
    : 0;

  let run = null;
  if (runSrc) {
    const rawTowers = Array.isArray(runSrc.towers) ? runSrc.towers : [];
    const towers = rawTowers.slice(0, MAX_TOWERS).map(normalizeTower);
    run = {
      wave: clampInt(runSrc.wave ?? 1, 0, 0xffff),
      gold: clampInt(runSrc.gold ?? 0, 0, 0xffffffff),
      lives: clampInt(runSrc.lives ?? 0, 0, 0xffff),
      essence: clampInt(runSrc.essence ?? 0, 0, 0xffff),
      score: clampInt(runSrc.score ?? 0, 0, 0xffffffff),
      seed: (Number(runSrc.seed) || 0) >>> 0,
      towers,
    };
  }

  return {
    version: CARTRIDGE_MAGIC_VERSION,
    updatedAt,
    rev,
    highScore,
    bestWave,
    settings,
    run,
  };
}

/**
 * Computes 32-bit FNV-1a checksum over a byte slice.
 */
export function computeFnv1a32(bytes) {
  let hash = FNV1A_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, FNV1A_PRIME);
  }
  return hash >>> 0;
}

/**
 * Encodes bytes into unpadded Base64URL (`A-Za-z0-9-_`).
 */
export function bytesToBase64Url(bytes) {
  const len = bytes.length;
  let out = '';
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < len;
    const hasB2 = i + 2 < len;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;

    out += BASE64URL_ALPHABET[(triplet >>> 18) & 0x3f];
    out += BASE64URL_ALPHABET[(triplet >>> 12) & 0x3f];
    if (hasB1) out += BASE64URL_ALPHABET[(triplet >>> 6) & 0x3f];
    if (hasB2) out += BASE64URL_ALPHABET[triplet & 0x3f];
  }
  return out;
}

/**
 * Decodes unpadded Base64URL string into Uint8Array, or returns null if malformed.
 */
export function base64UrlToBytes(str) {
  if (typeof str !== 'string' || str.length === 0) return null;
  if (str.length % 4 === 1) return null;

  const fullGroups = Math.floor(str.length / 4);
  const rem = str.length % 4;
  const outLen = fullGroups * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  const out = new Uint8Array(outLen);

  let inIdx = 0;
  let outIdx = 0;

  while (inIdx + 4 <= str.length) {
    const c0 = str.charCodeAt(inIdx);
    const c1 = str.charCodeAt(inIdx + 1);
    const c2 = str.charCodeAt(inIdx + 2);
    const c3 = str.charCodeAt(inIdx + 3);
    if (c0 > 127 || c1 > 127 || c2 > 127 || c3 > 127) return null;
    const v0 = BASE64URL_LOOKUP[c0];
    const v1 = BASE64URL_LOOKUP[c1];
    const v2 = BASE64URL_LOOKUP[c2];
    const v3 = BASE64URL_LOOKUP[c3];
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return null;

    const triplet = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    out[outIdx++] = (triplet >>> 16) & 0xff;
    out[outIdx++] = (triplet >>> 8) & 0xff;
    out[outIdx++] = triplet & 0xff;
    inIdx += 4;
  }

  if (rem === 2) {
    const c0 = str.charCodeAt(inIdx);
    const c1 = str.charCodeAt(inIdx + 1);
    if (c0 > 127 || c1 > 127) return null;
    const v0 = BASE64URL_LOOKUP[c0];
    const v1 = BASE64URL_LOOKUP[c1];
    if (v0 < 0 || v1 < 0 || (v1 & 0x0f) !== 0) return null;
    out[outIdx] = (v0 << 2) | (v1 >>> 4);
  } else if (rem === 3) {
    const c0 = str.charCodeAt(inIdx);
    const c1 = str.charCodeAt(inIdx + 1);
    const c2 = str.charCodeAt(inIdx + 2);
    if (c0 > 127 || c1 > 127 || c2 > 127) return null;
    const v0 = BASE64URL_LOOKUP[c0];
    const v1 = BASE64URL_LOOKUP[c1];
    const v2 = BASE64URL_LOOKUP[c2];
    if (v0 < 0 || v1 < 0 || v2 < 0 || (v2 & 0x03) !== 0) return null;
    out[outIdx++] = (v0 << 2) | (v1 >>> 4);
    out[outIdx] = ((v1 & 0x0f) << 4) | (v2 >>> 2);
  }

  return out;
}

/**
 * Compresses raw binary bytes using lightweight LZ77 sliding window + literal runs,
 * falling back to uncompressed framing whenever compression does not reduce size.
 */
function compressBytes(raw) {
  const n = raw.length;
  const maxOut = n + 8;
  const out = new Uint8Array(maxOut);
  out[0] = COMP_LZ77;
  out[1] = n & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = (n >>> 16) & 0xff;
  out[4] = (n >>> 24) & 0xff;

  let outPos = 5;
  let pos = 0;
  let litStart = 0;

  const flushLiterals = (endPos) => {
    while (litStart < endPos) {
      const chunkLen = Math.min(128, endPos - litStart);
      if (outPos + 1 + chunkLen >= maxOut) return false;
      out[outPos++] = chunkLen - 1;
      for (let i = 0; i < chunkLen; i++) {
        out[outPos++] = raw[litStart + i];
      }
      litStart += chunkLen;
    }
    return true;
  };

  while (pos < n) {
    let bestLen = 0;
    let bestDist = 0;

    if (pos + 3 <= n) {
      const windowStart = Math.max(0, pos - 4096);
      const maxMatch = Math.min(67, n - pos);
      const b0 = raw[pos];
      const b1 = raw[pos + 1];
      const b2 = raw[pos + 2];

      for (let cand = pos - 1; cand >= windowStart; cand--) {
        if (raw[cand] !== b0 || raw[cand + 1] !== b1 || raw[cand + 2] !== b2) continue;
        let len = 3;
        while (len < maxMatch && raw[cand + len] === raw[pos + len]) {
          len++;
        }
        const dist = pos - cand;
        if (len > bestLen && (dist <= 1024 ? len <= 18 || len >= 4 : len >= 4)) {
          bestLen = len;
          bestDist = dist;
          if (bestLen === maxMatch) break;
        }
      }
    }

    if (bestDist > 0 && bestDist <= 1024 && bestLen >= 3 && bestLen <= 18) {
      if (!flushLiterals(pos)) return makeRawFramed(raw);
      if (outPos + 2 >= maxOut) return makeRawFramed(raw);
      const distM1 = bestDist - 1;
      out[outPos++] = 0x80 | ((bestLen - 3) << 2) | (distM1 >>> 8);
      out[outPos++] = distM1 & 0xff;
      pos += bestLen;
      litStart = pos;
    } else if (bestDist > 0 && bestLen >= 4) {
      if (!flushLiterals(pos)) return makeRawFramed(raw);
      if (outPos + 3 >= maxOut) return makeRawFramed(raw);
      const distM1 = bestDist - 1;
      out[outPos++] = 0xc0 | (bestLen - 4);
      out[outPos++] = distM1 & 0xff;
      out[outPos++] = (distM1 >>> 8) & 0xff;
      pos += bestLen;
      litStart = pos;
    } else {
      pos++;
    }
  }

  if (!flushLiterals(n)) return makeRawFramed(raw);

  if (outPos >= n + 1) {
    return makeRawFramed(raw);
  }
  return out.subarray(0, outPos);
}

function makeRawFramed(raw) {
  const framed = new Uint8Array(raw.length + 1);
  framed[0] = COMP_RAW;
  framed.set(raw, 1);
  return framed;
}

/**
 * Decompresses a framed LZ77/raw stream safely; returns null on any truncation or corruption.
 */
function decompressBytes(framed) {
  if (!(framed instanceof Uint8Array) || framed.length < 2) return null;
  const mode = framed[0];

  if (mode === COMP_RAW) {
    return framed.subarray(1);
  }

  if (mode !== COMP_LZ77 || framed.length < 5) return null;

  const expectedLen =
    (framed[1] | (framed[2] << 8) | (framed[3] << 16) | (framed[4] << 24)) >>> 0;
  if (expectedLen === 0 || expectedLen > MAX_DECOMPRESSED_BYTES) return null;

  const out = new Uint8Array(expectedLen);
  let inPos = 5;
  let outPos = 0;

  while (inPos < framed.length) {
    const ctrl = framed[inPos++];
    if (ctrl < 0x80) {
      const litLen = ctrl + 1;
      if (inPos + litLen > framed.length || outPos + litLen > expectedLen) return null;
      for (let i = 0; i < litLen; i++) {
        out[outPos++] = framed[inPos++];
      }
    } else if (ctrl < 0xc0) {
      if (inPos >= framed.length) return null;
      const len = ((ctrl >>> 2) & 0x0f) + 3;
      const dist = (((ctrl & 0x03) << 8) | framed[inPos++]) + 1;
      if (dist <= 0 || dist > outPos || outPos + len > expectedLen) return null;
      for (let i = 0; i < len; i++) {
        out[outPos] = out[outPos - dist];
        outPos++;
      }
    } else {
      if (inPos + 1 >= framed.length) return null;
      const len = (ctrl - 0xc0) + 4;
      const dist = (framed[inPos] | (framed[inPos + 1] << 8)) + 1;
      inPos += 2;
      if (dist <= 0 || dist > outPos || outPos + len > expectedLen) return null;
      for (let i = 0; i < len; i++) {
        out[outPos] = out[outPos - dist];
        outPos++;
      }
    }
  }

  if (outPos !== expectedLen) return null;
  return out;
}

function packTowerWord(tower) {
  const col = clampInt(tower.col, 0, GRID_COLS - 1) & 0x1f;
  const row = clampInt(tower.row, 0, GRID_ROWS - 1) & 0x1f;
  const rawLineageIdx = BASE_TOWER_IDS.indexOf(tower.lineageId);
  const lineageIdx = (rawLineageIdx >= 0 ? rawLineageIdx : 0) & 0x07;
  const tierEnc = (clampInt(tower.tier ?? 1, 1, 4) - 1) & 0x03;
  const rawFusionIdx = tower.fusionId ? FUSION_TOWER_IDS.indexOf(tower.fusionId) : -1;
  const fusionIdx = (rawFusionIdx >= 0 ? rawFusionIdx + 1 : 0) & 0x0f;
  const chaosBit = tower.isChaosApex ? 1 : 0;
  const rawPrioIdx = TARGET_PRIORITIES.indexOf(tower.priority);
  const priorityIdx = (rawPrioIdx >= 0 ? rawPrioIdx : 0) & 0x07;
  const killsClamped = clampInt(tower.kills ?? 0, 0, MAX_KILLS_PACKED) & 0x1ff;

  return (
    (col |
      (row << 5) |
      (lineageIdx << 10) |
      (tierEnc << 13) |
      (fusionIdx << 15) |
      (chaosBit << 19) |
      (priorityIdx << 20) |
      (killsClamped << 23)) >>>
    0
  );
}

function unpackTowerWord(word) {
  const col = word & 0x1f;
  const row = (word >>> 5) & 0x1f;
  const lineageIdx = (word >>> 10) & 0x07;
  const tier = ((word >>> 13) & 0x03) + 1;
  const fusionIdx = (word >>> 15) & 0x0f;
  const isChaosApex = Boolean((word >>> 19) & 0x01);
  const priorityIdx = (word >>> 20) & 0x07;
  const kills = (word >>> 23) & 0x1ff;

  if (
    col >= GRID_COLS ||
    row >= GRID_ROWS ||
    lineageIdx >= BASE_TOWER_IDS.length ||
    fusionIdx > FUSION_TOWER_IDS.length ||
    priorityIdx >= TARGET_PRIORITIES.length
  ) {
    return null;
  }

  return {
    col,
    row,
    lineageId: BASE_TOWER_IDS[lineageIdx],
    tier,
    fusionId: fusionIdx === 0 ? null : FUSION_TOWER_IDS[fusionIdx - 1],
    isChaosApex,
    priority: TARGET_PRIORITIES[priorityIdx],
    kills,
    totalDamage: 0,
    goldInvested: 0,
  };
}

/**
 * Packs a checkpoint or flat run snapshot into binary layout + LZ77 + Base64URL string.
 */
export function encodeCartridge(snapshot) {
  const cp = normalizeCheckpoint(snapshot);
  const hasActiveRun = Boolean(cp.run);
  const towers = hasActiveRun ? cp.run.towers : [];
  const towerCount = Math.min(MAX_TOWERS, towers.length);

  const payloadLen = HEADER_BYTES + towerCount * TOWER_BYTES;
  const raw = new Uint8Array(payloadLen + CHECKSUM_BYTES);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  let flags = 0;
  if (hasActiveRun) flags |= 1 << 0;
  if (cp.settings.muted) flags |= 1 << 1;
  if (cp.settings.builderMode === BUILDER_MODES.INSTANT) flags |= 1 << 2;

  raw[0] = CARTRIDGE_MAGIC_VERSION;
  raw[1] = flags;
  view.setUint16(2, hasActiveRun ? cp.run.wave : 0, true);
  view.setUint32(4, hasActiveRun ? cp.run.gold : 0, true);
  view.setUint16(8, hasActiveRun ? cp.run.lives : 0, true);
  view.setUint16(10, hasActiveRun ? cp.run.essence : 0, true);
  view.setUint32(12, cp.highScore, true);
  view.setUint16(16, cp.bestWave, true);
  view.setUint32(18, hasActiveRun ? cp.run.seed : 0, true);
  raw[22] = towerCount;

  for (let i = 0; i < towerCount; i++) {
    const offset = HEADER_BYTES + i * TOWER_BYTES;
    view.setUint32(offset, packTowerWord(towers[i]), true);
  }

  const checksum = computeFnv1a32(raw.subarray(0, payloadLen));
  view.setUint32(payloadLen, checksum, true);

  const compressed = compressBytes(raw);
  return bytesToBase64Url(compressed);
}

/**
 * Safely decodes a `#maze=` hash or Base64URL token without ever throwing.
 */
export function decodeCartridge(hashOrToken) {
  try {
    if (typeof hashOrToken !== 'string') {
      return { ok: false, data: null, error: 'Cartridge input must be a string' };
    }

    let token = hashOrToken.trim();
    if (!token) {
      return { ok: false, data: null, error: 'Empty cartridge token' };
    }

    const prefixIdx = token.indexOf(CARTRIDGE_HASH_PREFIX);
    if (prefixIdx >= 0) {
      token = token.slice(prefixIdx + CARTRIDGE_HASH_PREFIX.length);
    }

    if (!token) {
      return { ok: false, data: null, error: 'Empty cartridge payload' };
    }

    const framed = base64UrlToBytes(token);
    if (!framed) {
      return { ok: false, data: null, error: 'Invalid Base64URL encoding' };
    }

    const raw = decompressBytes(framed);
    if (!raw || raw.length < HEADER_BYTES + CHECKSUM_BYTES) {
      return { ok: false, data: null, error: 'Truncated or corrupt cartridge payload' };
    }

    if (raw[0] !== CARTRIDGE_MAGIC_VERSION) {
      return { ok: false, data: null, error: `Unsupported cartridge version: ${raw[0]}` };
    }

    const towerCount = raw[22];
    const expectedPayloadLen = HEADER_BYTES + towerCount * TOWER_BYTES;
    if (raw.length !== expectedPayloadLen + CHECKSUM_BYTES) {
      return { ok: false, data: null, error: 'Cartridge length mismatch' };
    }

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const storedChecksum = view.getUint32(expectedPayloadLen, true);
    const computedChecksum = computeFnv1a32(raw.subarray(0, expectedPayloadLen));
    if (storedChecksum !== computedChecksum) {
      return { ok: false, data: null, error: 'Checksum mismatch' };
    }

    const flags = raw[1];
    const hasActiveRun = Boolean(flags & (1 << 0));
    const muted = Boolean(flags & (1 << 1));
    const instantBuilder = Boolean(flags & (1 << 2));

    const wave = view.getUint16(2, true);
    const gold = view.getUint32(4, true);
    const lives = view.getUint16(8, true);
    const essence = view.getUint16(10, true);
    const highScore = view.getUint32(12, true);
    const bestWave = view.getUint16(16, true);
    const seed = view.getUint32(18, true);

    const towers = [];
    for (let i = 0; i < towerCount; i++) {
      const word = view.getUint32(HEADER_BYTES + i * TOWER_BYTES, true);
      const tower = unpackTowerWord(word);
      if (!tower) {
        return { ok: false, data: null, error: `Corrupted tower record at index ${i}` };
      }
      towers.push(tower);
    }

    return {
      ok: true,
      data: {
        version: CARTRIDGE_MAGIC_VERSION,
        highScore,
        bestWave,
        settings: {
          muted,
          masterVolume: 1,
          builderMode: instantBuilder ? BUILDER_MODES.INSTANT : BUILDER_MODES.SPIRIT,
        },
        run: hasActiveRun
          ? {
              wave,
              gold,
              lives,
              essence,
              score: 0,
              seed,
              towers,
            }
          : null,
      },
    };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : 'Unknown decode error',
    };
  }
}

/**
 * Builds a shareable `#maze=<Base64URL>` hash string from a snapshot.
 */
export function buildCartridgeHash(snapshot) {
  return CARTRIDGE_HASH_PREFIX + encodeCartridge(snapshot);
}

/**
 * Exports a checkpoint or flat blueprint snapshot as formatted JSON.
 */
export function exportBlueprintJson(snapshot) {
  const cp = normalizeCheckpoint(snapshot);
  return JSON.stringify(
    {
      format: 'maul-forge-blueprint',
      version: CARTRIDGE_MAGIC_VERSION,
      rev: cp.rev,
      updatedAt: cp.updatedAt,
      highScore: cp.highScore,
      bestWave: cp.bestWave,
      settings: cp.settings,
      run: cp.run,
    },
    null,
    2,
  );
}

function validateImportedTower(t, index) {
  if (!isPlainObject(t)) return `Invalid tower entry at index ${index}`;
  if (!Number.isInteger(t.col) || t.col < 0 || t.col >= GRID_COLS) {
    return `Invalid tower col at index ${index}`;
  }
  if (!Number.isInteger(t.row) || t.row < 0 || t.row >= GRID_ROWS) {
    return `Invalid tower row at index ${index}`;
  }
  if (!BASE_TOWER_IDS.includes(t.lineageId)) {
    return `Invalid lineageId at index ${index}`;
  }
  if (!Number.isInteger(t.tier) || t.tier < 1 || t.tier > 4) {
    return `Invalid tier at index ${index}`;
  }
  if (t.fusionId !== undefined && t.fusionId !== null && !FUSION_TOWER_IDS.includes(t.fusionId)) {
    return `Invalid fusionId at index ${index}`;
  }
  if (t.priority !== undefined && !TARGET_PRIORITIES.includes(t.priority)) {
    return `Invalid priority at index ${index}`;
  }
  return null;
}

/**
 * Safely parses and validates a JSON blueprint/checkpoint export string.
 */
export function importBlueprintJson(jsonString) {
  try {
    if (typeof jsonString !== 'string' || !jsonString.trim()) {
      return { ok: false, data: null, error: 'Blueprint JSON string is empty' };
    }
    const parsed = JSON.parse(jsonString);
    if (!isPlainObject(parsed)) {
      return { ok: false, data: null, error: 'Blueprint JSON must be an object' };
    }
    if (parsed.format !== undefined && parsed.format !== 'maul-forge-blueprint') {
      return { ok: false, data: null, error: 'Unsupported blueprint format' };
    }
    if (parsed.version !== undefined && parsed.version !== CARTRIDGE_MAGIC_VERSION) {
      return { ok: false, data: null, error: `Unsupported blueprint version: ${parsed.version}` };
    }

    const hasRunField = Object.prototype.hasOwnProperty.call(parsed, 'run');
    const hasFlatRunFields =
      Array.isArray(parsed.towers) ||
      typeof parsed.wave === 'number' ||
      typeof parsed.gold === 'number';
    const hasMetaFields =
      typeof parsed.highScore === 'number' ||
      typeof parsed.bestWave === 'number' ||
      isPlainObject(parsed.settings);

    if (!hasRunField && !hasFlatRunFields && !hasMetaFields) {
      return { ok: false, data: null, error: 'Missing checkpoint or blueprint fields' };
    }

    const runObj = hasRunField ? parsed.run : hasFlatRunFields ? parsed : null;
    if (hasRunField && parsed.run !== null && !isPlainObject(parsed.run)) {
      return { ok: false, data: null, error: 'Invalid run object in blueprint' };
    }

    if (runObj) {
      if (!Array.isArray(runObj.towers)) {
        return { ok: false, data: null, error: 'Blueprint run.towers must be an array' };
      }
      for (let i = 0; i < runObj.towers.length; i++) {
        const err = validateImportedTower(runObj.towers[i], i);
        if (err) return { ok: false, data: null, error: err };
      }
    }

    return {
      ok: true,
      data: normalizeCheckpoint(parsed),
    };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : 'Invalid JSON blueprint',
    };
  }
}
