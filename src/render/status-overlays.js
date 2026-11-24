import { CAMERA_PITCH_Y } from '../contracts/types.js';

const TAU = Math.PI * 2;
const DASH_NONE = Object.freeze([]);
const DASH_RING = Object.freeze([5, 4]);

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

function drawPolygon(ctx, cx, cy, radius, sides, angleOffset = 0, pitchY = 1) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = angleOffset + (i * TAU) / sides;
    const px = cx + Math.cos(a) * radius;
    const py = cy + Math.sin(a) * radius * pitchY;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Renders gameplay status overlays (Chill/Deep Freeze, Acid Sundering,
 * Electric Stun/Static, Ignite/Napalm, Knock-Up/Gravity) with zero
 * GPU blur passes and zero per-frame object/array allocations.
 */
export class StatusOverlayRenderer {
  constructor() {
    this._jitterOut = { x: 0, y: 0 };
  }

  /**
   * Computes deterministic high-frequency micro-jitter offset for shocked creeps.
   * @param {object} creep
   * @param {number} timeSec
   * @param {{x:number, y:number}} [out]
   * @returns {{x:number, y:number}}
   */
  getShockJitter(creep, timeSec = 0, out = this._jitterOut) {
    if (!creep || !((creep.shockTimer || 0) > 0)) {
      out.x = 0;
      out.y = 0;
      return out;
    }
    const seed = (creep.id || creep.slot || 1) * 1.731;
    out.x = Math.sin(timeSec * 73 + seed) * 2.1 + Math.cos(timeSec * 119 + seed) * 0.9;
    out.y = Math.cos(timeSec * 83 + seed * 1.3) * 1.5;
    return out;
  }

  /**
   * Draws all active status overlays on a creep at its projected screen coordinates.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} screenX
   * @param {number} screenY
   * @param {number} groundY
   * @param {number} scale
   * @param {object} creep
   * @param {number} [timeSec=0]
   */
  renderCreepStatuses(ctx, screenX, screenY, groundY, scale, creep, timeSec = 0) {
    if (!ctx || !creep) return;

    const s = Math.max(8, Number.isFinite(scale) ? scale : 36);
    const radiusScale = Math.max(0.7, Math.min(2.4, creep.isBoss ? 1.65 : (creep.radius ? creep.radius * 2.4 : (creep.isSplitChild ? 0.72 : 1.0))));
    const r = s * 0.36 * radiusScale;
    const prevAlpha = ctx.globalAlpha;
    ctx.save();

    // 1. Knock-Up / Gravity shock-ring around groundY proportional to z height
    const zHeight = Number.isFinite(creep.z) ? creep.z : 0;
    const isKnockedAirborne = zHeight > 0.05 && (!creep.isFlying || (creep.earthboundTimer || 0) > 0 || Math.abs(creep.vz || 0) > 0.05);
    if (isKnockedAirborne) {
      this._renderKnockupOverlay(ctx, screenX, screenY, groundY, s, r, zHeight, timeSec);
    }

    // 2. Chill rime & Deep Freeze crystalline prism
    const chillTimer = creep.chillTimer || 0;
    const chillPct = creep.chillPct || 0;
    const frozenTimer = creep.frozenTimer || 0;
    if (chillTimer > 0 || chillPct > 0 || frozenTimer > 0) {
      this._renderFrostOverlay(ctx, screenX, screenY, groundY, s, r, chillPct, chillTimer, frozenTimer, timeSec);
    }

    // 3. Ignite / Napalm flickering multi-tongue flames around torso
    if ((creep.igniteTimer || 0) > 0) {
      this._renderIgniteOverlay(ctx, screenX, screenY, r, creep, timeSec);
    }

    // 4. Electric Stun / Static flickering cyan-white mini-arcs
    if ((creep.shockTimer || 0) > 0) {
      this._renderShockOverlay(ctx, screenX, screenY, r, creep, timeSec);
    }

    // 5. Acid Corrosion / Sundering dripping droplets + cracked-shield stack badge
    const acidStacks = creep.acidStacks || 0;
    if (acidStacks > 0 || (creep.acidTimer || 0) > 0) {
      this._renderAcidOverlay(ctx, screenX, screenY, groundY, s, r, Math.max(1, Math.round(acidStacks)), creep, timeSec);
    }

    ctx.restore();
    ctx.globalAlpha = prevAlpha;
  }

