# Project MAUL-FORGE — Sprint 1 Handoff

## 1. Completed & Verified (Sprint 1)
- **Simulation & Dual-Gate Flow-Field Mazing (`src/engine/*`)**: `32x22` octile Dijkstra flow-fields (`GridFlowField.recompute()` `0.13ms` avg, strict anti-corner-cutting), dual Spawn->Shrine->Nexus + live-creep anti-block validation, `SpatialHash`, 6 base towers x 4 tiers, 9 Hybrid Fusions, Chaos Apex, 5x6 WC3 armor matrix, 8 creep archetypes, Windchill Earthbind, `3.0x` Shatter, Acid stripping, and Spirit Architect builder (`tests/engine-pathfinding.test.mjs`: `10/10` pass).
- **2.5D Rendering & Audio (`src/render/*`, `src/audio/*`)**: Orthographic camera (`CAMERA_PITCH_Y=0.80`), cached runic terrain + 256-slot decals, zero-`shadowBlur` articulated tower/creep rigs, 5 status overlays, `2048`-slot pooled ragdoll particles, quarter-res WebGL2 premultiplied bloom overlay (`hasShaderErrors() === false`), and 24-voice stereo Web Audio foley (`SoundDirector`).
- **HUD, Persistence & WebAPK PWA (`index.html`, `src/ui/*`, `src/storage/*`, `manifest.json`, `sw.js`)**: Rigid `100dvw x 100dvh` WC3 Command Deck (`QWER/ASDF/ZXCV`), live `112x112` Portrait, interactive Minimap, 2-step touch mazing, real RGBA PNGs (`192x192` 23,001B; `512x512` 86,838B), network-first `./sw.js`, and GitHub Pages CI (`.github/workflows/deploy-pages.yml`).
- **Verification & Frame-Time Metrics**:
  - `tests/stress-100wave.mjs`: `100` waves, `136,942` ticks, `avgStepMs=0.09ms`, `p95StepMs=0.17ms`, `peakCreeps=427`, `2,231` illegal blocks rejected.
  - `tests/vault-cartridge.test.mjs`: `6/6` pass (`80`-tower checkpoint `544B < 3500B`, bidirectional `krunked-cookie-vault-v1` healing & `#maze=` cartridges).
  - `tests/browser-qa-suite.mjs`: `32/32` subpath HTTP URLs `200 OK`, 300-frame integration `avgFrameMs=0.78ms`.
  - Live Chromium Playwright (`1440x900` & `390x844`): WebGL2 active, `p50=16.7ms`, `p95=16.7ms` (`59-60 FPS` vsync locked across `142->76` creeps), zero console/network errors, `LocalStorage`+`IndexedDB` wipe self-heal + cookie wipe regeneration verified.

## 2. Active Technical Debt / Edge Cases
- Chromium `webview_browser` throttles `requestAnimationFrame` when non-foregrounded and disables `page.evaluate`; full 60Hz `rAF` + storage-wipe tests require foreground/Playwright Chromium.
- Touch-only 2-step build confirmation (`pointerType === 'touch'`) should be tested on physical touch hardware alongside desktop simulation.

## 3. Environment & Dependencies
- Zero runtime dependencies or build tools; pure ES modules (`./` relative paths). CI runs Node `22` (`validate-static-pwa.mjs --strict`, `tests/*.mjs`) and GitHub Pages (`_site/`).

## 4. Immediate Sprint 2 Priorities
1. Async Race / Co-op Ghost Seeds sharing deterministic wave splits & replay telemetry via `#maze=` URLs.
2. Multi-biome Elemental Boss Arenas with hazard ley-tiles and custom sanctuary waves.
3. In-app Custom Sanctuary Map Editor exporting shareable grid layouts to `#maze=` cartridges.
