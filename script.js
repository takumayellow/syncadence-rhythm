const LANE_COUNT = 4;
const HIT_KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK"];
const BASE_APPROACH_MS = 2100;
const NOTE_BASE_WIDTH = 118;
const COUNTDOWN_MS = 2100;

const JUDGE_WINDOWS = {
  perfect: 45,
  great: 95,
  good: 150,
  miss: 210,
};
const HOLD_EARLY_RELEASE_TOLERANCE_MS = 70;

const scoreMap = {
  perfect: 1000,
  great: 700,
  good: 400,
  miss: 0,
};

function buildDefaultLongNotes(offsetMs, lengthSec, bpm) {
  const notes = [];
  const stepMs = Math.round((60_000 / bpm) / 2);
  const lanesPattern = [0, 1, 2, 3, 2, 1, 0, 2, 1, 3, 2, 0, 1, 2, 3, 1];
  let time = offsetMs;
  let i = 0;
  while (time < lengthSec * 1000 - 400) {
    notes.push({ time, lane: lanesPattern[i % lanesPattern.length] });
    if (i % 16 === 15) {
      time += stepMs * 2;
    } else if (i % 7 === 0) {
      time += Math.round(stepMs * 1.5);
    } else {
      time += stepMs;
    }
    i += 1;
  }
  return notes;
}

const FALLBACK_CHART = {
  title: "Chopin Nocturne Op.9 No.2 (Built-in)",
  artist: "Frederic Chopin",
  audioUrl: "assets/audio/Chopin_Nocturne_Op_9_No_2.ogg",
  audioFallbackUrl: "assets/audio/Chopin_Nocturne_Op_9_No_2.ogg",
  license: "Public domain composition / Wikimedia recording",
  offsetMs: 2300,
  bpm: 118,
  lengthSec: 180,
  notes: buildDefaultLongNotes(2300, 180, 118),
};

const scoreEl = document.getElementById("score");
const comboEl = document.getElementById("combo");
const judgeEl = document.getElementById("judge");
const songTitleEl = document.getElementById("songTitle");
const notesLayer = document.getElementById("notes-layer");
const playfield = document.getElementById("playfield");
const cueEl = document.getElementById("cueText");
const hitFeedbackEl = document.getElementById("hitFeedback");
const startBtn = document.getElementById("startBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanelEl = document.getElementById("settingsPanel");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const speedRangeEl = document.getElementById("speedRange");
const speedValueEl = document.getElementById("speedValue");
const timingRangeEl = document.getElementById("timingRange");
const timingValueEl = document.getElementById("timingValue");
const tempoRangeEl = document.getElementById("tempoRange");
const tempoValueEl = document.getElementById("tempoValue");
const tapTempoBtn = document.getElementById("tapTempoBtn");
const tapTempoStateEl = document.getElementById("tapTempoState");
const musicXmlInputEl = document.getElementById("musicXmlInput");
const xmlImportStateEl = document.getElementById("xmlImportState");
const judgeLineRangeEl = document.getElementById("judgeLineRange");
const judgeLineValueEl = document.getElementById("judgeLineValue");
const saveSongTuneBtn = document.getElementById("saveSongTuneBtn");
const progressEl = document.getElementById("songProgress");
const resultOverlayEl = document.getElementById("resultOverlay");
const resultStateEl = document.getElementById("resultState");
const resultRankEl = document.getElementById("resultRank");
const resultScoreEl = document.getElementById("resultScore");
const resultAccEl = document.getElementById("resultAcc");
const laneButtons = Array.from(document.querySelectorAll(".lane"));
const laneVisuals = Array.from(document.querySelectorAll("[data-lane-visual]"));

let chartConfig = FALLBACK_CHART;
let chart = [];
let startedAt = 0;
let gameRunning = false;
let score = 0;
let combo = 0;
let rafId = null;
let countdownTimers = [];
let audio = null;
let cueHideTimer = null;
let feedbackHideTimer = null;
let useSynthBgm = false;
let bgmStep = 0;
let nextBgmMs = 0;
const laneFlashTokens = [0, 0, 0, 0];
const lanePressed = [false, false, false, false];
let triedAudioFallbackUrl = false;
let noteSpeed = 10.5;
let timingOffsetMs = 0;
let chartTempoBpm = 66;
let judgeLineOffsetPx = 110;
let achievedPoints = 0;
let possiblePoints = 0;
let missCount = 0;
let tapTempoMode = false;
let tapTimesMs = [];
let chartSourceMode = "grid";
let importedScoreNotes = [];

let audioCtx = null;
let masterGain = null;

const BGM_TEMPO = 108;
const BGM_STEP_MS = (60_000 / BGM_TEMPO) / 2;
const BGM_PATTERN = [
  440.0, 493.88, 523.25, 587.33,
  659.25, 587.33, 523.25, 493.88,
  440.0, 523.25, 587.33, 659.25,
  698.46, 659.25, 587.33, 523.25,
];

function createAudioForChart() {
  if (audio) {
    audio.pause();
    audio = null;
  }

  if (!chartConfig.audioUrl) return;

  audio = new Audio(chartConfig.audioUrl);
  audio.preload = "auto";
  audio.crossOrigin = "anonymous";
  audio.addEventListener("ended", () => {
    if (gameRunning) {
      stopGame();
    }
  });
}

function loadSettings() {
  const saved = Number(localStorage.getItem("pjsk_note_speed"));
  if (Number.isFinite(saved) && saved >= 6 && saved <= 12) {
    noteSpeed = saved;
  }
  const savedTiming = Number(localStorage.getItem("pjsk_timing_offset_ms"));
  if (Number.isFinite(savedTiming) && savedTiming >= -300 && savedTiming <= 300) {
    timingOffsetMs = savedTiming;
  }
  const savedJudgeLine = Number(localStorage.getItem("pjsk_judge_line_px"));
  if (Number.isFinite(savedJudgeLine) && savedJudgeLine >= 70 && savedJudgeLine <= 180) {
    judgeLineOffsetPx = savedJudgeLine;
  }
  const savedChartTempo = Number(localStorage.getItem("pjsk_chart_tempo_bpm"));
  if (Number.isFinite(savedChartTempo) && savedChartTempo >= 50 && savedChartTempo <= 110) {
    chartTempoBpm = savedChartTempo;
  }
  speedRangeEl.value = String(noteSpeed);
  speedValueEl.textContent = noteSpeed.toFixed(1);
  timingRangeEl.value = String(timingOffsetMs);
  timingValueEl.textContent = String(Math.round(timingOffsetMs));
  tempoRangeEl.value = String(chartTempoBpm);
  tempoValueEl.textContent = chartTempoBpm.toFixed(1);
  judgeLineRangeEl.value = String(judgeLineOffsetPx);
  judgeLineValueEl.textContent = String(Math.round(judgeLineOffsetPx));
  playfield.style.setProperty("--judge-line-bottom", `${judgeLineOffsetPx}px`);
}

function saveSettings() {
  localStorage.setItem("pjsk_note_speed", String(noteSpeed));
  localStorage.setItem("pjsk_timing_offset_ms", String(Math.round(timingOffsetMs)));
  localStorage.setItem("pjsk_judge_line_px", String(Math.round(judgeLineOffsetPx)));
  localStorage.setItem("pjsk_chart_tempo_bpm", String(chartTempoBpm));
}

function getApproachMs() {
  return BASE_APPROACH_MS * (10 / noteSpeed);
}

function switchToFallbackAudioUrl() {
  if (!audio || triedAudioFallbackUrl) return false;
  if (!chartConfig.audioFallbackUrl) return false;
  triedAudioFallbackUrl = true;
  audio.src = chartConfig.audioFallbackUrl;
  audio.load();
  return true;
}

function initAudio() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;

  audioCtx = new Ctx();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.18;
  masterGain.connect(audioCtx.destination);
}

