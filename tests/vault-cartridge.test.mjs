import assert from 'node:assert/strict';
import {
  BASE_TOWER_IDS,
  BUILDER_MODES,
  CARTRIDGE_HASH_PREFIX,
  COOKIE_VAULT_MAX_BYTES,
  COOKIE_VAULT_NAME,
  FUSION_TOWER_IDS,
  IDB_DB_NAME,
  IDB_STORE_NAME,
  STORAGE_KEY_PRIMARY,
  TARGET_PRIORITIES,
} from '../src/contracts/types.js';
import {
  buildCartridgeHash,
  decodeCartridge,
  encodeCartridge,
  exportBlueprintJson,
  importBlueprintJson,
} from '../src/storage/maze-cartridge.js';
import {
  clearCookieVault,
  readCookieVault,
  writeCookieVault,
} from '../src/storage/cookie-vault.js';
import { RunPersistence } from '../src/storage/run-persistence.js';

function createMockLocalStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, val) {
      map.set(key, String(val));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    _dump() {
      return map;
    },
  };
}

function createMockCookieDocument() {
  const jar = new Map();
  return {
    get cookie() {
      const parts = [];
      for (const [k, v] of jar.entries()) {
        parts.push(`${k}=${v}`);
      }
      return parts.join('; ');
    },
    set cookie(raw) {
      const segments = String(raw).split(';');
      const [name, ...valParts] = segments[0].split('=');
      const key = name.trim();
      const val = valParts.join('=').trim();
      const maxAgeSeg = segments.find((s) => s.trim().toLowerCase().startsWith('max-age='));
      const maxAge = maxAgeSeg ? Number(maxAgeSeg.trim().slice('max-age='.length)) : null;
      if ((maxAge !== null && maxAge <= 0) || val === '') {
        jar.delete(key);
      } else {
        jar.set(key, val);
      }
    },
    _rawJar: jar,
  };
}

function createMockCookieAccessor() {
  let stored = '';
  return {
    get() {
      return stored;
    },
    set(str) {
      stored = str;
    },
  };
}

