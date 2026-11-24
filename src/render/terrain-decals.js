import {
  GRID_COLS,
  GRID_ROWS,
  CAMERA_PITCH_Y,
  CAMERA_ELEV_SCALE,
  SPAWN_GATES,
  WAYPOINTS,
  NEXUS_CORE,
  STATIC_OBSTACLES,
  MAX_DECALS,
  SIM_EVENTS,
  CELL_FLAGS,
} from '../contracts/types.js';

const DECAL_TYPE_MAP = Object.freeze({
  scorch: 0,
  acid: 1,
  frost: 2,
  crack: 3,
  slag: 4,
  rune: 5,
});

const LINEAGE_GHOST_COLORS = Object.freeze({
  ballista: '#d4a238',
  mortar: '#f59e0b',
  frost: '#38bdf8',
  tesla: '#60a5fa',
  venom: '#4ade80',
  brazier: '#fb7185',
});

const CACHE_PAD_X = 1.25;
const CACHE_PAD_TOP = 2.0;
const CACHE_PAD_BOTTOM = 1.25;
const MAX_CACHE_DIM = 3072;

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

function tileHash(col, row) {
  let h = (col * 374761393 + row * 668265263) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h ^ (h >> 16)) >>> 0;
}

function drawEllipse(ctx, cx, cy, rx, ry, rot = 0, start = 0, end = Math.PI * 2) {
  if (rx <= 0 || ry <= 0) return;
  if (typeof ctx.ellipse === 'function') {
    ctx.ellipse(cx, cy, rx, ry, rot, start, end);
    return;
  }
  const steps = 18;
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

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
}

function setDash(ctx, arr) {
  if (typeof ctx.setLineDash === 'function') {
    ctx.setLineDash(arr);
  }
}

function createOffscreenCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(width, height);
    } catch {
      // Fall through to document canvas fallback
    }
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

/**
 * Renders the cached 32x22 carved runic slate sanctuary grid, Obsidian Pillars,
 * dual ley-line paths, animated Spawn/Waypoint/Nexus landmarks, 256-slot pooled
 * persistent decals, and placement ghost previews with travel-time delta badges.
 */
export class TerrainRenderer {
  constructor() {
    this._cacheCanvas = null;
    this._cacheCtx = null;
    this._cachedScale = -1;
    this._cachedDpr = -1;
    this._cacheRasterScale = 1;

    this.decalType = new Uint8Array(MAX_DECALS);
    this.decalX = new Float32Array(MAX_DECALS);
    this.decalY = new Float32Array(MAX_DECALS);
    this.decalRadius = new Float32Array(MAX_DECALS);
    this.decalLife = new Float32Array(MAX_DECALS);
    this.decalMaxLife = new Float32Array(MAX_DECALS);
    this.decalSeed = new Float32Array(MAX_DECALS);
    this._decalCursor = 0;

    this._ptA = { x: 0, y: 0 };
    this._ptB = { x: 0, y: 0 };
  }

  addDecal(type, wx, wy, radius = 0.85, lifeSec = 9.0) {
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    const idx = this._decalCursor;
    this._decalCursor = (idx + 1) % MAX_DECALS;

    const mapped =
      typeof type === 'number'
        ? type | 0
        : (DECAL_TYPE_MAP[String(type || 'scorch').toLowerCase()] ?? 0);

    this.decalType[idx] = mapped;
    this.decalX[idx] = wx;
    this.decalY[idx] = wy;
    this.decalRadius[idx] = Math.max(0.2, Number(radius) || 0.85);
    const maxLife = Math.max(0.25, Number(lifeSec) || 9.0);
    this.decalLife[idx] = maxLife;
    this.decalMaxLife[idx] = maxLife;
    this.decalSeed[idx] = ((Math.sin(wx * 12.9898 + wy * 78.233 + idx) * 43758.5453) % 1 + 1) % 1;
  }

