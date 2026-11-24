import { GRID_COLS, GRID_ROWS, MAX_CREEPS } from '../contracts/types.js';

/**
 * Zero-allocation flat typed-array spatial hash for O(1) average radius & segment queries.
 */
export class SpatialHash {
  constructor(cols = GRID_COLS, rows = GRID_ROWS, maxEntities = MAX_CREEPS) {
    this.cols = cols;
    this.rows = rows;
    this.cellCount = cols * rows;
    this.maxEntities = maxEntities;

    this.heads = new Int32Array(this.cellCount);
    this.next = new Int32Array(maxEntities);
    this.posX = new Float32Array(maxEntities);
    this.posY = new Float32Array(maxEntities);

    this.clear();
  }

  clear() {
    this.heads.fill(-1);
  }

  insert(idx, x, y) {
    if (idx < 0 || idx >= this.maxEntities) return;
    const c = Math.max(0, Math.min(this.cols - 1, Math.floor(x)));
    const r = Math.max(0, Math.min(this.rows - 1, Math.floor(y)));
    const cell = r * this.cols + c;

    this.posX[idx] = x;
    this.posY[idx] = y;
    this.next[idx] = this.heads[cell];
    this.heads[cell] = idx;
  }

  /**
   * Appends entity indices within `radius` of `(x, y)` to `outIndices`.
   * @returns {number} count appended
   */
  queryRadius(x, y, radius, outIndices) {
    const minC = Math.max(0, Math.floor(x - radius));
    const maxC = Math.min(this.cols - 1, Math.floor(x + radius));
    const minR = Math.max(0, Math.floor(y - radius));
    const maxR = Math.min(this.rows - 1, Math.floor(y + radius));
    const r2 = radius * radius;

    let added = 0;
    for (let r = minR; r <= maxR; r++) {
      const rowOffset = r * this.cols;
      for (let c = minC; c <= maxC; c++) {
        let idx = this.heads[rowOffset + c];
        while (idx !== -1) {
          const dx = this.posX[idx] - x;
          const dy = this.posY[idx] - y;
          if (dx * dx + dy * dy <= r2) {
            outIndices.push(idx);
            added++;
          }
          idx = this.next[idx];
        }
      }
    }
    return added;
  }

  /**
   * Appends entity indices within `halfWidth` of line segment `(x1, y1) -> (x2, y2)`.
   * @returns {number} count appended
   */
  querySegment(x1, y1, x2, y2, halfWidth, outIndices) {
    const minX = (x1 < x2 ? x1 : x2) - halfWidth;
    const maxX = (x1 > x2 ? x1 : x2) + halfWidth;
    const minY = (y1 < y2 ? y1 : y2) - halfWidth;
    const maxY = (y1 > y2 ? y1 : y2) + halfWidth;

    const minC = Math.max(0, Math.floor(minX));
    const maxC = Math.min(this.cols - 1, Math.floor(maxX));
    const minR = Math.max(0, Math.floor(minY));
    const maxR = Math.min(this.rows - 1, Math.floor(maxY));

    const segDx = x2 - x1;
    const segDy = y2 - y1;
    const segLenSq = segDx * segDx + segDy * segDy;
    const hwSq = halfWidth * halfWidth;

    let added = 0;
    for (let r = minR; r <= maxR; r++) {
      const rowOffset = r * this.cols;
      for (let c = minC; c <= maxC; c++) {
        let idx = this.heads[rowOffset + c];
        while (idx !== -1) {
          const px = this.posX[idx];
          const py = this.posY[idx];

          let t = 0;
          if (segLenSq > 1e-8) {
            t = ((px - x1) * segDx + (py - y1) * segDy) / segLenSq;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
          }

          const cx = x1 + t * segDx;
          const cy = y1 + t * segDy;
          const dx = px - cx;
          const dy = py - cy;
          if (dx * dx + dy * dy <= hwSq) {
            outIndices.push(idx);
            added++;
          }
          idx = this.next[idx];
        }
      }
    }
    return added;
  }
}
