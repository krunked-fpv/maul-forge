import { VOICE_POOL_LIMIT } from '../contracts/types.js';

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function setParamImmediate(param, value, time = 0) {
  if (!param || typeof param !== 'object') return;
  if (typeof param.cancelScheduledValues === 'function') {
    try {
      param.cancelScheduledValues(time);
    } catch {
      // Ignore mock or state edge errors.
    }
  }
  if (typeof param.setValueAtTime === 'function') {
    try {
      param.setValueAtTime(value, time);
    } catch {
      // Ignore if time is out of bounds on a mock.
    }
  }
  if ('value' in param) {
    param.value = value;
  }
}

function getGlobalAudioContextCtor() {
  if (typeof globalThis !== 'undefined') {
    if (typeof globalThis.AudioContext === 'function') return globalThis.AudioContext;
    if (typeof globalThis.webkitAudioContext === 'function') return globalThis.webkitAudioContext;
  }
  if (typeof window !== 'undefined') {
    if (typeof window.AudioContext === 'function') return window.AudioContext;
    if (typeof window.webkitAudioContext === 'function') return window.webkitAudioContext;
  }
  return null;
}

/**
 * Lazy Web Audio DSP context managing master compression, stereo voice
 * allocation capped at VOICE_POOL_LIMIT (24), and reusable noise buffers.
 */
export class DspContext {
  constructor(options = {}) {
    const opts = options || {};
    this._audioContextFactory =
      typeof opts.audioContextFactory === 'function' ? opts.audioContextFactory : null;
    this._voiceLimit =
      Number.isInteger(opts.voiceLimit) && opts.voiceLimit > 0
        ? opts.voiceLimit
        : VOICE_POOL_LIMIT;
    this._muted = Boolean(opts.muted);
    this._masterVolume = clamp(
      opts.masterVolume !== undefined ? opts.masterVolume : 0.8,
      0,
      1
    );

    this._ctx = null;
    this._masterGain = null;
    this._compressor = null;
    this._whiteNoiseBuffer = null;
    this._pinkNoiseBuffer = null;
    this._unlocked = false;

    this._voices = [];
    this._nextVoiceSeq = 1;
  }

  /**
   * Lazily constructs the AudioContext (or test mock) and resumes playback
   * strictly upon user gesture. Safe no-op in headless environments.
   */
  unlock() {
    if (!this._ctx) {
      let ctx = null;
      try {
        if (this._audioContextFactory) {
          ctx = this._audioContextFactory();
        } else {
          const AudioCtor = getGlobalAudioContextCtor();
          if (!AudioCtor) return false;
          ctx = new AudioCtor();
        }
      } catch {
        return false;
      }

      if (!ctx || typeof ctx.createGain !== 'function') {
        return false;
      }

      try {
        const masterGain = ctx.createGain();
        const compressor =
          typeof ctx.createDynamicsCompressor === 'function'
            ? ctx.createDynamicsCompressor()
            : null;

        const now = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;

        if (compressor) {
          setParamImmediate(compressor.threshold, -14, now);
          setParamImmediate(compressor.ratio, 6, now);
          setParamImmediate(compressor.knee, 12, now);
          setParamImmediate(compressor.attack, 0.003, now);
          setParamImmediate(compressor.release, 0.15, now);

          masterGain.connect(compressor);
          if (ctx.destination) {
            compressor.connect(ctx.destination);
          }
        } else if (ctx.destination) {
          masterGain.connect(ctx.destination);
        }

        this._ctx = ctx;
        this._masterGain = masterGain;
        this._compressor = compressor;
        this._syncMasterGain();
        this._ensureNoiseBuffers();
      } catch {
        this._ctx = null;
        this._masterGain = null;
        this._compressor = null;
        return false;
      }
    }

    if (this._ctx.state === 'closed') {
      this._unlocked = false;
      return false;
    }

    if (this._ctx.state === 'suspended' && typeof this._ctx.resume === 'function') {
      try {
        const maybePromise = this._ctx.resume();
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch(() => {});
        }
      } catch {
        // Ignore resume rejections outside gesture.
      }
    }

