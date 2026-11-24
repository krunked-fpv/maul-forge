import {
  CARTRIDGE_MAGIC_VERSION,
  IDB_DB_NAME,
  IDB_STORE_NAME,
  STORAGE_KEY_PRIMARY,
} from '../contracts/types.js';
import { readCookieVault, writeCookieVault } from './cookie-vault.js';
import { normalizeCheckpoint } from './maze-cartridge.js';

function getSafeGlobal(name) {
  try {
    return globalThis[name] ?? null;
  } catch {
    return null;
  }
}

function isValidStoredPayload(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.version !== undefined && obj.version !== CARTRIDGE_MAGIC_VERSION) return false;
  return (
    obj.rev !== undefined ||
    obj.updatedAt !== undefined ||
    obj.highScore !== undefined ||
    obj.bestWave !== undefined ||
    obj.settings !== undefined ||
    obj.run !== undefined
  );
}

function clonePlain(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fallback to JSON deep clone below
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function isCandidateBetter(a, b) {
  if (!b) return true;
  if (a.state.rev !== b.state.rev) {
    return a.state.rev > b.state.rev;
  }
  if (a.state.rev > 0) {
    if (a.isPrimary !== b.isPrimary) {
      return a.isPrimary;
    }
    if (a.state.updatedAt !== b.state.updatedAt) {
      return a.state.updatedAt > b.state.updatedAt;
    }
  } else {
    if (a.state.updatedAt !== b.state.updatedAt) {
      return a.state.updatedAt > b.state.updatedAt;
    }
    if (a.isPrimary !== b.isPrimary) {
      return a.isPrimary;
    }
  }

  const aScore =
    (a.state.run ? 1 : 0) +
    (a.state.run?.towers?.length || 0) +
    (a.state.highScore > 0 ? 1 : 0);
  const bScore =
    (b.state.run ? 1 : 0) +
    (b.state.run?.towers?.length || 0) +
    (b.state.highScore > 0 ? 1 : 0);
  if (aScore !== bScore) return aScore > bScore;

  return a.source === 'localStorage' && b.source !== 'localStorage';
}

function needsPrimaryHeal(layerState, winner) {
  if (!layerState) return true;
  if (layerState.rev < winner.state.rev) return true;
  if (layerState.rev === winner.state.rev && layerState.updatedAt < winner.state.updatedAt) {
    return true;
  }
  if (winner.source === 'cookieVault') {
    return false;
  }
  if (layerState.rev === winner.state.rev && layerState.updatedAt === winner.state.updatedAt) {
    const aHasRun = Boolean(layerState.run);
    const bHasRun = Boolean(winner.state.run);
    if (aHasRun !== bHasRun) return true;
    if (
      layerState.highScore !== winner.state.highScore ||
      layerState.bestWave !== winner.state.bestWave ||
      (layerState.run?.wave ?? 0) !== (winner.state.run?.wave ?? 0) ||
      (layerState.run?.towers?.length ?? 0) !== (winner.state.run?.towers?.length ?? 0)
    ) {
      return true;
    }
  }
  return false;
}

function needsCookieHeal(cookieRes, winner) {
  if (!cookieRes || !cookieRes.ok || !cookieRes.data) return true;
  if (cookieRes.rev < winner.state.rev) return true;
  if (cookieRes.rev === winner.state.rev && cookieRes.updatedAt < winner.state.updatedAt) {
    return true;
  }
  if (
    cookieRes.data.highScore !== winner.state.highScore ||
    cookieRes.data.bestWave !== winner.state.bestWave ||
    Boolean(cookieRes.data.run) !== Boolean(winner.state.run) ||
    (cookieRes.data.run?.wave ?? 0) !== (winner.state.run?.wave ?? 0) ||
    (cookieRes.data.run?.towers?.length ?? 0) !== (winner.state.run?.towers?.length ?? 0)
  ) {
    return true;
  }
  return false;
}

/**
 * Three-layer persistence & bidirectional self-healing coordinator across
 * LocalStorage, IndexedDB, and `krunked-cookie-vault-v1`.
 */
export class RunPersistence {
  constructor(env = {}) {
    this.localStorage = 'localStorage' in env ? env.localStorage : getSafeGlobal('localStorage');
    this.indexedDB = 'indexedDB' in env ? env.indexedDB : getSafeGlobal('indexedDB');
    this.cookieDoc = 'cookieDoc' in env ? env.cookieDoc : getSafeGlobal('document');
    this._lastRev = 0;
    this._lastState = null;
  }

  _readLocalStorage() {
    if (!this.localStorage || typeof this.localStorage.getItem !== 'function') return null;
    try {
      const raw = this.localStorage.getItem(STORAGE_KEY_PRIMARY);
      if (typeof raw !== 'string' || !raw.trim()) return null;
      const parsed = JSON.parse(raw);
      if (!isValidStoredPayload(parsed)) return null;
      return normalizeCheckpoint(parsed);
    } catch {
      return null;
    }
  }

  _writeLocalStorage(state) {
    if (!this.localStorage || typeof this.localStorage.setItem !== 'function') return false;
    try {
      this.localStorage.setItem(STORAGE_KEY_PRIMARY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  }

  async _openIdb() {
    if (!this.indexedDB || typeof this.indexedDB.open !== 'function') return null;
    return new Promise((resolve) => {
      try {
        const req = this.indexedDB.open(IDB_DB_NAME, 1);
        if (!req) {
          resolve(null);
          return;
        }
        let settled = false;
        const finish = (db) => {
          if (settled) return;
          settled = true;
          resolve(db || null);
        };
        req.onupgradeneeded = (ev) => {
          const db = ev?.target?.result ?? req.result;
          if (db && db.objectStoreNames && !db.objectStoreNames.contains(IDB_STORE_NAME)) {
            db.createObjectStore(IDB_STORE_NAME);
          }
        };
        req.onsuccess = (ev) => finish(ev?.target?.result ?? req.result);
        req.onerror = () => finish(null);
        req.onblocked = () => finish(null);
        if (req.readyState === 'done') {
          finish(req.result);
        }
      } catch {
        resolve(null);
      }
    });
  }

  async _readIndexedDB() {
    if (!this.indexedDB) return null;

    if (typeof this.indexedDB.open !== 'function' && typeof this.indexedDB.get === 'function') {
      try {
        const raw = await this.indexedDB.get(STORAGE_KEY_PRIMARY);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!isValidStoredPayload(parsed)) return null;
        return normalizeCheckpoint(parsed);
      } catch {
        return null;
      }
    }

    const db = await this._openIdb();
    if (!db) return null;

    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        try {
          db.close?.();
        } catch {
          // Ignore close errors
        }
        resolve(val);
      };

      try {
        const tx = db.transaction(IDB_STORE_NAME, 'readonly');
        const store = tx.objectStore(IDB_STORE_NAME);
        const req = store.get(STORAGE_KEY_PRIMARY);

        const handleResult = (raw) => {
          try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!isValidStoredPayload(parsed)) {
              done(null);
              return;
            }
            done(normalizeCheckpoint(parsed));
          } catch {
            done(null);
          }
        };

        req.onsuccess = (ev) => handleResult(ev?.target?.result ?? req.result);
        req.onerror = () => done(null);
        tx.onerror = () => done(null);
        tx.onabort = () => done(null);

        if (req.readyState === 'done') {
          handleResult(req.result);
        }
      } catch {
        done(null);
      }
    });
  }

  async _writeIndexedDB(state) {
    if (!this.indexedDB) return false;

    if (typeof this.indexedDB.open !== 'function' && typeof this.indexedDB.put === 'function') {
      try {
        await this.indexedDB.put(clonePlain(state), STORAGE_KEY_PRIMARY);
        return true;
      } catch {
        return false;
      }
    }

    const db = await this._openIdb();
    if (!db) return false;

    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        try {
          db.close?.();
        } catch {
          // Ignore close errors
        }
        resolve(ok);
      };

      try {
        const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
        const store = tx.objectStore(IDB_STORE_NAME);
        const req = store.put(clonePlain(state), STORAGE_KEY_PRIMARY);
        const isNativeIdbTx =
          typeof IDBTransaction !== 'undefined' && tx instanceof IDBTransaction;

        tx.oncomplete = () => done(true);
        tx.onerror = () => done(false);
        tx.onabort = () => done(false);
        req.onerror = () => done(false);
        req.onsuccess = () => {
          if (!isNativeIdbTx) {
            done(true);
          }
        };

        if (req.readyState === 'done' && !isNativeIdbTx) {
          done(true);
        }
      } catch {
        done(false);
      }
    });
  }

  _writeCookieLayer(state) {
    if (!this.cookieDoc) return false;
    try {
      const res = writeCookieVault(state, this.cookieDoc);
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  }

  async _readAllLayers() {
    const lsState = this._readLocalStorage();
    const idbState = await this._readIndexedDB();
    const cookieRes = this.cookieDoc ? readCookieVault(this.cookieDoc) : null;
    const cookieState = cookieRes && cookieRes.ok && cookieRes.data ? cookieRes.data : null;

    return { lsState, idbState, cookieRes, cookieState };
  }

  _selectWinner({ lsState, idbState, cookieState }) {
    const candidates = [];
    if (lsState) candidates.push({ source: 'localStorage', state: lsState, isPrimary: true });
    if (idbState) candidates.push({ source: 'indexedDB', state: idbState, isPrimary: true });
    if (cookieState) candidates.push({ source: 'cookieVault', state: cookieState, isPrimary: false });

    let winner = null;
    for (let i = 0; i < candidates.length; i++) {
      if (isCandidateBetter(candidates[i], winner)) {
        winner = candidates[i];
      }
    }
    return winner;
  }

  async _healMissingOrStale(winner, layers) {
    const healedLayers = [];
    const { lsState, idbState, cookieRes } = layers;

    if (this.localStorage && needsPrimaryHeal(lsState, winner)) {
      if (this._writeLocalStorage(winner.state)) {
        healedLayers.push('localStorage');
      }
    }

    if (this.indexedDB && needsPrimaryHeal(idbState, winner)) {
      if (await this._writeIndexedDB(winner.state)) {
        healedLayers.push('indexedDB');
      }
    }

    if (this.cookieDoc && needsCookieHeal(cookieRes, winner)) {
      if (this._writeCookieLayer(winner.state)) {
        healedLayers.push('cookieVault');
      }
    }

    return healedLayers;
  }

  /**
   * Reads all 3 layers, selects the highest-revision / freshest valid state
   * (preferring richer primary fields on revision ties), and heals missing,
   * corrupted, or stale stores bidirectionally.
   */
  async bootAndHeal() {
    const layers = await this._readAllLayers();
    const winner = this._selectWinner(layers);

    if (!winner) {
      return { state: null, source: null, healedLayers: [] };
    }

    const healedLayers = await this._healMissingOrStale(winner, layers);
    this._lastRev = Math.max(this._lastRev, winner.state.rev);
    this._lastState = clonePlain(winner.state);

    return {
      state: clonePlain(winner.state),
      source: winner.source,
      healedLayers,
    };
  }

  async _getCurrentMaxRev() {
    let maxRev = this._lastRev;
    const lsState = this._readLocalStorage();
    if (lsState && lsState.rev > maxRev) maxRev = lsState.rev;
    if (this.cookieDoc) {
      const cookieRes = readCookieVault(this.cookieDoc);
      if (cookieRes && cookieRes.ok && cookieRes.rev > maxRev) {
        maxRev = cookieRes.rev;
      }
    }
    if (this._lastRev === 0 && this.indexedDB) {
      const idbState = await this._readIndexedDB();
      if (idbState && idbState.rev > maxRev) maxRev = idbState.rev;
    }
    return maxRev;
  }

  /**
   * Increments `rev`, stamps `updatedAt`, and persists to LocalStorage,
   * IndexedDB, and `krunked-cookie-vault-v1`.
   */
  async saveState(snapshot) {
    const normalized = normalizeCheckpoint(snapshot);
    const incomingRev = Number.isFinite(Number(snapshot?.rev)) ? Number(snapshot.rev) : 0;
    const baseRev = await this._getCurrentMaxRev();
    const nextRev = Math.max(baseRev, incomingRev) + 1;
    const updatedAt = Date.now();

    const hasMetaHighScore = snapshot && typeof snapshot.highScore === 'number';
    const hasMetaBestWave = snapshot && typeof snapshot.bestWave === 'number';
    const hasSettings = snapshot && snapshot.settings && typeof snapshot.settings === 'object';

    const stateToSave = {
      version: CARTRIDGE_MAGIC_VERSION,
      rev: nextRev,
      updatedAt,
      highScore: hasMetaHighScore
        ? normalized.highScore
        : this._lastState?.highScore ?? normalized.highScore,
      bestWave: hasMetaBestWave
        ? normalized.bestWave
        : this._lastState?.bestWave ?? normalized.bestWave,
      settings: hasSettings
        ? normalized.settings
        : this._lastState?.settings ?? normalized.settings,
      run: normalized.run,
    };

    this._writeLocalStorage(stateToSave);
    await this._writeIndexedDB(stateToSave);
    this._writeCookieLayer(stateToSave);

    this._lastRev = nextRev;
    this._lastState = clonePlain(stateToSave);

    return clonePlain(stateToSave);
  }

  /**
   * Checks all live stores for missing, corrupted, or stale layers and repairs them
   * immediately from the freshest surviving store or `fallbackSnapshot`.
   */
  async reconcileIfTampered(fallbackSnapshot = null) {
    const layers = await this._readAllLayers();
    let winner = this._selectWinner(layers);

    if (!winner) {
      const fallback = fallbackSnapshot
        ? normalizeCheckpoint(fallbackSnapshot)
        : this._lastState
          ? clonePlain(this._lastState)
          : null;

      if (!fallback) {
        return { healed: false, source: null, state: null, healedLayers: [] };
      }

      if (fallback.rev <= 0) {
        fallback.rev = Math.max(this._lastRev, 0) + 1;
      }
      if (!fallback.updatedAt) {
        fallback.updatedAt = Date.now();
      }

      winner = {
        source: fallbackSnapshot ? 'fallback' : 'memory',
        state: fallback,
        isPrimary: true,
      };
    }

    const healedLayers = await this._healMissingOrStale(winner, layers);
    this._lastRev = Math.max(this._lastRev, winner.state.rev);
    this._lastState = clonePlain(winner.state);

    return {
      healed: healedLayers.length > 0,
      source: winner.source,
      state: clonePlain(winner.state),
      healedLayers,
    };
  }

  /**
   * Clears active run checkpoint while preserving `highScore`, `bestWave`,
   * and `settings` across all 3 persistence layers.
   */
  async clearRunOnly() {
    const layers = await this._readAllLayers();
    const winner = this._selectWinner(layers);
    const baseState = winner?.state ?? this._lastState ?? normalizeCheckpoint({});

    const nextRev = Math.max(this._lastRev, baseState.rev || 0) + 1;
    const clearedState = {
      version: CARTRIDGE_MAGIC_VERSION,
      rev: nextRev,
      updatedAt: Date.now(),
      highScore: baseState.highScore ?? 0,
      bestWave: baseState.bestWave ?? 0,
      settings: clonePlain(baseState.settings ?? normalizeCheckpoint({}).settings),
      run: null,
    };

    this._writeLocalStorage(clearedState);
    await this._writeIndexedDB(clearedState);
    this._writeCookieLayer(clearedState);

    this._lastRev = nextRev;
    this._lastState = clonePlain(clearedState);

    return clonePlain(clearedState);
  }
}
