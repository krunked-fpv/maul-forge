import {
  SIM_DT,
  GRID_COLS,
  ATTACK_TYPES,
  ARMOR_TYPES,
  DAMAGE_MATRIX,
  SIM_EVENTS,
  BUILDER_MODES,
  CARTRIDGE_HASH_PREFIX,
} from './contracts/types.js';
import { GameSim } from './engine/ecs-sim.js';
import { ViewportCamera } from './render/viewport-camera.js';
import { TerrainRenderer } from './render/terrain-decals.js';
import { TowerRigRenderer } from './render/tower-rigs.js';
import { BuilderRigRenderer } from './render/builder-rig.js';
import { CreepRigRenderer } from './render/creep-rigs.js';
import { StatusOverlayRenderer } from './render/status-overlays.js';
import { ProjectileVfxRenderer } from './render/projectiles-vfx.js';
import { RagdollParticleSystem } from './render/ragdoll-particles.js';
import { PostFxCompositor } from './render/postfx-webgl.js';
import { SoundDirector } from './audio/sound-director.js';
import { RunPersistence } from './storage/run-persistence.js';
import {
  decodeCartridge,
  buildCartridgeHash,
  exportBlueprintJson,
  importBlueprintJson,
} from './storage/maze-cartridge.js';
import { PortraitMinimapController } from './ui/portrait-minimap.js';
import { CommandCardController } from './ui/command-card.js';
import { InputController } from './ui/input-controller.js';

const FRAME_HISTORY_SIZE = 300;

function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // Safe fallback when served over unsupported scheme or sandbox
    });
  });
}

function copyTextFallback(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  }
}

