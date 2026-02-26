const LANE_COUNT = 4;
const HIT_KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK"];
const SONG_LENGTH_SEC = 30;
const APPROACH_MS = 1800;

const JUDGE_WINDOWS = {
  perfect: 45,
  great: 90,
  good: 140,
  miss: 200,
};

const scoreMap = {
  perfect: 1000,
  great: 700,
  good: 400,
  miss: 0,
};

const scoreEl = document.getElementById("score");
const comboEl = document.getElementById("combo");
const judgeEl = document.getElementById("judge");
const notesLayer = document.getElementById("notes-layer");
const playfield = document.getElementById("playfield");
const startBtn = document.getElementById("startBtn");
const restartBtn = document.getElementById("restartBtn");
const progressEl = document.getElementById("songProgress");
const laneButtons = Array.from(document.querySelectorAll(".lane"));

let chart = [];
let startedAt = 0;
let gameRunning = false;
let score = 0;
let combo = 0;
let rafId = null;

function seededRandom(seed) {
  let t = seed;
  return () => {
    t = (t * 1664525 + 1013904223) % 4294967296;
    return t / 4294967296;
  };
}

function buildChart() {
  const rnd = seededRandom(4625090);
  const notes = [];
  let time = 1200;

  while (time < SONG_LENGTH_SEC * 1000) {
    const lane = Math.floor(rnd() * LANE_COUNT);
    notes.push({
      lane,
      hitTime: time,
      judged: false,
      element: null,
    });

    // Slightly syncopated interval for rhythm-game feeling.
    const step = 220 + Math.floor(rnd() * 180);
    time += step;
  }

  return notes;
}

function createNoteElement(note) {
  const laneWidth = playfield.clientWidth / LANE_COUNT;
  const el = document.createElement("div");
  el.className = "note" + (note.lane % 2 ? " alt" : "");
  el.style.width = `${laneWidth - 18}px`;
  el.style.left = `${note.lane * laneWidth + 9}px`;
  el.style.top = "-30px";
  notesLayer.appendChild(el);
  note.element = el;
}

function resetGameState() {
  chart = buildChart();
  notesLayer.innerHTML = "";
  chart.forEach(createNoteElement);

  score = 0;
  combo = 0;
  updateScoreUI();
  setJudge("-");
  progressEl.textContent = "Ready";
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

function startGame() {
  if (gameRunning) return;
  startedAt = performance.now();
  gameRunning = true;
  progressEl.textContent = "Playing";
  loop();
}

function stopGame() {
  gameRunning = false;
  progressEl.textContent = "Finished";
  if (rafId) cancelAnimationFrame(rafId);
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
  score += scoreMap[judge];

  if (judge === "miss") {
    combo = 0;
  } else {
    combo += 1;
    score += combo * 8;
  }

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
  }
}

function updateNotes(nowMs) {
  const judgeLineY = playfield.clientHeight - 120;

  for (const note of chart) {
    if (note.judged) continue;

    const dt = note.hitTime - nowMs;
    const progress = 1 - dt / APPROACH_MS;
    const y = progress * judgeLineY;

    if (note.element) {
      note.element.style.top = `${Math.max(-30, y)}px`;
    }

    if (dt < -JUDGE_WINDOWS.miss) {
      applyJudge(note, "miss");
    }
  }
}

function loop() {
  if (!gameRunning) return;

  const now = performance.now() - startedAt;
  updateNotes(now);

  const sec = Math.min(SONG_LENGTH_SEC, now / 1000);
  progressEl.textContent = `Playing ${sec.toFixed(1)}s / ${SONG_LENGTH_SEC}s`;

  if (now >= SONG_LENGTH_SEC * 1000 + 1500) {
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

startBtn.addEventListener("click", startGame);
restartBtn.addEventListener("click", () => {
  if (rafId) cancelAnimationFrame(rafId);
  gameRunning = false;
  resetGameState();
});

window.addEventListener("resize", () => {
  if (!chart.length) return;

  notesLayer.innerHTML = "";
  chart.forEach((note) => {
    if (!note.judged) createNoteElement(note);
  });
});

resetGameState();
