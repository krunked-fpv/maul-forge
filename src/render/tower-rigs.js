import {
  CAMERA_PITCH_Y,
  CAMERA_ELEV_SCALE,
  BASE_TOWER_IDS,
  FUSION_TOWER_IDS,
} from '../contracts/types.js';

const LINEAGE_PALETTES = Object.freeze({
  ballista: { stone: '#262933', trim: '#d4a238', accent: '#fde68a', glow: 'rgba(212, 162, 56, 0.36)', dark: '#13161f' },
  mortar: { stone: '#282524', trim: '#c2782e', accent: '#fb923c', glow: 'rgba(249, 115, 22, 0.36)', dark: '#141211' },
  frost: { stone: '#1e2b3c', trim: '#38bdf8', accent: '#e0f2fe', glow: 'rgba(56, 189, 248, 0.38)', dark: '#0f172a' },
  tesla: { stone: '#1e2438', trim: '#60a5fa', accent: '#c4b5fd', glow: 'rgba(96, 165, 250, 0.40)', dark: '#0f1324' },
  venom: { stone: '#1d2b24', trim: '#22c55e', accent: '#86efac', glow: 'rgba(34, 197, 94, 0.36)', dark: '#0e1913' },
  brazier: { stone: '#2c1d1c', trim: '#ef4444', accent: '#fde047', glow: 'rgba(239, 68, 68, 0.38)', dark: '#170d0c' },

  glacial_obelisk: { stone: '#1b2b40', trim: '#38bdf8', accent: '#bae6fd', glow: 'rgba(56, 189, 248, 0.45)', dark: '#0c1526' },
  hellfire_mortar: { stone: '#2a1b19', trim: '#f97316', accent: '#fef08a', glow: 'rgba(249, 115, 22, 0.45)', dark: '#140b0a' },
  plague_coil: { stone: '#182b24', trim: '#4ade80', accent: '#7dd3fc', glow: 'rgba(74, 222, 128, 0.44)', dark: '#0b1713' },
  shatter_cannon: { stone: '#1d2a38', trim: '#7dd3fc', accent: '#e0f2fe', glow: 'rgba(125, 211, 252, 0.42)', dark: '#0f1722' },
  railgun_bastion: { stone: '#202636', trim: '#60a5fa', accent: '#fde68a', glow: 'rgba(96, 165, 250, 0.44)', dark: '#101420' },
  viper_gatling: { stone: '#1e2b21', trim: '#4ade80', accent: '#d4a238', glow: 'rgba(74, 222, 128, 0.42)', dark: '#0f1711' },
  singularity_catapult: { stone: '#1f1b32', trim: '#a855f7', accent: '#e9d5ff', glow: 'rgba(168, 85, 247, 0.45)', dark: '#0e0b1a' },
  solar_flare: { stone: '#2d2318', trim: '#facc15', accent: '#fef9c3', glow: 'rgba(250, 204, 21, 0.48)', dark: '#18120a' },
  windchill_flak: { stone: '#1c2b36', trim: '#38bdf8', accent: '#d4a238', glow: 'rgba(56, 189, 248, 0.42)', dark: '#0f1821' },
});

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

