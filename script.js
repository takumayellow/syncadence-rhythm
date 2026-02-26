const LANE_COUNT = 4;
const HIT_KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK"];
const BASE_APPROACH_MS = 2100;
const NOTE_BASE_WIDTH = 118;

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
const progressEl = document.getElementById("songProgress");
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
  speedRangeEl.value = String(noteSpeed);
  speedValueEl.textContent = noteSpeed.toFixed(1);
}

function saveSettings() {
  localStorage.setItem("pjsk_note_speed", String(noteSpeed));
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
    durationMs: n.duration || 0,
    holdEndTime: n.duration ? (n.time + n.duration) : n.time,
    judged: false,
    holding: false,
    holdBroken: false,
    element: null,
    lastStyleKey: "",
  }));
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
  bgmStep = 0;
  nextBgmMs = 0;

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
    audio.play().catch((err) => {
      console.warn("audio start failed", err);
      if (switchToFallbackAudioUrl()) {
        audio.play().then(() => {
          useSynthBgm = false;
          progressEl.textContent = "Playing (fallback audio)";
        }).catch(() => {
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

function startHoldNote(note, startJudge) {
  note.holding = true;
  setJudge(startJudge);
  showHitFeedback("great");
  score += Math.floor((scoreMap[startJudge] || 500) * 0.4);
  updateScoreUI();
}

function finishHoldNote(note, success) {
  note.judged = true;
  note.holding = false;
  if (note.element) note.element.remove();

  if (success) {
    setJudge("perfect");
    showHitFeedback("perfect");
    combo += 1;
    score += 1200 + combo * 10;
  } else {
    setJudge("miss");
    showHitFeedback("miss");
    combo = 0;
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

  const now = getSongTimeMs();
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
    if (best.note.durationMs > 0 && judge !== "miss") {
      startHoldNote(best.note, judge);
    } else {
      applyJudge(best.note, judge);
    }
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

    if (dt < -JUDGE_WINDOWS.miss) {
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
    const noteWHead = NOTE_BASE_WIDTH * scaleHead;
    const noteHHead = 26 * scaleHead;
    const xHead = laneCenterAtDepth(note.lane, depthHead) - noteWHead / 2;
    const skew = (note.lane - 1.5) * -1.8 * (1 - depthHead);

    if (note.element) {
      let drawX = xHead;
      let drawY = yHead - noteHHead / 2;
      let drawW = noteWHead;
      let drawH = noteHHead;

      if (note.durationMs > 0) {
        const top = Math.min(yHead, yTail);
        const bottom = Math.max(yHead, yTail);
        drawY = top - noteHHead * 0.45;
        drawH = Math.max(noteHHead, (bottom - top) + noteHHead * 0.9);
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
      ].join("|");

      if (styleKey !== note.lastStyleKey) {
        note.lastStyleKey = styleKey;
        note.element.style.display = "block";
        note.element.style.left = `${drawX}px`;
        note.element.style.top = `${drawY}px`;
        note.element.style.width = `${drawW}px`;
        note.element.style.height = `${drawH}px`;
        note.element.style.transform = `skewX(${skew.toFixed(2)}deg)`;
        note.element.style.opacity = String(0.55 + depthHead * 0.45);
      }
    }
  }
}

function updateHoldNotes(nowMs) {
  for (const note of chart) {
    if (note.judged || !note.holding) continue;

    if (!lanePressed[note.lane] && nowMs < note.holdEndTime - HOLD_EARLY_RELEASE_TOLERANCE_MS) {
      note.holdBroken = true;
      finishHoldNote(note, false);
      continue;
    }

    if (nowMs >= note.holdEndTime) {
      finishHoldNote(note, !note.holdBroken);
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
    return audio.currentTime * 1000;
  }
  return performance.now() - startedAt;
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
  const laneIndex = HIT_KEYS.indexOf(event.code);
  if (laneIndex < 0) return;
  if (event.repeat) return;
  lanePressed[laneIndex] = true;
  flashLane(laneIndex);
  pressLane(laneIndex);
});

document.addEventListener("keyup", (event) => {
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

window.addEventListener("resize", () => {
  if (!chart.length) return;

  notesLayer.innerHTML = "";
  chart.forEach((note) => {
    if (!note.judged) createNoteElement(note);
  });
});

async function init() {
  loadSettings();
  await loadChartConfig();
  resetGameState();
}

init();
