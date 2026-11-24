import {
  GRID_COLS,
  GRID_ROWS,
  GRID_CELL_COUNT,
  TOWER_FOOTPRINT,
  CELL_FLAGS,
  SPAWN_GATES,
  WAYPOINTS,
  NEXUS_CORE,
  STATIC_OBSTACLES,
} from '../contracts/types.js';

const BLOCKED_MASK = CELL_FLAGS.TOWER | CELL_FLAGS.OBSTACLE;
const SQRT2 = Math.SQRT2;
const INF = 1e9;
const REFERENCE_TRAVEL_SPEED = 1.8; // tiles/sec baseline for maze delta calculation

// 8-connected neighbor offsets: cardinal first, then diagonal
const DX = new Int8Array([1, -1, 0, 0, 1, 1, -1, -1]);
const DY = new Int8Array([0, 0, 1, -1, 1, -1, 1, -1]);
const STEP_COST = new Float32Array([1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2]);

/**
 * Zero-allocation dual-gate octile Dijkstra flow-field for 32x22 Sanctuary mazing.
 * Enforces strict anti-corner-cutting and mild wall repulsion.
 */
export class GridFlowField {
  constructor() {
    this.cols = GRID_COLS;
    this.rows = GRID_ROWS;
    this.cellCount = GRID_CELL_COUNT;

    this.flags = new Uint8Array(GRID_CELL_COUNT);
    this.trialFlags = new Uint8Array(GRID_CELL_COUNT);

    this.distToWaypoint = new Float32Array(GRID_CELL_COUNT);
    this.distToNexus = new Float32Array(GRID_CELL_COUNT);
    this.trialDistWaypoint = new Float32Array(GRID_CELL_COUNT);
    this.trialDistNexus = new Float32Array(GRID_CELL_COUNT);

    this.dirToWaypoint = new Float32Array(GRID_CELL_COUNT * 2);
    this.dirToNexus = new Float32Array(GRID_CELL_COUNT * 2);

    // Pre-allocated indexed binary min-heap
    this.heapNodes = new Int32Array(GRID_CELL_COUNT);
    this.heapPos = new Int32Array(GRID_CELL_COUNT);
    this.heapSize = 0;

    // Reusable scratch vector for internal path tracing
    this._tmpVec = { x: 0, y: 0, dist: 0 };

    this.reset();
  }

  /**
   * Restores grid to initial landmarks and static obsidian pillars, then solves flow-fields.
   */
  reset() {
    this.flags.fill(CELL_FLAGS.EMPTY);

    for (let i = 0; i < SPAWN_GATES.length; i++) {
      this._markRect(SPAWN_GATES[i], CELL_FLAGS.SPAWN);
    }
    for (let i = 0; i < WAYPOINTS.length; i++) {
      this._markRect(WAYPOINTS[i], CELL_FLAGS.WAYPOINT);
    }
    this._markRect(NEXUS_CORE, CELL_FLAGS.NEXUS);
    for (let i = 0; i < STATIC_OBSTACLES.length; i++) {
      this._markRect(STATIC_OBSTACLES[i], CELL_FLAGS.OBSTACLE);
    }

    this.recompute();
  }

  _markRect(rect, flag) {
    const endCol = rect.col + rect.w;
    const endRow = rect.row + rect.h;
    for (let r = rect.row; r < endRow; r++) {
      const rowOffset = r * GRID_COLS;
      for (let c = rect.col; c < endCol; c++) {
        this.flags[rowOffset + c] |= flag;
      }
    }
  }

  /**
   * Recomputes both Waypoint and Nexus Dijkstra fields + flow vector fields.
   * @returns {number} solve duration in milliseconds
   */
  recompute() {
    const t0 = performance.now();

    const wp = WAYPOINTS[0];
    this._solveDijkstra(this.flags, this.distToWaypoint, wp);
    this._buildFlowVectors(this.flags, this.distToWaypoint, this.dirToWaypoint, wp.cx, wp.cy);

    this._solveDijkstra(this.flags, this.distToNexus, NEXUS_CORE);
    this._buildFlowVectors(this.flags, this.distToNexus, this.dirToNexus, NEXUS_CORE.cx, NEXUS_CORE.cy);

    return performance.now() - t0;
  }

