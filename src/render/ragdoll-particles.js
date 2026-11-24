import {
  MAX_PARTICLES,
  SIM_EVENTS,
  CAMERA_PITCH_Y,
  CAMERA_ELEV_SCALE,
} from '../contracts/types.js';

const TAU = Math.PI * 2;

export const PARTICLE_KINDS = Object.freeze({
  SPARK: 0,
  SHARD: 1,
  PLATE: 2,
  SLIME: 3,
  SMOKE: 4,
  DUST: 5,
  FEATHER: 6,
  EMBER: 7,
});

const KIND_BY_NAME = Object.freeze({
  spark: PARTICLE_KINDS.SPARK,
  shard: PARTICLE_KINDS.SHARD,
  plate: PARTICLE_KINDS.PLATE,
  slime: PARTICLE_KINDS.SLIME,
  smoke: PARTICLE_KINDS.SMOKE,
  dust: PARTICLE_KINDS.DUST,
  feather: PARTICLE_KINDS.FEATHER,
  ember: PARTICLE_KINDS.EMBER,
});

function finiteOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function clampByte(v) {
  if (!Number.isFinite(v)) return 255;
  const n = Math.round(v);
  return n < 0 ? 0 : (n > 255 ? 255 : n);
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 1;
  return v < 0 ? 0 : (v > 1 ? 1 : v);
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

/**
 * Fixed Struct-of-Arrays (SoA) ring-buffer particle & ragdoll system.
 * Pre-allocates all TypedArrays in constructor to guarantee zero GC during combat.
 */
export class RagdollParticleSystem {
  /**
   * @param {number} [maxParticles=MAX_PARTICLES]
   */
  constructor(maxParticles = MAX_PARTICLES) {
    const cap = Math.max(1, Number.isFinite(maxParticles) ? (maxParticles | 0) : MAX_PARTICLES);
    this.maxParticles = cap;
    this.head = 0;
    this._highWater = 0;
    this.activeCount = 0;

    // Struct-of-Arrays fixed TypedArrays
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.r = new Uint8Array(cap);
    this.g = new Uint8Array(cap);
    this.b = new Uint8Array(cap);
    this.a = new Float32Array(cap);
    this.kind = new Uint8Array(cap);
    this.rot = new Float32Array(cap);
    this.vrot = new Float32Array(cap);

    this._pt = { x: 0, y: 0 };

    // Fixed 256-slot direct-mapped RGB string cache (zero heap growth)
    this._rgbKeys = new Int32Array(256);
    this._rgbKeys.fill(-1);
    this._rgbVals = new Array(256);
  }

  /**
   * Spawns a single particle into the fixed ring buffer, overwriting oldest when full.
   * @param {object} [opts]
   * @returns {number} slot index written
   */
  spawn(opts = {}) {
    const idx = this.head;
    this.head = (idx + 1) % this.maxParticles;
    if (this._highWater < this.maxParticles) {
      this._highWater++;
    }

    const life = Math.max(0.02, finiteOr(opts.maxLife ?? opts.life, 0.55));
    const curLife = Math.max(0.01, Math.min(life, finiteOr(opts.life, life)));
    let k = opts.kind;
    if (typeof k === 'string') {
      k = KIND_BY_NAME[k.toLowerCase()] ?? PARTICLE_KINDS.SPARK;
    } else if (!Number.isFinite(k)) {
      k = PARTICLE_KINDS.SPARK;
    }

    this.px[idx] = finiteOr(opts.x ?? opts.px, 0);
    this.py[idx] = finiteOr(opts.y ?? opts.py, 0);
    this.pz[idx] = Math.max(0, finiteOr(opts.z ?? opts.pz, 0.25));
    this.vx[idx] = finiteOr(opts.vx, 0);
    this.vy[idx] = finiteOr(opts.vy, 0);
    this.vz[idx] = finiteOr(opts.vz, 0);
    this.life[idx] = curLife;
    this.maxLife[idx] = life;
    this.size[idx] = Math.max(0.5, finiteOr(opts.size, 3.8));
    this.r[idx] = clampByte(opts.r ?? 251);
    this.g[idx] = clampByte(opts.g ?? 191);
    this.b[idx] = clampByte(opts.b ?? 36);
    this.a[idx] = clamp01(opts.a ?? 1);
    this.kind[idx] = k & 7;
    this.rot[idx] = finiteOr(opts.rot, 0);
    this.vrot[idx] = finiteOr(opts.vrot, 0);

    if (this.activeCount < this.maxParticles) {
      this.activeCount++;
    }
    return idx;
  }

  /**
   * Consumes simulation combat/build events and emits tailored ragdoll & particle bursts.
   * @param {object} ev
   */
  handleSimEvent(ev) {
    if (!ev || !ev.type) return;

    const x = finiteOr(ev.x ?? ev.wx, 0);
    const y = finiteOr(ev.y ?? ev.wy, 0);
    const z = Math.max(0, finiteOr(ev.z ?? ev.wz, 0.35));

    switch (ev.type) {
      case SIM_EVENTS.CREEP_KILLED:
        this._spawnCreepDeathBurst(ev, x, y, z);
        break;
      case SIM_EVENTS.SHATTER_COMBO:
        this._spawnShatterBurst(x, y, z, finiteOr(ev.radius, 1.8));
        break;
      case SIM_EVENTS.PROJECTILE_HIT:
        this._spawnHitBurst(ev, x, y, z);
        break;
      case SIM_EVENTS.BUILDER_SPARK:
        this._spawnBuilderSparks(x, y, Math.max(0.45, z));
        break;
      case SIM_EVENTS.KNOCKUP_LAND:
        this._spawnKnockupDust(x, y, finiteOr(ev.radius, 1.4));
        break;
      default:
        break;
    }
  }

  /**
   * Advances physics (gravity, ground bounce on pz, drag, rotation, lifetime).
   * @param {number} dt
   */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const stepDt = Math.min(dt, 0.1);
    const gravity = 14.5;
    const limit = this._highWater;

    const px = this.px;
    const py = this.py;
    const pz = this.pz;
    const vx = this.vx;
    const vy = this.vy;
    const vz = this.vz;
    const life = this.life;
    const kind = this.kind;
    const rot = this.rot;
    const vrot = this.vrot;

    let alive = 0;

    for (let i = 0; i < limit; i++) {
      const rem = life[i] - stepDt;
      if (rem <= 0) {
        life[i] = 0;
        continue;
      }
      life[i] = rem;
      alive++;

      const k = kind[i];

      if (k === PARTICLE_KINDS.SMOKE || k === PARTICLE_KINDS.DUST) {
        // Rising smoke / expanding shock dust with air damping
        const drag = Math.max(0, 1 - 3.2 * stepDt);
        vx[i] *= drag;
        vy[i] *= drag;
        vz[i] = vz[i] * drag + 0.65 * stepDt;
      } else if (k === PARTICLE_KINDS.FEATHER) {
        // Fluttering drake feathers / wing scales
        const drag = Math.max(0, 1 - 2.6 * stepDt);
        vx[i] *= drag;
        vy[i] *= drag;
        vz[i] -= gravity * 0.28 * stepDt;
      } else {
        vz[i] -= gravity * stepDt;
      }

      px[i] += vx[i] * stepDt;
      py[i] += vy[i] * stepDt;
      pz[i] += vz[i] * stepDt;
      rot[i] += vrot[i] * stepDt;

      // Ground collision & bounce on pz
      if (pz[i] <= 0) {
        pz[i] = 0;
        if (vz[i] < -0.45) {
          const restitution = (k === PARTICLE_KINDS.PLATE || k === PARTICLE_KINDS.SHARD) ? 0.42 : (k === PARTICLE_KINDS.SLIME ? 0.14 : 0.3);
          vz[i] = -vz[i] * restitution;
          vx[i] *= 0.72;
          vy[i] *= 0.72;
          vrot[i] *= 0.6;
        } else {
          vz[i] = 0;
          vx[i] *= 0.84;
          vy[i] *= 0.84;
          vrot[i] *= 0.75;
        }
      }
    }

    this.activeCount = alive;
  }

  /**
   * Renders all live particles respecting maxParticles cap with zero allocations.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} camera
   */
  render(ctx, camera) {
    if (!ctx) return;

    const limit = Math.min(this._highWater, this.maxParticles);
    if (limit === 0) return;

    const scale = (camera && typeof camera.getScale === 'function')
      ? camera.getScale()
      : (camera && Number.isFinite(camera.scale) ? camera.scale : 36);
    const scaleFactor = scale / 36;

    let hasBounds = false;
    let minX = -Infinity;
    let maxX = Infinity;
    let minY = -Infinity;
    let maxY = Infinity;
    if (camera && typeof camera.getVisibleWorldBounds === 'function') {
      const b = camera.getVisibleWorldBounds();
      if (b && Number.isFinite(b.minX)) {
        hasBounds = true;
        minX = b.minX - 1.5;
        maxX = b.maxX + 1.5;
        minY = b.minY - 1.5;
        maxY = b.maxY + 1.5;
      }
    }

    const px = this.px;
    const py = this.py;
    const pz = this.pz;
    const vx = this.vx;
    const vy = this.vy;
    const life = this.life;
    const maxLife = this.maxLife;
    const size = this.size;
    const rArr = this.r;
    const gArr = this.g;
    const bArr = this.b;
    const aArr = this.a;
    const kindArr = this.kind;
    const rotArr = this.rot;
    const pt = this._pt;

    const prevAlpha = ctx.globalAlpha;
    let lastKey = -1;
    let lastStyle = '';

    for (let i = 0; i < limit; i++) {
      const rem = life[i];
      if (rem <= 0) continue;

      const wx = px[i];
      const wy = py[i];
      if (hasBounds && (wx < minX || wx > maxX || wy < minY || wy > maxY)) {
        continue;
      }

      projectWorld(camera, wx, wy, pz[i], pt);
      const sx = pt.x;
      const sy = pt.y;
      const ml = maxLife[i] > 1e-4 ? maxLife[i] : 0.01;
      const frac = rem / ml;
      const alpha = aArr[i] * (frac < 0.7 ? frac / 0.7 : 1);
      if (alpha <= 0.01) continue;

      const cr = rArr[i];
      const cg = gArr[i];
      const cb = bArr[i];
      const key = (cr << 16) | (cg << 8) | cb;
      if (key !== lastKey) {
        lastKey = key;
        lastStyle = this._getRgbString(cr, cg, cb, key);
      }

      const sz = size[i] * scaleFactor;
      const k = kindArr[i];
      const ang = rotArr[i];

      ctx.globalAlpha = alpha;
      ctx.fillStyle = lastStyle;

      if (k === PARTICLE_KINDS.SPARK) {
        const len = Math.max(sz * 1.4, Math.hypot(vx[i], vy[i]) * scale * 0.045);
        const dirA = Math.atan2(vy[i] * CAMERA_PITCH_Y, vx[i] || 0.001);
        const ca = Math.cos(dirA);
        const sa = Math.sin(dirA);
        ctx.strokeStyle = lastStyle;
        ctx.lineWidth = Math.max(1.1, sz * 0.45);
        ctx.beginPath();
        ctx.moveTo(sx - ca * len, sy - sa * len);
        ctx.lineTo(sx + ca * len * 0.6, sy + sa * len * 0.6);
        ctx.stroke();
      } else if (k === PARTICLE_KINDS.SHARD) {
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const h = sz * 1.35;
        const w = sz * 0.55;
        ctx.beginPath();
        ctx.moveTo(sx + ca * h, sy + sa * h);
        ctx.lineTo(sx - sa * w, sy + ca * w);
        ctx.lineTo(sx - ca * h * 0.8, sy - sa * h * 0.8);
        ctx.lineTo(sx + sa * w, sy - ca * w);
        ctx.closePath();
        ctx.fill();
      } else if (k === PARTICLE_KINDS.PLATE) {
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const hw = sz * 1.1;
        const hh = sz * 0.72;
        ctx.beginPath();
        ctx.moveTo(sx + ca * hw - sa * hh, sy + sa * hw + ca * hh);
        ctx.lineTo(sx - ca * hw - sa * hh, sy - sa * hw + ca * hh);
        ctx.lineTo(sx - ca * hw + sa * hh, sy - sa * hw - ca * hh);
        ctx.lineTo(sx + ca * hw + sa * hh, sy + sa * hw - ca * hh);
        ctx.closePath();
        ctx.fill();
      } else if (k === PARTICLE_KINDS.FEATHER) {
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        ctx.beginPath();
        ctx.moveTo(sx + ca * sz * 1.4, sy + sa * sz * 1.4);
        ctx.quadraticCurveTo(sx - sa * sz * 0.9, sy + ca * sz * 0.9, sx - ca * sz * 1.2, sy - sa * sz * 1.2);
        ctx.quadraticCurveTo(sx + sa * sz * 0.5, sy - ca * sz * 0.5, sx + ca * sz * 1.4, sy + sa * sz * 1.4);
        ctx.fill();
      } else if (k === PARTICLE_KINDS.SMOKE || k === PARTICLE_KINDS.DUST) {
        const expand = 1 + (1 - frac) * 0.95;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1.2, sz * expand), 0, TAU);
        ctx.fill();
      } else if (k === PARTICLE_KINDS.EMBER) {
        // Outer soft halo + bright center core (zero GPU blur)
        ctx.globalAlpha = alpha * 0.35;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1.5, sz * 1.7), 0, TAU);
        ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1.0, sz * 0.72), 0, TAU);
        ctx.fill();
      } else {
        // SLIME & default droplets
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(1.0, sz), 0, TAU);
        ctx.fill();
      }
    }

    ctx.globalAlpha = prevAlpha;
  }

  _getRgbString(r, g, b, key) {
    const slot = ((key * 2654435761) >>> 24) & 255;
    if (this._rgbKeys[slot] === key) {
      return this._rgbVals[slot];
    }
    const str = `rgb(${r},${g},${b})`;
    this._rgbKeys[slot] = key;
    this._rgbVals[slot] = str;
    return str;
  }

  _spawnCreepDeathBurst(ev, x, y, z) {
    const arch = ev.archetypeId || ev.archetype || 'ghoul_swarm';
    const dirVx = finiteOr(ev.vx, 0) * 0.45;
    const dirVy = finiteOr(ev.vy, 0) * 0.45;
    const wasFrozen = Boolean(ev.wasFrozen || (ev.frozenTimer || 0) > 0);

    if (wasFrozen) {
      this._spawnShatterBurst(x, y, z, 1.1);
    }

    switch (arch) {
      case 'ironclad_grunt': {
        // Iron plate scatter + sparks + acid droplets if corroded
        const corroded = (ev.acidStacks || 0) > 2;
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * TAU;
          const spd = 1.4 + Math.random() * 2.8;
          this.spawn({
            x, y, z: z + 0.2,
            vx: dirVx + Math.cos(a) * spd,
            vy: dirVy + Math.sin(a) * spd,
            vz: 2.2 + Math.random() * 3.4,
            life: 0.65 + Math.random() * 0.35,
            size: 3.8 + Math.random() * 2.4,
            r: corroded ? 74 : 115,
            g: corroded ? 124 : 132,
            b: corroded ? 64 : 150,
            a: 0.95,
            kind: PARTICLE_KINDS.PLATE,
            rot: Math.random() * TAU,
            vrot: (Math.random() - 0.5) * 16,
          });
        }
        for (let i = 0; i < 6; i++) {
          const a = Math.random() * TAU;
          const spd = 2.0 + Math.random() * 3.2;
          this.spawn({
            x, y, z: z + 0.3,
            vx: dirVx + Math.cos(a) * spd,
            vy: dirVy + Math.sin(a) * spd,
            vz: 2.0 + Math.random() * 2.5,
            life: 0.35 + Math.random() * 0.2,
            size: 2.5,
            r: 251, g: 191, b: 36, a: 1,
            kind: PARTICLE_KINDS.SPARK,
          });
        }
        break;
      }

      case 'brood_arachnid': {
        // Chitin shards + toxic ichor splatters
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * TAU;
          const spd = 1.2 + Math.random() * 2.9;
          const isIchor = i % 2 === 0;
          this.spawn({
            x, y, z: z + 0.15,
            vx: dirVx + Math.cos(a) * spd,
            vy: dirVy + Math.sin(a) * spd,
            vz: 1.6 + Math.random() * 2.8,
            life: 0.5 + Math.random() * 0.3,
            size: isIchor ? 3.2 : 3.6,
            r: isIchor ? 192 : 46,
            g: isIchor ? 38 : 30,
            b: isIchor ? 211 : 72,
            a: 0.92,
            kind: isIchor ? PARTICLE_KINDS.SLIME : PARTICLE_KINDS.SHARD,
            rot: Math.random() * TAU,
            vrot: (Math.random() - 0.5) * 14,
          });
        }
        break;
      }

      case 'sky_wyvern': {
        // Wing scales & feathers fluttering down from altitude
        const startZ = Math.max(0.7, z);
        for (let i = 0; i < 16; i++) {
          const a = Math.random() * TAU;
          const spd = 1.1 + Math.random() * 2.6;
          const isFeather = i < 11;
          this.spawn({
            x, y, z: startZ,
            vx: dirVx + Math.cos(a) * spd,
            vy: dirVy + Math.sin(a) * spd,
            vz: 1.0 + Math.random() * 2.4,
            life: isFeather ? (0.85 + Math.random() * 0.45) : 0.45,
            size: isFeather ? 4.0 : 3.0,
            r: isFeather ? 56 : 186,
            g: isFeather ? 189 : 230,
            b: isFeather ? 248 : 253,
            a: 0.95,
            kind: isFeather ? PARTICLE_KINDS.FEATHER : PARTICLE_KINDS.SHARD,
            rot: Math.random() * TAU,
            vrot: (Math.random() - 0.5) * 8,
          });
        }
        break;
      }

      case 'blood_shaman': {
        // Ritual crimson embers + dark cloak ash
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * TAU;
          const spd = 0.8 + Math.random() * 2.4;
          const isAsh = i % 3 === 0;
          this.spawn({
            x, y, z: z + 0.25,
            vx: dirVx + Math.cos(a) * spd,
            vy: dirVy + Math.sin(a) * spd,
            vz: 1.2 + Math.random() * 2.6,
            life: 0.55 + Math.random() * 0.35,
            size: isAsh ? 4.5 : 3.0,
            r: isAsh ? 63 : 244,
            g: isAsh ? 22 : 63,
            b: isAsh ? 36 : 94,
            a: isAsh ? 0.72 : 0.96,
            kind: isAsh ? PARTICLE_KINDS.SMOKE : PARTICLE_KINDS.EMBER,
          });
        }
        break;
      }

      case 'bulwark_golem': {
        // Heavy fractured stone plates + cyan runic shards + stone dust
        for (let i = 0; i < 18; i++) {
          const a = Math.random() * TAU;
          const spd = 1.0 + Math.random() * 2.6;
          const isRune = i % 4 === 0;
          const isDust = i % 4 === 3;
          this.spawn({
            x, y, z: z + 0.3,
            vx: dirVx + Math.cos(a) * spd,
            vy: dirVy + Math.sin(a) * spd,
            vz: isDust ? 0.6 : (1.8 + Math.random() * 3.0),
            life: 0.65 + Math.random() * 0.4,
            size: isDust ? 5.2 : (isRune ? 3.2 : 4.4),
            r: isRune ? 34 : 100,
            g: isRune ? 211 : 116,
            b: isRune ? 238 : 139,
            a: isDust ? 0.55 : 0.95,
            kind: isDust ? PARTICLE_KINDS.DUST : (isRune ? PARTICLE_KINDS.SHARD : PARTICLE_KINDS.PLATE),
            rot: Math.random() * TAU,
            vrot: (Math.random() - 0.5) * 12,
          });
        }
        break;
      }

      case 'void_splitter': {
        // Ectoplasmic violet slime splatters + indigo void sparks
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * TAU;
          const spd = 1.4 + Math.random() * 2.7;
          const isSlime = i % 3 !== 0;
          this.spawn({
            x, y, z: z + 0.2,
            vx: dirVx + Math.cos(a) * spd,
            vy: dirVy + Math.sin(a) * spd,
            vz: 1.5 + Math.random() * 2.5,
            life: 0.5 + Math.random() * 0.3,
            size: isSlime ? 3.8 : 2.6,
            r: isSlime ? 124 : 232,
            g: isSlime ? 58 : 121,
            b: isSlime ? 237 : 249,
            a: 0.9,
            kind: isSlime ? PARTICLE_KINDS.SLIME : PARTICLE_KINDS.EMBER,
          });
        }
        break;
      }

      case 'act_boss': {
        // Multi-ring boss detonation: crown gold shards, obsidian plates, fiery embers & ash
        for (let i = 0; i < 36; i++) {
          const a = (i * TAU) / 36 + Math.random() * 0.2;
          const spd = 1.8 + Math.random() * 4.2;
          const mod = i % 4;
          this.spawn({
            x, y, z: z + 0.45,
            vx: Math.cos(a) * spd,
            vy: Math.sin(a) * spd,
            vz: 2.2 + Math.random() * 4.6,
            life: 0.8 + Math.random() * 0.5,
            size: mod === 3 ? 6.0 : 4.5,
            r: mod === 0 ? 250 : (mod === 1 ? 249 : (mod === 2 ? 71 : 41)),
            g: mod === 0 ? 204 : (mod === 1 ? 115 : (mod === 2 ? 85 : 37)),
            b: mod === 0 ? 21 : (mod === 1 ? 22 : (mod === 2 ? 105 : 36)),
            a: mod === 3 ? 0.65 : 0.98,
            kind: mod === 0 ? PARTICLE_KINDS.SHARD : (mod === 1 ? PARTICLE_KINDS.EMBER : (mod === 2 ? PARTICLE_KINDS.PLATE : PARTICLE_KINDS.SMOKE)),
            rot: Math.random() * TAU,
            vrot: (Math.random() - 0.5) * 16,
          });
        }
        break;
      }

      case 'ghoul_swarm':
      default: {
        // Crimson flesh splatters + pale bone splinters
        for (let i = 0; i < 12; i++) {
          const a = Math.random() * TAU;
          const spd = 1.4 + Math.random() * 2.8;
          const isBone = i % 3 === 0;
          this.spawn({
            x, y, z: z + 0.2,
            vx: dirVx + Math.cos(a) * spd,
            vy: dirVy + Math.sin(a) * spd,
            vz: 1.5 + Math.random() * 2.8,
            life: 0.45 + Math.random() * 0.25,
            size: isBone ? 3.2 : 3.4,
            r: isBone ? 231 : 185,
            g: isBone ? 229 : 28,
            b: isBone ? 228 : 28,
            a: 0.92,
            kind: isBone ? PARTICLE_KINDS.SHARD : PARTICLE_KINDS.SLIME,
            rot: Math.random() * TAU,
            vrot: (Math.random() - 0.5) * 14,
          });
        }
        break;
      }
    }
  }

  _spawnShatterBurst(x, y, z, radius) {
    const count = 18;
    for (let i = 0; i < count; i++) {
      const a = (i * TAU) / count + (Math.random() - 0.5) * 0.35;
      const spd = (1.6 + Math.random() * 2.8) * Math.max(0.8, radius * 0.6);
      const isIceDust = i % 4 === 0;
      this.spawn({
        x, y, z: z + 0.2,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        vz: 2.0 + Math.random() * 3.4,
        life: 0.5 + Math.random() * 0.35,
        size: isIceDust ? 4.4 : 3.6,
        r: isIceDust ? 186 : 125,
        g: isIceDust ? 230 : 211,
        b: 253,
        a: isIceDust ? 0.65 : 0.96,
        kind: isIceDust ? PARTICLE_KINDS.DUST : PARTICLE_KINDS.SHARD,
        rot: Math.random() * TAU,
        vrot: (Math.random() - 0.5) * 18,
      });
    }
  }

  _spawnHitBurst(ev, x, y, z) {
    const tag = ev.fusionId || ev.lineageId || ev.attackType || '';
    let r = 251;
    let g = 191;
    let b = 36;
    let kind = PARTICLE_KINDS.SPARK;

    if (tag === 'frost' || tag === 'glacial_obelisk' || tag === 'windchill_flak' || tag === 'shatter_cannon') {
      r = 125; g = 211; b = 252; kind = PARTICLE_KINDS.SHARD;
    } else if (tag === 'venom' || tag === 'viper_gatling' || tag === 'plague_coil') {
      r = 74; g = 222; b = 128; kind = PARTICLE_KINDS.SLIME;
    } else if (tag === 'brazier' || tag === 'hellfire_mortar' || tag === 'solar_flare') {
      r = 249; g = 115; b = 22; kind = PARTICLE_KINDS.EMBER;
    } else if (tag === 'singularity_catapult' || tag === 'Magic') {
      r = 192; g = 132; b = 252; kind = PARTICLE_KINDS.EMBER;
    }

    for (let i = 0; i < 6; i++) {
      const a = Math.random() * TAU;
      const spd = 1.0 + Math.random() * 2.2;
      this.spawn({
        x, y, z,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        vz: 1.2 + Math.random() * 2.0,
        life: 0.28 + Math.random() * 0.18,
        size: 2.8,
        r, g, b, a: 0.92,
        kind,
        rot: Math.random() * TAU,
        vrot: (Math.random() - 0.5) * 12,
      });
    }
  }

  _spawnBuilderSparks(x, y, z) {
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * TAU;
      const spd = 1.2 + Math.random() * 2.4;
      const isHot = i % 2 === 0;
      this.spawn({
        x, y, z,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        vz: 2.4 + Math.random() * 2.6,
        life: 0.35 + Math.random() * 0.25,
        size: isHot ? 2.4 : 3.0,
        r: isHot ? 254 : 245,
        g: isHot ? 240 : 158,
        b: isHot ? 138 : 11,
        a: 1,
        kind: isHot ? PARTICLE_KINDS.SPARK : PARTICLE_KINDS.EMBER,
      });
    }
  }

  _spawnKnockupDust(x, y, radius) {
    const count = 14;
    for (let i = 0; i < count; i++) {
      const a = (i * TAU) / count + Math.random() * 0.2;
      const spd = (1.2 + Math.random() * 1.8) * Math.max(0.7, radius * 0.65);
      const isChip = i % 3 === 0;
      this.spawn({
        x: x + Math.cos(a) * 0.18,
        y: y + Math.sin(a) * 0.18,
        z: 0.05,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        vz: isChip ? (1.8 + Math.random() * 2.0) : (0.5 + Math.random() * 0.8),
        life: 0.45 + Math.random() * 0.3,
        size: isChip ? 3.0 : 4.8,
        r: isChip ? 148 : 120,
        g: isChip ? 163 : 113,
        b: isChip ? 184 : 108,
        a: isChip ? 0.9 : 0.6,
        kind: isChip ? PARTICLE_KINDS.PLATE : PARTICLE_KINDS.DUST,
        rot: Math.random() * TAU,
        vrot: (Math.random() - 0.5) * 10,
      });
    }
  }
}
