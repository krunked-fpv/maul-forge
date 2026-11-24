import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  BASE_TOWER_IDS,
  BUILDER_MODES,
  CARTRIDGE_HASH_PREFIX,
  COOKIE_VAULT_NAME,
  CREEP_ARCHETYPE_IDS,
  FUSION_TOWER_IDS,
  GRID_COLS,
  IDB_DB_NAME,
  IDB_STORE_NAME,
  MAX_PARTICLES,
  SIM_DT,
  SIM_EVENTS,
  STORAGE_KEY_PRIMARY,
  TARGET_PRIORITIES,
  VOICE_POOL_LIMIT,
} from '../src/contracts/types.js';
import { GameSim } from '../src/engine/ecs-sim.js';
import { ViewportCamera } from '../src/render/viewport-camera.js';
import { TerrainRenderer } from '../src/render/terrain-decals.js';
import { TowerRigRenderer } from '../src/render/tower-rigs.js';
import { BuilderRigRenderer } from '../src/render/builder-rig.js';
import { CreepRigRenderer } from '../src/render/creep-rigs.js';
import { StatusOverlayRenderer } from '../src/render/status-overlays.js';
import { ProjectileVfxRenderer } from '../src/render/projectiles-vfx.js';
import { RagdollParticleSystem } from '../src/render/ragdoll-particles.js';
import { PostFxCompositor } from '../src/render/postfx-webgl.js';
import { SoundDirector } from '../src/audio/sound-director.js';
import { clearCookieVault, readCookieVault } from '../src/storage/cookie-vault.js';
import { buildCartridgeHash, decodeCartridge } from '../src/storage/maze-cartridge.js';
import { RunPersistence } from '../src/storage/run-persistence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SERVE_ROOT = fs.existsSync(path.join(process.cwd(), 'index.html'))
  ? path.resolve(process.cwd())
  : REPO_ROOT;

const SUBPATH_PREFIX = '/maul-forge';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});