    this._unlocked = true;
    return true;
  }

  isUnlocked() {
    return Boolean(this._unlocked && this._ctx && this._ctx.state !== 'closed');
  }

  setMuted(muted) {
    const nextMuted = Boolean(muted);
    this._muted = nextMuted;
    this._syncMasterGain();
    if (nextMuted) {
      this._releaseAllVoices();
    }
    return this._muted;
  }

  isMuted() {
    return this._muted;
  }

  setMasterVolume(vol) {
    if (Number.isFinite(vol)) {
      this._masterVolume = clamp(vol, 0, 1);
      this._syncMasterGain();
    }
    return this._masterVolume;
  }

  getMasterVolume() {
    return this._masterVolume;
  }

  getNoiseBuffer(kind = 'white') {
    if (!this.isUnlocked()) return null;
    this._ensureNoiseBuffers();
    return kind === 'pink' ? this._pinkNoiseBuffer : this._whiteNoiseBuffer;
  }

  getActiveVoiceCount() {
    this._pruneExpiredVoices();
    return this._voices.length;
  }

  /**
   * Allocates a stereo-panned voice connected to masterGain while strictly
   * enforcing VOICE_POOL_LIMIT by stealing the oldest lowest-priority voice.
   */
  acquireVoice(pan = 0, priority = 1, durationSec = 0.25) {
    if (!this.isUnlocked() || this._muted || !this._masterGain) {
      return null;
    }

    const ctx = this._ctx;
    const now = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
    this._pruneExpiredVoices(now);

    while (this._voices.length >= this._voiceLimit) {
      this._stealOldestLowestPriorityVoice();
    }

    const clampedPan = Number.isFinite(pan) ? clamp(pan, -0.85, 0.85) : 0;
    const safePriority = Number.isFinite(priority) ? priority : 1;
    const safeDuration = Number.isFinite(durationSec) ? clamp(durationSec, 0.02, 10.0) : 0.25;
    const endTime = now + safeDuration;

    let outNode = null;
    if (typeof ctx.createStereoPanner === 'function') {
      outNode = ctx.createStereoPanner();
      setParamImmediate(outNode.pan, clampedPan, now);
    } else {
      outNode = ctx.createGain();
    }
    outNode.connect(this._masterGain);

    const trackedNodes = [];
    const voice = {
      id: this._nextVoiceSeq++,
      priority: safePriority,
      startTime: now,
      endTime,
      outNode,
      released: false,
      timerId: null,
      track(node) {
        if (node) trackedNodes.push(node);
        return node;
      },
      release: null,
    };

    const release = (fromSteal = false) => {
      if (voice.released) return;
      voice.released = true;

      if (voice.timerId !== null) {
        clearTimeout(voice.timerId);
        voice.timerId = null;
      }

      const idx = this._voices.indexOf(voice);
      if (idx !== -1) {
        this._voices.splice(idx, 1);
      }

      for (let i = trackedNodes.length - 1; i >= 0; i -= 1) {
        const node = trackedNodes[i];
        if (fromSteal && typeof node.stop === 'function') {
          try {
            node.stop();
          } catch {
            // Node already stopped or not stoppable.
          }
        }
        if (typeof node.disconnect === 'function') {
          try {
            node.disconnect();
          } catch {
            // Already disconnected.
          }
        }
      }
      trackedNodes.length = 0;

      if (typeof outNode.disconnect === 'function') {
        try {
          outNode.disconnect();
        } catch {
          // Already disconnected.
        }
      }
    };

    voice.release = () => release(false);
    voice._steal = () => release(true);

    if (typeof setTimeout === 'function') {
      const delayMs = Math.ceil(safeDuration * 1000) + 40;
      voice.timerId = setTimeout(() => release(false), delayMs);
      if (voice.timerId && typeof voice.timerId.unref === 'function') {
        voice.timerId.unref();
      }
    }

    this._voices.push(voice);

    return {
      ctx,
      outNode,
      endTime,
      release: voice.release,
      track: voice.track,
    };
  }

  _syncMasterGain() {
    if (!this._masterGain || !this._ctx) return;
    const now = Number.isFinite(this._ctx.currentTime) ? this._ctx.currentTime : 0;
    const target = this._muted ? 0 : this._masterVolume;
    setParamImmediate(this._masterGain.gain, target, now);
  }

  _pruneExpiredVoices(nowOverride = null) {
    if (!this._ctx || this._voices.length === 0) return;
    const now =
      nowOverride !== null
        ? nowOverride
        : Number.isFinite(this._ctx.currentTime)
          ? this._ctx.currentTime
          : 0;

    for (let i = this._voices.length - 1; i >= 0; i -= 1) {
      const voice = this._voices[i];
      if (voice.released || voice.endTime <= now) {
        voice.release();
      }
    }
  }

  _stealOldestLowestPriorityVoice() {
    if (this._voices.length === 0) return;
    let victim = this._voices[0];
    for (let i = 1; i < this._voices.length; i += 1) {
      const candidate = this._voices[i];
      if (
        candidate.priority < victim.priority ||
        (candidate.priority === victim.priority &&
          (candidate.startTime < victim.startTime ||
            (candidate.startTime === victim.startTime && candidate.id < victim.id)))
      ) {
        victim = candidate;
      }
    }
    victim._steal();
  }

  _releaseAllVoices() {
    while (this._voices.length > 0) {
      this._voices[this._voices.length - 1]._steal();
    }
  }

  _ensureNoiseBuffers() {
    if (!this._ctx || typeof this._ctx.createBuffer !== 'function') return;
    if (this._whiteNoiseBuffer && this._pinkNoiseBuffer) return;

    const sampleRate = clamp(this._ctx.sampleRate || 44100, 8000, 192000);
    const length = Math.floor(sampleRate * 1.5);

    try {
      const white = this._ctx.createBuffer(1, length, sampleRate);
      const pink = this._ctx.createBuffer(1, length, sampleRate);

      let seed = 0x6d2b79f5;
      const nextRand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return (seed / 0xffffffff) * 2 - 1;
      };

      if (white && typeof white.getChannelData === 'function') {
        const wData = white.getChannelData(0);
        for (let i = 0; i < length; i += 1) {
          wData[i] = nextRand();
        }
      }

      if (pink && typeof pink.getChannelData === 'function') {
        const pData = pink.getChannelData(0);
        let b0 = 0;
        let b1 = 0;
        let b2 = 0;
        let b3 = 0;
        let b4 = 0;
        let b5 = 0;
        let b6 = 0;
        for (let i = 0; i < length; i += 1) {
          const w = nextRand();
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          const raw = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
          b6 = w * 0.115926;
          pData[i] = clamp(raw * 0.14, -0.98, 0.98);
        }
      }

      this._whiteNoiseBuffer = white;
      this._pinkNoiseBuffer = pink;
    } catch {
      // Ignore buffer synthesis failure on minimal mocks.
    }
  }
}
