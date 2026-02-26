const LANE_COUNT = 4;
const HIT_KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK"];
const APPROACH_MS = 2100;

const JUDGE_WINDOWS = {
  perfect: 45,
  great: 95,
  good: 150,
  miss: 210,
};

const scoreMap = {
  perfect: 1000,
  great: 700,
  good: 400,
  miss: 0,
};

const FALLBACK_CHART = {
  title: "Offline Demo Chart",
  artist: "Local",
  audioUrl: "",
  license: "-",
  offsetMs: 1800,
  bpm: 120,
  lengthSec: 30,
  notes: Array.from({ length: 90 }).map((_, i) => ({
    time: 1800 + i * 320,
    lane: [0, 1, 2, 1, 3, 2][i % 6],
  })),
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
const progressEl = document.getElementById("songProgress");
const laneButtons = Array.from(document.querySelectorAll(".lane"));

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
    progressEl.textContent = "Chart load failed: fallback";
    console.warn(err);
  }

  songTitleEl.textContent = `${chartConfig.title} / ${chartConfig.artist}`;
  createAudioForChart();
}

function createNoteElement(note) {
  const el = document.createElement("div");
  el.className = "note" + (note.lane % 2 ? " alt" : "");
  notesLayer.appendChild(el);
  note.element = el;
}

function buildChartFromConfig() {
  return chartConfig.notes.map((n) => ({
    lane: n.lane,
    hitTime: n.time,
    judged: false,
    element: null,
  }));
}

function resetGameState() {
  clearCountdown();
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  useSynthBgm = false;
  bgmStep = 0;
  nextBgmMs = 0;

  chart = buildChartFromConfig();
  notesLayer.innerHTML = "";
  chart.forEach(createNoteElement);

  score = 0;
  combo = 0;
  updateScoreUI();
  setJudge("-");
  hitFeedbackEl.classList.add("hidden");
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
  useSynthBgm = false;
  bgmStep = 0;
  nextBgmMs = 0;

  if (audio) {
    audio.currentTime = 0;
    audio.play().catch((err) => {
      console.warn("audio play failed", err);
      useSynthBgm = true;
      progressEl.textContent = "Playing (synth BGM)";
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
  }, 2100));
}

function stopGame() {
  gameRunning = false;
  progressEl.textContent = "Finished";
  if (rafId) cancelAnimationFrame(rafId);
  if (audio) audio.pause();
  useSynthBgm = false;
  playEndCue();
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

  if (judge === "miss") {
    combo = 0;
  } else {
    combo += 1;
    score += combo * 8;
  }

  updateScoreUI();
}

function applyEmptyHitMiss() {
  setJudge("miss");
  showHitFeedback("miss");
  combo = 0;
  updateScoreUI();
}

function pressLane(laneIndex) {
  if (!gameRunning) return;

  const now = performance.now() - startedAt;
  let best = null;

  for (const note of chart) {
    if (note.judged || note.lane !== laneIndex) continue;

    const delta = now - note.hitTime;
    const abs = Math.abs(delta);

    if (delta < -JUDGE_WINDOWS.miss) {
      break;
    }

    if (abs <= JUDGE_WINDOWS.miss && (!best || abs < best.abs)) {
      best = { note, abs };
    }
  }

  if (best) {
    const judge = judgeDelta(best.abs) || "miss";
    applyJudge(best.note, judge);
  } else {
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
  const judgeLineY = playfield.clientHeight - 110;

  for (const note of chart) {
    if (note.judged) continue;

    const dt = note.hitTime - nowMs;
    const linear = clamp01(1 - dt / APPROACH_MS);
    const depth = Math.pow(linear, 1.15);
    const y = farY + (judgeLineY - farY) * depth;

    const scale = 0.58 + depth * 1.2;
    const noteW = 92 * scale;
    const noteH = 26 * scale;
    const x = laneCenterAtDepth(note.lane, depth) - noteW / 2;
    const skew = (note.lane - 1.5) * -1.8 * (1 - depth);

    if (note.element) {
      note.element.style.left = `${x}px`;
      note.element.style.top = `${y - noteH / 2}px`;
      note.element.style.width = `${noteW}px`;
      note.element.style.height = `${noteH}px`;
      note.element.style.transform = `skewX(${skew.toFixed(2)}deg)`;
      note.element.style.opacity = String(0.55 + depth * 0.45);
    }

    if (dt < -JUDGE_WINDOWS.miss) {
      applyJudge(note, "miss");
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

function loop() {
  if (!gameRunning) return;

  const now = performance.now() - startedAt;
  tickSynthBgm(now);
  updateNotes(now);

  const sec = Math.min(chartConfig.lengthSec, now / 1000);
  progressEl.textContent = `Playing ${sec.toFixed(1)}s / ${chartConfig.lengthSec}s`;

  if (now >= chartConfig.lengthSec * 1000 + 800) {
    stopGame();
    return;
  }

  rafId = requestAnimationFrame(loop);
}

function flashLane(index) {
  const lane = laneButtons[index];
  if (!lane) return;
  lane.classList.add("active");
  setTimeout(() => lane.classList.remove("active"), 80);
}

document.addEventListener("keydown", (event) => {
  const laneIndex = HIT_KEYS.indexOf(event.code);
  if (laneIndex < 0) return;
  flashLane(laneIndex);
  pressLane(laneIndex);
});

laneButtons.forEach((lane, i) => {
  lane.addEventListener("pointerdown", () => {
    flashLane(i);
    pressLane(i);
  });
});

startBtn.addEventListener("click", () => {
  if (rafId) cancelAnimationFrame(rafId);
  resetGameState();
  startGame();
});

window.addEventListener("resize", () => {
  if (!chart.length) return;

  notesLayer.innerHTML = "";
  chart.forEach((note) => {
    if (!note.judged) createNoteElement(note);
  });
});

async function init() {
  await loadChartConfig();
  resetGameState();
}

init();