async function bootApplication() {
  registerServiceWorker();

  const battleStage = document.getElementById('battle-stage');
  const battleCanvas = document.getElementById('battle-canvas');
  const postfxCanvas = document.getElementById('postfx-canvas');
  const battleCtx = battleCanvas ? battleCanvas.getContext('2d') : null;

  // Core simulation, renderers, audio, persistence
  const sim = new GameSim();
  const camera = new ViewportCamera();
  const terrainRenderer = new TerrainRenderer();
  const towerRigRenderer = new TowerRigRenderer();
  const builderRigRenderer = new BuilderRigRenderer();
  const creepRigRenderer = new CreepRigRenderer();
  const statusOverlayRenderer = new StatusOverlayRenderer();
  const projectileVfxRenderer = new ProjectileVfxRenderer();
  const ragdollParticles = new RagdollParticleSystem();
  const postFx = new PostFxCompositor(postfxCanvas);
  const soundDirector = new SoundDirector();
  const persistence = new RunPersistence();

  // Rolling 300-frame rAF delta ring buffer
  const frameDeltas = new Float64Array(FRAME_HISTORY_SIZE);
  const frameScratch = new Float64Array(FRAME_HISTORY_SIZE);
  let frameSampleCount = 0;
  let frameCursor = 0;

  function recordFrameDelta(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    frameDeltas[frameCursor] = ms;
    frameCursor = (frameCursor + 1) % FRAME_HISTORY_SIZE;
    if (frameSampleCount < FRAME_HISTORY_SIZE) {
      frameSampleCount += 1;
    }
  }

  function getFrameStats() {
    if (frameSampleCount === 0) {
      return { fps: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, sampleCount: 0 };
    }
    let sum = 0;
    for (let i = 0; i < frameSampleCount; i++) {
      const v = frameDeltas[i];
      frameScratch[i] = v;
      sum += v;
    }
    const slice = frameScratch.subarray(0, frameSampleCount);
    slice.sort();
    const avgMs = sum / frameSampleCount;
    const fps = avgMs > 0 ? 1000 / avgMs : 0;
    const p50Ms = slice[Math.floor((frameSampleCount - 1) * 0.5)];
    const p95Ms = slice[Math.floor((frameSampleCount - 1) * 0.95)];
    return {
      fps: Math.round(fps * 10) / 10,
      avgMs: Math.round(avgMs * 100) / 100,
      p50Ms: Math.round(p50Ms * 100) / 100,
      p95Ms: Math.round(p95Ms * 100) / 100,
      sampleCount: frameSampleCount,
    };
  }

  // Serialized Vault Persistence
  let saveChain = Promise.resolve(null);
  let dirtyCheckpoint = false;

  function buildCurrentSnapshot() {
    const snap = sim.serializeCheckpoint();
    snap.settings.muted = soundDirector.isMuted();
    snap.settings.masterVolume = soundDirector.getMasterVolume();
    snap.settings.builderMode = sim.builderMode;
    return snap;
  }

  function syncVaultNow() {
    dirtyCheckpoint = false;
    const snap = buildCurrentSnapshot();
    saveChain = saveChain
      .then(() => persistence.saveState(snap))
      .catch(() => null);
    return saveChain;
  }

  // HUD Banner & Toast Helpers (zero reflow)
  const elWarningBanner = document.getElementById('placement-warning-banner');
  const elWarningText = document.getElementById('placement-warning-text');
  const elToastBanner = document.getElementById('wave-toast-banner');
  const elToastText = document.getElementById('wave-toast-text');
  let warningHideTimer = null;
  let toastHideTimer = null;

  function showWarning(text, autoClearMs = 0) {
    if (!elWarningBanner || !elWarningText) return;
    elWarningText.textContent = text || 'Cannot Block Creep Path!';
    elWarningBanner.classList.add('is-visible');
    if (warningHideTimer) {
      clearTimeout(warningHideTimer);
      warningHideTimer = null;
    }
    if (autoClearMs > 0) {
      warningHideTimer = setTimeout(() => {
        elWarningBanner.classList.remove('is-visible');
      }, autoClearMs);
    }
  }

  function clearWarning() {
    if (warningHideTimer) {
      clearTimeout(warningHideTimer);
      warningHideTimer = null;
    }
    elWarningBanner?.classList.remove('is-visible');
  }

  function showToast(text, durationMs = 2400) {
    if (!elToastBanner || !elToastText) return;
    elToastText.textContent = text;
    elToastBanner.classList.add('is-visible');
    if (toastHideTimer) clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => {
      elToastBanner.classList.remove('is-visible');
    }, durationMs);
  }

  // Matrix Popover & Blueprint Modal DOM
  const elMatrixPopover = document.getElementById('matrix-popover');
  const elMatrixTableWrap = document.getElementById('matrix-table-wrap');
  const elBlueprintModal = document.getElementById('blueprint-modal');
  const elCartridgeInput = document.getElementById('cartridge-link-input');
  const elBlueprintTextarea = document.getElementById('blueprint-json-text');
  const elBlueprintStatus = document.getElementById('blueprint-status');

  let matrixPinned = false;
  let matrixHovered = false;

  function renderMatrixTable(activeAttackType = null, activeArmorType = null) {
    if (!elMatrixTableWrap) return;
    const rows = ATTACK_TYPES.map((atk) => {
      const isRowActive = activeAttackType === atk;
      const cells = ARMOR_TYPES.map((arm) => {
        const mult = DAMAGE_MATRIX[atk]?.[arm] ?? 1.0;
        const multCls = mult >= 1.25 ? 'mult-high' : (mult < 0.9 ? 'mult-low' : 'mult-mid');
        const cellActive = isRowActive && activeArmorType === arm ? ' is-cell-active' : '';
        return `<td class="${multCls}${cellActive}">${mult.toFixed(2)}×</td>`;
      }).join('');
      return `<tr class="${isRowActive ? 'is-row-active' : ''}"><th>${atk}</th>${cells}</tr>`;
    }).join('');

    const headers = ARMOR_TYPES.map((arm) => {
      const colActive = activeArmorType === arm ? 'is-col-active' : '';
      return `<th class="${colActive}">${arm}</th>`;
    }).join('');

    elMatrixTableWrap.innerHTML = `<table class="matrix-table"><thead><tr><th>ATK \\ ARM</th>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function syncMatrixPopoverVisibility() {
    if (!elMatrixPopover) return;
    const show = matrixPinned || matrixHovered;
    elMatrixPopover.classList.toggle('is-hidden', !show);
    if (show) {
      const tower = inputController.selectedTowerId ? sim.getTowerById(inputController.selectedTowerId) : null;
      const creep = inputController.selectedCreepId ? sim.getCreepById(inputController.selectedCreepId) : null;
      renderMatrixTable(tower?.attackType || null, creep?.armorType || null);
    }
  }

  function openBlueprintModal() {
    if (!elBlueprintModal) return;
    const snap = buildCurrentSnapshot();
    const hash = buildCartridgeHash(snap);
    if (elCartridgeInput) {
      elCartridgeInput.value = buildShareUrl(hash);
    }
    if (elBlueprintTextarea) {
      elBlueprintTextarea.value = exportBlueprintJson(snap);
    }
    if (elBlueprintStatus) {
      elBlueprintStatus.textContent = 'Ready to export, share #maze= link, or import deterministic JSON.';
    }
    elBlueprintModal.classList.remove('is-hidden');
  }

  function closeOverlays() {
    matrixPinned = false;
    matrixHovered = false;
    syncMatrixPopoverVisibility();
    elBlueprintModal?.classList.add('is-hidden');
  }

  function isModalOpen() {
    const bpOpen = elBlueprintModal && !elBlueprintModal.classList.contains('is-hidden');
    return Boolean(bpOpen || matrixPinned);
  }

  function buildShareUrl(hash) {
    try {
      const url = new URL(window.location.href);
      url.hash = hash;
      return url.toString();
    } catch {
      return hash;
    }
  }

  function exportCartridgeHash() {
    const snap = buildCurrentSnapshot();
    const hash = buildCartridgeHash(snap);
    try {
      window.history.replaceState(null, '', hash);
    } catch {
      window.location.hash = hash;
    }
    return hash;
  }

  function applySettingsToAudio(settings) {
    if (!settings) return;
    soundDirector.setMuted(Boolean(settings.muted));
    if (Number.isFinite(settings.masterVolume)) {
      soundDirector.setMasterVolume(settings.masterVolume);
    }
  }

  function loadCartridgeHash(hashOrToken) {
    const decoded = decodeCartridge(hashOrToken);
    if (!decoded.ok || !decoded.data) {
      return { ok: false, error: decoded.error || 'Invalid cartridge hash' };
    }
    if (!decoded.data.run) {
      return { ok: false, error: 'Cartridge contains no active run layout' };
    }
    sim.hydrateCheckpoint(decoded.data);
    applySettingsToAudio(decoded.data.settings);
    terrainRenderer.decalLife.fill(0);
    inputController.clearSelection();
    commandCard.resetTransientState();
    syncVaultNow();
    updateTopBar();
    return { ok: true, data: decoded.data };
  }

  async function resetToFreshRun() {
    const preservedMode = sim.builderMode;
    await persistence.clearRunOnly().catch(() => null);
    sim.resetRun({ builderMode: preservedMode });
    terrainRenderer.decalLife.fill(0);
    inputController.clearSelection();
    commandCard.resetTransientState();
    try {
      if (window.location.hash.startsWith(CARTRIDGE_HASH_PREFIX)) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch {
      // Ignore history restrictions
    }
    await syncVaultNow();
    updateTopBar();
    showToast('New Sanctuary Bastion forged');
  }

  // Top Bar Elements
  const elWave = document.getElementById('wave-value');
  const elPhasePill = document.getElementById('phase-pill');
  const elGold = document.getElementById('gold-value');
  const elLives = document.getElementById('lives-value');
  const elEssence = document.getElementById('essence-value');
  const elScore = document.getElementById('score-value');
  const elHighScore = document.getElementById('highscore-value');
  const elBtnSpeed = document.getElementById('btn-speed');
  const elBtnBuilderMode = document.getElementById('btn-builder-mode');
  const elBtnMute = document.getElementById('btn-mute');
  const elVolumeSlider = document.getElementById('volume-slider');
  const elGameOverOverlay = document.getElementById('gameover-overlay');
  const elGoWave = document.getElementById('go-wave');
  const elGoScore = document.getElementById('go-score');
  const elGoBestWave = document.getElementById('go-best-wave');
  const elGoHighScore = document.getElementById('go-high-score');

  const topTextCache = new WeakMap();
  const topClassCache = new WeakMap();

  function setCachedText(el, str) {
    if (!el) return;
    if (topTextCache.get(el) !== str) {
      el.textContent = str;
      topTextCache.set(el, str);
    }
  }

  function setCachedClass(el, cls) {
    if (!el) return;
    if (topClassCache.get(el) !== cls) {
      el.className = cls;
      topClassCache.set(el, cls);
    }
  }

  function updateTopBar() {
    setCachedText(elWave, `WAVE ${sim.wave}`);

    if (sim.phase === 'gameover') {
      setCachedText(elPhasePill, 'BREACHED');
      setCachedClass(elPhasePill, 'phase-pill phase-gameover');
    } else if (sim.phase === 'combat') {
      const isBoss = sim.wave > 0 && sim.wave % 10 === 0;
      setCachedText(elPhasePill, isBoss ? `BOSS · ${sim.creeps.length}` : `COMBAT · ${sim.creeps.length}`);
      setCachedClass(elPhasePill, isBoss ? 'phase-pill phase-boss' : 'phase-pill phase-combat');
    } else {
      setCachedText(elPhasePill, `PREP ${sim.prepTimer.toFixed(1)}s`);
      setCachedClass(elPhasePill, 'phase-pill phase-prep');
    }

    setCachedText(elGold, String(Math.floor(sim.gold)));
    setCachedText(elLives, `${sim.lives}/${sim.maxLives}`);
    setCachedText(elEssence, String(sim.essence));
    setCachedText(elScore, String(Math.floor(sim.score)));
    setCachedText(elHighScore, `HI ${Math.max(sim.highScore, sim.score)}`);

    setCachedText(elBtnSpeed, `${sim.gameSpeed}×`);
    setCachedClass(elBtnSpeed, sim.gameSpeed > 1 ? 'top-btn is-active' : 'top-btn');

    const isSpirit = sim.builderMode === BUILDER_MODES.SPIRIT;
    setCachedText(elBtnBuilderMode, isSpirit ? 'Spirit' : 'Instant');
    setCachedClass(elBtnBuilderMode, isSpirit ? 'top-btn is-active' : 'top-btn');

    const muted = soundDirector.isMuted();
    setCachedText(elBtnMute, muted ? 'Muted' : 'Audio On');
    setCachedClass(elBtnMute, muted ? 'top-btn is-muted' : 'top-btn');

    if (elVolumeSlider) {
      const targetVal = String(Math.round(soundDirector.getMasterVolume() * 100));
      if (elVolumeSlider.value !== targetVal) {
        elVolumeSlider.value = targetVal;
      }
    }

    const isGameOver = sim.phase === 'gameover';
    if (elGameOverOverlay) {
      elGameOverOverlay.classList.toggle('is-hidden', !isGameOver);
      if (isGameOver) {
        setCachedText(elGoWave, String(sim.wave));
        setCachedText(elGoScore, String(Math.floor(sim.score)));
        setCachedText(elGoBestWave, String(Math.max(sim.bestWave, sim.wave)));
        setCachedText(elGoHighScore, String(Math.max(sim.highScore, sim.score)));
      }
    }
  }

  // Action Handlers shared by Command Card, Top Bar & Input Controller
  function handleSendWave() {
    soundDirector.unlock();
    const res = sim.startNextWave();
    if (res.ok) {
      const bonusMsg = res.earlyBonus > 0 ? ` (+${res.earlyBonus}g early bonus)` : '';
      if (res.schedule?.isBossWave) {
        showToast(`Wave ${res.wave} BOSS: ${res.schedule.bossTitle}!${bonusMsg}`, 3200);
      } else {
        showToast(`Wave ${res.wave} Launched${bonusMsg}`, 1800);
      }
      syncVaultNow();
    } else if (res.reason) {
      showToast(res.reason, 1600);
    }
    updateTopBar();
  }

  function handleToggleMute() {
    soundDirector.unlock();
    soundDirector.toggleMute();
    soundDirector.playUiClick();
    syncVaultNow();
    updateTopBar();
  }

  function handleCycleSpeed() {
    soundDirector.unlock();
    soundDirector.playUiClick();
    const next = (sim.gameSpeed % 3) + 1;
    sim.setGameSpeed(next);
    updateTopBar();
  }

  function handleToggleBuilderMode() {
    soundDirector.unlock();
    soundDirector.playUiClick();
    const next =
      sim.builderMode === BUILDER_MODES.SPIRIT
        ? BUILDER_MODES.INSTANT
        : BUILDER_MODES.SPIRIT;
    sim.setBuilderMode(next);
    syncVaultNow();
    updateTopBar();
    showToast(next === BUILDER_MODES.SPIRIT ? 'Spirit Architect Mode' : 'Instant Forge Mode');
  }

  function handleShareCartridge() {
    soundDirector.unlock();
    soundDirector.playUiClick();
    const hash = exportCartridgeHash();
    const fullUrl = buildShareUrl(hash);
    copyTextFallback(fullUrl).then((copied) => {
      showToast(
        copied ? 'Copied #maze= share link to clipboard!' : `Cartridge updated: ${hash.slice(0, 22)}…`
      );
    });
  }

  // Instantiate UI Controllers
  let inputController = null;

  const commandCard = new CommandCardController({
    onSelectBuild: (lineageId) => {
      soundDirector.unlock();
      inputController.selectBuildLineage(lineageId);
    },
    onUpgradeTower: (towerId) => {
      soundDirector.unlock();
      const res = sim.upgradeTower(towerId);
      if (res.ok) {
        syncVaultNow();
      } else {
        showWarning(res.reason || 'Upgrade failed', 1800);
      }
      updateTopBar();
    },
    onFuseTower: (towerId, fusionId, useEssence) => {
      soundDirector.unlock();
      const res = sim.fuseTower(towerId, fusionId, useEssence);
      if (res.ok) {
        commandCard.resetTransientState();
        syncVaultNow();
        showToast(`Fused: ${res.tower?.name || fusionId}!`, 2600);
      } else {
        showWarning(res.reason || 'Fusion failed', 2000);
      }
      updateTopBar();
    },
    onSellTower: (towerId) => {
      soundDirector.unlock();
      const res = sim.sellTower(towerId);
      if (res.ok) {
        inputController.clearSelection();
        syncVaultNow();
        showToast(`Tower salvaged (+${res.refund}g)`, 1600);
      }
      updateTopBar();
    },
    onCyclePriority: (towerId) => {
      soundDirector.unlock();
      soundDirector.playUiClick();
      const next = sim.cycleTowerPriority(towerId, 1);
      if (next) {
        dirtyCheckpoint = true;
      }
    },
    onToggleForceRetarget: (towerId) => {
      soundDirector.unlock();
      soundDirector.playUiClick();
      const tower = sim.getTowerById(towerId);
      if (!tower) return;
      if (inputController.forceRetargetArmed) {
        inputController.forceRetargetArmed = false;
        if (tower.forcedCreepId > 0) {
          sim.forceRetargetTower(tower.id, -1);
          showToast('Forced target cleared');
        }
      } else {
        inputController.forceRetargetArmed = true;
        showToast('Click a creep to force-target (or ground to rally)', 2200);
      }
    },
    onToggleBuilderMode: handleToggleBuilderMode,
    onSendWave: handleSendWave,
    onCycleSpeed: handleCycleSpeed,
    onShareCartridge: handleShareCartridge,
    onOpenBlueprint: () => {
      soundDirector.unlock();
      soundDirector.playUiClick();
      openBlueprintModal();
    },
    onToggleMute: handleToggleMute,
    onFocusCreep: (creepId) => {
      soundDirector.unlock();
      soundDirector.playUiClick();
      let count = 0;
      for (let i = 0; i < sim.towers.length; i++) {
        if (sim.forceRetargetTower(sim.towers[i].id, creepId)) {
          count++;
        }
      }
      showToast(count > 0 ? `Focused ${count} tower(s) on Creep #${creepId}` : 'No towers built yet');
    },
    onClearSelection: () => {
      soundDirector.unlock();
      soundDirector.playUiClick();
      inputController.clearSelection();
    },
    onOpenMatrix: () => {
      soundDirector.unlock();
      soundDirector.playUiClick();
      matrixPinned = !matrixPinned;
      syncMatrixPopoverVisibility();
    },
  });

  inputController = new InputController({
    canvas: battleCanvas,
    sim,
    camera,
    soundDirector,
    commandCard,
    onStateChange: () => {
      if (matrixPinned || matrixHovered) {
        syncMatrixPopoverVisibility();
      }
    },
    onMutateCheckpoint: () => syncVaultNow(),
    onShowWarning: (text) => showWarning(text, 2200),
    onClearWarning: () => clearWarning(),
    onShowToast: (text) => showToast(text),
    onToggleMute: handleToggleMute,
    onSendWave: handleSendWave,
    onEscape: () => closeOverlays(),
    isModalOpen,
  });

  const portraitMinimap = new PortraitMinimapController({
    towerRigRenderer,
    creepRigRenderer,
    statusOverlayRenderer,
    camera,
    onToggleMatrix: () => {
      soundDirector.unlock();
      soundDirector.playUiClick();
      matrixPinned = !matrixPinned;
      syncMatrixPopoverVisibility();
    },
    onPreviewMatrix: (hovering) => {
      matrixHovered = hovering;
      syncMatrixPopoverVisibility();
    },
    onCyclePriority: () => {
      if (!inputController.selectedTowerId) return;
      soundDirector.unlock();
      soundDirector.playUiClick();
      sim.cycleTowerPriority(inputController.selectedTowerId, 1);
      dirtyCheckpoint = true;
    },
  });

  // Wire Top Bar, Camera Quick Buttons, Matrix Popover, Blueprint Modal & PWA Install Prompt
  elBtnSpeed?.addEventListener('click', handleCycleSpeed);
  elBtnBuilderMode?.addEventListener('click', handleToggleBuilderMode);
  elBtnMute?.addEventListener('click', handleToggleMute);
  elVolumeSlider?.addEventListener('input', (ev) => {
    soundDirector.unlock();
    const vol = Math.max(0, Math.min(1, Number(ev.target.value) / 100));
    soundDirector.setMasterVolume(vol);
    dirtyCheckpoint = true;
  });
  document.getElementById('btn-matrix')?.addEventListener('click', () => {
    soundDirector.unlock();
    soundDirector.playUiClick();
    matrixPinned = !matrixPinned;
    syncMatrixPopoverVisibility();
  });
  document.getElementById('btn-close-matrix')?.addEventListener('click', () => {
    matrixPinned = false;
    matrixHovered = false;
    syncMatrixPopoverVisibility();
  });
  document.getElementById('btn-blueprint')?.addEventListener('click', () => {
    soundDirector.unlock();
    soundDirector.playUiClick();
    openBlueprintModal();
  });
  document.getElementById('btn-close-blueprint')?.addEventListener('click', closeOverlays);
  elBlueprintModal?.addEventListener('click', (ev) => {
    if (ev.target === elBlueprintModal) closeOverlays();
  });
  document.getElementById('btn-new-run')?.addEventListener('click', () => {
    soundDirector.unlock();
    soundDirector.playUiClick();
    resetToFreshRun();
  });
  document.getElementById('btn-gameover-reset')?.addEventListener('click', () => {
    soundDirector.unlock();
    soundDirector.playUiClick();
    resetToFreshRun();
  });
  document.getElementById('btn-modal-new-run')?.addEventListener('click', () => {
    soundDirector.unlock();
    soundDirector.playUiClick();
    closeOverlays();
    resetToFreshRun();
  });

  document.getElementById('btn-copy-cartridge')?.addEventListener('click', () => {
    const hash = exportCartridgeHash();
    const url = buildShareUrl(hash);
    if (elCartridgeInput) elCartridgeInput.value = url;
    copyTextFallback(url).then((ok) => {
      if (elBlueprintStatus) {
        elBlueprintStatus.textContent = ok
          ? `Copied ${hash.length}-char #maze= URL to clipboard.`
          : 'Updated #maze= hash in address bar.';
      }
    });
  });

  document.getElementById('btn-load-cartridge')?.addEventListener('click', () => {
    const val = elCartridgeInput?.value || '';
    const idx = val.indexOf(CARTRIDGE_HASH_PREFIX);
    const token = idx >= 0 ? val.slice(idx) : val.trim();
    const res = loadCartridgeHash(token);
    if (elBlueprintStatus) {
      elBlueprintStatus.textContent = res.ok
        ? `Loaded cartridge (Wave ${sim.wave}, ${sim.towers.length} towers).`
        : `Error: ${res.error}`;
    }
    if (res.ok) closeOverlays();
  });

  document.getElementById('btn-export-refresh')?.addEventListener('click', () => {
    const snap = buildCurrentSnapshot();
    if (elBlueprintTextarea) elBlueprintTextarea.value = exportBlueprintJson(snap);
    if (elCartridgeInput) elCartridgeInput.value = buildShareUrl(buildCartridgeHash(snap));
    if (elBlueprintStatus) elBlueprintStatus.textContent = 'Blueprint JSON refreshed from active Bastion.';
  });

  document.getElementById('btn-copy-json')?.addEventListener('click', () => {
    const txt = elBlueprintTextarea?.value || '';
    copyTextFallback(txt).then((ok) => {
      if (elBlueprintStatus) {
        elBlueprintStatus.textContent = ok ? 'Blueprint JSON copied to clipboard.' : 'Select and copy JSON manually.';
      }
    });
  });

  document.getElementById('btn-import-json')?.addEventListener('click', () => {
    const raw = elBlueprintTextarea?.value || '';
    const res = importBlueprintJson(raw);
    if (!res.ok || !res.data) {
      if (elBlueprintStatus) elBlueprintStatus.textContent = `Import failed: ${res.error}`;
      return;
    }
    if (!res.data.run) {
      if (elBlueprintStatus) elBlueprintStatus.textContent = 'Import failed: Blueprint has no run object.';
      return;
    }
    sim.hydrateCheckpoint(res.data);
    applySettingsToAudio(res.data.settings);
    terrainRenderer.decalLife.fill(0);
    inputController.clearSelection();
    commandCard.resetTransientState();
    syncVaultNow();
    updateTopBar();
    closeOverlays();
    showToast(`Imported Blueprint (Wave ${sim.wave}, ${sim.towers.length} towers)`);
  });

  // Quick camera controls
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    camera.zoomAtScreenPoint(1.18, camera.cssWidth * 0.5, camera.cssHeight * 0.5);
  });
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    camera.zoomAtScreenPoint(1 / 1.18, camera.cssWidth * 0.5, camera.cssHeight * 0.5);
  });
  document.getElementById('btn-zoom-reset')?.addEventListener('click', () => {
    camera.resetView();
  });

  // PWA beforeinstallprompt Banner (when not already standalone)
  let deferredInstallPrompt = null;
  let installDismissed = false;
  const elInstallPill = document.getElementById('install-pill');
  const elInstallBtn = document.getElementById('btn-install-app');
  const elInstallDismiss = document.getElementById('btn-install-dismiss');

  const isStandalone =
    Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches) ||
    Boolean(window.navigator?.standalone);

  if (!isStandalone) {
    window.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault();
      if (installDismissed) return;
      deferredInstallPrompt = ev;
      elInstallPill?.classList.remove('is-hidden');
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      elInstallPill?.classList.add('is-hidden');
      showToast('Bastion App installed!');
    });
  }

  elInstallBtn?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    try {
      await deferredInstallPrompt.userChoice;
    } catch {
      // Ignore prompt cancellation errors
    }
    deferredInstallPrompt = null;
    elInstallPill?.classList.add('is-hidden');
  });

  elInstallDismiss?.addEventListener('click', () => {
    installDismissed = true;
    deferredInstallPrompt = null;
    elInstallPill?.classList.add('is-hidden');
  });

  // Viewport Canvas Resize & DPR Scaling
  let viewportCssW = 1280;
  let viewportCssH = 720;
  let viewportDpr = 1;

  function resizeViewport() {
    if (!battleStage || !battleCanvas) return;
    const rect = battleStage.getBoundingClientRect();
    viewportCssW = Math.max(1, Math.floor(rect.width));
    viewportCssH = Math.max(1, Math.floor(rect.height));
    viewportDpr = Math.min(window.devicePixelRatio || 1, 2);

    const backingW = Math.round(viewportCssW * viewportDpr);
    const backingH = Math.round(viewportCssH * viewportDpr);
    if (battleCanvas.width !== backingW) battleCanvas.width = backingW;
    if (battleCanvas.height !== backingH) battleCanvas.height = backingH;

    camera.resize(viewportCssW, viewportCssH, viewportDpr);
    postFx.resize(viewportCssW, viewportCssH, viewportDpr);
  }

  resizeViewport();
  if (typeof ResizeObserver !== 'undefined' && battleStage) {
    const ro = new ResizeObserver(() => resizeViewport());
    ro.observe(battleStage);
  }
  window.addEventListener('resize', resizeViewport);

  // Boot Hydration: #maze= hash first, else triple-replicated RunPersistence.bootAndHeal()
  const bootRes = await persistence.bootAndHeal().catch(() => ({ state: null, source: null, healedLayers: [] }));
  const rawHash = window.location.hash || '';
  let hydrated = false;

  if (rawHash.startsWith(CARTRIDGE_HASH_PREFIX)) {
    const decoded = decodeCartridge(rawHash);
    if (decoded.ok && decoded.data && decoded.data.run) {
      const merged = {
        ...decoded.data,
        highScore: Math.max(decoded.data.highScore || 0, bootRes?.state?.highScore || 0),
        bestWave: Math.max(decoded.data.bestWave || 0, bootRes?.state?.bestWave || 0),
        settings: {
          muted: Boolean(decoded.data.settings?.muted),
          masterVolume: bootRes?.state?.settings?.masterVolume ?? 0.7,
          builderMode: decoded.data.settings?.builderMode || BUILDER_MODES.SPIRIT,
        },
      };
      sim.hydrateCheckpoint(merged);
      applySettingsToAudio(merged.settings);
      hydrated = true;
      showToast(`Loaded #maze= cartridge (Wave ${sim.wave}, ${sim.towers.length} towers)`, 2800);
      syncVaultNow();
    } else {
      showToast('Invalid #maze= cartridge link; checking local vault', 2600);
    }
  }

  if (!hydrated && bootRes && bootRes.state) {
    if (bootRes.state.run) {
      sim.hydrateCheckpoint(bootRes.state);
    } else {
      sim.highScore = bootRes.state.highScore || 0;
      sim.bestWave = bootRes.state.bestWave || 0;
      sim.setBuilderMode(bootRes.state.settings?.builderMode || BUILDER_MODES.SPIRIT);
    }
    applySettingsToAudio(bootRes.state.settings);
    if (bootRes.healedLayers && bootRes.healedLayers.length > 0) {
      showToast(`Vault healed (${bootRes.healedLayers.join(', ')})`, 2400);
    }
  } else if (!hydrated) {
    soundDirector.setMasterVolume(0.7);
    soundDirector.setMuted(false);
    syncVaultNow();
  }

  updateTopBar();

  // Periodic 2.5s vault reconciliation & tamper healing
  setInterval(() => {
    if (dirtyCheckpoint) {
      syncVaultNow();
    } else {
      const fallback = buildCurrentSnapshot();
      persistence.reconcileIfTampered(fallback).catch(() => null);
    }
  }, 2500);

  window.addEventListener('pagehide', () => {
    syncVaultNow();
  });

  window.addEventListener('hashchange', () => {
    const nextHash = window.location.hash || '';
    if (nextHash.startsWith(CARTRIDGE_HASH_PREFIX)) {
      const res = loadCartridgeHash(nextHash);
      if (res.ok) {
        showToast(`Loaded #maze= cartridge (Wave ${sim.wave}, ${sim.towers.length} towers)`, 2600);
      } else {
        showToast(`Invalid #maze= hash: ${res.error}`, 2400);
      }
    }
  });

  // Main 60Hz Fixed-Timestep Accumulator + Interpolated Render Loop
  let lastFrameTimeMs = performance.now();
  let accumulator = 0;
  let simTimeSec = 0;
  let frostPulse = 0;
  let dangerPulse = 0;
  let lastPhase = sim.phase;
  const simEvents = [];
  const uiState = {
    selectedTowerId: null,
    selectedCreepId: null,
    activeBuildLineage: null,
    forceRetargetArmed: false,
    isMuted: false,
  };

  function processSimEvents(events) {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      terrainRenderer.handleSimEvent(ev);
      builderRigRenderer.handleSimEvent(ev);
      projectileVfxRenderer.handleSimEvent(ev);
      ragdollParticles.handleSimEvent(ev);
      soundDirector.handleSimEvent(ev, GRID_COLS);

      if (ev.type === SIM_EVENTS.SHATTER_COMBO) {
        frostPulse = Math.max(frostPulse, 0.88);
      } else if (ev.type === SIM_EVENTS.EARTHBIND_PULL) {
        frostPulse = Math.max(frostPulse, 0.45);
      } else if (ev.type === SIM_EVENTS.NEXUS_LEAK) {
        dangerPulse = Math.max(dangerPulse, 0.92);
        dirtyCheckpoint = true;
      } else if (ev.type === SIM_EVENTS.WAVE_CLEARED) {
        showToast(`Wave ${ev.wave} Cleared! +${ev.bonusGold}g`, 2400);
        syncVaultNow();
      } else if (ev.type === SIM_EVENTS.CREEP_KILLED && ev.isBoss) {
        showToast('Boss Slain! +1 Fusion Essence', 2800);
        dirtyCheckpoint = true;
      }
    }
    events.length = 0;
  }

  function tickFrame(nowMs) {
    const rawDeltaMs = nowMs - lastFrameTimeMs;
    lastFrameTimeMs = nowMs;
    if (rawDeltaMs > 0) {
      recordFrameDelta(rawDeltaMs);
    }

    const frameDt = Math.min(Math.max(0, rawDeltaMs / 1000), 0.05);
    simTimeSec += frameDt;

    if (sim.phase !== 'gameover') {
      accumulator += frameDt * sim.gameSpeed;
      const maxSteps = 4 * sim.gameSpeed;
      let steps = 0;
      while (accumulator >= SIM_DT && steps < maxSteps) {
        sim.step(SIM_DT);
        accumulator -= SIM_DT;
        steps += 1;
      }
      if (steps >= maxSteps && accumulator > SIM_DT) {
        accumulator = SIM_DT * 0.5;
      }
    }

    if (sim.phase !== lastPhase) {
      lastPhase = sim.phase;
      if (sim.phase === 'gameover') {
        dangerPulse = 1.0;
        syncVaultNow();
      }
    }

    sim.drainEvents(simEvents);
    if (simEvents.length > 0) {
      processSimEvents(simEvents);
    }

    const visDt = frameDt * (sim.phase === 'gameover' ? 1 : sim.gameSpeed);
    terrainRenderer.update(visDt);
    builderRigRenderer.update(visDt);
    projectileVfxRenderer.update(visDt);
    ragdollParticles.update(visDt);
    inputController.update(frameDt);

    // Decay PostFX pulses smoothly
    frostPulse = Math.max(0, frostPulse - frameDt * 1.7);
    const lowLivesBaseline = sim.lives <= 6 && sim.lives > 0
      ? 0.16 + 0.12 * (0.5 + 0.5 * Math.sin(simTimeSec * 5.2))
      : 0;
    dangerPulse = Math.max(lowLivesBaseline, dangerPulse - frameDt * 1.5);

    const alpha = sim.phase === 'gameover' ? 1 : Math.max(0, Math.min(1, accumulator / SIM_DT));

    // Render 2.5D Battlefield onto #battle-canvas
    if (battleCtx && battleCanvas) {
      battleCtx.setTransform(1, 0, 0, 1, 0, 0);
      battleCtx.clearRect(0, 0, battleCanvas.width, battleCanvas.height);
      battleCtx.setTransform(viewportDpr, 0, 0, viewportDpr, 0, 0);
      battleCtx.fillStyle = '#07090e';
      battleCtx.fillRect(0, 0, viewportCssW, viewportCssH);

      terrainRenderer.render(battleCtx, camera, sim, simTimeSec, inputController.ghostPreview);
      towerRigRenderer.renderTowers(
        battleCtx,
        camera,
        sim.towers,
        simTimeSec,
        inputController.selectedTowerId
      );
      creepRigRenderer.renderCreeps(
        battleCtx,
        camera,
        sim,
        alpha,
        simTimeSec,
        inputController.selectedCreepId,
        statusOverlayRenderer
      );
      builderRigRenderer.render(battleCtx, camera, sim.builder, simTimeSec);
      projectileVfxRenderer.render(battleCtx, camera, sim, alpha, simTimeSec);
      ragdollParticles.render(battleCtx, camera);
    }

    // Half-Res WebGL2 Post-FX Bloom & Vignette Composite
    const intensity = sim.phase === 'combat' && sim.wave % 10 === 0 ? 1.15 : 1.0;
    const fxOk = postFx.render(battleCanvas, intensity, frostPulse, dangerPulse);
    if (postfxCanvas) {
      postfxCanvas.style.visibility = fxOk && !postFx.hasShaderErrors() ? 'visible' : 'hidden';
    }

    // Sync HUD
    uiState.selectedTowerId = inputController.selectedTowerId;
    uiState.selectedCreepId = inputController.selectedCreepId;
    uiState.activeBuildLineage = inputController.activeBuildLineage;
    uiState.forceRetargetArmed = inputController.forceRetargetArmed;
    uiState.isMuted = soundDirector.isMuted();

    updateTopBar();
    portraitMinimap.update(sim, uiState, simTimeSec);
    commandCard.update(sim, uiState);

    requestAnimationFrame(tickFrame);
  }

  // Expose QA & Inspection Hook
  window.__MAUL_FORGE__ = {
    sim,
    camera,
    persistence,
    soundDirector,
    postFx,
    inputController,
    getFrameStats,
    syncVaultNow,
    exportCartridgeHash,
    loadCartridgeHash,
  };

  requestAnimationFrame(tickFrame);
}

bootApplication();