  _renderKnockupOverlay(ctx, sx, sy, groundY, scale, r, zHeight, timeSec) {
    const heightFactor = Math.min(2.0, zHeight);
    const ringRadius = r * (1.05 + heightFactor * 0.75);
    const pulse = 0.5 + 0.5 * Math.sin(timeSec * 14);

    // Kinetic ground shadow & gravity pulse ring
    ctx.fillStyle = 'rgba(15, 23, 42, 0.45)';
    drawEllipsePath(ctx, sx, groundY, r * 0.72, r * 0.72 * CAMERA_PITCH_Y);
    ctx.fill();

    ctx.lineWidth = 2.0;
    ctx.strokeStyle = 'rgba(168, 85, 247, 0.72)';
    drawEllipsePath(ctx, sx, groundY, ringRadius, ringRadius * CAMERA_PITCH_Y);
    ctx.stroke();

    ctx.lineWidth = 1.25;
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.85)';
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash(DASH_RING);
    drawEllipsePath(ctx, sx, groundY, ringRadius * (0.68 + pulse * 0.14), ringRadius * (0.68 + pulse * 0.14) * CAMERA_PITCH_Y);
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash(DASH_NONE);

    // Upward gravity lift streaks linking groundY toward elevated sy
    const liftSpan = groundY - sy;
    if (liftSpan > 4) {
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(196, 181, 253, 0.6)';
      for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI) * 0.5 + 0.4;
        const ox = Math.cos(angle) * r * 0.75;
        const oy = Math.sin(angle) * r * 0.3;
        const phase = (timeSec * 3.5 + i * 0.25) % 1;
        const y0 = groundY + oy - phase * liftSpan * 0.65;
        const y1 = Math.max(sy, y0 - Math.min(scale * 0.35, liftSpan * 0.35));
        ctx.beginPath();
        ctx.moveTo(sx + ox, y0);
        ctx.lineTo(sx + ox, y1);
        ctx.stroke();
      }
    }
  }

  _renderFrostOverlay(ctx, sx, sy, groundY, scale, r, chillPct, chillTimer, frozenTimer, timeSec) {
    const chillIntensity = Math.min(1, Math.max(chillPct, chillTimer > 0 ? 0.35 : 0, frozenTimer > 0 ? 0.85 : 0));

    // Progressive cyan rime coating on ground + lower body
    ctx.fillStyle = `rgba(56, 189, 248, ${(0.18 + 0.18 * chillIntensity).toFixed(3)})`;
    drawEllipsePath(ctx, sx, groundY, r * 1.15, r * 1.15 * CAMERA_PITCH_Y);
    ctx.fill();

    // Rime frost spikes around feet
    const spikeCount = frozenTimer > 0 ? 6 : 4;
    ctx.fillStyle = `rgba(186, 230, 253, ${(0.45 + 0.35 * chillIntensity).toFixed(3)})`;
    for (let i = 0; i < spikeCount; i++) {
      const a = (i * TAU) / spikeCount + 0.35;
      const bx = sx + Math.cos(a) * r * 0.88;
      const by = groundY + Math.sin(a) * r * 0.48;
      const sh = r * (0.35 + 0.25 * chillIntensity);
      ctx.beginPath();
      ctx.moveTo(bx - r * 0.14, by);
      ctx.lineTo(bx + Math.cos(a) * r * 0.16, by - sh);
      ctx.lineTo(bx + r * 0.14, by);
      ctx.closePath();
      ctx.fill();
    }

    // Orbiting frost motes for chilled state
    if (frozenTimer <= 0) {
      ctx.fillStyle = 'rgba(224, 242, 254, 0.85)';
      for (let i = 0; i < 3; i++) {
        const a = timeSec * 2.4 + (i * TAU) / 3;
        const mx = sx + Math.cos(a) * r * 0.95;
        const my = sy - r * 0.25 + Math.sin(a * 1.5) * r * 0.35;
        drawPolygon(ctx, mx, my, Math.max(1.8, scale * 0.055), 4, a, 1);
        ctx.fill();
      }
      return;
    }

    // Deep Freeze: faceted translucent 2.5D crystalline ice prism encasing creep
    const topY = sy - r * 1.48;
    const midTopY = sy - r * 0.82;
    const midBotY = sy + r * 0.32;
    const botY = groundY + r * 0.12;
    const wOuter = r * 1.12;
    const wInner = r * 0.46;

    // Outer translucent crystal body
    ctx.fillStyle = 'rgba(14, 165, 233, 0.34)';
    ctx.beginPath();
    ctx.moveTo(sx, topY);
    ctx.lineTo(sx + wOuter, midTopY);
    ctx.lineTo(sx + wOuter * 0.86, midBotY);
    ctx.lineTo(sx, botY);
    ctx.lineTo(sx - wOuter * 0.86, midBotY);
    ctx.lineTo(sx - wOuter, midTopY);
    ctx.closePath();
    ctx.fill();

    // Left illuminated specular facet
    ctx.fillStyle = 'rgba(224, 242, 254, 0.44)';
    ctx.beginPath();
    ctx.moveTo(sx, topY);
    ctx.lineTo(sx - wInner, midTopY * 0.65 + midBotY * 0.35);
    ctx.lineTo(sx - wOuter * 0.86, midBotY);
    ctx.lineTo(sx - wOuter, midTopY);
    ctx.closePath();
    ctx.fill();

    // Center crystal facet
    ctx.fillStyle = 'rgba(125, 211, 252, 0.32)';
    ctx.beginPath();
    ctx.moveTo(sx, topY);
    ctx.lineTo(sx + wInner, midTopY + r * 0.22);
    ctx.lineTo(sx, botY);
    ctx.lineTo(sx - wInner, midTopY + r * 0.22);
    ctx.closePath();
    ctx.fill();

    // Dark cool shadow facet on lower right
    ctx.fillStyle = 'rgba(2, 132, 199, 0.38)';
    ctx.beginPath();
    ctx.moveTo(sx + wInner, midTopY + r * 0.22);
    ctx.lineTo(sx + wOuter, midTopY);
    ctx.lineTo(sx + wOuter * 0.86, midBotY);
    ctx.lineTo(sx, botY);
    ctx.closePath();
    ctx.fill();

    // Sharp specular edge ridges
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(240, 249, 255, 0.92)';
    ctx.beginPath();
    ctx.moveTo(sx, topY);
    ctx.lineTo(sx + wOuter, midTopY);
    ctx.lineTo(sx + wOuter * 0.86, midBotY);
    ctx.lineTo(sx, botY);
    ctx.lineTo(sx - wOuter * 0.86, midBotY);
    ctx.lineTo(sx - wOuter, midTopY);
    ctx.closePath();
    ctx.stroke();

    // Internal prism ridge lines
    ctx.lineWidth = 1.15;
    ctx.strokeStyle = 'rgba(224, 242, 254, 0.8)';
    ctx.beginPath();
    ctx.moveTo(sx, topY);
    ctx.lineTo(sx - wInner, midTopY + r * 0.22);
    ctx.lineTo(sx, botY);
    ctx.moveTo(sx, topY);
    ctx.lineTo(sx + wInner, midTopY + r * 0.22);
    ctx.lineTo(sx, botY);
    ctx.moveTo(sx - wOuter, midTopY);
    ctx.lineTo(sx - wInner, midTopY + r * 0.22);
    ctx.lineTo(sx + wInner, midTopY + r * 0.22);
    ctx.lineTo(sx + wOuter, midTopY);
    ctx.stroke();

    // Apex sparkle glint
    const glint = 0.55 + 0.45 * Math.sin(timeSec * 6.5);
    ctx.fillStyle = `rgba(255, 255, 255, ${glint.toFixed(3)})`;
    drawPolygon(ctx, sx - wInner * 0.55, midTopY, Math.max(2, r * 0.16), 4, timeSec * 1.2, 1);
    ctx.fill();
  }

  _renderIgniteOverlay(ctx, sx, sy, r, creep, timeSec) {
    const seed = (creep.id || creep.slot || 1) * 1.37;
    const baseY = sy + r * 0.12;
    const tongueCount = 5;

    for (let i = 0; i < tongueCount; i++) {
      const frac = (i / (tongueCount - 1)) - 0.5;
      const fx = sx + frac * r * 1.25;
      const wave = Math.sin(timeSec * 13 + seed + i * 2.1);
      const wave2 = Math.cos(timeSec * 19 + seed + i * 1.4);
      const flameH = r * (0.78 + 0.34 * Math.abs(wave) + (1 - Math.abs(frac) * 1.4) * 0.35);
      const tipX = fx + wave * r * 0.24;
      const tipY = baseY - flameH;
      const halfW = r * (0.26 + 0.06 * wave2);

      // Outer crimson-orange tongue
      ctx.fillStyle = i % 2 === 0 ? 'rgba(234, 88, 12, 0.78)' : 'rgba(249, 115, 22, 0.82)';
      ctx.beginPath();
      ctx.moveTo(fx - halfW, baseY);
      ctx.quadraticCurveTo(fx - halfW * 0.8, baseY - flameH * 0.55, tipX, tipY);
      ctx.quadraticCurveTo(fx + halfW * 0.8, baseY - flameH * 0.45, fx + halfW, baseY);
      ctx.closePath();
      ctx.fill();

      // Inner bright gold flame core
      ctx.fillStyle = 'rgba(253, 224, 71, 0.88)';
      ctx.beginPath();
      ctx.moveTo(fx - halfW * 0.5, baseY);
      ctx.quadraticCurveTo(fx - halfW * 0.3, baseY - flameH * 0.35, tipX * 0.7 + fx * 0.3, baseY - flameH * 0.62);
      ctx.quadraticCurveTo(fx + halfW * 0.3, baseY - flameH * 0.3, fx + halfW * 0.5, baseY);
      ctx.closePath();
      ctx.fill();
    }

    // Rising burning embers
    ctx.fillStyle = 'rgba(254, 240, 138, 0.9)';
    for (let i = 0; i < 3; i++) {
      const p = (timeSec * 2.2 + i * 0.33 + seed * 0.1) % 1;
      const ex = sx + Math.sin(timeSec * 7 + i * 2.3) * r * 0.65;
      const ey = baseY - r * 0.5 - p * r * 1.25;
      ctx.beginPath();
      ctx.arc(ex, ey, Math.max(1.2, r * 0.09 * (1 - p * 0.6)), 0, TAU);
      ctx.fill();
    }
  }

  _renderShockOverlay(ctx, sx, sy, r, creep, timeSec) {
    const tick = Math.floor(timeSec * 24);
    const seed = (creep.id || creep.slot || 1) * 3.17;
    const arcCount = 3;

    for (let a = 0; a < arcCount; a++) {
      const baseAngle = ((tick * 1.9 + a * 2.1 + seed) % TAU);
      const endAngle = baseAngle + 1.35;
      const rad = r * (0.85 + 0.25 * Math.sin(tick * 2.7 + a));

      const x0 = sx + Math.cos(baseAngle) * rad;
      const y0 = sy - r * 0.25 + Math.sin(baseAngle) * rad * 0.7;
      const x3 = sx + Math.cos(endAngle) * rad;
      const y3 = sy - r * 0.25 + Math.sin(endAngle) * rad * 0.7;

      const j1x = Math.sin(tick * 11.3 + a * 4.1 + seed) * r * 0.34;
      const j1y = Math.cos(tick * 13.7 + a * 2.9 + seed) * r * 0.34;
      const j2x = Math.cos(tick * 17.1 + a * 5.3 + seed) * r * 0.34;
      const j2y = Math.sin(tick * 7.9 + a * 3.7 + seed) * r * 0.34;

      const x1 = x0 + (x3 - x0) * 0.33 + j1x;
      const y1 = y0 + (y3 - y0) * 0.33 + j1y;
      const x2 = x0 + (x3 - x0) * 0.66 + j2x;
      const y2 = y0 + (y3 - y0) * 0.66 + j2y;

      // Cyan halo stroke
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.55)';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.stroke();

      // White electric core stroke
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = 'rgba(236, 254, 255, 0.96)';
      ctx.stroke();

      // Contact flash nodes
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x0, y0, Math.max(1.4, r * 0.1), 0, TAU);
      ctx.arc(x3, y3, Math.max(1.4, r * 0.1), 0, TAU);
      ctx.fill();
    }
  }

  _renderAcidOverlay(ctx, sx, screenY, groundY, scale, r, stacks, creep, timeSec) {
    const seed = (creep.id || creep.slot || 1) * 0.91;
    const dropCount = Math.min(6, 2 + Math.ceil(stacks * 0.5));

    // Faint corrosive puddle beneath creep
    ctx.fillStyle = 'rgba(74, 222, 128, 0.24)';
    drawEllipsePath(ctx, sx, groundY, r * 0.85, r * 0.85 * CAMERA_PITCH_Y);
    ctx.fill();

    // Dripping emerald acid droplets
    for (let i = 0; i < dropCount; i++) {
      const frac = ((timeSec * 1.55 + i * (1 / dropCount) + seed) % 1);
      const dx = sx + Math.sin(i * 2.4 + seed) * r * 0.72;
      const startY = screenY - r * 0.35;
      const dy = startY + frac * Math.max(r * 0.8, groundY - startY);
      const dropR = Math.max(1.5, scale * 0.055 * (1 - frac * 0.25));

      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.moveTo(dx, dy - dropR * 1.7);
      ctx.quadraticCurveTo(dx + dropR, dy, dx, dy + dropR);
      ctx.quadraticCurveTo(dx - dropR, dy, dx, dy - dropR * 1.7);
      ctx.fill();

      ctx.fillStyle = '#bbf7d0';
      ctx.beginPath();
      ctx.arc(dx - dropR * 0.25, dy, dropR * 0.35, 0, TAU);
      ctx.fill();
    }

    // Overhead cracked-shield icon + numeric stack indicator
    const badgeY = screenY - r * 1.75 - Math.max(8, scale * 0.24);
    const badgeX = sx;
    const sw = Math.max(6, scale * 0.18);
    const sh = sw * 1.15;

    // Cracked shield polygon
    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(badgeX - sw * 0.55 - sw * 0.5, badgeY - sh * 0.5);
    ctx.lineTo(badgeX - sw * 0.55 + sw * 0.5, badgeY - sh * 0.5);
    ctx.lineTo(badgeX - sw * 0.55 + sw * 0.45, badgeY + sh * 0.05);
    ctx.lineTo(badgeX - sw * 0.55, badgeY + sh * 0.55);
    ctx.lineTo(badgeX - sw * 0.55 - sw * 0.45, badgeY + sh * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Jagged emerald crack down shield face
    ctx.strokeStyle = '#bef264';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(badgeX - sw * 0.55 + sw * 0.08, badgeY - sh * 0.45);
    ctx.lineTo(badgeX - sw * 0.55 - sw * 0.14, badgeY - sh * 0.05);
    ctx.lineTo(badgeX - sw * 0.55 + sw * 0.12, badgeY + sh * 0.12);
    ctx.lineTo(badgeX - sw * 0.55 - sw * 0.04, badgeY + sh * 0.48);
    ctx.stroke();

    // Numeric stack indicator
    const fontPx = Math.max(10, Math.round(scale * 0.28));
    ctx.font = `700 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const label = `${stacks}`;
    const textX = badgeX + sw * 0.12;
    if (typeof ctx.strokeText === 'function') {
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = '#090d16';
      ctx.strokeText(label, textX, badgeY);
    }
    ctx.fillStyle = '#86efac';
    if (typeof ctx.fillText === 'function') {
      ctx.fillText(label, textX, badgeY);
    }
  }
}
