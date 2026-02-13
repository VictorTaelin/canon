(() => {
  if (typeof SCORE_DATA === "undefined") {
    throw new Error("Missing SCORE_DATA. Ensure score-data.js is loaded first.");
  }

  const NOTES = SCORE_DATA.notes
    .map(([t, d, m, s]) => ({ t, d, m, s }))
    .sort((a, b) => a.t - b.t || a.s - b.s || a.m - b.m || a.d - b.d);
  const TOTAL_BEATS = SCORE_DATA.totalBeats;
  const BASE_TEMPO = Math.round(SCORE_DATA.tempo || 100);
  const MIN_MIDI = SCORE_DATA.midiRange[0];
  const MAX_MIDI = SCORE_DATA.midiRange[1];

  const KEYBOARD_WIDTH = 0;
  const BEAT_WIDTH = 20;
  const ROW_HEIGHT = 14;
  const VOICE_COLORS = {
    1: { fill: "#bcded7", stroke: "#89b4ad" },
    2: { fill: "#d2d5ee", stroke: "#9ba1c8" },
    3: { fill: "#ebe3c5", stroke: "#baa97a" },
  };

  const LOOKAHEAD_SECONDS = 0.5;
  const SCHEDULER_MS = 20;
  const RESUME_OFFSET_SECONDS = 0.05;
  const MAX_SUSTAIN_BEATS = 4;
  const EPSILON_GAIN = 0.00001;

  const playPauseBtn = document.getElementById("playPauseBtn");
  const tempoRange = document.getElementById("tempoRange");
  const tempoOut = document.getElementById("tempoOut");
  const statusText = document.getElementById("statusText");
  const pianoLabels = document.getElementById("pianoLabels");
  const labelsCanvas = document.getElementById("labelsCanvas");
  const rollViewport = document.getElementById("rollViewport");
  const rollContent = document.getElementById("rollContent");
  const rollCanvas = document.getElementById("rollCanvas");
  const playhead = document.getElementById("playhead");
  const ctx2d = rollCanvas.getContext("2d", { alpha: false });
  const labelsCtx = labelsCanvas.getContext("2d", { alpha: false });

  const state = {
    tempo: BASE_TEMPO,
    isPlaying: false,
    loop: true,
    currentBeat: 0,
    startBeat: 0,
    startCtxTime: 0,
    nextIndex: 0,
    schedulerId: null,
    vibratoAmount: 1,
    volume: 58,
  };

  let audioCtx = null;
  let masterGain = null;
  let effectInput = null;
  let leadInPadding = 0;
  let tailPadding = 0;
  let rowHeight = ROW_HEIGHT;
  const activeVoices = new Set();

  function midiToHz(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function midiToLabel(midi) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const name = names[midi % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}`;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function beatToSeconds(beat) {
    return (beat * 60) / state.tempo;
  }

  function formatClock(beats) {
    const totalSeconds = Math.floor(beatToSeconds(beats));
    const min = Math.floor(totalSeconds / 60);
    const sec = totalSeconds % 60;
    return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function formatBarBeat(beat) {
    const bar = Math.floor(beat / 4) + 1;
    const beatInBar = (beat % 4) + 1;
    return `Bar ${bar}, Beat ${beatInBar.toFixed(2)}`;
  }

  function getCurrentBeatAt(time) {
    return clamp(state.startBeat + ((time - state.startCtxTime) * state.tempo) / 60, 0, TOTAL_BEATS);
  }

  function getCurrentBeat() {
    if (!state.isPlaying || !audioCtx) {
      return state.currentBeat;
    }
    return getCurrentBeatAt(audioCtx.currentTime);
  }

  function timeForBeat(beat) {
    return state.startCtxTime + ((beat - state.startBeat) * 60) / state.tempo;
  }

  function binarySearchByStart(targetBeat) {
    let lo = 0;
    let hi = NOTES.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (NOTES[mid].t < targetBeat) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  function findStartIndex(beat) {
    return binarySearchByStart(Math.max(0, beat - MAX_SUSTAIN_BEATS));
  }

  function createImpulseResponse(context, seconds = 4.0, decay = 1.8) {
    const sampleRate = context.sampleRate;
    const length = Math.floor(sampleRate * seconds);
    const impulse = context.createBuffer(2, length, sampleRate);

    for (let c = 0; c < 2; c += 1) {
      const channel = impulse.getChannelData(c);
      for (let i = 0; i < length; i += 1) {
        const n = Math.random() * 2 - 1;
        const falloff = Math.pow(1 - i / length, decay);
        channel[i] = n * falloff;
      }
    }

    return impulse;
  }

  function ensureAudio() {
    if (audioCtx) {
      return;
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextCtor();

    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.volume / 100;

    const outputBus = audioCtx.createGain();
    outputBus.gain.value = 0.92;

    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -19;
    compressor.knee.value = 18;
    compressor.ratio.value = 2.2;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.18;

    const dryGain = audioCtx.createGain();
    dryGain.gain.value = 0.64;

    const reverbInputHp = audioCtx.createBiquadFilter();
    reverbInputHp.type = "highpass";
    reverbInputHp.frequency.value = 170;
    reverbInputHp.Q.value = 0.6;

    const reverbInputLp = audioCtx.createBiquadFilter();
    reverbInputLp.type = "lowpass";
    reverbInputLp.frequency.value = 5900;
    reverbInputLp.Q.value = 0.65;

    const convolver = audioCtx.createConvolver();
    convolver.buffer = createImpulseResponse(audioCtx, 3.6, 2.15);
    const reverbGain = audioCtx.createGain();
    reverbGain.gain.value = 0.34;

    const chorusDelayLeft = audioCtx.createDelay(0.08);
    const chorusDelayRight = audioCtx.createDelay(0.08);
    chorusDelayLeft.delayTime.value = 0.018;
    chorusDelayRight.delayTime.value = 0.026;

    const chorusLfoLeft = audioCtx.createOscillator();
    const chorusLfoRight = audioCtx.createOscillator();
    chorusLfoLeft.type = "sine";
    chorusLfoRight.type = "sine";
    chorusLfoLeft.frequency.value = 0.19;
    chorusLfoRight.frequency.value = 0.27;

    const chorusDepthLeft = audioCtx.createGain();
    const chorusDepthRight = audioCtx.createGain();
    chorusDepthLeft.gain.value = 0.0038;
    chorusDepthRight.gain.value = 0.0046;

    const chorusPanLeft = audioCtx.createStereoPanner();
    const chorusPanRight = audioCtx.createStereoPanner();
    chorusPanLeft.pan.value = -0.36;
    chorusPanRight.pan.value = 0.36;

    const chorusTone = audioCtx.createBiquadFilter();
    chorusTone.type = "lowpass";
    chorusTone.frequency.value = 5200;
    chorusTone.Q.value = 0.65;

    const chorusMix = audioCtx.createGain();
    chorusMix.gain.value = 0.2;

    masterGain.connect(dryGain);
    dryGain.connect(outputBus);

    masterGain.connect(reverbInputHp);
    reverbInputHp.connect(reverbInputLp);
    reverbInputLp.connect(convolver);
    convolver.connect(reverbGain);
    reverbGain.connect(outputBus);

    masterGain.connect(chorusDelayLeft);
    masterGain.connect(chorusDelayRight);
    chorusDelayLeft.connect(chorusPanLeft);
    chorusDelayRight.connect(chorusPanRight);
    chorusPanLeft.connect(chorusTone);
    chorusPanRight.connect(chorusTone);
    chorusTone.connect(chorusMix);
    chorusMix.connect(outputBus);

    chorusLfoLeft.connect(chorusDepthLeft);
    chorusDepthLeft.connect(chorusDelayLeft.delayTime);
    chorusLfoRight.connect(chorusDepthRight);
    chorusDepthRight.connect(chorusDelayRight.delayTime);

    outputBus.connect(compressor);
    compressor.connect(audioCtx.destination);

    const startupTime = audioCtx.currentTime + 0.01;
    chorusLfoLeft.start(startupTime);
    chorusLfoRight.start(startupTime);

    effectInput = masterGain;
  }

  function createWaveshaper(context) {
    const shaper = context.createWaveShaper();
    const samples = 1024;
    const curve = new Float32Array(samples);
    const norm = Math.tanh(1.35);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = Math.tanh(x * 1.35) / norm;
    }
    shaper.curve = curve;
    shaper.oversample = "4x";
    return shaper;
  }

  function cleanupVoice(voice) {
    if (voice.osc1) {
      voice.osc1.onended = null;
    }
    voice.nodes.forEach((node) => {
      try {
        node.disconnect();
      } catch (_) {
        // noop
      }
    });
    activeVoices.delete(voice);
  }

  function scheduleNote(note, startTime, durationBeatsOverride) {
    if (!audioCtx || !effectInput) {
      return;
    }

    const durationBeats = durationBeatsOverride || note.d;
    if (durationBeats <= 0) {
      return;
    }

    const now = audioCtx.currentTime;
    const safeStart = Math.max(startTime, now + 0.002);
    const durSec = Math.max(0.055, (durationBeats * 60) / state.tempo * 0.992);
    const isShort = durSec < 0.24;
    const noteEnd = safeStart + durSec;
    const attackTime = isShort
      ? clamp(durSec * 0.22, 0.01, 0.03)
      : clamp(durSec * 0.18, 0.022, 0.075);
    const releaseTime = isShort ? 0.08 : clamp(durSec * 0.38, 0.12, 0.34);
    const stopTime = noteEnd + Math.max(0.16, releaseTime * 2.5);
    const freq = midiToHz(note.m);

    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const osc3 = audioCtx.createOscillator();
    const osc1Gain = audioCtx.createGain();
    const osc2Gain = audioCtx.createGain();
    const osc3Gain = audioCtx.createGain();
    const shaper = createWaveshaper(audioCtx);
    const highpass = audioCtx.createBiquadFilter();
    const lowpass = audioCtx.createBiquadFilter();
    const presence = audioCtx.createBiquadFilter();
    const airTrim = audioCtx.createBiquadFilter();
    const gain = audioCtx.createGain();
    const vibLfo = audioCtx.createOscillator();
    const vibDepth = audioCtx.createGain();
    const vibEnv = audioCtx.createGain();
    const driftLfo = audioCtx.createOscillator();
    const driftDepth = audioCtx.createGain();
    const pan = typeof audioCtx.createStereoPanner === "function" ? audioCtx.createStereoPanner() : null;

    const voiceGain = note.s === 1 ? 0.155 : note.s === 2 ? 0.143 : 0.136;
    const lowBoost = clamp(1.0 + (63 - note.m) * 0.02, 0.9, 1.28);
    const baseGain = voiceGain * lowBoost;
    const sustainTarget = baseGain * (isShort ? 0.95 : 0.9);
    const sustainStart = Math.min(noteEnd, safeStart + attackTime);

    gain.gain.cancelScheduledValues(safeStart);
    gain.gain.setValueAtTime(EPSILON_GAIN, safeStart);
    gain.gain.linearRampToValueAtTime(baseGain, safeStart + attackTime);
    gain.gain.setTargetAtTime(sustainTarget, sustainStart, Math.max(0.04, durSec * 0.45));
    gain.gain.setTargetAtTime(EPSILON_GAIN, noteEnd, Math.max(0.03, releaseTime * 0.45));

    osc1.type = "sine";
    osc2.type = "sine";
    osc3.type = "triangle";

    const glideTime = Math.min(0.055, durSec * 0.32);
    osc1.frequency.setValueAtTime(freq * 0.995, safeStart);
    osc1.frequency.exponentialRampToValueAtTime(freq, safeStart + glideTime);
    osc2.frequency.setValueAtTime(freq * 1.003, safeStart);
    osc3.frequency.setValueAtTime(freq * 2.0, safeStart);

    osc1Gain.gain.setValueAtTime(0.9, safeStart);
    osc2Gain.gain.setValueAtTime(0.74, safeStart);
    const octaveLevel = isShort ? 0.026 : (note.m < 65 ? 0.042 : 0.03);
    osc3Gain.gain.setValueAtTime(octaveLevel, safeStart);

    vibLfo.type = "sine";
    vibLfo.frequency.setValueAtTime(5.05 + note.s * 0.15 + Math.random() * 0.22, safeStart);
    vibDepth.gain.setValueAtTime(freq * 0.0039 * state.vibratoAmount, safeStart);

    vibEnv.gain.setValueAtTime(isShort ? 0.3 : 0.0, safeStart);
    if (!isShort) {
      const vibDelay = clamp(durSec * 0.28, 0.08, 0.18);
      vibEnv.gain.setValueAtTime(0.0, safeStart + vibDelay * 0.45);
      vibEnv.gain.linearRampToValueAtTime(1.0, safeStart + vibDelay);
    }
    vibEnv.gain.setTargetAtTime(0.0, noteEnd, Math.max(0.025, releaseTime * 0.3));

    driftLfo.type = "sine";
    driftLfo.frequency.setValueAtTime(0.17 + note.s * 0.04 + Math.random() * 0.03, safeStart);
    driftDepth.gain.setValueAtTime(freq * 0.00075, safeStart);

    vibLfo.connect(vibDepth);
    vibDepth.connect(vibEnv);
    vibEnv.connect(osc1.frequency);
    vibEnv.connect(osc2.frequency);
    driftLfo.connect(driftDepth);
    driftDepth.connect(osc1.frequency);
    driftDepth.connect(osc2.frequency);

    highpass.type = "highpass";
    highpass.frequency.setValueAtTime(115, safeStart);
    highpass.Q.setValueAtTime(0.65, safeStart);

    lowpass.type = "lowpass";
    const lowMult = note.m < 65 ? 1.22 : 1.0;
    const baseCutoff = clamp(freq * 2.35 * lowMult, 1500, 4300);
    const peakCutoff = clamp(baseCutoff * 1.35, 1900, 5600);
    lowpass.frequency.setValueAtTime(baseCutoff, safeStart);
    lowpass.frequency.linearRampToValueAtTime(peakCutoff, safeStart + attackTime);
    lowpass.frequency.setTargetAtTime(baseCutoff, noteEnd, 0.16);
    lowpass.Q.setValueAtTime(0.78, safeStart);

    presence.type = "peaking";
    presence.frequency.setValueAtTime(1140, safeStart);
    presence.Q.setValueAtTime(1.1, safeStart);
    presence.gain.setValueAtTime(3.2, safeStart);

    airTrim.type = "peaking";
    airTrim.frequency.setValueAtTime(3200, safeStart);
    airTrim.Q.setValueAtTime(1.25, safeStart);
    airTrim.gain.setValueAtTime(-2.4, safeStart);

    if (pan) {
      pan.pan.setValueAtTime((note.s - 2) * 0.2, safeStart);
    }

    osc1.connect(osc1Gain);
    osc2.connect(osc2Gain);
    osc3.connect(osc3Gain);
    osc1Gain.connect(shaper);
    osc2Gain.connect(shaper);
    osc3Gain.connect(shaper);
    shaper.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(presence);
    presence.connect(airTrim);
    airTrim.connect(gain);
    if (pan) {
      gain.connect(pan);
      pan.connect(effectInput);
    } else {
      gain.connect(effectInput);
    }

    const voice = {
      osc1,
      nodes: [
        osc1,
        osc2,
        osc3,
        osc1Gain,
        osc2Gain,
        osc3Gain,
        shaper,
        highpass,
        lowpass,
        presence,
        airTrim,
        vibLfo,
        vibDepth,
        vibEnv,
        driftLfo,
        driftDepth,
        gain,
      ],
    };
    if (pan) {
      voice.nodes.push(pan);
    }
    activeVoices.add(voice);

    osc1.onended = () => cleanupVoice(voice);

    osc1.start(safeStart);
    osc2.start(safeStart);
    osc3.start(safeStart);
    vibLfo.start(safeStart);
    driftLfo.start(safeStart);

    osc1.stop(stopTime);
    osc2.stop(stopTime);
    osc3.stop(stopTime);
    vibLfo.stop(stopTime);
    driftLfo.stop(stopTime);
  }

  function stopAllVoices() {
    if (!audioCtx) {
      return;
    }

    const now = audioCtx.currentTime;
    activeVoices.forEach((voice) => {
      voice.nodes.forEach((node) => {
        try {
          if (node instanceof GainNode) {
            node.gain.cancelScheduledValues(now);
            const held = Math.max(EPSILON_GAIN, node.gain.value || EPSILON_GAIN);
            node.gain.setValueAtTime(held, now);
            node.gain.setTargetAtTime(EPSILON_GAIN, now, 0.03);
          }
          if (node instanceof OscillatorNode) {
            node.stop(now + 0.08);
          }
        } catch (_) {
          // noop
        }
      });
    });
  }

  function stopScheduler() {
    if (state.schedulerId !== null) {
      clearInterval(state.schedulerId);
      state.schedulerId = null;
    }
  }

  function schedulerTick() {
    if (!state.isPlaying || !audioCtx) {
      return;
    }

    const now = audioCtx.currentTime;
    const currentBeat = getCurrentBeatAt(now);
    const lookaheadBeats = currentBeat + (state.tempo * LOOKAHEAD_SECONDS) / 60;

    while (state.nextIndex < NOTES.length) {
      const note = NOTES[state.nextIndex];
      if (note.t > lookaheadBeats) {
        break;
      }

      const noteEnd = note.t + note.d;
      if (noteEnd > currentBeat - 0.001) {
        if (note.t >= currentBeat) {
          scheduleNote(note, timeForBeat(note.t));
        } else {
          scheduleNote(note, now + 0.01, noteEnd - currentBeat);
        }
      }

      state.nextIndex += 1;
    }

    if (currentBeat >= TOTAL_BEATS - 0.0001) {
      if (state.loop) {
        restartFromBeat(0, true);
      } else {
        stopPlayback();
      }
    }
  }

  function startScheduler() {
    stopScheduler();
    schedulerTick();
    state.schedulerId = setInterval(schedulerTick, SCHEDULER_MS);
  }

  function restartFromBeat(beat, keepPlaying) {
    if (!audioCtx) {
      return;
    }

    stopScheduler();
    stopAllVoices();

    const clamped = clamp(beat, 0, TOTAL_BEATS);
    state.currentBeat = clamped;
    state.startBeat = clamped;
    state.startCtxTime = audioCtx.currentTime + RESUME_OFFSET_SECONDS;
    state.nextIndex = findStartIndex(clamped);

    if (keepPlaying) {
      state.isPlaying = true;
      startScheduler();
    }
    followPlayhead(true);
  }

  async function play() {
    ensureAudio();
    if (!audioCtx) {
      return;
    }

    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    if (state.isPlaying) {
      return;
    }

    restartFromBeat(state.currentBeat, true);
    updatePlayPauseLabel();
  }

  function pause() {
    if (!state.isPlaying) {
      return;
    }

    state.currentBeat = getCurrentBeat();
    state.isPlaying = false;
    stopScheduler();
    stopAllVoices();
    updatePlayPauseLabel();
  }

  function stopPlayback() {
    pause();
    state.currentBeat = 0;
    updateSeekAndStatus();
    followPlayhead(true);
  }

  function setTempo(nextTempo) {
    const tempo = clamp(Number(nextTempo) || BASE_TEMPO, 40, 100);
    if (tempo === state.tempo) {
      return;
    }

    const wasPlaying = state.isPlaying;
    const beat = getCurrentBeat();
    state.tempo = tempo;

    if (wasPlaying && audioCtx) {
      restartFromBeat(beat, true);
    } else {
      state.currentBeat = beat;
    }

    tempoOut.value = String(tempo);
    updateSeekAndStatus();
  }

  function updatePlayPauseLabel() {
    playPauseBtn.textContent = state.isPlaying ? "⏸" : "▶";
    playPauseBtn.setAttribute("aria-label", state.isPlaying ? "Pause" : "Play");
  }

  function yForMidi(midi) {
    return (MAX_MIDI - midi) * rowHeight;
  }

  function refreshHorizontalPadding() {
    const center = (rollViewport.clientWidth || 0) * 0.5;
    leadInPadding = Math.max(0, center - KEYBOARD_WIDTH);
    tailPadding = center;
  }

  function xForBeat(beat) {
    return leadInPadding + KEYBOARD_WIDTH + beat * BEAT_WIDTH;
  }

  function setupCanvas(canvas, context, cssWidth, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssWidth));
    const h = Math.max(1, Math.round(cssHeight));
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function syncLabelScroll() {
    const offsetY = -Math.round(rollViewport.scrollTop || 0);
    labelsCanvas.style.transform = `translate3d(0, ${offsetY}px, 0)`;
  }

  function updatePlayheadPosition() {
    const labelWidth = pianoLabels.clientWidth || 0;
    const viewportCenter = (rollViewport.clientWidth || 0) * 0.5;
    playhead.style.left = `${labelWidth + viewportCenter}px`;
  }

  function drawLabels(height) {
    const width = pianoLabels.clientWidth || 66;
    const size = setupCanvas(labelsCanvas, labelsCtx, width, height);
    const canvasWidth = size.w;
    labelsCtx.fillStyle = "#f7f2e4";
    labelsCtx.fillRect(0, 0, canvasWidth, height);
    labelsCtx.textAlign = "center";
    labelsCtx.textBaseline = "middle";
    const labelFontSize = Math.max(8, Math.min(11, Math.floor(rowHeight * 0.72)));
    labelsCtx.font = `bold ${labelFontSize}px Menlo, monospace`;

    for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi += 1) {
      const y = yForMidi(midi);
      const note = midi % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(note);
      labelsCtx.fillStyle = isBlack ? "#f0e9d8" : "#f7f2e4";
      labelsCtx.fillRect(0, y, canvasWidth, rowHeight);
      labelsCtx.strokeStyle = "#e2d9be";
      labelsCtx.beginPath();
      labelsCtx.moveTo(0, y + 0.5);
      labelsCtx.lineTo(canvasWidth, y + 0.5);
      labelsCtx.stroke();

      labelsCtx.fillStyle = "#586e75";
      labelsCtx.fillText(midiToLabel(midi), canvasWidth * 0.5, y + rowHeight * 0.5 + 1);
    }
  }

  function drawRoll() {
    refreshHorizontalPadding();
    const noteCount = MAX_MIDI - MIN_MIDI + 1;
    rowHeight = Math.max(12, Math.floor((rollViewport.clientHeight || 0) / noteCount));
    const scoreWidth = Math.ceil(leadInPadding + KEYBOARD_WIDTH + TOTAL_BEATS * BEAT_WIDTH + tailPadding);
    const width = Math.max(scoreWidth, rollViewport.clientWidth || 0);
    const height = Math.ceil(noteCount * rowHeight);

    setupCanvas(rollCanvas, ctx2d, width, height);
    rollContent.style.width = `${width}px`;
    rollContent.style.height = `${height}px`;

    const c = ctx2d;

    c.fillStyle = "#fdf6e3";
    c.fillRect(0, 0, width, height);

    for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi += 1) {
      const y = yForMidi(midi);
      const note = midi % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(note);
      c.fillStyle = isBlack ? "#f1ead9" : "#f7f2e4";
      c.fillRect(0, y, width, rowHeight);

      c.strokeStyle = "#e3dac0";
      c.beginPath();
      c.moveTo(0, y + 0.5);
      c.lineTo(width, y + 0.5);
      c.stroke();
    }

    for (let beat = 0; beat <= TOTAL_BEATS; beat += 1) {
      const x = xForBeat(beat) + 0.5;
      const measureLine = beat % 4 === 0;
      c.strokeStyle = measureLine ? "#93a1a1" : "#dcd3b8";
      c.lineWidth = measureLine ? 1.5 : 1;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, height);
      c.stroke();

      if (measureLine) {
        c.fillStyle = "#657b83";
        c.font = "11px Menlo, monospace";
        c.fillText(String(beat / 4 + 1), x + 3, 13);
      }
    }

    NOTES.forEach((note) => {
      const x = xForBeat(note.t);
      const y = yForMidi(note.m) + 1;
      const w = Math.max(2, note.d * BEAT_WIDTH - 1.4);
      const h = Math.max(2, rowHeight - 2);
      const color = VOICE_COLORS[note.s] || VOICE_COLORS[1];
      const fill = color.fill;
      const stroke = color.stroke;
      c.fillStyle = fill;
      c.fillRect(x, y, w, h);
      c.strokeStyle = stroke;
      c.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1);
    });

    drawLabels(height);
    updatePlayheadPosition();
    syncLabelScroll();
  }

  function followPlayhead(force = false) {
    if (!state.isPlaying && !force) {
      return;
    }

    const beat = state.isPlaying ? getCurrentBeat() : state.currentBeat;
    const targetX = xForBeat(beat);
    const viewWidth = rollViewport.clientWidth || 1;
    const maxScroll = Math.max(0, rollContent.scrollWidth - viewWidth);
    const targetScroll = clamp(targetX - viewWidth * 0.5, 0, maxScroll);
    rollViewport.scrollLeft = targetScroll;
  }

  function updateSeekAndStatus() {
    const beat = getCurrentBeat();
    statusText.textContent = `${formatClock(beat)} / ${formatClock(TOTAL_BEATS)}`;
  }

  function animationLoop() {
    if (state.isPlaying) {
      state.currentBeat = getCurrentBeat();
    }
    updateSeekAndStatus();
    followPlayhead();
    requestAnimationFrame(animationLoop);
  }

  function wireUi() {
    tempoRange.value = String(BASE_TEMPO);
    tempoOut.value = String(BASE_TEMPO);

    playPauseBtn.addEventListener("click", async () => {
      if (state.isPlaying) {
        pause();
      } else {
        await play();
      }
      updateSeekAndStatus();
    });

    tempoRange.addEventListener("input", () => {
      setTempo(tempoRange.value);
    });

    document.addEventListener("keydown", async (event) => {
      if (event.code !== "Space" || event.repeat) {
        return;
      }
      event.preventDefault();
      if (state.isPlaying) {
        pause();
      } else {
        await play();
      }
      updateSeekAndStatus();
    });

    window.addEventListener("resize", () => {
      drawRoll();
      updateSeekAndStatus();
      followPlayhead(true);
    });

    rollViewport.addEventListener("scroll", () => {
      syncLabelScroll();
    });
  }

  function init() {
    drawRoll();
    wireUi();
    updatePlayPauseLabel();
    updateSeekAndStatus();
    followPlayhead(true);
    syncLabelScroll();
    requestAnimationFrame(animationLoop);
  }

  init();
})();