function createSubpathServer(rootDir = SERVE_ROOT) {
  const resolvedRoot = path.resolve(rootDir);

  return http.createServer((req, res) => {
    const sendText = (statusCode, body, extraHeaders = {}) => {
      res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders,
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(405, 'Method Not Allowed');
      return;
    }

    const rawUrl = req.url || '/';
    const rawPathname = rawUrl.split(/[?#]/)[0];

    if (rawPathname.toLowerCase().includes('%2e%2e')) {
      sendText(403, 'Forbidden: traversal rejected');
      return;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(rawPathname);
    } catch {
      sendText(400, 'Bad Request');
      return;
    }

    if (decodedPath.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(decodedPath)) {
      sendText(403, 'Forbidden: traversal rejected');
      return;
    }

    if (decodedPath === SUBPATH_PREFIX) {
      res.writeHead(301, {
        Location: `${SUBPATH_PREFIX}/`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    let relPath = decodedPath;
    if (decodedPath.startsWith(`${SUBPATH_PREFIX}/`)) {
      relPath = decodedPath.slice(SUBPATH_PREFIX.length);
    }

    if (relPath === '/' || relPath === '') {
      relPath = '/index.html';
    } else if (relPath.endsWith('/')) {
      relPath = `${relPath}index.html`;
    }

    const cleanRel = relPath.replace(/^\/+/, '');
    const segments = cleanRel.split('/').filter(Boolean);
    if (segments.some((seg) => seg === '.git' || seg === '..' || seg === '.')) {
      sendText(403, 'Forbidden');
      return;
    }

    const absPath = path.resolve(resolvedRoot, ...segments);
    if (absPath !== resolvedRoot && !absPath.startsWith(resolvedRoot + path.sep)) {
      sendText(403, 'Forbidden');
      return;
    }

    fs.stat(absPath, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        sendText(404, `Not Found: ${decodedPath}`);
        return;
      }

      const ext = path.extname(absPath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';

      fs.readFile(absPath, (readErr, data) => {
        if (readErr) {
          sendText(500, 'Internal Server Error');
          return;
        }
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(data);
        }
      });
    });
  });
}

function parseCliArgs(argv) {
  let serve = false;
  let port = 8080;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--serve') {
      serve = true;
    } else if (arg === '--port' && i + 1 < argv.length) {
      port = Number(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${port}`);
  }
  return { serve, port };
}

async function runServeMode(port) {
  const server = createSubpathServer(SERVE_ROOT);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  console.log(`SERVING http://127.0.0.1:${actualPort}/maul-forge/`);

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
    server.closeAllConnections?.();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function extractRelativeHtmlRefs(htmlText) {
  const refs = new Set();
  const attrRe = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attrRe.exec(htmlText)) !== null) {
    const val = match[1].trim();
    if (!val || val.startsWith('#') || /^[a-z]+:/i.test(val)) continue;
    refs.add(val.replace(/^\.\//, ''));
  }
  return [...refs];
}

function extractSwAssetRefs(swText) {
  const refs = new Set();
  const strRe = /['"](\.\/[^'"]*)['"]/g;
  let match;
  while ((match = strRe.exec(swText)) !== null) {
    const val = match[1];
    refs.add(val === './' ? '' : val.slice(2));
  }
  return [...refs];
}

function extractJsModuleImports(jsSource, moduleRelPath) {
  const imports = [];
  const dir = path.posix.dirname(moduleRelPath);
  const stripped = jsSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const importRe = /(?:^|[\r\n;])\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRe.exec(stripped)) !== null) {
    const spec = match[1];
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const resolved = path.posix.normalize(dir === '.' ? spec : `${dir}/${spec}`);
      imports.push(resolved);
    }
  }
  return imports;
}

async function auditSubpathHttpServer(origin) {
  const subpathBase = `${origin}/maul-forge/`;
  const audited = new Map();

  async function fetchAndVerify(relUrl, expectedMimeSubstr, label = relUrl) {
    const fullUrl = relUrl.startsWith('/') ? `${origin}${relUrl}` : `${subpathBase}${relUrl}`;
    const res = await fetch(fullUrl);
    assert.equal(res.status, 200, `Expected 200 OK for ${label} (${fullUrl}), got ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    const cacheControl = res.headers.get('cache-control') || '';
    assert.ok(
      contentType.toLowerCase().includes(expectedMimeSubstr),
      `Expected Content-Type containing "${expectedMimeSubstr}" for ${label}, got "${contentType}"`,
    );
    assert.equal(cacheControl, 'no-store', `Expected Cache-Control: no-store for ${label}`);
    audited.set(fullUrl, { status: res.status, contentType });
    return res;
  }

  // 1. Check /maul-forge redirect -> /maul-forge/, /maul-forge/, and root / alias
  const redirectRes = await fetch(`${origin}/maul-forge`, { redirect: 'manual' });
  assert.equal(redirectRes.status, 301, `Expected 301 redirect from /maul-forge, got ${redirectRes.status}`);
  assert.equal(redirectRes.headers.get('location'), '/maul-forge/');

  const rootRes = await fetch(`${origin}/`);
  assert.equal(rootRes.status, 200);
  await rootRes.text();

  const baseRes = await fetchAndVerify('', 'text/html', '/maul-forge/');
  const baseHtml = await baseRes.text();

  const indexRes = await fetchAndVerify('index.html', 'text/html', '/maul-forge/index.html');
  const indexHtml = await indexRes.text();
  assert.equal(baseHtml, indexHtml);

  // 2. Check manifest.json & icons
  const manifestRes = await fetchAndVerify('manifest.json', 'application/json', '/maul-forge/manifest.json');
  const manifest = await manifestRes.json();
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  for (const icon of manifest.icons) {
    const rel = icon.src.replace(/^\.\//, '');
    const iconRes = await fetchAndVerify(rel, 'image/png', `/maul-forge/${rel}`);
    const bytes = new Uint8Array(await iconRes.arrayBuffer());
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
    assert.equal(bytes[2], 0x4e);
    assert.equal(bytes[3], 0x47);
  }

  // 3. Check sw.js and all assets listed inside index.html + sw.js
  const swRes = await fetchAndVerify('sw.js', 'javascript', '/maul-forge/sw.js');
  const swText = await swRes.text();

  const assetSet = new Set([
    ...extractRelativeHtmlRefs(indexHtml),
    ...extractSwAssetRefs(swText),
    'styles/hud.css',
    'assets/icons/icon-192.png',
    'assets/icons/icon-512.png',
    'src/main.js',
  ]);

  const queue = [];
  for (const rel of assetSet) {
    if (!rel || rel === 'index.html' || rel === 'manifest.json') continue;
    if (rel.endsWith('.css')) {
      const cssRes = await fetchAndVerify(rel, 'text/css', `/maul-forge/${rel}`);
      assert.ok((await cssRes.text()).length > 100);
    } else if (rel.endsWith('.png')) {
      const pngRes = await fetchAndVerify(rel, 'image/png', `/maul-forge/${rel}`);
      await pngRes.arrayBuffer();
    } else if (rel.endsWith('.js') || rel.endsWith('.mjs')) {
      queue.push(rel);
    }
  }

  // 4. Crawl full ES module import graph starting at src/main.js and sw.js runtime list
  const visitedModules = new Set();
  while (queue.length > 0) {
    const modRel = queue.shift();
    if (visitedModules.has(modRel)) continue;
    visitedModules.add(modRel);

    const modRes = await fetchAndVerify(modRel, 'javascript', `/maul-forge/${modRel}`);
    const src = await modRes.text();
    assert.ok(src.length > 0, `Empty JS module at ${modRel}`);

    const childImports = extractJsModuleImports(src, modRel);
    for (const child of childImports) {
      if (!visitedModules.has(child)) {
        queue.push(child);
      }
    }
  }

  // 5. Security & 404 negative tests: directory traversal must never return 200
  const parsedOrigin = new URL(origin);
  const sendRawGet = (rawPath) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: parsedOrigin.hostname,
          port: Number(parsedOrigin.port),
          path: rawPath,
          method: 'GET',
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });

  const rawTraversalStatus = await sendRawGet('/maul-forge/../../etc/passwd');
  assert.equal(rawTraversalStatus, 403, `Raw traversal must return 403, got ${rawTraversalStatus}`);

  const encodedTraversalStatus = await sendRawGet('/maul-forge/%2e%2e/package.json');
  assert.equal(encodedTraversalStatus, 403, `Encoded traversal must return 403, got ${encodedTraversalStatus}`);

  const missing = await fetch(`${origin}/maul-forge/does-not-exist-404.js`);
  assert.equal(missing.status, 404, `Missing file must return 404, got ${missing.status}`);

  return {
    totalAssetsVerified: audited.size,
    jsModulesAudited: visitedModules.size,
  };
}

function createMock2DContext() {
  const stack = [];
  let _shadowBlur = 0;

  const ctx = {
    globalAlpha: 1,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '12px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineDashOffset: 0,
    shadowColor: 'transparent',
    get shadowBlur() {
      return _shadowBlur;
    },
    set shadowBlur(v) {
      if (v !== 0) {
        ctx.shadowBlurViolations += 1;
      }
      _shadowBlur = v;
    },

    shadowBlurViolations: 0,
    saveDepth: 0,
    maxSaveDepth: 0,
    totalSaves: 0,
    totalRestores: 0,
    restoreUnderflows: 0,
    drawCalls: 0,

    save() {
      this.saveDepth += 1;
      this.totalSaves += 1;
      if (this.saveDepth > this.maxSaveDepth) this.maxSaveDepth = this.saveDepth;
      stack.push({
        globalAlpha: this.globalAlpha,
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        font: this.font,
        textAlign: this.textAlign,
        textBaseline: this.textBaseline,
        lineDashOffset: this.lineDashOffset,
      });
    },
    restore() {
      this.totalRestores += 1;
      if (this.saveDepth <= 0) {
        this.restoreUnderflows += 1;
        return;
      }
      this.saveDepth -= 1;
      const prev = stack.pop();
      if (prev) {
        this.globalAlpha = prev.globalAlpha;
        this.fillStyle = prev.fillStyle;
        this.strokeStyle = prev.strokeStyle;
        this.lineWidth = prev.lineWidth;
        this.lineCap = prev.lineCap;
        this.lineJoin = prev.lineJoin;
        this.font = prev.font;
        this.textAlign = prev.textAlign;
        this.textBaseline = prev.textBaseline;
        this.lineDashOffset = prev.lineDashOffset;
      }
    },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    arc() {},
    ellipse() {},
    fill() {
      this.drawCalls += 1;
    },
    stroke() {
      this.drawCalls += 1;
    },
    fillRect() {
      this.drawCalls += 1;
    },
    strokeRect() {
      this.drawCalls += 1;
    },
    clearRect() {},
    drawImage() {
      this.drawCalls += 1;
    },
    fillText() {
      this.drawCalls += 1;
    },
    strokeText() {
      this.drawCalls += 1;
    },
    measureText(text) {
      return { width: String(text || '').length * 6.5 };
    },
    setLineDash() {},
    translate() {},
    rotate() {},
    scale() {},
    setTransform() {},
    createRadialGradient() {
      return { addColorStop() {} };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };

  return ctx;
}

function createMockAudioParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime(v) {
      this.value = v;
    },
    linearRampToValueAtTime(v) {
      this.value = v;
    },
    exponentialRampToValueAtTime(v) {
      this.value = v;
    },
    cancelScheduledValues() {},
  };
}

function createMockAudioContext() {
  const makeNode = (extra = {}) => ({
    connect() {},
    disconnect() {},
    ...extra,
  });

  const ctx = {
    state: 'running',
    sampleRate: 44100,
    currentTime: 0,
    destination: makeNode(),
    totalAudioNodesCreated: 0,
    resume() {
      this.state = 'running';
      return Promise.resolve();
    },
    createGain() {
      ctx.totalAudioNodesCreated++;
      return makeNode({ gain: createMockAudioParam(1) });
    },
    createDynamicsCompressor() {
      ctx.totalAudioNodesCreated++;
      return makeNode({
        threshold: createMockAudioParam(-14),
        ratio: createMockAudioParam(6),
        knee: createMockAudioParam(12),
        attack: createMockAudioParam(0.003),
        release: createMockAudioParam(0.15),
      });
    },
    createStereoPanner() {
      ctx.totalAudioNodesCreated++;
      return makeNode({ pan: createMockAudioParam(0) });
    },
    createBiquadFilter() {
      ctx.totalAudioNodesCreated++;
      return makeNode({
        type: 'lowpass',
        frequency: createMockAudioParam(1000),
        Q: createMockAudioParam(1),
      });
    },
    createOscillator() {
      ctx.totalAudioNodesCreated++;
      return makeNode({
        type: 'sine',
        frequency: createMockAudioParam(440),
        start() {},
        stop() {},
      });
    },
    createBufferSource() {
      ctx.totalAudioNodesCreated++;
      return makeNode({
        buffer: null,
        loop: false,
        playbackRate: createMockAudioParam(1),
        start() {},
        stop() {},
      });
    },
    createBuffer(channels, length) {
      const data = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        getChannelData() {
          return data;
        },
      };
    },
  };

  return ctx;
}

function run300FrameIntegrationGauntlet() {
  const sim = new GameSim({
    builderMode: BUILDER_MODES.INSTANT,
    startingGold: 500000,
    startingLives: 5000,
    startingEssence: 50,
    seed: 0x2026cafe,
  });

  // Build all 6 base towers + all 9 fusions + 2 Chaos Apex towers along central arena
  const placeTower = (col, row, lin, tier = 4, fusionId = null, apex = false) => {
    const res = sim.placeTower(col, row, lin);
    assert.equal(res.ok, true, `Failed placing ${lin} at (${col},${row}): ${res.reason}`);
    const t = res.tower;
    while (t.tier < tier && !t.fusionId) {
      assert.equal(sim.upgradeTower(t.id).ok, true);
    }
    if (fusionId) {
      assert.equal(sim.fuseTower(t.id, fusionId, true).ok, true);
    }
    if (apex) {
      assert.equal(sim.upgradeTower(t.id).ok, true);
    }
    return t;
  };

  // All 6 base lineages at varied tiers
  placeTower(6, 4, 'ballista', 4, null, true);
  placeTower(6, 6, 'mortar', 4, null, false);
  placeTower(6, 8, 'frost', 4, null, false);
  placeTower(6, 10, 'tesla', 4, null, false);
  placeTower(6, 12, 'venom', 4, null, false);
  placeTower(6, 14, 'brazier', 4, null, false);

  // All 9 Fusions
  placeTower(10, 4, 'frost', 3, 'glacial_obelisk', true);
  placeTower(10, 6, 'brazier', 3, 'hellfire_mortar', false);
  placeTower(10, 8, 'venom', 3, 'plague_coil', false);
  placeTower(10, 10, 'frost', 3, 'shatter_cannon', false);
  placeTower(10, 12, 'ballista', 3, 'railgun_bastion', false);
  placeTower(10, 14, 'ballista', 3, 'viper_gatling', false);
  placeTower(14, 4, 'mortar', 3, 'singularity_catapult', false);
  placeTower(14, 6, 'brazier', 3, 'solar_flare', false);
  placeTower(14, 14, 'ballista', 3, 'windchill_flak', false);

  // Also test Spirit Architect active construction + trail
  sim.setBuilderMode(BUILDER_MODES.SPIRIT);
  sim.placeTower(18, 8, 'tesla');
  sim.placeTower(18, 12, 'mortar');

  // Start wave 10 (boss wave) + spawn all 8 creep archetypes right into combat corridor
  sim.wave = 9;
  sim.startNextWave();

  const sentinelCreeps = [];
  for (let i = 0; i < CREEP_ARCHETYPE_IDS.length; i++) {
    const arch = CREEP_ARCHETYPE_IDS[i];
    const c = sim._spawnCreep(
      {
        archetypeId: arch,
        gateId: i % 2,
        hpMult: 500,
        bountyMult: 2,
        bossTitle: arch === 'act_boss' ? 'Marrow-Crag' : '',
      },
      { x: 8.5 + (i % 4) * 1.1, y: 5.5 + Math.floor(i / 4) * 4.5 },
    );
    sentinelCreeps.push(c);
  }

  const camera = new ViewportCamera();
  const terrainRenderer = new TerrainRenderer();
  const towerRigRenderer = new TowerRigRenderer();
  const builderRigRenderer = new BuilderRigRenderer();
  const creepRigRenderer = new CreepRigRenderer();
  const statusOverlayRenderer = new StatusOverlayRenderer();
  const projectileVfxRenderer = new ProjectileVfxRenderer();
  const ragdollParticles = new RagdollParticleSystem(MAX_PARTICLES);
  const postFx = new PostFxCompositor(null);
  const mockAudioCtx = createMockAudioContext();
  const soundDirector = new SoundDirector({ audioContextFactory: () => mockAudioCtx });
  assert.equal(soundDirector.unlock(), true);

  const ctx = createMock2DContext();
  const portraitCtx = createMock2DContext();
  const mockCanvas = { width: 1440, height: 900, getContext: () => ctx };
  const simEvents = [];
  const frameTimes = [];

  camera.resize(1440, 900, 2);
  postFx.resize(1440, 900, 2);

  for (let frame = 0; frame < 300; frame++) {
    if (frame === 150) {
      camera.resize(390, 844, 2);
      postFx.resize(390, 844, 2);
      mockCanvas.width = 780;
      mockCanvas.height = 1688;
    } else if (frame === 60) {
      camera.zoomAtScreenPoint(1.25, 720, 450);
    } else if (frame === 120) {
      camera.panByScreenDelta(40, -25);
    } else if (frame === 140) {
      camera.resetView();
    }

    const tSec = frame * SIM_DT;
    mockAudioCtx.currentTime = tSec;

    // Keep all 5 status overlays continuously exercised across active combat
    for (let s = 0; s < sentinelCreeps.length; s++) {
      const sc = sentinelCreeps[s];
      if (!sc.active) continue;
      if (s % 5 === 0) {
        sc.chillPct = 0.45;
        sc.chillTimer = Math.max(sc.chillTimer, 1.5);
        sc.frozenTimer = Math.max(sc.frozenTimer, 1.0);
      } else if (s % 5 === 1) {
        sc.acidStacks = Math.max(sc.acidStacks, 6);
        sc.acidTimer = Math.max(sc.acidTimer, 2.0);
      } else if (s % 5 === 2) {
        sc.shockTimer = Math.max(sc.shockTimer, 0.25);
      } else if (s % 5 === 3) {
        sc.igniteDps = Math.max(sc.igniteDps, 40);
        sc.igniteTimer = Math.max(sc.igniteTimer, 1.5);
      } else if (s % 5 === 4 && sc.knockupTimer <= 0) {
        sc.knockupTimer = 0.5;
        sc.vz = 3.2;
      }
    }

    const t0 = performance.now();

    sim.step(SIM_DT);
    sim.drainEvents(simEvents);
    for (let i = 0; i < simEvents.length; i++) {
      const ev = simEvents[i];
      terrainRenderer.handleSimEvent(ev);
      builderRigRenderer.handleSimEvent(ev);
      projectileVfxRenderer.handleSimEvent(ev);
      ragdollParticles.handleSimEvent(ev);
      soundDirector.handleSimEvent(ev, GRID_COLS);
    }
    simEvents.length = 0;

    terrainRenderer.update(SIM_DT);
    builderRigRenderer.update(SIM_DT);
    projectileVfxRenderer.update(SIM_DT);
    ragdollParticles.update(SIM_DT);

    const ghostPreview = frame % 2 === 0
      ? sim.previewTowerPlacement(20, 10, 'ballista')
      : sim.previewTowerPlacement(5, 2, 'mortar');

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, mockCanvas.width, mockCanvas.height);
    ctx.fillStyle = '#07090e';
    ctx.fillRect(0, 0, camera.cssWidth, camera.cssHeight);

    terrainRenderer.render(ctx, camera, sim, tSec, ghostPreview);
    towerRigRenderer.renderTowers(ctx, camera, sim.towers, tSec, sim.towers[0]?.id ?? null);
    creepRigRenderer.renderCreeps(
      ctx,
      camera,
      sim,
      0.5,
      tSec,
      sim.creeps[0]?.id ?? -1,
      statusOverlayRenderer,
    );
    builderRigRenderer.render(ctx, camera, sim.builder, tSec);
    projectileVfxRenderer.render(ctx, camera, sim, 0.5, tSec);
    ragdollParticles.render(ctx, camera);

    if (frame % 30 === 0) {
      towerRigRenderer.renderPortraitTower(portraitCtx, 112, 112, sim.towers[frame % sim.towers.length], tSec);
      if (sim.creeps.length > 0) {
        creepRigRenderer.renderPortraitCreep(
          portraitCtx,
          112,
          112,
          sim.creeps[frame % sim.creeps.length],
          tSec,
          statusOverlayRenderer,
        );
      }
    }

    const fxRes = postFx.render(mockCanvas, 1.15, 0.65, 0.35);
    assert.equal(fxRes, false);
    assert.equal(postFx.hasShaderErrors(), false);

    frameTimes.push(performance.now() - t0);

    assert.equal(ctx.shadowBlurViolations, 0, `Non-zero shadowBlur detected on frame ${frame}`);
    assert.equal(ctx.saveDepth, 0, `Unbalanced save/restore on battle ctx at frame ${frame}: depth=${ctx.saveDepth}`);
    assert.equal(ctx.restoreUnderflows, 0, `restore() underflow on battle ctx at frame ${frame}`);
    assert.equal(portraitCtx.shadowBlurViolations, 0, `Non-zero shadowBlur on portrait ctx at frame ${frame}`);
    assert.equal(portraitCtx.saveDepth, 0, `Unbalanced save/restore on portrait ctx at frame ${frame}`);
    assert.equal(portraitCtx.restoreUnderflows, 0);
  }

  assert.equal(ctx.totalSaves, ctx.totalRestores, 'Total saves must equal total restores');
  assert.equal(portraitCtx.totalSaves, portraitCtx.totalRestores, 'Portrait saves must equal restores');
  assert.ok(ctx.drawCalls > 100000, `Expected substantial draw calls across 300 frames, got ${ctx.drawCalls}`);
  assert.ok(mockAudioCtx.totalAudioNodesCreated > 0, 'Expected SoundDirector to synthesize Web Audio patches');
  assert.ok(soundDirector.getActiveVoiceCount() <= VOICE_POOL_LIMIT, 'Audio voice pool exceeded limit');

  const avgFrameMs = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  const sorted = Float64Array.from(frameTimes).sort();
  const p95FrameMs = sorted[Math.floor((sorted.length - 1) * 0.95)];

  assert.ok(avgFrameMs < 3.5, `Expected avg headless frame compute < 3.5ms, got ${avgFrameMs.toFixed(4)}ms`);

  soundDirector.setMuted(true);
  postFx.dispose();

  return {
    frames: 300,
    avgFrameMs,
    p95FrameMs,
    drawCalls: ctx.drawCalls,
    totalSaves: ctx.totalSaves,
    totalRestores: ctx.totalRestores,
    audioNodesCreated: mockAudioCtx.totalAudioNodesCreated,
    sim,
  };
}

function createMockLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

function createMockCookieDoc() {
  const jar = new Map();
  return {
    get cookie() {
      const parts = [];
      for (const [k, v] of jar.entries()) parts.push(`${k}=${v}`);
      return parts.join('; ');
    },
    set cookie(raw) {
      const segments = String(raw).split(';');
      const [name, ...rest] = segments[0].split('=');
      const key = name.trim();
      const val = rest.join('=').trim();
      const maxAgeSeg = segments.find((s) => s.trim().toLowerCase().startsWith('max-age='));
      const maxAge = maxAgeSeg ? Number(maxAgeSeg.trim().slice('max-age='.length)) : null;
      if ((maxAge !== null && maxAge <= 0) || val === '') jar.delete(key);
      else jar.set(key, val);
    },
  };
}

function createMockIndexedDB() {
  const dbs = new Map();
  const getStores = (name) => {
    if (!dbs.has(name)) dbs.set(name, new Map());
    return dbs.get(name);
  };
  return {
    open(dbName) {
      const req = { result: null, readyState: 'pending', onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        const stores = getStores(dbName);
        const db = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => {
            if (!stores.has(n)) stores.set(n, new Map());
            return {};
          },
          transaction(storeName) {
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore(n) {
                if (n !== storeName && !stores.has(n)) throw new Error(`Missing store ${n}`);
                const map = stores.get(n);
                return {
                  get(k) {
                    const op = { result: undefined, readyState: 'pending', onsuccess: null, onerror: null };
                    queueMicrotask(() => {
                      op.result = map ? map.get(k) : undefined;
                      op.readyState = 'done';
                      op.onsuccess?.({ target: op });
                      tx.oncomplete?.();
                    });
                    return op;
                  },
                  put(val, k) {
                    const op = { result: k, readyState: 'pending', onsuccess: null, onerror: null };
                    queueMicrotask(() => {
                      if (map) map.set(k, structuredClone(val));
                      op.readyState = 'done';
                      op.onsuccess?.({ target: op });
                      tx.oncomplete?.();
                    });
                    return op;
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
        if (!stores.has(IDB_STORE_NAME)) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
    _wipeAll() {
      for (const s of dbs.values()) {
        for (const m of s.values()) m.clear();
      }
    },
    _getRaw(dbName = IDB_DB_NAME, storeName = IDB_STORE_NAME, key = STORAGE_KEY_PRIMARY) {
      return dbs.get(dbName)?.get(storeName)?.get(key) ?? null;
    },
  };
}

async function runPersistenceAndCartridgeChecks(sourceSim) {
  // Prepare rich checkpoint from live GameSim
  sourceSim.wave = 34;
  sourceSim.gold = 4321;
  sourceSim.lives = 24;
  sourceSim.essence = 3;
  sourceSim.score = 128450;
  sourceSim.bestWave = 34;
  sourceSim.highScore = 128450;
  sourceSim.setTowerPriority(sourceSim.towers[0].id, TARGET_PRIORITIES[2]); // Strongest
  sourceSim.towers[0].kills = 42;
  sourceSim.towers[0].totalDamage = 9800;

  const checkpoint = sourceSim.serializeCheckpoint();
  checkpoint.settings.muted = true;
  checkpoint.settings.masterVolume = 0.65;
  checkpoint.settings.builderMode = sourceSim.builderMode;

  const localStorage = createMockLocalStorage();
  const indexedDB = createMockIndexedDB();
  const cookieDoc = createMockCookieDoc();

  const p1 = new RunPersistence({ localStorage, indexedDB, cookieDoc });
  const saved = await p1.saveState(checkpoint);
  assert.ok(saved.rev >= 1);
  assert.ok(readCookieVault(cookieDoc)?.ok, 'Cookie vault must be populated');

  // 1. Wipe LocalStorage + IndexedDB -> self-heals from krunked-cookie-vault-v1
  localStorage.clear();
  indexedDB._wipeAll();
  assert.equal(localStorage.getItem(STORAGE_KEY_PRIMARY), null);
  assert.equal(indexedDB._getRaw(), null);

  const healFromCookie = await new RunPersistence({ localStorage, indexedDB, cookieDoc }).bootAndHeal();
  assert.equal(healFromCookie.source, 'cookieVault');
  assert.deepEqual(healFromCookie.healedLayers.sort(), ['indexedDB', 'localStorage']);
  assert.equal(healFromCookie.state.run.wave, 34);
  assert.equal(healFromCookie.state.run.gold, 4321);
  assert.equal(healFromCookie.state.run.lives, 24);
  assert.equal(healFromCookie.state.run.towers.length, checkpoint.run.towers.length);
  assert.ok(localStorage.getItem(STORAGE_KEY_PRIMARY), 'LocalStorage must be repopulated');
  assert.ok(indexedDB._getRaw(), 'IndexedDB must be repopulated');

  // 2. Wipe krunked-cookie-vault-v1 -> regenerates from surviving LocalStorage
  clearCookieVault(cookieDoc);
  assert.equal(readCookieVault(cookieDoc), null);

  const healCookieBoot = await new RunPersistence({ localStorage, indexedDB, cookieDoc }).bootAndHeal();
  assert.equal(healCookieBoot.source, 'localStorage');
  assert.deepEqual(healCookieBoot.healedLayers, ['cookieVault']);
  assert.equal(readCookieVault(cookieDoc)?.ok, true);
  assert.equal(readCookieVault(cookieDoc).data.run.towers.length, checkpoint.run.towers.length);

  // Also verify reconcileIfTampered heals cookie immediately
  clearCookieVault(cookieDoc);
  const reconcile = await p1.reconcileIfTampered(checkpoint);
  assert.equal(reconcile.healed, true);
  assert.deepEqual(reconcile.healedLayers, ['cookieVault']);
  assert.equal(readCookieVault(cookieDoc)?.ok, true);

  // 3. #maze= buildCartridgeHash -> decodeCartridge -> GameSim.hydrateCheckpoint exact restoration
  const hash = buildCartridgeHash(checkpoint);
  assert.ok(hash.startsWith(CARTRIDGE_HASH_PREFIX));
  const decoded = decodeCartridge(hash);
  assert.equal(decoded.ok, true, `Cartridge decode failed: ${decoded.error}`);

  const restoredSim = new GameSim();
  assert.equal(restoredSim.hydrateCheckpoint(decoded.data), true);
  assert.equal(restoredSim.wave, sourceSim.wave);
  assert.equal(restoredSim.gold, sourceSim.gold);
  assert.equal(restoredSim.lives, sourceSim.lives);
  assert.equal(restoredSim.essence, sourceSim.essence);
  assert.equal(restoredSim.highScore, Math.max(sourceSim.highScore, sourceSim.score));
  assert.equal(restoredSim.bestWave, Math.max(sourceSim.bestWave, sourceSim.wave));
  assert.equal(restoredSim.seed, sourceSim.seed);
  assert.equal(restoredSim.towers.length, sourceSim.towers.length);

  for (let i = 0; i < sourceSim.towers.length; i++) {
    const srcT = sourceSim.towers[i];
    const dstT = restoredSim.getTowerAtTile(srcT.col, srcT.row);
    assert.ok(dstT, `Missing hydrated tower at (${srcT.col},${srcT.row})`);
    assert.equal(dstT.lineageId, srcT.lineageId);
    assert.equal(dstT.tier, srcT.tier);
    assert.equal(dstT.fusionId, srcT.fusionId);
    assert.equal(dstT.isChaosApex, srcT.isChaosApex);
    assert.equal(dstT.priority, srcT.priority);
    assert.equal(dstT.kills, Math.min(511, srcT.kills));
  }
  assert.deepEqual(restoredSim.flowField.flags, sourceSim.flowField.flags);

  return {
    cartridgeLength: hash.length,
    hydratedTowers: restoredSim.towers.length,
  };
}

async function runDefaultQaMode() {
  const server = createSubpathServer(SERVE_ROOT);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  try {
    const addr = server.address();
    const origin = `http://127.0.0.1:${addr.port}`;

    const httpReport = await auditSubpathHttpServer(origin);
    const renderReport = run300FrameIntegrationGauntlet();
    const storageReport = await runPersistenceAndCartridgeChecks(renderReport.sim);

    console.log('=== MAUL-FORGE BROWSER QA & SUBPATH AUDIT ===');
    console.log(
      `HTTP Subpath Audit: ${httpReport.totalAssetsVerified} URLs returned 200 OK (${httpReport.jsModulesAudited} ES modules verified, zero 404s, traversal rejected)`,
    );
    console.log(
      `300-Frame Render/Audio Gauntlet: avgFrameMs=${renderReport.avgFrameMs.toFixed(4)}ms, p95FrameMs=${renderReport.p95FrameMs.toFixed(4)}ms, drawCalls=${renderReport.drawCalls}, save/restore=${renderReport.totalSaves}/${renderReport.totalRestores}, shadowBlurViolations=0, audioNodes=${renderReport.audioNodesCreated}`,
    );
    console.log(
      `Persistence & #maze= Round-Trip: bidirectional vault healing verified, cartridgeLen=${storageReport.cartridgeLength} chars, hydratedTowers=${storageReport.hydratedTowers}`,
    );
    console.log('ALL BROWSER QA CHECKS PASSED!');
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
}

const cli = parseCliArgs(process.argv.slice(2));
if (cli.serve) {
  await runServeMode(cli.port);
} else {
  await runDefaultQaMode();
}