function drawEllipse(ctx, cx, cy, rx, ry, rot = 0, start = 0, end = Math.PI * 2) {
  if (rx <= 0 || ry <= 0) return;
  if (typeof ctx.ellipse === 'function') {
    ctx.ellipse(cx, cy, rx, ry, rot, start, end);
    return;
  }
  const steps = 16;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  for (let i = 0; i <= steps; i++) {
    const a = start + ((end - start) * i) / steps;
    const lx = Math.cos(a) * rx;
    const ly = Math.sin(a) * ry;
    const px = cx + lx * cosR - ly * sinR;
    const py = cy + lx * sinR + ly * cosR;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
}

function setDash(ctx, dash) {
  if (typeof ctx.setLineDash === 'function') {
    ctx.setLineDash(dash);
  }
}

/**
 * Renders depth-sorted 2.5D articulated towers across all 6 base lineages (T1-T4),
 * 9 Hybrid Fusions, Chaos Apex halos, construction scaffolding, and HUD portraits.
 */
export class TowerRigRenderer {
  constructor() {
    this._sortList = [];
    this._p0 = { x: 0, y: 0 };
    this._p1 = { x: 0, y: 0 };
    this._p2 = { x: 0, y: 0 };
    this._p3 = { x: 0, y: 0 };
    this._p4 = { x: 0, y: 0 };
    this._p5 = { x: 0, y: 0 };
    this._p6 = { x: 0, y: 0 };
    this._p7 = { x: 0, y: 0 };

    this._portraitCam = {
      cx: 1,
      cy: 1,
      px: 56,
      py: 60,
      scale: 42,
      getScale() {
        return this.scale;
      },
      worldToScreen(wx, wy, wz = 0, out = null) {
        const sx = this.px + (wx - this.cx) * this.scale;
        const sy =
          this.py +
          (wy - this.cy) * this.scale * CAMERA_PITCH_Y -
          wz * this.scale * CAMERA_ELEV_SCALE;
        if (out) {
          out.x = sx;
          out.y = sy;
          return out;
        }
        return { x: sx, y: sy };
      },
    };
  }

  renderTowers(ctx, camera, towers, timeSec = 0, selectedTowerId = null) {
    if (!ctx || !camera || !towers) return;

    const list = this._sortList;
    list.length = 0;

    if (Array.isArray(towers)) {
      for (let i = 0; i < towers.length; i++) {
        if (towers[i]) list.push(towers[i]);
      }
    } else if (typeof towers[Symbol.iterator] === 'function') {
      for (const t of towers) {
        if (t) list.push(t);
      }
    }

    const n = list.length;
    if (n === 0) return;

    // Insertion sort by cy (back-to-front painter order) with zero allocator callbacks
    for (let i = 1; i < n; i++) {
      const key = list[i];
      const keyY = Number.isFinite(key.cy) ? key.cy : (Number(key.row) || 0) + 1;
      let j = i - 1;
      while (j >= 0) {
        const curY = Number.isFinite(list[j].cy) ? list[j].cy : (Number(list[j].row) || 0) + 1;
        if (curY <= keyY) break;
        list[j + 1] = list[j];
        j--;
      }
      list[j + 1] = key;
    }

    const scale = camera.getScale();
    for (let i = 0; i < n; i++) {
      const tower = list[i];
      this._renderSingleTower(ctx, camera, tower, scale, timeSec, selectedTowerId != null && tower.id === selectedTowerId, false);
    }
  }

  renderPortraitTower(ctx, width, height, tower, timeSec = 0) {
    if (!ctx || !tower) return;
    const w = Math.max(16, Number(width) || 112);
    const h = Math.max(16, Number(height) || 112);

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // Rich obsidian-gold portrait alcove background
    ctx.fillStyle = '#090c14';
    ctx.fillRect(0, 0, w, h);

    const cx = Number.isFinite(tower.cx) ? tower.cx : (Number(tower.col) || 0) + 1;
    const cy = Number.isFinite(tower.cy) ? tower.cy : (Number(tower.row) || 0) + 1;
    const key = tower.fusionId || tower.lineageId || 'ballista';
    const pal = LINEAGE_PALETTES[key] || LINEAGE_PALETTES.ballista;

    ctx.fillStyle = pal.glow;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.54, Math.min(w, h) * 0.36, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(212, 162, 56, 0.38)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(2, 2, w - 4, h - 4);

    const pCam = this._portraitCam;
    pCam.cx = cx;
    pCam.cy = cy;
    pCam.px = w * 0.5;
    pCam.py = h * 0.64;
    pCam.scale = Math.min(w, h) * 0.38;

    this._renderSingleTower(ctx, pCam, tower, pCam.scale, timeSec, false, true);
    ctx.restore();
  }

  _projLocal(baseX, baseY, fx, fy, scale, lx, ly, lz, out) {
    const rx = -fy;
    const ry = fx;
    out.x = baseX + (lx * fx + ly * rx) * scale;
    out.y = baseY + (lx * fy + ly * ry) * scale * CAMERA_PITCH_Y - lz * scale * CAMERA_ELEV_SCALE;
    return out;
  }

  _renderSingleTower(ctx, camera, tower, scale, timeSec, isSelected, isPortrait) {
    const cx = Number.isFinite(tower.cx) ? tower.cx : (Number(tower.col) || 0) + 1;
    const cy = Number.isFinite(tower.cy) ? tower.cy : (Number(tower.row) || 0) + 1;
    const fusionId = tower.fusionId || null;
    const lineageId = tower.lineageId || 'ballista';
    const rigId = fusionId || lineageId;
    const pal = LINEAGE_PALETTES[rigId] || LINEAGE_PALETTES[lineageId] || LINEAGE_PALETTES.ballista;
    const tier = clamp(Math.round(Number(tower.tier) || 1), 1, 4);
    const yaw = Number.isFinite(tower.yaw) ? tower.yaw : -0.45;
    const chargeGlow = clamp(Number(tower.chargeGlow) || 0, 0, 1);
    const recoil = clamp(Number(tower.recoil) || 0, 0, 1);
    const buildState = tower.buildState || 'active';
    const isConstructing = buildState !== 'active';
    const buildProgress = clamp(Number(tower.buildProgress) || (buildState === 'queued' ? 0.15 : 0.6), 0, 1);

    const ground = camera.worldToScreen(cx, cy, 0, this._p0);

    ctx.save();

    // Selection halo and optional range ellipse
    if (isSelected && !isPortrait) {
      const rx = scale * 1.18;
      const ry = rx * CAMERA_PITCH_Y;
      ctx.fillStyle = 'rgba(212, 162, 56, 0.12)';
      ctx.beginPath();
      drawEllipse(ctx, ground.x, ground.y, rx, ry);
      ctx.fill();

      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = Math.max(1.5, scale * 0.065);
      for (let s = 0; s < 4; s++) {
        const a0 = timeSec * 1.6 + (s * Math.PI) / 2;
        ctx.beginPath();
        drawEllipse(ctx, ground.x, ground.y, rx, ry, 0, a0, a0 + 0.9);
        ctx.stroke();
      }

      if (Number.isFinite(tower.range) && tower.range > 0) {
        const rngX = tower.range * scale;
        const rngY = rngX * CAMERA_PITCH_Y;
        setDash(ctx, [scale * 0.3, scale * 0.22]);
        ctx.strokeStyle = 'rgba(125, 211, 252, 0.55)';
        ctx.lineWidth = Math.max(1.2, scale * 0.045);
        ctx.beginPath();
        drawEllipse(ctx, ground.x, ground.y, rngX, rngY);
        ctx.stroke();
        setDash(ctx, []);
      }
    }

    // 2.5D parallax drop shadow
    const shadowOff = camera.worldToScreen(cx + 0.18, cy + 0.16, 0, this._p1);
    ctx.fillStyle = 'rgba(2, 5, 12, 0.56)';
    ctx.beginPath();
    drawEllipse(ctx, shadowOff.x, shadowOff.y, scale * 0.92, scale * 0.92 * CAMERA_PITCH_Y);
    ctx.fill();

    // Stepped obsidian/stone plinth with faction trim
    const plinthH = 0.24 + (fusionId ? 0.14 : (tier - 1) * 0.04);
    this._drawSteppedPlinth(ctx, camera, cx, cy, scale, pal, tier, Boolean(fusionId), plinthH);

    // If under construction, dim turret partially and overlay scaffolding
    if (isConstructing) {
      ctx.save();
      ctx.globalAlpha = 0.35 + buildProgress * 0.55;
      this._drawTowerMechanism(ctx, camera, cx, cy, plinthH * (0.4 + 0.6 * buildProgress), scale, rigId, tier, yaw, chargeGlow, recoil, timeSec, pal);
      ctx.restore();
      this._drawScaffoldingOverlay(ctx, camera, cx, cy, scale, buildProgress, timeSec, pal);
    } else {
      this._drawTowerMechanism(ctx, camera, cx, cy, plinthH, scale, rigId, tier, yaw, chargeGlow, recoil, timeSec, pal);
    }

    // Rotating golden Chaos Halo when ascended
    if (tower.isChaosApex === true) {
      this._drawChaosApexHalo(ctx, camera, cx, cy, plinthH + 0.95, scale, timeSec);
    }

    ctx.restore();
  }

  _drawOctagonPath(ctx, cx, cy, rx, ry) {
    const k = 0.92388;
    const s = 0.38268;
    ctx.moveTo(cx + rx * k, cy + ry * s);
    ctx.lineTo(cx + rx * s, cy + ry * k);
    ctx.lineTo(cx - rx * s, cy + ry * k);
    ctx.lineTo(cx - rx * k, cy + ry * s);
    ctx.lineTo(cx - rx * k, cy - ry * s);
    ctx.lineTo(cx - rx * s, cy - ry * k);
    ctx.lineTo(cx + rx * s, cy - ry * k);
    ctx.lineTo(cx + rx * k, cy - ry * s);
    ctx.closePath();
  }

  _drawSteppedPlinth(ctx, camera, cx, cy, scale, pal, tier, isFusion, plinthH) {
    const base = camera.worldToScreen(cx, cy, 0, this._p0);
    const mid = camera.worldToScreen(cx, cy, plinthH * 0.55, this._p1);
    const top = camera.worldToScreen(cx, cy, plinthH, this._p2);

    const rOuter = scale * 0.88;
    const rOuterY = rOuter * CAMERA_PITCH_Y;
    const rInner = scale * 0.68;
    const rInnerY = rInner * CAMERA_PITCH_Y;

    // Lower stone skirt
    ctx.fillStyle = pal.dark;
    ctx.beginPath();
    this._drawOctagonPath(ctx, base.x, base.y + scale * 0.04, rOuter, rOuterY);
    ctx.fill();

    ctx.fillStyle = pal.stone;
    ctx.beginPath();
    this._drawOctagonPath(ctx, mid.x, mid.y, rOuter * 0.94, rOuterY * 0.94);
    ctx.fill();

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = Math.max(1, scale * 0.035);
    ctx.stroke();

    // Upper stepped turret deck
    ctx.fillStyle = '#141925';
    ctx.beginPath();
    this._drawOctagonPath(ctx, top.x, top.y, rInner, rInnerY);
    ctx.fill();

    // Faction trim border
    ctx.strokeStyle = pal.trim;
    ctx.lineWidth = Math.max(1.2, scale * (isFusion ? 0.06 : 0.04 + tier * 0.006));
    ctx.stroke();

    // Tier corner buttress rivets
    const buttressCount = isFusion ? 6 : 2 + tier;
    ctx.fillStyle = pal.accent;
    for (let i = 0; i < buttressCount; i++) {
      const ang = (i * Math.PI * 2) / buttressCount + Math.PI * 0.25;
      const bx = mid.x + Math.cos(ang) * rOuter * 0.84;
      const by = mid.y + Math.sin(ang) * rOuterY * 0.84;
      ctx.beginPath();
      ctx.arc(bx, by, scale * 0.055, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawScaffoldingOverlay(ctx, camera, cx, cy, scale, progress, timeSec, pal) {
    const pBL = camera.worldToScreen(cx - 0.72, cy + 0.72, 0, this._p1);
    const pBR = camera.worldToScreen(cx + 0.72, cy + 0.72, 0, this._p2);
    const pTL = camera.worldToScreen(cx - 0.72, cy + 0.72, 0.95, this._p3);
    const pTR = camera.worldToScreen(cx + 0.72, cy + 0.72, 0.95, this._p4);
    const pBackL = camera.worldToScreen(cx - 0.72, cy - 0.72, 0.95, this._p5);
    const pBackR = camera.worldToScreen(cx + 0.72, cy - 0.72, 0.95, this._p6);

    // Timber scaffolding uprights & cross braces
    ctx.strokeStyle = '#926239';
    ctx.lineWidth = Math.max(1.5, scale * 0.055);
    ctx.beginPath();
    ctx.moveTo(pBL.x, pBL.y);
    ctx.lineTo(pTL.x, pTL.y);
    ctx.moveTo(pBR.x, pBR.y);
    ctx.lineTo(pTR.x, pTR.y);
    ctx.moveTo(pTL.x, pTL.y);
    ctx.lineTo(pTR.x, pTR.y);
    ctx.moveTo(pTL.x, pTL.y);
    ctx.lineTo(pBackL.x, pBackL.y);
    ctx.moveTo(pTR.x, pTR.y);
    ctx.lineTo(pBackR.x, pBackR.y);
    ctx.moveTo(pBackL.x, pBackL.y);
    ctx.lineTo(pBackR.x, pBackR.y);
    ctx.stroke();

    ctx.strokeStyle = '#b47b49';
    ctx.lineWidth = Math.max(1, scale * 0.035);
    ctx.beginPath();
    ctx.moveTo(pBL.x, pBL.y);
    ctx.lineTo(pTR.x, pTR.y);
    ctx.moveTo(pBR.x, pBR.y);
    ctx.lineTo(pTL.x, pTL.y);
    ctx.stroke();

    // Arcane assembly pulse ring rising with buildProgress
    const scanZ = 0.15 + ((timeSec * 0.9) % 1) * 0.75;
    const scanPos = camera.worldToScreen(cx, cy, scanZ, this._p1);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
    ctx.lineWidth = Math.max(1.2, scale * 0.045);
    ctx.beginPath();
    drawEllipse(ctx, scanPos.x, scanPos.y, scale * 0.68, scale * 0.68 * CAMERA_PITCH_Y);
    ctx.stroke();

    // Progress bar beneath scaffolding
    const barW = scale * 1.1;
    const barH = Math.max(3, scale * 0.1);
    const barCenter = camera.worldToScreen(cx, cy + 0.9, 0, this._p2);
    ctx.fillStyle = 'rgba(11, 13, 18, 0.85)';
    ctx.fillRect(barCenter.x - barW * 0.5, barCenter.y, barW, barH);
    ctx.fillStyle = pal.trim;
    ctx.fillRect(barCenter.x - barW * 0.5, barCenter.y, barW * progress, barH);
  }

  _drawChaosApexHalo(ctx, camera, cx, cy, zBase, scale, timeSec) {
    const center = camera.worldToScreen(cx, cy, zBase, this._p1);
    const rx = scale * 0.72;
    const ry = rx * CAMERA_PITCH_Y * 0.85;
    const spin = timeSec * 1.4;

    ctx.save();
    ctx.fillStyle = 'rgba(250, 204, 21, 0.16)';
    ctx.beginPath();
    drawEllipse(ctx, center.x, center.y, rx * 1.25, ry * 1.25);
    ctx.fill();

    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = Math.max(1.6, scale * 0.06);
    ctx.beginPath();
    drawEllipse(ctx, center.x, center.y, rx, ry);
    ctx.stroke();

    // 8 radiant golden Chaos spikes
    ctx.strokeStyle = '#fef08a';
    ctx.lineWidth = Math.max(1.2, scale * 0.045);
    for (let i = 0; i < 8; i++) {
      const a = spin + (i * Math.PI) / 4;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(center.x + ca * rx * 0.88, center.y + sa * ry * 0.88);
      ctx.lineTo(center.x + ca * rx * 1.32, center.y + sa * ry * 1.32);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawTowerMechanism(ctx, camera, cx, cy, plinthH, scale, rigId, tier, yaw, chargeGlow, recoil, timeSec, pal) {
    switch (rigId) {
      case 'ballista':
        this._drawBallista(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'mortar':
        this._drawMortar(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'frost':
        this._drawFrost(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'tesla':
        this._drawTesla(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'venom':
        this._drawVenom(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'brazier':
        this._drawBrazier(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'glacial_obelisk':
        this._drawGlacialObelisk(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'hellfire_mortar':
        this._drawHellfireMortar(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'plague_coil':
        this._drawPlagueCoil(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'shatter_cannon':
        this._drawShatterCannon(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'railgun_bastion':
        this._drawRailgunBastion(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'viper_gatling':
        this._drawViperGatling(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'singularity_catapult':
        this._drawSingularityCatapult(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'solar_flare':
        this._drawSolarFlare(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      case 'windchill_flak':
        this._drawWindchillFlak(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal);
        break;
      default:
        this._drawBallista(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal);
        break;
    }
  }

  _drawBrassGear(ctx, gx, gy, radius, teeth, angle, fill = '#d4a238', stroke = '#785111') {
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(angle);
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1, radius * 0.14);
    ctx.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i * Math.PI) / teeth;
      const r = i % 2 === 0 ? radius : radius * 0.72;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#1e2433';
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ==================== 6 BASE LINEAGES (TIERS 1..4) ====================

  _drawBallista(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const pivot = camera.worldToScreen(cx, cy, plinthH + 0.18, this._p0);

    // Spinning brass azimuth clockwork gear under carriage
    this._drawBrassGear(ctx, pivot.x, pivot.y + scale * 0.08, scale * 0.34, 8 + tier * 2, timeSec * 1.3 + yaw);

    // Side brass torsion gears
    const gearL = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.1, -0.34, 0.16, this._p1);
    const gearR = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.1, 0.34, 0.16, this._p2);
    this._drawBrassGear(ctx, gearL.x, gearL.y, scale * (0.14 + tier * 0.02), 7, -timeSec * 2.4);
    this._drawBrassGear(ctx, gearR.x, gearR.y, scale * (0.14 + tier * 0.02), 7, timeSec * 2.4);

    // Bolt magazine rack on left cheek
    const magA = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.36, -0.28, 0.14, this._p1);
    const magB = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.12, -0.28, 0.22, this._p2);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = Math.max(1.5, scale * 0.055);
    ctx.beginPath();
    ctx.moveTo(magA.x, magA.y);
    ctx.lineTo(magB.x, magB.y);
    ctx.stroke();

    // Recoil & flexing prod tension
    const kick = recoil * 0.22;
    const flex = Math.sin(timeSec * 2.2) * 0.04 + chargeGlow * 0.12 - recoil * 0.16;

    // Crossbow stock rail
    const stockRear = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.45 - kick, 0, 0.12, this._p1);
    const stockFront = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.62 - kick, 0, 0.28, this._p2);
    ctx.strokeStyle = tier >= 3 ? '#cbd5e1' : '#784824';
    ctx.lineWidth = Math.max(2.5, scale * (0.13 + tier * 0.02));
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(stockRear.x, stockRear.y);
    ctx.lineTo(stockFront.x, stockFront.y);
    ctx.stroke();

    // Flexing bow limbs (stacked twin prods for T2+)
    const limbStacks = tier >= 2 ? 2 : 1;
    for (let s = 0; s < limbStacks; s++) {
      const zOff = 0.22 + s * 0.14;
      const span = 0.56 + tier * 0.05 - s * 0.08;
      const tipL = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.15 - flex - kick, -span, zOff, this._p3);
      const tipR = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.15 - flex - kick, span, zOff, this._p4);
      const center = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.42 - kick, 0, zOff + 0.04, this._p5);

      ctx.strokeStyle = tier >= 4 ? '#facc15' : (tier >= 3 ? '#e2e8f0' : '#b47b49');
      ctx.lineWidth = Math.max(2, scale * 0.085);
      ctx.beginPath();
      ctx.moveTo(tipL.x, tipL.y);
      ctx.quadraticCurveTo(center.x, center.y, tipR.x, tipR.y);
      ctx.stroke();

      // Bowstring pulled to latch
      const latch = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.25 - chargeGlow * 0.18 - kick, 0, zOff, this._p6);
      ctx.strokeStyle = chargeGlow > 0.25 ? '#fef08a' : '#e2e8f0';
      ctx.lineWidth = Math.max(1, scale * 0.032);
      ctx.beginPath();
      ctx.moveTo(tipL.x, tipL.y);
      ctx.lineTo(latch.x, latch.y);
      ctx.lineTo(tipR.x, tipR.y);
      ctx.stroke();
    }

    // Loaded bolt + charge glow tip
    const boltTail = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.22 - kick, 0, 0.24, this._p1);
    const boltTip = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.74 - kick, 0, 0.30, this._p2);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = Math.max(1.5, scale * 0.055);
    ctx.beginPath();
    ctx.moveTo(boltTail.x, boltTail.y);
    ctx.lineTo(boltTip.x, boltTip.y);
    ctx.stroke();

    if (chargeGlow > 0.05) {
      ctx.fillStyle = `rgba(253, 224, 71, ${chargeGlow * 0.72})`;
      ctx.beginPath();
      ctx.arc(boltTip.x, boltTip.y, scale * (0.1 + chargeGlow * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }

    // T3/T4 Gryphon winged crest shields
    if (tier >= 3) {
      const wingL = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.05, -0.45, 0.48, this._p3);
      const wingR = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.05, 0.45, 0.48, this._p4);
      ctx.fillStyle = pal.trim;
      ctx.beginPath();
      ctx.arc(wingL.x, wingL.y, scale * 0.11, 0, Math.PI * 2);
      ctx.arc(wingR.x, wingR.y, scale * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawMortar(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const pivot = camera.worldToScreen(cx, cy, plinthH + 0.1, this._p0);

    // Glowing coal brazier furnace grate at rear
    const coal = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.34, 0, 0.18, this._p1);
    const emberPulse = 0.65 + 0.35 * Math.sin(timeSec * 6.5);
    ctx.fillStyle = '#1c1917';
    ctx.beginPath();
    ctx.arc(coal.x, coal.y, scale * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(249, 115, 22, ${0.75 * emberPulse})`;
    ctx.beginPath();
    ctx.arc(coal.x, coal.y, scale * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(253, 224, 71, ${0.65 * emberPulse})`;
    ctx.beginPath();
    ctx.arc(coal.x, coal.y, scale * 0.08, 0, Math.PI * 2);
    ctx.fill();

    // Riveted boiler drum & pumping steam pistons on flanks
    const pistonPump = Math.sin(timeSec * 5.2) * 0.1 + recoil * 0.12;
    for (let side = -1; side <= 1; side += 2) {
      const pBot = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.1, side * 0.42, 0.05, this._p2);
      const pTop = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.1, side * 0.42, 0.42 + pistonPump * side, this._p3);
      ctx.strokeStyle = '#9ca3af';
      ctx.lineWidth = Math.max(2, scale * 0.1);
      ctx.beginPath();
      ctx.moveTo(pBot.x, pBot.y);
      ctx.lineTo(pTop.x, pTop.y);
      ctx.stroke();

      ctx.fillStyle = '#3f3f46';
      ctx.beginPath();
      ctx.arc(pBot.x, pBot.y, scale * 0.13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = pal.trim;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Elevated angled riveted mortar barrel with spring kickback
    const kick = recoil * 0.24;
    const bBase = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.15 - kick, 0, 0.24, this._p1);
    const bMuzzle = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.46 - kick * 0.8, 0, 0.76 + tier * 0.04 - kick * 0.4, this._p2);
    const barrelW = scale * (0.28 + tier * 0.045);

    ctx.lineCap = 'round';
    ctx.strokeStyle = '#18181b';
    ctx.lineWidth = barrelW + scale * 0.08;
    ctx.beginPath();
    ctx.moveTo(bBase.x, bBase.y);
    ctx.lineTo(bMuzzle.x, bMuzzle.y);
    ctx.stroke();

    ctx.strokeStyle = tier >= 3 ? '#52525b' : '#3f3f46';
    ctx.lineWidth = barrelW;
    ctx.beginPath();
    ctx.moveTo(bBase.x, bBase.y);
    ctx.lineTo(bMuzzle.x, bMuzzle.y);
    ctx.stroke();

    // Brass barrel bands + muzzle rim
    ctx.fillStyle = pal.trim;
    ctx.beginPath();
    ctx.arc(bMuzzle.x, bMuzzle.y, barrelW * 0.56, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = chargeGlow > 0.2 ? '#fb923c' : '#09090b';
    ctx.beginPath();
    ctx.arc(bMuzzle.x, bMuzzle.y, barrelW * 0.34, 0, Math.PI * 2);
    ctx.fill();

    if (chargeGlow > 0.08) {
      ctx.fillStyle = `rgba(251, 146, 60, ${chargeGlow * 0.55})`;
      ctx.beginPath();
      ctx.arc(bMuzzle.x, bMuzzle.y, barrelW * (0.65 + chargeGlow * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawFrost(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const base = camera.worldToScreen(cx, cy, plinthH, this._p0);

    // Venting sub-zero mist ring expanding smoothly
    const ventPhase = (timeSec * 0.75) % 1;
    const ventR = scale * (0.55 + ventPhase * 0.45);
    ctx.strokeStyle = `rgba(186, 230, 253, ${(1 - ventPhase) * 0.45})`;
    ctx.lineWidth = Math.max(1.2, scale * 0.05);
    ctx.beginPath();
    drawEllipse(ctx, base.x, base.y + scale * 0.05, ventR, ventR * CAMERA_PITCH_Y);
    ctx.stroke();

    // Central faceted cryo-spire
    const spireH = 0.78 + tier * 0.14 - recoil * 0.08;
    const tip = camera.worldToScreen(cx, cy, plinthH + spireH, this._p1);
    const w = scale * (0.28 + tier * 0.03);

    ctx.fillStyle = '#0284c7';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(base.x - w, base.y);
    ctx.lineTo(base.x, base.y + scale * 0.12);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(base.x + w, base.y);
    ctx.lineTo(base.x, base.y + scale * 0.12);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = chargeGlow > 0.25 ? '#ffffff' : '#e0f2fe';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(base.x + w * 0.34, base.y + scale * 0.04);
    ctx.lineTo(base.x, base.y + scale * 0.12);
    ctx.closePath();
    ctx.fill();

    // Counter-orbiting ice crystals
    const crystalCount = tier === 1 ? 2 : (tier === 2 ? 3 : (tier === 3 ? 4 : 6));
    for (let i = 0; i < crystalCount; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      const orbitA = timeSec * 1.9 * dir + (i * Math.PI * 2) / crystalCount;
      const rad = i % 2 === 0 ? 0.56 : 0.42;
      const cz = plinthH + 0.48 + Math.sin(timeSec * 3.1 + i) * 0.1;
      const cPos = camera.worldToScreen(cx + Math.cos(orbitA) * rad, cy + Math.sin(orbitA) * rad, cz, this._p2);
      const cr = scale * 0.11;

      ctx.fillStyle = i % 2 === 0 ? '#7dd3fc' : '#e0f2fe';
      ctx.beginPath();
      ctx.moveTo(cPos.x, cPos.y - cr * 1.4);
      ctx.lineTo(cPos.x + cr * 0.7, cPos.y);
      ctx.lineTo(cPos.x, cPos.y + cr * 1.2);
      ctx.lineTo(cPos.x - cr * 0.7, cPos.y);
      ctx.closePath();
      ctx.fill();
    }

    // Yaw-tracking cryo-emitter prism tip
    const aimTip = this._projLocal(tip.x, tip.y, fx, fy, scale, 0.26 - recoil * 0.1, 0, 0.08, this._p3);
    ctx.fillStyle = `rgba(186, 230, 253, ${0.42 + chargeGlow * 0.5})`;
    ctx.beginPath();
    ctx.arc(aimTip.x, aimTip.y, scale * (0.12 + chargeGlow * 0.1), 0, Math.PI * 2);
    ctx.fill();
  }

  _drawTesla(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const base = camera.worldToScreen(cx, cy, plinthH, this._p0);
    const spireZ = 0.78 + tier * 0.12;
    const dome = camera.worldToScreen(cx, cy, plinthH + spireZ, this._p1);

    // Copper-wound induction pylon column
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = Math.max(3, scale * 0.22);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(dome.x, dome.y);
    ctx.stroke();

    // Copper coil ribs
    const ribs = 3 + tier;
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = Math.max(1.5, scale * 0.055);
    for (let r = 1; r <= ribs; r++) {
      const rp = camera.worldToScreen(cx, cy, plinthH + (spireZ * r) / (ribs + 1), this._p2);
      ctx.beginPath();
      drawEllipse(ctx, rp.x, rp.y, scale * 0.22, scale * 0.22 * CAMERA_PITCH_Y);
      ctx.stroke();
    }

    // Rotating gimbaled copper rings
    const ringCount = tier >= 3 ? 3 : (tier >= 2 ? 2 : 1);
    const mid = camera.worldToScreen(cx, cy, plinthH + spireZ * 0.56, this._p2);
    for (let g = 0; g < ringCount; g++) {
      const tilt = timeSec * (1.7 + g * 0.5) * (g % 2 === 0 ? 1 : -1);
      ctx.strokeStyle = g === 0 ? '#f59e0b' : '#fbbf24';
      ctx.lineWidth = Math.max(1.3, scale * 0.045);
      ctx.beginPath();
      drawEllipse(ctx, mid.x, mid.y, scale * (0.48 + g * 0.06), scale * (0.18 + g * 0.05), tilt);
      ctx.stroke();
    }

    // Floating orbiting runestones
    const runeCount = 1 + tier;
    for (let i = 0; i < runeCount; i++) {
      const a = timeSec * 1.4 + (i * Math.PI * 2) / runeCount;
      const rPos = camera.worldToScreen(
        cx + Math.cos(a) * 0.62,
        cy + Math.sin(a) * 0.62,
        plinthH + 0.36 + Math.sin(timeSec * 3.5 + i) * 0.07,
        this._p3
      );
      ctx.fillStyle = '#334155';
      ctx.fillRect(rPos.x - scale * 0.07, rPos.y - scale * 0.1, scale * 0.14, scale * 0.2);
      ctx.fillStyle = '#60a5fa';
      ctx.fillRect(rPos.x - scale * 0.02, rPos.y - scale * 0.05, scale * 0.04, scale * 0.1);
    }

    // Top capacitor sphere + directional spark prong
    const orbR = scale * (0.18 + tier * 0.02 + chargeGlow * 0.06);
    ctx.fillStyle = `rgba(96, 165, 250, ${0.28 + chargeGlow * 0.42})`;
    ctx.beginPath();
    ctx.arc(dome.x, dome.y, orbR * 1.65, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath();
    ctx.arc(dome.x, dome.y, orbR * 0.85, 0, Math.PI * 2);
    ctx.fill();

    // Directional discharge horn tracking yaw + idle crackling arc
    const horn = this._projLocal(dome.x, dome.y, fx, fy, scale, 0.34 - recoil * 0.1, 0, 0.04, this._p4);
    ctx.strokeStyle = '#93c5fd';
    ctx.lineWidth = Math.max(1.2, scale * 0.04);
    ctx.beginPath();
    ctx.moveTo(dome.x, dome.y);
    ctx.lineTo((dome.x + horn.x) * 0.5 + Math.sin(timeSec * 29) * scale * 0.06, (dome.y + horn.y) * 0.5 + Math.cos(timeSec * 23) * scale * 0.05);
    ctx.lineTo(horn.x, horn.y);
    ctx.stroke();
  }

  _drawVenom(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const base = camera.worldToScreen(cx, cy, plinthH, this._p0);

    // Pressurized glass-and-brass vats (1 at T1, 2 at T2+, 3-4 cluster visual)
    const vatCount = tier === 1 ? 1 : (tier >= 3 ? 3 : 2);
    for (let v = 0; v < vatCount; v++) {
      const ang = vatCount === 1 ? 0 : (v * Math.PI * 2) / vatCount + 0.5;
      const off = vatCount === 1 ? 0 : 0.32;
      const vx = cx + Math.cos(ang) * off;
      const vy = cy + Math.sin(ang) * off;
      const vBot = camera.worldToScreen(vx, vy, plinthH, this._p1);
      const vTop = camera.worldToScreen(vx, vy, plinthH + 0.58 + tier * 0.05, this._p2);
      const vw = scale * (vatCount === 1 ? 0.34 : 0.22);

      // Emerald liquid cylinder
      ctx.fillStyle = 'rgba(22, 163, 74, 0.55)';
      ctx.fillRect(vTop.x - vw * 0.85, vTop.y, vw * 1.7, vBot.y - vTop.y);

      // Glass rim & brass caps
      ctx.strokeStyle = '#a7f3d0';
      ctx.lineWidth = Math.max(1, scale * 0.03);
      ctx.strokeRect(vTop.x - vw * 0.85, vTop.y, vw * 1.7, vBot.y - vTop.y);

      ctx.fillStyle = '#b47b49';
      ctx.fillRect(vTop.x - vw, vTop.y - scale * 0.05, vw * 2, scale * 0.09);
      ctx.fillRect(vBot.x - vw, vBot.y - scale * 0.05, vw * 2, scale * 0.09);

      // Rising emerald bubbles inside glass vat
      for (let b = 0; b < 3; b++) {
        const phase = (timeSec * 0.85 + b * 0.33 + v * 0.21) % 1;
        const bx = vBot.x + Math.sin(timeSec * 4 + b + v) * vw * 0.38;
        const by = vBot.y - phase * (vBot.y - vTop.y) * 0.88;
        ctx.fillStyle = 'rgba(134, 239, 172, 0.88)';
        ctx.beginPath();
        ctx.arc(bx, by, scale * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Peristaltic crank arms rotating continuously
    const crankA = timeSec * 3.1;
    const crankPin = camera.worldToScreen(cx + Math.cos(crankA) * 0.45, cy + Math.sin(crankA) * 0.45, plinthH + 0.24, this._p3);
    ctx.strokeStyle = '#d4a238';
    ctx.lineWidth = Math.max(1.5, scale * 0.055);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y - scale * 0.14);
    ctx.lineTo(crankPin.x, crankPin.y);
    ctx.stroke();
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.arc(crankPin.x, crankPin.y, scale * 0.07, 0, Math.PI * 2);
    ctx.fill();

    // Top yaw-tracking brass alchemical nozzle
    const head = camera.worldToScreen(cx, cy, plinthH + 0.65 + tier * 0.05, this._p1);
    const nozzle = this._projLocal(head.x, head.y, fx, fy, scale, 0.48 - recoil * 0.18, 0, 0.04, this._p2);
    ctx.strokeStyle = '#ca8a04';
    ctx.lineWidth = Math.max(2.5, scale * 0.12);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(head.x, head.y);
    ctx.lineTo(nozzle.x, nozzle.y);
    ctx.stroke();

    ctx.fillStyle = `rgba(74, 222, 128, ${0.45 + chargeGlow * 0.5})`;
    ctx.beginPath();
    ctx.arc(nozzle.x, nozzle.y, scale * (0.09 + chargeGlow * 0.08), 0, Math.PI * 2);
    ctx.fill();
  }

  _drawBrazier(ctx, camera, cx, cy, plinthH, scale, tier, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const base = camera.worldToScreen(cx, cy, plinthH, this._p0);
    const bowl = camera.worldToScreen(cx, cy, plinthH + 0.42, this._p1);

    // Pumping leather bellows on flanks
    const bellowBreath = 0.78 + 0.22 * Math.sin(timeSec * 4.4);
    for (let side = -1; side <= 1; side += 2) {
      const bPos = this._projLocal(base.x, base.y, fx, fy, scale, -0.1, side * 0.56, 0.16, this._p2);
      ctx.fillStyle = '#573628';
      ctx.beginPath();
      drawEllipse(ctx, bPos.x, bPos.y, scale * 0.22 * bellowBreath, scale * 0.14);
      ctx.fill();
      ctx.strokeStyle = '#a16207';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Volcanic basalt jaws cradling molten bowl
    ctx.fillStyle = '#1c1917';
    ctx.beginPath();
    ctx.moveTo(base.x - scale * 0.52, base.y);
    ctx.lineTo(bowl.x - scale * 0.42, bowl.y);
    ctx.lineTo(bowl.x + scale * 0.42, bowl.y);
    ctx.lineTo(base.x + scale * 0.52, base.y);
    ctx.closePath();
    ctx.fill();

    // Roaring fire core
    const flicker = 0.85 + 0.15 * Math.sin(timeSec * 9.3);
    ctx.fillStyle = `rgba(239, 68, 68, ${0.65 + chargeGlow * 0.3})`;
    ctx.beginPath();
    drawEllipse(ctx, bowl.x, bowl.y, scale * 0.36 * flicker, scale * 0.24 * flicker);
    ctx.fill();

    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(bowl.x - scale * 0.2, bowl.y);
    ctx.lineTo(bowl.x, bowl.y - scale * (0.36 + tier * 0.06 + chargeGlow * 0.18) * flicker);
    ctx.lineTo(bowl.x + scale * 0.2, bowl.y);
    ctx.closePath();
    ctx.fill();

    // Basalt fang jaw tracking yaw
    const jawTip = this._projLocal(bowl.x, bowl.y, fx, fy, scale, 0.48 + recoil * 0.12, 0, 0.1, this._p3);
    ctx.strokeStyle = '#44403c';
    ctx.lineWidth = Math.max(2.5, scale * 0.14);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bowl.x, bowl.y);
    ctx.lineTo(jawTip.x, jawTip.y);
    ctx.stroke();

    // Swaying ember lanterns
    const lanternCount = tier >= 3 ? 2 : 1;
    for (let l = 0; l < lanternCount; l++) {
      const side = l === 0 ? -1 : 1;
      const sway = Math.sin(timeSec * 2.8 + l * 1.9) * 0.09;
      const hook = camera.worldToScreen(cx + side * 0.58, cy + 0.18, plinthH + 0.48, this._p4);
      const lantern = camera.worldToScreen(cx + side * 0.58 + sway, cy + 0.18, plinthH + 0.22, this._p5);
      ctx.strokeStyle = '#78716c';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(hook.x, hook.y);
      ctx.lineTo(lantern.x, lantern.y);
      ctx.stroke();
      ctx.fillStyle = '#fb923c';
      ctx.beginPath();
      ctx.arc(lantern.x, lantern.y, scale * 0.075, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ==================== 9 HYBRID FUSIONS ====================

  _drawGlacialObelisk(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const base = camera.worldToScreen(cx, cy, plinthH, this._p0);
    const tip = camera.worldToScreen(cx, cy, plinthH + 1.28, this._p1);

    // Tall diamond cryo-obelisk
    ctx.fillStyle = '#0369a1';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(base.x - scale * 0.34, base.y);
    ctx.lineTo(base.x, base.y + scale * 0.12);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(base.x + scale * 0.34, base.y);
    ctx.lineTo(base.x, base.y + scale * 0.12);
    ctx.closePath();
    ctx.fill();

    // Electrified Tesla rings around obelisk
    for (let r = 0; r < 2; r++) {
      const rp = camera.worldToScreen(cx, cy, plinthH + 0.45 + r * 0.35, this._p2);
      ctx.strokeStyle = r === 0 ? '#f59e0b' : '#bae6fd';
      ctx.lineWidth = Math.max(1.4, scale * 0.05);
      ctx.beginPath();
      drawEllipse(ctx, rp.x, rp.y, scale * (0.52 - r * 0.1), scale * (0.2 - r * 0.03), timeSec * (r === 0 ? 1.8 : -2.2));
      ctx.stroke();
    }

    // Yaw cryo-lance emitter
    const lance = this._projLocal(tip.x, tip.y, fx, fy, scale, 0.48 - recoil * 0.16, 0, -0.1, this._p3);
    ctx.strokeStyle = '#e0f2fe';
    ctx.lineWidth = Math.max(2, scale * 0.08);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y + scale * 0.18);
    ctx.lineTo(lance.x, lance.y);
    ctx.stroke();

    if (chargeGlow > 0.05) {
      ctx.fillStyle = `rgba(186, 230, 253, ${0.4 + chargeGlow * 0.5})`;
      ctx.beginPath();
      ctx.arc(lance.x, lance.y, scale * 0.14, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawHellfireMortar(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const pivot = camera.worldToScreen(cx, cy, plinthH + 0.14, this._p0);

    // Molten slag boiler core
    const slagPulse = 0.75 + 0.25 * Math.sin(timeSec * 6.5);
    const boiler = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.26, 0, 0.28, this._p1);
    ctx.fillStyle = '#292524';
    ctx.beginPath();
    ctx.arc(boiler.x, boiler.y, scale * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(249, 115, 22, ${0.8 * slagPulse})`;
    ctx.beginPath();
    ctx.arc(boiler.x, boiler.y, scale * 0.18, 0, Math.PI * 2);
    ctx.fill();

    // Heavy armored hellfire siege barrel
    const kick = recoil * 0.25;
    const b0 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.12 - kick, 0, 0.22, this._p2);
    const b1 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.56 - kick * 0.8, 0, 0.82 - kick * 0.3, this._p3);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1c1917';
    ctx.lineWidth = scale * 0.42;
    ctx.beginPath();
    ctx.moveTo(b0.x, b0.y);
    ctx.lineTo(b1.x, b1.y);
    ctx.stroke();

    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = scale * 0.16;
    ctx.beginPath();
    ctx.moveTo(b0.x, b0.y);
    ctx.lineTo(b1.x, b1.y);
    ctx.stroke();

    ctx.fillStyle = `rgba(253, 224, 71, ${0.65 + chargeGlow * 0.35})`;
    ctx.beginPath();
    ctx.arc(b1.x, b1.y, scale * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawPlagueCoil(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const base = camera.worldToScreen(cx, cy, plinthH, this._p0);
    const top = camera.worldToScreen(cx, cy, plinthH + 0.92, this._p1);

    // Emerald glass venom cylinder core
    ctx.fillStyle = 'rgba(34, 197, 94, 0.65)';
    ctx.fillRect(top.x - scale * 0.18, top.y, scale * 0.36, base.y - top.y);
    ctx.strokeStyle = '#86efac';
    ctx.lineWidth = 1.4;
    ctx.strokeRect(top.x - scale * 0.18, top.y, scale * 0.36, base.y - top.y);

    // Triple electrified copper coils orbiting vat
    const mid = camera.worldToScreen(cx, cy, plinthH + 0.5, this._p2);
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = i % 2 === 0 ? '#4ade80' : '#f59e0b';
      ctx.lineWidth = Math.max(1.3, scale * 0.048);
      ctx.beginPath();
      drawEllipse(ctx, mid.x, mid.y, scale * 0.52, scale * 0.2, timeSec * 2.1 + (i * Math.PI) / 3);
      ctx.stroke();
    }

    // Arcing toxic discharge emitter
    const prong = this._projLocal(top.x, top.y, fx, fy, scale, 0.42 - recoil * 0.12, 0, 0.05, this._p3);
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = Math.max(1.8, scale * 0.07);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(prong.x, prong.y);
    ctx.stroke();
    ctx.fillStyle = `rgba(134, 239, 172, ${0.5 + chargeGlow * 0.5})`;
    ctx.beginPath();
    ctx.arc(prong.x, prong.y, scale * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawShatterCannon(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const pivot = camera.worldToScreen(cx, cy, plinthH + 0.14, this._p0);

    // Twin cryo coolant canisters on flanks
    for (let s = -1; s <= 1; s += 2) {
      const tank = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.1, s * 0.44, 0.25, this._p1);
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.arc(tank.x, tank.y, scale * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#bae6fd';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // Heavy frost-forged cannon barrel
    const kick = recoil * 0.22;
    const b0 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.16 - kick, 0, 0.22, this._p2);
    const b1 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.56 - kick * 0.8, 0, 0.74 - kick * 0.3, this._p3);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = scale * 0.36;
    ctx.beginPath();
    ctx.moveTo(b0.x, b0.y);
    ctx.lineTo(b1.x, b1.y);
    ctx.stroke();

    ctx.strokeStyle = '#7dd3fc';
    ctx.lineWidth = scale * 0.16;
    ctx.beginPath();
    ctx.moveTo(b0.x, b0.y);
    ctx.lineTo(b1.x, b1.y);
    ctx.stroke();

    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath();
    ctx.arc(b1.x, b1.y, scale * (0.13 + chargeGlow * 0.08), 0, Math.PI * 2);
    ctx.fill();
  }

  _drawRailgunBastion(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const pivot = camera.worldToScreen(cx, cy, plinthH + 0.22, this._p0);
    const kick = recoil * 0.2;

    // Parallel twin electromagnetic accelerator rails
    const rL0 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.35 - kick, -0.18, 0.24, this._p1);
    const rL1 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.78 - kick, -0.14, 0.28, this._p2);
    const rR0 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.35 - kick, 0.18, 0.24, this._p3);
    const rR1 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.78 - kick, 0.14, 0.28, this._p4);

    // Plasma channel between rails
    const c0 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.25 - kick, 0, 0.24, this._p5);
    const c1 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.76 - kick, 0, 0.28, this._p6);
    const pulse = 0.55 + 0.45 * Math.sin(timeSec * 8) + chargeGlow * 0.5;
    ctx.strokeStyle = `rgba(96, 165, 250, ${clamp(pulse, 0.3, 1)})`;
    ctx.lineWidth = Math.max(2, scale * 0.12);
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.stroke();

    // Copper-and-steel outer rails
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = Math.max(2, scale * 0.095);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(rL0.x, rL0.y);
    ctx.lineTo(rL1.x, rL1.y);
    ctx.moveTo(rR0.x, rR0.y);
    ctx.lineTo(rR1.x, rR1.y);
    ctx.stroke();

    // Capacitor fins
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = Math.max(1.5, scale * 0.05);
    for (let k = 0; k < 3; k++) {
      const t = 0.15 + k * 0.24;
      const finL = this._projLocal(pivot.x, pivot.y, fx, fy, scale, t - kick, -0.26, 0.26, this._p5);
      const finR = this._projLocal(pivot.x, pivot.y, fx, fy, scale, t - kick, 0.26, 0.26, this._p6);
      ctx.beginPath();
      ctx.moveTo(finL.x, finL.y);
      ctx.lineTo(finR.x, finR.y);
      ctx.stroke();
    }
  }

  _drawViperGatling(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const pivot = camera.worldToScreen(cx, cy, plinthH + 0.2, this._p0);
    const kick = recoil * 0.12;

    // Pressurized emerald venom ammo drum on side
    const drum = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.15, -0.34, 0.22, this._p1);
    ctx.fillStyle = '#16a34a';
    ctx.beginPath();
    ctx.arc(drum.x, drum.y, scale * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#d4a238';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 6-barrel rotating brass gatling assembly
    const spin = timeSec * (8.5 + recoil * 10);
    for (let b = 0; b < 6; b++) {
      const a = spin + (b * Math.PI) / 3;
      const ly = Math.cos(a) * 0.14;
      const lz = 0.26 + Math.sin(a) * 0.14;
      const b0 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.05 - kick, ly, lz, this._p2);
      const b1 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.68 - kick, ly, lz, this._p3);
      ctx.strokeStyle = b % 2 === 0 ? '#d4a238' : '#94a3b8';
      ctx.lineWidth = Math.max(1.3, scale * 0.055);
      ctx.beginPath();
      ctx.moveTo(b0.x, b0.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.stroke();
    }

    // Venom tip glow
    const tip = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.72 - kick, 0, 0.26, this._p4);
    ctx.fillStyle = `rgba(74, 222, 128, ${0.42 + chargeGlow * 0.48})`;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, scale * 0.11, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawSingularityCatapult(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const pivot = camera.worldToScreen(cx, cy, plinthH + 0.14, this._p0);

    // Side frame stanchions
    const stL = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.08, -0.34, 0.45, this._p1);
    const stR = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.08, 0.34, 0.45, this._p2);
    ctx.strokeStyle = '#6d28d9';
    ctx.lineWidth = Math.max(2, scale * 0.08);
    ctx.beginPath();
    ctx.moveTo(pivot.x, pivot.y);
    ctx.lineTo(stL.x, stL.y);
    ctx.moveTo(pivot.x, pivot.y);
    ctx.lineTo(stR.x, stR.y);
    ctx.moveTo(stL.x, stL.y);
    ctx.lineTo(stR.x, stR.y);
    ctx.stroke();

    // Swinging torsion throwing arm (whips forward on recoil!)
    const whip = recoil * 0.9;
    const armLx = -0.38 + whip * 0.72;
    const armLz = 0.25 + whip * 0.65;
    const armTip = this._projLocal(pivot.x, pivot.y, fx, fy, scale, armLx, 0, armLz, this._p3);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = Math.max(2, scale * 0.09);
    ctx.beginPath();
    ctx.moveTo(pivot.x, pivot.y);
    ctx.lineTo(armTip.x, armTip.y);
    ctx.stroke();

    // Floating dark-matter singularity orb
    const orb = this._projLocal(pivot.x, pivot.y, fx, fy, scale, armLx + 0.04, 0, armLz + 0.18, this._p4);
    ctx.fillStyle = `rgba(168, 85, 247, ${0.4 + chargeGlow * 0.4})`;
    ctx.beginPath();
    ctx.arc(orb.x, orb.y, scale * 0.24, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#090514';
    ctx.beginPath();
    ctx.arc(orb.x, orb.y, scale * 0.13, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#e9d5ff';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    drawEllipse(ctx, orb.x, orb.y, scale * 0.28, scale * 0.1, timeSec * 2.5);
    ctx.stroke();
  }

  _drawSolarFlare(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const base = camera.worldToScreen(cx, cy, plinthH, this._p0);
    const core = camera.worldToScreen(cx, cy, plinthH + 0.72, this._p1);

    // Gilded solar mirror petals
    for (let i = 0; i < 4; i++) {
      const a = timeSec * 0.6 + (i * Math.PI) / 2;
      const petal = camera.worldToScreen(cx + Math.cos(a) * 0.44, cy + Math.sin(a) * 0.44, plinthH + 0.48, this._p2);
      ctx.fillStyle = '#d4a238';
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(petal.x - scale * 0.1, petal.y);
      ctx.lineTo(petal.x + scale * 0.1, petal.y);
      ctx.closePath();
      ctx.fill();
    }

    // Blazing sun-forge prism & corona rings
    ctx.fillStyle = `rgba(250, 204, 21, ${0.38 + chargeGlow * 0.4})`;
    ctx.beginPath();
    ctx.arc(core.x, core.y, scale * 0.34, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fef9c3';
    ctx.beginPath();
    ctx.arc(core.x, core.y, scale * 0.17, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#fb923c';
    ctx.lineWidth = Math.max(1.3, scale * 0.045);
    ctx.beginPath();
    drawEllipse(ctx, core.x, core.y, scale * 0.48, scale * 0.18, timeSec * 2.2);
    ctx.stroke();

    // Directional solar lens tracking yaw
    const lens = this._projLocal(core.x, core.y, fx, fy, scale, 0.36 - recoil * 0.08, 0, 0, this._p3);
    ctx.fillStyle = '#fef08a';
    ctx.beginPath();
    ctx.arc(lens.x, lens.y, scale * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawWindchillFlak(ctx, camera, cx, cy, plinthH, scale, yaw, chargeGlow, recoil, timeSec, pal) {
    const fx = Math.cos(yaw);
    const fy = Math.sin(yaw);
    const pivot = camera.worldToScreen(cx, cy, plinthH + 0.18, this._p0);
    const kick = recoil * 0.18;

    // Rotating elevation drum
    this._drawBrassGear(ctx, pivot.x, pivot.y, scale * 0.28, 10, timeSec * 1.8);

    // Twin flexing frost-prods
    const tipL = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.1 - kick, -0.58, 0.34, this._p1);
    const tipR = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.1 - kick, 0.58, 0.34, this._p2);
    const mid = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.35 - kick, 0, 0.36, this._p3);
    ctx.strokeStyle = '#7dd3fc';
    ctx.lineWidth = Math.max(2, scale * 0.085);
    ctx.beginPath();
    ctx.moveTo(tipL.x, tipL.y);
    ctx.quadraticCurveTo(mid.x, mid.y, tipR.x, tipR.y);
    ctx.stroke();

    // Quad cryo-harpoon barrels angled slightly upward for AA flak
    for (let i = 0; i < 4; i++) {
      const row = i < 2 ? 0.14 : -0.14;
      const zOff = i % 2 === 0 ? 0.42 : 0.24;
      const b0 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, -0.08 - kick, row, zOff, this._p4);
      const b1 = this._projLocal(pivot.x, pivot.y, fx, fy, scale, 0.62 - kick, row, zOff + 0.18, this._p5);
      ctx.strokeStyle = '#bae6fd';
      ctx.lineWidth = Math.max(1.5, scale * 0.06);
      ctx.beginPath();
      ctx.moveTo(b0.x, b0.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.stroke();
    }

    if (chargeGlow > 0.05) {
      ctx.fillStyle = `rgba(186, 230, 253, ${0.4 + chargeGlow * 0.45})`;
      ctx.beginPath();
      ctx.arc(mid.x, mid.y, scale * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export { BASE_TOWER_IDS, FUSION_TOWER_IDS };