function playTone(freq, durationMs, type = "sine", volume = 1, delayMs = 0) {
  if (!audioCtx || !masterGain) return;

  const now = audioCtx.currentTime + delayMs / 1000;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = type;
  osc.frequency.value = freq;

  const scaledVolume = volume * 0.16;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(scaledVolume, now + 0.014);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(now);
  osc.stop(now + durationMs / 1000 + 0.03);
}

function playStartCue() {
  showCue("START", 1000);
  playTone(523.25, 150, "triangle", 0.9, 0);
  playTone(659.25, 150, "triangle", 0.9, 160);
  playTone(783.99, 220, "triangle", 1.0, 330);
}

function playEndCue() {
  showCue("FINISH", 1400);
  playTone(783.99, 170, "triangle", 0.95, 0);
  playTone(659.25, 170, "triangle", 0.85, 180);
  playTone(523.25, 230, "triangle", 0.9, 360);
}

function showCue(text, durationMs = 900) {
  cueEl.textContent = text;
  cueEl.classList.remove("hidden");
  if (cueHideTimer) clearTimeout(cueHideTimer);
  cueHideTimer = setTimeout(() => cueEl.classList.add("hidden"), durationMs);
}

function showHitFeedback(judge) {
  hitFeedbackEl.className = "hit-feedback";
  hitFeedbackEl.textContent = judge.toUpperCase();
  hitFeedbackEl.classList.add(`judge-${judge}`);
  hitFeedbackEl.classList.remove("hidden");

  if (feedbackHideTimer) clearTimeout(feedbackHideTimer);
  feedbackHideTimer = setTimeout(() => {
    hitFeedbackEl.classList.add("hidden");
  }, 240);
}

