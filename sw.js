/**
 * Maul-Forge: Bastion TD — Subpath-Safe Network-First Service Worker
 * Uses strictly relative ./ paths for GitHub Pages subpath compatibility.
 */

const MAUL_FORGE_CACHE_V1 = 'maul-forge-v1.0.0';

const CORE_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './styles/hud.css',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './src/main.js',
  './src/contracts/types.js',
];

const RUNTIME_MODULE_ASSETS = [
  './src/engine/grid-flowfield.js',
  './src/engine/spatial-hash.js',
  './src/engine/towers-data.js',
  './src/engine/waves-combat.js',
  './src/engine/ecs-sim.js',
  './src/render/viewport-camera.js',
  './src/render/terrain-decals.js',
  './src/render/tower-rigs.js',
  './src/render/builder-rig.js',
  './src/render/postfx-webgl.js',
  './src/render/creep-rigs.js',
  './src/render/status-overlays.js',
  './src/render/projectiles-vfx.js',
  './src/render/ragdoll-particles.js',
  './src/audio/dsp-context.js',
  './src/audio/foley-patches.js',
  './src/audio/sound-director.js',
  './src/storage/cookie-vault.js',
  './src/storage/run-persistence.js',
  './src/storage/maze-cartridge.js',
  './src/ui/input-controller.js',
  './src/ui/command-card.js',
  './src/ui/portrait-minimap.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(MAUL_FORGE_CACHE_V1);
      try {
        await cache.addAll(CORE_SHELL_ASSETS);
      } catch {
        await Promise.allSettled(
          CORE_SHELL_ASSETS.map((assetUrl) => cache.add(assetUrl))
        );
      }
      await Promise.allSettled(
        RUNTIME_MODULE_ASSETS.map((assetUrl) => cache.add(assetUrl))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== MAUL_FORGE_CACHE_V1)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

async function handleNetworkFirst(request) {
  const cache = await caches.open(MAUL_FORGE_CACHE_V1);
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = (await cache.match(request)) || (await caches.match(request));
    if (cached) {
      return cached;
    }
    if (request.mode === 'navigate' || request.destination === 'document') {
      const shellFallback =
        (await cache.match('./index.html')) ||
        (await caches.match('./index.html')) ||
        (await cache.match('./')) ||
        (await caches.match('./'));
      if (shellFallback) {
        return shellFallback;
      }
    }
    return new Response('Offline: resource not available in cache.', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let reqUrl;
  try {
    reqUrl = new URL(request.url);
  } catch {
    return;
  }
  if (reqUrl.origin !== self.location.origin) return;

  event.respondWith(handleNetworkFirst(request));
});
