#!/usr/bin/env node
/**
 * Static PWA, Binary PNG, Subpath-Safety, and CI Workflow Validator
 * Usage:
 *   node scripts/validate-static-pwa.mjs           # Default mode (existing files + required PWA/CI assets)
 *   node scripts/validate-static-pwa.mjs --strict  # Strict CI mode (requires index.html, styles/hud.css, src/main.js)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const STRICT_MODE = args.has('--strict');

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'tmp',
  '_site',
  '.scratch',
  '.worktrees',
  'scripts',
  'tests',
  '.agents',
]);

const SCAN_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json']);

// IEEE 802.3 CRC32 table for verifying PNG chunk integrity
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const errors = [];
const passes = [];
const infos = [];

function fail(msg) {
  errors.push(msg);
}

function pass(msg) {
  passes.push(msg);
}

function info(msg) {
  infos.push(msg);
}

function resolveRepoPath(relPath) {
  return path.join(ROOT_DIR, ...relPath.split('/'));
}

function readTextIfExists(relPath) {
  const fullPath = resolveRepoPath(relPath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.readFileSync(fullPath, 'utf8');
}

function validatePng(relPath, expectedWidth, expectedHeight) {
  const fullPath = resolveRepoPath(relPath);
  if (!fs.existsSync(fullPath)) {
    fail(`Missing PNG asset: ${relPath}`);
    return;
  }

  const buf = fs.readFileSync(fullPath);
  if (buf.length < 33) {
    fail(`${relPath}: file too small (${buf.length} bytes) to be a valid PNG`);
    return;
  }

  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (buf[i] !== PNG_MAGIC[i]) {
      fail(`${relPath}: invalid PNG signature byte at index ${i} (got 0x${buf[i].toString(16)})`);
      return;
    }
  }

  const ihdrLen = buf.readUInt32BE(8);
  const ihdrType = buf.subarray(12, 16).toString('ascii');
  if (ihdrType !== 'IHDR' || ihdrLen !== 13) {
    fail(`${relPath}: expected 13-byte IHDR chunk first, got ${ihdrType} (${ihdrLen} bytes)`);
    return;
  }

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (width !== expectedWidth || height !== expectedHeight) {
    fail(`${relPath}: expected dimensions ${expectedWidth}x${expectedHeight}, got ${width}x${height}`);
    return;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    fail(`${relPath}: expected 8-bit RGBA PNG (depth=8, colorType=6), got depth=${bitDepth}, colorType=${colorType}`);
    return;
  }

  // Walk every PNG chunk and verify CRC32 + IDAT decompression + IEND termination
  let offset = 8;
  const idatChunks = [];
  let sawIend = false;
  while (offset + 12 <= buf.length) {
    const chunkLen = buf.readUInt32BE(offset);
    const chunkType = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    if (dataEnd + 4 > buf.length) {
      fail(`${relPath}: truncated ${chunkType} chunk at offset ${offset}`);
      return;
    }
    const expectedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(offset + 4, dataEnd));
    if (expectedCrc !== actualCrc) {
      fail(`${relPath}: CRC mismatch in chunk ${chunkType} (expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)})`);
      return;
    }
    if (chunkType === 'IDAT') {
      idatChunks.push(buf.subarray(dataStart, dataEnd));
    } else if (chunkType === 'IEND') {
      sawIend = true;
      offset = dataEnd + 4;
      break;
    }
    offset = dataEnd + 4;
  }

  if (!sawIend || idatChunks.length === 0) {
    fail(`${relPath}: missing required IDAT or IEND chunk`);
    return;
  }
  if (offset !== buf.length) {
    fail(`${relPath}: unexpected trailing bytes after IEND (${buf.length - offset} bytes)`);
    return;
  }

  try {
    const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
    const expectedRawLen = (expectedWidth * 4 + 1) * expectedHeight;
    if (inflated.length !== expectedRawLen) {
      fail(`${relPath}: inflated scanline length mismatch (expected ${expectedRawLen}, got ${inflated.length})`);
      return;
    }
  } catch (err) {
    fail(`${relPath}: IDAT zlib decompression failed: ${err.message}`);
    return;
  }

  pass(`${relPath} verified (${width}x${height} 8-bit RGBA PNG, ${buf.length} bytes, valid CRCs & IDAT)`);
}

function validateManifest() {
  const raw = readTextIfExists('manifest.json');
  if (raw === null) {
    fail('Missing manifest.json');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    fail(`manifest.json: invalid JSON (${err.message})`);
    return;
  }

  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    fail('manifest.json: missing non-empty "name"');
  }
  if (typeof manifest.short_name !== 'string' || !manifest.short_name.trim()) {
    fail('manifest.json: missing non-empty "short_name"');
  }
  if (manifest.start_url !== './') {
    fail(`manifest.json: "start_url" must be "./", got ${JSON.stringify(manifest.start_url)}`);
  }
  if (manifest.scope !== './') {
    fail(`manifest.json: "scope" must be "./", got ${JSON.stringify(manifest.scope)}`);
  }
  if (manifest.display !== 'standalone') {
    fail(`manifest.json: "display" must be "standalone", got ${JSON.stringify(manifest.display)}`);
  }
  if (String(manifest.background_color || '').toLowerCase() !== '#0b0d12') {
    fail(`manifest.json: "background_color" must be "#0b0d12", got ${JSON.stringify(manifest.background_color)}`);
  }
  if (String(manifest.theme_color || '').toLowerCase() !== '#d4a238') {
    fail(`manifest.json: "theme_color" must be "#d4a238", got ${JSON.stringify(manifest.theme_color)}`);
  }

  if (!Array.isArray(manifest.icons) || manifest.icons.length < 2) {
    fail('manifest.json: "icons" must include 192x192 and 512x512 entries');
    return;
  }

  const requiredSizes = new Map([
    ['192x192', './assets/icons/icon-192.png'],
    ['512x512', './assets/icons/icon-512.png'],
  ]);

  for (const icon of manifest.icons) {
    if (!icon || typeof icon.src !== 'string' || !icon.src.startsWith('./')) {
      fail(`manifest.json: icon src must be relative "./...", got ${JSON.stringify(icon?.src)}`);
      continue;
    }
    if (icon.type !== 'image/png') {
      fail(`manifest.json: icon ${icon.src} must have type "image/png"`);
    }
    const targetFile = resolveRepoPath(icon.src.slice(2));
    if (!fs.existsSync(targetFile)) {
      fail(`manifest.json: icon target does not exist: ${icon.src}`);
    }
    if (requiredSizes.has(icon.sizes)) {
      const expectedSrc = requiredSizes.get(icon.sizes);
      if (icon.src !== expectedSrc) {
        fail(`manifest.json: expected ${icon.sizes} icon src "${expectedSrc}", got "${icon.src}"`);
      }
      if (!String(icon.purpose || '').includes('maskable')) {
        fail(`manifest.json: icon ${icon.src} should include "maskable" in purpose`);
      }
      requiredSizes.delete(icon.sizes);
    }
  }

  for (const [missingSize] of requiredSizes) {
    fail(`manifest.json: missing icon entry for ${missingSize}`);
  }

  if (!errors.some((e) => e.startsWith('manifest.json'))) {
    pass('manifest.json verified (subpath-safe "./" start_url/scope, standalone, theme #d4a238, icons ok)');
  }
}

function validateServiceWorker() {
  const swText = readTextIfExists('sw.js');
  if (swText === null) {
    fail('Missing sw.js');
    return;
  }

  const cacheConstRe = /const\s+MAUL_FORGE_CACHE_V1\s*=\s*['"]maul-forge-v1\.0\.0['"]/;
  if (!cacheConstRe.test(swText)) {
    fail("sw.js: must define const MAUL_FORGE_CACHE_V1 = 'maul-forge-v1.0.0'");
  }

  for (const lifecycle of ['install', 'activate', 'fetch']) {
    const listenerRe = new RegExp(`addEventListener\\s*\\(\\s*['"]${lifecycle}['"]`);
    if (!listenerRe.test(swText)) {
      fail(`sw.js: missing '${lifecycle}' event listener`);
    }
  }

  if (!swText.includes('skipWaiting')) {
    fail('sw.js: install handler should call self.skipWaiting()');
  }
  if (!swText.includes('clients.claim')) {
    fail('sw.js: activate handler should call self.clients.claim()');
  }
  if (!swText.includes('caches.delete')) {
    fail('sw.js: activate handler should prune stale caches with caches.delete()');
  }
  if (!swText.includes('cache.put') && !swText.includes('.put(')) {
    fail('sw.js: fetch handler must update cache with network-first put()');
  }

  if (!errors.some((e) => e.startsWith('sw.js'))) {
    pass('sw.js verified (MAUL_FORGE_CACHE_V1, install/activate/fetch, network-first caching)');
  }
}

function validateWorkflow() {
  const wfPath = '.github/workflows/deploy-pages.yml';
  const wfText = readTextIfExists(wfPath);
  if (wfText === null) {
    fail(`Missing ${wfPath}`);
    return;
  }

  const checks = [
    ['push trigger on main', /\bbranches\s*:\s*(?:\[\s*main\s*\]|[\r\n]+\s*-\s*main\b)/],
    ['workflow_dispatch trigger', /\bworkflow_dispatch\s*:/],
    ['pages write permission', /\bpages\s*:\s*write\b/],
    ['id-token write permission', /\bid-token\s*:\s*write\b/],
    ['pages concurrency group', /\bgroup\s*:\s*pages\b/],
    ['actions/checkout@v4', /actions\/checkout@v4/],
    ['actions/setup-node@v4', /actions\/setup-node@v4/],
    ['Node 22 setup', /node-version\s*:\s*['"]?22['"]?/],
    ['strict PWA validation step', /node\s+scripts\/validate-static-pwa\.mjs\s+--strict/],
    ['actions/upload-pages-artifact@v3', /actions\/upload-pages-artifact@v3/],
    ['actions/deploy-pages@v4', /actions\/deploy-pages@v4/],
  ];

  for (const [label, regex] of checks) {
    if (!regex.test(wfText)) {
      fail(`${wfPath}: missing ${label}`);
    }
  }

  if (!errors.some((e) => e.startsWith(wfPath))) {
    pass(`${wfPath} verified (Pages triggers, permissions, strict validation, tests, deploy)`);
  }
}

function validateShellEntryPoints() {
  const indexHtml = readTextIfExists('index.html');
  if (indexHtml === null) {
    if (STRICT_MODE) {
      fail('index.html: missing required file in --strict mode');
    } else {
      info('index.html not yet present (allowed in default mode; required under --strict)');
    }
  } else {
    if (!/href\s*=\s*["'](?:\.\/)?manifest\.json["']/.test(indexHtml)) {
      fail('index.html: missing relative manifest.json link');
    }
    if (!/href\s*=\s*["'](?:\.\/)?styles\/hud\.css["']/.test(indexHtml)) {
      fail('index.html: missing relative ./styles/hud.css stylesheet link');
    }
    if (!/src\s*=\s*["'](?:\.\/)?src\/main\.js["']/.test(indexHtml)) {
      fail('index.html: missing relative ./src/main.js module script tag');
    }
    pass('index.html verified (relative manifest, stylesheet, and module entry)');
  }

  const hudCss = readTextIfExists('styles/hud.css');
  if (hudCss === null) {
    if (STRICT_MODE) {
      fail('styles/hud.css: missing required file in --strict mode');
    } else {
      info('styles/hud.css not yet present (allowed in default mode; required under --strict)');
    }
  } else if (!hudCss.trim()) {
    fail('styles/hud.css: file is empty');
  } else {
    pass('styles/hud.css present and non-empty');
  }

  const mainJs = readTextIfExists('src/main.js');
  if (mainJs === null) {
    if (STRICT_MODE) {
      fail('src/main.js: missing required file in --strict mode');
    } else {
      info('src/main.js not yet present (allowed in default mode; required under --strict)');
    }
  } else if (!mainJs.trim()) {
    fail('src/main.js: file is empty');
  } else {
    if (/serviceWorker\.register\s*\(\s*['"]\//.test(mainJs)) {
      fail('src/main.js: serviceWorker.register must use relative "./sw.js", never "/..."');
    }
    pass('src/main.js present and non-empty');
  }
}

function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

function stripCssComments(src) {
  let out = '';
  let inQuote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inQuote) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 1;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'case',
  'throw',
  'typeof',
  'void',
  'delete',
  'in',
  'of',
  'await',
  'yield',
  'new',
  'else',
]);

/**
 * Single-pass JS lexer that strips comments, collects string/template literals,
 * and skips regex literals cleanly so quotes inside regexes never desync string tracking.
 */