async function loadChartConfig() {
  try {
    const res = await fetch("charts/chopin_nocturne_easy.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`chart load failed: ${res.status}`);
    chartConfig = await res.json();
  } catch (err) {
    chartConfig = FALLBACK_CHART;
    progressEl.textContent = "Chart load failed: built-in Chopin";
    console.warn(err);
  }

  songTitleEl.textContent = `${chartConfig.title} / ${chartConfig.artist}`;
  loadSongTune();
  createAudioForChart();
}

function createNoteElement(note) {
  const el = document.createElement("div");
  el.className = "note" + (note.lane % 2 ? " alt" : "");
  notesLayer.appendChild(el);
  note.element = el;
}

function buildChartFromConfig() {
  const sourceNotes = chartSourceMode === "score" && importedScoreNotes.length
    ? importedScoreNotes
    : generateTempoGridNotes(chartTempoBpm);

  return sourceNotes.map((n) => ({
    lane: n.lane,
    hitTime: n.time,
    durationMs: n.duration || 0,
    holdEndTime: n.duration ? (n.time + n.duration) : n.time,
    judged: false,
    holding: false,
    holdBroken: false,
    headJudged: false,
    tailJudged: false,
    headJudge: null,
    tailJudge: null,
    element: null,
    lastStyleKey: "",
  }));
}

function pitchToMidi(step, alter, octave) {
  const map = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (octave + 1) * 12 + (map[step] ?? 0) + alter;
}

function mapMidiToLane(midi, minMidi, maxMidi) {
  const span = Math.max(1, maxMidi - minMidi);
  const t = Math.max(0, Math.min(1, (midi - minMidi) / span));
  return Math.max(0, Math.min(3, Math.floor(t * 4)));
}

function parseMusicXmlToNotes(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    throw new Error("MusicXML parse error");
  }

  const part = doc.querySelector("part");
  if (!part) throw new Error("MusicXML has no <part>");

  let divisions = 1;
  let tempo = chartTempoBpm;
  let cursorDiv = 0;
  let lastChordStartDiv = 0;
  const raw = [];

  for (const measure of part.querySelectorAll("measure")) {
    const divEl = measure.querySelector("attributes > divisions");
    if (divEl) {
      const d = Number(divEl.textContent);
      if (Number.isFinite(d) && d > 0) divisions = d;
    }

    for (const child of Array.from(measure.children)) {
      if (child.tagName === "direction") {
        const soundTempo = child.querySelector("sound[tempo]");
        if (soundTempo) {
          const t = Number(soundTempo.getAttribute("tempo"));
          if (Number.isFinite(t) && t >= 30 && t <= 240) tempo = t;
        }
        const perMin = child.querySelector("metronome > per-minute");
        if (perMin) {
          const t = Number(perMin.textContent);
          if (Number.isFinite(t) && t >= 30 && t <= 240) tempo = t;
        }
      }

      if (child.tagName === "backup") {
        const dur = Number(child.querySelector("duration")?.textContent || "0");
        cursorDiv = Math.max(0, cursorDiv - dur);
        continue;
      }

      if (child.tagName === "forward") {
        const dur = Number(child.querySelector("duration")?.textContent || "0");
        cursorDiv += dur;
        continue;
      }

      if (child.tagName !== "note") continue;
      if (child.querySelector("grace")) continue;

      const isRest = !!child.querySelector("rest");
      const hasChord = !!child.querySelector("chord");
      const dur = Number(child.querySelector("duration")?.textContent || "0");
      const startDiv = hasChord ? lastChordStartDiv : cursorDiv;
      const beatMs = 60000 / tempo;
      const quarterMs = beatMs;
      const startMs = Math.round((startDiv / divisions) * quarterMs + (chartConfig.offsetMs || 1600));
      const durMs = Math.max(0, Math.round((dur / divisions) * quarterMs));

      if (!isRest) {
        const step = child.querySelector("pitch > step")?.textContent || "C";
        const alter = Number(child.querySelector("pitch > alter")?.textContent || "0");
        const octave = Number(child.querySelector("pitch > octave")?.textContent || "4");
        const midi = pitchToMidi(step, alter, octave);
        raw.push({ time: startMs, duration: durMs, midi });
      }

      lastChordStartDiv = startDiv;
      if (!hasChord) {
        cursorDiv += dur;
      }
    }
  }

  if (!raw.length) return [];
  const minMidi = Math.min(...raw.map((n) => n.midi));
  const maxMidi = Math.max(...raw.map((n) => n.midi));

  const notes = raw.map((n) => {
    const lane = mapMidiToLane(n.midi, minMidi, maxMidi);
    const out = { time: n.time, lane };
    if (n.duration >= 700) out.duration = n.duration;
    return out;
  });

  notes.sort((a, b) => a.time - b.time);
  return notes;
}

function songTuneKey() {
  const id = chartConfig.audioUrl || chartConfig.title || "default";
  return `pjsk_song_tune_${encodeURIComponent(id)}`;
}