  _pushOrDecrease(node, distArr) {
    let pos = this.heapPos[node];
    if (pos === -1) {
      pos = this.heapSize++;
      this.heapNodes[pos] = node;
      this.heapPos[node] = pos;
    }
    const d = distArr[node];
    while (pos > 0) {
      const parentPos = (pos - 1) >> 1;
      const parentNode = this.heapNodes[parentPos];
      if (d >= distArr[parentNode]) break;
      this.heapNodes[pos] = parentNode;
      this.heapPos[parentNode] = pos;
      pos = parentPos;
    }
    this.heapNodes[pos] = node;
    this.heapPos[node] = pos;
  }

  _popMin(distArr) {
    const minNode = this.heapNodes[0];
    this.heapPos[minNode] = -1;
    const lastIdx = --this.heapSize;
    if (lastIdx > 0) {
      const lastNode = this.heapNodes[lastIdx];
      const lastDist = distArr[lastNode];
      let pos = 0;
      const half = lastIdx >> 1;
      while (pos < half) {
        let childPos = (pos << 1) + 1;
        let childNode = this.heapNodes[childPos];
        let childDist = distArr[childNode];
        const rightPos = childPos + 1;
        if (rightPos < lastIdx) {
          const rightNode = this.heapNodes[rightPos];
          const rightDist = distArr[rightNode];
          if (rightDist < childDist) {
            childPos = rightPos;
            childNode = rightNode;
            childDist = rightDist;
          }
        }
        if (lastDist <= childDist) break;
        this.heapNodes[pos] = childNode;
        this.heapPos[childNode] = pos;
        pos = childPos;
      }
      this.heapNodes[pos] = lastNode;
      this.heapPos[lastNode] = pos;
    }
    return minNode;
  }

  _solveDijkstra(flagsArr, distArr, goalRect) {
    distArr.fill(INF);
    this.heapPos.fill(-1);
    this.heapSize = 0;

    const endCol = goalRect.col + goalRect.w;
    const endRow = goalRect.row + goalRect.h;
    for (let r = goalRect.row; r < endRow; r++) {
      const rowOffset = r * GRID_COLS;
      for (let c = goalRect.col; c < endCol; c++) {
        const idx = rowOffset + c;
        if ((flagsArr[idx] & BLOCKED_MASK) === 0) {
          distArr[idx] = 0;
          this._pushOrDecrease(idx, distArr);
        }
      }
    }

    while (this.heapSize > 0) {
      const idx = this._popMin(distArr);
      const d = distArr[idx];
      const c = idx % GRID_COLS;
      const r = (idx - c) / GRID_COLS;

      for (let k = 0; k < 8; k++) {
        const dx = DX[k];
        const dy = DY[k];
        const nc = c + dx;
        const nr = r + dy;
        if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;

        const nIdx = nr * GRID_COLS + nc;
        if ((flagsArr[nIdx] & BLOCKED_MASK) !== 0) continue;

        // Strict anti-corner-cutting for diagonals
        if (dx !== 0 && dy !== 0) {
          if ((flagsArr[r * GRID_COLS + nc] & BLOCKED_MASK) !== 0) continue;
          if ((flagsArr[nr * GRID_COLS + c] & BLOCKED_MASK) !== 0) continue;
        }

        const nd = d + STEP_COST[k];
        if (nd < distArr[nIdx]) {
          distArr[nIdx] = nd;
          this._pushOrDecrease(nIdx, distArr);
        }
      }
    }
  }

