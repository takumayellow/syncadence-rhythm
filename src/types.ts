export type Judge = "perfect" | "great" | "good" | "miss";

export type ScoreMeta = {
  id: string;
  title: string;
  artist: string;
  audioUrl: string;
  xmlPath?: string;
  mxlPath?: string;
  midiPath?: string;
  strictMode?: boolean;
  offsetMs: number;
  bpm: number;
  lengthSec: number;
};

export type ScoreEvent = {
  beatPos: number;
  durationBeats: number;
  midi: number;
  timeMs?: number;
  durationMs?: number;
};

export type PlayNote = {
  lane: number;
  hitTime: number;
  durationMs: number;
  holdEndTime: number;
  judged: boolean;
  holding: boolean;
  holdBroken: boolean;
  headJudged: boolean;
  tailJudged: boolean;
  element: HTMLDivElement | null;
  lastStyleKey: string;
};
