import {
  GRID_COLS,
  GRID_ROWS,
  SPAWN_GATES,
  WAYPOINTS,
  NEXUS_CORE,
  STATIC_OBSTACLES,
  INITIAL_RUN_CONFIG,
} from '../contracts/types.js';
import { BASE_TOWERS, getTowerStats } from '../engine/towers-data.js';
import { CREEP_DEFS, computeArmorFactor } from '../engine/waves-combat.js';

const LINEAGE_MINIMAP_COLORS = Object.freeze({
  ballista: '#d4a238',
  mortar: '#f97316',
  frost: '#38bdf8',
  tesla: '#60a5fa',
  venom: '#4ade80',
  brazier: '#ef4444',
  glacial_obelisk: '#7dd3fc',
  hellfire_mortar: '#fb923c',
  plague_coil: '#86efac',
  shatter_cannon: '#bae6fd',
  railgun_bastion: '#93c5fd',
  viper_gatling: '#4ade80',
  singularity_catapult: '#c084fc',
  solar_flare: '#fde047',
  windchill_flak: '#38bdf8',
});

const LINEAGE_LABELS = Object.freeze({
  ballista: 'Ballista',
  mortar: 'Mortar',
  frost: 'Frost',
  tesla: 'Tesla',
  venom: 'Venom',
  brazier: 'Brazier',
});

const LINEAGE_ROLES = Object.freeze({
  ballista: 'Rapid Pierce Bolts · Anti-Light & Air',
  mortar: 'Long-Range Siege Splash · Shatters Frozen',
  frost: 'Chills & Deep Freezes · Unlocks Shatter 3×',
  tesla: 'Instant Chain Lightning · Melts Heavy & Ethereal',
  venom: 'Acid Armor Sundering (−2.5/stack) + DoT',
  brazier: 'Ignite Burn DoT + AoE Scorch (T2+)',
});

