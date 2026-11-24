import {
  CREEP_ARCHETYPE_IDS,
  MAX_CREEPS,
  CAMERA_PITCH_Y,
  CAMERA_ELEV_SCALE,
} from '../contracts/types.js';

const TAU = Math.PI * 2;
const SHELL_GAPS = Object.freeze([701, 301, 132, 57, 23, 10, 4, 1]);
const DASH_NONE = Object.freeze([]);
const DASH_CHAIN = Object.freeze([4, 3]);

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function projectWorld(camera, wx, wy, wz, out) {
  if (camera && typeof camera.worldToScreen === 'function') {
    const res = camera.worldToScreen(wx, wy, wz, out);
    if (res && res !== out) {
      out.x = res.x;
      out.y = res.y;
    }
    return out;
  }
  const s = (camera && Number.isFinite(camera.scale)) ? camera.scale : 36;
  out.x = wx * s;
  out.y = (wy * CAMERA_PITCH_Y - wz * CAMERA_ELEV_SCALE) * s;
  return out;
}

function drawEllipsePath(ctx, cx, cy, rx, ry) {
  ctx.beginPath();
  if (typeof ctx.ellipse === 'function') {
    ctx.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, TAU);
    return;
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(Math.max(0.5, rx), Math.max(0.5, ry));
  ctx.arc(0, 0, 1, 0, TAU);
  ctx.restore();
}

