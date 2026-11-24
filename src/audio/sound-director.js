import { GRID_COLS, SIM_EVENTS } from '../contracts/types.js';
import { DspContext } from './dsp-context.js';
import { FoleyPatches } from './foley-patches.js';

const DEFAULT_COOLDOWNS_MS = Object.freeze({
  buildPlace: 40,
  buildComplete: 40,
  upgradeAnvil: 45,
  fusionChord: 60,
  sellCoins: 45,
  invalidBlock: 60,
  fireBallista: 28,
  fireMortar: 45,
  fireFrost: 35,
  shatterIce: 40,
  chainLightning: 40,
  acidSizzle: 38,
  flameRoar: 40,
  creepBounty: 35,
  waveHorn: 60,
  nexusLeak: 55,
  uiClick: 25,
});

const TOWER_FIRE_PATCH_MAP = Object.freeze({
  ballista: 'fireBallista',
  railgun_bastion: 'fireBallista',
  viper_gatling: 'fireBallista',
  windchill_flak: 'fireBallista',
  mortar: 'fireMortar',
  hellfire_mortar: 'fireMortar',
  shatter_cannon: 'fireMortar',
  singularity_catapult: 'fireMortar',
  frost: 'fireFrost',
  glacial_obelisk: 'fireFrost',
  tesla: 'chainLightning',
  plague_coil: 'chainLightning',
  venom: 'acidSizzle',
  brazier: 'flameRoar',
  solar_flare: 'flameRoar',
});

function getWallNowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * Routes simulation events and UI cues into stereo-panned procedural
 * Web Audio patches with per-patch cooldown throttling (25-60ms).
 */
export class SoundDirector {
  constructor(dspOptions = {}) {
    if (dspOptions instanceof DspContext || typeof dspOptions?.acquireVoice === 'function') {
      this.dsp = dspOptions;
    } else if (dspOptions?.dsp) {
      this.dsp = dspOptions.dsp;
    } else {
      this.dsp = new DspContext(dspOptions);
    }

    this._nowFn = typeof dspOptions?.nowFn === 'function' ? dspOptions.nowFn : null;
    this._cooldownsMs = {
      ...DEFAULT_COOLDOWNS_MS,
      ...(dspOptions?.cooldownsMs || {}),
    };
    this._wallOriginMs = getWallNowMs();
    this._lastPlayedMs = new Map();
  }

  unlock() {
    const unlocked = this.dsp.unlock();
    if (unlocked) {
      this._wallOriginMs = getWallNowMs();
    }
    return unlocked;
  }

  setMuted(b) {
    return this.dsp.setMuted(b);
  }

  toggleMute() {
    return this.dsp.setMuted(!this.dsp.isMuted());
  }

  isMuted() {
    return this.dsp.isMuted();
  }

  setMasterVolume(v) {
    return this.dsp.setMasterVolume(v);
  }

  getMasterVolume() {
    return this.dsp.getMasterVolume();
  }

  getActiveVoiceCount() {
    return this.dsp.getActiveVoiceCount();
  }

  /**
   * Plays a crisp, enveloped clockwork UI click when unlocked and unmuted.
   */
  playUiClick() {
    if (!this.dsp.isUnlocked() || this.dsp.isMuted()) return false;
    if (!this._canTrigger('uiClick')) return false;

    const voice = this.dsp.acquireVoice(0, 3, 0.08);
    if (!voice) return false;

    const { ctx, outNode } = voice;
    if (typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') {
      return true;
    }

    const now = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    voice.track?.(osc);
    voice.track?.(gain);

    osc.type = 'triangle';
    if (osc.frequency) {
      osc.frequency.setValueAtTime?.(1380, now);
      osc.frequency.exponentialRampToValueAtTime?.(620, now + 0.045);
    }
    if (gain.gain) {
      gain.gain.setValueAtTime?.(0.0001, now);
      gain.gain.linearRampToValueAtTime?.(0.14, now + 0.002);
      gain.gain.exponentialRampToValueAtTime?.(0.0001, now + 0.055);
    }

    osc.connect?.(gain);
    gain.connect?.(outNode);
    osc.start?.(now);
    osc.stop?.(now + 0.065);
    return true;
  }

  /**
   * Maps a simulation event to a procedural FoleyPatch with world-X stereo
   * panning and per-patch cooldown throttling.
   */
  handleSimEvent(ev, worldWidth = GRID_COLS) {
    if (!ev || typeof ev !== 'object') return false;
    if (!this.dsp.isUnlocked() || this.dsp.isMuted()) return false;

    const patchKey = this._resolvePatchKey(ev);
    if (!patchKey) return false;

    const patchFn = FoleyPatches[patchKey];
    if (typeof patchFn !== 'function') return false;

    if (!this._canTrigger(patchKey)) return false;

    const pan = this._computePan(ev, worldWidth);
    return Boolean(patchFn(this.dsp, pan));
  }

