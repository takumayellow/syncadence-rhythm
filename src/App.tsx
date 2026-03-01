import { useEffect, useMemo, useRef, useState } from "react";
import { parseMusicXml } from "./musicxml";
import { parseMidi } from "./midi";
import { extractMusicXmlFromMxl } from "./mxl";
import type { Judge, PlayNote, ScoreEvent, ScoreMeta } from "./types";

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

const SCORE_MAP: Record<Judge, number> = {
  perfect: 1000,
  great: 700,
  good: 400,
  miss: 0,
};

const defaultScore: ScoreMeta = {
  id: "lian-ai-cai-pan-40mp",
  title: "shishiriennu-zuo-pin78-to-duan-diao",
  artist: "Score + MP3",
  audioUrl: "/scores/songs/shishiriennu-op78-etude/audio.mp3",
  mxlPath: "/scores/songs/shishiriennu-op78-etude/score.mxl",
  strictMode: true,
  offsetMs: -120,
  bpm: 100,
  lengthSec: 240,
};

type Runtime = {
  chart: PlayNote[];
  chartEndMs: number;
  mediaDurationMs: number;
  gameRunning: boolean;
  startedAt: number;
  rafId: number | null;
  audio: HTMLAudioElement | null;
  audioCtx: AudioContext | null;
  synthEvents: ScoreEvent[];
  synthCursor: number;
  lastProgressUpdateMs: number;
  countdown: number[];
  lanePressed: boolean[];
  laneFlashTokens: number[];
  importedEvents: ScoreEvent[];
  midiPlaybackEvents: ScoreEvent[];
  chartSourceMode: "grid" | "score";
  achievedPoints: number;
  possiblePoints: number;
  missCount: number;
  combo: number;
  score: number;
  useSynthBgm: boolean;
  awaitingAudioStart: boolean;
};

function laneCenterAtDepth(lane: number, depth: number, width: number): number {
  const center = width / 2;
  const nearSpread = width * 0.92;
  const farSpread = width * 0.38;
  const t = (lane + 0.5) / LANE_COUNT - 0.5;
  const xNear = center + t * nearSpread;
  const xFar = center + t * farSpread;
  return xFar + (xNear - xFar) * depth;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function quantizeBeat(x: number): number {
  const cands = [1, 0.5, 1 / 3];
  let best = cands[0];
  let bestDiff = Math.abs(x - best);
  for (const c of cands) {
    const d = Math.abs(x - c);
    if (d < bestDiff) {
      best = c;
      bestDiff = d;
    }
  }
  return best;
}

function estimateBpmFromTimedEvents(events: ScoreEvent[]): number {
  const times = events
    .map((e) => e.timeMs)
    .filter((t): t is number => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < 4) return 120;
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const d = times[i] - times[i - 1];
    if (d > 70 && d < 1600) diffs.push(d);
  }
  if (!diffs.length) return 120;
  const m = median(diffs);
  const bpm = 60000 / Math.max(1, m);
  return Math.max(50, Math.min(180, bpm));
}

function estimateBpmForBeatScore(events: ScoreEvent[], mediaDurationMs: number): number | null {
  if (!events.length || !Number.isFinite(mediaDurationMs) || mediaDurationMs <= 0) return null;
  const beatBased = events.filter((e) => !Number.isFinite(e.timeMs));
  if (!beatBased.length) return null;
  const lastBeat = Math.max(
    ...beatBased.map((e) => e.beatPos + Math.max(0.25, e.durationBeats || 0))
  );
  if (!Number.isFinite(lastBeat) || lastBeat <= 0.1) return null;
  const leadInMs = 550;
  const tailMs = 24;
  const playableMs = Math.max(1200, mediaDurationMs - leadInMs - tailMs);
  const bpm = (lastBeat * 60000) / playableMs;
  if (!Number.isFinite(bpm)) return null;
  return Math.max(40, Math.min(220, bpm));
}

function isMidiUrl(url: string): boolean {
  return /\.mid(i)?$/i.test(url);
}

function simplifyEventsForRhythm(events: ScoreEvent[], bpm: number): ScoreEvent[] {
  if (!events.length) return [];
  const beatMs = 60000 / Math.max(1, bpm);
  const absEvents = events
    .map((e) => {
      const timeMs = Number.isFinite(e.timeMs) ? (e.timeMs as number) : e.beatPos * beatMs;
      const durMs = Number.isFinite(e.durationMs) ? (e.durationMs as number) : e.durationBeats * beatMs;
      return { ...e, timeMs, durationMs: Math.max(0, durMs) };
    })
    .sort((a, b) => (a.timeMs as number) - (b.timeMs as number));

  const grouped = new Map<number, ScoreEvent[]>();
  for (const e of absEvents) {
    // Collapse near-simultaneous chord notes but keep original absolute timing.
    const key = Math.round((e.timeMs as number) / 22);
    const list = grouped.get(key) ?? [];
    list.push(e);
    grouped.set(key, list);
  }

  const selected: ScoreEvent[] = [];
  for (const [k, list] of grouped) {
    const byPitch = [...list].sort((a, b) => a.midi - b.midi);
    const melodyLike = byPitch[Math.min(byPitch.length - 1, Math.floor(byPitch.length * 0.68))];
    const out = [melodyLike].map((e) => ({ ...e, timeMs: e.timeMs }));
    selected.push(...out);
  }

  selected.sort((a, b) => (a.timeMs as number) - (b.timeMs as number));
  const minGap = Math.max(190, beatMs * 0.5);
  const thinned: ScoreEvent[] = [];
  for (const e of selected) {
    const prev = thinned[thinned.length - 1];
    if (!prev) {
      thinned.push(e);
      continue;
    }
    const dt = (e.timeMs as number) - (prev.timeMs as number);
    if (dt < minGap) {
      continue;
    }
    thinned.push(e);
  }
  return thinned;
}

function removeOverlapsWithLongNotes(notes: PlayNote[]): PlayNote[] {
  if (!notes.length) return notes;
  const sorted = [...notes].sort((a, b) => a.hitTime - b.hitTime);
  const kept: PlayNote[] = [];
  const holdWindows: Array<{ start: number; end: number; lane: number }> = [];
  const headGuard = 40;
  const tailGuard = 90;

  for (const n of sorted) {
    if (n.durationMs > 0) {
      const overlapLong = holdWindows.some(
        (w) => n.lane === w.lane && n.hitTime < w.end + 80 && n.holdEndTime > w.start - 80
      );
      if (overlapLong) continue;
      kept.push(n);
      holdWindows.push({ start: n.hitTime - headGuard, end: n.holdEndTime + tailGuard, lane: n.lane });
      continue;
    }

    const overlapTap = holdWindows.some((w) => n.lane === w.lane && n.hitTime >= w.start && n.hitTime <= w.end);
    if (overlapTap) continue;
    kept.push(n);
  }

  return kept;
}

function fitChartToSongDuration(chart: PlayNote[], mediaDurationMs: number): PlayNote[] {
  if (!chart.length || !Number.isFinite(mediaDurationMs) || mediaDurationMs <= 0) return chart;
  const sorted = [...chart].sort((a, b) => a.hitTime - b.hitTime);
  const desiredLast = Math.max(0, mediaDurationMs - 24);
  const minLeadIn = 550;
  const first = sorted[0].hitTime;
  const shift = first < minLeadIn ? (minLeadIn - first) : 0;

  const adjusted = sorted
    .map((n) => {
      const hit = n.hitTime + shift;
      const end = n.holdEndTime + shift;
      const clampedHit = Math.max(0, Math.min(desiredLast, hit));
      const clampedEnd = Math.max(clampedHit, Math.min(desiredLast, end));
      return {
        ...n,
        hitTime: clampedHit,
        holdEndTime: clampedEnd,
        durationMs: Math.max(0, clampedEnd - clampedHit),
      };
    })
    .filter((n) => n.hitTime <= desiredLast + 4);

  return adjusted;
}

