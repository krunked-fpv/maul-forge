let variationCounter = 0;

function nextJitter(spread = 0.03) {
  variationCounter = (variationCounter + 1) & 0xff;
  const norm = ((variationCounter * 73) % 29) / 28; // deterministic 0..1 cycle
  return 1 + (norm * 2 - 1) * spread;
}

function trackNode(voice, node) {
  if (voice && typeof voice.track === 'function' && node) {
    voice.track(node);
  }
  return node;
}

function setParamValue(param, val, time) {
  if (!param || typeof param !== 'object') return;
  if (typeof param.setValueAtTime === 'function') {
    param.setValueAtTime(val, time);
  } else if ('value' in param) {
    param.value = val;
  }
}

function scheduleSweep(param, startVal, endVal, t0, t1, exponential = true) {
  if (!param || typeof param !== 'object') return;
  const safeStart = exponential ? Math.max(0.0001, startVal) : startVal;
  const safeEnd = exponential ? Math.max(0.0001, endVal) : endVal;
  setParamValue(param, safeStart, t0);
  if (t1 <= t0 || safeStart === safeEnd) return;
  if (exponential && typeof param.exponentialRampToValueAtTime === 'function') {
    param.exponentialRampToValueAtTime(safeEnd, t1);
  } else if (typeof param.linearRampToValueAtTime === 'function') {
    param.linearRampToValueAtTime(safeEnd, t1);
  }
}

function scheduleEnvelope(gainParam, t0, attack, hold, release, peakGain, sustainLevel = 0) {
  if (!gainParam || typeof gainParam !== 'object') return t0 + attack + hold + release;
  const floor = 0.0001;
  const peak = Math.max(floor, peakGain);
  const tAtk = t0 + Math.max(0.002, attack);
  const tHold = tAtk + Math.max(0, hold);
  const tEnd = tHold + Math.max(0.008, release);

  setParamValue(gainParam, floor, t0);
  if (typeof gainParam.linearRampToValueAtTime === 'function') {
    gainParam.linearRampToValueAtTime(peak, tAtk);
    if (hold > 0) {
      const holdGain = sustainLevel > 0 ? Math.max(floor, peak * sustainLevel) : peak;
      gainParam.linearRampToValueAtTime(holdGain, tHold);
    }
  }
  if (typeof gainParam.exponentialRampToValueAtTime === 'function') {
    gainParam.exponentialRampToValueAtTime(floor, tEnd);
  } else if (typeof gainParam.linearRampToValueAtTime === 'function') {
    gainParam.linearRampToValueAtTime(0, tEnd);
  }
  return tEnd;
}

function createFilter(ctx, voice, opts, t0, tEnd) {
  if (!opts || typeof ctx.createBiquadFilter !== 'function') return null;
  const filter = trackNode(voice, ctx.createBiquadFilter());
  if ('type' in filter) filter.type = opts.type || 'lowpass';
  if (filter.frequency) {
    const f0 = opts.freqStart ?? opts.freq ?? 1000;
    const f1 = opts.freqEnd ?? f0;
    scheduleSweep(filter.frequency, f0, f1, t0, opts.sweepEnd ?? tEnd, true);
  }
  if (filter.Q && opts.q !== undefined) {
    setParamValue(filter.Q, opts.q, t0);
  }
  return filter;
}

function connectChain(nodes) {
  for (let i = 0; i < nodes.length - 1; i += 1) {
    if (nodes[i] && nodes[i + 1] && typeof nodes[i].connect === 'function') {
      nodes[i].connect(nodes[i + 1]);
    }
  }
}