function loadSongTune() {
  if (Number.isFinite(chartConfig.bpm)) {
    chartTempoBpm = Math.max(50, Math.min(110, Number(chartConfig.bpm)));
  }
  try {
    const raw = localStorage.getItem(songTuneKey());
    if (!raw) return;
    const s = JSON.parse(raw);
    if (Number.isFinite(s.timingOffsetMs)) timingOffsetMs = Math.max(-300, Math.min(300, Math.round(s.timingOffsetMs)));
    if (Number.isFinite(s.chartTempoBpm)) chartTempoBpm = Math.max(50, Math.min(110, s.chartTempoBpm));
  } catch {
    // ignore parse errors
  }

  timingRangeEl.value = String(timingOffsetMs);
  timingValueEl.textContent = String(timingOffsetMs);
  tempoRangeEl.value = String(chartTempoBpm);
  tempoValueEl.textContent = chartTempoBpm.toFixed(1);
}

function saveSongTune() {
  const payload = {
    timingOffsetMs,
    chartTempoBpm,
  };
  localStorage.setItem(songTuneKey(), JSON.stringify(payload));
}

function generateTempoGridNotes(bpm) {
  const beatMs = 60000 / bpm;
  const offsetMs = chartConfig.offsetMs || 1600;
  const endMs = (chartConfig.lengthSec || 180) * 1000;
  const notes = [];
  const flow = [
    1, 0.5, 1, 1 / 3, 1 / 3, 1 / 3,
    1, 0.5, 0.5, 1,
    1, 1 / 3, 1 / 3, 1 / 3, 1,
    0.5, 0.5, 1,
  ];
  const lanes = [1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 2, 3, 2, 1, 0];
  let t = offsetMs;
  let i = 0;

  while (t < endMs - 1200) {
    const lane = lanes[i % lanes.length];
    const note = { time: Math.round(t), lane };
    if (i % 24 === 8) note.duration = Math.round(beatMs * 1.5);
    if (i % 48 === 32) note.duration = Math.round(beatMs * 2);
    notes.push(note);
    t += beatMs * flow[i % flow.length];
    i += 1;
  }

  const holds = notes.filter((n) => n.duration).map((n) => ({ s: n.time, e: n.time + n.duration + 90 }));
  return notes.filter((n) => {
    if (n.duration) return true;
    for (const h of holds) {
      if (n.time > h.s + 20 && n.time < h.e) return false;
    }
    return true;
  });
}

function resetGameState() {
  clearCountdown();
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  triedAudioFallbackUrl = false;
  useSynthBgm = false;
  bgmStep = 0;
  nextBgmMs = 0;
  lanePressed.fill(false);

  chart = buildChartFromConfig();
  notesLayer.innerHTML = "";
  chart.forEach(createNoteElement);

  score = 0;
  combo = 0;
  achievedPoints = 0;
  missCount = 0;
  possiblePoints = chart.reduce((sum, n) => sum + (n.durationMs > 0 ? 2200 : 1000), 0);
  updateScoreUI();
  setJudge("-");
  hitFeedbackEl.classList.add("hidden");
  resultOverlayEl.classList.add("hidden");
  resultOverlayEl.setAttribute("aria-hidden", "true");
  progressEl.textContent = "Ready";
  gameRunning = false;
}

function updateScoreUI() {
  scoreEl.textContent = String(score);
  comboEl.textContent = String(combo);
}

function setJudge(judge) {
  judgeEl.className = "";
  if (["perfect", "great", "good", "miss"].includes(judge)) {
    judgeEl.classList.add(`judge-${judge}`);
  }
  judgeEl.textContent = judge === "-" ? "-" : judge.toUpperCase();
}

function clearCountdown() {
  for (const t of countdownTimers) clearTimeout(t);
  countdownTimers = [];
}

function startMainLoop() {
  startedAt = performance.now();
  gameRunning = true;
  progressEl.textContent = "Playing";
  playStartCue();
  bgmStep = 0;
  nextBgmMs = 0;

  if (audio) {
    audio.currentTime = 0;
    audio.play().catch(() => {
      if (switchToFallbackAudioUrl()) {
        audio.play().catch(() => {
          useSynthBgm = true;
          progressEl.textContent = "Playing (synth BGM)";
        });
      } else {
        useSynthBgm = true;
        progressEl.textContent = "Playing (synth BGM)";
      }
    });
  } else {
    useSynthBgm = true;
    progressEl.textContent = "Playing (synth BGM)";
  }

  loop();
}

function startGame() {
  if (gameRunning || countdownTimers.length > 0) return;

  initAudio();
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  useSynthBgm = false;

  if (audio) {
    audio.currentTime = 0;
    audio.muted = true;
    audio.play().then(() => {
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
    }).catch(() => {
      audio.muted = false;
    });
  }

  showCue("3", 650);
  playTone(440, 120, "square", 0.7, 0);

  countdownTimers.push(setTimeout(() => {
    showCue("2", 650);
    playTone(440, 120, "square", 0.7, 0);
  }, 700));

  countdownTimers.push(setTimeout(() => {
    showCue("1", 650);
    playTone(440, 120, "square", 0.7, 0);
  }, 1400));

  countdownTimers.push(setTimeout(() => {
    clearCountdown();
    startMainLoop();
  }, COUNTDOWN_MS));
}

function stopGame() {
  gameRunning = false;
  progressEl.textContent = "Finished";
  if (rafId) cancelAnimationFrame(rafId);
  if (audio) audio.pause();
  useSynthBgm = false;
  playEndCue();
  showResultOverlay();
}

