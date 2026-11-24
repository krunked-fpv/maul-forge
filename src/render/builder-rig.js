import {
  SIM_EVENTS,
  CAMERA_PITCH_Y,
} from '../contracts/types.js';

const MAX_TRAIL = 24;
const MAX_SPARKS = 96;
const MAX_SHOCKWAVES = 16;

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

/**
 * Renders The Architect hovering spirit builder with glowing arcane trail,
 * orbiting brass calipers, swinging rune-hammer, anvil spark bursts, and
 * golden completion shockwaves.
 */
export class BuilderRigRenderer {
  constructor() {
    this.trailX = new Float32Array(MAX_TRAIL);
    this.trailY = new Float32Array(MAX_TRAIL);
    this.trailZ = new Float32Array(MAX_TRAIL);
    this.trailLife = new Float32Array(MAX_TRAIL);
    this._trailCursor = 0;
    this._lastTrailX = NaN;
    this._lastTrailY = NaN;

    this.sparkX = new Float32Array(MAX_SPARKS);
    this.sparkY = new Float32Array(MAX_SPARKS);
    this.sparkZ = new Float32Array(MAX_SPARKS);
    this.sparkVx = new Float32Array(MAX_SPARKS);
    this.sparkVy = new Float32Array(MAX_SPARKS);
    this.sparkVz = new Float32Array(MAX_SPARKS);
    this.sparkLife = new Float32Array(MAX_SPARKS);
    this.sparkMaxLife = new Float32Array(MAX_SPARKS);
    this._sparkCursor = 0;

    this.waveX = new Float32Array(MAX_SHOCKWAVES);
    this.waveY = new Float32Array(MAX_SHOCKWAVES);
    this.waveLife = new Float32Array(MAX_SHOCKWAVES);
    this.waveMaxLife = new Float32Array(MAX_SHOCKWAVES);
    this.waveMaxRadius = new Float32Array(MAX_SHOCKWAVES);
    this._waveCursor = 0;

    this._rngState = 0x9e3779b9;
    this._p0 = { x: 0, y: 0 };
    this._p1 = { x: 0, y: 0 };
    this._p2 = { x: 0, y: 0 };
  }

  _nextRand() {
    let x = this._rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this._rngState = x | 0;
    return ((x >>> 0) % 10000) / 10000;
  }

  _spawnSparkBurst(wx, wy, wz, count, speedMult = 1) {
    for (let i = 0; i < count; i++) {
      const idx = this._sparkCursor;
      this._sparkCursor = (idx + 1) % MAX_SPARKS;
      const ang = this._nextRand() * Math.PI * 2;
      const spd = (1.6 + this._nextRand() * 3.4) * speedMult;

      this.sparkX[idx] = wx;
      this.sparkY[idx] = wy;
      this.sparkZ[idx] = wz;
      this.sparkVx[idx] = Math.cos(ang) * spd;
      this.sparkVy[idx] = Math.sin(ang) * spd;
      this.sparkVz[idx] = (2.2 + this._nextRand() * 3.6) * speedMult;
      const life = 0.28 + this._nextRand() * 0.34;
      this.sparkLife[idx] = life;
      this.sparkMaxLife[idx] = life;
    }
  }

  _spawnShockwave(wx, wy, maxRadius = 2.4, duration = 0.65) {
    const idx = this._waveCursor;
    this._waveCursor = (idx + 1) % MAX_SHOCKWAVES;
    this.waveX[idx] = wx;
    this.waveY[idx] = wy;
    this.waveLife[idx] = duration;
    this.waveMaxLife[idx] = duration;
    this.waveMaxRadius[idx] = maxRadius;
  }