function spawnTone(voice, opts) {
  const { ctx, outNode } = voice;
  if (typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') return;

  const baseNow = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
  const t0 = baseNow + (opts.offset || 0);
  const attack = opts.attack ?? 0.004;
  const hold = opts.hold ?? 0;
  const release = opts.release ?? 0.14;

  const osc = trackNode(voice, ctx.createOscillator());
  osc.type = opts.wave || 'sine';

  const envGain = trackNode(voice, ctx.createGain());
  const tEnd = scheduleEnvelope(
    envGain.gain,
    t0,
    attack,
    hold,
    release,
    opts.gain ?? 0.28,
    opts.sustain ?? 0
  );

  const fStart = opts.freqStart ?? opts.freq ?? 440;
  const fEnd = opts.freqEnd ?? fStart;
  scheduleSweep(osc.frequency, fStart, fEnd, t0, opts.pitchEnd ?? tEnd, opts.expPitch !== false);

  if (opts.fmFreq && opts.fmDepth) {
    const mod = trackNode(voice, ctx.createOscillator());
    const modGain = trackNode(voice, ctx.createGain());
    mod.type = opts.fmWave || 'sine';
    scheduleSweep(mod.frequency, opts.fmFreq, opts.fmFreqEnd ?? opts.fmFreq, t0, tEnd, true);
    scheduleSweep(
      modGain.gain,
      opts.fmDepth,
      Math.max(0.001, opts.fmDepthEnd ?? opts.fmDepth * 0.15),
      t0,
      tEnd,
      true
    );
    connectChain([mod, modGain, osc.frequency]);
    mod.start(t0);
    mod.stop(tEnd + 0.01);
  }

  const filter = createFilter(ctx, voice, opts.filter, t0, tEnd);
  if (filter) {
    connectChain([osc, filter, envGain, outNode]);
  } else {
    connectChain([osc, envGain, outNode]);
  }

  osc.start(t0);
  osc.stop(tEnd + 0.01);
}

function spawnNoise(dsp, voice, opts) {
  const { ctx, outNode } = voice;
  const buffer = typeof dsp.getNoiseBuffer === 'function' ? dsp.getNoiseBuffer(opts.kind || 'white') : null;
  if (!buffer || typeof ctx.createBufferSource !== 'function' || typeof ctx.createGain !== 'function') {
    return;
  }

  const baseNow = Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0;
  const t0 = baseNow + (opts.offset || 0);
  const attack = opts.attack ?? 0.003;
  const hold = opts.hold ?? 0;
  const release = opts.release ?? 0.12;

  const src = trackNode(voice, ctx.createBufferSource());
  src.buffer = buffer;
  if ('playbackRate' in src && opts.rate) {
    setParamValue(src.playbackRate, opts.rate, t0);
  }

  const envGain = trackNode(voice, ctx.createGain());
  const tEnd = scheduleEnvelope(
    envGain.gain,
    t0,
    attack,
    hold,
    release,
    opts.gain ?? 0.2,
    opts.sustain ?? 0
  );

  const filter = createFilter(ctx, voice, opts.filter, t0, tEnd);
  if (filter) {
    connectChain([src, filter, envGain, outNode]);
  } else {
    connectChain([src, envGain, outNode]);
  }

  const bufferDur = Number.isFinite(buffer.duration) ? buffer.duration : 1.0;
  const bufOffset = Math.min(Math.max(0, opts.bufOffset || 0), Math.max(0, bufferDur - 0.1));
  src.start(t0, bufOffset);
  src.stop(tEnd + 0.01);
}

/**
 * 16 procedural Web Audio foley & synth patches (zero external audio assets).
 * Every patch returns the acquired voice handle, or null if muted/un-unlocked.
 */
export const FoleyPatches = Object.freeze({
  buildPlace(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 4, 0.26);
    if (!voice) return null;
    const j = nextJitter(0.04);

    // Granite sub impact + hollow stone resonance + gravel transient
    spawnTone(voice, {
      wave: 'triangle',
      freqStart: 150 * j,
      freqEnd: 46 * j,
      attack: 0.003,
      release: 0.15,
      gain: 0.44,
    });
    spawnTone(voice, {
      wave: 'sine',
      freqStart: 225 * j,
      freqEnd: 90 * j,
      attack: 0.004,
      release: 0.18,
      gain: 0.26,
      filter: { type: 'lowpass', freqStart: 520, freqEnd: 190, q: 2.0 },
    });
    spawnNoise(dsp, voice, {
      kind: 'pink',
      attack: 0.002,
      release: 0.11,
      gain: 0.24,
      filter: { type: 'bandpass', freqStart: 580, freqEnd: 220, q: 1.8 },
    });
    return voice;
  },

  buildComplete(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 6, 0.56);
    if (!voice) return null;
    const j = nextJitter(0.02);

    // Golden anvil metallic partial + bright rising fifth chime
    spawnTone(voice, {
      wave: 'sine',
      freqStart: 940 * j,
      freqEnd: 932 * j,
      fmFreq: 1380 * j,
      fmDepth: 540,
      fmDepthEnd: 45,
      attack: 0.002,
      release: 0.23,
      gain: 0.24,
    });
    spawnTone(voice, {
      wave: 'triangle',
      freqStart: 587.33 * j,
      attack: 0.006,
      hold: 0.04,
      release: 0.34,
      gain: 0.22,
      filter: { type: 'lowpass', freqStart: 3200, freqEnd: 1400 },
    });
    spawnTone(voice, {
      offset: 0.07,
      wave: 'sine',
      freqStart: 880 * j,
      fmFreq: 1760 * j,
      fmDepth: 190,
      fmDepthEnd: 20,
      attack: 0.005,
      hold: 0.05,
      release: 0.38,
      gain: 0.25,
    });
    spawnNoise(dsp, voice, {
      kind: 'white',
      attack: 0.002,
      release: 0.032,
      gain: 0.14,
      filter: { type: 'highpass', freq: 2600, q: 1.2 },
    });
    return voice;
  },

  upgradeAnvil(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 5, 0.38);
    if (!voice) return null;
    const j = nextJitter(0.03);

    // Crisp double-clink anvil strike
    spawnTone(voice, {
      wave: 'sine',
      freqStart: 1046.5 * j,
      fmFreq: 1569.7 * j,
      fmDepth: 480,
      fmDepthEnd: 35,
      attack: 0.002,
      release: 0.16,
      gain: 0.24,
    });
    spawnTone(voice, {
      offset: 0.095,
      wave: 'sine',
      freqStart: 1318.5 * j,
      fmFreq: 1977.8 * j,
      fmDepth: 560,
      fmDepthEnd: 40,
      attack: 0.002,
      release: 0.22,
      gain: 0.26,
    });
    spawnNoise(dsp, voice, {
      offset: 0.095,
      kind: 'white',
      attack: 0.002,
      release: 0.03,
      gain: 0.12,
      filter: { type: 'highpass', freq: 3400, q: 1.4 },
    });
    return voice;
  },

  fusionChord(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 8, 0.8);
    if (!voice) return null;

    // Crystalline major-9th triad chord swell
    const freqs = [587.33, 739.99, 880.0, 1318.51];
    for (let i = 0; i < freqs.length; i += 1) {
      spawnTone(voice, {
        offset: i * 0.02,
        wave: i % 2 === 0 ? 'triangle' : 'sine',
        freqStart: freqs[i] * 0.996,
        freqEnd: freqs[i] * 1.003,
        attack: 0.085,
        hold: 0.14,
        release: 0.48,
        sustain: 0.72,
        gain: 0.14,
        filter: { type: 'bandpass', freqStart: 1100, freqEnd: 3400, q: 0.9 },
      });
    }
    spawnNoise(dsp, voice, {
      kind: 'pink',
      attack: 0.09,
      hold: 0.12,
      release: 0.42,
      gain: 0.11,
      filter: { type: 'highpass', freqStart: 3200, freqEnd: 5400, q: 1.5 },
    });
    return voice;
  },

  sellCoins(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 4, 0.32);
    if (!voice) return null;
    const j = nextJitter(0.025);
    const notes = [2637.0, 2093.0, 1567.98];

    for (let i = 0; i < notes.length; i += 1) {
      spawnTone(voice, {
        offset: i * 0.055,
        wave: 'sine',
        freqStart: notes[i] * j,
        fmFreq: notes[i] * 1.414 * j,
        fmDepth: 320,
        fmDepthEnd: 25,
        attack: 0.002,
        release: 0.13,
        gain: 0.17,
      });
    }
    return voice;
  },

  invalidBlock(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 5, 0.25);
    if (!voice) return null;

    // Muffled low brass dissonant buzz
    spawnTone(voice, {
      wave: 'sawtooth',
      freqStart: 116.5,
      freqEnd: 92.5,
      attack: 0.008,
      hold: 0.06,
      release: 0.14,
      sustain: 0.65,
      gain: 0.22,
      filter: { type: 'lowpass', freqStart: 420, freqEnd: 200, q: 2.8 },
    });
    spawnTone(voice, {
      wave: 'sawtooth',
      freqStart: 123.5,
      freqEnd: 98.0,
      attack: 0.008,
      hold: 0.06,
      release: 0.14,
      sustain: 0.65,
      gain: 0.18,
      filter: { type: 'lowpass', freqStart: 390, freqEnd: 185, q: 2.8 },
    });
    return voice;
  },

  fireBallista(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 2, 0.17);
    if (!voice) return null;
    const j = nextJitter(0.05);

    // Taut bowstring torsion twang + high latch tick
    spawnTone(voice, {
      wave: 'triangle',
      freqStart: 350 * j,
      freqEnd: 132 * j,
      fmFreq: 700 * j,
      fmDepth: 160,
      fmDepthEnd: 12,
      attack: 0.002,
      release: 0.095,
      gain: 0.26,
      filter: { type: 'bandpass', freqStart: 920, freqEnd: 380, q: 1.5 },
    });
    spawnNoise(dsp, voice, {
      kind: 'white',
      attack: 0.002,
      release: 0.036,
      gain: 0.19,
      filter: { type: 'bandpass', freqStart: 3600, freqEnd: 2100, q: 2.2 },
    });
    return voice;
  },

  fireMortar(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 3, 0.35);
    if (!voice) return null;
    const j = nextJitter(0.04);

    // Sub-bass cannon punch + low-passed blackpowder pop
    spawnTone(voice, {
      wave: 'sine',
      freqStart: 148 * j,
      freqEnd: 36 * j,
      attack: 0.003,
      release: 0.2,
      gain: 0.48,
    });
    spawnTone(voice, {
      wave: 'triangle',
      freqStart: 220 * j,
      freqEnd: 68 * j,
      attack: 0.003,
      release: 0.09,
      gain: 0.22,
    });
    spawnNoise(dsp, voice, {
      kind: 'pink',
      attack: 0.003,
      release: 0.24,
      gain: 0.34,
      filter: { type: 'lowpass', freqStart: 980, freqEnd: 150, q: 2.4 },
    });
    return voice;
  },

  fireFrost(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 2, 0.29);
    if (!voice) return null;
    const j = nextJitter(0.035);

    // Crystalline chime shimmer + cold air hiss
    spawnTone(voice, {
      wave: 'sine',
      freqStart: 1760 * j,
      freqEnd: 1795 * j,
      attack: 0.006,
      release: 0.22,
      gain: 0.16,
    });
    spawnTone(voice, {
      offset: 0.012,
      wave: 'sine',
      freqStart: 2637 * j,
      freqEnd: 2610 * j,
      attack: 0.006,
      release: 0.21,
      gain: 0.12,
    });
    spawnNoise(dsp, voice, {
      kind: 'white',
      attack: 0.008,
      release: 0.19,
      gain: 0.13,
      filter: { type: 'bandpass', freqStart: 5000, freqEnd: 7400, q: 4.0 },
    });
    return voice;
  },

  shatterIce(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 5, 0.44);
    if (!voice) return null;
    const j = nextJitter(0.04);

    // High-glass crystalline burst + crackling noise + frozen body thud
    spawnTone(voice, {
      wave: 'sine',
      freqStart: 2960 * j,
      freqEnd: 2150 * j,
      fmFreq: 4440 * j,
      fmDepth: 620,
      fmDepthEnd: 40,
      attack: 0.002,
      release: 0.2,
      gain: 0.22,
    });
    spawnTone(voice, {
      offset: 0.025,
      wave: 'sine',
      freqStart: 4186 * j,
      freqEnd: 3320 * j,
      attack: 0.002,
      release: 0.22,
      gain: 0.16,
    });
    spawnTone(voice, {
      wave: 'triangle',
      freqStart: 195 * j,
      freqEnd: 65 * j,
      attack: 0.002,
      release: 0.12,
      gain: 0.24,
    });
    spawnNoise(dsp, voice, {
      kind: 'white',
      attack: 0.002,
      release: 0.16,
      gain: 0.26,
      filter: { type: 'highpass', freqStart: 2800, freqEnd: 4400, q: 1.5 },
    });
    spawnNoise(dsp, voice, {
      offset: 0.045,
      kind: 'white',
      attack: 0.002,
      release: 0.24,
      gain: 0.2,
      filter: { type: 'bandpass', freqStart: 5200, freqEnd: 3200, q: 3.2 },
    });
    return voice;
  },

  chainLightning(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 4, 0.38);
    if (!voice) return null;
    const j = nextJitter(0.05);

    // Bandpass crackle snap + pitch-drop thunder rumble
    spawnTone(voice, {
      wave: 'sawtooth',
      freqStart: 1900 * j,
      freqEnd: 410 * j,
      fmFreq: 380 * j,
      fmDepth: 950,
      fmDepthEnd: 90,
      attack: 0.002,
      release: 0.085,
      gain: 0.21,
      filter: { type: 'bandpass', freqStart: 2800, freqEnd: 1100, q: 2.0 },
    });
    spawnNoise(dsp, voice, {
      kind: 'white',
      attack: 0.002,
      release: 0.09,
      gain: 0.28,
      filter: { type: 'bandpass', freqStart: 4200, freqEnd: 1500, q: 3.2 },
    });
    spawnTone(voice, {
      offset: 0.015,
      wave: 'triangle',
      freqStart: 130 * j,
      freqEnd: 44 * j,
      attack: 0.006,
      release: 0.26,
      gain: 0.28,
    });
    spawnNoise(dsp, voice, {
      offset: 0.02,
      kind: 'pink',
      attack: 0.01,
      release: 0.3,
      gain: 0.22,
      filter: { type: 'lowpass', freqStart: 640, freqEnd: 120, q: 1.4 },
    });
    return voice;
  },

  acidSizzle(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 2, 0.32);
    if (!voice) return null;
    const j = nextJitter(0.05);

    // Resonant sweeping bubble hiss + reactive chemical pops
    spawnNoise(dsp, voice, {
      kind: 'white',
      attack: 0.01,
      hold: 0.04,
      release: 0.22,
      sustain: 0.55,
      gain: 0.21,
      filter: { type: 'bandpass', freqStart: 1450, freqEnd: 4300, q: 5.5 },
    });
    spawnTone(voice, {
      offset: 0.018,
      wave: 'sine',
      freqStart: 430 * j,
      freqEnd: 990 * j,
      attack: 0.004,
      release: 0.065,
      gain: 0.11,
    });
    spawnTone(voice, {
      offset: 0.085,
      wave: 'sine',
      freqStart: 620 * j,
      freqEnd: 1340 * j,
      attack: 0.004,
      release: 0.075,
      gain: 0.1,
    });
    return voice;
  },

  flameRoar(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 3, 0.36);
    if (!voice) return null;
    const j = nextJitter(0.04);

    // Warm bandpass combustive whoosh + furnace flame rumble
    spawnNoise(dsp, voice, {
      kind: 'pink',
      attack: 0.04,
      hold: 0.05,
      release: 0.24,
      sustain: 0.6,
      gain: 0.31,
      filter: { type: 'bandpass', freqStart: 320, freqEnd: 1120, q: 1.5 },
    });
    spawnTone(voice, {
      wave: 'sawtooth',
      freqStart: 94 * j,
      freqEnd: 62 * j,
      attack: 0.025,
      hold: 0.05,
      release: 0.21,
      gain: 0.15,
      filter: { type: 'lowpass', freqStart: 270, freqEnd: 150, q: 1.8 },
    });
    return voice;
  },

  creepBounty(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 2, 0.22);
    if (!voice) return null;
    const j = nextJitter(0.03);

    // Crisp metallic coin glint
    spawnTone(voice, {
      wave: 'sine',
      freqStart: 1975.5 * j,
      fmFreq: 2960.0 * j,
      fmDepth: 280,
      fmDepthEnd: 20,
      attack: 0.002,
      release: 0.11,
      gain: 0.15,
    });
    spawnTone(voice, {
      offset: 0.042,
      wave: 'sine',
      freqStart: 2959.96 * j,
      attack: 0.002,
      release: 0.14,
      gain: 0.14,
    });
    return voice;
  },

  waveHorn(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 8, 0.86);
    if (!voice) return null;

    // Deep warhorn fifth swell (G2 + D3 + sub G1)
    spawnTone(voice, {
      wave: 'sawtooth',
      freqStart: 97.5,
      freqEnd: 98.5,
      attack: 0.14,
      hold: 0.24,
      release: 0.42,
      sustain: 0.82,
      gain: 0.22,
      filter: { type: 'lowpass', freqStart: 220, freqEnd: 1200, q: 2.2 },
    });
    spawnTone(voice, {
      offset: 0.03,
      wave: 'sawtooth',
      freqStart: 146.5,
      freqEnd: 147.2,
      attack: 0.16,
      hold: 0.22,
      release: 0.4,
      sustain: 0.78,
      gain: 0.16,
      filter: { type: 'lowpass', freqStart: 260, freqEnd: 1350, q: 2.0 },
    });
    spawnTone(voice, {
      wave: 'triangle',
      freqStart: 49.0,
      attack: 0.1,
      hold: 0.26,
      release: 0.42,
      sustain: 0.85,
      gain: 0.24,
    });
    spawnNoise(dsp, voice, {
      kind: 'pink',
      attack: 0.12,
      hold: 0.16,
      release: 0.35,
      gain: 0.09,
      filter: { type: 'bandpass', freqStart: 420, freqEnd: 680, q: 1.8 },
    });
    return voice;
  },

  nexusLeak(dsp, pan = 0) {
    const voice = dsp?.acquireVoice?.(pan, 10, 0.7);
    if (!voice) return null;

    // Ominous descending warning brass blast
    spawnTone(voice, {
      wave: 'sawtooth',
      freqStart: 233.08,
      freqEnd: 138.59,
      attack: 0.012,
      hold: 0.16,
      release: 0.46,
      sustain: 0.75,
      gain: 0.26,
      filter: { type: 'lowpass', freqStart: 1700, freqEnd: 340, q: 3.0 },
    });
    spawnTone(voice, {
      wave: 'sawtooth',
      freqStart: 116.54,
      freqEnd: 69.3,
      attack: 0.012,
      hold: 0.18,
      release: 0.45,
      sustain: 0.78,
      gain: 0.28,
      filter: { type: 'lowpass', freqStart: 1200, freqEnd: 240, q: 2.6 },
    });
    spawnTone(voice, {
      wave: 'triangle',
      freqStart: 112.0,
      freqEnd: 38.0,
      attack: 0.004,
      release: 0.24,
      gain: 0.32,
    });
    return voice;
  },
});
