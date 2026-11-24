import { SIM_EVENTS } from '../contracts/types.js';
import { BASE_TOWERS } from '../engine/towers-data.js';

const NUMBER_BUILD_MAP = Object.freeze({
  '1': 'ballista',
  '2': 'mortar',
  '3': 'frost',
  '4': 'tesla',
  '5': 'venom',
  '6': 'brazier',
  'T': 'venom',
  'Y': 'brazier',
});

const COMMAND_KEYS = new Set([
  'Q', 'W', 'E', 'R',
  'A', 'S', 'D', 'F',
  'Z', 'X', 'C', 'V',
]);

/**
 * Unified Desktop & Mobile Input Controller:
 * - Keyboard hotkeys (QWER/ASDF/ZXCV, 1-6, T/Y, Space, Escape, M)
 * - Desktop mouse hover ghost preview, left-click build/select, right-click cancel/rally/retarget,
 *   wheel cursor-anchored zoom, and middle/Shift/right-drag camera pan
 * - Mobile touch 1-finger pan (>10px), 2-finger pinch-to-zoom, and 2-step tap-preview / tap-confirm build UX
 */
export class InputController {
  constructor(options = {}) {
    this.canvas = options.canvas || document.getElementById('battle-canvas');
    this.sim = options.sim;
    this.camera = options.camera;
    this.soundDirector = options.soundDirector || null;
    this.commandCard = options.commandCard || null;

    this.callbacks = {
      onStateChange: options.onStateChange || (() => {}),
      onMutateCheckpoint: options.onMutateCheckpoint || (() => {}),
      onShowWarning: options.onShowWarning || (() => {}),
      onClearWarning: options.onClearWarning || (() => {}),
      onShowToast: options.onShowToast || (() => {}),
      onToggleMute: options.onToggleMute || (() => {}),
      onSendWave: options.onSendWave || (() => {}),
      onEscape: options.onEscape || (() => {}),
      isModalOpen: options.isModalOpen || (() => false),
    };

    this.selectedTowerId = null;
    this.selectedCreepId = null;
    this.activeBuildLineage = null;
    this.forceRetargetArmed = false;
    this.ghostPreview = null;
    this.pendingTouchBuild = null;

    this._hoverActive = false;
    this._hoverX = 0;
    this._hoverY = 0;
    this._lastPreviewKey = '';
    this._previewRefreshTimer = 0;

    this._mouseDrag = null;
    this._touchPointers = new Map();
    this._pinchPrevDist = 0;
    this._pinchPrevMidX = 0;
    this._pinchPrevMidY = 0;
    this._hadMultiTouch = false;

    this.elConfirmPill = document.getElementById('mobile-confirm-pill');
    this.elConfirmTitle = document.getElementById('confirm-build-title');
    this.elConfirmSub = document.getElementById('confirm-build-sub');
    this.elConfirmBtn = document.getElementById('btn-confirm-build');
    this.elCancelBtn = document.getElementById('btn-cancel-build');

    this._bindEvents();
  }

