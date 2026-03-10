import { useEffect, useMemo, useRef, useState } from "react";
import { parseMusicXml } from "./musicxml";
import { parseMidi } from "./midi";
import { extractMusicXmlFromMxl } from "./mxl";
import type { Judge, PlayNote, ScoreEvent, ScoreMeta } from "./types";

const LANE_COUNT = 4;
const HIT_KEYS = ["KeyD", "KeyF", "KeyJ", "KeyK"];
const BASE_APPROACH_MS = 2100;
const NOTE_BASE_WIDTH = 118;
const AUTO_CALIBRATION_MS = 10000;
const LIVE_ADJUST_WINDOW_MS = 30000;
const NOTE_LANE_FILL_RATIO = 0.96;
const APP_BASE_URL = new URL(".", document.baseURI).pathname || "/";

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
  id: "shishiriennu-op78-etude",
  title: "シシリエンヌ 作品78 ト短調",
  artist: "ガブリエル・フォーレ",
  audioUrl: "/scores/songs/shishiriennu-op78-etude/audio.mp3",
  mxlPath: "/scores/songs/shishiriennu-op78-etude/score.mxl",
  strictMode: true,
  offsetMs: -120,
  bpm: 100,
  lengthSec: 240,
};

// runtimeRef が保持する「再レンダリング不要の実行状態」一式．
// useState に載せると毎フレーム再描画になるため，ゲーム処理はここに集約する．
type Runtime = {
  chart: PlayNote[];
  chartEndMs: number;
  mediaDurationMs: number;
  gameRunning: boolean;
  calibrationActive: boolean;
  calibrationTapTimes: number[];
  calibrationAnchorTimes: number[];
  calibrationTimer: number | null;
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
  liveAdjustSamples: number[];
  liveAdjustLastApplyMs: number;
  sweepIndex: number;
  liveShiftPendingMs: number;
  liveOffsetPendingMs: number;
  liveAdjustLastUiMs: number;
  liveAdjustFrozen: boolean;
  audioPrimed: boolean;
  lastAudioError: string;
};

// 遠近（depth）に応じたレーン中心Xを返す．
// depth=0 は奥側，depth=1 は手前側で，奥ほどレーン間隔を狭くする．
function laneCenterAtDepth(lane: number, depth: number, width: number): number {
  // 画面中心を基準に左右へ振り分ける．
  const center = width / 2;
  // 手前と奥でレーンの広がりを変えて，擬似3Dのパースを作る．
  const nearSpread = width * 0.92;
  const farSpread = width * 0.38;
  // lane を -0.5..+0.5 付近に正規化して左右係数にする．
  const t = (lane + 0.5) / LANE_COUNT - 0.5;
  const xNear = center + t * nearSpread;
  const xFar = center + t * farSpread;
  // 奥座標と手前座標を depth で線形補間．
  return xFar + (xNear - xFar) * depth;
}