function formatCompactNum(n) {
  const v = Math.round(n || 0);
  if (v >= 1000000) return `${(v / 1000000).toFixed(2)}M`;
  if (v >= 10000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/**
 * Controls the interactive 32x22 tactical minimap (landmarks, golden paths, towers,
 * creeps/bosses, draggable camera frustum) and the live 112x112 HUD portrait +
 * zero-jitter tabular telemetry panel.
 */
export class PortraitMinimapController {
  constructor(options = {}) {
    this.minimapCanvas = options.minimapCanvas || document.getElementById('minimap-canvas');
    this.portraitCanvas = options.portraitCanvas || document.getElementById('portrait-canvas');
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;
    this.portraitCtx = this.portraitCanvas ? this.portraitCanvas.getContext('2d') : null;

    this.towerRigRenderer = options.towerRigRenderer || null;
    this.creepRigRenderer = options.creepRigRenderer || null;
    this.statusOverlayRenderer = options.statusOverlayRenderer || null;
    this.camera = options.camera || null;

    this.onToggleMatrix = typeof options.onToggleMatrix === 'function' ? options.onToggleMatrix : () => {};
    this.onPreviewMatrix = typeof options.onPreviewMatrix === 'function' ? options.onPreviewMatrix : () => {};
    this.onCyclePriority = typeof options.onCyclePriority === 'function' ? options.onCyclePriority : () => {};

    // DOM elements updated in-place to eliminate layout shift or innerHTML churn
    this.elMinimapMeta = document.getElementById('minimap-meta');
    this.elPortraitTier = document.getElementById('portrait-tier-badge');
    this.elPriorityPill = document.getElementById('portrait-priority-pill');
    this.elName = document.getElementById('insp-name');
    this.elSubtitle = document.getElementById('insp-subtitle');
    this.elTypeBadge = document.getElementById('insp-type-badge');
    this.elTypeText = document.getElementById('insp-type-text');
    this.elBadgesRow = document.getElementById('insp-badges-row');

    this._statKeys = [];
    this._statVals = [];
    for (let i = 0; i < 6; i++) {
      this._statKeys.push(document.getElementById(`stat-k-${i}`));
      this._statVals.push(document.getElementById(`stat-v-${i}`));
    }

    // Pre-allocate 6 reusable status chips inside #insp-badges-row
    this._chipNodes = [];
    if (this.elBadgesRow) {
      this.elBadgesRow.innerHTML = '';
      for (let i = 0; i < 6; i++) {
        const chip = document.createElement('span');
        chip.className = 'status-chip is-hidden';
        this.elBadgesRow.appendChild(chip);
        this._chipNodes.push(chip);
      }
    }

    this._textCache = new WeakMap();
    this._classCache = new WeakMap();
    this._previewTower = {
      id: 0,
      col: 0,
      row: 0,
      cx: 1,
      cy: 1,
      lineageId: 'ballista',
      tier: 1,
      fusionId: null,
      isChaosApex: false,
      buildState: 'active',
      buildProgress: 1,
      yaw: -0.45,
      chargeGlow: 0.25,
      recoil: 0,
    };

    this._isDraggingMinimap = false;
    this._cachedPathFingerprint = '';
    this._cachedPaths = [[], []];
    this._bindEvents();
  }

  _setText(el, text) {
    if (!el) return;
    const str = String(text ?? '');
    if (this._textCache.get(el) !== str) {
      el.textContent = str;
      this._textCache.set(el, str);
    }
  }

  _setClass(el, cls) {
    if (!el) return;
    if (this._classCache.get(el) !== cls) {
      el.className = cls;
      this._classCache.set(el, cls);
    }
  }

  _bindEvents() {
    if (this.minimapCanvas) {
      const jumpCameraToEvent = (ev) => {
        if (!this.camera) return;
        const rect = this.minimapCanvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const nx = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        const ny = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
        this.camera.setCenter(nx * GRID_COLS, ny * GRID_ROWS);
      };

      this.minimapCanvas.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0 && ev.pointerType === 'mouse') return;
        ev.preventDefault();
        this._isDraggingMinimap = true;
        try {
          this.minimapCanvas.setPointerCapture(ev.pointerId);
        } catch {
          // Synthetic pointer events may omit capture
        }
        jumpCameraToEvent(ev);
      });

      this.minimapCanvas.addEventListener('pointermove', (ev) => {
        if (!this._isDraggingMinimap) return;
        ev.preventDefault();
        jumpCameraToEvent(ev);
      });

      const stopDrag = () => {
        this._isDraggingMinimap = false;
      };
      this.minimapCanvas.addEventListener('pointerup', stopDrag);
      this.minimapCanvas.addEventListener('pointercancel', stopDrag);
    }

    if (this.elTypeBadge) {
      this.elTypeBadge.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.onToggleMatrix();
      });
      this.elTypeBadge.addEventListener('pointerenter', (ev) => {
        if (ev.pointerType === 'mouse') {
          this.onPreviewMatrix(true);
        }
      });
      this.elTypeBadge.addEventListener('pointerleave', (ev) => {
        if (ev.pointerType === 'mouse') {
          this.onPreviewMatrix(false);
        }
      });
    }

    if (this.elPriorityPill) {
      this.elPriorityPill.addEventListener('click', () => {
        this.onCyclePriority();
      });
    }
  }

  update(sim, state, timeSec) {
    const selectedTower = state.selectedTowerId ? sim.getTowerById(state.selectedTowerId) : null;
    const selectedCreep = !selectedTower && state.selectedCreepId ? sim.getCreepById(state.selectedCreepId) : null;
    const activeBuildLineage = state.activeBuildLineage || null;

    this._renderMinimap(sim, selectedTower, selectedCreep, timeSec);
    this._renderPortrait(selectedTower, selectedCreep, activeBuildLineage, timeSec);
    this._updateTelemetry(sim, selectedTower, selectedCreep, activeBuildLineage);
  }

  _getGoldenPaths(sim) {
    const flowField = sim?.flowField;
    if (!flowField || typeof flowField.traceGoldenPath !== 'function') {
      return this._cachedPaths;
    }
    const lastId = sim.towers.length > 0 ? sim.towers[sim.towers.length - 1].id : 0;
    const fp = `${sim.towers.length}:${lastId}:${sim.wave}:${sim.lastFlowSolveMs.toFixed(2)}`;
    if (fp !== this._cachedPathFingerprint) {
      this._cachedPathFingerprint = fp;
      this._cachedPaths[0] = flowField.traceGoldenPath(0) || [];
      this._cachedPaths[1] = flowField.traceGoldenPath(1) || [];
    }
    return this._cachedPaths;
  }

  _renderMinimap(sim, selectedTower, selectedCreep, timeSec) {
    const ctx = this.minimapCtx;
    const canvas = this.minimapCanvas;
    if (!ctx || !canvas) return;

    const w = canvas.width;
    const h = canvas.height;
    const sx = w / GRID_COLS;
    const sy = h / GRID_ROWS;

    // Background obsidian slate
    ctx.fillStyle = '#060910';
    ctx.fillRect(0, 0, w, h);

    // Subtle 2x2 grid guides
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.24)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 2; c < GRID_COLS; c += 2) {
      const px = Math.round(c * sx) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
    }
    for (let r = 2; r < GRID_ROWS; r += 2) {
      const py = Math.round(r * sy) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
    }
    ctx.stroke();

    // Static Obsidian Pillars
    ctx.fillStyle = '#253047';
    ctx.strokeStyle = '#d4a238';
    ctx.lineWidth = 1;
    for (let i = 0; i < STATIC_OBSTACLES.length; i++) {
      const obs = STATIC_OBSTACLES[i];
      ctx.fillRect(obs.col * sx, obs.row * sy, obs.w * sx, obs.h * sy);
      ctx.strokeRect(obs.col * sx + 0.5, obs.row * sy + 0.5, obs.w * sx - 1, obs.h * sy - 1);
    }

    // Golden Path Lines
    const paths = this._getGoldenPaths(sim);
    ctx.strokeStyle = 'rgba(212, 162, 56, 0.62)';
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let p = 0; p < paths.length; p++) {
      const path = paths[p];
      if (!path || path.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const pt = path[i];
        if (i === 0) ctx.moveTo(pt.x * sx, pt.y * sy);
        else ctx.lineTo(pt.x * sx, pt.y * sy);
      }
      ctx.stroke();
    }

    // Spawn Gates
    for (let i = 0; i < SPAWN_GATES.length; i++) {
      const g = SPAWN_GATES[i];
      ctx.fillStyle = 'rgba(168, 85, 247, 0.72)';
      ctx.fillRect(g.col * sx, g.row * sy, g.w * sx, g.h * sy);
      ctx.strokeStyle = '#e879f9';
      ctx.lineWidth = 1;
      ctx.strokeRect(g.col * sx + 0.5, g.row * sy + 0.5, g.w * sx - 1, g.h * sy - 1);
    }

    // Waypoint Ley Shrine
    for (let i = 0; i < WAYPOINTS.length; i++) {
      const wp = WAYPOINTS[i];
      ctx.fillStyle = 'rgba(56, 189, 248, 0.62)';
      ctx.fillRect(wp.col * sx, wp.row * sy, wp.w * sx, wp.h * sy);
      ctx.strokeStyle = '#bae6fd';
      ctx.strokeRect(wp.col * sx + 0.5, wp.row * sy + 0.5, wp.w * sx - 1, wp.h * sy - 1);
    }

    // Arcane Nexus Core
    ctx.fillStyle = sim.lives <= 10 ? '#f43f5e' : '#fbbf24';
    ctx.fillRect(NEXUS_CORE.col * sx, NEXUS_CORE.row * sy, NEXUS_CORE.w * sx, NEXUS_CORE.h * sy);
    ctx.strokeStyle = '#fef08a';
    ctx.strokeRect(NEXUS_CORE.col * sx + 0.5, NEXUS_CORE.row * sy + 0.5, NEXUS_CORE.w * sx - 1, NEXUS_CORE.h * sy - 1);

    // Element-colored Tower Dots
    for (let i = 0; i < sim.towers.length; i++) {
      const t = sim.towers[i];
      const color = LINEAGE_MINIMAP_COLORS[t.fusionId || t.lineageId] || '#d4a238';
      const tx = t.col * sx + 1;
      const ty = t.row * sy + 1;
      const tw = 2 * sx - 2;
      const th = 2 * sy - 2;

      ctx.fillStyle = t.buildState === 'active' ? color : 'rgba(148, 163, 184, 0.6)';
      ctx.fillRect(tx, ty, tw, th);

      if (t.isChaosApex) {
        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = 1.4;
        ctx.strokeRect(tx, ty, tw, th);
      } else if (t.fusionId) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx, ty, tw, th);
      }

      if (selectedTower && selectedTower.id === t.id) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.6;
        ctx.strokeRect(t.col * sx - 1, t.row * sy - 1, 2 * sx + 2, 2 * sy + 2);
      }
    }

    // Spirit Builder Wisp
    if (sim.builderMode === 'spirit' && sim.builder) {
      ctx.fillStyle = '#7dd3fc';
      ctx.beginPath();
      ctx.arc(sim.builder.x * sx, sim.builder.y * sy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Crimson & Gold Creep / Boss Blips
    for (let i = 0; i < sim.creeps.length; i++) {
      const c = sim.creeps[i];
      if (!c.active) continue;
      const cx = c.x * sx;
      const cy = c.y * sy;
      if (c.isBoss) {
        const pulse = 4.2 + Math.sin(timeSec * 6) * 0.8;
        ctx.fillStyle = '#fbbf24';
        ctx.strokeStyle = '#7f1d1d';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx, cy - pulse);
        ctx.lineTo(cx + pulse, cy);
        ctx.lineTo(cx, cy + pulse);
        ctx.lineTo(cx - pulse, cy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = c.isFlying && c.earthboundTimer <= 0 ? '#38bdf8' : '#f43f5e';
        ctx.beginPath();
        ctx.arc(cx, cy, c.isSplitChild ? 1.6 : 2.3, 0, Math.PI * 2);
        ctx.fill();
      }
      if (selectedCreep && selectedCreep.id === c.id) {
        ctx.strokeStyle = '#fef08a';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, 4.8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // White Camera Frustum Rectangle
    if (this.camera && typeof this.camera.getVisibleWorldBounds === 'function') {
      const b = this.camera.getVisibleWorldBounds();
      const rx = Math.max(0, b.minX) * sx;
      const ry = Math.max(0, b.minY) * sy;
      const rw = Math.min(GRID_COLS, b.maxX) * sx - rx;
      const rh = Math.min(GRID_ROWS, b.maxY) * sy - ry;
      if (rw > 1 && rh > 1) {
        ctx.strokeStyle = 'rgba(248, 250, 252, 0.92)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
      }
    }

    this._setText(
      this.elMinimapMeta,
      `${GRID_COLS}×${GRID_ROWS} · ${sim.lastFlowSolveMs.toFixed(1)}ms`
    );
  }

  _renderPortrait(selectedTower, selectedCreep, activeBuildLineage, timeSec) {
    const ctx = this.portraitCtx;
    if (!ctx) return;

    if (selectedTower && this.towerRigRenderer) {
      this.towerRigRenderer.renderPortraitTower(ctx, 112, 112, selectedTower, timeSec);
      return;
    }

    if (selectedCreep && selectedCreep.active && this.creepRigRenderer) {
      this.creepRigRenderer.renderPortraitCreep(
        ctx,
        112,
        112,
        selectedCreep,
        timeSec,
        this.statusOverlayRenderer
      );
      return;
    }

    if (activeBuildLineage && BASE_TOWERS[activeBuildLineage] && this.towerRigRenderer) {
      this._previewTower.lineageId = activeBuildLineage;
      this._previewTower.yaw = timeSec * 0.7;
      this.towerRigRenderer.renderPortraitTower(ctx, 112, 112, this._previewTower, timeSec);
      return;
    }

    // Idle Obsidian Bastion Sanctuary Crest
    const w = 112;
    const h = 112;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#090c14';
    ctx.fillRect(0, 0, w, h);

    const pulse = 0.5 + 0.5 * Math.sin(timeSec * 2.4);
    ctx.fillStyle = `rgba(56, 189, 248, ${0.12 + pulse * 0.1})`;
    ctx.beginPath();
    ctx.arc(56, 56, 36, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(212, 162, 56, 0.7)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 3; i++) {
      const a = timeSec * 0.9 + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(56, 56, 34, a, a + 1.15);
      ctx.stroke();
    }

    // Faceted Arcane Crystal
    ctx.fillStyle = '#0284c7';
    ctx.beginPath();
    ctx.moveTo(56, 22);
    ctx.lineTo(36, 56);
    ctx.lineTo(56, 86);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(56, 22);
    ctx.lineTo(76, 56);
    ctx.lineTo(56, 86);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath();
    ctx.moveTo(56, 22);
    ctx.lineTo(63, 56);
    ctx.lineTo(56, 86);
    ctx.lineTo(49, 56);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#d4a238';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(56, 22);
    ctx.lineTo(76, 56);
    ctx.lineTo(56, 86);
    ctx.lineTo(36, 56);
    ctx.closePath();
    ctx.stroke();
  }

  _setStat(idx, label, value) {
    this._setText(this._statKeys[idx], label);
    this._setText(this._statVals[idx], value);
  }

  _setChips(chips) {
    for (let i = 0; i < this._chipNodes.length; i++) {
      const node = this._chipNodes[i];
      if (i < chips.length) {
        this._setText(node, chips[i].text);
        this._setClass(node, `status-chip ${chips[i].cls || ''}`.trim());
      } else {
        this._setText(node, '');
        this._setClass(node, 'status-chip is-hidden');
      }
    }
  }

  _updateTelemetry(sim, tower, creep, activeBuildLineage) {
    if (tower) {
      const stats = getTowerStats(tower.lineageId, tower.tier, tower.fusionId, tower.isChaosApex);
      const tierLabel = tower.isChaosApex
        ? 'APEX'
        : (tower.fusionId ? 'FUSION' : `TIER ${tower.tier}`);
      const subParts = [tower.fusionId ? 'Hybrid Fusion' : `Tier ${tower.tier} ${LINEAGE_LABELS[tower.lineageId] || ''}`];
      if (tower.isChaosApex) subParts.push('Chaos Ascended');
      if (tower.buildState !== 'active') {
        subParts.push(`Forging ${Math.round((tower.buildProgress || 0) * 100)}%`);
      }

      this._setText(this.elPortraitTier, tierLabel);
      this._setText(this.elPriorityPill, `Pri: ${tower.priority}`);
      this._setClass(this.elPriorityPill, 'priority-pill');
      this._setText(this.elName, stats.name);
      this._setText(this.elSubtitle, subParts.join(' · '));
      this._setText(this.elTypeText, stats.attackType);
      this._setClass(this.elTypeBadge, `type-badge type-${stats.attackType.toLowerCase()}`);

      this._setStat(0, 'KILLS', formatCompactNum(tower.kills));
      this._setStat(1, 'TOTAL DMG', formatCompactNum(tower.totalDamage));
      this._setStat(2, 'LIVE DPS', `${formatCompactNum(tower.currentDps || 0)}/s`);
      this._setStat(3, 'RANGE', `${stats.range.toFixed(1)}t`);
      this._setStat(4, 'ATK SPEED', `${(1 / stats.cd).toFixed(2)}/s`);
      this._setStat(
        5,
        'HIT / CD',
        `${Math.round(stats.dmg)} · ${stats.cd.toFixed(2)}s`
      );

      const chips = [];
      if (tower.isChaosApex) {
        chips.push({ text: 'Chaos Apex (1.0× All)', cls: 'chip-chaos' });
      }
      if (tower.forcedCreepId > 0) {
        chips.push({ text: `Focus #${tower.forcedCreepId}`, cls: 'chip-ignite' });
      }
      if (stats.triggersShatter) chips.push({ text: 'Shatter 3×', cls: 'chip-frost' });
      if (stats.chainBounces) chips.push({ text: `Chain ×${stats.chainBounces}`, cls: 'chip-shock' });
      if (stats.acidStacks) chips.push({ text: `Acid +${stats.acidStacks}`, cls: 'chip-acid' });
      if (stats.earthbindSec) chips.push({ text: 'Earthbind Air', cls: 'chip-earthbound' });
      if (stats.knockupSec) chips.push({ text: 'Knock-Up', cls: 'chip-earthbound' });
      if (!tower.fusionId && tower.tier >= 3) {
        const adj = sim.getAdjacentLineages(tower);
        for (const lin of adj) {
          chips.push({ text: `Link: ${LINEAGE_LABELS[lin] || lin}`, cls: 'chip-catalyst' });
        }
      }
      if (chips.length === 0) {
        chips.push({ text: `Invested ${tower.goldInvested}g`, cls: 'chip-muted' });
      }
      this._setChips(chips);
      return;
    }

    if (creep && creep.active) {
      const def = CREEP_DEFS[creep.archetypeId];
      const armorInfo = computeArmorFactor(creep.baseArmor || 0, creep.acidStacks || 0);
      const effSpeed = creep.speed * (1 - Math.min(0.65, creep.chillPct || 0));
      const title = creep.bossTitle
        ? `${creep.bossTitle} · Boss`
        : (def ? def.name : creep.archetypeId);
      const mobility = creep.isFlying && creep.earthboundTimer <= 0 ? 'Flying' : 'Ground';
      const stageTxt = creep.stage === 0 ? 'To Ley Shrine' : 'To Nexus Core';

      this._setText(this.elPortraitTier, creep.isBoss ? 'BOSS' : creep.armorType.toUpperCase());
      this._setText(this.elPriorityPill, `Bounty: +${creep.bounty}g`);
      this._setClass(this.elPriorityPill, 'priority-pill is-passive');
      this._setText(this.elName, title);
      this._setText(this.elSubtitle, `${mobility} · ${stageTxt}`);
      this._setText(this.elTypeText, creep.armorType);
      this._setClass(this.elTypeBadge, 'type-badge type-armor');

      this._setStat(0, 'HEALTH', `${Math.max(0, Math.ceil(creep.hp))}/${creep.maxHp}`);
      this._setStat(
        1,
        'SHIELD',
        creep.maxShield > 0 ? `${Math.ceil(creep.shield)}/${creep.maxShield}` : 'None'
      );
      this._setStat(
        2,
        'ARMOR',
        creep.acidStacks > 0
          ? `${creep.baseArmor} → ${armorInfo.effectiveArmor.toFixed(1)}`
          : `${creep.baseArmor}`
      );
      this._setStat(3, 'SPEED', `${effSpeed.toFixed(2)} t/s`);
      this._setStat(4, 'BOUNTY', `+${creep.bounty}g`);
      this._setStat(
        5,
        'PATH DIST',
        Number.isFinite(creep.pathDist) ? `${creep.pathDist.toFixed(1)}t` : '--'
      );

      const chips = [];
      if (creep.frozenTimer > 0) {
        chips.push({ text: `DEEP FREEZE ${creep.frozenTimer.toFixed(1)}s`, cls: 'chip-frozen' });
      }
      if (creep.chillTimer > 0) {
        chips.push({ text: `Chill -${Math.round((creep.chillPct || 0) * 100)}%`, cls: 'chip-frost' });
      }
      if (creep.acidStacks > 0) {
        chips.push({ text: `Acid ×${creep.acidStacks}`, cls: 'chip-acid' });
      }
      if (creep.igniteTimer > 0) {
        chips.push({ text: `Ignite ${Math.round(creep.igniteDps || 0)}/s`, cls: 'chip-ignite' });
      }
      if (creep.shockTimer > 0) {
        chips.push({ text: 'Shocked', cls: 'chip-shock' });
      }
      if (creep.earthboundTimer > 0) {
        chips.push({ text: `Earthbound ${creep.earthboundTimer.toFixed(1)}s`, cls: 'chip-earthbound' });
      }
      if (creep.knockupTimer > 0) {
        chips.push({ text: 'Knocked Up', cls: 'chip-earthbound' });
      }
      if (chips.length === 0) {
        chips.push({ text: 'No active debuffs · Click Matrix badge for multipliers', cls: 'chip-muted' });
      }
      this._setChips(chips);
      return;
    }

    if (activeBuildLineage && BASE_TOWERS[activeBuildLineage]) {
      const stats = getTowerStats(activeBuildLineage, 1);
      this._setText(this.elPortraitTier, `BUILD [${stats.hotkey}]`);
      this._setText(this.elPriorityPill, `Cost: ${stats.cost}g`);
      this._setClass(this.elPriorityPill, 'priority-pill is-passive');
      this._setText(this.elName, stats.name);
      this._setText(this.elSubtitle, LINEAGE_ROLES[activeBuildLineage] || '2×2 Sanctuary Tower');
      this._setText(this.elTypeText, stats.attackType);
      this._setClass(this.elTypeBadge, `type-badge type-${stats.attackType.toLowerCase()}`);

      this._setStat(0, 'BUILD COST', `${stats.cost}g`);
      this._setStat(1, 'DAMAGE', `${stats.dmg}`);
      this._setStat(2, 'RANGE', `${stats.range.toFixed(1)}t`);
      this._setStat(3, 'ATK SPEED', `${(1 / stats.cd).toFixed(2)}/s`);
      this._setStat(4, 'SPLASH', stats.splash ? `${stats.splash.toFixed(2)}t` : 'Single');
      this._setStat(5, 'FOOTPRINT', '2×2 Tile');

      this._setChips([
        { text: 'Click terrain to forge · Right-click or Esc to cancel', cls: 'chip-catalyst' },
      ]);
      return;
    }

    // Idle Sanctuary Telemetry
    const earlyBonus =
      sim.phase === 'prep' && sim.prepTimer > 0
        ? Math.round(sim.prepTimer * INITIAL_RUN_CONFIG.earlySendBonusPerSec)
        : 0;

    this._setText(this.elPortraitTier, 'BASTION');
    this._setText(this.elPriorityPill, `Speed: ${sim.gameSpeed}×`);
    this._setClass(this.elPriorityPill, 'priority-pill is-passive');
    this._setText(this.elName, 'Obsidian Sanctuary');
    this._setText(
      this.elSubtitle,
      sim.phase === 'prep'
        ? 'Prep Window · Maze freely (100% refund)'
        : (sim.phase === 'combat' ? 'Wave Active · 75% combat refund' : 'Sanctuary Breached')
    );
    this._setText(this.elTypeText, 'MATRIX');
    this._setClass(this.elTypeBadge, 'type-badge');

    this._setStat(0, 'TOWERS', `${sim.towers.length}`);
    this._setStat(1, 'CREEPS', `${sim.creeps.length}`);
    this._setStat(2, 'FLOW SOLVE', `${sim.lastFlowSolveMs.toFixed(2)}ms`);
    this._setStat(3, 'BEST WAVE', `${Math.max(sim.bestWave || 0, sim.wave)}`);
    this._setStat(4, 'BUILDER', sim.builderMode === 'instant' ? 'Instant' : 'Spirit');
    this._setStat(5, 'EARLY BONUS', earlyBonus > 0 ? `+${earlyBonus}g` : '--');

    this._setChips([
      { text: 'Q/W/E/R/F/V Build · Click Tower to Upgrade/Fuse · Matrix Badge for 5×6', cls: 'chip-muted' },
    ]);
  }
}