function isSparseChart(chart: PlayNote[], mediaDurationMs: number): boolean {
  if (!chart.length || mediaDurationMs <= 0) return true;
  const durationSec = mediaDurationMs / 1000;
  const first = chart[0].hitTime;
  const last = Math.max(...chart.map((n) => Math.max(n.hitTime, n.holdEndTime)));
  const coverageRatio = Math.max(0, last - first) / mediaDurationMs;
  const density = chart.length / Math.max(1, durationSec);
  return chart.length < 56 || coverageRatio < 0.76 || density < 0.42;
}

function buildSupportNotes(mediaDurationMs: number, bpm: number): PlayNote[] {
  const beatMs = 60000 / Math.max(1, bpm);
  const flow = [1, 0.5, 1, 1 / 3, 1 / 3, 1 / 3, 1, 0.5, 0.5, 1];
  const lanes = [1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 2, 3, 2, 1, 0];
  const out: PlayNote[] = [];
  let t = 1200;
  let i = 0;
  const endMs = Math.max(1300, mediaDurationMs - 120);
  while (t <= endMs) {
    out.push({
      lane: lanes[i % lanes.length],
      hitTime: Math.round(t),
      durationMs: 0,
      holdEndTime: Math.round(t),
      judged: false,
      holding: false,
      holdBroken: false,
      headJudged: false,
      tailJudged: false,
      element: null,
      lastStyleKey: "",
    });
    t += beatMs * flow[i % flow.length];
    i += 1;
  }
  return out;
}

function mergeChartWithSupport(base: PlayNote[], support: PlayNote[]): PlayNote[] {
  const merged = [...base];
  for (const s of support) {
    const near = merged.some((n) => Math.abs(n.hitTime - s.hitTime) < 160);
    if (!near) merged.push(s);
  }
  merged.sort((a, b) => a.hitTime - b.hitTime);
  return merged;
}

function ensureTailNote(chart: PlayNote[], mediaDurationMs: number): PlayNote[] {
  if (mediaDurationMs <= 0) return chart;
  const target = Math.max(1200, Math.round(mediaDurationMs - 24));
  const nearTail = chart.some((n) => Math.abs((n.durationMs > 0 ? n.holdEndTime : n.hitTime) - target) <= 70);
  if (nearTail) return chart;
  const occupied = new Set<number>();
  for (const n of chart) {
    if (n.durationMs > 0 && target >= n.hitTime - 20 && target <= n.holdEndTime + 20) occupied.add(n.lane);
  }
  let lane = 1;
  for (let i = 0; i < LANE_COUNT; i += 1) {
    if (!occupied.has(i)) {
      lane = i;
      break;
    }
  }
  return [
    ...chart,
    {
      lane,
      hitTime: target,
      durationMs: 0,
      holdEndTime: target,
      judged: false,
      holding: false,
      holdBroken: false,
      headJudged: false,
      tailJudged: false,
      element: null,
      lastStyleKey: "",
    },
  ].sort((a, b) => a.hitTime - b.hitTime);
}

function chooseLaneFromMidi(midi: number, minMidi: number, maxMidi: number): number {
  const tNorm = (midi - minMidi) / Math.max(1, maxMidi - minMidi);
  return Math.max(0, Math.min(3, Math.floor(tNorm * 4)));
}

function assignLanesForFlow(events: ScoreEvent[], bpm: number): number[] {
  if (!events.length) return [];
  const beatMs = 60000 / Math.max(1, bpm);
  const minMidi = Math.min(...events.map((e) => e.midi));
  const maxMidi = Math.max(...events.map((e) => e.midi));
  const lanes: number[] = [];
  let prevLane = -1;
  let prevMidi = events[0].midi;
  let sameStreak = 0;

  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const pref = chooseLaneFromMidi(e.midi, minMidi, maxMidi);
    const prev = i > 0 ? events[i - 1] : null;
    const dt = prev ? ((e.timeMs ?? e.beatPos * beatMs) - (prev.timeMs ?? prev.beatPos * beatMs)) : Number.POSITIVE_INFINITY;
    const shortGap = dt < beatMs * 0.58;
    const veryShortGap = dt < beatMs * 0.36;
    const pitchDir = Math.sign(e.midi - prevMidi);

    let bestLane = pref;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      let score = 0;
      score += Math.abs(lane - pref) * 1.15;
      if (prevLane >= 0) score += Math.abs(lane - prevLane) * 0.28;
      if (lane === prevLane && shortGap) score += 1.45;
      if (lane === prevLane && veryShortGap) score += 1.2;
      if (sameStreak >= 1 && lane === prevLane) score += 1.8;
      if (sameStreak >= 2 && lane === prevLane) score += 3.8;
      if (pitchDir > 0 && prevLane >= 0 && lane < prevLane) score += 0.55;
      if (pitchDir < 0 && prevLane >= 0 && lane > prevLane) score += 0.55;
      if ((e.durationMs ?? 0) > beatMs * 0.95) {
        if (prevLane >= 0 && lane !== prevLane) score += 0.35;
      }
      if (score < bestScore) {
        bestScore = score;
        bestLane = lane;
      }
    }

    lanes.push(bestLane);
    if (bestLane === prevLane) sameStreak += 1;
    else sameStreak = 0;
    prevLane = bestLane;
    prevMidi = e.midi;
  }
  return lanes;
}

function assignLanesStrict(events: ScoreEvent[]): number[] {
  if (!events.length) return [];
  const minMidi = Math.min(...events.map((e) => e.midi));
  const maxMidi = Math.max(...events.map((e) => e.midi));
  return events.map((e) => chooseLaneFromMidi(e.midi, minMidi, maxMidi));
}

async function fetchMusicXml(meta: ScoreMeta): Promise<ScoreEvent[]> {
  if (meta.mxlPath) {
    const res = await fetch(meta.mxlPath);
    if (!res.ok) throw new Error("mxl not found");
    const xml = await extractMusicXmlFromMxl(await res.arrayBuffer());
    return parseMusicXml(xml);
  }
  if (meta.xmlPath) {
    const res = await fetch(meta.xmlPath);
    if (!res.ok) throw new Error("xml not found");
    return parseMusicXml(await res.text());
  }
  return [];
}

async function fetchMidiEvents(meta: ScoreMeta): Promise<ScoreEvent[]> {
  if (!meta.midiPath) return [];
  const res = await fetch(meta.midiPath);
  if (!res.ok) throw new Error("midi not found");
  const midiNotes = parseMidi(await res.arrayBuffer());
  return midiNotes.map((n) => ({
    beatPos: 0,
    durationBeats: 0,
    midi: n.midi,
    timeMs: n.timeMs,
    durationMs: n.durationMs,
  }));
}