// public 配下の相対URLを，現在の base path に安全に解決する．
function resolvePublicUrl(path: string): string {
  if (!path) return path;
  // 絶対 URL はそのまま使う．
  if (/^https?:\/\//i.test(path)) return path;
  // Blob/Data URL も変換すると壊れるのでそのまま返す．
  if (path.startsWith("blob:") || path.startsWith("data:")) return path;
  const base = APP_BASE_URL.endsWith("/") ? APP_BASE_URL : `${APP_BASE_URL}/`;
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return `${base}${clean}`;
}

// 指定 depth におけるレーンの左右境界を返す．
// 中心点列から隣接中点を境界として組み立てる．
function laneBoundsAtDepth(lane: number, depth: number, width: number): { left: number; right: number } {
  const centers = Array.from({ length: LANE_COUNT }, (_, i) => laneCenterAtDepth(i, depth, width));
  const bounds = new Array<number>(LANE_COUNT + 1);
  // 最左境界は 0 番と 1 番の中心間隔を外側へ半分だけ延長して推定．
  bounds[0] = centers[0] - (centers[1] - centers[0]) / 2;
  for (let i = 1; i < LANE_COUNT; i += 1) {
    // 隣接中心の中点をレーン境界にする．
    bounds[i] = (centers[i - 1] + centers[i]) / 2;
  }
  // 最右境界も同様に外側へ半分延長．
  bounds[LANE_COUNT] = centers[LANE_COUNT - 1] + (centers[LANE_COUNT - 1] - centers[LANE_COUNT - 2]) / 2;
  return { left: bounds[lane], right: bounds[lane + 1] };
}

// 0..1 の範囲にクランプする補助関数．
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// hitTime でソート済み配列に対する lower_bound（二分探索）．
// value 以上が最初に現れる index を返す．
function lowerBoundHitTime(notes: PlayNote[], value: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    // ビットシフトで高速に中央 index を求める．
    const mid = (lo + hi) >> 1;
    if (notes[mid].hitTime < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// 中央値を返す．外れ値に強いので BPM 推定などで使う．
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  // 要素数が偶数なら中央2つの平均．
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// グリッド生成用に，リズム候補を 1拍/8分/3連符 に丸める．
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

// timeMs を持つイベント列から実測 BPM を推定する．
function estimateBpmFromTimedEvents(events: ScoreEvent[]): number {
  const times = events
    .map((e) => e.timeMs)
    .filter((t): t is number => Number.isFinite(t))
    .sort((a, b) => a - b);
  // サンプルが少なすぎる場合は安全側の既定値に倒す．
  if (times.length < 4) return 120;
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i += 1) {
    const d = times[i] - times[i - 1];
    // 速すぎる/遅すぎる差分はノイズとして除外．
    if (d > 70 && d < 1600) diffs.push(d);
  }
  if (!diffs.length) return 120;
  const m = median(diffs);
  const bpm = 60000 / Math.max(1, m);
  // UI 想定レンジへ収める．
  return Math.max(50, Math.min(180, bpm));
}

// beatPos ベースの譜面しかない場合に，曲長から逆算で BPM を推定する．
function estimateBpmForBeatScore(events: ScoreEvent[], mediaDurationMs: number): number | null {
  if (!events.length || !Number.isFinite(mediaDurationMs) || mediaDurationMs <= 0) return null;
  const beatBased = events.filter((e) => !Number.isFinite(e.timeMs));
  if (!beatBased.length) return null;
  const lastBeat = Math.max(
    ...beatBased.map((e) => e.beatPos + Math.max(0.25, e.durationBeats || 0))
  );
  if (!Number.isFinite(lastBeat) || lastBeat <= 0.1) return null;
  // 先頭カウントインと末尾余白はプレイ外時間として差し引く．
  const leadInMs = 550;
  const tailMs = 24;
  const playableMs = Math.max(1200, mediaDurationMs - leadInMs - tailMs);
  const bpm = (lastBeat * 60000) / playableMs;
  if (!Number.isFinite(bpm)) return null;
  return Math.max(40, Math.min(220, bpm));
}

// 拡張子で MIDI 音源かどうか判定．
function isMidiUrl(url: string): boolean {
  return /\.mid(i)?$/i.test(url);
}

// 複雑なスコアイベントを「遊びやすい密度」に簡略化する．
function simplifyEventsForRhythm(events: ScoreEvent[], bpm: number): ScoreEvent[] {
  if (!events.length) return [];
  const beatMs = 60000 / Math.max(1, bpm);
  const absEvents = events
    .map((e) => {
      // 絶対時刻がない場合は beat 情報から時刻へ変換．
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
    // 同時和音は音高順に並べ，メロディ寄り（高め寄り）を1音だけ採用．
    const byPitch = [...list].sort((a, b) => a.midi - b.midi);
    const melodyLike = byPitch[Math.min(byPitch.length - 1, Math.floor(byPitch.length * 0.68))];
    const out = [melodyLike].map((e) => ({ ...e, timeMs: e.timeMs }));
    selected.push(...out);
  }

  selected.sort((a, b) => (a.timeMs as number) - (b.timeMs as number));
  // 近すぎる音符を間引いて物理的に押せる密度へ整える．
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

// 同一レーン内で，ロングノーツと他ノーツが衝突しないよう除去する．
function removeOverlapsWithLongNotes(notes: PlayNote[]): PlayNote[] {
  if (!notes.length) return notes;
  const sorted = [...notes].sort((a, b) => a.hitTime - b.hitTime);
  const kept: PlayNote[] = [];
  const holdWindows: Array<{ start: number; end: number; lane: number }> = [];
  // 判定の見た目と体感を守るため，前後に少しガード領域を持たせる．
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

// 譜面全体を曲長に合わせて前後クランプし，先頭リードインも確保する．
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
      // 先頭・末尾を曲の再生可能区間に収める．
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

// 譜面がスカスカかどうかを，ノーツ数・時間カバー率・密度で判定する．
function isSparseChart(chart: PlayNote[], mediaDurationMs: number): boolean {
  if (!chart.length || mediaDurationMs <= 0) return true;
  const durationSec = mediaDurationMs / 1000;
  const first = chart[0].hitTime;
  const last = Math.max(...chart.map((n) => Math.max(n.hitTime, n.holdEndTime)));
  const coverageRatio = Math.max(0, last - first) / mediaDurationMs;
  const density = chart.length / Math.max(1, durationSec);
  return chart.length < 56 || coverageRatio < 0.76 || density < 0.42;
}

// sparse 時に補助的に混ぜる規則ノーツ列を生成する．
function buildSupportNotes(mediaDurationMs: number, bpm: number): PlayNote[] {
  const beatMs = 60000 / Math.max(1, bpm);
  const flow = [1, 0.5, 1, 1 / 3, 1 / 3, 1 / 3, 1, 0.5, 0.5, 1];
  const lanes = [1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 2, 3, 2, 1, 0];
  const out: PlayNote[] = [];
  // 冒頭は視認時間を確保するため少し遅らせて開始．
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

// 既存譜面と補助譜面を時間近傍重複なしで統合する．
function mergeChartWithSupport(base: PlayNote[], support: PlayNote[]): PlayNote[] {
  const merged = [...base];
  for (const s of support) {
    const near = merged.some((n) => Math.abs(n.hitTime - s.hitTime) < 160);
    if (!near) merged.push(s);
  }
  merged.sort((a, b) => a.hitTime - b.hitTime);
  return merged;
}

// 曲終端にノーツが存在しない場合は末尾ノーツを追加して尻切れ感を防ぐ．
function ensureTailNote(chart: PlayNote[], mediaDurationMs: number): PlayNote[] {
  if (mediaDurationMs <= 0) return chart;
  const target = Math.max(1200, Math.round(mediaDurationMs - 24));
  const nearTail = chart.some((n) => Math.abs((n.durationMs > 0 ? n.holdEndTime : n.hitTime) - target) <= 70);
  if (nearTail) return chart;
  const occupied = new Set<number>();
  for (const n of chart) {
    if (n.durationMs > 0 && target >= n.hitTime - 20 && target <= n.holdEndTime + 20) occupied.add(n.lane);
  }
  // 末尾時刻でロングが占有していないレーンを優先．
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

// ロングノーツ比率を最小/最大範囲へ収める．
function applyLongNoteQuota(notes: PlayNote[], beatMs: number, minRatio = 0.12, maxRatio = 0.35): PlayNote[] {
  if (!notes.length) return notes;
  const out = [...notes];
  const minTarget = Math.max(1, Math.floor(out.length * minRatio));
  const maxTarget = Math.max(minTarget, Math.ceil(out.length * maxRatio));
  let current = out.filter((n) => n.durationMs > 0).length;

  if (current > maxTarget) {
    const longIdx = out
      .map((n, i) => ({ i, n }))
      .filter((x) => x.n.durationMs > 0)
      .sort((a, b) => a.n.durationMs - b.n.durationMs)
      .map((x) => x.i);
    let cut = current - maxTarget;
    for (const i of longIdx) {
      if (cut <= 0) break;
      // 長すぎる比率を下げるため，短いロングから順に通常ノーツへ戻す．
      out[i] = { ...out[i], durationMs: 0, holdEndTime: out[i].hitTime };
      cut -= 1;
      current -= 1;
    }
  }
  if (current >= minTarget) return out;

  const candidates = out
    .map((n, i) => ({ i, n }))
    .filter((x) => x.n.durationMs <= 0)
    .sort((a, b) => b.n.hitTime - a.n.hitTime);

  for (const c of candidates) {
    if (current >= minTarget) break;
    const prev = out[c.i - 1];
    const next = out[c.i + 1];
    const prevGap = prev ? c.n.hitTime - prev.hitTime : Number.POSITIVE_INFINITY;
    const nextGap = next ? next.hitTime - c.n.hitTime : Number.POSITIVE_INFINITY;
    // 前後が詰まりすぎる箇所はロング化しない．
    if (prevGap < beatMs * 0.42 || nextGap < beatMs * 0.42) continue;
    const d = Math.round(Math.max(beatMs * 0.72, Math.min(beatMs * 2.2, Math.min(prevGap, nextGap) * 0.72)));
    out[c.i] = { ...c.n, durationMs: d, holdEndTime: c.n.hitTime + d };
    current += 1;
  }
  return out;
}

// ロング連打が続きすぎると破綻しやすいため，連続数を上限で抑える．
function rebalanceLongRuns(notes: PlayNote[], maxConsecutiveLong = 2): PlayNote[] {
  if (!notes.length) return notes;
  const out = [...notes].sort((a, b) => a.hitTime - b.hitTime);
  let run = 0;
  for (let i = 0; i < out.length; i += 1) {
    const n = out[i];
    if (n.durationMs > 0) {
      run += 1;
      if (run > maxConsecutiveLong) {
        out[i] = { ...n, durationMs: 0, holdEndTime: n.hitTime };
        run = 0;
      }
    } else {
      run = 0;
    }
  }
  return out;
}

// 曲後半にロングが偏りすぎないよう，末尾区間のみ比率調整する．
function rebalanceTailLongRatio(notes: PlayNote[], mediaDurationMs: number, maxTailLongRatio = 0.46): PlayNote[] {
  if (!notes.length || !Number.isFinite(mediaDurationMs) || mediaDurationMs <= 0) return notes;
  const out = [...notes].sort((a, b) => a.hitTime - b.hitTime);
  const tailStart = mediaDurationMs * 0.72;
  const tailIndices = out
    .map((n, i) => ({ n, i }))
    .filter((x) => x.n.hitTime >= tailStart)
    .map((x) => x.i);
  if (tailIndices.length < 6) return out;
  let tailLong = tailIndices.filter((i) => out[i].durationMs > 0).length;
  if (tailLong / tailIndices.length <= maxTailLongRatio) return out;
  const longCandidates = tailIndices
    .filter((i) => out[i].durationMs > 0)
    .sort((a, b) => out[a].durationMs - out[b].durationMs);
  const targetLong = Math.floor(tailIndices.length * maxTailLongRatio);
  for (const idx of longCandidates) {
    if (tailLong <= targetLong) break;
    const n = out[idx];
    out[idx] = { ...n, durationMs: 0, holdEndTime: n.hitTime };
    tailLong -= 1;
  }
  return out;
}

// MIDI 音高をレンジ正規化して 0..3 レーンへ割り当てる．
function chooseLaneFromMidi(midi: number, minMidi: number, maxMidi: number): number {
  const tNorm = (midi - minMidi) / Math.max(1, maxMidi - minMidi);
  return Math.max(0, Math.min(3, Math.floor(tNorm * 4)));
}

// 押しやすさを優先した動的レーン割り当て．
// 音高準拠をベースに，前ノーツ位置・間隔・同一レーン連続をペナルティ化する．
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
    // 音高からの「理想レーン」．
    const pref = chooseLaneFromMidi(e.midi, minMidi, maxMidi);
    const prev = i > 0 ? events[i - 1] : null;
    const dt = prev ? ((e.timeMs ?? e.beatPos * beatMs) - (prev.timeMs ?? prev.beatPos * beatMs)) : Number.POSITIVE_INFINITY;
    // 間隔が短いほど同一レーン連打の負担を強く避ける．
    const shortGap = dt < beatMs * 0.58;
    const veryShortGap = dt < beatMs * 0.36;
    const pitchDir = Math.sign(e.midi - prevMidi);

    let bestLane = pref;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let lane = 0; lane < LANE_COUNT; lane += 1) {
      // スコアが低いレーンほど採用される．
      let score = 0;
      score += Math.abs(lane - pref) * 1.15;
      if (prevLane >= 0) score += Math.abs(lane - prevLane) * 0.28;
      if (lane === prevLane && shortGap) score += 1.45;
      if (lane === prevLane && veryShortGap) score += 1.2;
      if (sameStreak >= 1 && lane === prevLane) score += 1.8;
      if (sameStreak >= 2 && lane === prevLane) score += 3.8;
      if (pitchDir > 0 && prevLane >= 0 && lane < prevLane) score += 0.55;
      if (pitchDir < 0 && prevLane >= 0 && lane > prevLane) score += 0.55;
      // 長音は前ノーツとレーンを揃えると押しやすい傾向があるため軽く優遇．
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

// strictMode 用の単純割り当て（音高のみ準拠）．
function assignLanesStrict(events: ScoreEvent[]): number[] {
  if (!events.length) return [];
  const minMidi = Math.min(...events.map((e) => e.midi));
  const maxMidi = Math.max(...events.map((e) => e.midi));
  return events.map((e) => chooseLaneFromMidi(e.midi, minMidi, maxMidi));
}

// ScoreMeta から MusicXML/MXL を取得して ScoreEvent 列へ変換する．
async function fetchMusicXml(meta: ScoreMeta): Promise<ScoreEvent[]> {
  if (meta.mxlPath) {
    const res = await fetch(resolvePublicUrl(meta.mxlPath));
    if (!res.ok) throw new Error("mxl not found");
    const xml = await extractMusicXmlFromMxl(await res.arrayBuffer());
    return parseMusicXml(xml);
  }
  if (meta.xmlPath) {
    const res = await fetch(resolvePublicUrl(meta.xmlPath));
    if (!res.ok) throw new Error("xml not found");
    return parseMusicXml(await res.text());
  }
  return [];
}

// ScoreMeta の MIDI を取得して ScoreEvent 互換に変換する．
async function fetchMidiEvents(meta: ScoreMeta): Promise<ScoreEvent[]> {
  if (!meta.midiPath) return [];
  const res = await fetch(resolvePublicUrl(meta.midiPath));
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

// score と midi が同時にある場合の同期戦略．
// 音高/並びは score を優先し，時刻/長さは midi へ寄せる．
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
  // 実DOM参照（プレイフィールド，ノーツ描画層，レーン演出）．
  const playfieldRef = useRef<HTMLDivElement>(null);
  const notesLayerRef = useRef<HTMLDivElement>(null);
  const laneVisualRefs = useRef<SVGPolygonElement[]>([]);

  // ループから最新設定値を読むためのミラー．
  const settingsRef = useRef({
    noteSpeed: 15,
    timingOffsetMs: 0,
    chartTempoBpm: 66,
    judgeLineOffsetPx: 110,
  });

  // 毎フレーム更新される実行状態．
  const runtimeRef = useRef<Runtime>({
    chart: [],
    chartEndMs: defaultScore.lengthSec * 1000,
    mediaDurationMs: defaultScore.lengthSec * 1000,
    gameRunning: false,
    calibrationActive: false,
    calibrationTapTimes: [],
    calibrationAnchorTimes: [],
    calibrationTimer: null,
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
    liveAdjustSamples: [],
    liveAdjustLastApplyMs: 0,
    sweepIndex: 0,
    liveShiftPendingMs: 0,
    liveOffsetPendingMs: 0,
    liveAdjustLastUiMs: 0,
    liveAdjustFrozen: false,
    audioPrimed: false,
    lastAudioError: "",
  });

  // 曲リストと選択曲．
  const [scores, setScores] = useState<ScoreMeta[]>([defaultScore]);
  const [selectedScoreId, setSelectedScoreId] = useState(defaultScore.id);
  const selectedScore = useMemo(
    () => scores.find((s) => s.id === selectedScoreId) ?? defaultScore,
    [scores, selectedScoreId]
  );

  // UI 表示用 state（変更時に再描画される）．
  const [score, setScore] = useState(0);
  const [uiMode, setUiMode] = useState<"auto" | "mobile" | "desktop">("auto");
  const [combo, setCombo] = useState(0);
  const [judge, setJudge] = useState("-");
  const [progress, setProgress] = useState("Ready");
  const [songTitle, setSongTitle] = useState("Loading...");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customAudioUrl, setCustomAudioUrl] = useState<string | null>(null);
  const [customAudioName, setCustomAudioName] = useState<string>("");
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);
  const [liveAdjustEnabled, setLiveAdjustEnabled] = useState(true);
  const [recalibrateOnNextStart, setRecalibrateOnNextStart] = useState(false);
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
  const isMobileUi = uiMode === "mobile";

  // URL から UI モードを判定する．
  useEffect(() => {
    const queryUi = new URLSearchParams(window.location.search).get("ui");
    const path = window.location.pathname.toLowerCase();
    if (queryUi === "mobile" || queryUi === "desktop") {
      setUiMode(queryUi);
      return;
    }
    if (path.endsWith("/mobile") || path.endsWith("/mobile/") || path.endsWith("/mobile.html")) {
      setUiMode("mobile");
      return;
    }
    if (path.endsWith("/desktop") || path.endsWith("/desktop/") || path.endsWith("/desktop.html")) {
      setUiMode("desktop");
      return;
    }
    setUiMode("auto");
  }, []);

  // body 属性に UI モードを反映して CSS 分岐に使う．
  useEffect(() => {
    document.body.setAttribute("data-ui-mode", uiMode);
    return () => {
      document.body.removeAttribute("data-ui-mode");
    };
  }, [uiMode]);

  // 永続化された設定値を初期読み込みする．
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

  // state 更新時に settingsRef と localStorage を同期する．
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

  // 曲リスト index を読み込み，失敗時は default を使う．
  useEffect(() => {
    fetch(resolvePublicUrl("/scores/index.json"))
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

  // アンマウント時に timer / object URL を解放する．
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

  // 曲切替時の初期化と譜面データ読み込み．
  useEffect(() => {
    setSongTitle(`${selectedScore.title} / ${selectedScore.artist}`);
    setRecalibrateOnNextStart(false);
    if (customAudioObjectUrlRef.current) {
      URL.revokeObjectURL(customAudioObjectUrlRef.current);
      customAudioObjectUrlRef.current = null;
    }
    setCustomAudioUrl(null);
    setCustomAudioName("");
    setTimingOffsetMs(selectedScore.offsetMs || 0);
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

  // 譜面データがない場合のフォールバック用に，規則パターンのイベント列を生成する．
  function generateGridEvents(bpm: number): ScoreEvent[] {
    // 1拍，8分，3連を混ぜた簡易リズム流れ．
    const flow = [1, 0.5, 1, 1 / 3, 1 / 3, 1 / 3, 1, 0.5, 0.5, 1, 1, 1 / 3, 1 / 3, 1 / 3, 1];
    // 左右に振る基本レーン列（midi へ仮エンコード）．
    const lanes = [1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 2, 3, 2, 1, 0];
    // 曲長から「生成する拍上限」を計算．末尾は少し余白を残す．
    const beatLimit = Math.floor((selectedScore.lengthSec * bpm) / 60) - 2;
    const out: ScoreEvent[] = [];
    let beat = 0;
    let i = 0;
    while (beat < beatLimit) {
      // 一定周期でロング候補を混ぜる（1.5拍や2拍）．
      out.push({ beatPos: beat, durationBeats: i % 24 === 8 ? 1.5 : i % 48 === 32 ? 2 : 0.5, midi: 60 + lanes[i % lanes.length] * 2 });
      beat += quantizeBeat(flow[i % flow.length]);
      i += 1;
    }
    return out;
  }

  // ScoreEvent を実プレイ用 PlayNote へ変換する中核関数．
  function eventsToNotes(events: ScoreEvent[], bpm: number, strictMode = false): PlayNote[] {
    const source = strictMode
      ? events
          .map((e) => ({
            ...e,
            // strict 時は原譜面の時刻をそのまま尊重（beat しかなければ時刻化）．
            timeMs: Number.isFinite(e.timeMs) ? e.timeMs : e.beatPos * (60000 / Math.max(1, bpm)),
            durationMs: Number.isFinite(e.durationMs) ? e.durationMs : e.durationBeats * (60000 / Math.max(1, bpm)),
          }))
          .sort((a, b) => (a.timeMs as number) - (b.timeMs as number))
      // 非 strict は遊びやすさを優先して簡略化したイベント列を使う．
      : simplifyEventsForRhythm(events, bpm);
    if (!source.length) return [];
    const beatMs = 60000 / bpm;
    const lanePlan = strictMode ? assignLanesStrict(source) : assignLanesForFlow(source, bpm);
    const base = source.map((e, idx) => {
      const lane = lanePlan[idx] ?? 1;
      // 曲ごとの既定オフセットを先に載せて，判定時刻を作る．
      const hitTime = Math.round(
        (selectedScore.offsetMs || 0) + (Number.isFinite(e.timeMs) ? (e.timeMs as number) : e.beatPos * beatMs)
      );
      const rawDurationMs = Math.max(0, Number.isFinite(e.durationMs) ? (e.durationMs as number) : e.durationBeats * beatMs);
      return { lane, hitTime, rawDurationMs };
    }).sort((a, b) => a.hitTime - b.hitTime);

    if (strictMode) {
      // strict は入力をそのまま近い形にする（最低 100ms 未満は通常ノーツ扱い）．
      const strictMapped = base.map((b) => {
        const d = b.rawDurationMs >= 100 ? Math.round(b.rawDurationMs) : 0;
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
      const withQuota = applyLongNoteQuota(removeOverlapsWithLongNotes(strictMapped), beatMs, 0.14, 0.3);
      return removeOverlapsWithLongNotes(rebalanceLongRuns(withQuota, 2));
    }

    // 非 strict はロング採用を「押しやすさ条件」で間引く．
    let longCount = 0;
    let lastLongHit = -10_000_000;
    const mapped = base.map((b, i) => {
      const prev = base[i - 1];
      const next = base[i + 1];
      const prevGap = prev ? b.hitTime - prev.hitTime : Number.POSITIVE_INFINITY;
      const nextGap = next ? next.hitTime - b.hitTime : Number.POSITIVE_INFINITY;
      // 元イベントが十分長い場合のみロング候補にする．
      const longCandidate = b.rawDurationMs >= beatMs * 0.85;
      const spacingOK = prevGap >= beatMs * 0.42 && nextGap >= beatMs * 0.42;
      const ratioOK = longCount / Math.max(1, i) < 0.22;
      const cooldownOK = b.hitTime - lastLongHit >= beatMs * 1.25;
      let durationMs = 0;
      if (longCandidate && spacingOK && ratioOK && cooldownOK) {
        // ロング長は短すぎ/長すぎを防ぐようレンジ固定．
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
    // ロングが完全に消えた場合のみ，限定的に注入して単調さを防ぐ．
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
    resolved = applyLongNoteQuota(resolved, beatMs, 0.1, 0.26);
    return rebalanceLongRuns(resolved, 2);
  }

  // 現在の譜面ソース（読み込み済み score か，フォールバック grid）を返す．
  function getCurrentEvents(): ScoreEvent[] {
    const rt = runtimeRef.current;
    if (rt.chartSourceMode === "score" && rt.importedEvents.length) return rt.importedEvents;
    return generateGridEvents(settingsRef.current.chartTempoBpm);
  }

  function getEffectiveAudioUrl(): string {
    return customAudioUrl || resolvePublicUrl(selectedScore.audioUrl);
  }

  // MIDI ノート番号を周波数（Hz）へ変換．
  function midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // synth 再生状態の停止と解放．
  function stopSynthBgm(): void {
    const rt = runtimeRef.current;
    rt.synthEvents = [];
    rt.synthCursor = 0;
    if (rt.audioCtx) {
      rt.audioCtx.close().catch(() => {});
      rt.audioCtx = null;
    }
  }

  // WebAudio で1音鳴らす．複数オシレータ＋ADSR 風エンベロープで質感を作る．
  function playSynthNote(ctx: AudioContext, midi: number, durationMs: number): void {
    const freq = midiToFreq(midi);
    // 時間は過度に短い/長い値を避けてクランプ．
    const dur = Math.max(0.12, Math.min(3.2, (durationMs / 1000) * 0.85));
    const now = ctx.currentTime;

    // 3オシレータを mix -> lowpass -> env -> destination へ流す．
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

    // 立ち上がりは短く，減衰後に薄く残す設定．
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

  // score/midi イベントを使って synth BGM の再生キューを初期化する．
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

  // 現在時刻+先読み範囲までの synth ノートを順次発音する．
  function tickSynthBgm(rawMs: number): void {
    const rt = runtimeRef.current;
    if (!rt.useSynthBgm || !rt.audioCtx || !rt.synthEvents.length) return;
    // わずかに先読みして発音ジッタを減らす．
    const lookAheadMs = 22;
    while (rt.synthCursor < rt.synthEvents.length) {
      const ev = rt.synthEvents[rt.synthCursor];
      const t = ev.timeMs as number;
      if (t > rawMs + lookAheadMs) break;
      playSynthNote(rt.audioCtx, ev.midi, ev.durationMs ?? 220);
      rt.synthCursor += 1;
    }
  }

  // DOM ノーツ要素を遅延生成して note に紐付ける．
  function createNoteElement(note: PlayNote): void {
    if (!notesLayerRef.current) return;
    const el = document.createElement("div");
    el.className = `note${note.lane % 2 ? " alt" : ""}`;
    notesLayerRef.current.appendChild(el);
    note.element = el;
  }

  // 現在の設定/曲情報に基づき譜面を再構築する．
  function rebuildChartForCurrentTime(): void {
    const rt = runtimeRef.current;
    // プレイ中に再構築する場合は，過去ノーツを済み扱いにするため現在時刻を取得．
    const now = rt.gameRunning ? getTimelineMs() : 0;
    let bpm = settingsRef.current.chartTempoBpm;
    const strictMode = !!selectedScore.strictMode;
    // beat 譜面のみの場合は曲長から BPM を再推定してズレを減らす．
    if (rt.chartSourceMode === "score" && rt.importedEvents.length && rt.midiPlaybackEvents.length === 0) {
      const autoBpm = estimateBpmForBeatScore(rt.importedEvents, rt.mediaDurationMs);
      if (autoBpm) bpm = autoBpm;
    }
    let chart = fitChartToSongDuration(eventsToNotes(getCurrentEvents(), bpm, strictMode), rt.mediaDurationMs);
    // 非 strict かつ疎な譜面は補助ノーツを混ぜる．
    if (!strictMode && isSparseChart(chart, rt.mediaDurationMs)) {
      const support = buildSupportNotes(rt.mediaDurationMs, bpm);
      chart = fitChartToSongDuration(mergeChartWithSupport(chart, support), rt.mediaDurationMs);
    }
    if (!strictMode) {
      chart = ensureTailNote(chart, rt.mediaDurationMs);
    }
    chart = rebalanceTailLongRatio(chart, rt.mediaDurationMs, 0.45);
    chart = rebalanceLongRuns(chart, 2);
    rt.chart = removeOverlapsWithLongNotes(chart);
    rt.sweepIndex = 0;
    rt.chartEndMs = Math.max(0, rt.mediaDurationMs - 8);
    // 達成率計算用の理論満点（ロングは頭+尻を想定して高め）．
    rt.possiblePoints = rt.chart.reduce((s, n) => s + (n.durationMs > 0 ? 2200 : 1000), 0);
    if (notesLayerRef.current) notesLayerRef.current.innerHTML = "";
    for (const note of rt.chart) {
      if (note.hitTime < now - JUDGE_WINDOWS.miss && note.durationMs === 0) {
        note.judged = true;
      }
      note.element = null;
    }
  }

  // 実行状態を初期化し，音源・譜面を再準備する．
  function resetGame(): void {
    const rt = runtimeRef.current;
    rt.gameRunning = false;
    rt.awaitingAudioStart = false;
    rt.calibrationActive = false;
    rt.calibrationTapTimes = [];
    rt.calibrationAnchorTimes = [];
    if (rt.calibrationTimer) {
      clearTimeout(rt.calibrationTimer);
      rt.calibrationTimer = null;
    }
    // 音源メタが取れるまでは score 定義長を仮の曲長とする．
    rt.mediaDurationMs = selectedScore.lengthSec * 1000;
    if (rt.rafId) cancelAnimationFrame(rt.rafId);
    rt.countdown.forEach((t) => clearTimeout(t));
    rt.countdown = [];
    stopSynthBgm();
    rt.useSynthBgm = false;
    rt.liveAdjustSamples = [];
    rt.liveAdjustLastApplyMs = 0;
    rt.liveShiftPendingMs = 0;
    rt.liveOffsetPendingMs = 0;
    rt.liveAdjustLastUiMs = 0;
    rt.liveAdjustFrozen = false;
    rt.audioPrimed = false;
    rt.lastAudioError = "";
    if (rt.audio) {
      rt.audio.pause();
      rt.audio.currentTime = 0;
    }
    const effectiveAudio = getEffectiveAudioUrl();
    // MIDI URL の場合は HTMLAudio を作らず synth 再生へ寄せる．
    if (isMidiUrl(effectiveAudio)) {
      rt.audio = null;
    } else {
      rt.audio = new Audio(effectiveAudio);
      rt.audio.preload = "auto";
      rt.audio.setAttribute("playsinline", "true");
      rt.audio.crossOrigin = "anonymous";
      // 実メディア長が読めたら譜面末尾を再フィットする．
      rt.audio.onloadedmetadata = () => {
        if (!rt.audio) return;
        const d = rt.audio.duration;
        if (Number.isFinite(d) && d > 0) {
          rt.mediaDurationMs = d * 1000;
          if (!rt.gameRunning) rebuildChartForCurrentTime();
        }
      };
      rt.audio.onerror = () => {
        rt.lastAudioError = "audio load error";
        setProgress("Audio load failed");
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

  // 入力ズレ絶対値から判定ランクを返す．
  function judgeDelta(abs: number): Judge | null {
    if (abs <= JUDGE_WINDOWS.perfect) return "perfect";
    if (abs <= JUDGE_WINDOWS.great) return "great";
    if (abs <= JUDGE_WINDOWS.good) return "good";
    if (abs <= JUDGE_WINDOWS.miss) return "miss";
    return null;
  }

  // 判定テキストを短時間表示する UI ヘルパー．
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

  // 未判定ノーツ全体を時刻シフトする（ライブ補正用）．
  function shiftPendingNotes(shiftMs: number): void {
    const rt = runtimeRef.current;
    if (!Number.isFinite(shiftMs) || Math.abs(shiftMs) < 0.5) return;
    for (const n of rt.chart) {
      if (n.judged) continue;
      n.hitTime += shiftMs;
      n.holdEndTime += shiftMs;
    }
    rt.chartEndMs += shiftMs;
  }

  // ライブ補正キューを少しずつ適用し，譜面位置とオフセットを滑らかに調整する．
  function applySmoothLiveAdjust(rawMs: number): void {
    const rt = runtimeRef.current;
    if (!liveAdjustEnabled || rt.calibrationActive || rt.liveAdjustFrozen) return;
    // 冒頭 30 秒を過ぎたら補正を凍結して値を保存．
    if (rawMs > LIVE_ADJUST_WINDOW_MS) {
      rt.liveShiftPendingMs = 0;
      rt.liveOffsetPendingMs = 0;
      rt.liveAdjustFrozen = true;
      persistTuneForSong(Math.round(settingsRef.current.timingOffsetMs), settingsRef.current.chartTempoBpm);
      return;
    }

    // 譜面時刻シフトは 1 フレームあたり最大 5.2ms に制限．
    if (Math.abs(rt.liveShiftPendingMs) > 0.15) {
      const step = Math.max(-5.2, Math.min(5.2, rt.liveShiftPendingMs));
      shiftPendingNotes(step);
      rt.liveShiftPendingMs -= step;
    }

    // UI へ見せる timingOffset はさらに緩やかに更新．
    if (Math.abs(rt.liveOffsetPendingMs) > 0.1) {
      const stepOff = Math.max(-2.2, Math.min(2.2, rt.liveOffsetPendingMs));
      const next = Math.max(-300, Math.min(300, settingsRef.current.timingOffsetMs + stepOff));
      settingsRef.current.timingOffsetMs = next;
      rt.liveOffsetPendingMs -= stepOff;
      if (rawMs - rt.liveAdjustLastUiMs >= 180) {
        setTimingOffsetMs(Math.round(next));
        persistTuneForSong(Math.round(next), settingsRef.current.chartTempoBpm);
        rt.liveAdjustLastUiMs = rawMs;
      }
    }
  }

  // プレイヤー入力のズレ標本を収集して，補正量キューへ積む．
  function registerLiveTimingDelta(deltaMs: number): void {
    const rt = runtimeRef.current;
    if (!liveAdjustEnabled || rt.calibrationActive || rt.liveAdjustFrozen) return;
    if (getTimelineMs() > LIVE_ADJUST_WINDOW_MS) return;
    if (!Number.isFinite(deltaMs) || Math.abs(deltaMs) > 340) return;
    rt.liveAdjustSamples.push(deltaMs);
    if (rt.liveAdjustSamples.length > 44) rt.liveAdjustSamples.shift();
    const raw = getTimelineMs();
    if (rt.liveAdjustSamples.length < 5) return;
    if (raw - rt.liveAdjustLastApplyMs < 350) return;

    const sorted = [...rt.liveAdjustSamples].sort((a, b) => a - b);
    // 両端 10% を捨てて外れ値の影響を減らす．
    const cut = Math.floor(sorted.length * 0.1);
    const core = sorted.slice(cut, sorted.length - cut);
    if (!core.length) return;
    const avg = core.reduce((s, v) => s + v, 0) / core.length; // + => player late
    const correction = Math.max(-85, Math.min(85, avg * 1.45));
    if (Math.abs(correction) < 0.8) return;
    // Smooth strong mode: queue large correction and apply progressively.
    rt.liveShiftPendingMs += correction;
    rt.liveOffsetPendingMs += -correction * 0.55;
    rt.liveAdjustLastApplyMs = raw;
    rt.liveAdjustSamples = [];
  }

  // 通常ノーツの確定判定とスコア反映．
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

  // ロングノーツ頭の判定．成功時は holding 状態へ遷移する．
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

  // ロングノーツ尻の判定．保持継続できていれば成功．
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

  // カウントダウン完了後に本再生を開始する．
  function beginPlayAfterCountdown(): void {
    const rt = runtimeRef.current;
    rt.lastProgressUpdateMs = -1000;
    rt.gameRunning = true;
    rt.awaitingAudioStart = true;
    setCountdownText("");
    if (rt.audio) {
      rt.audio.currentTime = 0;
      rt.audio.muted = false;
      // prime 済みで再生中なら開始遅延を最小化できる．
      if (rt.audioPrimed && !rt.audio.paused) {
        rt.useSynthBgm = false;
        rt.startedAt = performance.now() - (rt.audio?.currentTime ?? 0) * 1000;
        rt.awaitingAudioStart = false;
      } else {
        rt.audio.play().then(() => {
          rt.useSynthBgm = false;
          rt.startedAt = performance.now() - (rt.audio?.currentTime ?? 0) * 1000;
          rt.awaitingAudioStart = false;
        }).catch(() => {
          rt.lastAudioError = "audio play blocked";
          rt.useSynthBgm = true;
          rt.startedAt = performance.now();
          rt.awaitingAudioStart = false;
          startSynthBgm();
          setProgress("Audio blocked, fallback synth");
        });
      }
    } else {
      rt.useSynthBgm = true;
      rt.startedAt = performance.now();
      rt.awaitingAudioStart = false;
      startSynthBgm();
    }
    loop();
  }

  // 事前 prime 済み audio が使えるなら即採用する．
  function activatePrimedAudioIfAvailable(): boolean {
    const rt = runtimeRef.current;
    if (!rt.audio) return false;
    rt.audio.currentTime = 0;
    rt.audio.muted = false;
    if (rt.audioPrimed && !rt.audio.paused) {
      rt.useSynthBgm = false;
      rt.startedAt = performance.now() - (rt.audio?.currentTime ?? 0) * 1000;
      return true;
    }
    return false;
  }

  // キャリブレーション時の再生開始（audio 優先，失敗時 synth）．
  function startAudioNowOrFallback(): void {
    const rt = runtimeRef.current;
    if (activatePrimedAudioIfAvailable()) return;
    if (rt.audio) {
      rt.audio.play().then(() => {
        rt.useSynthBgm = false;
        rt.startedAt = performance.now() - (rt.audio?.currentTime ?? 0) * 1000;
      }).catch(() => {
        rt.lastAudioError = "audio play blocked";
        rt.useSynthBgm = true;
        rt.startedAt = performance.now();
        startSynthBgm();
        setProgress("Audio blocked, fallback synth");
      });
    } else {
      rt.useSynthBgm = true;
      rt.startedAt = performance.now();
      startSynthBgm();
    }
  }

  // ユーザーのタップ時刻とアンカー時刻から最適オフセットを推定する．
  function calculateCalibrationOffset(taps: number[], anchors: number[]): number | null {
    if (taps.length < 6 || anchors.length < 8) return null;
    const deltas: number[] = [];
    for (const t of taps) {
      let best = Number.POSITIVE_INFINITY;
      let nearest = 0;
      for (const a of anchors) {
        const d = Math.abs(a - t);
        if (d < best) {
          best = d;
          nearest = a;
        }
      }
      // 最寄り差が大きすぎるタップはノイズとして破棄．
      if (best <= 240) deltas.push(nearest - t);
    }
    if (deltas.length < 5) return null;
    return median(deltas);
  }

  // 10 秒キャリブレーションを実行し，終了後に補正値を適用して再スタートする．
  function startCalibrationThenPlay(): void {
    const rt = runtimeRef.current;
    const anchorMaxMs = AUTO_CALIBRATION_MS;
    rt.gameRunning = true;
    rt.awaitingAudioStart = false;
    rt.lastProgressUpdateMs = -1000;
    // 早すぎる先頭や遅すぎる末尾は除外して，安定区間のみアンカー化．
    rt.calibrationAnchorTimes = rt.chart
      .map((n) => n.hitTime)
      .filter((t) => t >= 350 && t <= anchorMaxMs);
    rt.calibrationTapTimes = [];
    rt.calibrationActive = true;
    setProgress("Calibration 10s: tap Space / D F J K");
    setJudge("TAP");
    startAudioNowOrFallback();

    rt.calibrationTimer = window.setTimeout(() => {
      const delta = calculateCalibrationOffset(rt.calibrationTapTimes, rt.calibrationAnchorTimes);
      if (rt.audio) {
        rt.audio.pause();
        rt.audio.currentTime = 0;
      }
      rt.calibrationActive = false;
      rt.calibrationTimer = null;
      if (delta !== null && Number.isFinite(delta)) {
        const next = Math.max(-300, Math.min(300, Math.round(settingsRef.current.timingOffsetMs + delta)));
        settingsRef.current.timingOffsetMs = next;
        setTimingOffsetMs(next);
        persistTuneForSong(next, settingsRef.current.chartTempoBpm);
        setRecalibrateOnNextStart(false);
        setProgress(`Calibration applied: ${delta > 0 ? "+" : ""}${Math.round(delta)}ms`);
      } else {
        setProgress("Calibration skipped (not enough taps)");
      }
      resetGame();
      startGame(true);
    }, AUTO_CALIBRATION_MS);
    loop();
  }

  // カウントダウン開始．条件を満たす場合のみ事前キャリブレーションへ分岐する．
  function startGame(skipCalibration = false): void {
    const rt = runtimeRef.current;
    if (rt.gameRunning || rt.countdown.length) return;
    setProgress("Counting...");
    setJudge("-");
    setCountdownText("3");

    // オーディオはミュート再生で prime し，開始時の再生失敗を減らす．
    if (rt.audio) {
      rt.audio.currentTime = 0;
      rt.audio.muted = true;
      rt.audioPrimed = false;
      rt.audio.play().then(() => {
        rt.audioPrimed = true;
      }).catch(() => {
        if (rt.audio) {
          rt.audio.muted = false;
          rt.audioPrimed = false;
        }
        rt.lastAudioError = "prime failed";
        setProgress("Audio prime failed");
      });
    } else {
      rt.useSynthBgm = true;
    }

    // 0.7 秒刻みで 3,2,1 表示．
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
      const shouldCalibrate = autoSyncEnabled && rt.chart.length > 30 && (recalibrateOnNextStart || !hasTuneForSong(selectedScore));
      if (!skipCalibration && shouldCalibrate) {
        setCountdownText("");
        startCalibrationThenPlay();
        return;
      }
      beginPlayAfterCountdown();
    }, 2100);
    rt.countdown = [t1, t2, t3, t4];
  }

  // 現在の再生タイムライン（audio か performance.now 基準）を返す．
  function getTimelineMs(): number {
    const rt = runtimeRef.current;
    return !rt.useSynthBgm && rt.audio && !rt.audio.paused && Number.isFinite(rt.audio.currentTime)
      ? rt.audio.currentTime * 1000
      : performance.now() - rt.startedAt;
  }

  // 判定用時刻（ユーザー調整オフセット適用後）．
  function getSongTimeMs(): number {
    return getTimelineMs() + settingsRef.current.timingOffsetMs;
  }

  // 生の再生時刻（オフセット未適用）．
  function getRawSongTimeMs(): number {
    return getTimelineMs();
  }

  // 描画対象ノーツを更新し，過去ノーツの miss 処理と DOM スタイル反映を行う．
  function updateNotes(nowMs: number): void {
    const rt = runtimeRef.current;
    const pf = playfieldRef.current;
    if (!pf) return;
    // 判定ラインYは「下端からのオフセット」で管理．
    const judgeLineY = pf.clientHeight - settingsRef.current.judgeLineOffsetPx;
    const approachMs = BASE_APPROACH_MS * (10 / settingsRef.current.noteSpeed);
    const maxAhead = approachMs + 650;
    const pruneAhead = maxAhead + 520;
    const windowStartMs = nowMs - 6000;
    const windowEndMs = nowMs + pruneAhead;
    // 探索範囲を二分探索で絞って全量走査を避ける．
    const startIdx = Math.max(0, lowerBoundHitTime(rt.chart, windowStartMs) - 2);
    const endIdx = Math.min(rt.chart.length, lowerBoundHitTime(rt.chart, windowEndMs + 1) + 2);

    // 窓外へ流れた未判定ノーツを sweep で順次 miss 確定．
    while (rt.sweepIndex < startIdx) {
      const old = rt.chart[rt.sweepIndex];
      if (!old.judged) {
        if (old.durationMs > 0) {
          if (!old.headJudged) judgeLongHead(old, "miss");
          if (!old.tailJudged) judgeLongTail(old, false);
        } else {
          applyJudge(old, "miss");
        }
      }
      rt.sweepIndex += 1;
    }

    for (let i = startIdx; i < endIdx; i += 1) {
      const note = rt.chart[i];
      if (note.judged) continue;
      // dt > 0 は「まだ先」，dt < 0 は「過去」．
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
      // 0..1 の進行度をパース深度へ写像して位置・サイズを計算．
      const headLinear = clamp01(1 - (headTime - nowMs) / approachMs);
      const tailLinear = clamp01(1 - (tailTime - nowMs) / approachMs);
      const depthHead = Math.pow(headLinear, 1.15);
      const depthTail = Math.pow(tailLinear, 1.15);
      const yHeadRaw = 55 + (judgeLineY - 55) * depthHead;
      const yTailRaw = 55 + (judgeLineY - 55) * depthTail;

      const laneHead = laneBoundsAtDepth(note.lane, depthHead, pf.clientWidth);
      const laneTail = laneBoundsAtDepth(note.lane, depthTail, pf.clientWidth);
      const laneHeadW = Math.max(22, laneHead.right - laneHead.left);
      const laneTailW = Math.max(16, laneTail.right - laneTail.left);
      // ノーツ幅は遠近で拡大しつつ，レーン幅をはみ出さないよう制約．
      const wHead = Math.min(NOTE_BASE_WIDTH * (0.6 + depthHead * 1.2), laneHeadW * NOTE_LANE_FILL_RATIO);
      const wTail = Math.min(NOTE_BASE_WIDTH * (0.6 + depthTail * 1.2), laneTailW * NOTE_LANE_FILL_RATIO);
      const hHead = 26 * (0.58 + depthHead * 1.2);
      const hTail = 26 * (0.58 + depthTail * 1.2);
      const yHead = Math.min(yHeadRaw, judgeLineY - hHead / 2);
      const yTail = Math.min(yTailRaw, judgeLineY - hTail / 2);
      const xHead = laneHead.left + (laneHeadW - wHead) / 2;
      const xTail = laneTail.left + (laneTailW - wTail) / 2;
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
        // ロングは頭と尻を囲む矩形+clip-path で台形に描画する．
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

      // スタイル文字列が同一なら DOM 更新をスキップして負荷を下げる．
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

  // 押下維持中のロングノーツを監視し，早離し/完走を判定する．
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

  // レーン入力時に最適候補ノーツを探索して判定を適用する．
  function pressLane(laneIdx: number): void {
    const rt = runtimeRef.current;
    if (!rt.gameRunning || rt.awaitingAudioStart || rt.calibrationActive) return;
    const now = getSongTimeMs();
    let best: { note: PlayNote; abs: number; delta: number; longHead: boolean } | null = null;
    let lateHold: PlayNote | null = null;

    for (const note of rt.chart) {
      if (note.judged || note.lane !== laneIdx) continue;
      if (note.durationMs > 0) {
        if (!note.headJudged) {
          const d = now - note.hitTime;
          const a = Math.abs(d);
          // ソート済みなので，これより先のノーツはさらに未来側．
          if (d < -JUDGE_WINDOWS.miss) break;
          if (a <= JUDGE_WINDOWS.miss && (!best || a < best.abs)) {
            best = { note, abs: a, delta: d, longHead: true };
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
        best = { note, abs: a, delta: d, longHead: false };
      }
    }

    if (best) {
      const j = judgeDelta(best.abs) ?? "miss";
      if (j !== "miss") registerLiveTimingDelta(best.delta);
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

    // 有効な押下対象がない場合のみ空打ち MISS にする．
    const hasActive = rt.chart.some((n) => n.lane === laneIdx && n.holding && !n.judged);
    if (!hasActive) {
      rt.combo = 0;
      rt.missCount += 1;
      setJudge("MISS");
      setCombo(0);
      showHitFeedback("miss");
    }
  }

  // レーンを短時間ハイライトして入力フィードバックを出す．
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

  // 精度（%）からリザルトランクを返す．
  function calcRank(acc: number): string {
    if (acc >= 95) return "S";
    if (acc >= 88) return "A";
    if (acc >= 78) return "B";
    if (acc >= 66) return "C";
    return "D";
  }

  // ゲーム終了処理．タイマー停止，保存，結果計算，オーバーレイ表示まで行う．
  function stopGame(): void {
    const rt = runtimeRef.current;
    rt.gameRunning = false;
    rt.calibrationActive = false;
    if (rt.calibrationTimer) {
      clearTimeout(rt.calibrationTimer);
      rt.calibrationTimer = null;
    }
    if (rt.rafId) cancelAnimationFrame(rt.rafId);
    rt.audio?.pause();
    stopSynthBgm();
    persistTuneForSong(Math.round(settingsRef.current.timingOffsetMs), settingsRef.current.chartTempoBpm);
    setProgress("Finished");
    const acc = rt.possiblePoints > 0 ? (rt.achievedPoints / rt.possiblePoints) * 100 : 0;
    const clear = acc >= 72 && rt.missCount < Math.max(30, Math.floor(rt.chart.length * 0.22));
    setResult({ show: true, state: clear ? "CLEAR!" : "FAILED", rank: `RANK ${calcRank(acc)}`, acc: `${acc.toFixed(1)}%`, score: `${rt.score}` });
  }

  // requestAnimationFrame のメインループ．
  // 時刻取得 -> 自動補正 -> 判定更新 -> 描画更新 -> 終了判定 の順で実行する．
  function loop(): void {
    const rt = runtimeRef.current;
    if (!rt.gameRunning) return;
    // audio 開始待ち中は判定/描画更新を保留する．
    if (rt.awaitingAudioStart) {
      rt.rafId = requestAnimationFrame(loop);
      return;
    }
    if (rt.calibrationActive) {
      const rawCal = getTimelineMs();
      const calSec = Math.min(AUTO_CALIBRATION_MS / 1000, rawCal / 1000);
      if (rawCal - rt.lastProgressUpdateMs >= 120) {
        setProgress(`Calibrating ${calSec.toFixed(1)}s / ${(AUTO_CALIBRATION_MS / 1000).toFixed(1)}s`);
        rt.lastProgressUpdateMs = rawCal;
      }
      rt.rafId = requestAnimationFrame(loop);
      return;
    }
    const rawMs = getTimelineMs();
    const now = rawMs + settingsRef.current.timingOffsetMs;
    applySmoothLiveAdjust(rawMs);
    // HTMLAudio の終了検知．末尾誤差を見込んで少し手前でも終了扱いにする．
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

  // タップテンポモードの ON/OFF．
  function toggleTapTempo(): void {
    setTapTempoMode((v) => !v);
    setTapTimes([]);
    setTapTempoState((v) => (v === "idle" ? "tap quarter notes..." : "idle"));
  }

  // 収集したタップ間隔から BPM と timing offset を再推定して適用する．
  function applyTapTempo(): void {
    if (tapTimes.length < 4) return;
    const intervals = tapTimes.slice(1).map((t, i) => t - tapTimes[i]);
    // 手拍子のばらつきに強い中央値を採用．
    const beatMs = median(intervals);
    if (!Number.isFinite(beatMs) || beatMs < 350 || beatMs > 1400) {
      setTapTempoState("failed, retry");
      return;
    }
    const bpm = 60000 / beatMs;
    setChartTempoBpmState(Math.max(50, Math.min(110, bpm)));

    // 最寄り拍へ丸めた誤差の平均を，追加オフセットとして反映．
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

  // タップテンポ中のキー入力を記録する．
  function registerTap(): void {
    if (!tapTempoMode || !runtimeRef.current.gameRunning) return;
    setTapTimes((prev) => {
      const next = [...prev, getRawSongTimeMs()].slice(-12);
      // 8 回程度たまったら自動適用してテンポ推定を安定化．
      if (next.length >= 8) {
        window.setTimeout(applyTapTempo, 0);
      } else {
        setTapTempoState(`taps: ${next.length}`);
      }
      return next;
    });
  }

  // キャリブレーション中のタップ時刻を蓄積する．
  function registerCalibrationTap(): void {
    const rt = runtimeRef.current;
    if (!rt.calibrationActive) return;
    rt.calibrationTapTimes.push(getTimelineMs());
    if (rt.calibrationTapTimes.length > 120) {
      rt.calibrationTapTimes.shift();
    }
  }

  // 曲ごとのチューニング保存キーを返す．
  function tuneKey(meta: ScoreMeta): string {
    return `pjsk_song_tune_${encodeURIComponent(meta.audioUrl || meta.id)}`;
  }

  function hasTuneForSong(meta: ScoreMeta): boolean {
    return !!localStorage.getItem(tuneKey(meta));
  }

  // 現在曲向けに timing / bpm 設定を永続化する．
  function persistTuneForSong(timing: number, bpm: number): void {
    localStorage.setItem(
      tuneKey(selectedScore),
      JSON.stringify({ timingOffsetMs: timing, chartTempoBpm: bpm })
    );
  }

  // 手動保存ボタン処理．
  function saveTuneForSong(): void {
    persistTuneForSong(timingOffsetMs, chartTempoBpm);
    setRecalibrateOnNextStart(false);
    setProgress("Saved tune for this song");
  }

  // 曲切替時に保存済みチューニングを読み込む．
  function loadTuneForSong(meta: ScoreMeta): void {
    try {
      const raw = localStorage.getItem(tuneKey(meta));
      if (!raw) return;
      const s = JSON.parse(raw) as { timingOffsetMs?: number; chartTempoBpm?: number };
      if (Number.isFinite(s.timingOffsetMs)) setTimingOffsetMs(Math.max(-300, Math.min(300, Number(s.timingOffsetMs))));
      if (Number.isFinite(s.chartTempoBpm)) setChartTempoBpmState(Math.max(50, Math.min(110, Number(s.chartTempoBpm))));
    } catch {
      // 壊れた JSON は無視して既定値のまま進める．
    }
  }

  // 曲ごとの保存チューニングを削除して既定値へ戻す．
  function resetTuneForSong(): void {
    localStorage.removeItem(tuneKey(selectedScore));
    setTimingOffsetMs(selectedScore.offsetMs || 0);
    setChartTempoBpmState(selectedScore.bpm || 66);
    setRecalibrateOnNextStart(true);
    rebuildChartForCurrentTime();
    setProgress("Reset tune for this song");
  }

  // 選択曲が変わったら曲別チューニングを適用．
  useEffect(() => {
    loadTuneForSong(selectedScore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScoreId]);

  // キーボード入力のグローバルハンドラ．
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // キャリブレーション中はタップ採取だけ行う．
      if (runtimeRef.current.calibrationActive) {
        if (e.code === "Space" || e.code === "KeyT" || HIT_KEYS.includes(e.code)) {
          e.preventDefault();
          registerCalibrationTap();
          const idx = HIT_KEYS.indexOf(e.code);
          if (idx >= 0) flashLane(idx);
        }
        return;
      }
      if (tapTempoMode && (e.code === "Space" || e.code === "KeyT")) {
        e.preventDefault();
        registerTap();
        return;
      }
      const idx = HIT_KEYS.indexOf(e.code);
      if (idx < 0 || e.repeat) return;
      // 押下状態と判定を同時に更新．
      runtimeRef.current.lanePressed[idx] = true;
      flashLane(idx);
      pressLane(idx);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      // プレイ中の微調整ショートカット．
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

  // タッチ/ポインタ入力開始時の処理．
  function onLanePointerDown(i: number): void {
    if (runtimeRef.current.calibrationActive) {
      registerCalibrationTap();
      flashLane(i);
      return;
    }
    runtimeRef.current.lanePressed[i] = true;
    flashLane(i);
    pressLane(i);
  }

  return (
    <>
      {/* 背景の発光エフェクト層． */}
      <div className="bg-glow" />
      <main className="app">
        {!isMobileUi && (
          /* デスクトップ用ヘッダ（スコア情報と曲セレクト）． */
          <header className="topbar">
            <div className="title-wrap">
              <h1>SEKAI-Like Rhythm Demo</h1>
              <p className="keyboard-hint">キー: D / F / J / K，またはレーンをタップ</p>
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
              <div className="song-select-desktop">
                <span className="label">曲リスト</span>
                <select value={selectedScoreId} onChange={(e) => setSelectedScoreId(e.target.value)}>
                  {scores.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
              </div>
            </div>
          </header>
        )}

        <section className="playfield-wrap">
          <div className="playfield" id="playfield" ref={playfieldRef}>
            {!isMobileUi && (
              <div className="mobile-song-chip" aria-hidden="true">{selectedScore.title}</div>
            )}
            <div className="cue">{runtimeRef.current.gameRunning ? "" : "READY"}</div>
            <div className={`countdown-overlay ${countdownText ? "" : "hidden"}`}>{countdownText}</div>
            <div className="judge-line" />
            {/* 判定ライン手前の背景装飾（パース付き）． */}
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
            {/* 透明ボタンで4レーンのポインタ入力を受け取る． */}
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
            {/* ノーツDOMを imperative に配置する専用レイヤー． */}
            <div id="notes-layer" ref={notesLayerRef} />
            <div className={`hit-feedback ${hitFeedback.visible ? "" : "hidden"} ${hitFeedback.className}`}>
              {hitFeedback.text}
            </div>
            {/* クリア/失敗の結果表示オーバーレイ． */}
            <div className={`result-overlay ${result.show ? "" : "hidden"}`} aria-hidden={!result.show}>
              <div className="result-card">
                <p className={`result-state ${result.state === "CLEAR!" ? "judge-great" : "judge-miss"}`}>{result.state}</p>
                <p className="result-rank">{result.rank}</p>
                <p className="result-score">SCORE {result.score}</p>
                <p className="result-meta">ACCURACY {result.acc}</p>
                <button className="primary result-restart" onClick={() => { resetGame(); startGame(); }}>RESTART</button>
              </div>
            </div>
          </div>
        </section>

        <footer className="controls">
          {/* 再初期化して即開始する． */}
          <button className="primary" onClick={() => { resetGame(); startGame(); }}>START / RESTART</button>
          <button onClick={() => setSettingsOpen(true)}>SETTINGS</button>
          {!isMobileUi && <div className="progress">{progress}</div>}
        </footer>
      </main>

      <div className={`settings-panel ${settingsOpen ? "" : "hidden"}`} onClick={(e) => {
        // モーダル外クリックで閉じる．
        if (e.target === e.currentTarget) setSettingsOpen(false);
      }}>
        <div className="settings-card">
          <h2>Settings</h2>
          <label>現在情報</label>
          <div className="speed-row">
            <span>Score / Combo</span>
            <span>{score} / {combo}</span>
          </div>
          <div className="speed-row">
            <span>Judge</span>
            <span>{judge}</span>
          </div>
          <div className="speed-row">
            <span>Song</span>
            <span>{songTitle}</span>
          </div>
          <div className="speed-row">
            <span>BGM</span>
            <span>{customAudioName ? `custom: ${customAudioName}` : isMidiUrl(getEffectiveAudioUrl()) ? "MIDI synth" : "audio file"}</span>
          </div>
          <div className="speed-row">
            <span>Status</span>
            <span>{progress}</span>
          </div>
          <div className="speed-row">
            <span>Audio Error</span>
            <span>{runtimeRef.current.lastAudioError || "-"}</span>
          </div>
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
            {/* 変更時は譜面再生成して体感テンポを即反映． */}
            <input type="range" min={50} max={110} step={0.5} value={chartTempoBpm} onChange={(e) => { setChartTempoBpmState(Number(e.target.value)); rebuildChartForCurrentTime(); }} />
            <span>{chartTempoBpm.toFixed(1)}</span>
          </div>
          <label>曲リスト</label>
          <div className="speed-row">
            <select value={selectedScoreId} onChange={(e) => setSelectedScoreId(e.target.value)}>
              {scores.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
            <span>{selectedScore.artist}</span>
          </div>
          <div className="speed-row">
            <button onClick={toggleTapTempo}>TAP TEMPO</button>
            <span>{tapTempoState}</span>
          </div>
          <label>Auto Sync (10s)</label>
          <div className="speed-row">
            <button onClick={() => setAutoSyncEnabled((v) => !v)}>
              {autoSyncEnabled ? "ON" : "OFF"}
            </button>
            <span>{autoSyncEnabled ? "初回/再測定時のみ開始前に10秒測定" : "常に測定なしで開始"}</span>
          </div>
          <label>再測定（次回開始時）</label>
          <div className="speed-row">
            <button onClick={() => setRecalibrateOnNextStart((v) => !v)}>
              {recalibrateOnNextStart ? "ON" : "OFF"}
            </button>
            <span>{recalibrateOnNextStart ? "次回STARTで10秒測定を実施" : "保存済み補正をそのまま使用"}</span>
          </div>
          <label>調整モード（プレイ中）</label>
          <div className="speed-row">
            <button onClick={() => setLiveAdjustEnabled((v) => !v)}>
              {liveAdjustEnabled ? "ON" : "OFF"}
            </button>
            <span>{liveAdjustEnabled ? "平均ズレを超強力補正＋曲別デフォルト保存" : "補正しない"}</span>
          </div>
          <div className="speed-row">
            <input type="file" accept=".musicxml,.xml,.mxl,.mid,.midi" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const lower = file.name.toLowerCase();
                if (lower.endsWith(".mid") || lower.endsWith(".midi")) {
                  // MIDI は時刻情報つきなのでそのまま再生/譜面ソースに使う．
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
                  // XML/MXL は拍ベース情報を parser で ScoreEvent 化する．
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
              // 既存 object URL は解放してリークを防ぐ．
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
