/**
 * Score validation script
 * Parses all MXL files using the app's parseMusicXml logic and reports issues.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";
import { JSDOM } from "jsdom";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const SONGS_DIR = join(PROJECT_ROOT, "public", "scores", "songs");

// ---------------------------------------------------------------------------
// Re-implement parseMusicXml for Node.js (using jsdom's DOMParser)
// ---------------------------------------------------------------------------

function pitchToMidi(step, alter, octave) {
  const map = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (octave + 1) * 12 + (map[step] ?? 0) + alter;
}

function divToMs(divPos, tempos, divisions) {
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

function divDurationToMs(startDiv, durDiv, tempos, divisions) {
  const endDiv = startDiv + durDiv;
  const startMs = divToMs(startDiv, tempos, divisions);
  const endMs = divToMs(endDiv, tempos, divisions);
  return Math.max(0, endMs - startMs);
}

function parseMusicXml(xmlText) {
  const dom = new JSDOM("");
  const parser = new dom.window.DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const parserError = doc.querySelector("parsererror");
  if (parserError) throw new Error("MusicXML parse error");

  const part = doc.querySelector("part");
  if (!part) throw new Error("MusicXML has no part");

  // Pass 1: collect tempo markings
  const tempos = [];
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

      const soundEls =
        node.tagName === "direction"
          ? Array.from(node.querySelectorAll("sound"))
          : node.tagName === "sound"
          ? [node]
          : [];

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

  if (tempos.length === 0) {
    tempos.push({ divPos: 0, bpm: 120 });
  }
  tempos.sort((a, b) => a.divPos - b.divPos);
  if (tempos[0].divPos !== 0) {
    tempos.unshift({ divPos: 0, bpm: tempos[0].bpm });
  }

  // Pass 2: parse notes
  let divisions = 1;
  let cursorDiv = 0;
  let lastChordStart = 0;
  const raw = [];

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

// ---------------------------------------------------------------------------
// Extract MusicXML text from an MXL (ZIP) file
// ---------------------------------------------------------------------------

async function extractMusicXmlFromMxl(mxlPath) {
  const data = readFileSync(mxlPath);
  const zip = await JSZip.loadAsync(data);

  // Find the .musicxml or .xml file inside the archive
  let xmlFile = null;
  for (const name of Object.keys(zip.files)) {
    if (name.endsWith(".musicxml") || (name.endsWith(".xml") && name !== "META-INF/container.xml")) {
      xmlFile = zip.files[name];
      break;
    }
  }

  if (!xmlFile) {
    // Fallback: try container.xml to find rootfile
    const container = zip.files["META-INF/container.xml"];
    if (container) {
      const containerText = await container.async("text");
      const dom = new JSDOM("");
      const parser = new dom.window.DOMParser();
      const doc = parser.parseFromString(containerText, "application/xml");
      const rootfile = doc.querySelector("rootfile");
      const fullPath = rootfile?.getAttribute("full-path");
      if (fullPath && zip.files[fullPath]) {
        xmlFile = zip.files[fullPath];
      }
    }
  }

  if (!xmlFile) {
    throw new Error("No MusicXML content found in MXL archive");
  }

  return xmlFile.async("text");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validateSong(songDir) {
  const songId = basename(songDir);
  const mxlPath = join(songDir, "score.mxl");

  if (!existsSync(mxlPath)) {
    return { songId, error: "No score.mxl found", notes: 0 };
  }

  try {
    const xmlText = await extractMusicXmlFromMxl(mxlPath);
    const events = parseMusicXml(xmlText);
    const issues = [];

    const noteCount = events.length;
    if (noteCount === 0) {
      issues.push("0 notes parsed");
      return { songId, notes: 0, issues };
    }

    const timeMsValues = events.map((e) => e.timeMs);
    const durationMsValues = events.map((e) => e.durationMs);

    const minTimeMs = Math.min(...timeMsValues);
    const maxTimeMs = Math.max(...timeMsValues);
    const minDurMs = Math.min(...durationMsValues);
    const maxDurMs = Math.max(...durationMsValues);
    const totalSpanSec = (maxTimeMs - minTimeMs) / 1000;

    // Check for negative timeMs
    const negativeCount = timeMsValues.filter((t) => t < 0).length;
    if (negativeCount > 0) {
      issues.push(`${negativeCount} notes with negative timeMs`);
    }

    // Check for 0-duration notes
    const zeroDurCount = durationMsValues.filter((d) => d === 0).length;
    if (zeroDurCount > 0) {
      issues.push(`${zeroDurCount} notes with 0ms duration`);
    }

    // Check for very short total duration
    if (totalSpanSec < 10) {
      issues.push(`Very short duration: ${totalSpanSec.toFixed(1)}s`);
    }

    // Check monotonicity of timeMs (after sort, should be non-decreasing)
    let monoViolations = 0;
    for (let i = 1; i < timeMsValues.length; i++) {
      if (timeMsValues[i] < timeMsValues[i - 1]) {
        monoViolations++;
      }
    }
    if (monoViolations > 0) {
      issues.push(`${monoViolations} monotonicity violations in timeMs`);
    }

    // Check for duplicate timeMs (potential parsing issue if too many)
    const timeFreq = {};
    for (const t of timeMsValues) {
      const key = t.toFixed(2);
      timeFreq[key] = (timeFreq[key] || 0) + 1;
    }
    const maxDupes = Math.max(...Object.values(timeFreq));
    const dupeTimestamps = Object.values(timeFreq).filter((c) => c > 1).length;
    if (maxDupes > 10) {
      issues.push(`Max ${maxDupes} notes at same timeMs (${dupeTimestamps} duplicate timestamps)`);
    }

    return {
      songId,
      notes: noteCount,
      minTimeMs: Math.round(minTimeMs),
      maxTimeMs: Math.round(maxTimeMs),
      spanSec: totalSpanSec.toFixed(1),
      minDurMs: Math.round(minDurMs),
      maxDurMs: Math.round(maxDurMs),
      maxSimultaneous: maxDupes,
      issues,
    };
  } catch (err) {
    return { songId, error: err.message, notes: 0, issues: [err.message] };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const songDirs = readdirSync(SONGS_DIR)
    .map((d) => join(SONGS_DIR, d))
    .filter((d) => existsSync(join(d, "score.mxl")))
    .sort();

  console.log(`Found ${songDirs.length} songs with score.mxl\n`);

  const results = [];
  for (const dir of songDirs) {
    const r = await validateSong(dir);
    results.push(r);
  }

  // Print table
  const header = [
    "Song ID".padEnd(35),
    "Notes".padStart(6),
    "MinT(ms)".padStart(9),
    "MaxT(ms)".padStart(9),
    "Span(s)".padStart(8),
    "MinDur".padStart(7),
    "MaxDur".padStart(7),
    "MaxSim".padStart(7),
    "Issues",
  ].join(" | ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const r of results) {
    if (r.error) {
      console.log(
        `${r.songId.padEnd(35)} | ${"ERROR".padStart(6)} | ${r.error}`
      );
      continue;
    }

    const issueStr = r.issues.length > 0 ? r.issues.join("; ") : "OK";
    const row = [
      r.songId.padEnd(35),
      String(r.notes).padStart(6),
      String(r.minTimeMs).padStart(9),
      String(r.maxTimeMs).padStart(9),
      String(r.spanSec).padStart(8),
      String(r.minDurMs).padStart(7),
      String(r.maxDurMs).padStart(7),
      String(r.maxSimultaneous).padStart(7),
      issueStr,
    ].join(" | ");
    console.log(row);
  }

  // Summary
  const withIssues = results.filter(
    (r) => r.issues && r.issues.length > 0
  );
  const withErrors = results.filter((r) => r.error);

  console.log(`\n--- Summary ---`);
  console.log(`Total songs validated: ${results.length}`);
  console.log(`Songs with errors: ${withErrors.length}`);
  console.log(`Songs with issues: ${withIssues.length}`);
  console.log(
    `Songs passing all checks: ${results.length - withIssues.length - withErrors.length}`
  );

  if (withIssues.length > 0 || withErrors.length > 0) {
    console.log(`\n--- Flagged Songs ---`);
    for (const r of [...withErrors, ...withIssues]) {
      const msgs = r.error ? [r.error] : r.issues;
      console.log(`  ${r.songId}: ${msgs.join("; ")}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