function judgeDelta(deltaAbs) {
  if (deltaAbs <= JUDGE_WINDOWS.perfect) return "perfect";
  if (deltaAbs <= JUDGE_WINDOWS.great) return "great";
  if (deltaAbs <= JUDGE_WINDOWS.good) return "good";
  if (deltaAbs <= JUDGE_WINDOWS.miss) return "miss";
  return null;
}

function applyJudge(note, judge) {
  note.judged = true;
  if (note.element) note.element.remove();

  setJudge(judge);
  showHitFeedback(judge);
  score += scoreMap[judge];
  if (judge === "perfect") achievedPoints += 1000;
  else if (judge === "great") achievedPoints += 800;
  else if (judge === "good") achievedPoints += 550;
  else missCount += 1;

  if (judge === "miss") {
    combo = 0;
  } else {
    combo += 1;
    score += combo * 8;
  }

  updateScoreUI();
}

function judgeLongHead(note, judge) {
  if (note.headJudged) return;
  note.headJudged = true;
  note.headJudge = judge;

  setJudge(judge);
  showHitFeedback(judge);

  if (judge === "perfect") achievedPoints += 1000;
  else if (judge === "great") achievedPoints += 800;
  else if (judge === "good") achievedPoints += 550;
  else missCount += 1;

  if (judge === "miss") {
    combo = 0;
  } else {
    combo += 1;
    score += Math.floor((scoreMap[judge] || 500) * 0.45) + combo * 6;
    note.holding = true;
  }

  updateScoreUI();
}

function startLateHold(note) {
  if (note.tailJudged) return;
  if (!note.headJudged) {
    judgeLongHead(note, "miss");
  }
  note.holding = true;
  note.holdBroken = false;
  setJudge("good");
  showHitFeedback("good");
}

function judgeLongTail(note, success) {
  if (note.tailJudged) return;
  note.tailJudged = true;
  note.tailJudge = success ? "perfect" : "miss";
  note.holding = false;
  note.judged = true;
  if (note.element) note.element.remove();

  if (success) {
    setJudge("perfect");
    showHitFeedback("perfect");
    combo += 1;
    score += 1200 + combo * 10;
    achievedPoints += 1200;
  } else {
    setJudge("miss");
    showHitFeedback("miss");
    combo = 0;
    missCount += 1;
  }

  updateScoreUI();
}

function applyEmptyHitMiss() {
  setJudge("miss");
  showHitFeedback("miss");
  combo = 0;
  missCount += 1;
  updateScoreUI();
}

