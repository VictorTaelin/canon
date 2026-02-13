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

  function createImpulseResponse(context, seconds = 2.5, decay = 2.5) {
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
    outputBus.gain.value = 0.9;

    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 16;
    compressor.ratio.value = 3.2;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    const dryGain = audioCtx.createGain();
    dryGain.gain.value = 0.85;

    const convolver = audioCtx.createConvolver();
    convolver.buffer = createImpulseResponse(audioCtx);
    const reverbGain = audioCtx.createGain();
    reverbGain.gain.value = 0.25;

    masterGain.connect(dryGain);
    dryGain.connect(outputBus);

    masterGain.connect(convolver);
    convolver.connect(reverbGain);
    reverbGain.connect(outputBus);

    outputBus.connect(compressor);
    compressor.connect(audioCtx.destination);

    effectInput = masterGain;
  }

  function cleanupVoice(voice) {
    if (voice.osc1) {
      voice.osc1.onended = null;
    }
    [
      voice.osc1,
      voice.osc2,
      voice.osc3,
      voice.osc3Gain,
      voice.vibLfo,
      voice.vibGain,
      voice.tremLfo,
      voice.tremGain,
      voice.filter,
      voice.gain,
    ].forEach((node) => {
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

    const durSec = Math.max(0.03, (durationBeats * 60) / state.tempo * 0.985);
    const stopTime = startTime + durSec + 0.06;
    const freq = midiToHz(note.m);

    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const osc3 = audioCtx.createOscillator();
    const osc3Gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    const gain = audioCtx.createGain();
    const vibLfo = audioCtx.createOscillator();
    const vibGain = audioCtx.createGain();
    const tremLfo = audioCtx.createOscillator();
    const tremGain = audioCtx.createGain();

    const baseGain = note.s === 1 ? 0.2 : note.s === 2 ? 0.18 : 0.17;
    const attackTime = Math.min(0.08, durSec * 0.2);
    const releaseTime = Math.min(0.12, durSec * 0.3);
    const sustainPoint = Math.max(startTime + attackTime, startTime + durSec - releaseTime);

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(baseGain, startTime + attackTime);
    gain.gain.setValueAtTime(baseGain, sustainPoint);
    gain.gain.linearRampToValueAtTime(0.0001, startTime + durSec);

    osc1.type = "sine";
    osc2.type = "sine";
    osc3.type = "triangle";
    osc1.frequency.setValueAtTime(freq, startTime);
    osc2.frequency.setValueAtTime(freq * 1.002, startTime);
    osc3.frequency.setValueAtTime(freq * 2, startTime);
    osc3Gain.gain.setValueAtTime(0.08, startTime);

    vibLfo.type = "sine";
    vibLfo.frequency.setValueAtTime(5 + Math.random(), startTime);
    vibGain.gain.setValueAtTime(freq * 0.006 * state.vibratoAmount, startTime);
    vibLfo.connect(vibGain);
    vibGain.connect(osc1.frequency);
    vibGain.connect(osc2.frequency);

    tremLfo.type = "sine";
    tremLfo.frequency.setValueAtTime(3.5, startTime);
    tremGain.gain.setValueAtTime(0.06 * state.vibratoAmount, startTime);
    tremLfo.connect(tremGain);
    tremGain.connect(gain.gain);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(freq * 4, 8000), startTime);
    filter.Q.setValueAtTime(0.7, startTime);

    osc1.connect(filter);
    osc2.connect(filter);
    osc3.connect(osc3Gain);
    osc3Gain.connect(filter);
    filter.connect(gain);
    gain.connect(effectInput);

    const voice = {
      osc1,
      osc2,
      osc3,
      osc3Gain,
      vibLfo,
      vibGain,
      tremLfo,
      tremGain,
      filter,
      gain,
    };
    activeVoices.add(voice);

    osc1.onended = () => cleanupVoice(voice);

    osc1.start(startTime);
    osc2.start(startTime);
    osc3.start(startTime);
    vibLfo.start(startTime);
    tremLfo.start(startTime);

    osc1.stop(stopTime);
    osc2.stop(stopTime);
    osc3.stop(stopTime);
    vibLfo.stop(stopTime);
    tremLfo.stop(stopTime);
  }

  function stopAllVoices() {
    if (!audioCtx) {
      return;
    }

    const now = audioCtx.currentTime;
    activeVoices.forEach((voice) => {
      try {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setTargetAtTime(0.0001, now, 0.01);
      } catch (_) {
        // noop
      }
      [voice.osc1, voice.osc2, voice.osc3, voice.vibLfo, voice.tremLfo].forEach((osc) => {
        try {
          osc.stop(now + 0.04);
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

  function updatePlayheadPosition() {
    const labelWidth = pianoLabels.clientWidth || 0;
    const viewportCenter = (rollViewport.clientWidth || 0) * 0.5;
    playhead.style.left = `${labelWidth + viewportCenter}px`;
  }

  function drawLabels(height) {
    const width = pianoLabels.clientWidth || 66;
    labelsCanvas.width = width;
    labelsCanvas.height = height;
    labelsCtx.fillStyle = "#f7f2e4";
    labelsCtx.fillRect(0, 0, width, height);

    for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi += 1) {
      const y = yForMidi(midi);
      const note = midi % 12;
      const isBlack = [1, 3, 6, 8, 10].includes(note);
      labelsCtx.fillStyle = isBlack ? "#f0e9d8" : "#f7f2e4";
      labelsCtx.fillRect(0, y, width, rowHeight);
      labelsCtx.strokeStyle = "#e2d9be";
      labelsCtx.beginPath();
      labelsCtx.moveTo(0, y + rowHeight + 0.5);
      labelsCtx.lineTo(width, y + rowHeight + 0.5);
      labelsCtx.stroke();

      labelsCtx.fillStyle = "#586e75";
      labelsCtx.font = "10px Menlo, monospace";
      labelsCtx.fillText(midiToLabel(midi), 3, y + Math.min(rowHeight - 2, 10));
    }
  }

  function drawRoll() {
    refreshHorizontalPadding();
    const noteCount = MAX_MIDI - MIN_MIDI + 1;
    rowHeight = Math.max(12, (rollViewport.clientHeight || 0) / noteCount);
    const scoreWidth = Math.ceil(leadInPadding + KEYBOARD_WIDTH + TOTAL_BEATS * BEAT_WIDTH + tailPadding);
    const width = Math.max(scoreWidth, rollViewport.clientWidth || 0);
    const height = Math.ceil(noteCount * rowHeight);

    rollCanvas.width = width;
    rollCanvas.height = height;
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
    labelsCanvas.style.transform = `translateY(${-rollViewport.scrollTop}px)`;
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
    statusText.textContent = `${formatClock(beat)} / ${formatClock(TOTAL_BEATS)} | ${formatBarBeat(beat)}`;
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

    window.addEventListener("resize", () => {
      drawRoll();
      updateSeekAndStatus();
      followPlayhead(true);
    });

    rollViewport.addEventListener("scroll", () => {
      labelsCanvas.style.transform = `translateY(${-rollViewport.scrollTop}px)`;
    });
  }

  function init() {
    drawRoll();
    wireUi();
    updatePlayPauseLabel();
    updateSeekAndStatus();
    followPlayhead(true);
    labelsCanvas.style.transform = "translateY(0px)";
    requestAnimationFrame(animationLoop);
  }

  init();
})();
