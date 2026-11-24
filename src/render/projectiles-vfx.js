import {
  SIM_EVENTS,
  CAMERA_PITCH_Y,
  CAMERA_ELEV_SCALE,
} from '../contracts/types.js';

const TAU = Math.PI * 2;
const MAX_TRANSIENT_VFX = 256;
const MAX_HOP_POINTS = 16;

const VFX_NONE = 0;
const VFX_CHAIN_LIGHTNING = 1;
const VFX_SOLAR_BEAM = 2;
const VFX_RAILGUN_STREAK = 3;
const VFX_CRYO_LANCE = 4;
const VFX_SHATTER_WAVE = 5;
const VFX_EARTHBIND_TETHER = 6;
const VFX_KNOCKUP_RING = 7;
const VFX_MUZZLE_FLASH = 8;

const DASH_NONE = Object.freeze([]);
const DASH_TETHER = Object.freeze([6, 4]);

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function hash01(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
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

function createVfxSlot() {
  return {
    type: VFX_NONE,
    life: 0,
    maxLife: 0.25,
    seed: 1,
    radius: 1.5,
    isAcid: false,
    isChaos: false,
    r: 56,
    g: 189,
    b: 248,
    hopCount: 0,
    ptsX: new Float32Array(MAX_HOP_POINTS),
    ptsY: new Float32Array(MAX_HOP_POINTS),
    ptsZ: new Float32Array(MAX_HOP_POINTS),
  };
}

/**
 * Renders live interpolated projectiles and pre-allocated transient beam/arc/shockwave VFX
 * (Lindenmayer chain lightning, Solar Flare beams, Railgun streaks, Shatter waves, Earthbind tethers)
 * with zero blur passes and zero combat allocations.
 */
export class ProjectileVfxRenderer {
  constructor() {
    this._maxSlots = MAX_TRANSIENT_VFX;
    this._slots = new Array(MAX_TRANSIENT_VFX);
    for (let i = 0; i < MAX_TRANSIENT_VFX; i++) {
      this._slots[i] = createVfxSlot();
    }
    this._head = 0;
    this._seedCounter = 1;

    this._ptA = { x: 0, y: 0 };
    this._ptB = { x: 0, y: 0 };
    this._ptShadow = { x: 0, y: 0 };
    this._segX = new Float32Array(12);
    this._segY = new Float32Array(12);
  }

  _allocSlot() {
    const slot = this._slots[this._head];
    this._head = (this._head + 1) % this._maxSlots;
    slot.seed = (this._seedCounter = (this._seedCounter + 1) & 0xffff);
    slot.isAcid = false;
    slot.isChaos = false;
    slot.hopCount = 0;
    return slot;
  }

  /**
   * Consumes simulation combat events into the fixed ring buffer.
   * @param {object} ev
   */
  handleSimEvent(ev) {
    if (!ev || !ev.type) return;

    switch (ev.type) {
      case SIM_EVENTS.CHAIN_LIGHTNING:
        this._spawnChainLightning(ev);
        break;
      case SIM_EVENTS.TOWER_FIRE:
        this._spawnTowerFire(ev);
        break;
      case SIM_EVENTS.SHATTER_COMBO:
        this._spawnShatterWave(ev);
        break;
      case SIM_EVENTS.EARTHBIND_PULL:
        this._spawnEarthbindTether(ev);
        break;
      case SIM_EVENTS.KNOCKUP_LAND:
        this._spawnKnockupRing(ev);
        break;
      default:
        break;
    }
  }

  /**
   * Advances transient beam/arc lifetimes.
   * @param {number} dt
   */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const stepDt = Math.min(dt, 0.1);
    for (let i = 0; i < this._maxSlots; i++) {
      const slot = this._slots[i];
      if (slot.type === VFX_NONE) continue;
      slot.life -= stepDt;
      if (slot.life <= 0) {
        slot.type = VFX_NONE;
        slot.life = 0;
      }
    }
  }

  /**
   * Renders live projectiles from sim plus active ring-buffered beams & shockwaves.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} camera
   * @param {object} sim
   * @param {number} [alpha=1]
   * @param {number} [timeSec=0]
   */
  render(ctx, camera, sim, alpha = 1, timeSec = 0) {
    if (!ctx) return;
    const a = clamp01(Number.isFinite(alpha) ? alpha : 1);
    const scale = (camera && typeof camera.getScale === 'function')
      ? camera.getScale()
      : (camera && Number.isFinite(camera.scale) ? camera.scale : 36);

    const prevAlpha = ctx.globalAlpha;

    // 1. Live projectiles from sim.projectiles
    if (sim && sim.projectiles) {
      this._renderProjectiles(ctx, camera, sim.projectiles, a, scale, timeSec);
    }

    // 2. Transient VFX ring buffer
    for (let i = 0; i < this._maxSlots; i++) {
      const slot = this._slots[i];
      if (slot.type === VFX_NONE || slot.life <= 0) continue;
      const frac = clamp01(slot.life / Math.max(0.01, slot.maxLife));
      switch (slot.type) {
        case VFX_CHAIN_LIGHTNING:
          this._renderChainLightning(ctx, camera, slot, frac, scale, timeSec);
          break;
        case VFX_SOLAR_BEAM:
          this._renderSolarBeam(ctx, camera, slot, frac, scale, timeSec);
          break;
        case VFX_RAILGUN_STREAK:
          this._renderRailgunStreak(ctx, camera, slot, frac, scale);
          break;
        case VFX_CRYO_LANCE:
          this._renderCryoLance(ctx, camera, slot, frac, scale);
          break;
        case VFX_SHATTER_WAVE:
          this._renderShatterWave(ctx, camera, slot, frac, scale);
          break;
        case VFX_EARTHBIND_TETHER:
          this._renderEarthbindTether(ctx, camera, slot, frac, scale, timeSec);
          break;
        case VFX_KNOCKUP_RING:
          this._renderKnockupRing(ctx, camera, slot, frac, scale);
          break;
        case VFX_MUZZLE_FLASH:
          this._renderMuzzleFlash(ctx, camera, slot, frac, scale);
          break;
        default:
          break;
      }
    }

    ctx.globalAlpha = prevAlpha;
  }

  _spawnChainLightning(ev) {
    const pts = ev.points || ev.hops || ev.targets;
    const slot = this._allocSlot();
    slot.type = VFX_CHAIN_LIGHTNING;
    slot.maxLife = 0.28;
    slot.life = slot.maxLife;
    slot.isAcid = Boolean(
      ev.isAcid ||
      ev.fusionId === 'plague_coil' ||
      ev.lineageId === 'plague_coil' ||
      ev.attackType === 'Elemental'
    );
    slot.isChaos = Boolean(ev.isChaosApex);

    let count = 0;
    if (Array.isArray(pts) && pts.length >= 2) {
      const n = Math.min(MAX_HOP_POINTS, pts.length);
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        if (!p) continue;
        slot.ptsX[count] = Number.isFinite(p.x) ? p.x : 0;
        slot.ptsY[count] = Number.isFinite(p.y) ? p.y : 0;
        slot.ptsZ[count] = Number.isFinite(p.z) ? p.z : (count === 0 ? 0.85 : 0.38);
        count++;
      }
    } else if (Number.isFinite(ev.fromX ?? ev.x1 ?? ev.x) && Number.isFinite(ev.toX ?? ev.x2 ?? ev.targetX)) {
      slot.ptsX[0] = ev.fromX ?? ev.x1 ?? ev.x;
      slot.ptsY[0] = ev.fromY ?? ev.y1 ?? ev.y;
      slot.ptsZ[0] = ev.fromZ ?? 0.85;
      slot.ptsX[1] = ev.toX ?? ev.x2 ?? ev.targetX;
      slot.ptsY[1] = ev.toY ?? ev.y2 ?? ev.targetY;
      slot.ptsZ[1] = ev.toZ ?? 0.38;
      count = 2;
    }

    if (count < 2) {
      slot.type = VFX_NONE;
      return;
    }
    slot.hopCount = count;
  }

  _spawnTowerFire(ev) {
    const fusion = ev.fusionId || '';
    const lineage = ev.lineageId || ev.towerId || ev.kind || '';
    const x1 = ev.fromX ?? ev.tx ?? ev.x1 ?? ev.x ?? 0;
    const y1 = ev.fromY ?? ev.ty ?? ev.y1 ?? ev.y ?? 0;
    const z1 = ev.fromZ ?? ev.z1 ?? 0.78;

    if ((lineage === 'tesla' || fusion === 'plague_coil') && Array.isArray(ev.points) && ev.points.length >= 2) {
      this._spawnChainLightning(ev);
      return;
    }

    const x2 = ev.toX ?? ev.targetX ?? ev.x2 ?? (x1 + (ev.dirX || 0) * (ev.length || ev.range || 6));
    const y2 = ev.toY ?? ev.targetY ?? ev.y2 ?? (y1 + (ev.dirY || 0) * (ev.length || ev.range || 6));
    const z2 = ev.toZ ?? ev.targetZ ?? ev.z2 ?? 0.35;

    if (fusion === 'solar_flare') {
      const slot = this._allocSlot();
      slot.type = VFX_SOLAR_BEAM;
      slot.maxLife = 0.26;
      slot.life = slot.maxLife;
      slot.isChaos = Boolean(ev.isChaosApex);
      slot.hopCount = 2;
      slot.ptsX[0] = x1;
      slot.ptsY[0] = y1;
      slot.ptsZ[0] = z1;
      slot.ptsX[1] = x2;
      slot.ptsY[1] = y2;
      slot.ptsZ[1] = z2;
      return;
    }

    if (fusion === 'railgun_bastion') {
      const slot = this._allocSlot();
      slot.type = VFX_RAILGUN_STREAK;
      slot.maxLife = 0.36;
      slot.life = slot.maxLife;
      slot.isChaos = Boolean(ev.isChaosApex);
      slot.hopCount = 2;

      const dx = (ev.dirX !== undefined) ? ev.dirX : (x2 - x1);
      const dy = (ev.dirY !== undefined) ? ev.dirY : (y2 - y1);
      const dist = Math.hypot(dx, dy);
      const len = Number.isFinite(ev.length) ? ev.length : Math.max(dist, 8.5);
      const ux = dist > 1e-4 ? dx / dist : 1;
      const uy = dist > 1e-4 ? dy / dist : 0;

      slot.ptsX[0] = x1;
      slot.ptsY[0] = y1;
      slot.ptsZ[0] = z1;
      slot.ptsX[1] = x1 + ux * len;
      slot.ptsY[1] = y1 + uy * len;
      slot.ptsZ[1] = z2;
      return;
    }

    if (fusion === 'glacial_obelisk') {
      const slot = this._allocSlot();
      slot.type = VFX_CRYO_LANCE;
      slot.maxLife = 0.28;
      slot.life = slot.maxLife;
      slot.isChaos = Boolean(ev.isChaosApex);
      slot.hopCount = 2;
      slot.ptsX[0] = x1;
      slot.ptsY[0] = y1;
      slot.ptsZ[0] = z1;
      slot.ptsX[1] = x2;
      slot.ptsY[1] = y2;
      slot.ptsZ[1] = z2;
      return;
    }

    // Muzzle flash at firing tower for projectile weapons
    const slot = this._allocSlot();
    slot.type = VFX_MUZZLE_FLASH;
    slot.maxLife = 0.16;
    slot.life = slot.maxLife;
    slot.hopCount = 1;
    slot.ptsX[0] = x1;
    slot.ptsY[0] = y1;
    slot.ptsZ[0] = z1;
    slot.radius = (lineage === 'mortar' || fusion === 'hellfire_mortar' || fusion === 'shatter_cannon') ? 0.55 : 0.34;
    if (lineage === 'frost' || fusion === 'shatter_cannon' || fusion === 'windchill_flak') {
      slot.r = 125; slot.g = 211; slot.b = 252;
    } else if (lineage === 'venom' || fusion === 'viper_gatling') {
      slot.r = 74; slot.g = 222; slot.b = 128;
    } else if (fusion === 'singularity_catapult') {
      slot.r = 168; slot.g = 85; slot.b = 247;
    } else {
      slot.r = 251; slot.g = 191; slot.b = 36;
    }
  }

  _spawnShatterWave(ev) {
    const slot = this._allocSlot();
    slot.type = VFX_SHATTER_WAVE;
    slot.maxLife = 0.44;
    slot.life = slot.maxLife;
    slot.radius = Number.isFinite(ev.radius) ? ev.radius : 2.1;
    slot.ptsX[0] = Number.isFinite(ev.x) ? ev.x : 0;
    slot.ptsY[0] = Number.isFinite(ev.y) ? ev.y : 0;
    slot.ptsZ[0] = Number.isFinite(ev.z) ? ev.z : 0.12;
  }

  _spawnEarthbindTether(ev) {
    const slot = this._allocSlot();
    slot.type = VFX_EARTHBIND_TETHER;
    slot.maxLife = 0.55;
    slot.life = slot.maxLife;
    slot.hopCount = 2;

    const tx = ev.toX ?? ev.targetX ?? ev.x2 ?? ev.x ?? 0;
    const ty = ev.toY ?? ev.targetY ?? ev.y2 ?? ev.y ?? 0;
    const fx = ev.fromX ?? ev.tx ?? ev.x1 ?? tx;
    const fy = ev.fromY ?? ev.ty ?? ev.y1 ?? (ty + 0.5);

    slot.ptsX[0] = fx;
    slot.ptsY[0] = fy;
    slot.ptsZ[0] = Number.isFinite(ev.fromZ) ? ev.fromZ : 0.65;
    slot.ptsX[1] = tx;
    slot.ptsY[1] = ty;
    slot.ptsZ[1] = Number.isFinite(ev.z ?? ev.toZ) ? (ev.z ?? ev.toZ) : 1.15;
  }

  _spawnKnockupRing(ev) {
    const slot = this._allocSlot();
    slot.type = VFX_KNOCKUP_RING;
    slot.maxLife = 0.45;
    slot.life = slot.maxLife;
    slot.radius = Number.isFinite(ev.radius) ? ev.radius : 1.6;
    slot.ptsX[0] = Number.isFinite(ev.x) ? ev.x : 0;
    slot.ptsY[0] = Number.isFinite(ev.y) ? ev.y : 0;
    slot.ptsZ[0] = 0;
  }

  _renderChainLightning(ctx, camera, slot, frac, scale, timeSec) {
    const count = slot.hopCount;
    if (count < 2) return;

    const flicker = Math.floor(timeSec * 30);
    const outerColor = slot.isChaos
      ? `rgba(250, 204, 21, ${(0.55 * frac).toFixed(3)})`
      : (slot.isAcid ? `rgba(74, 222, 128, ${(0.52 * frac).toFixed(3)})` : `rgba(34, 211, 238, ${(0.55 * frac).toFixed(3)})`);
    const midColor = slot.isChaos
      ? `rgba(253, 224, 71, ${(0.88 * frac).toFixed(3)})`
      : (slot.isAcid ? `rgba(163, 230, 53, ${(0.9 * frac).toFixed(3)})` : `rgba(125, 211, 252, ${(0.9 * frac).toFixed(3)})`);
    const coreColor = `rgba(248, 250, 252, ${(0.98 * frac).toFixed(3)})`;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let h = 0; h < count - 1; h++) {
      projectWorld(camera, slot.ptsX[h], slot.ptsY[h], slot.ptsZ[h], this._ptA);
      projectWorld(camera, slot.ptsX[h + 1], slot.ptsY[h + 1], slot.ptsZ[h + 1], this._ptB);

      const x0 = this._ptA.x;
      const y0 = this._ptA.y;
      const x1 = this._ptB.x;
      const y1 = this._ptB.y;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;

      const nx = -dy / dist;
      const ny = dx / dist;
      const amp = Math.min(scale * 0.42, dist * 0.19);

      // Build 5 jagged segments (6 points) in pre-allocated scratch buffers
      const segCount = 5;
      this._segX[0] = x0;
      this._segY[0] = y0;
      for (let s = 1; s < segCount; s++) {
        const t = s / segCount;
        const j = (hash01(slot.seed + h * 31 + s * 17 + flicker * 7) - 0.5) * 2.0 * amp;
        this._segX[s] = x0 + dx * t + nx * j;
        this._segY[s] = y0 + dy * t + ny * j;
      }
      this._segX[segCount] = x1;
      this._segY[segCount] = y1;

      // Outer energy sheath
      ctx.strokeStyle = outerColor;
      ctx.lineWidth = Math.max(3.2, scale * 0.14 * frac);
      ctx.beginPath();
      ctx.moveTo(this._segX[0], this._segY[0]);
      for (let s = 1; s <= segCount; s++) ctx.lineTo(this._segX[s], this._segY[s]);
      ctx.stroke();

      // Secondary L-system-style forked branches at vertices 2 & 3
      const baseAngle = Math.atan2(dy, dx);
      ctx.strokeStyle = midColor;
      ctx.lineWidth = Math.max(1.4, scale * 0.055 * frac);
      for (let b = 2; b <= 3; b++) {
        const bx0 = this._segX[b];
        const by0 = this._segY[b];
        const sign = ((b + h + flicker) % 2 === 0) ? 1 : -1;
        const branchAngle = baseAngle + sign * (0.52 + hash01(slot.seed + b * 13 + flicker) * 0.32);
        const branchLen = dist * (0.24 + hash01(slot.seed + b * 19) * 0.14);
        const bx1 = bx0 + Math.cos(branchAngle) * branchLen * 0.55;
        const by1 = by0 + Math.sin(branchAngle) * branchLen * 0.55;
        const bx2 = bx1 + Math.cos(branchAngle - sign * 0.25) * branchLen * 0.45;
        const by2 = by1 + Math.sin(branchAngle - sign * 0.25) * branchLen * 0.45;

        ctx.beginPath();
        ctx.moveTo(bx0, by0);
        ctx.lineTo(bx1, by1);
        ctx.lineTo(bx2, by2);
        ctx.stroke();
      }

      // Main bolt mid & white core
      ctx.strokeStyle = midColor;
      ctx.lineWidth = Math.max(2.0, scale * 0.08 * frac);
      ctx.beginPath();
      ctx.moveTo(this._segX[0], this._segY[0]);
      for (let s = 1; s <= segCount; s++) ctx.lineTo(this._segX[s], this._segY[s]);
      ctx.stroke();

      ctx.strokeStyle = coreColor;
      ctx.lineWidth = Math.max(1.0, scale * 0.036 * frac);
      ctx.stroke();

      // Target hop impact flash node
      ctx.fillStyle = coreColor;
      ctx.beginPath();
      ctx.arc(x1, y1, Math.max(2.0, scale * 0.1 * frac), 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  _renderSolarBeam(ctx, camera, slot, frac, scale, timeSec) {
    projectWorld(camera, slot.ptsX[0], slot.ptsY[0], slot.ptsZ[0], this._ptA);
    projectWorld(camera, slot.ptsX[1], slot.ptsY[1], slot.ptsZ[1], this._ptB);

    const x0 = this._ptA.x;
    const y0 = this._ptA.y;
    const x1 = this._ptB.x;
    const y1 = this._ptB.y;
    const pulse = 0.85 + 0.15 * Math.sin(timeSec * 36 + slot.seed);

    ctx.save();
    ctx.lineCap = 'round';

    // Outer radiant orange-gold beam halo
    ctx.strokeStyle = `rgba(249, 115, 22, ${(0.34 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(6, scale * 0.32 * pulse * frac);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    // Inner amber beam
    ctx.strokeStyle = `rgba(251, 191, 36, ${(0.78 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(3, scale * 0.15 * pulse * frac);
    ctx.stroke();

    // White-hot radiant core
    ctx.strokeStyle = `rgba(254, 249, 195, ${(0.95 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(1.4, scale * 0.06 * frac);
    ctx.stroke();

    // Solar impact flare at target
    ctx.fillStyle = `rgba(251, 146, 60, ${(0.45 * frac).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x1, y1, scale * 0.34 * pulse * frac, 0, TAU);
    ctx.fill();

    ctx.fillStyle = `rgba(255, 255, 255, ${(0.9 * frac).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x1, y1, scale * 0.13 * frac, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  _renderRailgunStreak(ctx, camera, slot, frac, scale) {
    projectWorld(camera, slot.ptsX[0], slot.ptsY[0], slot.ptsZ[0], this._ptA);
    projectWorld(camera, slot.ptsX[1], slot.ptsY[1], slot.ptsZ[1], this._ptB);

    const x0 = this._ptA.x;
    const y0 = this._ptA.y;
    const x1 = this._ptB.x;
    const y1 = this._ptB.y;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 2) return;
    const angle = Math.atan2(dy, dx);

    ctx.save();
    ctx.lineCap = 'butt';

    // Hyper-velocity corridor glow
    ctx.strokeStyle = slot.isChaos
      ? `rgba(250, 204, 21, ${(0.35 * frac).toFixed(3)})`
      : `rgba(56, 189, 248, ${(0.38 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(5, scale * 0.28 * frac);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    // Inner plasma slug streak
    ctx.strokeStyle = `rgba(224, 242, 254, ${(0.95 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(1.8, scale * 0.085 * frac);
    ctx.stroke();

    // Mach shock rings spaced along railgun axis
    const ringCount = 4;
    ctx.strokeStyle = `rgba(186, 230, 253, ${(0.72 * frac).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    for (let i = 1; i <= ringCount; i++) {
      const t = i / (ringCount + 1);
      const rx = x0 + dx * t;
      const ry = y0 + dy * t;
      const ringSize = scale * (0.14 + (1 - frac) * 0.2);
      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(angle);
      drawEllipsePath(ctx, 0, 0, ringSize * 0.35, ringSize);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  _renderCryoLance(ctx, camera, slot, frac, scale) {
    projectWorld(camera, slot.ptsX[0], slot.ptsY[0], slot.ptsZ[0], this._ptA);
    projectWorld(camera, slot.ptsX[1], slot.ptsY[1], slot.ptsZ[1], this._ptB);

    const x0 = this._ptA.x;
    const y0 = this._ptA.y;
    const x1 = this._ptB.x;
    const y1 = this._ptB.y;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(56, 189, 248, ${(0.45 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(4, scale * 0.22 * frac);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    ctx.strokeStyle = `rgba(224, 242, 254, ${(0.92 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(1.6, scale * 0.07 * frac);
    ctx.stroke();

    // Crystalline spearhead diamond at target
    const r = scale * 0.24 * frac;
    ctx.fillStyle = `rgba(186, 230, 253, ${(0.85 * frac).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(x1, y1 - r);
    ctx.lineTo(x1 + r * 0.7, y1);
    ctx.lineTo(x1, y1 + r);
    ctx.lineTo(x1 - r * 0.7, y1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _renderShatterWave(ctx, camera, slot, frac, scale) {
    projectWorld(camera, slot.ptsX[0], slot.ptsY[0], slot.ptsZ[0], this._ptA);
    const progress = 1 - frac;
    const maxR = slot.radius * scale;
    const curR = maxR * (0.2 + 0.8 * progress);

    ctx.save();
    // Polygonal crystalline shockwave ring
    ctx.strokeStyle = `rgba(125, 211, 252, ${(0.85 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(2, scale * 0.1 * frac);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i * TAU) / 10;
      const jagged = i % 2 === 0 ? 1.08 : 0.92;
      const px = this._ptA.x + Math.cos(a) * curR * jagged;
      const py = this._ptA.y + Math.sin(a) * curR * jagged * CAMERA_PITCH_Y;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();

    // Radial fracture spikes
    ctx.strokeStyle = `rgba(240, 249, 255, ${(0.9 * frac).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 8; i++) {
      const a = (i * TAU) / 8 + 0.2;
      const r0 = curR * 0.45;
      const r1 = curR * 1.1;
      ctx.beginPath();
      ctx.moveTo(this._ptA.x + Math.cos(a) * r0, this._ptA.y + Math.sin(a) * r0 * CAMERA_PITCH_Y);
      ctx.lineTo(this._ptA.x + Math.cos(a) * r1, this._ptA.y + Math.sin(a) * r1 * CAMERA_PITCH_Y);
      ctx.stroke();
    }
    ctx.restore();
  }

  _renderEarthbindTether(ctx, camera, slot, frac, scale, timeSec) {
    projectWorld(camera, slot.ptsX[0], slot.ptsY[0], slot.ptsZ[0], this._ptA);
    projectWorld(camera, slot.ptsX[1], slot.ptsY[1], slot.ptsZ[1], this._ptB);
    projectWorld(camera, slot.ptsX[1], slot.ptsY[1], 0, this._ptShadow);

    ctx.save();
    // Harpoon tether from shooter to target wyvern
    ctx.strokeStyle = `rgba(34, 211, 238, ${(0.72 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(2, scale * 0.08);
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash(DASH_TETHER);
    ctx.beginPath();
    ctx.moveTo(this._ptA.x, this._ptA.y);
    ctx.lineTo(this._ptB.x, this._ptB.y);
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash(DASH_NONE);

    // Downward pull chain from target to ground anchor
    ctx.strokeStyle = `rgba(165, 243, 252, ${(0.9 * frac).toFixed(3)})`;
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(this._ptB.x, this._ptB.y);
    ctx.lineTo(this._ptShadow.x + Math.sin(timeSec * 22) * 2, this._ptShadow.y);
    ctx.stroke();

    // Ground anchor rune ring
    const ringR = scale * 0.55 * (1 - 0.25 * (1 - frac));
    ctx.strokeStyle = `rgba(34, 211, 238, ${(0.85 * frac).toFixed(3)})`;
    drawEllipsePath(ctx, this._ptShadow.x, this._ptShadow.y, ringR, ringR * CAMERA_PITCH_Y);
    ctx.stroke();

    ctx.restore();
  }

  _renderKnockupRing(ctx, camera, slot, frac, scale) {
    projectWorld(camera, slot.ptsX[0], slot.ptsY[0], 0, this._ptA);
    const progress = 1 - frac;
    const rad = slot.radius * scale * (0.25 + 0.75 * progress);

    ctx.save();
    ctx.strokeStyle = `rgba(217, 119, 6, ${(0.72 * frac).toFixed(3)})`;
    ctx.lineWidth = Math.max(2, scale * 0.1 * frac);
    drawEllipsePath(ctx, this._ptA.x, this._ptA.y, rad, rad * CAMERA_PITCH_Y);
    ctx.stroke();

    ctx.strokeStyle = `rgba(196, 181, 253, ${(0.65 * frac).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    drawEllipsePath(ctx, this._ptA.x, this._ptA.y, rad * 0.65, rad * 0.65 * CAMERA_PITCH_Y);
    ctx.stroke();
    ctx.restore();
  }

  _renderMuzzleFlash(ctx, camera, slot, frac, scale) {
    projectWorld(camera, slot.ptsX[0], slot.ptsY[0], slot.ptsZ[0], this._ptA);
    const r = slot.radius * scale * (0.6 + 0.5 * (1 - frac));
    ctx.save();
    ctx.fillStyle = `rgba(${slot.r}, ${slot.g}, ${slot.b}, ${(0.62 * frac).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(this._ptA.x, this._ptA.y, r, 0, TAU);
    ctx.fill();

    ctx.fillStyle = `rgba(255, 255, 255, ${(0.88 * frac).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(this._ptA.x, this._ptA.y, r * 0.42, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _renderProjectiles(ctx, camera, projectiles, alpha, scale, timeSec) {
    if (Array.isArray(projectiles)) {
      for (let i = 0; i < projectiles.length; i++) {
        const p = projectiles[i];
        if (!p || p.active === false) continue;
        this._drawSingleProjectile(ctx, camera, p, alpha, scale, timeSec);
      }
      return;
    }
    if (typeof projectiles[Symbol.iterator] === 'function') {
      for (const p of projectiles) {
        if (!p || p.active === false) continue;
        this._drawSingleProjectile(ctx, camera, p, alpha, scale, timeSec);
      }
    }
  }

  _drawSingleProjectile(ctx, camera, p, alpha, scale, timeSec) {
    const px = Number.isFinite(p.prevX) ? p.prevX : (p.x ?? 0);
    const py = Number.isFinite(p.prevY) ? p.prevY : (p.y ?? 0);
    const pz = Number.isFinite(p.prevZ) ? p.prevZ : (p.z ?? 0.45);
    const x = px + ((p.x ?? px) - px) * alpha;
    const y = py + ((p.y ?? py) - py) * alpha;
    const z = pz + ((p.z ?? pz) - pz) * alpha;

    projectWorld(camera, x, y, 0, this._ptShadow);
    projectWorld(camera, x, y, z, this._ptA);

    const sx = this._ptA.x;
    const sy = this._ptA.y;
    const vx = p.vx ?? ((p.x ?? px) - px);
    const vy = p.vy ?? ((p.y ?? py) - py);
    const angle = Number.isFinite(p.yaw) ? p.yaw : Math.atan2(vy * CAMERA_PITCH_Y, vx || 1);

    const kind = p.fusionId || p.lineageId || p.kind || p.type || '';
    const r = Math.max(3, scale * 0.14);

    ctx.save();

    // Ground shadow when projectile has elevation
    if (z > 0.12) {
      ctx.fillStyle = 'rgba(2, 6, 23, 0.32)';
      drawEllipsePath(ctx, this._ptShadow.x, this._ptShadow.y, r * 0.85, r * 0.85 * CAMERA_PITCH_Y);
      ctx.fill();
    }

    if (kind === 'singularity_catapult') {
      // Swirling dark-matter orb
      ctx.fillStyle = 'rgba(139, 92, 246, 0.32)';
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2.1, 0, TAU);
      ctx.fill();

      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 1.6;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(timeSec * 8);
      drawEllipsePath(ctx, 0, 0, r * 1.75, r * 0.72);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#09090b';
      ctx.beginPath();
      ctx.arc(sx, sy, r * 0.95, 0, TAU);
      ctx.fill();
    } else if (kind === 'mortar' || kind === 'hellfire_mortar' || kind === 'shatter_cannon') {
      const isShatter = kind === 'shatter_cannon';
      const isHellfire = kind === 'hellfire_mortar';
      // Shell wake glow
      ctx.fillStyle = isShatter ? 'rgba(56, 189, 248, 0.34)' : (isHellfire ? 'rgba(249, 115, 22, 0.38)' : 'rgba(245, 158, 11, 0.3)');
      ctx.beginPath();
      ctx.arc(sx, sy, r * 1.7, 0, TAU);
      ctx.fill();

      // Shell body
      ctx.fillStyle = isShatter ? '#0284c7' : (isHellfire ? '#9a3412' : '#334155');
      ctx.strokeStyle = isShatter ? '#bae6fd' : '#fbbf24';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(sx, sy, r * 1.05, 0, TAU);
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'frost' || kind === 'glacial_obelisk' || kind === 'windchill_flak') {
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      ctx.fillStyle = '#38bdf8';
      ctx.strokeStyle = '#e0f2fe';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(r * 1.6, 0);
      ctx.lineTo(-r * 0.6, r * 0.65);
      ctx.lineTo(-r * 1.1, 0);
      ctx.lineTo(-r * 0.6, -r * 0.65);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'venom' || kind === 'viper_gatling') {
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      ctx.fillStyle = 'rgba(74, 222, 128, 0.35)';
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.3, 0, TAU);
      ctx.fill();

      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      if (kind === 'viper_gatling') {
        ctx.moveTo(r * 1.6, 0);
        ctx.lineTo(-r * 1.1, r * 0.35);
        ctx.lineTo(-r * 1.1, -r * 0.35);
        ctx.closePath();
      } else {
        ctx.arc(0, 0, r * 0.85, 0, TAU);
      }
      ctx.fill();
    } else if (kind === 'brazier') {
      ctx.fillStyle = 'rgba(249, 115, 22, 0.38)';
      ctx.beginPath();
      ctx.arc(sx, sy, r * 1.6, 0, TAU);
      ctx.fill();

      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.arc(sx, sy, r * 0.85, 0, TAU);
      ctx.fill();
    } else {
      // Ballista / Pierce / default bolt
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      ctx.strokeStyle = p.isChaosApex ? '#facc15' : '#e2e8f0';
      ctx.lineWidth = Math.max(1.8, r * 0.48);
      ctx.beginPath();
      ctx.moveTo(-r * 1.5, 0);
      ctx.lineTo(r * 1.4, 0);
      ctx.stroke();

      // Bolt head
      ctx.fillStyle = p.isChaosApex ? '#f43f5e' : '#fbbf24';
      ctx.beginPath();
      ctx.moveTo(r * 1.8, 0);
      ctx.lineTo(r * 0.7, r * 0.45);
      ctx.lineTo(r * 0.7, -r * 0.45);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }
}