function analyzeJsSource(src) {
  let out = '';
  const literals = [];
  let i = 0;
  const len = src.length;
  let prevNonSpace = ';';
  let prevIdent = '';

  while (i < len) {
    const ch = src[i];
    const next = src[i + 1];

    // String or template literal
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let lit = '';
      out += ch;
      i += 1;
      while (i < len) {
        const c = src[i];
        out += c;
        if (c === '\\' && i + 1 < len) {
          lit += c + src[i + 1];
          out += src[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        if (c === quote) break;
        lit += c;
      }
      literals.push(lit);
      prevNonSpace = quote;
      prevIdent = '';
      continue;
    }

    // Line comment
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && src[i] !== '\n') i += 1;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }

    // Potential regex literal after expression prefix token or keyword
    if (
      ch === '/' &&
      ('=(,[!:&|?;{}\n~^'.includes(prevNonSpace) || REGEX_PREFIX_KEYWORDS.has(prevIdent))
    ) {
      out += ch;
      i += 1;
      let inCharClass = false;
      while (i < len) {
        const c = src[i];
        out += c;
        if (c === '\\' && i + 1 < len) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        if (c === '[') inCharClass = true;
        else if (c === ']') inCharClass = false;
        else if (c === '/' && !inCharClass) {
          i += 1;
          break;
        } else if (c === '\n') {
          i += 1;
          break;
        }
        i += 1;
      }
      prevNonSpace = '/';
      prevIdent = '';
      continue;
    }

    out += ch;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      prevIdent += ch;
      prevNonSpace = ch;
    } else if (!/\s/.test(ch)) {
      prevNonSpace = ch;
      prevIdent = '';
    }
    i += 1;
  }

  return { clean: out, literals };
}

function collectRuntimeFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeFiles(fullPath, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCAN_EXTENSIONS.has(ext)) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

function findExternalUrls(text) {
  const matches = text.match(/https?:\/\/[^\s"'`)<>]+/gi) || [];
  // Allow standard W3C XML namespaces if inline SVG is used
  return matches.filter((u) => !/^https?:\/\/www\.w3\.org\//i.test(u));
}

function scanSubpathAndCdnLeaks() {
  const files = collectRuntimeFiles(ROOT_DIR);

  const htmlRootLeakRe = /\b(?:href|src|action|poster|content)\s*=\s*["']\s*\//gi;
  const htmlProtocolRelRe = /\b(?:href|src|action|poster)\s*=\s*["']\s*\/\//gi;
  const cssUrlLeakRe = /url\(\s*["']?\s*\//gi;
  const cssImportLeakRe = /@import\s+["']\s*\//gi;

  const jsRootLeakChecks = [
    ['HTML attribute root path', /\b(?:href|src)\s*=\s*["'`]\s*\//gi],
    ['CSS url(/ root path', /\burl\(\s*["'`]?\s*\//gi],
    ['ServiceWorker register("/', /\bregister\(\s*["'`]\s*\//gi],
    ['ServiceWorker scope: "/', /\bscope\s*:\s*["'`]\s*\//gi],
    ['ES module static import "/', /(?:^|[\s;])(?:import|from)\s+["'`]\s*\//gm],
    ['ES module dynamic import("/', /\bimport\(\s*["'`]\s*\//gi],
    ['fetch("/ root path', /\bfetch\(\s*["'`]\s*\//gi],
    ['caches.match("/ root path', /\bcaches\.match\(\s*["'`]\s*\//gi],
  ];

  let scannedCount = 0;

  for (const fullPath of files) {
    const relPath = path.relative(ROOT_DIR, fullPath).replaceAll('\\', '/');
    const ext = path.extname(fullPath).toLowerCase();
    const raw = fs.readFileSync(fullPath, 'utf8');
    scannedCount += 1;

    if (ext === '.html') {
      const clean = stripHtmlComments(raw);
      for (const m of clean.match(htmlRootLeakRe) || []) {
        fail(`${relPath}: root-domain "/" path leak detected (${m.trim()})`);
      }
      for (const m of clean.match(htmlProtocolRelRe) || []) {
        fail(`${relPath}: protocol-relative "//" external link detected (${m.trim()})`);
      }
      for (const m of clean.match(cssUrlLeakRe) || []) {
        fail(`${relPath}: CSS url(/ root-domain leak detected (${m.trim()})`);
      }
      for (const url of findExternalUrls(clean)) {
        fail(`${relPath}: external URL detected (${url})`);
      }
    } else if (ext === '.css') {
      const clean = stripCssComments(raw);
      for (const m of clean.match(cssUrlLeakRe) || []) {
        fail(`${relPath}: root-domain "/" url() leak detected (${m.trim()})`);
      }
      for (const m of clean.match(cssImportLeakRe) || []) {
        fail(`${relPath}: root-domain "/" @import leak detected (${m.trim()})`);
      }
      for (const url of findExternalUrls(clean)) {
        fail(`${relPath}: external URL detected (${url})`);
      }
    } else if (ext === '.js' || ext === '.mjs') {
      const { clean, literals } = analyzeJsSource(raw);
      for (const [label, regex] of jsRootLeakChecks) {
        const matches = clean.match(regex);
        if (matches) {
          fail(`${relPath}: ${label} leak detected (${matches[0].trim()})`);
        }
      }
      for (const lit of literals) {
        if (/\bpath=\/(?!\.)/i.test(lit)) {
          fail(`${relPath}: cookie path=/ leak detected inside string literal (must use path=./)`);
        }
        for (const url of findExternalUrls(lit)) {
          fail(`${relPath}: external URL detected in string literal (${url})`);
        }
      }
    } else if (ext === '.json') {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        fail(`${relPath}: invalid JSON (${err.message})`);
        continue;
      }
      const visitJson = (node, keyPath) => {
        if (typeof node === 'string') {
          if (node.startsWith('/')) {
            fail(`${relPath} (${keyPath}): root-domain "/" path leak (${node})`);
          }
          for (const url of findExternalUrls(node)) {
            fail(`${relPath} (${keyPath}): external URL detected (${url})`);
          }
        } else if (Array.isArray(node)) {
          node.forEach((item, idx) => visitJson(item, `${keyPath}[${idx}]`));
        } else if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            visitJson(v, keyPath ? `${keyPath}.${k}` : k);
          }
        }
      };
      visitJson(parsed, '');
    }
  }

  pass(`Subpath & zero-CDN scan completed cleanly across ${scannedCount} runtime files`);
}

validatePng('assets/icons/icon-192.png', 192, 192);
validatePng('assets/icons/icon-512.png', 512, 512);
validateManifest();
validateServiceWorker();
validateWorkflow();
validateShellEntryPoints();
scanSubpathAndCdnLeaks();

console.log(`=== Maul-Forge Static PWA Validator (${STRICT_MODE ? 'STRICT' : 'DEFAULT'} mode) ===`);
for (const p of passes) console.log(`[PASS] ${p}`);
for (const i of infos) console.log(`[INFO] ${i}`);
for (const e of errors) console.error(`[FAIL] ${e}`);

if (errors.length > 0) {
  console.error(`\nValidation failed with ${errors.length} error(s).`);
  process.exit(1);
}

console.log('\nAll static PWA checks passed!');
process.exit(0);