function createMockIndexedDB() {
  const databases = new Map();

  function getStores(dbName) {
    if (!databases.has(dbName)) {
      databases.set(dbName, new Map());
    }
    return databases.get(dbName);
  }

  return {
    open(dbName) {
      const req = {
        result: null,
        readyState: 'pending',
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        const stores = getStores(dbName);
        const db = {
          objectStoreNames: {
            contains(name) {
              return stores.has(name);
            },
          },
          createObjectStore(name) {
            if (!stores.has(name)) {
              stores.set(name, new Map());
            }
            return {};
          },
          transaction(storeName) {
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore(name) {
                if (name !== storeName && !stores.has(name)) {
                  throw new Error(`Missing store ${name}`);
                }
                const storeMap = stores.get(name);
                return {
                  get(key) {
                    const opReq = { result: undefined, readyState: 'pending', onsuccess: null, onerror: null };
                    queueMicrotask(() => {
                      opReq.result = storeMap ? storeMap.get(key) : undefined;
                      opReq.readyState = 'done';
                      opReq.onsuccess?.({ target: opReq });
                      tx.oncomplete?.();
                    });
                    return opReq;
                  },
                  put(val, key) {
                    const opReq = { result: key, readyState: 'pending', onsuccess: null, onerror: null };
                    queueMicrotask(() => {
                      if (storeMap) {
                        storeMap.set(key, structuredClone(val));
                      }
                      opReq.readyState = 'done';
                      opReq.onsuccess?.({ target: opReq });
                      tx.oncomplete?.();
                    });
                    return opReq;
                  },
                };
              },
            };
            return tx;
          },
          close() {},
        };

        req.result = db;
        req.readyState = 'done';
        if (!stores.has(IDB_STORE_NAME)) {
          req.onupgradeneeded?.({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
    _wipeAll() {
      for (const dbStores of databases.values()) {
        for (const map of dbStores.values()) {
          map.clear();
        }
      }
    },
    _getRaw(dbName = IDB_DB_NAME, storeName = IDB_STORE_NAME, key = STORAGE_KEY_PRIMARY) {
      return databases.get(dbName)?.get(storeName)?.get(key) ?? null;
    },
  };
}

function buildEndgameCheckpoint(towerCount = 80) {
  const towers = [];
  let idx = 0;
  for (let row = 0; row < 20 && towers.length < towerCount; row += 2) {
    for (let col = 0; col < 30 && towers.length < towerCount; col += 2) {
      const lineageId = BASE_TOWER_IDS[idx % BASE_TOWER_IDS.length];
      const tier = (idx % 4) + 1;
      const fusionId =
        tier >= 3 && idx % 3 === 0 ? FUSION_TOWER_IDS[idx % FUSION_TOWER_IDS.length] : null;
      const isChaosApex = tier === 4 && idx % 5 === 0;
      const priority = TARGET_PRIORITIES[idx % TARGET_PRIORITIES.length];
      const kills = idx === 79 ? 1200 : (idx * 17) % 512;
      towers.push({
        col,
        row,
        lineageId,
        tier,
        fusionId,
        isChaosApex,
        priority,
        kills,
        totalDamage: kills * 350,
        goldInvested: 120 + tier * 90,
      });
      idx++;
    }
  }

  return {
    version: 1,
    rev: 12,
    updatedAt: 1730000123456,
    highScore: 9876543,
    bestWave: 92,
    settings: {
      muted: true,
      masterVolume: 0.75,
      builderMode: BUILDER_MODES.INSTANT,
    },
    run: {
      wave: 87,
      gold: 18420,
      lives: 19,
      essence: 4,
      score: 654321,
      seed: 0xdeadbeef,
      towers,
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('1. 80-tower endgame checkpoint encodes < 3500 bytes and restores exact tower state', () => {
  const checkpoint = buildEndgameCheckpoint(80);
  const hash = buildCartridgeHash(checkpoint);
  assert.ok(hash.startsWith(CARTRIDGE_HASH_PREFIX));

  const cookieDoc = createMockCookieDocument();
  const writeRes = writeCookieVault(checkpoint, cookieDoc);
  assert.equal(writeRes.ok, true);
  assert.ok(
    writeRes.bytes < COOKIE_VAULT_MAX_BYTES,
    `Expected cookie size < ${COOKIE_VAULT_MAX_BYTES}, got ${writeRes.bytes}`,
  );
  assert.match(
    writeRes.cookieString,
    new RegExp(`^${COOKIE_VAULT_NAME}=v1\\.12\\.[0-9a-z]+\\.[A-Za-z0-9_-]+; SameSite=Lax; path=\\./; max-age=31536000$`),
  );

  // Also test { get(), set() } accessor support
  const accessor = createMockCookieAccessor();
  const writeAccRes = writeCookieVault(checkpoint, accessor);
  assert.equal(writeAccRes.ok, true);
  assert.ok(writeAccRes.bytes < COOKIE_VAULT_MAX_BYTES);

  const readDoc = readCookieVault(cookieDoc);
  const readAcc = readCookieVault(accessor);
  assert.ok(readDoc?.ok);
  assert.ok(readAcc?.ok);
  assert.equal(readDoc.rev, 12);
  assert.equal(readDoc.updatedAt, 1730000123456);
  assert.equal(readAcc.rev, 12);
  assert.equal(readAcc.updatedAt, 1730000123456);

  const decodedHash = decodeCartridge(hash);
  assert.equal(decodedHash.ok, true);
  assert.equal(decodedHash.data.highScore, 9876543);
  assert.equal(decodedHash.data.bestWave, 92);
  assert.equal(decodedHash.data.settings.muted, true);
  assert.equal(decodedHash.data.settings.builderMode, BUILDER_MODES.INSTANT);
  assert.equal(decodedHash.data.run.wave, 87);
  assert.equal(decodedHash.data.run.gold, 18420);
  assert.equal(decodedHash.data.run.lives, 19);
  assert.equal(decodedHash.data.run.essence, 4);
  assert.equal(decodedHash.data.run.seed, 0xdeadbeef);
  assert.equal(decodedHash.data.run.towers.length, 80);

  for (let i = 0; i < 80; i++) {
    const src = checkpoint.run.towers[i];
    const dst = decodedHash.data.run.towers[i];
    assert.equal(dst.col, src.col);
    assert.equal(dst.row, src.row);
    assert.equal(dst.lineageId, src.lineageId);
    assert.equal(dst.tier, src.tier);
    assert.equal(dst.fusionId, src.fusionId);
    assert.equal(dst.isChaosApex, src.isChaosApex);
    assert.equal(dst.priority, src.priority);
    assert.equal(dst.kills, Math.min(511, src.kills));
  }

  // Flat snapshot support check
  const flatToken = encodeCartridge({
    wave: 15,
    gold: 400,
    lives: 25,
    essence: 2,
    highScore: 1000,
    bestWave: 15,
    seed: 42,
    settings: { muted: false, builderMode: BUILDER_MODES.SPIRIT },
    towers: [checkpoint.run.towers[0]],
  });
  const flatDecoded = decodeCartridge(flatToken);
  assert.equal(flatDecoded.ok, true);
  assert.equal(flatDecoded.data.run.wave, 15);
  assert.equal(flatDecoded.data.run.towers.length, 1);
});

test('2. Corrupted, truncated, and invalid #maze= inputs fail gracefully without throwing', () => {
  const validToken = encodeCartridge(buildEndgameCheckpoint(20));

  const badInputs = [
    null,
    undefined,
    123,
    {},
    '',
    '   ',
    '#maze=',
    '#wrong=' + validToken,
    validToken + '=',
    validToken + '!',
    'A', // invalid base64 length mod 4 === 1
    'Zm9v', // valid base64 for "foo", invalid cartridge
  ];

  for (const input of badInputs) {
    const res = decodeCartridge(input);
    assert.equal(res.ok, false);
    assert.equal(res.data, null);
    assert.equal(typeof res.error, 'string');
  }

  // Every truncated prefix must fail safely
  for (let len = 1; len < validToken.length; len++) {
    const truncated = '#maze=' + validToken.slice(0, len);
    const res = decodeCartridge(truncated);
    assert.equal(res.ok, false, `Expected truncated length ${len} to fail`);
    assert.equal(res.data, null);
  }

  // Corrupted characters inside the token must fail checksum/LZ safely
  for (const idx of [0, 3, 10, Math.floor(validToken.length / 2), validToken.length - 1]) {
    const chars = validToken.split('');
    chars[idx] = chars[idx] === 'A' ? 'B' : 'A';
    const corrupted = CARTRIDGE_HASH_PREFIX + chars.join('');
    const res = decodeCartridge(corrupted);
    assert.equal(res.ok, false, `Expected bit flip at index ${idx} to fail`);
    assert.equal(res.data, null);
  }

  // Corrupted cookie vault token returns { ok: false }, clear sets null
  const cookieDoc = createMockCookieDocument();
  cookieDoc.cookie = `${COOKIE_VAULT_NAME}=v1.1.abc.${validToken.slice(0, -4)}ZZZZ`;
  const badCookie = readCookieVault(cookieDoc);
  assert.ok(badCookie);
  assert.equal(badCookie.ok, false);
  assert.equal(badCookie.data, null);

  clearCookieVault(cookieDoc);
  assert.equal(readCookieVault(cookieDoc), null);
});

test('3. Wiping LocalStorage AND IndexedDB heals both automatically from krunked-cookie-vault-v1', async () => {
  const localStorage = createMockLocalStorage();
  const indexedDB = createMockIndexedDB();
  const cookieDoc = createMockCookieDocument();

  const persistence1 = new RunPersistence({ localStorage, indexedDB, cookieDoc });
  const checkpoint = buildEndgameCheckpoint(80);
  const saved = await persistence1.saveState(checkpoint);
  assert.ok(saved.rev >= 1);
  assert.ok(localStorage.getItem(STORAGE_KEY_PRIMARY));
  assert.ok(indexedDB._getRaw());
  assert.ok(readCookieVault(cookieDoc)?.ok);

  // Simulate browser clearing LocalStorage & IndexedDB while cookie survives
  localStorage.clear();
  indexedDB._wipeAll();
  assert.equal(localStorage.getItem(STORAGE_KEY_PRIMARY), null);
  assert.equal(indexedDB._getRaw(), null);

  const persistence2 = new RunPersistence({ localStorage, indexedDB, cookieDoc });
  const healed = await persistence2.bootAndHeal();

  assert.equal(healed.source, 'cookieVault');
  assert.deepEqual(healed.healedLayers.sort(), ['indexedDB', 'localStorage']);
  assert.equal(healed.state.rev, saved.rev);
  assert.equal(healed.state.highScore, checkpoint.highScore);
  assert.equal(healed.state.bestWave, checkpoint.bestWave);
  assert.equal(healed.state.run.wave, checkpoint.run.wave);
  assert.equal(healed.state.run.gold, checkpoint.run.gold);
  assert.equal(healed.state.run.towers.length, 80);

  // Verify both LocalStorage and IndexedDB were actually repopulated
  const lsRestored = JSON.parse(localStorage.getItem(STORAGE_KEY_PRIMARY));
  const idbRestored = indexedDB._getRaw();
  assert.equal(lsRestored.run.towers.length, 80);
  assert.equal(idbRestored.run.towers.length, 80);
  assert.equal(lsRestored.rev, saved.rev);
  assert.equal(idbRestored.rev, saved.rev);
});

test('4. Clearing krunked-cookie-vault-v1 heals cookie automatically on bootAndHeal() and reconcileIfTampered()', async () => {
  const localStorage = createMockLocalStorage();
  const indexedDB = createMockIndexedDB();
  const cookieDoc = createMockCookieDocument();

  const persistence = new RunPersistence({ localStorage, indexedDB, cookieDoc });
  const checkpoint = buildEndgameCheckpoint(40);
  const saved = await persistence.saveState(checkpoint);

  // Clear cookie while primary stores remain
  clearCookieVault(cookieDoc);
  assert.equal(readCookieVault(cookieDoc), null);

  const bootResult = await new RunPersistence({ localStorage, indexedDB, cookieDoc }).bootAndHeal();
  assert.equal(bootResult.source, 'localStorage');
  assert.deepEqual(bootResult.healedLayers, ['cookieVault']);
  assert.equal(bootResult.state.run.score, checkpoint.run.score);
  assert.equal(bootResult.state.run.towers[0].totalDamage, checkpoint.run.towers[0].totalDamage);

  const regeneratedCookie = readCookieVault(cookieDoc);
  assert.ok(regeneratedCookie?.ok);
  assert.equal(regeneratedCookie.rev, saved.rev);
  assert.equal(regeneratedCookie.data.run.towers.length, 40);

  // Clear cookie again and verify reconcileIfTampered() repairs it immediately
  clearCookieVault(cookieDoc);
  assert.equal(readCookieVault(cookieDoc), null);

  const reconcileRes = await persistence.reconcileIfTampered();
  assert.equal(reconcileRes.healed, true);
  assert.deepEqual(reconcileRes.healedLayers, ['cookieVault']);
  assert.ok(readCookieVault(cookieDoc)?.ok);

  // Verify clearRunOnly() clears run while preserving meta + settings across all 3 layers
  const cleared = await persistence.clearRunOnly();
  assert.equal(cleared.run, null);
  assert.equal(cleared.highScore, checkpoint.highScore);
  assert.equal(cleared.bestWave, checkpoint.bestWave);
  assert.equal(cleared.settings.muted, true);
  assert.equal(cleared.settings.builderMode, BUILDER_MODES.INSTANT);

  localStorage.clear();
  indexedDB._wipeAll();
  const afterMetaRecovery = await new RunPersistence({ localStorage, indexedDB, cookieDoc }).bootAndHeal();
  assert.equal(afterMetaRecovery.source, 'cookieVault');
  assert.equal(afterMetaRecovery.state.run, null);
  assert.equal(afterMetaRecovery.state.highScore, checkpoint.highScore);
  assert.equal(afterMetaRecovery.state.bestWave, checkpoint.bestWave);
  assert.equal(afterMetaRecovery.state.settings.muted, true);
  assert.equal(afterMetaRecovery.state.settings.builderMode, BUILDER_MODES.INSTANT);
});

test('5. JSON blueprint export/import round-trips cleanly and rejects malformed blueprints', () => {
  const checkpoint = buildEndgameCheckpoint(25);
  const exported = exportBlueprintJson(checkpoint);
  const imported = importBlueprintJson(exported);

  assert.equal(imported.ok, true);
  assert.equal(imported.data.highScore, checkpoint.highScore);
  assert.equal(imported.data.bestWave, checkpoint.bestWave);
  assert.deepEqual(imported.data.settings, checkpoint.settings);
  assert.equal(imported.data.run.wave, checkpoint.run.wave);
  assert.equal(imported.data.run.score, checkpoint.run.score);
  assert.deepEqual(imported.data.run.towers, checkpoint.run.towers);

  // Bad JSON inputs must never throw
  for (const bad of ['', '{not json', '{}', '{"format":"wrong"}', '{"version":99,"run":{"towers":[]}}', '{"run":{"towers":[{"col":99,"row":0,"lineageId":"ballista","tier":1}]}}']) {
    const res = importBlueprintJson(bad);
    assert.equal(res.ok, false);
    assert.equal(res.data, null);
    assert.equal(typeof res.error, 'string');
  }

  // Headless global defaults work without throwing
  const headless = new RunPersistence();
  assert.ok(headless);
});

test('6. Revision conflict resolution, rich tie-breaking, and tamper fallback recovery', async () => {
  const localStorage = createMockLocalStorage();
  const indexedDB = createMockIndexedDB();
  const cookieDoc = createMockCookieDocument();

  // Case A: Cookie has higher rev than stale LocalStorage -> cookie wins & heals LS + IDB
  const stale = buildEndgameCheckpoint(5);
  stale.rev = 3;
  stale.updatedAt = 1000;
  localStorage.setItem(STORAGE_KEY_PRIMARY, JSON.stringify(stale));

  const newer = buildEndgameCheckpoint(15);
  newer.rev = 10;
  newer.updatedAt = 2000;
  const cookieWrite = writeCookieVault(newer, cookieDoc);
  assert.ok(cookieWrite.bytes < 700, `Expected 15-tower cookie < 700 bytes, got ${cookieWrite.bytes}`);

  const p1 = new RunPersistence({ localStorage, indexedDB, cookieDoc });
  const resA = await p1.bootAndHeal();
  assert.equal(resA.source, 'cookieVault');
  assert.deepEqual(resA.healedLayers.sort(), ['indexedDB', 'localStorage']);
  assert.equal(resA.state.rev, 10);
  assert.equal(resA.state.run.towers.length, 15);

  // Case B: Rev tie -> richer primary (LocalStorage) beats Cookie even with newer cookie updatedAt
  const richPrimary = buildEndgameCheckpoint(12);
  richPrimary.rev = 20;
  richPrimary.updatedAt = 5000;
  richPrimary.run.score = 777777;
  richPrimary.run.towers[0].totalDamage = 999999;
  localStorage.setItem(STORAGE_KEY_PRIMARY, JSON.stringify(richPrimary));
  writeCookieVault({ ...richPrimary, updatedAt: 6000 }, cookieDoc);

  const p2 = new RunPersistence({ localStorage, indexedDB, cookieDoc });
  const resB = await p2.bootAndHeal();
  assert.equal(resB.source, 'localStorage');
  assert.equal(resB.state.run.score, 777777);
  assert.equal(resB.state.run.towers[0].totalDamage, 999999);

  // Case C: Corrupted cookie + missing LocalStorage heals both from IndexedDB
  localStorage.clear();
  cookieDoc.cookie = `${COOKIE_VAULT_NAME}=v1.99.zzz.CORRUPTED`;
  const resC = await new RunPersistence({ localStorage, indexedDB, cookieDoc }).bootAndHeal();
  assert.equal(resC.source, 'indexedDB');
  assert.deepEqual(resC.healedLayers.sort(), ['cookieVault', 'localStorage']);
  assert.ok(readCookieVault(cookieDoc)?.ok);

  // Case D: All 3 stores wiped -> reconcileIfTampered(fallbackSnapshot) restores all 3
  localStorage.clear();
  indexedDB._wipeAll();
  clearCookieVault(cookieDoc);
  const fallback = buildEndgameCheckpoint(80);
  const p3 = new RunPersistence({ localStorage, indexedDB, cookieDoc });
  const resD = await p3.reconcileIfTampered(fallback);
  assert.equal(resD.healed, true);
  assert.equal(resD.source, 'fallback');
  assert.deepEqual(resD.healedLayers.sort(), ['cookieVault', 'indexedDB', 'localStorage']);
  assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEY_PRIMARY)).run.towers.length, 80);
  assert.equal(indexedDB._getRaw().run.towers.length, 80);
  assert.equal(readCookieVault(cookieDoc).data.run.towers.length, 80);

  // Case E: Headless RunPersistence with no stores returns clean empty state
  const emptyPersistence = new RunPersistence({
    localStorage: null,
    indexedDB: null,
    cookieDoc: null,
  });
  const emptyBoot = await emptyPersistence.bootAndHeal();
  assert.deepEqual(emptyBoot, { state: null, source: null, healedLayers: [] });
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

if (failed > 0) {
  process.exit(1);
}
console.log(`All ${tests.length} vault-cartridge tests passed.`);