function pressLane(laneIndex) {
  if (!gameRunning) return;

  const now = getSongTimeMs();
  let best = null;
  let lateHold = null;

  for (const note of chart) {
    if (note.judged || note.lane !== laneIndex) continue;
    if (note.durationMs > 0) {
      if (!note.headJudged) {
        const delta = now - note.hitTime;
        const abs = Math.abs(delta);
        if (delta < -JUDGE_WINDOWS.miss) {
          break;
        }
        if (abs <= JUDGE_WINDOWS.miss && (!best || abs < best.abs)) {
          best = { note, abs, isLongHead: true };
          continue;
        }
      }
      if (!note.tailJudged && !note.holding && now > note.hitTime + JUDGE_WINDOWS.miss && now < note.holdEndTime) {
        lateHold = note;
      }
      continue;
    }

    const delta = now - note.hitTime;
    const abs = Math.abs(delta);

    if (delta < -JUDGE_WINDOWS.miss) {
      break;
    }

    if (abs <= JUDGE_WINDOWS.miss && (!best || abs < best.abs)) {
      best = { note, abs, isLongHead: false };
    }
  }

  if (best) {
    const judge = judgeDelta(best.abs) || "miss";
    if (best.isLongHead) {
      judgeLongHead(best.note, judge);
    } else {
      applyJudge(best.note, judge);
    }
  } else if (lateHold) {
    startLateHold(lateHold);
  } else {
    const hasActiveHold = chart.some(
      (note) => note.lane === laneIndex && note.holding && !note.judged
    );
    if (hasActiveHold) return;
    applyEmptyHitMiss();
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function laneCenterAtDepth(lane, depth) {
  const width = playfield.clientWidth;
  const center = width / 2;
  const nearSpread = width * 0.92;
  const farSpread = width * 0.38;
  const t = (lane + 0.5) / LANE_COUNT - 0.5;

  const xNear = center + t * nearSpread;
  const xFar = center + t * farSpread;
  return xFar + (xNear - xFar) * depth;
}

function updateNotes(nowMs) {
  const farY = 55;
  const judgeLineY = playfield.clientHeight - judgeLineOffsetPx;
  const approachMs = getApproachMs();
  const maxAhead = approachMs + 650;

  for (const note of chart) {
    if (note.judged) continue;

    const dt = note.hitTime - nowMs;
    if (dt > maxAhead) {
      if (note.element && note.element.style.display !== "none") {
        note.element.style.display = "none";
      }
      continue;
    }

    if (note.durationMs > 0) {
      if (!note.headJudged && nowMs > note.hitTime + JUDGE_WINDOWS.miss) {
        judgeLongHead(note, "miss");
      }
      if (!note.tailJudged && nowMs > note.holdEndTime + JUDGE_WINDOWS.miss) {
        judgeLongTail(note, false);
        continue;
      }
    } else if (dt < -JUDGE_WINDOWS.miss) {
      applyJudge(note, "miss");
      continue;
    }

    const headTime = note.holding ? nowMs : note.hitTime;
    const tailTime = note.durationMs > 0 ? note.holdEndTime : note.hitTime;
    const dtHead = headTime - nowMs;
    const dtTail = tailTime - nowMs;

    const headLinear = clamp01(1 - dtHead / approachMs);
    const tailLinear = clamp01(1 - dtTail / approachMs);
    const depthHead = Math.pow(headLinear, 1.15);
    const depthTail = Math.pow(tailLinear, 1.15);
    const yHead = farY + (judgeLineY - farY) * depthHead;
    const yTail = farY + (judgeLineY - farY) * depthTail;

    const scaleHead = 0.58 + depthHead * 1.2;
    const scaleTail = 0.58 + depthTail * 1.2;
    const noteWHead = NOTE_BASE_WIDTH * scaleHead;
    const noteHTail = 26 * scaleTail;
    const noteHHead = 26 * scaleHead;
    const noteWTail = NOTE_BASE_WIDTH * scaleTail;
    const xHead = laneCenterAtDepth(note.lane, depthHead) - noteWHead / 2;
    const xTail = laneCenterAtDepth(note.lane, depthTail) - noteWTail / 2;
    const yHeadTop = yHead - noteHHead / 2;
    const yHeadBottom = yHead + noteHHead / 2;
    const yTailTop = yTail - noteHTail / 2;
    const skew = (note.lane - 1.5) * -1.8 * (1 - depthHead);

    if (note.element) {
      let drawX = xHead;
      let drawY = yHeadTop;
      let drawW = noteWHead;
      let drawH = noteHHead;
      let drawClip = "";
      let drawTransform = `skewX(${skew.toFixed(2)}deg)`;

      if (note.durationMs > 0) {
        const left = Math.min(xHead, xTail);
        const right = Math.max(xHead + noteWHead, xTail + noteWTail);
        const top = Math.min(yTailTop, yHeadTop);
        const bottom = Math.max(yHeadBottom, yTailTop + noteHTail);
        drawX = left;
        drawY = top;
        drawW = right - left;
        drawH = Math.max(noteHHead, bottom - top);

        const p1x = ((xTail - left) / drawW) * 100;
        const p2x = ((xTail + noteWTail - left) / drawW) * 100;
        const p3x = ((xHead + noteWHead - left) / drawW) * 100;
        const p4x = ((xHead - left) / drawW) * 100;
        const p1y = ((yTailTop - top) / drawH) * 100;
        const p2y = p1y;
        const p3y = ((yHeadBottom - top) / drawH) * 100;
        const p4y = p3y;
        drawClip = `polygon(${p1x}% ${p1y}%, ${p2x}% ${p2y}%, ${p3x}% ${p3y}%, ${p4x}% ${p4y}%)`;
        drawTransform = "none";
        note.element.classList.add("long-note");
      } else {
        note.element.classList.remove("long-note");
      }

      const styleKey = [
        drawX.toFixed(1),
        drawY.toFixed(1),
        drawW.toFixed(1),
        drawH.toFixed(1),
        skew.toFixed(2),
        (0.55 + depthHead * 0.45).toFixed(2),
        note.durationMs > 0 ? "L" : "T",
        drawClip,
      ].join("|");

      if (styleKey !== note.lastStyleKey) {
        note.lastStyleKey = styleKey;
        note.element.style.display = "block";
        note.element.style.left = `${drawX}px`;
        note.element.style.top = `${drawY}px`;
        note.element.style.width = `${drawW}px`;
        note.element.style.height = `${drawH}px`;
        note.element.style.transform = drawTransform;
        note.element.style.clipPath = drawClip || "none";
        note.element.style.opacity = String(0.55 + depthHead * 0.45);
      }
    }
  }
}

function updateHoldNotes(nowMs) {
  for (const note of chart) {
    if (note.judged || note.tailJudged) continue;

    if (note.holding && !lanePressed[note.lane] && nowMs < note.holdEndTime - HOLD_EARLY_RELEASE_TOLERANCE_MS) {
      note.holdBroken = true;
      note.holding = false;
      continue;
    }

    if (note.holding && nowMs >= note.holdEndTime) {
      judgeLongTail(note, !note.holdBroken);
    }
  }
}

function tickSynthBgm(nowMs) {
  if (!useSynthBgm) return;
  while (nowMs >= nextBgmMs) {
    const freq = BGM_PATTERN[bgmStep % BGM_PATTERN.length];
    playTone(freq, 130, "triangle", 0.35);
    if (bgmStep % 4 === 0) {
      playTone(freq / 2, 110, "sine", 0.18);
    }
    bgmStep += 1;
    nextBgmMs += BGM_STEP_MS;
  }
}

function getSongTimeMs() {
  if (audio && !useSynthBgm && !audio.paused && Number.isFinite(audio.currentTime)) {
    return audio.currentTime * 1000 + timingOffsetMs;
  }
  return performance.now() - startedAt + timingOffsetMs;
}

function getRawSongTimeMs() {
  if (audio && !audio.paused && Number.isFinite(audio.currentTime)) {
    return audio.currentTime * 1000;
  }
  return performance.now() - startedAt;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function nearestGrid(timeMs, beatMs, baseOffsetMs) {
  const k = Math.round((timeMs - baseOffsetMs) / beatMs);
  return baseOffsetMs + k * beatMs;
}

function applyTapTempoCalibration() {
  if (tapTimesMs.length < 4) return false;

  const intervals = [];
  for (let i = 1; i < tapTimesMs.length; i += 1) {
    intervals.push(tapTimesMs[i] - tapTimesMs[i - 1]);
  }
  const beatMs = median(intervals);
  if (!Number.isFinite(beatMs) || beatMs < 350 || beatMs > 1400) return false;

  const bpm = 60000 / beatMs;
  setChartTempo(bpm, true);

  const deltas = tapTimesMs.map((t) => nearestGrid(t, beatMs, chartConfig.offsetMs || 1600) - t);
  const deltaAvg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  setTimingOffset(timingOffsetMs + deltaAvg);
  saveSongTune();
  return true;
}

function loop() {
  if (!gameRunning) return;

  const now = getSongTimeMs();
  tickSynthBgm(now);
  updateHoldNotes(now);
  updateNotes(now);

  const sec = Math.min(chartConfig.lengthSec, now / 1000);
  progressEl.textContent = `Playing ${sec.toFixed(1)}s / ${chartConfig.lengthSec}s`;

  if (now >= chartConfig.lengthSec * 1000 + 800) {
    stopGame();
    return;
  }

  rafId = requestAnimationFrame(loop);
}

function openSettings() {
  settingsPanelEl.classList.remove("hidden");
  settingsPanelEl.setAttribute("aria-hidden", "false");
}

function closeSettings() {
  settingsPanelEl.classList.add("hidden");
  settingsPanelEl.setAttribute("aria-hidden", "true");
}

function setTapTempoState(text) {
  tapTempoStateEl.textContent = text;
}

function setXmlImportState(text) {
  xmlImportStateEl.textContent = text;
}

function toggleTapTempoMode() {
  tapTempoMode = !tapTempoMode;
  tapTimesMs = [];
  setTapTempoState(tapTempoMode ? "tap quarter notes..." : "idle");
}

function registerTapTempo() {
  if (!tapTempoMode || !gameRunning) return;
  const t = getRawSongTimeMs();
  tapTimesMs.push(t);
  if (tapTimesMs.length > 12) tapTimesMs.shift();
  setTapTempoState(`taps: ${tapTimesMs.length}`);

  if (tapTimesMs.length >= 8) {
    const ok = applyTapTempoCalibration();
    setTapTempoState(ok ? `applied ${chartTempoBpm.toFixed(1)} BPM` : "failed, retry");
    tapTempoMode = false;
    tapTimesMs = [];
  }
}

function calcRank(accPercent) {
  if (accPercent >= 95) return "S";
  if (accPercent >= 88) return "A";
  if (accPercent >= 78) return "B";
  if (accPercent >= 66) return "C";
  return "D";
}

function showResultOverlay() {
  const acc = possiblePoints > 0 ? (achievedPoints / possiblePoints) * 100 : 0;
  const clear = acc >= 72 && missCount < Math.max(30, Math.floor(chart.length * 0.22));
  const rank = calcRank(acc);

  resultStateEl.textContent = clear ? "CLEAR!" : "FAILED";
  resultRankEl.textContent = `RANK ${rank}`;
  resultScoreEl.textContent = `SCORE ${score}`;
  resultAccEl.textContent = `ACCURACY ${acc.toFixed(1)}%`;
  resultStateEl.style.color = clear ? "#8dffbf" : "#ff8b8b";

  resultOverlayEl.classList.remove("hidden");
  resultOverlayEl.setAttribute("aria-hidden", "false");
}

function setTimingOffset(next) {
  timingOffsetMs = Math.max(-300, Math.min(300, Math.round(next)));
  timingRangeEl.value = String(timingOffsetMs);
  timingValueEl.textContent = String(timingOffsetMs);
  saveSettings();
}

function setJudgeLineOffset(next) {
  judgeLineOffsetPx = Math.max(70, Math.min(180, Math.round(next)));
  judgeLineRangeEl.value = String(judgeLineOffsetPx);
  judgeLineValueEl.textContent = String(judgeLineOffsetPx);
  playfield.style.setProperty("--judge-line-bottom", `${judgeLineOffsetPx}px`);
  saveSettings();
}

function rebuildChartForCurrentTime() {
  const now = getSongTimeMs();
  chart = buildChartFromConfig();
  notesLayer.innerHTML = "";
  for (const note of chart) {
    if (note.hitTime < now - JUDGE_WINDOWS.miss) {
      note.judged = true;
      continue;
    }
    createNoteElement(note);
  }
}

function setChartTempo(next, rebuild = true) {
  chartTempoBpm = Math.max(50, Math.min(110, Number(next)));
  tempoRangeEl.value = String(chartTempoBpm);
  tempoValueEl.textContent = chartTempoBpm.toFixed(1);
  saveSettings();
  if (rebuild && chart.length > 0) {
    rebuildChartForCurrentTime();
  }
}

async function importMusicXmlFile(file) {
  const text = await file.text();
  const notes = parseMusicXmlToNotes(text);
  if (!notes.length) {
    setXmlImportState("empty score");
    return;
  }

  importedScoreNotes = notes;
  chartSourceMode = "score";
  setXmlImportState(`score: ${file.name} (${notes.length} notes)`);
  progressEl.textContent = "MusicXML imported";
  rebuildChartForCurrentTime();
}

function flashLane(index) {
  const lane = laneVisuals[index];
  if (!lane) return;

  laneVisuals.forEach((vis, i) => {
    if (i !== index) vis.classList.remove("active");
  });

  laneFlashTokens[index] += 1;
  const token = laneFlashTokens[index];
  lane.classList.add("active");
  setTimeout(() => {
    if (laneFlashTokens[index] === token) {
      lane.classList.remove("active");
    }
  }, 80);
}

document.addEventListener("keydown", (event) => {
  if (tapTempoMode && (event.code === "Space" || event.code === "KeyT")) {
    event.preventDefault();
    registerTapTempo();
    return;
  }
  const laneIndex = HIT_KEYS.indexOf(event.code);
  if (laneIndex < 0) return;
  if (event.repeat) return;
  lanePressed[laneIndex] = true;
  flashLane(laneIndex);
  pressLane(laneIndex);
});

document.addEventListener("keyup", (event) => {
  if (event.code === "BracketLeft") {
    setTimingOffset(timingOffsetMs - 20);
  }
  if (event.code === "BracketRight") {
    setTimingOffset(timingOffsetMs + 20);
  }
  if (event.code === "Minus") {
    setJudgeLineOffset(judgeLineOffsetPx - 5);
  }
  if (event.code === "Equal") {
    setJudgeLineOffset(judgeLineOffsetPx + 5);
  }
  if (event.code === "Escape") {
    closeSettings();
  }
  const laneIndex = HIT_KEYS.indexOf(event.code);
  if (laneIndex < 0) return;
  lanePressed[laneIndex] = false;
});

laneButtons.forEach((lane, i) => {
  lane.addEventListener("pointerdown", () => {
    lanePressed[i] = true;
    flashLane(i);
    pressLane(i);
  });
  lane.addEventListener("pointerup", () => {
    lanePressed[i] = false;
  });
  lane.addEventListener("pointerleave", () => {
    lanePressed[i] = false;
  });
  lane.addEventListener("pointercancel", () => {
    lanePressed[i] = false;
  });
});

startBtn.addEventListener("click", () => {
  if (rafId) cancelAnimationFrame(rafId);
  resetGameState();
  startGame();
});

settingsBtn.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeSettings);
settingsPanelEl.addEventListener("click", (event) => {
  if (event.target === settingsPanelEl) closeSettings();
});
speedRangeEl.addEventListener("input", () => {
  noteSpeed = Number(speedRangeEl.value);
  speedValueEl.textContent = noteSpeed.toFixed(1);
  saveSettings();
});
timingRangeEl.addEventListener("input", () => {
  setTimingOffset(Number(timingRangeEl.value));
});
tempoRangeEl.addEventListener("input", () => {
  setChartTempo(Number(tempoRangeEl.value), true);
});
judgeLineRangeEl.addEventListener("input", () => {
  setJudgeLineOffset(Number(judgeLineRangeEl.value));
});
saveSongTuneBtn.addEventListener("click", () => {
  saveSongTune();
  progressEl.textContent = "Saved tune for this song";
});
tapTempoBtn.addEventListener("click", () => {
  toggleTapTempoMode();
});
musicXmlInputEl.addEventListener("change", async () => {
  const file = musicXmlInputEl.files?.[0];
  if (!file) return;
  try {
    await importMusicXmlFile(file);
  } catch (err) {
    console.warn(err);
    setXmlImportState("import failed");
  }
});

window.addEventListener("resize", () => {
  if (!chart.length) return;

  notesLayer.innerHTML = "";
  chart.forEach((note) => {
    if (!note.judged) createNoteElement(note);
  });
});

async function init() {
  loadSettings();
  setTapTempoState("idle");
  setXmlImportState("no score");
  await loadChartConfig();
  resetGameState();
}

init();