function drawHexagon(ctx, cx, cy, r, pitchY = 1) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i * TAU) / 6 - Math.PI / 6;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r * pitchY;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawCrownEmblem(ctx, cx, cy, size, fillColor, strokeColor) {
  const hw = size * 0.65;
  const h = size * 0.55;
  ctx.fillStyle = fillColor;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = Math.max(1, size * 0.12);
  ctx.beginPath();
  ctx.moveTo(cx - hw, cy + h * 0.45);
  ctx.lineTo(cx - hw * 1.08, cy - h * 0.35);
  ctx.lineTo(cx - hw * 0.45, cy + h * 0.05);
  ctx.lineTo(cx, cy - h * 0.65);
  ctx.lineTo(cx + hw * 0.45, cy + h * 0.05);
  ctx.lineTo(cx + hw * 1.08, cy - h * 0.35);
  ctx.lineTo(cx + hw, cy + h * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Crown jewel
  ctx.fillStyle = '#fef08a';
  ctx.beginPath();
  ctx.arc(cx, cy + h * 0.08, Math.max(1.2, size * 0.12), 0, TAU);
  ctx.fill();
}

function resolveBossVariant(creep) {
  const raw = String(creep.bossVariant || creep.bossTitle || creep.bossName || creep.name || creep.variant || '').toLowerCase();
  if (raw.includes('zephyria')) return 'zephyria';
  if (raw.includes('malakor')) return 'malakor';
  if (raw.includes('marrow')) return 'marrow_crag';
  if (creep.armorType === 'Fortified') return 'zephyria';
  const w = Number(creep.wave || 0);
  if (w > 0) {
    const mod = w % 30;
    if (mod === 20) return 'zephyria';
    if (mod === 0) return 'malakor';
  }
  return 'marrow_crag';
}

function resolveCreepYaw(creep) {
  if (Number.isFinite(creep.yaw)) return creep.yaw;
  const vx = creep.vx || 0;
  const vy = creep.vy || 0;
  if (vx * vx + vy * vy > 1e-4) return Math.atan2(vy, vx);
  return 0;
}

/**
 * Renders all 8 articulated procedural creep archetypes in depth-sorted 2.5D,
 * plus live animated HUD portrait busts, with zero blur passes and zero combat GC.
 */
export class CreepRigRenderer {
  constructor() {
    this._maxCreeps = MAX_CREEPS;
    this._sortIndices = new Int32Array(MAX_CREEPS);
    this._sortDepths = new Float32Array(MAX_CREEPS);
    this._creepsRef = new Array(MAX_CREEPS);
    this._interpX = new Float32Array(MAX_CREEPS);
    this._interpY = new Float32Array(MAX_CREEPS);
    this._interpZ = new Float32Array(MAX_CREEPS);

    this._pt = { x: 0, y: 0 };
    this._ptGround = { x: 0, y: 0 };
    this._ptJitter = { x: 0, y: 0 };
  }

  /**
   * Depth-sorts active creeps by interpolated world Y and draws rigs, bars, and status overlays.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} camera
   * @param {object} sim
   * @param {number} [alpha=1]
   * @param {number} [timeSec=0]
   * @param {number} [selectedCreepId=-1]
   * @param {object|null} [statusOverlayRenderer=null]
   */
  renderCreeps(ctx, camera, sim, alpha = 1, timeSec = 0, selectedCreepId = -1, statusOverlayRenderer = null) {
    if (!ctx || !sim) return;
    const pool = sim.creeps || sim.creepPool;
    if (!pool) return;

    const a = clamp01(Number.isFinite(alpha) ? alpha : 1);
    const scale = (camera && typeof camera.getScale === 'function')
      ? camera.getScale()
      : (camera && Number.isFinite(camera.scale) ? camera.scale : 36);

    let hasBounds = false;
    let minX = -Infinity;
    let maxX = Infinity;
    let minY = -Infinity;
    let maxY = Infinity;
    if (camera && typeof camera.getVisibleWorldBounds === 'function') {
      const b = camera.getVisibleWorldBounds();
      if (b && Number.isFinite(b.minX)) {
        hasBounds = true;
        minX = b.minX - 2.5;
        maxX = b.maxX + 2.5;
        minY = b.minY - 2.5;
        maxY = b.maxY + 2.5;
      }
    }

    let count = 0;
    const maxCap = this._maxCreeps;

    if (Array.isArray(pool)) {
      for (let i = 0; i < pool.length && count < maxCap; i++) {
        const c = pool[i];
        if (!c || c.active === false) continue;
        count = this._pushActiveCreep(c, count, a, hasBounds, minX, maxX, minY, maxY);
      }
    } else if (typeof pool[Symbol.iterator] === 'function') {
      for (const c of pool) {
        if (!c || c.active === false) continue;
        count = this._pushActiveCreep(c, count, a, hasBounds, minX, maxX, minY, maxY);
        if (count >= maxCap) break;
      }
    }

    if (count === 0) return;

    // Zero-allocation Shell sort on _sortIndices by _sortDepths
    this._sortActiveByDepth(count);

    const prevAlpha = ctx.globalAlpha;

    for (let k = 0; k < count; k++) {
      const idx = this._sortIndices[k];
      const creep = this._creepsRef[idx];
      const wx = this._interpX[idx];
      const wy = this._interpY[idx];
      const wz = this._interpZ[idx];

      projectWorld(camera, wx, wy, 0, this._ptGround);
      projectWorld(camera, wx, wy, wz, this._pt);

      const gx = this._ptGround.x;
      const gy = this._ptGround.y;
      let sx = this._pt.x;
      let sy = this._pt.y;

      // Apply skeletal micro-jitter if shocked
      if ((creep.shockTimer || 0) > 0) {
        if (statusOverlayRenderer && typeof statusOverlayRenderer.getShockJitter === 'function') {
          statusOverlayRenderer.getShockJitter(creep, timeSec, this._ptJitter);
        } else {
          const seed = (creep.id || idx + 1) * 1.731;
          this._ptJitter.x = Math.sin(timeSec * 73 + seed) * 2.0;
          this._ptJitter.y = Math.cos(timeSec * 83 + seed) * 1.4;
        }
        sx += this._ptJitter.x;
        sy += this._ptJitter.y;
      }

      // Ground selection reticle if selected
      if (selectedCreepId != null && creep.id === selectedCreepId) {
        this._drawSelectionRing(ctx, gx, gy, scale, creep, timeSec);
      }

      // Draw articulated creep rig
      ctx.save();
      this._renderArchetype(ctx, creep, sx, sy, gx, gy, wz, scale, timeSec, false);
      ctx.restore();

      // Status overlays (Chill/Freeze, Acid, Shock, Ignite, Knock-up)
      if (statusOverlayRenderer && typeof statusOverlayRenderer.renderCreepStatuses === 'function') {
        ctx.save();
        statusOverlayRenderer.renderCreepStatuses(ctx, sx, sy, gy, scale, creep, timeSec);
        ctx.restore();
      }

      // Grounded crisp HP + shield mini-bars (or multi-segment boss bar)
      const hp = creep.hp ?? 100;
      const maxHp = creep.maxHp ?? 100;
      const shield = creep.shield || 0;
      const isBoss = Boolean(creep.isBoss || creep.archetypeId === 'act_boss');
      if (isBoss || hp < maxHp || shield > 0) {
        ctx.save();
        this._drawHealthAndShieldBar(ctx, sx, sy, scale, creep, isBoss);
        ctx.restore();
      }
    }

    ctx.globalAlpha = prevAlpha;
  }

  /**
   * Renders a live animated bust/silhouette of a creep inside the 112x112 HUD portrait canvas.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {number} height
   * @param {object} creep
   * @param {number} [timeSec=0]
   * @param {object|null} [statusOverlayRenderer=null]
   */
  renderPortraitCreep(ctx, width, height, creep, timeSec = 0, statusOverlayRenderer = null) {
    if (!ctx || !creep) return;
    const w = Math.max(32, width || 112);
    const h = Math.max(32, height || 112);
    const prevAlpha = ctx.globalAlpha;

    ctx.save();

    // Obsidian Bastion backdrop
    ctx.fillStyle = '#0a0e17';
    ctx.fillRect(0, 0, w, h);

    const isBoss = Boolean(creep.isBoss || creep.archetypeId === 'act_boss');
    const rimColor = isBoss ? 'rgba(212, 162, 56, 0.25)' : 'rgba(56, 189, 248, 0.16)';
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.52, Math.min(w, h) * 0.44, 0, TAU);
    ctx.fill();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rimColor;
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.52, Math.min(w, h) * 0.44, 0, TAU);
    ctx.stroke();

    // Subtle stone pedestal shadow
    const cx = w * 0.5;
    const baseY = h * 0.78;
    const bustY = h * 0.62;
    const scale = Math.min(w, h) * (isBoss ? 0.42 : (creep.archetypeId === 'brood_arachnid' || creep.archetypeId === 'sky_wyvern' ? 0.54 : 0.62));

    let sx = cx;
    let sy = bustY;
    if ((creep.shockTimer || 0) > 0 && statusOverlayRenderer && typeof statusOverlayRenderer.getShockJitter === 'function') {
      statusOverlayRenderer.getShockJitter(creep, timeSec, this._ptJitter);
      sx += this._ptJitter.x;
      sy += this._ptJitter.y;
    }

    this._renderArchetype(ctx, creep, sx, sy, cx, baseY, 0, scale, timeSec, true);

    if (statusOverlayRenderer && typeof statusOverlayRenderer.renderCreepStatuses === 'function') {
      statusOverlayRenderer.renderCreepStatuses(ctx, sx, sy, baseY, scale * 0.85, creep, timeSec);
    }

    // Inner portrait border frame
    ctx.strokeStyle = isBoss ? 'rgba(212, 162, 56, 0.6)' : 'rgba(100, 116, 139, 0.45)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);

    ctx.restore();
    ctx.globalAlpha = prevAlpha;
  }

  _pushActiveCreep(c, count, alpha, hasBounds, minX, maxX, minY, maxY) {
    const cx = Number.isFinite(c.x) ? c.x : 0;
    const cy = Number.isFinite(c.y) ? c.y : 0;
    const px = Number.isFinite(c.prevX) ? c.prevX : cx;
    const py = Number.isFinite(c.prevY) ? c.prevY : cy;

    const ix = px + (cx - px) * alpha;
    const iy = py + (cy - py) * alpha;

    if (hasBounds && (ix < minX || ix > maxX || iy < minY || iy > maxY)) {
      return count;
    }

    let cz = Number.isFinite(c.z) ? c.z : (c.archetypeId === 'sky_wyvern' && !((c.earthboundTimer || 0) > 0) ? 1.15 : 0);
    const pz = Number.isFinite(c.prevZ) ? c.prevZ : cz;
    const iz = pz + (cz - pz) * alpha;

    this._creepsRef[count] = c;
    this._sortIndices[count] = count;
    this._interpX[count] = ix;
    this._interpY[count] = iy;
    this._interpZ[count] = iz;
    this._sortDepths[count] = iy + ((c.isFlying && !((c.earthboundTimer || 0) > 0)) ? 0.025 : 0);
    return count + 1;
  }

  _sortActiveByDepth(n) {
    const indices = this._sortIndices;
    const depths = this._sortDepths;
    for (let g = 0; g < SHELL_GAPS.length; g++) {
      const gap = SHELL_GAPS[g];
      if (gap >= n) continue;
      for (let i = gap; i < n; i++) {
        const tempIdx = indices[i];
        const tempDepth = depths[tempIdx];
        let j = i;
        while (j >= gap && depths[indices[j - gap]] > tempDepth) {
          indices[j] = indices[j - gap];
          j -= gap;
        }
        indices[j] = tempIdx;
      }
    }
  }

  _drawSelectionRing(ctx, gx, gy, scale, creep, timeSec) {
    const rad = scale * (creep.isBoss ? 0.72 : (creep.isSplitChild ? 0.34 : 0.48));
    const pulse = 1 + 0.07 * Math.sin(timeSec * 6);
    const rx = rad * pulse;
    const ry = rx * CAMERA_PITCH_Y;

    ctx.save();
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';
    ctx.lineWidth = 2.2;
    drawEllipsePath(ctx, gx, gy, rx, ry);
    ctx.stroke();

    // Rotating cardinal lock-on ticks
    ctx.strokeStyle = 'rgba(254, 240, 138, 0.95)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 4; i++) {
      const a = timeSec * 1.4 + (i * Math.PI) * 0.5;
      const ca = Math.cos(a);
      const sa = Math.sin(a) * CAMERA_PITCH_Y;
      ctx.beginPath();
      ctx.moveTo(gx + ca * rx * 0.84, gy + sa * rx * 0.84);
      ctx.lineTo(gx + ca * rx * 1.15, gy + sa * rx * 1.15);
      ctx.stroke();
    }
    ctx.restore();
  }

  _renderArchetype(ctx, creep, sx, sy, gx, gy, wz, scale, timeSec, isPortrait) {
    const archetype = creep.archetypeId || CREEP_ARCHETYPE_IDS[0];
    const yaw = isPortrait ? 0.25 : resolveCreepYaw(creep);
    const dir = Math.cos(yaw) >= -0.05 ? 1 : -1;
    const chillSlow = 1 - clamp01(creep.chillPct || ((creep.chillTimer || 0) > 0 ? 0.3 : 0)) * 0.65;
    const frozen = (creep.frozenTimer || 0) > 0;
    const phase = Number.isFinite(creep.walkPhase)
      ? creep.walkPhase
      : (frozen ? 0 : timeSec * 7.2 * chillSlow + (creep.id || 0) * 0.8);

    switch (archetype) {
      case 'ghoul_swarm':
        this._drawGhoulSwarm(ctx, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait);
        break;
      case 'ironclad_grunt':
        this._drawIroncladGrunt(ctx, creep, sx, sy, gx, gy, scale, dir, phase, isPortrait);
        break;
      case 'brood_arachnid':
        this._drawBroodArachnid(ctx, sx, sy, gx, gy, scale, yaw, phase, isPortrait);
        break;
      case 'sky_wyvern':
        this._drawSkyWyvern(ctx, creep, sx, sy, gx, gy, wz, scale, dir, phase, timeSec, isPortrait);
        break;
      case 'blood_shaman':
        this._drawBloodShaman(ctx, creep, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait);
        break;
      case 'bulwark_golem':
        this._drawBulwarkGolem(ctx, creep, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait);
        break;
      case 'void_splitter':
        this._drawVoidSplitter(ctx, creep, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait);
        break;
      case 'act_boss':
        this._drawActBoss(ctx, creep, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait);
        break;
      default:
        this._drawGhoulSwarm(ctx, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait);
        break;
    }
  }

  _drawGroundShadow(ctx, gx, gy, rx, alpha = 0.36) {
    ctx.fillStyle = `rgba(5, 8, 15, ${alpha.toFixed(3)})`;
    drawEllipsePath(ctx, gx, gy, rx, rx * CAMERA_PITCH_Y);
    ctx.fill();
  }

  // 1. Ghoul Swarm: Hunched claw pack-runner with forward-lunging arms & spine tilt
  _drawGhoulSwarm(ctx, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait) {
    const r = scale * 0.28;
    const stride = Math.sin(phase);
    const bob = Math.abs(Math.cos(phase)) * r * 0.16;

    if (!isPortrait) this._drawGroundShadow(ctx, gx, gy, r * 0.95);

    ctx.save();
    ctx.translate(sx, sy - bob);
    ctx.scale(dir, 1);

    // Back leg
    ctx.strokeStyle = '#451a1a';
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-r * 0.28, r * 0.05);
    ctx.lineTo(-r * (0.42 + stride * 0.25), r * 0.42);
    ctx.lineTo(-r * (0.25 + stride * 0.38), r * 0.78);
    ctx.stroke();

    // Back lunging claw arm
    ctx.strokeStyle = '#7f1d1d';
    ctx.lineWidth = Math.max(1.8, r * 0.18);
    ctx.beginPath();
    ctx.moveTo(r * 0.12, -r * 0.32);
    ctx.lineTo(r * (0.62 - stride * 0.22), -r * 0.12);
    ctx.lineTo(r * (0.98 - stride * 0.22), r * 0.08);
    ctx.stroke();

    // Hunched forward-tilted spine & ribcage torso
    ctx.fillStyle = '#991b1b';
    ctx.strokeStyle = '#2a0e0e';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-r * 0.46, r * 0.14);
    ctx.quadraticCurveTo(-r * 0.22, -r * 0.65, r * 0.36, -r * 0.42);
    ctx.lineTo(r * 0.42, -r * 0.08);
    ctx.lineTo(-r * 0.12, r * 0.22);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Exposed bone spine ridges
    ctx.strokeStyle = '#e7e5e4';
    ctx.lineWidth = Math.max(1.2, r * 0.1);
    for (let i = 0; i < 3; i++) {
      const bx = -r * 0.25 + i * r * 0.22;
      const by = -r * (0.34 + i * 0.05);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - r * 0.14, by - r * 0.18);
      ctx.stroke();
    }

    // Front leg
    ctx.strokeStyle = '#7f1d1d';
    ctx.lineWidth = Math.max(2, r * 0.24);
    ctx.beginPath();
    ctx.moveTo(-r * 0.1, r * 0.12);
    ctx.lineTo(r * (0.12 - stride * 0.28), r * 0.44);
    ctx.lineTo(r * (0.28 - stride * 0.35), r * 0.78);
    ctx.stroke();

    // Feral skull thrust forward
    const headX = r * 0.56;
    const headY = -r * 0.32 + Math.sin(timeSec * 8 + phase) * r * 0.05;
    ctx.fillStyle = '#d6d3d1';
    ctx.strokeStyle = '#292524';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(headX, headY, r * 0.28, 0, TAU);
    ctx.fill();
    ctx.stroke();

    // Snout & glowing amber eye
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(headX + r * 0.12, headY - r * 0.04, Math.max(1.3, r * 0.09), 0, TAU);
    ctx.fill();

    // Forward-lunging primary claw arm + 2 wicked blades
    const clawReach = r * (0.85 + stride * 0.26);
    const clawY = -r * 0.02 + stride * r * 0.12;
    ctx.strokeStyle = '#b91c1c';
    ctx.lineWidth = Math.max(2, r * 0.2);
    ctx.beginPath();
    ctx.moveTo(r * 0.22, -r * 0.22);
    ctx.lineTo(r * 0.54, clawY - r * 0.08);
    ctx.lineTo(clawReach, clawY);
    ctx.stroke();

    ctx.strokeStyle = '#f5f5f4';
    ctx.lineWidth = Math.max(1.2, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(clawReach, clawY);
    ctx.lineTo(clawReach + r * 0.28, clawY + r * 0.16);
    ctx.moveTo(clawReach, clawY - r * 0.04);
    ctx.lineTo(clawReach + r * 0.24, clawY - r * 0.16);
    ctx.stroke();

    ctx.restore();
  }

  // 2. Ironclad Grunt: Layered iron pauldrons + shield plates that darken, pit & peel off with acidStacks
  _drawIroncladGrunt(ctx, creep, sx, sy, gx, gy, scale, dir, phase, isPortrait) {
    const r = scale * 0.37;
    const acidStacks = Math.max(0, Math.min(10, creep.acidStacks || 0));
    const acidFrac = acidStacks / 10;
    const stride = Math.sin(phase);
    const stomp = Math.abs(Math.cos(phase)) * r * 0.1;

    if (!isPortrait) this._drawGroundShadow(ctx, gx, gy, r * 1.1);

    // Metal plate colors darken and turn corroded olive-slate with acidStacks
    const plateR = Math.round(lerp(132, 54, acidFrac));
    const plateG = Math.round(lerp(148, 72, acidFrac));
    const plateB = Math.round(lerp(168, 48, acidFrac));
    const plateFill = `rgb(${plateR},${plateG},${plateB})`;
    const darkR = Math.round(lerp(71, 32, acidFrac));
    const darkG = Math.round(lerp(85, 44, acidFrac));
    const darkB = Math.round(lerp(105, 30, acidFrac));
    const plateDark = `rgb(${darkR},${darkG},${darkB})`;
    const edgeColor = acidFrac > 0.35 ? '#84cc16' : '#cbd5e1';

    ctx.save();
    ctx.translate(sx, sy - stomp);
    ctx.scale(dir, 1);

    // Heavy stomping legs
    ctx.fillStyle = '#334155';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.4;
    ctx.fillRect(-r * 0.42 + stride * r * 0.18, r * 0.18, r * 0.3, r * 0.56);
    ctx.strokeRect(-r * 0.42 + stride * r * 0.18, r * 0.18, r * 0.3, r * 0.56);
    ctx.fillRect(r * 0.12 - stride * r * 0.18, r * 0.22, r * 0.3, r * 0.54);
    ctx.strokeRect(r * 0.12 - stride * r * 0.18, r * 0.22, r * 0.3, r * 0.54);

    // Exposed scarred brute torso beneath armor
    ctx.fillStyle = '#5c4033';
    ctx.fillRect(-r * 0.52, -r * 0.54, r * 1.04, r * 0.86);

    // Chest armor plate (peels/splits at high acidStacks >= 7)
    const chestPeel = acidStacks >= 7 ? (acidStacks - 6) * 0.08 : 0;
    ctx.save();
    ctx.translate(0, -r * 0.12);
    ctx.rotate(chestPeel);
    ctx.fillStyle = plateFill;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-r * 0.54, -r * 0.44);
    ctx.lineTo(r * 0.54, -r * 0.44);
    ctx.lineTo(r * 0.44, r * 0.34);
    ctx.lineTo(-r * 0.44, r * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Corrosion pits on chest plate
    if (acidStacks > 0) {
      const pitCount = Math.min(5, Math.ceil(acidStacks * 0.55));
      ctx.fillStyle = '#14532d';
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = 0.9;
      for (let i = 0; i < pitCount; i++) {
        const px = -r * 0.26 + ((i * 37) % 5) * r * 0.13;
        const py = -r * 0.22 + ((i * 23) % 3) * r * 0.16;
        ctx.beginPath();
        ctx.arc(px, py, r * 0.085, 0, TAU);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    // Left / Rear Iron Pauldron (peels outward when acidStacks >= 4)
    const leftPeel = acidStacks >= 4 ? -0.35 - (acidStacks - 4) * 0.06 : 0;
    ctx.save();
    ctx.translate(-r * 0.58, -r * 0.46 + acidStacks * r * 0.02);
    ctx.rotate(leftPeel);
    ctx.fillStyle = plateDark;
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.34, Math.PI * 0.85, TAU * 0.95);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Helmeted head with visor slit
    ctx.fillStyle = plateDark;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(r * 0.04, -r * 0.72, r * 0.28, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fb7185';
    ctx.fillRect(-r * 0.05, -r * 0.76, r * 0.24, r * 0.08);

    // Right / Front Layered Iron Pauldron (tilts & peels off at acidStacks >= 2)
    const rightPeel = acidStacks >= 2 ? 0.28 + (acidStacks - 2) * 0.07 : 0;
    const rightDrop = acidStacks >= 6 ? r * 0.14 : 0;
    ctx.save();
    ctx.translate(r * 0.52, -r * 0.44 + rightDrop);
    ctx.rotate(rightPeel);
    ctx.fillStyle = plateFill;
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-r * 0.22, -r * 0.16);
    ctx.lineTo(r * 0.28, -r * 0.24);
    ctx.lineTo(r * 0.36, r * 0.18);
    ctx.lineTo(-r * 0.24, r * 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Front Heavy Tower Shield with layered plate & peeling outer lamina
    const shieldPeel = acidStacks >= 5 ? (acidStacks - 4) * 0.08 : 0;
    ctx.save();
    ctx.translate(r * 0.56, -r * 0.04);
    ctx.rotate(shieldPeel * 0.5);
    ctx.fillStyle = plateDark;
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-r * 0.22, -r * 0.38);
    ctx.lineTo(r * 0.28, -r * 0.32);
    ctx.lineTo(r * 0.24, r * 0.36);
    ctx.lineTo(-r * 0.18, r * 0.44);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Shield outer plate peeling away as acidStacks >= 3
    if (acidStacks < 9) {
      ctx.save();
      ctx.translate(acidStacks >= 3 ? r * 0.09 : 0, acidStacks >= 3 ? acidStacks * r * 0.015 : 0);
      ctx.rotate(acidStacks >= 3 ? acidStacks * 0.055 : 0);
      ctx.fillStyle = plateFill;
      ctx.beginPath();
      ctx.moveTo(-r * 0.12, -r * 0.28);
      ctx.lineTo(r * 0.2, -r * 0.24);
      ctx.lineTo(r * 0.16, r * 0.28);
      ctx.lineTo(-r * 0.1, r * 0.32);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    // Shield acid corrosion pits
    if (acidStacks > 0) {
      ctx.fillStyle = '#166534';
      const shieldPits = Math.min(4, acidStacks);
      for (let i = 0; i < shieldPits; i++) {
        ctx.beginPath();
        ctx.arc(r * 0.02 + (i % 2) * r * 0.1, -r * 0.18 + i * r * 0.12, r * 0.06, 0, TAU);
        ctx.fill();
      }
    }

    ctx.restore();
    ctx.restore();
  }

  // 3. Brood Arachnid: 8-legged multi-joint procedural IK gait driven by walkPhase
  _drawBroodArachnid(ctx, sx, sy, gx, gy, scale, yaw, phase, isPortrait) {
    const r = scale * 0.34;
    if (!isPortrait) this._drawGroundShadow(ctx, gx, gy, r * 1.25);

    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const bodyBob = Math.sin(phase * 2) * r * 0.06;
    const bx = sx;
    const by = sy - r * 0.22 + bodyBob;

    // 8 articulated legs (4 per side) with analytical 2-bone IK knee lift
    const femurLen = r * 0.72;
    const tibiaLen = r * 0.82;

    for (let side = -1; side <= 1; side += 2) {
      for (let leg = 0; leg < 4; leg++) {
        // Tetrapod alternating gait phase
        const legOffset = ((leg + (side > 0 ? 1 : 0)) % 2) * Math.PI + leg * 0.35;
        const cycle = phase + legOffset;
        const swing = Math.sin(cycle);
        const lift = Math.max(0, Math.cos(cycle));

        // Base shoulder socket on cephalothorax
        const spreadAngle = yaw + side * (Math.PI * 0.32 + (leg - 1.5) * 0.34);
        const hipX = bx + Math.cos(spreadAngle) * r * 0.34;
        const hipY = by + Math.sin(spreadAngle) * r * 0.26 * CAMERA_PITCH_Y;

        // Ground foot target driven by forward/back stride along yaw + lateral spread
        const footDist = r * (1.12 + (leg === 1 || leg === 2 ? 0.16 : 0));
        const strideShift = swing * r * 0.28;
        const footX = bx + Math.cos(spreadAngle) * footDist + cosY * strideShift;
        const footY = (isPortrait ? by + r * 0.3 : gy) + Math.sin(spreadAngle) * footDist * CAMERA_PITCH_Y + sinY * strideShift * CAMERA_PITCH_Y - lift * r * 0.32;

        // 2-bone analytical IK knee (arching upward in screen -Y)
        const dx = footX - hipX;
        const dy = footY - hipY;
        const dist = Math.max(2, Math.min(femurLen + tibiaLen - 0.5, Math.hypot(dx, dy)));
        const cosAng = Math.max(-1, Math.min(1, (femurLen * femurLen + dist * dist - tibiaLen * tibiaLen) / (2 * femurLen * dist)));
        const baseAng = Math.atan2(dy, dx);
        const bendSign = (hipX <= footX) ? -1 : 1; // always arch knee upward!
        const kneeAngle = baseAng + bendSign * Math.acos(cosAng);

        const kneeX = hipX + Math.cos(kneeAngle) * femurLen;
        const kneeY = hipY + Math.sin(kneeAngle) * femurLen - r * 0.12;

        // Femur
        ctx.strokeStyle = '#1e1b2e';
        ctx.lineWidth = Math.max(2, r * 0.15);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(hipX, hipY);
        ctx.lineTo(kneeX, kneeY);
        ctx.stroke();

        // Tibia claw
        ctx.strokeStyle = '#3b2d54';
        ctx.lineWidth = Math.max(1.5, r * 0.11);
        ctx.beginPath();
        ctx.moveTo(kneeX, kneeY);
        ctx.lineTo(footX, footY);
        ctx.stroke();

        // Knee chitin joint highlight
        ctx.fillStyle = '#a855f7';
        ctx.beginPath();
        ctx.arc(kneeX, kneeY, Math.max(1.2, r * 0.065), 0, TAU);
        ctx.fill();
      }
    }

    // Venomous swollen abdomen behind cephalothorax
    const abX = bx - cosY * r * 0.52;
    const abY = by - sinY * r * 0.38 * CAMERA_PITCH_Y - r * 0.1;
    ctx.fillStyle = '#2e1065';
    ctx.strokeStyle = '#09090b';
    ctx.lineWidth = 1.5;
    drawEllipsePath(ctx, abX, abY, r * 0.52, r * 0.42);
    ctx.fill();
    ctx.stroke();

    // Glowing venom sacs / stripes on abdomen
    ctx.fillStyle = '#c026d3';
    drawEllipsePath(ctx, abX, abY - r * 0.06, r * 0.24, r * 0.14);
    ctx.fill();

    // Cephalothorax & chelicerae fangs
    const headX = bx + cosY * r * 0.24;
    const headY = by + sinY * r * 0.18 * CAMERA_PITCH_Y;
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#020617';
    ctx.lineWidth = 1.4;
    drawEllipsePath(ctx, headX, headY, r * 0.36, r * 0.28);
    ctx.fill();
    ctx.stroke();

    // Clustered crimson eyes
    ctx.fillStyle = '#f43f5e';
    const eyeBaseX = headX + cosY * r * 0.22;
    const eyeBaseY = headY + sinY * r * 0.15 * CAMERA_PITCH_Y;
    for (let e = -1; e <= 1; e++) {
      ctx.beginPath();
      ctx.arc(eyeBaseX - sinY * e * r * 0.1, eyeBaseY + cosY * e * r * 0.08, Math.max(1.2, r * 0.065), 0, TAU);
      ctx.fill();
    }
  }

  // 4. Sky-Wyvern: Flapping drake at elevated z separated from dark ground drop-shadow + Earthbind cyan chains
  _drawSkyWyvern(ctx, creep, sx, sy, gx, gy, wz, scale, dir, phase, timeSec, isPortrait) {
    const r = scale * 0.38;
    const earthbound = (creep.earthboundTimer || 0) > 0;
    const altScale = Math.max(0.55, 1 - wz * 0.18);

    // Dark ground drop-shadow at worldToScreen(x, y, 0)
    if (!isPortrait) {
      this._drawGroundShadow(ctx, gx, gy, r * 1.15 * altScale, 0.38 * altScale);
    }

    // Glowing cyan Earthbind chains pulling wyvern down when earthboundTimer > 0
    if (earthbound && !isPortrait) {
      ctx.save();
      // Ground runic anchor sigil
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)';
      ctx.lineWidth = 1.8;
      drawEllipsePath(ctx, gx, gy, r * 0.95, r * 0.95 * CAMERA_PITCH_Y);
      ctx.stroke();

      // 3 taut cyan energy chains anchoring ground sigil to wyvern wings/collar
      const anchors = [
        -r * 0.72, -r * 0.25,
        0, r * 0.18,
        r * 0.72, -r * 0.25,
      ];
      for (let i = 0; i < 3; i++) {
        const ax = gx + anchors[i * 2];
        const ay = gy + anchors[i * 2 + 1] * 0.5;
        const tx = sx + anchors[i * 2] * 0.45;
        const ty = sy + r * 0.05;
        const midX = (ax + tx) * 0.5 + Math.sin(timeSec * 18 + i * 2) * 3;
        const midY = (ay + ty) * 0.5;

        ctx.strokeStyle = 'rgba(34, 211, 238, 0.45)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(midX, midY, tx, ty);
        ctx.stroke();

        ctx.strokeStyle = '#cffafe';
        ctx.lineWidth = 1.5;
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash(DASH_CHAIN);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(midX, midY, tx, ty);
        ctx.stroke();
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash(DASH_NONE);
      }
      ctx.restore();
    }

    const flapSpeed = earthbound ? 4.5 : 9.5;
    const flap = Math.sin(timeSec * flapSpeed + phase * 0.7);
    const wingLift = flap * r * (earthbound ? 0.35 : 0.78);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(dir, 1);

    // Back wing
    ctx.fillStyle = '#0c4a6e';
    ctx.strokeStyle = '#082f49';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-r * 0.12, -r * 0.15);
    ctx.lineTo(-r * 0.65, -r * 0.65 - wingLift * 0.85);
    ctx.lineTo(-r * 1.15, -r * 0.28 - wingLift * 0.6);
    ctx.lineTo(-r * 0.48, r * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Sweeping barbed drake tail
    ctx.strokeStyle = '#0369a1';
    ctx.lineWidth = Math.max(2.2, r * 0.18);
    ctx.beginPath();
    ctx.moveTo(-r * 0.28, r * 0.08);
    ctx.quadraticCurveTo(-r * 0.75, r * 0.25 + flap * r * 0.12, -r * 1.08, r * 0.02);
    ctx.stroke();

    // Serpentine drake torso
    ctx.fillStyle = '#0284c7';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.4;
    drawEllipsePath(ctx, 0, 0, r * 0.48, r * 0.24);
    ctx.fill();
    ctx.stroke();

    // Neck & horned drake head
    ctx.fillStyle = '#0ea5e9';
    ctx.beginPath();
    ctx.moveTo(r * 0.26, -r * 0.08);
    ctx.lineTo(r * 0.68, -r * 0.42);
    ctx.lineTo(r * 1.02, -r * 0.32);
    ctx.lineTo(r * 0.72, -r * 0.16);
    ctx.lineTo(r * 0.36, r * 0.08);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Drake horns & glowing amber eye
    ctx.strokeStyle = '#bae6fd';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(r * 0.68, -r * 0.42);
    ctx.lineTo(r * 0.46, -r * 0.64);
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.arc(r * 0.78, -r * 0.32, Math.max(1.3, r * 0.075), 0, TAU);
    ctx.fill();

    // Front sweeping membrane wing + spar bones
    ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(r * 0.12, -r * 0.08);
    ctx.lineTo(-r * 0.18, -r * 0.88 - wingLift);
    ctx.lineTo(-r * 0.92, -r * 0.56 - wingLift * 0.8);
    ctx.lineTo(-r * 0.45, -r * 0.12 - wingLift * 0.35);
    ctx.lineTo(-r * 0.15, r * 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  // 5. Blood-Ward Shaman: Hooded caster + orb staff + expanding emerald/crimson mend aura rings
  _drawBloodShaman(ctx, creep, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait) {
    const r = scale * 0.34;
    const hover = Math.sin(phase * 0.8 + timeSec * 3) * r * 0.08;

    if (!isPortrait) this._drawGroundShadow(ctx, gx, gy, r * 0.95);

    // Expanding emerald/crimson mend aura rings during heal pulses
    const hc = creep.healCooldown;
    const pulseActive = (creep.healPulseTimer || 0) > 0 || (Number.isFinite(hc) && hc > 1.85);
    const ambientPulse = Math.sin(timeSec * 2.5) > 0.65;
    if (pulseActive || (isPortrait && ambientPulse) || (!Number.isFinite(hc) && ambientPulse)) {
      const p = Number.isFinite(hc) ? clamp01((2.6 - hc) / 0.75) : ((timeSec * 1.4) % 1);
      const auraR = r * (1.2 + p * 2.6);
      const auraAlpha = Math.max(0.08, 0.72 * (1 - p));
      ctx.save();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = `rgba(52, 211, 153, ${auraAlpha.toFixed(3)})`;
      drawEllipsePath(ctx, gx, gy, auraR, auraR * CAMERA_PITCH_Y);
      ctx.stroke();

      ctx.lineWidth = 1.6;
      ctx.strokeStyle = `rgba(244, 63, 94, ${(auraAlpha * 0.85).toFixed(3)})`;
      drawEllipsePath(ctx, gx, gy, auraR * 0.72, auraR * 0.72 * CAMERA_PITCH_Y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(sx, sy - hover);
    ctx.scale(dir, 1);

    // Draped cultist robes swaying with walkPhase
    const sway = Math.sin(phase) * r * 0.14;
    ctx.fillStyle = '#4c0519';
    ctx.strokeStyle = '#18181b';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-r * 0.34, -r * 0.45);
    ctx.lineTo(r * 0.34, -r * 0.45);
    ctx.lineTo(r * 0.56 + sway, r * 0.72);
    ctx.lineTo(-r * 0.52 + sway, r * 0.72);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Crimson & bone shoulder mantle
    ctx.fillStyle = '#881337';
    ctx.beginPath();
    ctx.moveTo(-r * 0.48, -r * 0.45);
    ctx.lineTo(r * 0.48, -r * 0.45);
    ctx.lineTo(r * 0.32, -r * 0.15);
    ctx.lineTo(-r * 0.32, -r * 0.15);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Pointed occult hood
    ctx.fillStyle = '#270914';
    ctx.beginPath();
    ctx.moveTo(-r * 0.34, -r * 0.44);
    ctx.lineTo(0, -r * 1.05);
    ctx.lineTo(r * 0.38, -r * 0.44);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Glowing emerald/crimson ritual eyes under hood
    ctx.fillStyle = '#34d399';
    ctx.beginPath();
    ctx.arc(r * 0.12, -r * 0.62, Math.max(1.4, r * 0.08), 0, TAU);
    ctx.fill();

    // Gnarled orb staff held forward
    const staffX = r * 0.64;
    ctx.strokeStyle = '#78350f';
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.beginPath();
    ctx.moveTo(staffX - r * 0.08, r * 0.7);
    ctx.lineTo(staffX + r * 0.06, -r * 0.72);
    ctx.stroke();

    // Glowing blood/emerald staff orb + outer translucent halo
    const orbX = staffX + r * 0.07;
    const orbY = -r * 0.82;
    const orbPulse = 1 + 0.18 * Math.sin(timeSec * 6);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.32)';
    ctx.beginPath();
    ctx.arc(orbX, orbY, r * 0.34 * orbPulse, 0, TAU);
    ctx.fill();

    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.arc(orbX, orbY, r * 0.18, 0, TAU);
    ctx.fill();

    ctx.fillStyle = '#a7f3d0';
    ctx.beginPath();
    ctx.arc(orbX - r * 0.05, orbY - r * 0.05, r * 0.07, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  // 6. Bulwark Golem: Runed stone colossus + cracking faceted hexagonal barrier dome
  _drawBulwarkGolem(ctx, creep, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait) {
    const r = scale * 0.44;
    const stride = Math.sin(phase);
    const stomp = Math.abs(Math.cos(phase)) * r * 0.08;

    if (!isPortrait) this._drawGroundShadow(ctx, gx, gy, r * 1.15);

    ctx.save();
    ctx.translate(sx, sy - stomp);
    ctx.scale(dir, 1);

    // Massive stone pillar legs
    ctx.fillStyle = '#334155';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.6;
    ctx.fillRect(-r * 0.44 + stride * r * 0.14, r * 0.16, r * 0.32, r * 0.56);
    ctx.strokeRect(-r * 0.44 + stride * r * 0.14, r * 0.16, r * 0.32, r * 0.56);
    ctx.fillRect(r * 0.12 - stride * r * 0.14, r * 0.18, r * 0.32, r * 0.54);
    ctx.strokeRect(r * 0.12 - stride * r * 0.14, r * 0.18, r * 0.32, r * 0.54);

    // Monolithic torso
    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.moveTo(-r * 0.65, -r * 0.55);
    ctx.lineTo(r * 0.65, -r * 0.55);
    ctx.lineTo(r * 0.46, r * 0.3);
    ctx.lineTo(-r * 0.46, r * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Glowing arcane core runes on chest
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = Math.max(1.5, r * 0.09);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.38);
    ctx.lineTo(r * 0.18, -r * 0.14);
    ctx.lineTo(0, r * 0.12);
    ctx.lineTo(-r * 0.18, -r * 0.14);
    ctx.closePath();
    ctx.stroke();

    // Stone head crest
    ctx.fillStyle = '#64748b';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-r * 0.24, -r * 0.85, r * 0.48, r * 0.32);
    ctx.strokeRect(-r * 0.24, -r * 0.85, r * 0.48, r * 0.32);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(-r * 0.12, -r * 0.74, r * 0.26, r * 0.09);

    // Detached hovering stone gauntlets
    const armSwing = stride * r * 0.18;
    ctx.fillStyle = '#475569';
    ctx.strokeStyle = '#0f172a';
    ctx.fillRect(-r * 0.84, -r * 0.22 - armSwing, r * 0.28, r * 0.44);
    ctx.strokeRect(-r * 0.84, -r * 0.22 - armSwing, r * 0.28, r * 0.44);
    ctx.fillRect(r * 0.56, -r * 0.22 + armSwing, r * 0.28, r * 0.44);
    ctx.strokeRect(r * 0.56, -r * 0.22 + armSwing, r * 0.28, r * 0.44);

    ctx.restore();

    // Faceted translucent hexagonal barrier dome when shield > 0 (cracks as shield depletes)
    const shield = creep.shield || 0;
    if (shield > 0) {
      const maxShield = creep.maxShield || shield;
      const ratio = clamp01(maxShield > 0 ? shield / maxShield : 1);
      const domeR = r * 1.18;
      const domeY = sy - r * 0.12;
      const flicker = ratio < 0.25 ? (0.55 + 0.45 * Math.sin(timeSec * 24)) : 1;

      ctx.save();
      ctx.fillStyle = `rgba(34, 211, 238, ${(0.16 * ratio * flicker).toFixed(3)})`;
      ctx.strokeStyle = ratio > 0.4 ? `rgba(103, 232, 249, ${(0.78 * flicker).toFixed(3)})` : `rgba(251, 191, 36, ${(0.85 * flicker).toFixed(3)})`;
      ctx.lineWidth = 1.8;
      drawHexagon(ctx, sx, domeY, domeR, 0.92);
      ctx.fill();
      ctx.stroke();

      // Inner faceted hexagonal ribs
      ctx.lineWidth = 1.0;
      ctx.strokeStyle = `rgba(165, 243, 252, ${(0.45 * flicker).toFixed(3)})`;
      drawHexagon(ctx, sx, domeY, domeR * 0.58, 0.92);
      ctx.stroke();

      // Cracks visually intensify as shield depletes
      if (ratio < 0.92) {
        const crackCount = Math.max(1, Math.ceil((1 - ratio) * 6));
        ctx.strokeStyle = ratio < 0.35 ? 'rgba(253, 224, 71, 0.92)' : 'rgba(224, 242, 254, 0.88)';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < crackCount; i++) {
          const ang = (i * TAU) / 6 + 0.3;
          const x0 = sx + Math.cos(ang) * domeR * 0.25;
          const y0 = domeY + Math.sin(ang) * domeR * 0.22;
          const x1 = sx + Math.cos(ang + 0.22) * domeR * 0.62;
          const y1 = domeY + Math.sin(ang + 0.22) * domeR * 0.56;
          const x2 = sx + Math.cos(ang - 0.14) * domeR * 0.94;
          const y2 = domeY + Math.sin(ang - 0.14) * domeR * 0.86;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  // 7. Void Splitter: Phasing translucent indigo wraith OR agile mini-slimes when isSplitChild
  _drawVoidSplitter(ctx, creep, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait) {
    if (creep.isSplitChild) {
      const r = scale * 0.24;
      const bounce = Math.abs(Math.sin(phase * 1.4));
      const squashX = 1 + (1 - bounce) * 0.24;
      const squashY = 1 - (1 - bounce) * 0.2;
      const hopY = bounce * r * 0.45;

      if (!isPortrait) this._drawGroundShadow(ctx, gx, gy, r * (0.9 - bounce * 0.2), 0.3);

      ctx.save();
      ctx.translate(sx, sy - hopY);
      ctx.scale(squashX, squashY);

      // Translucent agile mini-slime dome
      ctx.fillStyle = 'rgba(124, 58, 237, 0.72)';
      ctx.strokeStyle = '#c4b5fd';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.95, Math.PI, TAU);
      ctx.quadraticCurveTo(r * 0.95, r * 0.48, 0, r * 0.48);
      ctx.quadraticCurveTo(-r * 0.95, r * 0.48, -r * 0.95, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Inner dark-matter core + specular highlight
      ctx.fillStyle = '#3b0764';
      ctx.beginPath();
      ctx.arc(dir * r * 0.1, 0, r * 0.36, 0, TAU);
      ctx.fill();

      ctx.fillStyle = '#e879f9';
      ctx.beginPath();
      ctx.arc(-r * 0.26, -r * 0.26, r * 0.18, 0, TAU);
      ctx.fill();

      ctx.restore();
      return;
    }

    // Full Void Wraith (phasing translucent indigo wraith)
    const r = scale * 0.36;
    const hover = Math.sin(timeSec * 4.5 + phase) * r * 0.12;
    const phaseAlpha = 0.72 + 0.18 * Math.sin(timeSec * 5.8);
    const echoOffset = Math.sin(timeSec * 9) * r * 0.2;

    if (!isPortrait) this._drawGroundShadow(ctx, gx, gy, r * 0.85, 0.28);

    // Trailing phase echo silhouette
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = '#4c1d95';
    ctx.beginPath();
    ctx.moveTo(sx - dir * r * 0.35 + echoOffset, sy - r * 0.9 - hover);
    ctx.lineTo(sx + dir * r * 0.35 + echoOffset, sy - hover * 0.5);
    ctx.lineTo(sx - dir * r * 0.45 + echoOffset, sy + r * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(sx, sy - hover);
    ctx.scale(dir, 1);
    ctx.globalAlpha = phaseAlpha;

    // Swirling void cloak & tentacles
    ctx.fillStyle = '#312e81';
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-r * 0.32, -r * 0.55);
    ctx.lineTo(r * 0.38, -r * 0.52);
    ctx.lineTo(r * 0.55, r * 0.48);
    ctx.lineTo(r * 0.15, r * 0.25 + Math.sin(timeSec * 7) * r * 0.12);
    ctx.lineTo(-r * 0.12, r * 0.62);
    ctx.lineTo(-r * 0.48, r * 0.32);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Spectral wraith cowl & glowing violet eyes
    ctx.fillStyle = '#1e1b4b';
    ctx.beginPath();
    ctx.arc(r * 0.04, -r * 0.66, r * 0.3, 0, TAU);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e879f9';
    ctx.beginPath();
    ctx.arc(r * 0.16, -r * 0.66, Math.max(1.5, r * 0.09), 0, TAU);
    ctx.fill();

    // 3 orbiting mini-slime cores hinting at split progeny
    ctx.fillStyle = '#c084fc';
    for (let i = 0; i < 3; i++) {
      const a = timeSec * 3.4 + (i * TAU) / 3;
      const ox = Math.cos(a) * r * 0.58;
      const oy = -r * 0.18 + Math.sin(a) * r * 0.24;
      ctx.beginPath();
      ctx.arc(ox, oy, Math.max(1.5, r * 0.1), 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  // 8. Act Boss: Towering multi-part silhouette (Marrow-Crag, Zephyria, Malakor) + crown emblem
  _drawActBoss(ctx, creep, sx, sy, gx, gy, scale, dir, phase, timeSec, isPortrait) {
    const variant = resolveBossVariant(creep);
    const r = scale * (isPortrait ? 0.62 : 0.56);
    const stomp = Math.abs(Math.cos(phase * 0.7)) * r * 0.07;

    if (!isPortrait) this._drawGroundShadow(ctx, gx, gy, r * 1.28, 0.44);

    // Boss ground aura ring
    ctx.save();
    ctx.strokeStyle = variant === 'zephyria'
      ? 'rgba(56, 189, 248, 0.5)'
      : (variant === 'malakor' ? 'rgba(249, 115, 22, 0.55)' : 'rgba(212, 162, 56, 0.5)');
    ctx.lineWidth = 2.0;
    drawEllipsePath(ctx, gx, gy, r * 1.18, r * 1.18 * CAMERA_PITCH_Y);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(sx, sy - stomp);
    ctx.scale(dir, 1);

    if (variant === 'zephyria') {
      // Storm-Gilded Valkyrie Titaness
      const wingSpread = Math.sin(timeSec * 4.2) * r * 0.14;
      // Mechanical storm wings
      ctx.fillStyle = '#0c4a6e';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5;
      for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.moveTo(side * r * 0.25, -r * 0.45);
        ctx.lineTo(side * r * 1.25, -r * 1.05 + wingSpread);
        ctx.lineTo(side * r * 1.05, -r * 0.25 + wingSpread);
        ctx.lineTo(side * r * 0.35, -r * 0.05);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // Armored greaves & torso
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#d4a238';
      ctx.lineWidth = 1.6;
      ctx.fillRect(-r * 0.38, r * 0.14, r * 0.28, r * 0.58);
      ctx.strokeRect(-r * 0.38, r * 0.14, r * 0.28, r * 0.58);
      ctx.fillRect(r * 0.1, r * 0.14, r * 0.28, r * 0.58);
      ctx.strokeRect(r * 0.1, r * 0.14, r * 0.28, r * 0.58);

      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.moveTo(-r * 0.58, -r * 0.68);
      ctx.lineTo(r * 0.58, -r * 0.68);
      ctx.lineTo(r * 0.38, r * 0.22);
      ctx.lineTo(-r * 0.38, r * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Storm halberd silhouette
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(r * 0.68, r * 0.68);
      ctx.lineTo(r * 0.78, -r * 1.15);
      ctx.stroke();
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.moveTo(r * 0.78, -r * 1.28);
      ctx.lineTo(r * 1.02, -r * 0.88);
      ctx.lineTo(r * 0.74, -r * 0.76);
      ctx.closePath();
      ctx.fill();

      // Helm & glowing eyes
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.arc(0, -r * 0.86, r * 0.28, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#7dd3fc';
      ctx.fillRect(-r * 0.12, -r * 0.9, r * 0.28, r * 0.08);
    } else if (variant === 'malakor') {
      // Abyssal Horned Demon-Archon Lord
      // Floating volcanic shoulder shards
      const floatY = Math.sin(timeSec * 4) * r * 0.08;
      ctx.fillStyle = '#450a0a';
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 1.6;
      for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.moveTo(side * r * 0.48, -r * 0.65 + floatY);
        ctx.lineTo(side * r * 1.02, -r * 1.08 + floatY);
        ctx.lineTo(side * r * 0.84, -r * 0.22 + floatY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // Legs
      ctx.fillStyle = '#1c1917';
      ctx.fillRect(-r * 0.42, r * 0.16, r * 0.3, r * 0.56);
      ctx.fillRect(r * 0.12, r * 0.16, r * 0.3, r * 0.56);

      // Towering obsidian-crimson chest furnace
      ctx.fillStyle = '#18181b';
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(-r * 0.64, -r * 0.68);
      ctx.lineTo(r * 0.64, -r * 0.68);
      ctx.lineTo(r * 0.44, r * 0.28);
      ctx.lineTo(-r * 0.44, r * 0.28);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Infernal chest core
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.arc(0, -r * 0.22, r * 0.22, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(0, -r * 0.22, r * 0.1, 0, TAU);
      ctx.fill();

      // Demon head + sweeping obsidian horns
      ctx.fillStyle = '#27272a';
      ctx.beginPath();
      ctx.arc(0, -r * 0.88, r * 0.26, 0, TAU);
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(-r * 0.16, -r * 1.04);
      ctx.quadraticCurveTo(-r * 0.58, -r * 1.38, -r * 0.46, -r * 1.56);
      ctx.moveTo(r * 0.16, -r * 1.04);
      ctx.quadraticCurveTo(r * 0.58, -r * 1.38, r * 0.46, -r * 1.56);
      ctx.stroke();
    } else {
      // Marrow-Crag: Bone-plated obsidian dreadnought colossus
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#090d16';
      ctx.lineWidth = 1.6;
      ctx.fillRect(-r * 0.44, r * 0.16, r * 0.34, r * 0.56);
      ctx.strokeRect(-r * 0.44, r * 0.16, r * 0.34, r * 0.56);
      ctx.fillRect(r * 0.1, r * 0.16, r * 0.34, r * 0.56);
      ctx.strokeRect(r * 0.1, r * 0.16, r * 0.34, r * 0.56);

      // Massive hull + bone rib plates
      ctx.fillStyle = '#292524';
      ctx.strokeStyle = '#d6d3d1';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-r * 0.72, -r * 0.62);
      ctx.lineTo(r * 0.72, -r * 0.62);
      ctx.lineTo(r * 0.52, r * 0.32);
      ctx.lineTo(-r * 0.52, r * 0.32);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Spiked bone pauldrons
      ctx.fillStyle = '#e7e5e4';
      ctx.strokeStyle = '#44403c';
      for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.moveTo(side * r * 0.42, -r * 0.62);
        ctx.lineTo(side * r * 1.05, -r * 0.92);
        ctx.lineTo(side * r * 0.88, -r * 0.18);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // Molten rib fissures
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.8;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.32, -r * 0.25 + i * r * 0.18);
        ctx.lineTo(r * 0.32, -r * 0.25 + i * r * 0.18);
        ctx.stroke();
      }

      // Dreadnought skull helm
      ctx.fillStyle = '#d6d3d1';
      ctx.strokeStyle = '#1c1917';
      ctx.beginPath();
      ctx.arc(0, -r * 0.86, r * 0.28, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(-r * 0.14, -r * 0.9, r * 0.28, r * 0.08);
    }

    ctx.restore();

    // Boss crown emblem hovering cleanly above head
    drawCrownEmblem(ctx, sx, sy - r * 1.32, Math.max(8, r * 0.36), '#d4a238', '#451a03');
  }

  _drawHealthAndShieldBar(ctx, sx, sy, scale, creep, isBoss) {
    const hp = Math.max(0, creep.hp ?? 100);
    const maxHp = Math.max(1, creep.maxHp ?? 100);
    const hpRatio = clamp01(hp / maxHp);
    const shield = Math.max(0, creep.shield || 0);
    const maxShield = Math.max(shield, creep.maxShield || (shield > 0 ? maxHp * 0.25 : 0));
    const shieldRatio = maxShield > 0 ? clamp01(shield / maxShield) : 0;

    if (isBoss) {
      const barW = Math.max(46, scale * 1.48);
      const barH = Math.max(6, scale * 0.17);
      const x = sx - barW * 0.5;
      const y = sy - scale * 0.96 - barH;

      // Crown emblem beside boss bar
      drawCrownEmblem(ctx, x - barH * 1.1, y + barH * 0.5, barH * 1.45, '#fbbf24', '#451a03');

      // Framed obsidian plate
      ctx.fillStyle = '#090d16';
      ctx.fillRect(x - 1.5, y - 1.5, barW + 3, barH + (shield > 0 ? 5.5 : 3));

      // Boss HP fill
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(x, y, barW * hpRatio, barH);

      // Multi-segment dividers (5 segments)
      ctx.strokeStyle = '#090d16';
      ctx.lineWidth = 1.2;
      for (let s = 1; s < 5; s++) {
        const divX = x + (barW * s) / 5;
        ctx.beginPath();
        ctx.moveTo(divX, y);
        ctx.lineTo(divX, y + barH);
        ctx.stroke();
      }

      // Shield sub-bar
      if (shield > 0) {
        ctx.fillStyle = '#22d3ee';
        ctx.fillRect(x, y + barH + 1, barW * shieldRatio, 2.8);
      }

      // Gold boss border
      ctx.strokeStyle = '#d4a238';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x - 1, y - 1, barW + 2, barH + (shield > 0 ? 4.5 : 2));
      return;
    }

    // Standard grounded crisp mini-bar
    const sizeScale = creep.isSplitChild ? 0.72 : 1.0;
    const barW = Math.max(22, scale * 0.68 * sizeScale);
    const barH = Math.max(3.5, scale * 0.1);
    const x = sx - barW * 0.5;
    const y = sy - scale * (creep.archetypeId === 'bulwark_golem' ? 0.68 : 0.54) - barH;

    ctx.fillStyle = 'rgba(9, 13, 22, 0.9)';
    ctx.fillRect(x - 1, y - 1, barW + 2, barH + (shield > 0 ? 4 : 2));

    ctx.fillStyle = hpRatio > 0.55 ? '#22c55e' : (hpRatio > 0.25 ? '#eab308' : '#ef4444');
    ctx.fillRect(x, y, barW * hpRatio, barH);

    if (shield > 0) {
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(x, y + barH + 0.8, barW * shieldRatio, 2.2);
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x - 0.5, y - 0.5, barW + 1, barH + (shield > 0 ? 3.5 : 1));
  }
}