function mergeScoreAndMidi(scoreEvents: ScoreEvent[], midiEvents: ScoreEvent[]): ScoreEvent[] {
  // If both exist, keep the score note order/pitch while mapping timestamps from MIDI.
  if (scoreEvents.length && midiEvents.length) {
    const sLen = scoreEvents.length;
    const mLen = midiEvents.length;
    if (sLen === 1) {
      const m = midiEvents[0];
      return [{
        ...scoreEvents[0],
        timeMs: m.timeMs,
        durationMs: m.durationMs,
      }];
    }
    return scoreEvents.map((s, i) => {
      const ratio = i / Math.max(1, sLen - 1);
      const mIdx = Math.max(0, Math.min(mLen - 1, Math.round(ratio * (mLen - 1))));
      const m = midiEvents[mIdx];
      return {
        ...s,
        timeMs: m.timeMs,
        durationMs: m.durationMs,
      };
    });
  }
  if (midiEvents.length) return midiEvents;
  if (scoreEvents.length) return scoreEvents;
  return midiEvents;
}

export default function App(): JSX.Element {
  const playfieldRef = useRef<HTMLDivElement>(null);
  const notesLayerRef = useRef<HTMLDivElement>(null);
  const laneVisualRefs = useRef<SVGPolygonElement[]>([]);

  const settingsRef = useRef({
    noteSpeed: 15,
    timingOffsetMs: 0,
    chartTempoBpm: 66,
    judgeLineOffsetPx: 110,
  });

  const runtimeRef = useRef<Runtime>({
    chart: [],
    chartEndMs: defaultScore.lengthSec * 1000,
    mediaDurationMs: defaultScore.lengthSec * 1000,
    gameRunning: false,
    startedAt: 0,
    rafId: null,
    audio: null,
    audioCtx: null,
    synthEvents: [],
    synthCursor: 0,
    lastProgressUpdateMs: 0,
    countdown: [],
    lanePressed: [false, false, false, false],
    laneFlashTokens: [0, 0, 0, 0],
    importedEvents: [],
    midiPlaybackEvents: [],
    chartSourceMode: "grid",
    achievedPoints: 0,
    possiblePoints: 0,
    missCount: 0,
    combo: 0,
    score: 0,
    useSynthBgm: false,
    awaitingAudioStart: false,
  });

  const [scores, setScores] = useState<ScoreMeta[]>([defaultScore]);
  const [selectedScoreId, setSelectedScoreId] = useState(defaultScore.id);
  const selectedScore = useMemo(
    () => scores.find((s) => s.id === selectedScoreId) ?? defaultScore,
    [scores, selectedScoreId]
  );

  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [judge, setJudge] = useState("-");
  const [progress, setProgress] = useState("Ready");
  const [songTitle, setSongTitle] = useState("Loading...");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customAudioUrl, setCustomAudioUrl] = useState<string | null>(null);
  const [customAudioName, setCustomAudioName] = useState<string>("");
  const [noteSpeed, setNoteSpeed] = useState(15);
  const [timingOffsetMs, setTimingOffsetMs] = useState(0);
  const [chartTempoBpm, setChartTempoBpmState] = useState(66);
  const [judgeLineOffsetPx, setJudgeLineOffsetPxState] = useState(110);
  const [tapTempoState, setTapTempoState] = useState("idle");
  const [tapTempoMode, setTapTempoMode] = useState(false);
  const [tapTimes, setTapTimes] = useState<number[]>([]);
  const [xmlImportState, setXmlImportState] = useState("no score");
  const [countdownText, setCountdownText] = useState("");
  const [hitFeedback, setHitFeedback] = useState<{ text: string; className: string; visible: boolean }>({
    text: "",
    className: "judge-perfect",
    visible: false,
  });
  const [result, setResult] = useState<{show:boolean;state:string;rank:string;acc:string;score:string}>({
    show:false,state:"CLEAR!",rank:"RANK A",acc:"0.0%",score:"0"
  });
  const feedbackTimerRef = useRef<number | null>(null);
  const customAudioObjectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const savedSpeed = Number(localStorage.getItem("pjsk_note_speed"));
    const savedTiming = Number(localStorage.getItem("pjsk_timing_offset_ms"));
    const savedTempo = Number(localStorage.getItem("pjsk_chart_tempo_bpm"));
    const savedJudge = Number(localStorage.getItem("pjsk_judge_line_px"));
    if (Number.isFinite(savedSpeed) && savedSpeed >= 6 && savedSpeed <= 15) setNoteSpeed(savedSpeed);
    if (Number.isFinite(savedTiming) && savedTiming >= -300 && savedTiming <= 300) setTimingOffsetMs(savedTiming);
    if (Number.isFinite(savedTempo) && savedTempo >= 50 && savedTempo <= 110) setChartTempoBpmState(savedTempo);
    if (Number.isFinite(savedJudge) && savedJudge >= 70 && savedJudge <= 180) setJudgeLineOffsetPxState(savedJudge);
  }, []);

  useEffect(() => {
    settingsRef.current = { noteSpeed, timingOffsetMs, chartTempoBpm, judgeLineOffsetPx };
    localStorage.setItem("pjsk_note_speed", String(noteSpeed));
    localStorage.setItem("pjsk_timing_offset_ms", String(Math.round(timingOffsetMs)));
    localStorage.setItem("pjsk_chart_tempo_bpm", String(chartTempoBpm));
    localStorage.setItem("pjsk_judge_line_px", String(Math.round(judgeLineOffsetPx)));
    if (playfieldRef.current) {
      playfieldRef.current.style.setProperty("--judge-line-bottom", `${judgeLineOffsetPx}px`);
    }
  }, [noteSpeed, timingOffsetMs, chartTempoBpm, judgeLineOffsetPx]);

  useEffect(() => {
    fetch("/scores/index.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("score index not found"))))
      .then((list: ScoreMeta[]) => {
        if (Array.isArray(list) && list.length) {
          setScores(list);
          setSelectedScoreId(list[0].id);
        }
      })
      .catch(() => {
        setScores([defaultScore]);
        setSelectedScoreId(defaultScore.id);
      });
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
      }
      if (customAudioObjectUrlRef.current) {
        URL.revokeObjectURL(customAudioObjectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setSongTitle(`${selectedScore.title} / ${selectedScore.artist}`);
    if (customAudioObjectUrlRef.current) {
      URL.revokeObjectURL(customAudioObjectUrlRef.current);
      customAudioObjectUrlRef.current = null;
    }
    setCustomAudioUrl(null);
    setCustomAudioName("");
    setChartTempoBpmState(selectedScore.bpm || 66);
    const rt = runtimeRef.current;
    rt.importedEvents = [];
    rt.midiPlaybackEvents = [];
    rt.chartSourceMode = "grid";
    setXmlImportState("loading...");
    Promise.allSettled([fetchMusicXml(selectedScore), fetchMidiEvents(selectedScore)])
      .then((all) => {
        const scoreEvents = all[0].status === "fulfilled" ? all[0].value : [];
        const midiEvents = all[1].status === "fulfilled" ? all[1].value : [];
        if (midiEvents.length) {
          setChartTempoBpmState(estimateBpmFromTimedEvents(midiEvents));
        }
        rt.midiPlaybackEvents = midiEvents;
        rt.importedEvents = mergeScoreAndMidi(scoreEvents, midiEvents);
        if (rt.importedEvents.length > 0) {
          rt.chartSourceMode = "score";
          const hasMxl = !!selectedScore.mxlPath;
          const hasMidi = !!selectedScore.midiPath;
          const mode = hasMxl && hasMidi ? "mxl+midi synced" : hasMxl ? "mxl" : hasMidi ? "midi" : "xml";
          setXmlImportState(`score: ${mode}`);
        } else {
          setXmlImportState("no score");
        }
      })
      .finally(() => resetGame());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScoreId]);

  function generateGridEvents(bpm: number): ScoreEvent[] {
    const flow = [1, 0.5, 1, 1 / 3, 1 / 3, 1 / 3, 1, 0.5, 0.5, 1, 1, 1 / 3, 1 / 3, 1 / 3, 1];
    const lanes = [1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 2, 3, 2, 1, 0];
    const beatLimit = Math.floor((selectedScore.lengthSec * bpm) / 60) - 2;
    const out: ScoreEvent[] = [];
    let beat = 0;
    let i = 0;
    while (beat < beatLimit) {
      out.push({ beatPos: beat, durationBeats: i % 24 === 8 ? 1.5 : i % 48 === 32 ? 2 : 0.5, midi: 60 + lanes[i % lanes.length] * 2 });
      beat += quantizeBeat(flow[i % flow.length]);
      i += 1;
    }
    return out;
  }

  function eventsToNotes(events: ScoreEvent[], bpm: number, strictMode = false): PlayNote[] {
    const source = strictMode
      ? events
          .map((e) => ({
            ...e,
            timeMs: Number.isFinite(e.timeMs) ? e.timeMs : e.beatPos * (60000 / Math.max(1, bpm)),
            durationMs: Number.isFinite(e.durationMs) ? e.durationMs : e.durationBeats * (60000 / Math.max(1, bpm)),
          }))
          .sort((a, b) => (a.timeMs as number) - (b.timeMs as number))
      : simplifyEventsForRhythm(events, bpm);
    if (!source.length) return [];
    const beatMs = 60000 / bpm;
    const lanePlan = strictMode ? assignLanesStrict(source) : assignLanesForFlow(source, bpm);
    const base = source.map((e, idx) => {
      const lane = lanePlan[idx] ?? 1;
      const hitTime = Math.round(
        (selectedScore.offsetMs || 0) + (Number.isFinite(e.timeMs) ? (e.timeMs as number) : e.beatPos * beatMs)
      );
      const rawDurationMs = Math.max(0, Number.isFinite(e.durationMs) ? (e.durationMs as number) : e.durationBeats * beatMs);
      return { lane, hitTime, rawDurationMs };
    }).sort((a, b) => a.hitTime - b.hitTime);

    if (strictMode) {
      const strictMapped = base.map((b) => {
        const d = b.rawDurationMs >= 140 ? Math.round(b.rawDurationMs) : 0;
        return {
          lane: b.lane,
          hitTime: b.hitTime,
          durationMs: d,
          holdEndTime: b.hitTime + d,
          judged: false,
          holding: false,
          holdBroken: false,
          headJudged: false,
          tailJudged: false,
          element: null,
          lastStyleKey: "",
        };
      });
      return removeOverlapsWithLongNotes(strictMapped);
    }

    let longCount = 0;
    let lastLongHit = -10_000_000;
    const mapped = base.map((b, i) => {
      const prev = base[i - 1];
      const next = base[i + 1];
      const prevGap = prev ? b.hitTime - prev.hitTime : Number.POSITIVE_INFINITY;
      const nextGap = next ? next.hitTime - b.hitTime : Number.POSITIVE_INFINITY;
      const longCandidate = b.rawDurationMs >= beatMs * 0.85;
      const spacingOK = prevGap >= beatMs * 0.42 && nextGap >= beatMs * 0.42;
      const ratioOK = longCount / Math.max(1, i) < 0.22;
      const cooldownOK = b.hitTime - lastLongHit >= beatMs * 1.25;
      let durationMs = 0;
      if (longCandidate && spacingOK && ratioOK && cooldownOK) {
        durationMs = Math.round(Math.min(beatMs * 2.8, Math.max(beatMs * 0.75, b.rawDurationMs * 0.85)));
        longCount += 1;
        lastLongHit = b.hitTime;
      }
      return {
        lane: b.lane,
        hitTime: b.hitTime,
        durationMs,
        holdEndTime: b.hitTime + durationMs,
        judged: false,
        holding: false,
        holdBroken: false,
        headJudged: false,
        tailJudged: false,
        element: null,
        lastStyleKey: "",
      };
    }).sort((a, b) => a.hitTime - b.hitTime);
    let resolved = removeOverlapsWithLongNotes(mapped);
    const longAfterFilter = resolved.filter((n) => n.durationMs > 0).length;
    if (longAfterFilter === 0) {
      let injected = 0;
      resolved = resolved.map((n, i) => {
        if (injected >= 8 || i % 10 !== 6) return n;
        const src = base[i];
        if (!src || src.rawDurationMs < beatMs * 0.65) return n;
        injected += 1;
        const d = Math.round(Math.min(beatMs * 2.1, Math.max(beatMs * 0.7, src.rawDurationMs * 0.65)));
        return { ...n, durationMs: d, holdEndTime: n.hitTime + d };
      });
      resolved = removeOverlapsWithLongNotes(resolved);
    }
    return resolved;
  }

  function getCurrentEvents(): ScoreEvent[] {
    const rt = runtimeRef.current;
    if (rt.chartSourceMode === "score" && rt.importedEvents.length) return rt.importedEvents;
    return generateGridEvents(settingsRef.current.chartTempoBpm);
  }

  function getEffectiveAudioUrl(): string {
    return customAudioUrl || selectedScore.audioUrl;
  }

  function midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function stopSynthBgm(): void {
    const rt = runtimeRef.current;
    rt.synthEvents = [];
    rt.synthCursor = 0;
    if (rt.audioCtx) {
      rt.audioCtx.close().catch(() => {});
      rt.audioCtx = null;
    }
  }

  function playSynthNote(ctx: AudioContext, midi: number, durationMs: number): void {
    const freq = midiToFreq(midi);
    const dur = Math.max(0.12, Math.min(3.2, (durationMs / 1000) * 0.85));
    const now = ctx.currentTime;

    const mix = ctx.createGain();
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 3200;
    filter.Q.value = 0.8;
    mix.connect(filter);
    filter.connect(env);
    env.connect(ctx.destination);

    const o1 = ctx.createOscillator();
    o1.type = "sine";
    o1.frequency.value = freq;
    const g1 = ctx.createGain();
    g1.gain.value = 0.58;
    o1.connect(g1);
    g1.connect(mix);

    const o2 = ctx.createOscillator();
    o2.type = "triangle";
    o2.frequency.value = freq * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    o2.connect(g2);
    g2.connect(mix);

    const o3 = ctx.createOscillator();
    o3.type = "sine";
    o3.frequency.value = freq * 0.5;
    const g3 = ctx.createGain();
    g3.gain.value = 0.12;
    o3.connect(g3);
    g3.connect(mix);

    const attack = 0.018;
    const decay = 0.16;
    const release = Math.min(0.45, dur * 0.5);
    const sustain = 0.18;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(0.24, now + attack);
    env.gain.exponentialRampToValueAtTime(sustain, now + attack + decay);
    env.gain.setValueAtTime(sustain, now + Math.max(attack + decay, dur - release));
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    o1.start(now);
    o2.start(now);
    o3.start(now);
    o1.stop(now + dur + 0.02);
    o2.stop(now + dur + 0.02);
    o3.stop(now + dur + 0.02);
  }

  function startSynthBgm(): void {
    const rt = runtimeRef.current;
    stopSynthBgm();
    const source = rt.midiPlaybackEvents.length ? rt.midiPlaybackEvents : getCurrentEvents();
    const events = source
      .filter((e) => Number.isFinite(e.timeMs))
      .sort((a, b) => (a.timeMs as number) - (b.timeMs as number));
    if (!events.length) return;
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    rt.audioCtx = ctx;
    rt.synthEvents = events;
    rt.synthCursor = 0;
  }

  function tickSynthBgm(rawMs: number): void {
    const rt = runtimeRef.current;
    if (!rt.useSynthBgm || !rt.audioCtx || !rt.synthEvents.length) return;
    const lookAheadMs = 22;
    while (rt.synthCursor < rt.synthEvents.length) {
      const ev = rt.synthEvents[rt.synthCursor];
      const t = ev.timeMs as number;
      if (t > rawMs + lookAheadMs) break;
      playSynthNote(rt.audioCtx, ev.midi, ev.durationMs ?? 220);
      rt.synthCursor += 1;
    }
  }

  function createNoteElement(note: PlayNote): void {
    if (!notesLayerRef.current) return;
    const el = document.createElement("div");
    el.className = `note${note.lane % 2 ? " alt" : ""}`;
    notesLayerRef.current.appendChild(el);
    note.element = el;
  }

  function rebuildChartForCurrentTime(): void {
    const rt = runtimeRef.current;
    const now = rt.gameRunning ? getTimelineMs() : 0;
    let bpm = settingsRef.current.chartTempoBpm;
    const strictMode = !!selectedScore.strictMode;
    if (rt.chartSourceMode === "score" && rt.importedEvents.length && rt.midiPlaybackEvents.length === 0) {
      const autoBpm = estimateBpmForBeatScore(rt.importedEvents, rt.mediaDurationMs);
      if (autoBpm) bpm = autoBpm;
    }
    let chart = fitChartToSongDuration(eventsToNotes(getCurrentEvents(), bpm, strictMode), rt.mediaDurationMs);
    if (!strictMode && isSparseChart(chart, rt.mediaDurationMs)) {
      const support = buildSupportNotes(rt.mediaDurationMs, bpm);
      chart = fitChartToSongDuration(mergeChartWithSupport(chart, support), rt.mediaDurationMs);
    }
    if (!strictMode) {
      chart = ensureTailNote(chart, rt.mediaDurationMs);
    }
    rt.chart = removeOverlapsWithLongNotes(chart);
    rt.chartEndMs = Math.max(0, rt.mediaDurationMs - 8);
    rt.possiblePoints = rt.chart.reduce((s, n) => s + (n.durationMs > 0 ? 2200 : 1000), 0);
    if (notesLayerRef.current) notesLayerRef.current.innerHTML = "";
    for (const note of rt.chart) {
      if (note.hitTime < now - JUDGE_WINDOWS.miss && note.durationMs === 0) {
        note.judged = true;
      }
      note.element = null;
    }
  }

  function resetGame(): void {
    const rt = runtimeRef.current;
    rt.gameRunning = false;
    rt.awaitingAudioStart = false;
    rt.mediaDurationMs = selectedScore.lengthSec * 1000;
    if (rt.rafId) cancelAnimationFrame(rt.rafId);
    rt.countdown.forEach((t) => clearTimeout(t));
    rt.countdown = [];
    stopSynthBgm();
    rt.useSynthBgm = false;
    if (rt.audio) {
      rt.audio.pause();
      rt.audio.currentTime = 0;
    }
    const effectiveAudio = getEffectiveAudioUrl();
    if (isMidiUrl(effectiveAudio)) {
      rt.audio = null;
    } else {
      rt.audio = new Audio(effectiveAudio);
      rt.audio.preload = "auto";
      rt.audio.crossOrigin = "anonymous";
      rt.audio.onloadedmetadata = () => {
        if (!rt.audio) return;
        const d = rt.audio.duration;
        if (Number.isFinite(d) && d > 0) {
          rt.mediaDurationMs = d * 1000;
          if (!rt.gameRunning) rebuildChartForCurrentTime();
        }
      };
    }
    rt.score = 0;
    rt.combo = 0;
    rt.achievedPoints = 0;
    rt.missCount = 0;
    setScore(0);
    setCombo(0);
    setJudge("-");
    setProgress("Ready");
    setCountdownText("");
    setResult((r) => ({ ...r, show: false }));
    setHitFeedback((v) => ({ ...v, visible: false }));
    rebuildChartForCurrentTime();
  }

  function judgeDelta(abs: number): Judge | null {
    if (abs <= JUDGE_WINDOWS.perfect) return "perfect";
    if (abs <= JUDGE_WINDOWS.great) return "great";
    if (abs <= JUDGE_WINDOWS.good) return "good";
    if (abs <= JUDGE_WINDOWS.miss) return "miss";
    return null;
  }

  function showHitFeedback(j: Judge): void {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setHitFeedback({
      text: j.toUpperCase(),
      className: `judge-${j}`,
      visible: true,
    });
    feedbackTimerRef.current = window.setTimeout(() => {
      setHitFeedback((prev) => ({ ...prev, visible: false }));
      feedbackTimerRef.current = null;
    }, 240);
  }

  function applyJudge(note: PlayNote, j: Judge): void {
    const rt = runtimeRef.current;
    note.judged = true;
    note.element?.remove();
    setJudge(j.toUpperCase());
    rt.score += SCORE_MAP[j];
    if (j === "perfect") rt.achievedPoints += 1000;
    else if (j === "great") rt.achievedPoints += 800;
    else if (j === "good") rt.achievedPoints += 550;
    else rt.missCount += 1;
    if (j === "miss") rt.combo = 0;
    else {
      rt.combo += 1;
      rt.score += rt.combo * 8;
    }
    setScore(rt.score);
    setCombo(rt.combo);
    showHitFeedback(j);
  }

  function judgeLongHead(note: PlayNote, j: Judge): void {
    if (note.headJudged) return;
    const rt = runtimeRef.current;
    note.headJudged = true;
    if (j === "perfect") rt.achievedPoints += 1000;
    else if (j === "great") rt.achievedPoints += 800;
    else if (j === "good") rt.achievedPoints += 550;
    else rt.missCount += 1;
    if (j === "miss") rt.combo = 0;
    else {
      note.holding = true;
      rt.combo += 1;
      rt.score += Math.floor((SCORE_MAP[j] || 500) * 0.45) + rt.combo * 6;
    }
    setJudge(j.toUpperCase());
    setScore(rt.score);
    setCombo(rt.combo);
    showHitFeedback(j);
  }

  function judgeLongTail(note: PlayNote, success: boolean): void {
    if (note.tailJudged) return;
    const rt = runtimeRef.current;
    note.tailJudged = true;
    note.holding = false;
    note.judged = true;
    note.element?.remove();
    if (success) {
      rt.combo += 1;
      rt.score += 1200 + rt.combo * 10;
      rt.achievedPoints += 1200;
      setJudge("PERFECT");
      showHitFeedback("perfect");
    } else {
      rt.combo = 0;
      rt.missCount += 1;
      setJudge("MISS");
      showHitFeedback("miss");
    }
    setScore(rt.score);
    setCombo(rt.combo);
  }

  function startGame(): void {
    const rt = runtimeRef.current;
    if (rt.gameRunning || rt.countdown.length) return;
    setProgress("Counting...");
    setJudge("-");
    setCountdownText("3");

    if (rt.audio) {
      rt.audio.currentTime = 0;
      rt.audio.muted = true;
      rt.audio.play().then(() => {
        rt.audio?.pause();
        if (rt.audio) {
          rt.audio.currentTime = 0;
          rt.audio.muted = false;
        }
      }).catch(() => {
        if (rt.audio) rt.audio.muted = false;
      });
    } else {
      rt.useSynthBgm = true;
    }

    const t1 = window.setTimeout(() => {
      setJudge("3");
      setCountdownText("3");
    }, 0);
    const t2 = window.setTimeout(() => {
      setJudge("2");
      setCountdownText("2");
    }, 700);
    const t3 = window.setTimeout(() => {
      setJudge("1");
      setCountdownText("1");
    }, 1400);
    const t4 = window.setTimeout(() => {
      rt.countdown = [];
      rt.lastProgressUpdateMs = -1000;
      rt.gameRunning = true;
      rt.awaitingAudioStart = true;
      setCountdownText("");
      if (rt.audio) {
        rt.audio.currentTime = 0;
        rt.audio.play().then(() => {
          rt.useSynthBgm = false;
          rt.startedAt = performance.now() - (rt.audio?.currentTime ?? 0) * 1000;
          rt.awaitingAudioStart = false;
        }).catch(() => {
          rt.useSynthBgm = true;
          rt.startedAt = performance.now();
          rt.awaitingAudioStart = false;
          startSynthBgm();
        });
      } else {
        rt.useSynthBgm = true;
        rt.startedAt = performance.now();
        rt.awaitingAudioStart = false;
        startSynthBgm();
      }
      loop();
    }, 2100);
    rt.countdown = [t1, t2, t3, t4];
  }

  function getTimelineMs(): number {
    const rt = runtimeRef.current;
    return !rt.useSynthBgm && rt.audio && Number.isFinite(rt.audio.currentTime)
      ? rt.audio.currentTime * 1000
      : performance.now() - rt.startedAt;
  }

  function getSongTimeMs(): number {
    return getTimelineMs() + settingsRef.current.timingOffsetMs;
  }

  function getRawSongTimeMs(): number {
    return getTimelineMs();
  }

  function updateNotes(nowMs: number): void {
    const rt = runtimeRef.current;
    const pf = playfieldRef.current;
    if (!pf) return;
    const judgeLineY = pf.clientHeight - settingsRef.current.judgeLineOffsetPx;
    const approachMs = BASE_APPROACH_MS * (10 / settingsRef.current.noteSpeed);
    const maxAhead = approachMs + 650;
    const pruneAhead = maxAhead + 520;

    for (const note of rt.chart) {
      if (note.judged) continue;
      const dt = note.hitTime - nowMs;
      if (dt > pruneAhead) {
        if (note.element) {
          note.element.remove();
          note.element = null;
          note.lastStyleKey = "";
        }
        continue;
      }
      if (dt > maxAhead) continue;

      if (note.durationMs > 0) {
        if (!note.headJudged && nowMs > note.hitTime + JUDGE_WINDOWS.miss) judgeLongHead(note, "miss");
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
      const headLinear = clamp01(1 - (headTime - nowMs) / approachMs);
      const tailLinear = clamp01(1 - (tailTime - nowMs) / approachMs);
      const depthHead = Math.pow(headLinear, 1.15);
      const depthTail = Math.pow(tailLinear, 1.15);
      const yHead = 55 + (judgeLineY - 55) * depthHead;
      const yTail = 55 + (judgeLineY - 55) * depthTail;

      const wHead = NOTE_BASE_WIDTH * (0.58 + depthHead * 1.2);
      const wTail = NOTE_BASE_WIDTH * (0.58 + depthTail * 1.2);
      const hHead = 26 * (0.58 + depthHead * 1.2);
      const hTail = 26 * (0.58 + depthTail * 1.2);
      const xHead = laneCenterAtDepth(note.lane, depthHead, pf.clientWidth) - wHead / 2;
      const xTail = laneCenterAtDepth(note.lane, depthTail, pf.clientWidth) - wTail / 2;
      const skew = (note.lane - 1.5) * -1.8 * (1 - depthHead);

      if (!note.element) createNoteElement(note);
      if (!note.element) continue;
      let drawX = xHead;
      let drawY = yHead - hHead / 2;
      let drawW = wHead;
      let drawH = hHead;
      let drawClip = "";
      let drawTransform = `skewX(${skew.toFixed(2)}deg)`;

      if (note.durationMs > 0) {
        const left = Math.min(xHead, xTail);
        const right = Math.max(xHead + wHead, xTail + wTail);
        const top = Math.min(yTail - hTail / 2, yHead - hHead / 2);
        const bottom = Math.max(yHead + hHead / 2, yTail + hTail / 2);
        drawX = left;
        drawY = top;
        drawW = right - left;
        drawH = Math.max(hHead, bottom - top);

        const p1x = ((xTail - left) / drawW) * 100;
        const p2x = ((xTail + wTail - left) / drawW) * 100;
        const p3x = ((xHead + wHead - left) / drawW) * 100;
        const p4x = ((xHead - left) / drawW) * 100;
        const p1y = (((yTail - hTail / 2) - top) / drawH) * 100;
        const p3y = (((yHead + hHead / 2) - top) / drawH) * 100;
        drawClip = `polygon(${p1x}% ${p1y}%, ${p2x}% ${p1y}%, ${p3x}% ${p3y}%, ${p4x}% ${p3y}%)`;
        drawTransform = "none";
        note.element.classList.add("long-note");
      } else {
        note.element.classList.remove("long-note");
      }

      const key = [drawX.toFixed(1), drawY.toFixed(1), drawW.toFixed(1), drawH.toFixed(1), drawClip].join("|");
      if (key !== note.lastStyleKey) {
        note.lastStyleKey = key;
        note.element.style.display = "block";
        note.element.style.left = `${drawX}px`;
        note.element.style.top = `${drawY}px`;
        note.element.style.width = `${drawW}px`;
        note.element.style.height = `${drawH}px`;
        note.element.style.transform = drawTransform;
        note.element.style.clipPath = drawClip || "none";
      }
    }
  }

  function updateHoldNotes(nowMs: number): void {
    const rt = runtimeRef.current;
    for (const note of rt.chart) {
      if (note.judged || note.tailJudged) continue;
      if (note.holding && !rt.lanePressed[note.lane] && nowMs < note.holdEndTime - HOLD_EARLY_RELEASE_TOLERANCE_MS) {
        note.holdBroken = true;
        note.holding = false;
      }
      if (note.holding && nowMs >= note.holdEndTime) {
        judgeLongTail(note, !note.holdBroken);
      }
    }
  }

  function pressLane(laneIdx: number): void {
    const rt = runtimeRef.current;
    if (!rt.gameRunning || rt.awaitingAudioStart) return;
    const now = getSongTimeMs();
    let best: { note: PlayNote; abs: number; longHead: boolean } | null = null;
    let lateHold: PlayNote | null = null;

    for (const note of rt.chart) {
      if (note.judged || note.lane !== laneIdx) continue;
      if (note.durationMs > 0) {
        if (!note.headJudged) {
          const d = now - note.hitTime;
          const a = Math.abs(d);
          if (d < -JUDGE_WINDOWS.miss) break;
          if (a <= JUDGE_WINDOWS.miss && (!best || a < best.abs)) {
            best = { note, abs: a, longHead: true };
            continue;
          }
        }
        if (!note.tailJudged && !note.holding && now > note.hitTime + JUDGE_WINDOWS.miss && now < note.holdEndTime) {
          lateHold = note;
        }
        continue;
      }

      const d = now - note.hitTime;
      const a = Math.abs(d);
      if (d < -JUDGE_WINDOWS.miss) break;
      if (a <= JUDGE_WINDOWS.miss && (!best || a < best.abs)) {
        best = { note, abs: a, longHead: false };
      }
    }

    if (best) {
      const j = judgeDelta(best.abs) ?? "miss";
      if (best.longHead) judgeLongHead(best.note, j);
      else applyJudge(best.note, j);
      return;
    }
    if (lateHold) {
      if (!lateHold.headJudged) judgeLongHead(lateHold, "miss");
      lateHold.holding = true;
      lateHold.holdBroken = false;
      return;
    }

    const hasActive = rt.chart.some((n) => n.lane === laneIdx && n.holding && !n.judged);
    if (!hasActive) {
      rt.combo = 0;
      rt.missCount += 1;
      setJudge("MISS");
      setCombo(0);
      showHitFeedback("miss");
    }
  }

  function flashLane(idx: number): void {
    laneVisualRefs.current.forEach((el, i) => {
      if (!el) return;
      if (i !== idx) el.classList.remove("active");
    });
    const target = laneVisualRefs.current[idx];
    if (!target) return;
    const rt = runtimeRef.current;
    rt.laneFlashTokens[idx] += 1;
    const token = rt.laneFlashTokens[idx];
    target.classList.add("active");
    window.setTimeout(() => {
      if (runtimeRef.current.laneFlashTokens[idx] === token) target.classList.remove("active");
    }, 80);
  }

  function calcRank(acc: number): string {
    if (acc >= 95) return "S";
    if (acc >= 88) return "A";
    if (acc >= 78) return "B";
    if (acc >= 66) return "C";
    return "D";
  }

  function stopGame(): void {
    const rt = runtimeRef.current;
    rt.gameRunning = false;
    if (rt.rafId) cancelAnimationFrame(rt.rafId);
    rt.audio?.pause();
    stopSynthBgm();
    setProgress("Finished");
    const acc = rt.possiblePoints > 0 ? (rt.achievedPoints / rt.possiblePoints) * 100 : 0;
    const clear = acc >= 72 && rt.missCount < Math.max(30, Math.floor(rt.chart.length * 0.22));
    setResult({ show: true, state: clear ? "CLEAR!" : "FAILED", rank: `RANK ${calcRank(acc)}`, acc: `${acc.toFixed(1)}%`, score: `${rt.score}` });
  }

  function loop(): void {
    const rt = runtimeRef.current;
    if (!rt.gameRunning) return;
    if (rt.awaitingAudioStart) {
      rt.rafId = requestAnimationFrame(loop);
      return;
    }
    const rawMs = getTimelineMs();
    const now = rawMs + settingsRef.current.timingOffsetMs;
    const audioEnded = !!(
      rt.audio &&
      !rt.useSynthBgm &&
      (rt.audio.ended || (Number.isFinite(rt.audio.duration) && rt.audio.duration > 0 && rt.audio.currentTime >= rt.audio.duration - 0.02))
    );
    if (audioEnded) {
      stopGame();
      return;
    }
    tickSynthBgm(rawMs);
    updateHoldNotes(now);
    updateNotes(now);
    const chartSec = Math.max(1, rt.chartEndMs / 1000);
    const sec = Math.min(chartSec, rawMs / 1000);
    if (rawMs - rt.lastProgressUpdateMs >= 120) {
      setProgress(`Playing ${sec.toFixed(1)}s / ${chartSec.toFixed(1)}s`);
      rt.lastProgressUpdateMs = rawMs;
    }
    if (rawMs >= rt.chartEndMs) {
      stopGame();
      return;
    }
    rt.rafId = requestAnimationFrame(loop);
  }

  function toggleTapTempo(): void {
    setTapTempoMode((v) => !v);
    setTapTimes([]);
    setTapTempoState((v) => (v === "idle" ? "tap quarter notes..." : "idle"));
  }

  function applyTapTempo(): void {
    if (tapTimes.length < 4) return;
    const intervals = tapTimes.slice(1).map((t, i) => t - tapTimes[i]);
    const beatMs = median(intervals);
    if (!Number.isFinite(beatMs) || beatMs < 350 || beatMs > 1400) {
      setTapTempoState("failed, retry");
      return;
    }
    const bpm = 60000 / beatMs;
    setChartTempoBpmState(Math.max(50, Math.min(110, bpm)));

    const baseOffset = selectedScore.offsetMs;
    const deltas = tapTimes.map((t) => {
      const k = Math.round((t - baseOffset) / beatMs);
      return baseOffset + k * beatMs - t;
    });
    const delta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    setTimingOffsetMs((v) => Math.max(-300, Math.min(300, v + delta)));
    setTapTempoState(`applied ${Math.max(50, Math.min(110, bpm)).toFixed(1)} BPM`);
    setTapTempoMode(false);
    setTapTimes([]);
    rebuildChartForCurrentTime();
  }

  function registerTap(): void {
    if (!tapTempoMode || !runtimeRef.current.gameRunning) return;
    setTapTimes((prev) => {
      const next = [...prev, getRawSongTimeMs()].slice(-12);
      if (next.length >= 8) {
        window.setTimeout(applyTapTempo, 0);
      } else {
        setTapTempoState(`taps: ${next.length}`);
      }
      return next;
    });
  }

  function saveTuneForSong(): void {
    const key = `pjsk_song_tune_${encodeURIComponent(selectedScore.audioUrl || selectedScore.id)}`;
    localStorage.setItem(key, JSON.stringify({ timingOffsetMs, chartTempoBpm }));
    setProgress("Saved tune for this song");
  }

  function loadTuneForSong(meta: ScoreMeta): void {
    const key = `pjsk_song_tune_${encodeURIComponent(meta.audioUrl || meta.id)}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const s = JSON.parse(raw) as { timingOffsetMs?: number; chartTempoBpm?: number };
      if (Number.isFinite(s.timingOffsetMs)) setTimingOffsetMs(Math.max(-300, Math.min(300, Number(s.timingOffsetMs))));
      if (Number.isFinite(s.chartTempoBpm)) setChartTempoBpmState(Math.max(50, Math.min(110, Number(s.chartTempoBpm))));
    } catch {
      // ignore
    }
  }

  function resetTuneForSong(): void {
    const key = `pjsk_song_tune_${encodeURIComponent(selectedScore.audioUrl || selectedScore.id)}`;
    localStorage.removeItem(key);
    setTimingOffsetMs(0);
    setChartTempoBpmState(selectedScore.bpm || 66);
    rebuildChartForCurrentTime();
    setProgress("Reset tune for this song");
  }

  useEffect(() => {
    loadTuneForSong(selectedScore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScoreId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (tapTempoMode && (e.code === "Space" || e.code === "KeyT")) {
        e.preventDefault();
        registerTap();
        return;
      }
      const idx = HIT_KEYS.indexOf(e.code);
      if (idx < 0 || e.repeat) return;
      runtimeRef.current.lanePressed[idx] = true;
      flashLane(idx);
      pressLane(idx);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "BracketLeft") setTimingOffsetMs((v) => Math.max(-300, v - 20));
      if (e.code === "BracketRight") setTimingOffsetMs((v) => Math.min(300, v + 20));
      if (e.code === "Minus") setJudgeLineOffsetPxState((v) => Math.max(70, v - 5));
      if (e.code === "Equal") setJudgeLineOffsetPxState((v) => Math.min(180, v + 5));
      if (e.code === "Escape") setSettingsOpen(false);
      const idx = HIT_KEYS.indexOf(e.code);
      if (idx >= 0) runtimeRef.current.lanePressed[idx] = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tapTempoMode, tapTimes]);

  function onLanePointerDown(i: number): void {
    runtimeRef.current.lanePressed[i] = true;
    flashLane(i);
    pressLane(i);
  }

  return (
    <>
      <div className="bg-glow" />
      <main className="app">
        <header className="topbar">
          <div className="title-wrap">
            <h1>SEKAI-Like Rhythm Demo</h1>
            <p>キー: D / F / J / K，またはレーンをタップ</p>
          </div>
          <div className="status">
            <div><span className="label">Score</span><span>{score}</span></div>
            <div><span className="label">Combo</span><span>{combo}</span></div>
            <div><span className="label">Judge</span><span>{judge}</span></div>
            <div><span className="label">Song</span><span>{songTitle}</span></div>
            <div>
              <span className="label">BGM</span>
              <span>{customAudioName ? `custom: ${customAudioName}` : isMidiUrl(getEffectiveAudioUrl()) ? "MIDI synth" : "audio file"}</span>
            </div>
            <div>
              <span className="label">Score Set</span>
              <select value={selectedScoreId} onChange={(e) => setSelectedScoreId(e.target.value)}>
                {scores.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </div>
          </div>
        </header>

        <section className="playfield-wrap">
          <div className="playfield" id="playfield" ref={playfieldRef}>
            <div className="cue">{runtimeRef.current.gameRunning ? "" : "READY"}</div>
            <div className={`countdown-overlay ${countdownText ? "" : "hidden"}`}>{countdownText}</div>
            <div className="judge-line" />
            <div className="track-bg" aria-hidden="true">
              <svg className="track-perspective" viewBox="0 0 100 100" preserveAspectRatio="none">
                {[0, 1, 2, 3].map((i) => (
                  <polygon
                    key={i}
                    ref={(el) => {
                      if (el) laneVisualRefs.current[i] = el;
                    }}
                    className={`lane-fill lane-fill-${i + 1}`}
                    points={
                      i === 0 ? "0,100 25,100 38,8 26,8" :
                      i === 1 ? "25,100 50,100 50,8 38,8" :
                      i === 2 ? "50,100 75,100 62,8 50,8" :
                      "75,100 100,100 74,8 62,8"
                    }
                  />
                ))}
                <line className="lane-sep outer" x1="0" y1="100" x2="26" y2="8" />
                <line className="lane-sep" x1="25" y1="100" x2="38" y2="8" />
                <line className="lane-sep" x1="50" y1="100" x2="50" y2="8" />
                <line className="lane-sep" x1="75" y1="100" x2="62" y2="8" />
                <line className="lane-sep outer" x1="100" y1="100" x2="74" y2="8" />
              </svg>
              <div className="track-grid" />
              <div className="track-gloss" />
            </div>
            <div className="lanes">
              {[0, 1, 2, 3].map((i) => (
                <button
                  key={i}
                  className="lane"
                  onPointerDown={() => onLanePointerDown(i)}
                  onPointerUp={() => { runtimeRef.current.lanePressed[i] = false; }}
                  onPointerLeave={() => { runtimeRef.current.lanePressed[i] = false; }}
                />
              ))}
            </div>
            <div id="notes-layer" ref={notesLayerRef} />
            <div className={`hit-feedback ${hitFeedback.visible ? "" : "hidden"} ${hitFeedback.className}`}>
              {hitFeedback.text}
            </div>
            <div className={`result-overlay ${result.show ? "" : "hidden"}`} aria-hidden={!result.show}>
              <div className="result-card">
                <p className={`result-state ${result.state === "CLEAR!" ? "judge-great" : "judge-miss"}`}>{result.state}</p>
                <p className="result-rank">{result.rank}</p>
                <p className="result-score">SCORE {result.score}</p>
                <p className="result-meta">ACCURACY {result.acc}</p>
              </div>
            </div>
          </div>
        </section>

        <footer className="controls">
          <button className="primary" onClick={() => { resetGame(); startGame(); }}>START / RESTART</button>
          <button onClick={() => setSettingsOpen(true)}>SETTINGS</button>
          <div className="progress">{progress}</div>
        </footer>
      </main>

      <div className={`settings-panel ${settingsOpen ? "" : "hidden"}`} onClick={(e) => {
        if (e.target === e.currentTarget) setSettingsOpen(false);
      }}>
        <div className="settings-card">
          <h2>Settings</h2>
          <label>Note Speed</label>
          <div className="speed-row">
            <input type="range" min={6} max={15} step={0.1} value={noteSpeed} onChange={(e) => setNoteSpeed(Number(e.target.value))} />
            <span>{noteSpeed.toFixed(1)}</span>
          </div>
          <label>Timing Offset (ms)</label>
          <div className="speed-row">
            <input type="range" min={-300} max={300} step={10} value={timingOffsetMs} onChange={(e) => setTimingOffsetMs(Number(e.target.value))} />
            <span>{Math.round(timingOffsetMs)}</span>
          </div>
          <label>Chart BPM</label>
          <div className="speed-row">
            <input type="range" min={50} max={110} step={0.5} value={chartTempoBpm} onChange={(e) => { setChartTempoBpmState(Number(e.target.value)); rebuildChartForCurrentTime(); }} />
            <span>{chartTempoBpm.toFixed(1)}</span>
          </div>
          <div className="speed-row">
            <button onClick={toggleTapTempo}>TAP TEMPO</button>
            <span>{tapTempoState}</span>
          </div>
          <div className="speed-row">
            <input type="file" accept=".musicxml,.xml,.mxl,.mid,.midi" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const lower = file.name.toLowerCase();
                if (lower.endsWith(".mid") || lower.endsWith(".midi")) {
                  const midiNotes = parseMidi(await file.arrayBuffer());
                  const midiEvents = midiNotes.map((n) => ({
                    beatPos: 0,
                    durationBeats: 0,
                    midi: n.midi,
                    timeMs: n.timeMs,
                    durationMs: n.durationMs,
                  }));
                  runtimeRef.current.importedEvents = midiEvents;
                  runtimeRef.current.midiPlaybackEvents = midiEvents;
                } else {
                  const xml = lower.endsWith(".mxl")
                    ? await extractMusicXmlFromMxl(await file.arrayBuffer())
                    : await file.text();
                  runtimeRef.current.importedEvents = parseMusicXml(xml);
                  runtimeRef.current.midiPlaybackEvents = [];
                }
                runtimeRef.current.chartSourceMode = "score";
                setXmlImportState(`score: ${file.name}`);
                rebuildChartForCurrentTime();
              } catch {
                setXmlImportState("import failed");
              }
            }} />
            <span>{xmlImportState}</span>
          </div>
          <label>BGM Audio</label>
          <div className="speed-row">
            <input type="file" accept=".ogg,.mp3,.wav,.m4a,.aac,.flac" onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (customAudioObjectUrlRef.current) {
                URL.revokeObjectURL(customAudioObjectUrlRef.current);
              }
              const url = URL.createObjectURL(file);
              customAudioObjectUrlRef.current = url;
              setCustomAudioUrl(url);
              setCustomAudioName(file.name);
              setProgress("Custom audio loaded");
              resetGame();
            }} />
            <span>{customAudioName || "default"}</span>
          </div>
          <label>Judge Line Y</label>
          <div className="speed-row">
            <input type="range" min={70} max={180} step={5} value={judgeLineOffsetPx} onChange={(e) => setJudgeLineOffsetPxState(Number(e.target.value))} />
            <span>{Math.round(judgeLineOffsetPx)}</span>
          </div>
          <p className="settings-hint">`[` / `]` timing, `-` / `=` judge line, `Space` tap</p>
          <button onClick={saveTuneForSong}>SAVE FOR THIS SONG</button>
          <button onClick={resetTuneForSong}>RESET TUNE</button>
          <button onClick={() => setSettingsOpen(false)}>CLOSE</button>
        </div>
      </div>
    </>
  );
}
