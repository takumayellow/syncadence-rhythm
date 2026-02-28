import type { ScoreEvent } from "./types";

function pitchToMidi(step: string, alter: number, octave: number): number {
  const map: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (octave + 1) * 12 + (map[step] ?? 0) + alter;
}

export function parseMusicXml(xmlText: string): ScoreEvent[] {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) throw new Error("MusicXML parse error");

  const part = doc.querySelector("part");
  if (!part) throw new Error("MusicXML has no part");

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
      raw.push({ beatPos, durationBeats, midi });

      lastChordStart = startDiv;
      if (!hasChord) cursorDiv += durDiv;
    }
  }

  raw.sort((a, b) => a.beatPos - b.beatPos);
  return raw;
}