  handleSimEvent(ev) {
    if (!ev || !ev.type) return;
    const wx = Number.isFinite(ev.wx) ? ev.wx : (Number.isFinite(ev.x) ? ev.x : (Number.isFinite(ev.col) ? ev.col + 1 : NaN));
    const wy = Number.isFinite(ev.wy) ? ev.wy : (Number.isFinite(ev.y) ? ev.y : (Number.isFinite(ev.row) ? ev.row + 1 : NaN));

    switch (ev.type) {
      case SIM_EVENTS.TERRAIN_DECAL:
        this.addDecal(ev.decalType || ev.kind || ev.subtype || 'scorch', wx, wy, ev.radius ?? 0.9, ev.lifeSec ?? ev.life ?? 10);
        break;
      case SIM_EVENTS.TOWER_PLACED:
        this.addDecal('crack', wx, wy, 1.15, 7.0);
        break;
      case SIM_EVENTS.TOWER_COMPLETE:
        this.addDecal('rune', wx, wy, 1.3, 4.5);
        break;
      case SIM_EVENTS.TOWER_FUSED:
        this.addDecal('rune', wx, wy, 1.65, 8.0);
        this.addDecal('scorch', wx, wy, 1.35, 10.0);
        break;
      case SIM_EVENTS.SHATTER_COMBO:
        this.addDecal('frost', wx, wy, ev.radius ?? 1.4, 8.5);
        this.addDecal('crack', wx, wy, ev.radius ?? 1.15, 9.5);
        break;
      case SIM_EVENTS.KNOCKUP_LAND:
        this.addDecal('crack', wx, wy, ev.radius ?? 1.2, 8.0);
        break;
      case SIM_EVENTS.PROJECTILE_HIT: {
        if (ev.decalType) {
          this.addDecal(ev.decalType, wx, wy, ev.radius ?? 0.9, ev.lifeSec ?? 9.0);
        } else if (ev.lineageId === 'hellfire_mortar' || ev.fusionId === 'hellfire_mortar') {
          this.addDecal('slag', wx, wy, ev.splash || 1.25, 11.0);
        } else if (ev.attackType === 'Siege' || (ev.splash && ev.splash >= 1.2)) {
          this.addDecal('scorch', wx, wy, Math.min(1.8, (ev.splash || 1.0) * 0.65), 8.5);
        } else if (ev.lineageId === 'venom' || ev.lineageId === 'plague_coil') {
          this.addDecal('acid', wx, wy, 0.72, 6.5);
        } else if (ev.lineageId === 'frost' || ev.lineageId === 'shatter_cannon') {
          this.addDecal('frost', wx, wy, 0.85, 6.0);
        }
        break;
      }
      case SIM_EVENTS.NEXUS_LEAK:
        this.addDecal('scorch', NEXUS_CORE.cx, NEXUS_CORE.cy, 1.7, 6.0);
        break;
      default:
        break;
    }
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const step = Math.min(dt, 0.25);
    for (let i = 0; i < MAX_DECALS; i++) {
      if (this.decalLife[i] > 0) {
        const next = this.decalLife[i] - step;
        this.decalLife[i] = next > 0 ? next : 0;
      }
    }
  }

  _ensureStaticCache(scale, dpr) {
    if (this._cacheCanvas && this._cachedScale === scale && this._cachedDpr === dpr) {
      return this._cacheCanvas;
    }

    const worldSpanW = GRID_COLS + CACHE_PAD_X * 2;
    const worldSpanH = (GRID_ROWS + CACHE_PAD_TOP + CACHE_PAD_BOTTOM) * CAMERA_PITCH_Y;
    const desiredRaster = scale * dpr;
    const maxScaleX = MAX_CACHE_DIM / worldSpanW;
    const maxScaleY = MAX_CACHE_DIM / worldSpanH;
    const rasterScale = Math.max(4, Math.min(desiredRaster, maxScaleX, maxScaleY));

    const pxW = Math.max(1, Math.round(worldSpanW * rasterScale));
    const pxH = Math.max(1, Math.round(worldSpanH * rasterScale));

    if (!this._cacheCanvas || this._cacheCanvas.width !== pxW || this._cacheCanvas.height !== pxH) {
      this._cacheCanvas = createOffscreenCanvas(pxW, pxH);
      this._cacheCtx = this._cacheCanvas ? this._cacheCanvas.getContext('2d') : null;
    }

    this._cachedScale = scale;
    this._cachedDpr = dpr;
    this._cacheRasterScale = rasterScale;

    if (!this._cacheCtx) {
      return null;
    }

    this._cacheCtx.clearRect(0, 0, pxW, pxH);
    const originX = CACHE_PAD_X * rasterScale;
    const originY = CACHE_PAD_TOP * rasterScale * CAMERA_PITCH_Y;
    this._drawStaticSanctuary(this._cacheCtx, originX, originY, rasterScale);
    return this._cacheCanvas;
  }