  handleSimEvent(ev) {
    if (!ev || !ev.type) return;
    const wx = Number.isFinite(ev.wx) ? ev.wx : (Number.isFinite(ev.x) ? ev.x : (Number.isFinite(ev.col) ? ev.col + 1 : NaN));
    const wy = Number.isFinite(ev.wy) ? ev.wy : (Number.isFinite(ev.y) ? ev.y : (Number.isFinite(ev.row) ? ev.row + 1 : NaN));
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;

    if (ev.type === SIM_EVENTS.BUILDER_SPARK) {
      this._spawnSparkBurst(wx, wy, Number.isFinite(ev.wz) ? ev.wz : 0.45, 8, 1.0);
    } else if (ev.type === SIM_EVENTS.TOWER_COMPLETE || ev.type === SIM_EVENTS.TOWER_FUSED) {
      const isFusion = ev.type === SIM_EVENTS.TOWER_FUSED;
      this._spawnShockwave(wx, wy, isFusion ? 3.2 : 2.35, isFusion ? 0.8 : 0.6);
      this._spawnSparkBurst(wx, wy, 0.55, isFusion ? 18 : 12, 1.25);
    }
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const step = Math.min(dt, 0.1);

    for (let i = 0; i < MAX_TRAIL; i++) {
      if (this.trailLife[i] > 0) {
        this.trailLife[i] = Math.max(0, this.trailLife[i] - step);
      }
    }

    const gravity = 13.5;
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= step;
      if (this.sparkLife[i] <= 0) {
        this.sparkLife[i] = 0;
        continue;
      }
      this.sparkX[i] += this.sparkVx[i] * step;
      this.sparkY[i] += this.sparkVy[i] * step;
      this.sparkVz[i] -= gravity * step;
      this.sparkZ[i] += this.sparkVz[i] * step;
      if (this.sparkZ[i] < 0) {
        this.sparkZ[i] = 0;
        this.sparkVz[i] = Math.abs(this.sparkVz[i]) * 0.42;
        this.sparkVx[i] *= 0.72;
        this.sparkVy[i] *= 0.72;
      }
    }

    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      if (this.waveLife[i] > 0) {
        this.waveLife[i] = Math.max(0, this.waveLife[i] - step);
      }
    }
  }

  _recordTrail(wx, wy, wz) {
    if (!Number.isFinite(this._lastTrailX)) {
      this._lastTrailX = wx;
      this._lastTrailY = wy;
    } else {
      const dx = wx - this._lastTrailX;
      const dy = wy - this._lastTrailY;
      if (dx * dx + dy * dy < 0.012) return;
      this._lastTrailX = wx;
      this._lastTrailY = wy;
    }

    const idx = this._trailCursor;
    this._trailCursor = (idx + 1) % MAX_TRAIL;
    this.trailX[idx] = wx;
    this.trailY[idx] = wy;
    this.trailZ[idx] = wz;
    this.trailLife[idx] = 0.48;
  }

  render(ctx, camera, builder, timeSec = 0) {
    if (!ctx || !camera) return;
    const scale = camera.getScale();

    // 1. Golden completion shockwave rings
    this._renderShockwaves(ctx, camera, scale);

    // 2. The Architect spirit wisp + trail + calipers + swinging rune-hammer
    if (builder && Number.isFinite(builder.x) && Number.isFinite(builder.y)) {
      const bx = builder.x;
      const by = builder.y;
      const hoverZ = 0.74 + Math.sin(timeSec * 3.8) * 0.1;

      this._recordTrail(bx, by, hoverZ);
      this._renderTrail(ctx, camera, scale);
      this._renderArchitect(ctx, camera, builder, bx, by, hoverZ, scale, timeSec);
    }

    // 3. Anvil spark bursts
    this._renderSparks(ctx, camera, scale);
  }

  _renderShockwaves(ctx, camera, scale) {
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const life = this.waveLife[i];
      if (life <= 0) continue;
      const maxLife = this.waveMaxLife[i] || 1;
      const t = 1 - clamp(life / maxLife, 0, 1);
      const alpha = (1 - t) * 0.85;
      const r = (0.35 + t * this.waveMaxRadius[i]) * scale;
      const ry = r * CAMERA_PITCH_Y;
      const pos = camera.worldToScreen(this.waveX[i], this.waveY[i], 0.04, this._p0);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = Math.max(1.5, scale * 0.11 * (1 - t * 0.6));
      ctx.beginPath();
      drawEllipse(ctx, pos.x, pos.y, r, ry);
      ctx.stroke();

      ctx.strokeStyle = '#fef08a';
      ctx.lineWidth = Math.max(1, scale * 0.05);
      ctx.beginPath();
      drawEllipse(ctx, pos.x, pos.y, r * 0.78, ry * 0.78);
      ctx.stroke();
      ctx.restore();
    }
  }

  _renderTrail(ctx, camera, scale) {
    for (let i = 0; i < MAX_TRAIL; i++) {
      const life = this.trailLife[i];
      if (life <= 0) continue;
      const t = clamp(life / 0.48, 0, 1);
      const p = camera.worldToScreen(this.trailX[i], this.trailY[i], this.trailZ[i], this._p0);
      const r = scale * 0.2 * t;

      ctx.fillStyle = `rgba(56, 189, 248, ${t * 0.28})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(250, 204, 21, ${t * 0.45})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.65, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _renderArchitect(ctx, camera, builder, bx, by, hoverZ, scale, timeSec) {
    const shadow = camera.worldToScreen(bx + 0.1, by + 0.1, 0, this._p0);
    const core = camera.worldToScreen(bx, by, hoverZ, this._p1);

    ctx.save();

    // Ground drop shadow
    ctx.fillStyle = 'rgba(2, 6, 14, 0.42)';
    ctx.beginPath();
    drawEllipse(ctx, shadow.x, shadow.y, scale * 0.36, scale * 0.36 * CAMERA_PITCH_Y);
    ctx.fill();

    // Soft layered spirit aura (translucent layered fills)
    ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
    ctx.beginPath();
    ctx.arc(core.x, core.y, scale * 0.48, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(212, 162, 56, 0.22)';
    ctx.beginPath();
    ctx.arc(core.x, core.y, scale * 0.34, 0, Math.PI * 2);
    ctx.fill();

    // Orbiting brass calipers (2 articulated curved drafting arcs)
    for (let c = 0; c < 2; c++) {
      const a = timeSec * 2.4 + c * Math.PI;
      const tilt = c === 0 ? 0.45 : -0.45;
      ctx.strokeStyle = '#d4a238';
      ctx.lineWidth = Math.max(1.4, scale * 0.05);
      ctx.beginPath();
      drawEllipse(ctx, core.x, core.y, scale * 0.42, scale * 0.16, tilt, a, a + 1.8);
      ctx.stroke();

      const tipX = core.x + Math.cos(a + 1.8) * scale * 0.42 * Math.cos(tilt) - Math.sin(a + 1.8) * scale * 0.16 * Math.sin(tilt);
      const tipY = core.y + Math.cos(a + 1.8) * scale * 0.42 * Math.sin(tilt) + Math.sin(a + 1.8) * scale * 0.16 * Math.cos(tilt);
      ctx.fillStyle = '#fde68a';
      ctx.beginPath();
      ctx.arc(tipX, tipY, scale * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }

    // Hovering obsidian-gold spirit core diamond
    const cw = scale * 0.22;
    const ch = scale * 0.32;

    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(core.x, core.y - ch);
    ctx.lineTo(core.x + cw, core.y);
    ctx.lineTo(core.x, core.y + ch);
    ctx.lineTo(core.x - cw, core.y);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = Math.max(1.5, scale * 0.055);
    ctx.stroke();

    // Glowing cyan inner rune eye
    ctx.fillStyle = '#7dd3fc';
    ctx.beginPath();
    ctx.moveTo(core.x, core.y - ch * 0.45);
    ctx.lineTo(core.x + cw * 0.45, core.y);
    ctx.lineTo(core.x, core.y + ch * 0.45);
    ctx.lineTo(core.x - cw * 0.45, core.y);
    ctx.closePath();
    ctx.fill();

    // Swinging rune-hammer when building
    const isBuilding =
      builder.targetTowerId != null ||
      Boolean(builder.activeTask) ||
      (Number.isFinite(builder.swingPhase) && builder.swingPhase > 0);

    if (isBuilding) {
      const phase = Number.isFinite(builder.swingPhase) && builder.swingPhase > 0
        ? builder.swingPhase
        : timeSec * 11;
      const swing = Math.sin(phase) * 0.95 - 0.35;
      const handleLen = scale * 0.42;
      const pivotX = core.x + scale * 0.2;
      const pivotY = core.y - scale * 0.06;
      const hx = pivotX + Math.cos(swing) * handleLen;
      const hy = pivotY + Math.sin(swing) * handleLen;

      // Hammer shaft
      ctx.strokeStyle = '#b47b49';
      ctx.lineWidth = Math.max(1.6, scale * 0.055);
      ctx.beginPath();
      ctx.moveTo(pivotX, pivotY);
      ctx.lineTo(hx, hy);
      ctx.stroke();

      // Golden rune-hammer head perpendicular to shaft
      const nx = -Math.sin(swing) * scale * 0.14;
      const ny = Math.cos(swing) * scale * 0.14;
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = Math.max(3, scale * 0.14);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(hx - nx, hy - ny);
      ctx.lineTo(hx + nx, hy + ny);
      ctx.stroke();

      ctx.fillStyle = '#e0f2fe';
      ctx.beginPath();
      ctx.arc(hx, hy, scale * 0.055, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  _renderSparks(ctx, camera, scale) {
    for (let i = 0; i < MAX_SPARKS; i++) {
      const life = this.sparkLife[i];
      if (life <= 0) continue;
      const maxLife = this.sparkMaxLife[i] || 1;
      const t = clamp(life / maxLife, 0, 1);

      const p = camera.worldToScreen(this.sparkX[i], this.sparkY[i], this.sparkZ[i], this._p0);
      const tail = camera.worldToScreen(
        this.sparkX[i] - this.sparkVx[i] * 0.025,
        this.sparkY[i] - this.sparkVy[i] * 0.025,
        Math.max(0, this.sparkZ[i] - this.sparkVz[i] * 0.025),
        this._p1
      );

      ctx.strokeStyle = t > 0.5 ? `rgba(254, 240, 138, ${t})` : `rgba(251, 146, 60, ${t})`;
      ctx.lineWidth = Math.max(1.2, scale * 0.055 * t);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }
}
