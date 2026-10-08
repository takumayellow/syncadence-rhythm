// 音源から生成した譜面ファイル (scripts/build_charts.py が出力する chart.json) の読み込み．
// ノーツの時刻は音源の再生位置 (audio.currentTime, ms) そのもので，楽譜からの写像は挟まない．
import type { PlayNote } from "./types";

export const DIFFICULTIES = ["easy", "normal", "hard", "expert"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "EASY",
  normal: "NORMAL",
  hard: "HARD",
  expert: "EXPERT",
};

// [hitMs, lane, durationMs]
type RawNote = [number, number, number];

export type ChartFile = {
  version: 1;
  durationMs: number;
  difficulties: Record<Difficulty, RawNote[]>;
};

const LANES = 4;
const MAX_NOTES = 20000;

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === "string" && (DIFFICULTIES as readonly string[]).includes(v);
}

function isRawNote(v: unknown): v is RawNote {
  if (!Array.isArray(v) || v.length !== 3) return false;
  const [t, lane, dur] = v;
  return (
    Number.isFinite(t) &&
    t >= 0 &&
    Number.isInteger(lane) &&
    lane >= 0 &&
    lane < LANES &&
    Number.isFinite(dur) &&
    dur >= 0
  );
}

// 形が崩れたファイルで描画ループを壊さないよう，読み込み時に全ノーツを検査する．
export function parseChart(data: unknown): ChartFile {
  const obj = data as Partial<ChartFile> | null;
  if (!obj || obj.version !== 1 || typeof obj.difficulties !== "object" || !obj.difficulties) {
    throw new Error("unsupported chart format");
  }
  const difficulties = {} as Record<Difficulty, RawNote[]>;
  for (const d of DIFFICULTIES) {
    const notes = (obj.difficulties as Record<string, unknown>)[d];
    if (!Array.isArray(notes) || notes.length > MAX_NOTES || !notes.every(isRawNote)) {
      throw new Error(`invalid notes for ${d}`);
    }
    difficulties[d] = notes;
  }
  return {
    version: 1,
    durationMs: Number.isFinite(obj.durationMs) ? Number(obj.durationMs) : 0,
    difficulties,
  };
}

export async function fetchChart(url: string): Promise<ChartFile> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`chart not found: ${res.status}`);
  return parseChart(await res.json());
}

export function chartToNotes(chart: ChartFile, difficulty: Difficulty): PlayNote[] {
  return chart.difficulties[difficulty]
    .map(([hitTime, lane, durationMs]) => ({
      lane,
      hitTime,
      durationMs,
      holdEndTime: hitTime + durationMs,
      judged: false,
      holding: false,
      holdBroken: false,
      headJudged: false,
      tailJudged: false,
      element: null,
      lastStyleKey: "",
    }))
    .sort((a, b) => a.hitTime - b.hitTime || a.lane - b.lane);
}

// ランキングは難易度ごとに分ける．
export function rankingSongId(songId: string, difficulty: Difficulty): string {
  return `${songId}.${difficulty}`;
}