  _drawStaticSanctuary(ctx, originX, originY, scale) {
    const tileW = scale;
    const tileH = scale * CAMERA_PITCH_Y;
    const elev = scale * CAMERA_ELEV_SCALE;
    const gridW = GRID_COLS * tileW;
    const gridH = GRID_ROWS * tileH;

    // Outer bastion stone plinth border
    const border = tileW * 0.42;
    ctx.fillStyle = '#07090f';
    ctx.fillRect(originX - border * 1.4, originY - border * 1.1, gridW + border * 2.8, gridH + border * 2.6);

    ctx.fillStyle = '#171d29';
    ctx.beginPath();
    drawRoundedRectPath(ctx, originX - border, originY - border * 0.85, gridW + border * 2, gridH + border * 1.75, tileW * 0.25);
    ctx.fill();

    ctx.strokeStyle = '#2b3448';
    ctx.lineWidth = Math.max(1, scale * 0.05);
    ctx.stroke();

    // Inner recessed parapet shadow edge
    ctx.fillStyle = '#090c13';
    ctx.fillRect(originX - 2, originY - 2, gridW + 4, gridH + 4);

    // 32x22 carved runic slate cells
    const inset = Math.max(0.75, scale * 0.035);
    for (let row = 0; row < GRID_ROWS; row++) {
      const y = originY + row * tileH;
      for (let col = 0; col < GRID_COLS; col++) {
        const x = originX + col * tileW;
        const h = tileHash(col, row);
        const checker = (col + row) & 1;
        const tone = (h & 7) - 3;

        const r = 18 + checker * 3 + tone;
        const g = 23 + checker * 3 + tone;
        const b = 34 + checker * 5 + Math.floor(tone * 1.2);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x + inset, y + inset, tileW - inset * 2, tileH - inset * 2);

        // Top-left stone bevel highlight
        ctx.fillStyle = 'rgba(148, 163, 184, 0.07)';
        ctx.fillRect(x + inset, y + inset, tileW - inset * 2, Math.max(1, tileH * 0.08));
        ctx.fillRect(x + inset, y + inset, Math.max(1, tileW * 0.07), tileH - inset * 2);

        // Bottom-right carved shadow bevel
        ctx.fillStyle = 'rgba(2, 6, 15, 0.35)';
        ctx.fillRect(x + inset, y + tileH - inset - Math.max(1, tileH * 0.1), tileW - inset * 2, Math.max(1, tileH * 0.1));

        // Deterministic carved sanctuary runes
        if (h % 11 === 0) {
          const cx = x + tileW * 0.5;
          const cy = y + tileH * 0.5;
          const rw = tileW * 0.22;
          const rh = tileH * 0.22;
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
          ctx.lineWidth = Math.max(1, scale * 0.03);
          ctx.beginPath();
          if ((h & 16) !== 0) {
            ctx.moveTo(cx, cy - rh);
            ctx.lineTo(cx + rw, cy);
            ctx.lineTo(cx, cy + rh);
            ctx.lineTo(cx - rw, cy);
            ctx.closePath();
          } else {
            ctx.moveTo(cx - rw, cy - rh * 0.6);
            ctx.lineTo(cx, cy + rh * 0.7);
            ctx.lineTo(cx + rw, cy - rh * 0.6);
          }
          ctx.stroke();
        }
      }
    }

    // Subtle 2x2 maze guide alignment lines
    ctx.strokeStyle = 'rgba(212, 162, 56, 0.075)';
    ctx.lineWidth = Math.max(1, scale * 0.025);
    ctx.beginPath();
    for (let col = 2; col < GRID_COLS; col += 2) {
      const gx = originX + col * tileW;
      ctx.moveTo(gx, originY);
      ctx.lineTo(gx, originY + gridH);
    }
    for (let row = 2; row < GRID_ROWS; row += 2) {
      const gy = originY + row * tileH;
      ctx.moveTo(originX, gy);
      ctx.lineTo(originX + gridW, gy);
    }
    ctx.stroke();

    // Central sanctuary brass boundary trim
    ctx.strokeStyle = 'rgba(212, 162, 56, 0.35)';
    ctx.lineWidth = Math.max(1.5, scale * 0.06);
    ctx.strokeRect(originX, originY, gridW, gridH);