  _buildFlowVectors(flagsArr, distArr, dirArr, goalCx, goalCy) {
    dirArr.fill(0);

    for (let r = 0; r < GRID_ROWS; r++) {
      const rowOffset = r * GRID_COLS;
      for (let c = 0; c < GRID_COLS; c++) {
        const idx = rowOffset + c;
        if ((flagsArr[idx] & BLOCKED_MASK) !== 0) continue;
        const d = distArr[idx];
        if (d >= INF * 0.5) continue;

        if (d === 0) {
          const toX = goalCx - (c + 0.5);
          const toY = goalCy - (r + 0.5);
          const len = Math.hypot(toX, toY);
          if (len > 1e-5) {
            dirArr[idx * 2] = toX / len;
            dirArr[idx * 2 + 1] = toY / len;
          }
          continue;
        }

        let bestDx = 0;
        let bestDy = 0;
        let bestRate = -1;
        let bestGoalAlign = -2;

        const toGoalX = goalCx - (c + 0.5);
        const toGoalY = goalCy - (r + 0.5);
        const toGoalLen = Math.hypot(toGoalX, toGoalY) || 1;
        const gnx = toGoalX / toGoalLen;
        const gny = toGoalY / toGoalLen;

        for (let k = 0; k < 8; k++) {
          const dx = DX[k];
          const dy = DY[k];
          const nc = c + dx;
          const nr = r + dy;
          if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;

          const nIdx = nr * GRID_COLS + nc;
          if ((flagsArr[nIdx] & BLOCKED_MASK) !== 0) continue;

          if (dx !== 0 && dy !== 0) {
            if ((flagsArr[r * GRID_COLS + nc] & BLOCKED_MASK) !== 0) continue;
            if ((flagsArr[nr * GRID_COLS + c] & BLOCKED_MASK) !== 0) continue;
          }

          const nd = distArr[nIdx];
          if (nd >= d) continue;

          const cost = STEP_COST[k];
          const rate = (d - nd) / cost;
          const stepLen = cost;
          const align = (dx / stepLen) * gnx + (dy / stepLen) * gny;

          if (rate > bestRate + 1e-4 || (Math.abs(rate - bestRate) <= 1e-4 && align > bestGoalAlign)) {
            bestRate = rate;
            bestGoalAlign = align;
            bestDx = dx / stepLen;
            bestDy = dy / stepLen;
          }
        }

        dirArr[idx * 2] = bestDx;
        dirArr[idx * 2 + 1] = bestDy;
      }
    }
  }

  _computeCellFlowFromDist(flagsArr, distArr, c, r, goalCx, goalCy, outVec) {
    const idx = r * GRID_COLS + c;
    const d = distArr[idx];
    if ((flagsArr[idx] & BLOCKED_MASK) !== 0 || d >= INF * 0.5) {
      outVec.x = 0;
      outVec.y = 0;
      outVec.dist = INF;
      return outVec;
    }

    if (d === 0) {
      const toX = goalCx - (c + 0.5);
      const toY = goalCy - (r + 0.5);
      const len = Math.hypot(toX, toY);
      outVec.x = len > 1e-5 ? toX / len : 0;
      outVec.y = len > 1e-5 ? toY / len : 0;
      outVec.dist = 0;
      return outVec;
    }

    let bestDx = 0;
    let bestDy = 0;
    let bestRate = -1;
    let bestGoalAlign = -2;

    const toGoalX = goalCx - (c + 0.5);
    const toGoalY = goalCy - (r + 0.5);
    const toGoalLen = Math.hypot(toGoalX, toGoalY) || 1;
    const gnx = toGoalX / toGoalLen;
    const gny = toGoalY / toGoalLen;

    for (let k = 0; k < 8; k++) {
      const dx = DX[k];
      const dy = DY[k];
      const nc = c + dx;
      const nr = r + dy;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;

      const nIdx = nr * GRID_COLS + nc;
      if ((flagsArr[nIdx] & BLOCKED_MASK) !== 0) continue;

      if (dx !== 0 && dy !== 0) {
        if ((flagsArr[r * GRID_COLS + nc] & BLOCKED_MASK) !== 0) continue;
        if ((flagsArr[nr * GRID_COLS + c] & BLOCKED_MASK) !== 0) continue;
      }

      const nd = distArr[nIdx];
      if (nd >= d) continue;

      const cost = STEP_COST[k];
      const rate = (d - nd) / cost;
      const align = (dx / cost) * gnx + (dy / cost) * gny;

      if (rate > bestRate + 1e-4 || (Math.abs(rate - bestRate) <= 1e-4 && align > bestGoalAlign)) {
        bestRate = rate;
        bestGoalAlign = align;
        bestDx = dx / cost;
        bestDy = dy / cost;
      }
    }

    outVec.x = bestDx;
    outVec.y = bestDy;
    outVec.dist = d;
    return outVec;
  }

