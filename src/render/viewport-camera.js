import {
  GRID_COLS,
  GRID_ROWS,
  CAMERA_PITCH_Y,
  CAMERA_ELEV_SCALE,
} from '../contracts/types.js';

const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2.6;
const DEFAULT_CSS_WIDTH = 1280;
const DEFAULT_CSS_HEIGHT = 720;

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/**
 * Orthographic 2.5D pitched sanctuary camera with DPR locking, cursor-anchored
 * zooming, bounded panning, and 1x1-aligned 2x2 tower placement snapping.
 */
export class ViewportCamera {
  constructor() {
    this.cssWidth = DEFAULT_CSS_WIDTH;
    this.cssHeight = DEFAULT_CSS_HEIGHT;
    this.dpr = 1;
    this.pixelWidth = DEFAULT_CSS_WIDTH;
    this.pixelHeight = DEFAULT_CSS_HEIGHT;

    this.minZoom = MIN_ZOOM;
    this.maxZoom = MAX_ZOOM;
    this.zoom = 1.0;

    this.centerX = GRID_COLS * 0.5;
    this.centerY = GRID_ROWS * 0.5;
    this.baseScale = 32;

    this._recomputeBaseScale();
  }

  _recomputeBaseScale() {
    const padCols = 1.6;
    const padRows = 1.8;
    const scaleX = this.cssWidth / (GRID_COLS + padCols);
    const scaleY = this.cssHeight / (GRID_ROWS * CAMERA_PITCH_Y + padRows);
    const computed = Math.min(scaleX, scaleY);
    this.baseScale = Number.isFinite(computed) && computed > 1 ? computed : 24;
  }

  _clampCenter() {
    this.centerX = clamp(this.centerX, 0, GRID_COLS);
    this.centerY = clamp(this.centerY, 0, GRID_ROWS);
  }

  resize(cssWidth, cssHeight, dpr = 1) {
    const validW = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : DEFAULT_CSS_WIDTH;
    const validH = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : DEFAULT_CSS_HEIGHT;
    const clampedDpr = clamp(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, 1, 2);

    this.cssWidth = validW;
    this.cssHeight = validH;
    this.dpr = clampedDpr;
    this.pixelWidth = Math.max(1, Math.round(validW * clampedDpr));
    this.pixelHeight = Math.max(1, Math.round(validH * clampedDpr));
    this._recomputeBaseScale();
    this._clampCenter();
  }

  getScale() {
    return this.baseScale * this.zoom;
  }

  worldToScreen(wx, wy, wz = 0, out = null) {
    const scale = this.getScale();
    const sx = this.cssWidth * 0.5 + (wx - this.centerX) * scale;
    const sy =
      this.cssHeight * 0.5 +
      (wy - this.centerY) * scale * CAMERA_PITCH_Y -
      wz * scale * CAMERA_ELEV_SCALE;

    if (out) {
      out.x = sx;
      out.y = sy;
      return out;
    }
    return { x: sx, y: sy };
  }

  screenToWorld(sx, sy, out = null) {
    let screenX = sx;
    let screenY = sy;
    let targetOut = out;

    if (typeof sx === 'object' && sx !== null) {
      screenX = sx.x;
      screenY = sx.y;
      targetOut = sy && typeof sy === 'object' ? sy : null;
    }

    const scale = this.getScale();
    const wx = this.centerX + (screenX - this.cssWidth * 0.5) / scale;
    const wy = this.centerY + (screenY - this.cssHeight * 0.5) / (scale * CAMERA_PITCH_Y);

    if (targetOut) {
      targetOut.x = wx;
      targetOut.y = wy;
      return targetOut;
    }
    return { x: wx, y: wy };
  }

  screenToTowerPlacement(sx, sy) {
    const world = this.screenToWorld(sx, sy);
    const col = clamp(Math.round(world.x - 1), 0, GRID_COLS - 2);
    const row = clamp(Math.round(world.y - 1), 0, GRID_ROWS - 2);
    return { col, row };
  }

  panByScreenDelta(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const scale = this.getScale();
    this.centerX -= dx / scale;
    this.centerY -= dy / (scale * CAMERA_PITCH_Y);
    this._clampCenter();
  }

  zoomAtScreenPoint(factor, sx = this.cssWidth * 0.5, sy = this.cssHeight * 0.5) {
    if (!Number.isFinite(factor) || factor <= 0) return;

    const anchorX = Number.isFinite(sx) ? sx : this.cssWidth * 0.5;
    const anchorY = Number.isFinite(sy) ? sy : this.cssHeight * 0.5;
    const worldBefore = this.screenToWorld(anchorX, anchorY);

    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);

    const newScale = this.getScale();
    this.centerX = worldBefore.x - (anchorX - this.cssWidth * 0.5) / newScale;
    this.centerY = worldBefore.y - (anchorY - this.cssHeight * 0.5) / (newScale * CAMERA_PITCH_Y);
    this._clampCenter();
  }

  setCenter(wx, wy) {
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    this.centerX = wx;
    this.centerY = wy;
    this._clampCenter();
  }

  getVisibleWorldBounds() {
    const scale = this.getScale();
    const halfW = (this.cssWidth * 0.5) / scale;
    const halfH = (this.cssHeight * 0.5) / (scale * CAMERA_PITCH_Y);
    return {
      minX: this.centerX - halfW,
      maxX: this.centerX + halfW,
      minY: this.centerY - halfH,
      maxY: this.centerY + halfH,
      width: halfW * 2,
      height: halfH * 2,
    };
  }

  resetView() {
    this.zoom = 1.0;
    this.centerX = GRID_COLS * 0.5;
    this.centerY = GRID_ROWS * 0.5;
    this._clampCenter();
  }
}