    // 4 Static 1x2 Obsidian Pillars
    for (let i = 0; i < STATIC_OBSTACLES.length; i++) {
      const obs = STATIC_OBSTACLES[i];
      this._drawObsidianPillar(ctx, originX, originY, tileW, tileH, elev, obs);
    }
  }

  _drawObsidianPillar(ctx, originX, originY, tileW, tileH, elev, obs) {
    const x = originX + obs.col * tileW;
    const y = originY + obs.row * tileH;
    const w = obs.w * tileW;
    const h = obs.h * tileH;
    const pillarH = elev * 1.35;
    const pad = tileW * 0.1;

    // 2.5D cast shadow
    ctx.fillStyle = 'rgba(2, 4, 10, 0.55)';
    ctx.beginPath();
    ctx.moveTo(x + pad, y + h);
    ctx.lineTo(x + w + tileW * 0.42, y + h + tileH * 0.25);
    ctx.lineTo(x + w + tileW * 0.42, y + tileH * 0.25);
    ctx.lineTo(x + w - pad, y);
    ctx.closePath();
    ctx.fill();

    // Stepped stone plinth base
    ctx.fillStyle = '#1b2232';
    ctx.fillRect(x + pad * 0.5, y + pad * 0.4, w - pad, h - pad * 0.8);
    ctx.strokeStyle = '#3c4863';
    ctx.lineWidth = Math.max(1, tileW * 0.035);
    ctx.strokeRect(x + pad * 0.5, y + pad * 0.4, w - pad, h - pad * 0.8);

    // Front obsidian shaft
    const bodyX = x + pad * 1.4;
    const bodyW = w - pad * 2.8;
    const baseBottom = y + h - pad * 1.2;
    const topY = y - pillarH;
    const topH = h - pad * 2.4;

    ctx.fillStyle = '#0c1018';
    ctx.beginPath();
    ctx.moveTo(bodyX, topY + topH * 0.5);
    ctx.lineTo(bodyX + bodyW, topY + topH * 0.5);
    ctx.lineTo(bodyX + bodyW, baseBottom);
    ctx.lineTo(bodyX, baseBottom);
    ctx.closePath();
    ctx.fill();

    // Chiseled front sheen
    ctx.fillStyle = '#171f2e';
    ctx.fillRect(bodyX + bodyW * 0.12, topY + topH * 0.5, bodyW * 0.35, baseBottom - (topY + topH * 0.5));

    // Top faceted obsidian cap
    ctx.fillStyle = '#1f293d';
    ctx.beginPath();
    ctx.moveTo(bodyX, topY + topH * 0.5);
    ctx.lineTo(bodyX + bodyW * 0.5, topY);
    ctx.lineTo(bodyX + bodyW, topY + topH * 0.5);
    ctx.lineTo(bodyX + bodyW * 0.5, topY + topH);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#d4a238';
    ctx.lineWidth = Math.max(1, tileW * 0.04);
    ctx.stroke();

    // Glowing rune inlay slit
    const cx = bodyX + bodyW * 0.5;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
    ctx.lineWidth = Math.max(1.2, tileW * 0.06);
    ctx.beginPath();
    ctx.moveTo(cx, topY + topH + tileH * 0.1);
    ctx.lineTo(cx, baseBottom - tileH * 0.2);
    ctx.stroke();
  }

  render(ctx, camera, sim = null, timeSec = 0, ghostPreview = null) {
    if (!ctx || !camera) return;
    const scale = camera.getScale();
    const dpr = camera.dpr || 1;

    // 1. Static carved runic slate sanctuary grid + Obsidian Pillars
    const topLeft = camera.worldToScreen(-CACHE_PAD_X, -CACHE_PAD_TOP, 0, this._ptA);
    const cache = this._ensureStaticCache(scale, dpr);
    if (cache) {
      const worldSpanW = GRID_COLS + CACHE_PAD_X * 2;
      const worldSpanH = (GRID_ROWS + CACHE_PAD_TOP + CACHE_PAD_BOTTOM) * CAMERA_PITCH_Y;
      ctx.drawImage(
        cache,
        topLeft.x,
        topLeft.y,
        worldSpanW * scale,
        worldSpanH * scale
      );
    } else {
      const origin = camera.worldToScreen(0, 0, 0, this._ptB);
      this._drawStaticSanctuary(ctx, origin.x, origin.y, scale);
    }

    // 2. Subtle ley-line channels along dual golden paths
    this._renderLeyChannels(ctx, camera, sim, scale, timeSec);

    // 3. Persistent 256-slot pooled terrain decals
    this._renderDecals(ctx, camera, scale, timeSec);

    // 4. Glowing North / South Spawn Rifts
    for (let i = 0; i < SPAWN_GATES.length; i++) {
      this._renderSpawnRift(ctx, camera, SPAWN_GATES[i], scale, timeSec);
    }

    // 5. Central Ley Shrine Waypoint
    for (let i = 0; i < WAYPOINTS.length; i++) {
      this._renderLeyShrine(ctx, camera, WAYPOINTS[i], scale, timeSec);
    }

    // 6. Pulsing 2.5D Arcane Nexus Crystal
    this._renderNexusCore(ctx, camera, sim, scale, timeSec);

    // 7. Tower placement ghost preview + animated reroute ribbon + delta badge
    if (ghostPreview && Number.isFinite(ghostPreview.col) && Number.isFinite(ghostPreview.row)) {
      this._renderGhostPreview(ctx, camera, ghostPreview, scale, timeSec);
    }
  }

  _renderLeyChannels(ctx, camera, sim, scale, timeSec) {
    const flowField = sim && sim.flowField;
    if (!flowField || typeof flowField.traceGoldenPath !== 'function') return;

    for (let gate = 0; gate < SPAWN_GATES.length; gate++) {
      const path = flowField.traceGoldenPath(gate);
      if (!path || path.length < 2) continue;

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // Dark stone channel trench
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const pt = camera.worldToScreen(path[i].x, path[i].y, 0, this._ptA);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.strokeStyle = 'rgba(14, 165, 233, 0.14)';
      ctx.lineWidth = Math.max(2, scale * 0.24);
      ctx.stroke();

      // Animated ley filament
      setDash(ctx, [scale * 0.45, scale * 0.55]);
      if ('lineDashOffset' in ctx) {
        ctx.lineDashOffset = -timeSec * scale * 1.4;
      }
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.34)';
      ctx.lineWidth = Math.max(1.2, scale * 0.08);
      ctx.stroke();
      setDash(ctx, []);
      ctx.restore();
    }
  }

  _renderDecals(ctx, camera, scale, timeSec) {
    for (let i = 0; i < MAX_DECALS; i++) {
      const life = this.decalLife[i];
      if (life <= 0) continue;

      const maxLife = this.decalMaxLife[i] || 1;
      const alpha = clamp(life / Math.min(maxLife, 2.0), 0, 1);
      const pos = camera.worldToScreen(this.decalX[i], this.decalY[i], 0, this._ptA);
      const rx = this.decalRadius[i] * scale;
      const ry = rx * CAMERA_PITCH_Y;
      const kind = this.decalType[i];
      const seed = this.decalSeed[i];

      ctx.save();
      ctx.globalAlpha = alpha;

      if (kind === 0) {
        // Scorch crater
        ctx.fillStyle = 'rgba(6, 7, 10, 0.68)';
        ctx.beginPath();
        drawEllipse(ctx, pos.x, pos.y, rx, ry);
        ctx.fill();

        ctx.fillStyle = 'rgba(24, 14, 10, 0.55)';
        ctx.beginPath();
        drawEllipse(ctx, pos.x, pos.y, rx * 0.62, ry * 0.62);
        ctx.fill();

        const glow = clamp(life / maxLife, 0, 1);
        if (glow > 0.35) {
          ctx.strokeStyle = `rgba(249, 115, 22, ${(glow - 0.35) * 0.7})`;
          ctx.lineWidth = Math.max(1, scale * 0.04);
          ctx.beginPath();
          for (let r = 0; r < 5; r++) {
            const ang = seed * Math.PI * 2 + r * 1.25;
            ctx.moveTo(pos.x, pos.y);
            ctx.lineTo(pos.x + Math.cos(ang) * rx * 0.7, pos.y + Math.sin(ang) * ry * 0.7);
          }
          ctx.stroke();
        }
      } else if (kind === 1) {
        // Acid corrosion pool
        const pulse = 0.94 + Math.sin(timeSec * 3.5 + seed * 10) * 0.06;
        ctx.fillStyle = 'rgba(22, 163, 74, 0.32)';
        ctx.beginPath();
        drawEllipse(ctx, pos.x, pos.y, rx * pulse, ry * pulse);
        ctx.fill();

        ctx.fillStyle = 'rgba(74, 222, 128, 0.42)';
        ctx.beginPath();
        drawEllipse(ctx, pos.x + rx * 0.14, pos.y - ry * 0.08, rx * 0.52, ry * 0.52);
        ctx.fill();

        ctx.strokeStyle = 'rgba(134, 239, 172, 0.45)';
        ctx.lineWidth = Math.max(1, scale * 0.03);
        ctx.beginPath();
        drawEllipse(ctx, pos.x, pos.y, rx * 0.85, ry * 0.85);
        ctx.stroke();
      } else if (kind === 2) {
        // Frost rime fracture
        ctx.fillStyle = 'rgba(56, 189, 248, 0.24)';
        ctx.beginPath();
        drawEllipse(ctx, pos.x, pos.y, rx, ry);
        ctx.fill();

        ctx.strokeStyle = 'rgba(186, 230, 253, 0.58)';
        ctx.lineWidth = Math.max(1, scale * 0.035);
        ctx.beginPath();
        for (let s = 0; s < 6; s++) {
          const ang = seed * Math.PI + (s * Math.PI) / 3;
          ctx.moveTo(pos.x, pos.y);
          ctx.lineTo(pos.x + Math.cos(ang) * rx * 0.95, pos.y + Math.sin(ang) * ry * 0.95);
        }
        ctx.stroke();
      } else if (kind === 3) {
        // Seismic crack
        ctx.strokeStyle = 'rgba(4, 7, 13, 0.82)';
        ctx.lineWidth = Math.max(1.2, scale * 0.055);
        ctx.beginPath();
        for (let k = 0; k < 5; k++) {
          const a = seed * 6.28 + k * 1.24;
          const midX = pos.x + Math.cos(a + 0.18) * rx * 0.48;
          const midY = pos.y + Math.sin(a + 0.18) * ry * 0.48;
          ctx.moveTo(pos.x, pos.y);
          ctx.lineTo(midX, midY);
          ctx.lineTo(pos.x + Math.cos(a - 0.12) * rx, pos.y + Math.sin(a - 0.12) * ry);
        }
        ctx.stroke();
      } else if (kind === 4) {
        // Burning napalm slag
        const simmer = 0.85 + Math.sin(timeSec * 6.5 + seed * 12) * 0.15;
        ctx.fillStyle = 'rgba(15, 12, 10, 0.62)';
        ctx.beginPath();
        drawEllipse(ctx, pos.x, pos.y, rx, ry);
        ctx.fill();

        ctx.fillStyle = `rgba(249, 115, 22, ${0.48 * simmer})`;
        ctx.beginPath();
        drawEllipse(ctx, pos.x, pos.y, rx * 0.72, ry * 0.72);
        ctx.fill();

        ctx.fillStyle = `rgba(253, 224, 71, ${0.52 * simmer})`;
        ctx.beginPath();
        drawEllipse(ctx, pos.x - rx * 0.1, pos.y, rx * 0.34, ry * 0.34);
        ctx.fill();
      } else {
        // Consecration rune ring
        ctx.strokeStyle = 'rgba(212, 162, 56, 0.5)';
        ctx.lineWidth = Math.max(1.1, scale * 0.045);
        ctx.beginPath();
        drawEllipse(ctx, pos.x, pos.y, rx, ry);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(125, 211, 252, 0.45)';
        ctx.beginPath();
        drawEllipse(ctx, pos.x, pos.y, rx * 0.65, ry * 0.65);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  _renderSpawnRift(ctx, camera, gate, scale, timeSec) {
    const pos = camera.worldToScreen(gate.cx, gate.cy, 0, this._ptA);
    const rx = scale * 0.92;
    const ry = rx * CAMERA_PITCH_Y;
    const spin = timeSec * (gate.id === 0 ? 1.4 : -1.4);

    ctx.save();

    // Stone portal dais
    ctx.fillStyle = '#181326';
    ctx.beginPath();
    drawEllipse(ctx, pos.x, pos.y, rx * 1.08, ry * 1.08);
    ctx.fill();
    ctx.strokeStyle = '#6d28d9';
    ctx.lineWidth = Math.max(1.5, scale * 0.06);
    ctx.stroke();

    // Swirling dimensional void
    ctx.fillStyle = 'rgba(168, 85, 247, 0.28)';
    ctx.beginPath();
    drawEllipse(ctx, pos.x, pos.y, rx * 0.84, ry * 0.84);
    ctx.fill();

    ctx.fillStyle = 'rgba(244, 63, 94, 0.32)';
    ctx.beginPath();
    drawEllipse(ctx, pos.x, pos.y, rx * 0.56, ry * 0.56);
    ctx.fill();

    ctx.fillStyle = '#06030d';
    ctx.beginPath();
    drawEllipse(ctx, pos.x, pos.y, rx * 0.34, ry * 0.34);
    ctx.fill();

    // Rotating rift sigil spokes
    ctx.strokeStyle = 'rgba(232, 121, 249, 0.72)';
    ctx.lineWidth = Math.max(1.2, scale * 0.05);
    for (let k = 0; k < 4; k++) {
      const a0 = spin + (k * Math.PI) / 2;
      ctx.beginPath();
      drawEllipse(ctx, pos.x, pos.y, rx * 0.74, ry * 0.74, 0, a0, a0 + 0.75);
      ctx.stroke();
    }

    // Elevated floating rift core
    const hover = camera.worldToScreen(gate.cx, gate.cy, 0.42 + Math.sin(timeSec * 3.2 + gate.id) * 0.08, this._ptB);
    ctx.fillStyle = 'rgba(244, 63, 94, 0.45)';
    ctx.beginPath();
    ctx.arc(hover.x, hover.y, scale * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fda4af';
    ctx.beginPath();
    ctx.arc(hover.x, hover.y, scale * 0.11, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _renderLeyShrine(ctx, camera, wp, scale, timeSec) {
    const pos = camera.worldToScreen(wp.cx, wp.cy, 0, this._ptA);
    const rx = scale * 0.94;
    const ry = rx * CAMERA_PITCH_Y;

    ctx.save();

    // Stepped slate & brass dais
    ctx.fillStyle = '#1b2434';
    ctx.beginPath();
    drawEllipse(ctx, pos.x, pos.y, rx, ry);
    ctx.fill();
    ctx.strokeStyle = '#d4a238';
    ctx.lineWidth = Math.max(1.5, scale * 0.065);
    ctx.stroke();

    ctx.fillStyle = '#101827';
    ctx.beginPath();
    drawEllipse(ctx, pos.x, pos.y, rx * 0.68, ry * 0.68);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = Math.max(1.2, scale * 0.045);
    ctx.stroke();

    // Rotating golden compass arcs
    const rot = timeSec * 0.9;
    ctx.strokeStyle = 'rgba(212, 162, 56, 0.75)';
    ctx.lineWidth = Math.max(1.2, scale * 0.045);
    for (let i = 0; i < 4; i++) {
      const a = rot + (i * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(pos.x + Math.cos(a) * rx * 0.45, pos.y + Math.sin(a) * ry * 0.45);
      ctx.lineTo(pos.x + Math.cos(a) * rx * 0.88, pos.y + Math.sin(a) * ry * 0.88);
      ctx.stroke();
    }

    // Hovering Shrine Beacon Prism
    const z = 0.58 + Math.sin(timeSec * 2.6) * 0.08;
    const tip = camera.worldToScreen(wp.cx, wp.cy, z, this._ptB);
    const r = scale * 0.24;

    ctx.fillStyle = 'rgba(56, 189, 248, 0.26)';
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, r * 1.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y - r * 1.25);
    ctx.lineTo(tip.x + r * 0.75, tip.y);
    ctx.lineTo(tip.x, tip.y + r * 0.95);
    ctx.lineTo(tip.x - r * 0.75, tip.y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y - r * 1.25);
    ctx.lineTo(tip.x + r * 0.25, tip.y);
    ctx.lineTo(tip.x, tip.y + r * 0.95);
    ctx.lineTo(tip.x - r * 0.25, tip.y);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  _renderNexusCore(ctx, camera, sim, scale, timeSec) {
    const pos = camera.worldToScreen(NEXUS_CORE.cx, NEXUS_CORE.cy, 0, this._ptA);
    const rx = scale * 1.05;
    const ry = rx * CAMERA_PITCH_Y;
    const lowLives = sim && Number.isFinite(sim.lives) && sim.lives <= 10;
    const pulse = 0.5 + 0.5 * Math.sin(timeSec * (lowLives ? 6.2 : 2.8));

    ctx.save();

    // Altar plinth layers
    ctx.fillStyle = '#171c28';
    ctx.beginPath();
    drawEllipse(ctx, pos.x, pos.y, rx, ry);
    ctx.fill();
    ctx.strokeStyle = '#d4a238';
    ctx.lineWidth = Math.max(1.8, scale * 0.08);
    ctx.stroke();

    ctx.fillStyle = '#0b111d';
    ctx.beginPath();
    drawEllipse(ctx, pos.x, pos.y, rx * 0.72, ry * 0.72);
    ctx.fill();

    // Layered ground aura (translucent layered fills)
    ctx.fillStyle = lowLives
      ? `rgba(244, 63, 94, ${0.18 + pulse * 0.16})`
      : `rgba(56, 189, 248, ${0.16 + pulse * 0.14})`;
    ctx.beginPath();
    drawEllipse(ctx, pos.x, pos.y, rx * 0.85, ry * 0.85);
    ctx.fill();

    // Orbiting golden seal ring
    ctx.strokeStyle = 'rgba(212, 162, 56, 0.78)';
    ctx.lineWidth = Math.max(1.4, scale * 0.055);
    for (let i = 0; i < 3; i++) {
      const a = timeSec * 1.3 + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      drawEllipse(ctx, pos.x, pos.y, rx * 0.82, ry * 0.82, 0, a, a + 1.05);
      ctx.stroke();
    }

    // Hovering 2.5D faceted Arcane Nexus Crystal
    const bobZ = 0.92 + Math.sin(timeSec * 2.4) * 0.1;
    const center = camera.worldToScreen(NEXUS_CORE.cx, NEXUS_CORE.cy, bobZ, this._ptB);
    const w = scale * 0.44;
    const h = scale * 0.86;

    // Soft outer crystal halo
    ctx.fillStyle = lowLives
      ? `rgba(251, 113, 133, ${0.22 + pulse * 0.14})`
      : `rgba(56, 189, 248, ${0.22 + pulse * 0.15})`;
    ctx.beginPath();
    ctx.arc(center.x, center.y, scale * 0.68, 0, Math.PI * 2);
    ctx.fill();

    // Left dark cyan facet
    ctx.fillStyle = lowLives ? '#e11d48' : '#0284c7';
    ctx.beginPath();
    ctx.moveTo(center.x, center.y - h * 0.65);
    ctx.lineTo(center.x - w, center.y - h * 0.05);
    ctx.lineTo(center.x, center.y + h * 0.55);
    ctx.closePath();
    ctx.fill();

    // Right bright cyan facet
    ctx.fillStyle = lowLives ? '#fb7185' : '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(center.x, center.y - h * 0.65);
    ctx.lineTo(center.x + w, center.y - h * 0.05);
    ctx.lineTo(center.x, center.y + h * 0.55);
    ctx.closePath();
    ctx.fill();

    // Center specular core facet
    ctx.fillStyle = lowLives ? '#ffe4e6' : '#e0f2fe';
    ctx.beginPath();
    ctx.moveTo(center.x, center.y - h * 0.65);
    ctx.lineTo(center.x + w * 0.36, center.y - h * 0.05);
    ctx.lineTo(center.x, center.y + h * 0.55);
    ctx.lineTo(center.x - w * 0.25, center.y - h * 0.05);
    ctx.closePath();
    ctx.fill();

    // Rim highlight
    ctx.strokeStyle = '#d4a238';
    ctx.lineWidth = Math.max(1.2, scale * 0.045);
    ctx.beginPath();
    ctx.moveTo(center.x, center.y - h * 0.65);
    ctx.lineTo(center.x + w, center.y - h * 0.05);
    ctx.lineTo(center.x, center.y + h * 0.55);
    ctx.lineTo(center.x - w, center.y - h * 0.05);
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
  }

  _renderGhostPreview(ctx, camera, ghost, scale, timeSec) {
    const col = ghost.col;
    const row = ghost.row;
    const cx = col + 1;
    const cy = row + 1;
    const valid = ghost.valid !== false;

    const tl = camera.worldToScreen(col, row, 0, this._ptA);
    const w = 2 * scale;
    const h = 2 * scale * CAMERA_PITCH_Y;
    const center = camera.worldToScreen(cx, cy, 0, this._ptB);

    ctx.save();

    // Animated golden reroute ley-ribbon when valid previewPath exists
    if (valid && Array.isArray(ghost.previewPath) && ghost.previewPath.length >= 2) {
      ctx.beginPath();
      for (let i = 0; i < ghost.previewPath.length; i++) {
        const node = ghost.previewPath[i];
        const p = camera.worldToScreen(node.x, node.y, 0.05, this._ptA);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(212, 162, 56, 0.28)';
      ctx.lineWidth = Math.max(3, scale * 0.28);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      setDash(ctx, [scale * 0.5, scale * 0.4]);
      if ('lineDashOffset' in ctx) {
        ctx.lineDashOffset = -timeSec * scale * 2.5;
      }
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';
      ctx.lineWidth = Math.max(1.5, scale * 0.1);
      ctx.stroke();
      setDash(ctx, []);
    }

    // Recompute tl after _ptA reuse
    const padTL = camera.worldToScreen(col, row, 0, this._ptA);
    const tint = LINEAGE_GHOST_COLORS[ghost.lineageId] || '#d4a238';

    // Footprint quad
    ctx.fillStyle = valid ? 'rgba(56, 189, 248, 0.20)' : 'rgba(239, 68, 68, 0.26)';
    ctx.fillRect(padTL.x, padTL.y, w, h);

    ctx.strokeStyle = valid ? '#38bdf8' : '#ef4444';
    ctx.lineWidth = Math.max(1.5, scale * 0.07);
    ctx.strokeRect(padTL.x, padTL.y, w, h);

    if (!valid) {
      // Crimson warning crosshatch
      ctx.strokeStyle = 'rgba(248, 113, 113, 0.65)';
      ctx.lineWidth = Math.max(1.2, scale * 0.045);
      ctx.beginPath();
      ctx.moveTo(padTL.x + w * 0.1, padTL.y + h * 0.1);
      ctx.lineTo(padTL.x + w * 0.9, padTL.y + h * 0.9);
      ctx.moveTo(padTL.x + w * 0.9, padTL.y + h * 0.1);
      ctx.lineTo(padTL.x + w * 0.1, padTL.y + h * 0.9);
      ctx.stroke();
    }

    // Range ring
    if (Number.isFinite(ghost.range) && ghost.range > 0) {
      const rx = ghost.range * scale;
      const ry = rx * CAMERA_PITCH_Y;
      ctx.fillStyle = valid ? 'rgba(56, 189, 248, 0.06)' : 'rgba(239, 68, 68, 0.06)';
      ctx.beginPath();
      drawEllipse(ctx, center.x, center.y, rx, ry);
      ctx.fill();

      setDash(ctx, [scale * 0.28, scale * 0.22]);
      ctx.strokeStyle = valid ? 'rgba(125, 211, 252, 0.68)' : 'rgba(248, 113, 113, 0.65)';
      ctx.lineWidth = Math.max(1.2, scale * 0.045);
      ctx.stroke();
      setDash(ctx, []);
    }

    // Translucent 2.5D turret silhouette ghost
    const turretTop = camera.worldToScreen(cx, cy, 0.72, this._ptB);
    const groundCenter = camera.worldToScreen(cx, cy, 0, this._ptA);
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = valid ? tint : '#ef4444';
    ctx.beginPath();
    drawEllipse(ctx, groundCenter.x, groundCenter.y, scale * 0.66, scale * 0.66 * CAMERA_PITCH_Y);
    ctx.fill();

    ctx.fillStyle = valid ? 'rgba(226, 232, 240, 0.32)' : 'rgba(254, 202, 202, 0.35)';
    ctx.beginPath();
    ctx.moveTo(groundCenter.x - scale * 0.42, groundCenter.y);
    ctx.lineTo(turretTop.x - scale * 0.24, turretTop.y);
    ctx.lineTo(turretTop.x + scale * 0.24, turretTop.y);
    ctx.lineTo(groundCenter.x + scale * 0.42, groundCenter.y);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(turretTop.x, turretTop.y, scale * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = valid ? tint : '#f87171';
    ctx.fill();
    ctx.globalAlpha = 1;

    // Floating Travel Time / Invalid Block Callout Badge
    let badgeText = '';
    if (valid) {
      const delta = Number(ghost.deltaSec) || 0;
      const sign = delta >= 0 ? '+' : '';
      badgeText = `${sign}${delta.toFixed(1)}s Travel Time`;
    } else {
      const r = ghost.reason || '';
      if (!r || /block|trap|path/i.test(r)) {
        badgeText = 'Cannot Block Creep Path!';
      } else {
        badgeText = r;
      }
    }

    const fontPx = clamp(Math.round(scale * 0.34), 11, 15);
    ctx.font = `700 ${fontPx}px system-ui, -apple-system, sans-serif`;
    const measured =
      typeof ctx.measureText === 'function'
        ? ctx.measureText(badgeText).width
        : badgeText.length * fontPx * 0.58;
    const badgeW = measured + fontPx * 1.4;
    const badgeH = fontPx * 1.75;
    const bx = groundCenter.x - badgeW * 0.5;
    const by = padTL.y - badgeH - scale * 0.28;

    ctx.fillStyle = valid ? 'rgba(11, 13, 18, 0.90)' : 'rgba(69, 10, 10, 0.92)';
    ctx.beginPath();
    drawRoundedRectPath(ctx, bx, by, badgeW, badgeH, 6);
    ctx.fill();

    ctx.strokeStyle = valid ? '#d4a238' : '#ef4444';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = valid ? '#fde68a' : '#fecaca';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, groundCenter.x, by + badgeH * 0.52);

    ctx.restore();
  }
}