  _resolvePatchKey(ev) {
    const type = ev.type ?? ev.event ?? ev.kind;
    switch (type) {
      case SIM_EVENTS.TOWER_PLACED:
        return 'buildPlace';
      case SIM_EVENTS.TOWER_COMPLETE:
      case SIM_EVENTS.WAVE_CLEARED:
        return 'buildComplete';
      case SIM_EVENTS.TOWER_UPGRADED:
        return 'upgradeAnvil';
      case SIM_EVENTS.TOWER_FUSED:
        return 'fusionChord';
      case SIM_EVENTS.TOWER_SOLD:
        return 'sellCoins';
      case SIM_EVENTS.BUILD_INVALID:
        return 'invalidBlock';
      case SIM_EVENTS.BUILDER_SPARK:
        return null;
      case SIM_EVENTS.TOWER_FIRE: {
        const towerId =
          ev.fusionId ||
          ev.tower?.fusionId ||
          ev.lineageId ||
          ev.tower?.lineageId ||
          ev.towerType ||
          ev.weapon ||
          'ballista';
        return TOWER_FIRE_PATCH_MAP[towerId] || 'fireBallista';
      }
      case SIM_EVENTS.PROJECTILE_HIT: {
        const hitSource =
          ev.fusionId ||
          ev.lineageId ||
          ev.towerType ||
          ev.effect ||
          ev.attackType ||
          '';
        if (
          hitSource === 'hellfire_mortar' ||
          hitSource === 'brazier' ||
          hitSource === 'solar_flare' ||
          hitSource === 'ignite'
        ) {
          return 'flameRoar';
        }
        if (
          hitSource === 'venom' ||
          hitSource === 'plague_coil' ||
          hitSource === 'viper_gatling' ||
          hitSource === 'acid' ||
          ev.acid
        ) {
          return 'acidSizzle';
        }
        if (
          hitSource === 'mortar' ||
          hitSource === 'shatter_cannon' ||
          hitSource === 'singularity_catapult' ||
          hitSource === 'Siege'
        ) {
          return 'fireMortar';
        }
        if (
          hitSource === 'frost' ||
          hitSource === 'glacial_obelisk' ||
          hitSource === 'chill' ||
          hitSource === 'freeze'
        ) {
          return 'fireFrost';
        }
        return null;
      }
      case SIM_EVENTS.CHAIN_LIGHTNING:
        return 'chainLightning';
      case SIM_EVENTS.SHATTER_COMBO:
        return 'shatterIce';
      case SIM_EVENTS.EARTHBIND_PULL:
        return 'fireFrost';
      case SIM_EVENTS.KNOCKUP_LAND:
        return 'fireMortar';
      case SIM_EVENTS.TERRAIN_DECAL: {
        const decalType = ev.decalType ?? ev.decal ?? ev.subType;
        if (decalType === 'acid') return 'acidSizzle';
        if (decalType === 'scorch' || decalType === 'slag' || decalType === 'fire') {
          return 'flameRoar';
        }
        if (decalType === 'frost') return 'fireFrost';
        if (decalType === 'crack') return 'fireMortar';
        return null;
      }
      case SIM_EVENTS.CREEP_KILLED:
        return 'creepBounty';
      case SIM_EVENTS.NEXUS_LEAK:
        return 'nexusLeak';
      case SIM_EVENTS.WAVE_STARTED:
        return 'waveHorn';
      default:
        return null;
    }
  }

  _computePan(ev, worldWidth) {
    const width = Number.isFinite(worldWidth) && worldWidth > 0 ? worldWidth : GRID_COLS;
    let wx = ev.x ?? ev.wx ?? ev.cx;
    if (!Number.isFinite(wx) && Number.isFinite(ev.col)) {
      wx = ev.col + 1;
    }
    if (!Number.isFinite(wx) && Array.isArray(ev.points) && ev.points.length > 0) {
      const p0 = ev.points[0];
      wx = p0?.x ?? p0?.wx;
    }
    if (!Number.isFinite(wx)) return 0;
    const rawPan = (wx / width) * 2 - 1;
    return Number.isFinite(rawPan) ? clamp(rawPan, -0.85, 0.85) : 0;
  }

  _getNowMs() {
    if (this._nowFn) return this._nowFn();
    const wallElapsed = Math.max(0, getWallNowMs() - this._wallOriginMs);
    const ctxTime = this.dsp?._ctx?.currentTime;
    const ctxMs = Number.isFinite(ctxTime) ? ctxTime * 1000 : 0;
    return Math.max(wallElapsed, ctxMs);
  }

  _canTrigger(patchKey) {
    const cooldown = this._cooldownsMs[patchKey] ?? 35;
    const nowMs = this._getNowMs();
    const prevMs = this._lastPlayedMs.get(patchKey);
    if (prevMs !== undefined && nowMs - prevMs < cooldown) {
      return false;
    }
    this._lastPlayedMs.set(patchKey, nowMs);
    return true;
  }
}
