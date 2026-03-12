import type { ScoreEvent } from "./types";

function pitchToMidi(step: string, alter: number, octave: number): number {
  const map: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (octave + 1) * 12 + (map[step] ?? 0) + alter;
}

// テンポ変更点を保持する型．
type TempoMark = {
  divPos: number;   // divisions 単位の絶対位置
  bpm: number;      // その時点からの BPM
};

// divisions 単位の位置をミリ秒に変換する．
// テンポ変化を逐次追跡して正確な経過時刻を求める．
function divToMs(
  divPos: number,
  tempos: TempoMark[],
  divisions: number,
): number {
  let ms = 0;
  let prevDiv = 0;
  let currentBpm = tempos[0]?.bpm ?? 120;

  for (let i = 1; i < tempos.length; i++) {
    if (tempos[i].divPos >= divPos) break;
    const dt = tempos[i].divPos - prevDiv;
    ms += (dt / divisions) * (60000 / currentBpm);
    prevDiv = tempos[i].divPos;
    currentBpm = tempos[i].bpm;
  }

  const tail = divPos - prevDiv;
  ms += (tail / divisions) * (60000 / currentBpm);
  return ms;
}

// divisions 単位の長さをミリ秒に変換する（開始位置のテンポを使用）．
function divDurationToMs(
  startDiv: number,
  durDiv: number,
  tempos: TempoMark[],
  divisions: number,
): number {
  // 区間内にテンポ変化がある場合も正確に計算する．
  const endDiv = startDiv + durDiv;
  const startMs = divToMs(startDiv, tempos, divisions);
  const endMs = divToMs(endDiv, tempos, divisions);
  return Math.max(0, endMs - startMs);
}

export function parseMusicXml(xmlText: string): ScoreEvent[] {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) throw new Error("MusicXML parse error");

  const part = doc.querySelector("part");
  if (!part) throw new Error("MusicXML has no part");

  // --- Pass 1: テンポマーキングを収集する ---
  // MusicXML のテンポは <direction><sound tempo="X"/></direction> に記述される．
  // 一部の楽譜では <measure> 直下の <sound> にも出る．
  const tempos: TempoMark[] = [];
  let scanDiv = 0;
  let scanDivisions = 1;

  for (const measure of Array.from(part.querySelectorAll("measure"))) {
    const divEl = measure.querySelector("attributes > divisions");
    if (divEl) {
      const d = Number(divEl.textContent ?? "1");
      if (Number.isFinite(d) && d > 0) scanDivisions = d;
    }

    for (const node of Array.from(measure.children)) {
      if (node.tagName === "backup") {
        const d = Number(node.querySelector("duration")?.textContent ?? "0");
        scanDiv = Math.max(0, scanDiv - d);
        continue;
      }
      if (node.tagName === "forward") {
        const d = Number(node.querySelector("duration")?.textContent ?? "0");
        scanDiv += d;
        continue;
      }

      // <direction> 内または直接の <sound tempo="...">
      const soundEls = node.tagName === "direction"
        ? Array.from(node.querySelectorAll("sound"))
        : node.tagName === "sound" ? [node] : [];

      for (const s of soundEls) {
        const t = Number(s.getAttribute("tempo") ?? "");
        if (Number.isFinite(t) && t > 0) {
          tempos.push({ divPos: scanDiv, bpm: t });
        }
      }

      if (node.tagName === "note") {
        const hasChord = !!node.querySelector("chord");
        const durDiv = Number(node.querySelector("duration")?.textContent ?? "0");
        if (!hasChord) scanDiv += durDiv;
      }
    }
  }

  // テンポマーキングがなければデフォルト 120 BPM とする．
  if (tempos.length === 0) {
    tempos.push({ divPos: 0, bpm: 120 });
  }
  tempos.sort((a, b) => a.divPos - b.divPos);
  // 先頭が 0 でない場合は追加する．
  if (tempos[0].divPos !== 0) {
    tempos.unshift({ divPos: 0, bpm: tempos[0].bpm });
  }

  // --- Pass 2: ノートを解析して timeMs / durationMs 付きで返す ---
  let divisions = 1;
  let cursorDiv = 0;
  let lastChordStart = 0;
  const raw: ScoreEvent[] = [];

  for (const measure of Array.from(part.querySelectorAll("measure"))) {
    const divEl = measure.querySelector("attributes > divisions");
    if (divEl) {
      const d = Number(divEl.textContent ?? "1");
      if (Number.isFinite(d) && d > 0) divisions = d;
    }

    for (const node of Array.from(measure.children)) {
      if (node.tagName === "backup") {
        const d = Number(node.querySelector("duration")?.textContent ?? "0");
        cursorDiv = Math.max(0, cursorDiv - d);
        continue;
      }
      if (node.tagName === "forward") {
        const d = Number(node.querySelector("duration")?.textContent ?? "0");
        cursorDiv += d;
        continue;
      }
      if (node.tagName !== "note") continue;
      if (node.querySelector("rest") || node.querySelector("grace")) {
        const d = Number(node.querySelector("duration")?.textContent ?? "0");
        if (!node.querySelector("chord")) cursorDiv += d;
        continue;
      }

      const hasChord = !!node.querySelector("chord");
      const durDiv = Number(node.querySelector("duration")?.textContent ?? "0");
      const startDiv = hasChord ? lastChordStart : cursorDiv;

      const step = node.querySelector("pitch > step")?.textContent ?? "C";
      const alter = Number(node.querySelector("pitch > alter")?.textContent ?? "0");
      const octave = Number(node.querySelector("pitch > octave")?.textContent ?? "4");
      const midi = pitchToMidi(step, alter, octave);

      const beatPos = startDiv / divisions;
      const durationBeats = Math.max(0, durDiv / divisions);
      const timeMs = divToMs(startDiv, tempos, divisions);
      const durationMs = divDurationToMs(startDiv, durDiv, tempos, divisions);

      raw.push({ beatPos, durationBeats, midi, timeMs, durationMs });

      lastChordStart = startDiv;
      if (!hasChord) cursorDiv += durDiv;
    }
  }

  raw.sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0));
  return raw;
}
