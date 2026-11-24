import { COOKIE_VAULT_MAX_BYTES, COOKIE_VAULT_NAME } from '../contracts/types.js';
import { decodeCartridge, encodeCartridge } from './maze-cartridge.js';

const TEXT_ENCODER = new TextEncoder();
const VAULT_TOKEN_VERSION = 'v1';
const COOKIE_MAX_AGE_SEC = 31536000;

function readRawCookieHeader(cookieDoc) {
  if (!cookieDoc) return '';
  try {
    if (typeof cookieDoc.get === 'function') {
      const value = cookieDoc.get();
      return typeof value === 'string' ? value : '';
    }
    if (typeof cookieDoc.cookie === 'string') {
      return cookieDoc.cookie;
    }
  } catch {
    return '';
  }
  return '';
}

function writeRawCookieHeader(cookieDoc, cookieString) {
  if (!cookieDoc || typeof cookieDoc !== 'object') return false;
  try {
    if (typeof cookieDoc.set === 'function') {
      cookieDoc.set(cookieString);
      return true;
    }
    cookieDoc.cookie = cookieString;
    return true;
  } catch {
    return false;
  }
}

function extractCookieValue(rawCookieHeader, name) {
  if (typeof rawCookieHeader !== 'string' || !rawCookieHeader) return null;
  const segments = rawCookieHeader.split(';');
  let found = false;
  let value = '';

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const eqIdx = seg.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = seg.slice(0, eqIdx).trim();
    if (key === name) {
      found = true;
      value = seg.slice(eqIdx + 1).trim();
    }
  }

  if (!found || value.length === 0) return null;
  return value;
}

/**
 * Serializes a checkpoint snapshot into `v1.<rev>.<updatedAt36>.<payload>`,
 * asserts the full cookie string fits within `COOKIE_VAULT_MAX_BYTES`, and writes
 * it to the provided `document` or `{ get(), set(str) }` cookie accessor.
 */
export function writeCookieVault(snapshot, cookieDoc = globalThis.document) {
  const rev = Number.isFinite(Number(snapshot?.rev))
    ? Math.max(0, Math.floor(Number(snapshot.rev)))
    : 0;
  const rawUpdatedAt = Number(snapshot?.updatedAt);
  const updatedAt =
    Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
      ? Math.floor(rawUpdatedAt)
      : Date.now();
  const updatedAt36 = updatedAt.toString(36);
  const payload = encodeCartridge(snapshot);
  const token = `${VAULT_TOKEN_VERSION}.${rev}.${updatedAt36}.${payload}`;
  const cookieString = `${COOKIE_VAULT_NAME}=${token}; SameSite=Lax; path=./; max-age=${COOKIE_MAX_AGE_SEC}`;

  const byteLength = TEXT_ENCODER.encode(cookieString).length;
  if (byteLength > COOKIE_VAULT_MAX_BYTES) {
    throw new Error(
      `${COOKIE_VAULT_NAME} exceeded COOKIE_VAULT_MAX_BYTES (${byteLength} > ${COOKIE_VAULT_MAX_BYTES})`,
    );
  }

  const written = writeRawCookieHeader(cookieDoc, cookieString);
  return {
    ok: written,
    bytes: byteLength,
    rev,
    updatedAt,
    token,
    cookieString,
  };
}

/**
 * Reads and verifies `krunked-cookie-vault-v1` via `decodeCartridge`.
 * Returns `{ ok, rev, updatedAt, data, error? }`, or `null` when absent/empty.
 */
export function readCookieVault(cookieDoc = globalThis.document) {
  const rawHeader = readRawCookieHeader(cookieDoc);
  const token = extractCookieValue(rawHeader, COOKIE_VAULT_NAME);
  if (token === null) return null;

  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VAULT_TOKEN_VERSION) {
    return {
      ok: false,
      rev: 0,
      updatedAt: 0,
      data: null,
      error: 'Malformed cookie vault token header',
    };
  }

  const [, revStr, updatedAt36, payload] = parts;
  if (!/^\d+$/.test(revStr) || !/^[0-9a-z]+$/i.test(updatedAt36) || !payload) {
    return {
      ok: false,
      rev: 0,
      updatedAt: 0,
      data: null,
      error: 'Malformed cookie vault metadata',
    };
  }

  const rev = Number(revStr);
  const updatedAt = parseInt(updatedAt36, 36);
  if (!Number.isSafeInteger(rev) || !Number.isSafeInteger(updatedAt)) {
    return {
      ok: false,
      rev: 0,
      updatedAt: 0,
      data: null,
      error: 'Invalid cookie vault revision or timestamp',
    };
  }

  const decoded = decodeCartridge(payload);
  if (!decoded.ok || !decoded.data) {
    return {
      ok: false,
      rev,
      updatedAt,
      data: null,
      error: decoded.error || 'Failed to decode cookie vault cartridge',
    };
  }

  decoded.data.rev = rev;
  decoded.data.updatedAt = updatedAt;

  return {
    ok: true,
    rev,
    updatedAt,
    data: decoded.data,
  };
}

/**
 * Expires `krunked-cookie-vault-v1` immediately using relative `path=./`.
 */
export function clearCookieVault(cookieDoc = globalThis.document) {
  const cookieString = `${COOKIE_VAULT_NAME}=; SameSite=Lax; path=./; max-age=0`;
  return writeRawCookieHeader(cookieDoc, cookieString);
}