  _canvasLocalCoords(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  _bindEvents() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (ev) => this._onKeyDown(ev));
    }

    if (this.elConfirmBtn) {
      this.elConfirmBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.soundDirector?.unlock?.();
        this.confirmPendingTouchBuild();
      });
    }

    if (this.elCancelBtn) {
      this.elCancelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.soundDirector?.playUiClick?.();
        this.clearPendingTouchBuild();
      });
    }

    if (!this.canvas) return;

    this.canvas.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
    });

    this.canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        if (!this.camera) return;
        const pt = this._canvasLocalCoords(ev.clientX, ev.clientY);
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.camera.zoomAtScreenPoint(factor, pt.x, pt.y);
      },
      { passive: false }
    );

    this.canvas.addEventListener('pointerdown', (ev) => this._onPointerDown(ev));
    this.canvas.addEventListener('pointermove', (ev) => this._onPointerMove(ev));
    this.canvas.addEventListener('pointerup', (ev) => this._onPointerUp(ev));
    this.canvas.addEventListener('pointercancel', (ev) => this._onPointerCancel(ev));
    this.canvas.addEventListener('pointerleave', (ev) => {
      if (ev.pointerType !== 'touch') {
        this._hoverActive = false;
        this._mouseDrag = null;
        if (!this.pendingTouchBuild) {
          this.ghostPreview = null;
          this.callbacks.onClearWarning();
        }
      }
    });
  }

  _onKeyDown(ev) {
    const tag = ev.target && ev.target.tagName ? ev.target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev.target?.isContentEditable) {
      if (ev.key === 'Escape') {
        this.callbacks.onEscape();
      }
      return;
    }

    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    this.soundDirector?.unlock?.();

    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (this.callbacks.isModalOpen()) {
        this.callbacks.onEscape();
        return;
      }
      this.handleEscape();
      return;
    }

    if (this.callbacks.isModalOpen()) return;

    if (ev.code === 'Space' || ev.key === ' ') {
      ev.preventDefault();
      this.callbacks.onSendWave();
      return;
    }

    const upper = String(ev.key || '').toUpperCase();

    if (upper === 'M') {
      ev.preventDefault();
      this.callbacks.onToggleMute();
      return;
    }

    if (NUMBER_BUILD_MAP[upper]) {
      ev.preventDefault();
      this.selectBuildLineage(NUMBER_BUILD_MAP[upper]);
      return;
    }

    if (COMMAND_KEYS.has(upper) && this.commandCard) {
      ev.preventDefault();
      this.commandCard.triggerHotkey(upper);
    }
  }

  handleEscape() {
    if (this.forceRetargetArmed) {
      this.forceRetargetArmed = false;
      this.callbacks.onStateChange();
      return;
    }
    if (this.pendingTouchBuild) {
      this.clearPendingTouchBuild();
      return;
    }
    if (this.activeBuildLineage) {
      this.activeBuildLineage = null;
      this.ghostPreview = null;
      this._lastPreviewKey = '';
      this.callbacks.onClearWarning();
      this.callbacks.onStateChange();
      return;
    }
    if (this.selectedTowerId || this.selectedCreepId) {
      this.clearSelection();
    }
  }

  selectBuildLineage(lineageId) {
    if (!BASE_TOWERS[lineageId]) return;
    if (this.sim.phase === 'gameover') return;
    this.soundDirector?.playUiClick?.();

    if (this.activeBuildLineage === lineageId) {
      this.activeBuildLineage = null;
      this.ghostPreview = null;
      this.clearPendingTouchBuild();
      this.callbacks.onClearWarning();
    } else {
      this.selectedTowerId = null;
      this.selectedCreepId = null;
      this.forceRetargetArmed = false;
      this.activeBuildLineage = lineageId;
      this.clearPendingTouchBuild();
      this._lastPreviewKey = '';
      if (this._hoverActive) {
        this._updateHoverGhost(true);
      }
    }
    this.callbacks.onStateChange();
  }

  clearSelection() {
    this.selectedTowerId = null;
    this.selectedCreepId = null;
    this.forceRetargetArmed = false;
    this.activeBuildLineage = null;
    this.ghostPreview = null;
    this.clearPendingTouchBuild();
    this.callbacks.onClearWarning();
    this.callbacks.onStateChange();
  }

  selectTower(towerId) {
    const tower = this.sim.getTowerById(towerId);
    if (!tower) return false;
    this.selectedTowerId = tower.id;
    this.selectedCreepId = null;
    this.activeBuildLineage = null;
    this.forceRetargetArmed = false;
    this.ghostPreview = null;
    this.clearPendingTouchBuild();
    this.callbacks.onClearWarning();
    this.callbacks.onStateChange();
    return true;
  }

  selectCreep(creepId) {
    const creep = this.sim.getCreepById(creepId);
    if (!creep || !creep.active) return false;
    this.selectedCreepId = creep.id;
    this.selectedTowerId = null;
    this.activeBuildLineage = null;
    this.forceRetargetArmed = false;
    this.ghostPreview = null;
    this.clearPendingTouchBuild();
    this.callbacks.onClearWarning();
    this.callbacks.onStateChange();
    return true;
  }

  clearPendingTouchBuild() {
    this.pendingTouchBuild = null;
    if (!this._hoverActive) {
      this.ghostPreview = null;
      this.callbacks.onClearWarning();
    }
    this._syncConfirmPill();
  }

  _syncConfirmPill() {
    if (!this.elConfirmPill) return;
    const pending = this.pendingTouchBuild;
    if (!pending || !pending.preview) {
      this.elConfirmPill.classList.add('is-hidden');
      return;
    }

    const preview = pending.preview;
    const t1 = BASE_TOWERS[pending.lineageId]?.tiers?.[0];
    this.elConfirmPill.classList.remove('is-hidden');

    if (this.elConfirmTitle) {
      this.elConfirmTitle.textContent = t1 ? t1.name : pending.lineageId;
    }
    if (this.elConfirmSub) {
      if (preview.valid) {
        const sign = preview.deltaSec >= 0 ? '+' : '';
        this.elConfirmSub.textContent = `(${pending.col},${pending.row}) · ${sign}${preview.deltaSec.toFixed(1)}s Travel`;
      } else {
        this.elConfirmSub.textContent = preview.reason || 'Cannot Block Creep Path!';
      }
    }
    if (this.elConfirmBtn) {
      this.elConfirmBtn.disabled = !preview.valid;
      this.elConfirmBtn.textContent = preview.valid
        ? `Confirm Build (${preview.cost}g)`
        : (preview.reason || 'Blocked');
    }
  }

  confirmPendingTouchBuild() {
    if (!this.pendingTouchBuild) return false;
    const { col, row, lineageId } = this.pendingTouchBuild;
    const ok = this._tryPlaceTower(col, row, lineageId);
    this.pendingTouchBuild = null;
    this.ghostPreview = null;
    this._syncConfirmPill();
    return ok;
  }

  _tryPlaceTower(col, row, lineageId) {
    const res = this.sim.placeTower(col, row, lineageId);
    if (res.ok) {
      this._lastPreviewKey = '';
      this.callbacks.onClearWarning();
      this.callbacks.onMutateCheckpoint();
      this.callbacks.onStateChange();
      return true;
    }

    const msg = res.reason || 'Cannot Block Creep Path!';
    this.callbacks.onShowWarning(msg);
    return false;
  }

  _onPointerDown(ev) {
    if (this.callbacks.isModalOpen()) return;
    this.soundDirector?.unlock?.();
    const pt = this._canvasLocalCoords(ev.clientX, ev.clientY);

    if (ev.pointerType === 'touch') {
      ev.preventDefault();
      try {
        this.canvas.setPointerCapture(ev.pointerId);
      } catch {
        // Ignore synthetic capture failures
      }
      this._touchPointers.set(ev.pointerId, {
        id: ev.pointerId,
        x: pt.x,
        y: pt.y,
        startX: pt.x,
        startY: pt.y,
        moved: false,
      });

      if (this._touchPointers.size >= 2) {
        this._hadMultiTouch = true;
        this._initPinchMetrics();
      } else {
        this._hadMultiTouch = false;
      }
      return;
    }

    // Desktop Mouse / Pen
    this._hoverActive = true;
    this._hoverX = pt.x;
    this._hoverY = pt.y;
    this._mouseDrag = {
      button: ev.button,
      shiftKey: ev.shiftKey,
      startX: pt.x,
      startY: pt.y,
      lastX: pt.x,
      lastY: pt.y,
      moved: false,
      canPan: ev.button === 1 || ev.button === 2 || (ev.button === 0 && ev.shiftKey),
    };
  }

  _initPinchMetrics() {
    const pts = Array.from(this._touchPointers.values());
    if (pts.length < 2) return;
    const a = pts[0];
    const b = pts[1];
    this._pinchPrevDist = Math.hypot(b.x - a.x, b.y - a.y);
    this._pinchPrevMidX = (a.x + b.x) * 0.5;
    this._pinchPrevMidY = (a.y + b.y) * 0.5;
    a.moved = true;
    b.moved = true;
  }

  _onPointerMove(ev) {
    const pt = this._canvasLocalCoords(ev.clientX, ev.clientY);

    if (ev.pointerType === 'touch') {
      const ptr = this._touchPointers.get(ev.pointerId);
      if (!ptr) return;
      const prevX = ptr.x;
      const prevY = ptr.y;
      ptr.x = pt.x;
      ptr.y = pt.y;

      if (this._touchPointers.size >= 2) {
        this._hadMultiTouch = true;
        const pts = Array.from(this._touchPointers.values());
        const a = pts[0];
        const b = pts[1];
        a.moved = true;
        b.moved = true;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const midX = (a.x + b.x) * 0.5;
        const midY = (a.y + b.y) * 0.5;

        if (this._pinchPrevDist > 4 && dist > 4 && this.camera) {
          this.camera.panByScreenDelta(midX - this._pinchPrevMidX, midY - this._pinchPrevMidY);
          this.camera.zoomAtScreenPoint(dist / this._pinchPrevDist, midX, midY);
        }
        this._pinchPrevDist = dist;
        this._pinchPrevMidX = midX;
        this._pinchPrevMidY = midY;
        return;
      }

      if (!ptr.moved && Math.hypot(pt.x - ptr.startX, pt.y - ptr.startY) > 10) {
        ptr.moved = true;
      }
      if (ptr.moved && !this._hadMultiTouch && this.camera) {
        this.camera.panByScreenDelta(pt.x - prevX, pt.y - prevY);
      }
      return;
    }

    // Mouse / Pen
    this._hoverActive = true;
    this._hoverX = pt.x;
    this._hoverY = pt.y;

    if (this._mouseDrag) {
      const d = this._mouseDrag;
      if (d.canPan) {
        if (!d.moved && Math.hypot(pt.x - d.startX, pt.y - d.startY) > 5) {
          d.moved = true;
        }
        if (d.moved && this.camera) {
          this.camera.panByScreenDelta(pt.x - d.lastX, pt.y - d.lastY);
        }
      }
      d.lastX = pt.x;
      d.lastY = pt.y;
    }

    if (this.activeBuildLineage && (!this._mouseDrag || !this._mouseDrag.moved)) {
      this._updateHoverGhost(false);
    }
  }

  _onPointerUp(ev) {
    const pt = this._canvasLocalCoords(ev.clientX, ev.clientY);

    if (ev.pointerType === 'touch') {
      const ptr = this._touchPointers.get(ev.pointerId);
      this._touchPointers.delete(ev.pointerId);
      if (this._touchPointers.size < 2) {
        this._pinchPrevDist = 0;
      }

      if (
        ptr &&
        !ptr.moved &&
        !this._hadMultiTouch &&
        this._touchPointers.size === 0
      ) {
        this._handleTouchTap(pt.x, pt.y);
      }

      if (this._touchPointers.size === 0) {
        this._hadMultiTouch = false;
      }
      return;
    }

    const drag = this._mouseDrag;
    this._mouseDrag = null;
    if (drag && drag.moved) return;

    if (ev.button === 0 && !ev.shiftKey) {
      this._handlePrimaryClick(pt.x, pt.y);
    } else if (ev.button === 2) {
      this._handleSecondaryClick(pt.x, pt.y);
    }
  }

  _onPointerCancel(ev) {
    if (ev.pointerType === 'touch') {
      this._touchPointers.delete(ev.pointerId);
      if (this._touchPointers.size < 2) {
        this._pinchPrevDist = 0;
      }
      if (this._touchPointers.size === 0) {
        this._hadMultiTouch = false;
      }
    } else {
      this._mouseDrag = null;
    }
  }

  _handleTouchTap(sx, sy) {
    if (this.forceRetargetArmed && this.selectedTowerId) {
      this._tryForceRetargetAtScreen(sx, sy);
      return;
    }

    if (this.activeBuildLineage) {
      const { col, row } = this.camera.screenToTowerPlacement(sx, sy);
      if (
        this.pendingTouchBuild &&
        this.pendingTouchBuild.col === col &&
        this.pendingTouchBuild.row === row &&
        this.pendingTouchBuild.lineageId === this.activeBuildLineage
      ) {
        if (this.pendingTouchBuild.preview?.valid) {
          this.confirmPendingTouchBuild();
        } else {
          this.callbacks.onShowWarning(
            this.pendingTouchBuild.preview?.reason || 'Cannot Block Creep Path!'
          );
        }
        return;
      }

      const preview = this.sim.previewTowerPlacement(col, row, this.activeBuildLineage);
      this.pendingTouchBuild = {
        col,
        row,
        lineageId: this.activeBuildLineage,
        preview,
      };
      this.ghostPreview = preview;
      if (!preview.valid) {
        this.callbacks.onShowWarning(preview.reason || 'Cannot Block Creep Path!');
      } else {
        this.callbacks.onClearWarning();
      }
      this._syncConfirmPill();
      this.callbacks.onStateChange();
      return;
    }

    this._selectEntityAtScreen(sx, sy);
  }

  _handlePrimaryClick(sx, sy) {
    if (this.forceRetargetArmed && this.selectedTowerId) {
      this._tryForceRetargetAtScreen(sx, sy);
      return;
    }

    if (this.activeBuildLineage) {
      const { col, row } = this.camera.screenToTowerPlacement(sx, sy);
      this._tryPlaceTower(col, row, this.activeBuildLineage);
      this._updateHoverGhost(true);
      return;
    }

    this._selectEntityAtScreen(sx, sy);
  }

  _handleSecondaryClick(sx, sy) {
    if (this.activeBuildLineage) {
      this.soundDirector?.playUiClick?.();
      this.activeBuildLineage = null;
      this.ghostPreview = null;
      this.clearPendingTouchBuild();
      this.callbacks.onClearWarning();
      this.callbacks.onStateChange();
      return;
    }

    if (this.forceRetargetArmed) {
      this.forceRetargetArmed = false;
      this.callbacks.onStateChange();
      return;
    }

    const world = this.camera.screenToWorld(sx, sy);

    if (this.selectedTowerId) {
      const creep = this.sim.getCreepAtWorld(world.x, world.y, 0.9);
      if (creep) {
        this.sim.forceRetargetTower(this.selectedTowerId, creep.id);
        this.soundDirector?.playUiClick?.();
        this.callbacks.onShowToast(`Tower focusing Creep #${creep.id}`);
        this.callbacks.onStateChange();
        return;
      }
    }

    if (this.sim.builderMode === 'spirit') {
      this.sim.rallyBuilder(world.x, world.y);
      this.soundDirector?.playUiClick?.();
    }
  }

  _tryForceRetargetAtScreen(sx, sy) {
    const world = this.camera.screenToWorld(sx, sy);
    const creep = this.sim.getCreepAtWorld(world.x, world.y, 0.95);
    this.forceRetargetArmed = false;
    if (creep && this.selectedTowerId) {
      this.sim.forceRetargetTower(this.selectedTowerId, creep.id);
      this.soundDirector?.playUiClick?.();
      this.callbacks.onShowToast(`Forced target: Creep #${creep.id}`);
    } else if (this.sim.builderMode === 'spirit') {
      this.sim.rallyBuilder(world.x, world.y);
      this.callbacks.onShowToast('Spirit Architect rallied');
    }
    this.callbacks.onStateChange();
  }

  _selectEntityAtScreen(sx, sy) {
    const world = this.camera.screenToWorld(sx, sy);

    // Flying creeps flying directly over towers take tight priority
    const tightCreep = this.sim.getCreepAtWorld(world.x, world.y, 0.55);
    if (tightCreep && (tightCreep.isFlying || tightCreep.z > 0.2)) {
      this.soundDirector?.playUiClick?.();
      this.selectCreep(tightCreep.id);
      return;
    }

    const tileCol = Math.floor(world.x);
    const tileRow = Math.floor(world.y);
    const tower = this.sim.getTowerAtTile(tileCol, tileRow);
    if (tower) {
      this.soundDirector?.playUiClick?.();
      this.selectTower(tower.id);
      return;
    }

    const creep = this.sim.getCreepAtWorld(world.x, world.y, 0.85);
    if (creep) {
      this.soundDirector?.playUiClick?.();
      this.selectCreep(creep.id);
      return;
    }

    if (this.selectedTowerId || this.selectedCreepId) {
      this.clearSelection();
    }
  }

  _updateHoverGhost(force) {
    if (!this.activeBuildLineage || !this._hoverActive || !this.camera) {
      return;
    }
    const { col, row } = this.camera.screenToTowerPlacement(this._hoverX, this._hoverY);
    const key = `${col},${row},${this.activeBuildLineage},${this.sim.gold}`;
    if (!force && key === this._lastPreviewKey) return;
    this._lastPreviewKey = key;

    const preview = this.sim.previewTowerPlacement(col, row, this.activeBuildLineage);
    this.ghostPreview = preview;

    if (!preview.valid) {
      this.callbacks.onShowWarning(preview.reason || 'Cannot Block Creep Path!');
    } else {
      this.callbacks.onClearWarning();
    }
  }

  update(dt) {
    // Clear stale selection if creep died or tower was sold
    if (this.selectedTowerId && !this.sim.getTowerById(this.selectedTowerId)) {
      this.selectedTowerId = null;
      this.forceRetargetArmed = false;
      this.callbacks.onStateChange();
    }
    if (this.selectedCreepId) {
      const c = this.sim.getCreepById(this.selectedCreepId);
      if (!c || !c.active) {
        this.selectedCreepId = null;
        this.callbacks.onStateChange();
      }
    }

    this._previewRefreshTimer += dt;
    if (this._previewRefreshTimer >= 0.14) {
      this._previewRefreshTimer = 0;
      if (this.activeBuildLineage && this._hoverActive) {
        this._updateHoverGhost(true);
      } else if (this.pendingTouchBuild && this.activeBuildLineage) {
        const p = this.sim.previewTowerPlacement(
          this.pendingTouchBuild.col,
          this.pendingTouchBuild.row,
          this.activeBuildLineage
        );
        this.pendingTouchBuild.preview = p;
        this.ghostPreview = p;
        this._syncConfirmPill();
      }
    }
  }
}