  /**
   * Samples flow direction at world coordinates (wx, wy) for stage (0 = Waypoint, 1 = Nexus).
   * Applies mild wall repulsion near blocked edges/corners.
   */
  sampleFlow(wx, wy, stage, outVec = { x: 0, y: 0, dist: 0 }) {
    const c = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(wx)));
    const r = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(wy)));
    const idx = r * GRID_COLS + c;

    const distArr = stage === 0 ? this.distToWaypoint : this.distToNexus;
    const dirArr = stage === 0 ? this.dirToWaypoint : this.dirToNexus;
    const goal = stage === 0 ? WAYPOINTS[0] : NEXUS_CORE;

    if ((this.flags[idx] & BLOCKED_MASK) !== 0 || distArr[idx] >= INF * 0.5) {
      const safe = this.findNearestWalkable(wx, wy);
      const dx = safe.x - wx;
      const dy = safe.y - wy;
      const len = Math.hypot(dx, dy);
      outVec.x = len > 1e-5 ? dx / len : 0;
      outVec.y = len > 1e-5 ? dy / len : 0;
      outVec.dist = Infinity;
      return outVec;
    }

    const d = distArr[idx];
    if (d === 0) {
      const dx = goal.cx - wx;
      const dy = goal.cy - wy;
      const len = Math.hypot(dx, dy);
      outVec.x = len > 1e-5 ? dx / len : 0;
      outVec.y = len > 1e-5 ? dy / len : 0;
      outVec.dist = 0;
      return outVec;
    }

    let vx = dirArr[idx * 2];
    let vy = dirArr[idx * 2 + 1];

    // Mild wall & corner repulsion from any adjacent blocked cell within 0.44 tiles
    const repelRadius = 0.44;
    const repelStrength = 0.52;
    for (let k = 0; k < 8; k++) {
      const nc = c + DX[k];
      const nr = r + DY[k];
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      if ((this.flags[nr * GRID_COLS + nc] & BLOCKED_MASK) === 0) continue;

      const px = wx < nc ? nc : wx > nc + 1 ? nc + 1 : wx;
      const py = wy < nr ? nr : wy > nr + 1 ? nr + 1 : wy;
      const rdx = wx - px;
      const rdy = wy - py;
      const distWall = Math.hypot(rdx, rdy);
      if (distWall < repelRadius && distWall > 1e-5) {
        const w = ((repelRadius - distWall) / repelRadius) * repelStrength;
        vx += (rdx / distWall) * w;
        vy += (rdy / distWall) * w;
      }
    }

    const len = Math.hypot(vx, vy);
    if (len > 1e-5) {
      outVec.x = vx / len;
      outVec.y = vy / len;
    } else {
      outVec.x = dirArr[idx * 2];
      outVec.y = dirArr[idx * 2 + 1];
    }
    outVec.dist = d;
    return outVec;
  }

  _rectMinDist(rect, distArr) {
    let best = INF;
    const endCol = rect.col + rect.w;
    const endRow = rect.row + rect.h;
    for (let r = rect.row; r < endRow; r++) {
      const rowOffset = r * GRID_COLS;
      for (let c = rect.col; c < endCol; c++) {
        const d = distArr[rowOffset + c];
        if (d < best) best = d;
      }
    }
    return best;
  }

  _computeTotalPathDist(distWpArr, distNxArr) {
    let gateDistSum = 0;
    for (let i = 0; i < SPAWN_GATES.length; i++) {
      const gd = this._rectMinDist(SPAWN_GATES[i], distWpArr);
      if (gd >= INF * 0.5) return Infinity;
      gateDistSum += gd;
    }
    const wpToNx = this._rectMinDist(WAYPOINTS[0], distNxArr);
    if (wpToNx >= INF * 0.5) return Infinity;
    return gateDistSum / SPAWN_GATES.length + wpToNx;
  }

  _tracePathFromFields(gateIndex, flagsArr, distWpArr, distNxArr, usePrecomputedDirs) {
    const gate = SPAWN_GATES[gateIndex] || SPAWN_GATES[0];
    const wp = WAYPOINTS[0];
    const nx = NEXUS_CORE;

    const path = [{ x: gate.cx, y: gate.cy }];
    let x = gate.cx;
    let y = gate.cy;
    const stepSize = 0.5;
    const vec = this._tmpVec;

    // Stage 0: Gate -> Waypoint 0
    for (let iter = 0; iter < 1200; iter++) {
      const toWpDist = Math.hypot(wp.cx - x, wp.cy - y);
      if (toWpDist <= 0.65) {
        path.push({ x: wp.cx, y: wp.cy });
        x = wp.cx;
        y = wp.cy;
        break;
      }

      if (usePrecomputedDirs) {
        this.sampleFlow(x, y, 0, vec);
      } else {
        const c = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(x)));
        const r = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(y)));
        this._computeCellFlowFromDist(flagsArr, distWpArr, c, r, wp.cx, wp.cy, vec);
      }

      if (vec.dist >= INF * 0.5 || (vec.x === 0 && vec.y === 0)) break;
      x += vec.x * stepSize;
      y += vec.y * stepSize;
      path.push({ x, y });
    }

    // Stage 1: Waypoint 0 -> Nexus
    for (let iter = 0; iter < 1200; iter++) {
      const toNxDist = Math.hypot(nx.cx - x, nx.cy - y);
      if (toNxDist <= 0.65) {
        path.push({ x: nx.cx, y: nx.cy });
        break;
      }

      if (usePrecomputedDirs) {
        this.sampleFlow(x, y, 1, vec);
      } else {
        const c = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(x)));
        const r = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(y)));
        this._computeCellFlowFromDist(flagsArr, distNxArr, c, r, nx.cx, nx.cy, vec);
      }

      if (vec.dist >= INF * 0.5 || (vec.x === 0 && vec.y === 0)) break;
      x += vec.x * stepSize;
      y += vec.y * stepSize;
      path.push({ x, y });
    }

    return path;
  }

  /**
   * Traces the current optimal path from Spawn Gate `gateIndex` -> Waypoint 0 -> Nexus.
   */
  traceGoldenPath(gateIndex = 0) {
    return this._tracePathFromFields(gateIndex, this.flags, this.distToWaypoint, this.distToNexus, true);
  }

  /**
   * Finds the nearest walkable world coordinate if `(wx, wy)` lies inside a blocked cell.
   */
  findNearestWalkable(wx, wy) {
    const c = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(wx)));
    const r = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(wy)));
    if ((this.flags[r * GRID_COLS + c] & BLOCKED_MASK) === 0) {
      return {
        x: Math.max(0.2, Math.min(GRID_COLS - 0.2, wx)),
        y: Math.max(0.2, Math.min(GRID_ROWS - 0.2, wy)),
      };
    }

    let bestX = c + 0.5;
    let bestY = r + 0.5;
    let bestDistSq = Infinity;

    for (let nr = 0; nr < GRID_ROWS; nr++) {
      const rowOffset = nr * GRID_COLS;
      for (let nc = 0; nc < GRID_COLS; nc++) {
        if ((this.flags[rowOffset + nc] & BLOCKED_MASK) !== 0) continue;
        const cx = nc + 0.5;
        const cy = nr + 0.5;
        const dSq = (cx - wx) * (cx - wx) + (cy - wy) * (cy - wy);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestX = cx;
          bestY = cy;
        }
      }
    }

    return { x: bestX, y: bestY };
  }

  /**
   * Dual-gate non-mutating placement trial.
   * Rejects bounds/overlap, Spawn->Waypoint->Nexus blocks, or trapped/overlapping ground creeps.
   */
  canPlaceTower(col, row, activeGroundCreeps = []) {
    const baseDist = this._computeTotalPathDist(this.distToWaypoint, this.distToNexus);
    const baseTravelSec = Number.isFinite(baseDist) ? baseDist / REFERENCE_TRAVEL_SPEED : Infinity;

    if (
      !Number.isInteger(col) ||
      !Number.isInteger(row) ||
      col < 0 ||
      row < 0 ||
      col > GRID_COLS - TOWER_FOOTPRINT ||
      row > GRID_ROWS - TOWER_FOOTPRINT
    ) {
      return {
        valid: false,
        reason: 'Out of bounds',
        baseTravelSec,
        previewTravelSec: baseTravelSec,
        deltaSec: 0,
        previewPath: [],
      };
    }

    for (let dr = 0; dr < TOWER_FOOTPRINT; dr++) {
      const rowOffset = (row + dr) * GRID_COLS;
      for (let dc = 0; dc < TOWER_FOOTPRINT; dc++) {
        if (this.flags[rowOffset + col + dc] !== CELL_FLAGS.EMPTY) {
          return {
            valid: false,
            reason: 'Tile occupied',
            baseTravelSec,
            previewTravelSec: baseTravelSec,
            deltaSec: 0,
            previewPath: [],
          };
        }
      }
    }

    // Check physical footprint overlap with active ground creeps
    if (activeGroundCreeps && activeGroundCreeps.length > 0) {
      const x0 = col;
      const x1 = col + TOWER_FOOTPRINT;
      const y0 = row;
      const y1 = row + TOWER_FOOTPRINT;
      for (let i = 0; i < activeGroundCreeps.length; i++) {
        const creep = activeGroundCreeps[i];
        if (!creep || creep.active === false) continue;
        if (creep.isFlying && !(creep.earthboundTimer > 0)) continue;

        const rad = creep.radius || 0.25;
        const px = creep.x < x0 ? x0 : creep.x > x1 ? x1 : creep.x;
        const py = creep.y < y0 ? y0 : creep.y > y1 ? y1 : creep.y;
        const dx = creep.x - px;
        const dy = creep.y - py;
        if (dx * dx + dy * dy < rad * rad) {
          return {
            valid: false,
            reason: 'Cannot build on active creeps!',
            baseTravelSec,
            previewTravelSec: baseTravelSec,
            deltaSec: 0,
            previewPath: [],
          };
        }
      }
    }

    // Populate trial flags without mutating live grid
    this.trialFlags.set(this.flags);
    for (let dr = 0; dr < TOWER_FOOTPRINT; dr++) {
      const rowOffset = (row + dr) * GRID_COLS;
      for (let dc = 0; dc < TOWER_FOOTPRINT; dc++) {
        this.trialFlags[rowOffset + col + dc] |= CELL_FLAGS.TOWER;
      }
    }

    this._solveDijkstra(this.trialFlags, this.trialDistWaypoint, WAYPOINTS[0]);
    this._solveDijkstra(this.trialFlags, this.trialDistNexus, NEXUS_CORE);

    const previewDist = this._computeTotalPathDist(this.trialDistWaypoint, this.trialDistNexus);
    if (!Number.isFinite(previewDist)) {
      return {
        valid: false,
        reason: 'Cannot Block Creep Path!',
        baseTravelSec,
        previewTravelSec: Infinity,
        deltaSec: Infinity,
        previewPath: [],
      };
    }

    // Verify every active ground creep still has a valid path to its current stage goal
    if (activeGroundCreeps && activeGroundCreeps.length > 0) {
      for (let i = 0; i < activeGroundCreeps.length; i++) {
        const creep = activeGroundCreeps[i];
        if (!creep || creep.active === false) continue;
        if (creep.isFlying && !(creep.earthboundTimer > 0)) continue;

        const cc = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(creep.x)));
        const cr = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(creep.y)));
        const idx = cr * GRID_COLS + cc;

        if ((this.trialFlags[idx] & BLOCKED_MASK) !== 0) {
          return {
            valid: false,
            reason: 'Cannot Block Creep Path!',
            baseTravelSec,
            previewTravelSec: Infinity,
            deltaSec: Infinity,
            previewPath: [],
          };
        }

        const creepDist = creep.stage === 0 ? this.trialDistWaypoint[idx] : this.trialDistNexus[idx];
        if (creepDist >= INF * 0.5) {
          return {
            valid: false,
            reason: 'Cannot Trap Active Creep!',
            baseTravelSec,
            previewTravelSec: Infinity,
            deltaSec: Infinity,
            previewPath: [],
          };
        }
      }
    }

    const previewTravelSec = previewDist / REFERENCE_TRAVEL_SPEED;
    const deltaSec = previewTravelSec - baseTravelSec;
    const previewPath = this._tracePathFromFields(
      0,
      this.trialFlags,
      this.trialDistWaypoint,
      this.trialDistNexus,
      false,
    );

    return {
      valid: true,
      reason: 'ok',
      baseTravelSec,
      previewTravelSec,
      deltaSec,
      previewPath,
    };
  }

  /**
   * Commits a 2x2 tower footprint onto the live grid and updates flow-fields.
   */
  placeTowerFootprint(col, row) {
    if (
      !Number.isInteger(col) ||
      !Number.isInteger(row) ||
      col < 0 ||
      row < 0 ||
      col > GRID_COLS - TOWER_FOOTPRINT ||
      row > GRID_ROWS - TOWER_FOOTPRINT
    ) {
      return false;
    }

    for (let dr = 0; dr < TOWER_FOOTPRINT; dr++) {
      const rowOffset = (row + dr) * GRID_COLS;
      for (let dc = 0; dc < TOWER_FOOTPRINT; dc++) {
        if (this.flags[rowOffset + col + dc] !== CELL_FLAGS.EMPTY) return false;
      }
    }

    for (let dr = 0; dr < TOWER_FOOTPRINT; dr++) {
      const rowOffset = (row + dr) * GRID_COLS;
      for (let dc = 0; dc < TOWER_FOOTPRINT; dc++) {
        this.flags[rowOffset + col + dc] |= CELL_FLAGS.TOWER;
      }
    }

    this.recompute();
    return true;
  }

  /**
   * Removes a 2x2 tower footprint from the live grid and updates flow-fields.
   */
  removeTowerFootprint(col, row) {
    if (
      !Number.isInteger(col) ||
      !Number.isInteger(row) ||
      col < 0 ||
      row < 0 ||
      col > GRID_COLS - TOWER_FOOTPRINT ||
      row > GRID_ROWS - TOWER_FOOTPRINT
    ) {
      return false;
    }

    let hadTower = false;
    for (let dr = 0; dr < TOWER_FOOTPRINT; dr++) {
      const rowOffset = (row + dr) * GRID_COLS;
      for (let dc = 0; dc < TOWER_FOOTPRINT; dc++) {
        const idx = rowOffset + col + dc;
        if ((this.flags[idx] & CELL_FLAGS.TOWER) !== 0) {
          hadTower = true;
          this.flags[idx] &= ~CELL_FLAGS.TOWER;
        }
      }
    }

    if (hadTower) {
      this.recompute();
    }
    return hadTower;
  }
}
