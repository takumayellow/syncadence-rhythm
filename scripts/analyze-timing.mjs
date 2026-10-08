// 全曲の譜面長 vs オーディオ長を分析し、offsetMs を自動推定するスクリプト
import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';

// 簡易 MusicXML パーサー（timeMs を得るため）
function pitchToMidi(step, alter, octave) {
  const map = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (octave + 1) * 12 + (map[step] ?? 0) + alter;
}

function divToMs(divPos, tempos, divisions) {
  let ms = 0, prevDiv = 0, currentBpm = tempos[0]?.bpm ?? 120;
  for (let i = 1; i < tempos.length; i++) {
    if (tempos[i].divPos >= divPos) break;
    ms += ((tempos[i].divPos - prevDiv) / divisions) * (60000 / currentBpm);
    prevDiv = tempos[i].divPos;
    currentBpm = tempos[i].bpm;
  }
  ms += ((divPos - prevDiv) / divisions) * (60000 / currentBpm);
  return ms;
}

function parseMusicXml(xmlText, meta = {}) {
  const dom = new JSDOM(xmlText, { contentType: 'application/xml' });
  const doc = dom.window.document;
  const part = doc.querySelector('part');
  if (!part) return [];

  // Pass 1: tempos
  const tempos = [];
  let scanDiv = 0, scanDivisions = 1;
  for (const measure of Array.from(part.querySelectorAll('measure'))) {
    const divEl = measure.querySelector('attributes > divisions');
    if (divEl) { const d = Number(divEl.textContent); if (d > 0) scanDivisions = d; }
    for (const node of Array.from(measure.childNodes)) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'backup') { scanDiv = Math.max(0, scanDiv - Number(node.querySelector('duration')?.textContent || 0)); continue; }
      if (node.tagName === 'forward') { scanDiv += Number(node.querySelector('duration')?.textContent || 0); continue; }
      const soundEls = node.tagName === 'direction' ? Array.from(node.querySelectorAll('sound')) : node.tagName === 'sound' ? [node] : [];
      for (const s of soundEls) { const t = Number(s.getAttribute('tempo')); if (t > 0) tempos.push({ divPos: scanDiv, bpm: t }); }
      if (node.tagName === 'note') { if (!node.querySelector('chord')) scanDiv += Number(node.querySelector('duration')?.textContent || 0); }
    }
  }
  meta.tempoMarks = tempos.length;
  if (!tempos.length) tempos.push({ divPos: 0, bpm: 120 });
  tempos.sort((a, b) => a.divPos - b.divPos);
  if (tempos[0].divPos !== 0) tempos.unshift({ divPos: 0, bpm: tempos[0].bpm });

  // Pass 2: notes
  let divisions = 1, cursorDiv = 0, lastChordStart = 0;
  const raw = [];
  for (const measure of Array.from(part.querySelectorAll('measure'))) {
    const divEl = measure.querySelector('attributes > divisions');
    if (divEl) { const d = Number(divEl.textContent); if (d > 0) divisions = d; }
    for (const node of Array.from(measure.childNodes)) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'backup') { cursorDiv = Math.max(0, cursorDiv - Number(node.querySelector('duration')?.textContent || 0)); continue; }
      if (node.tagName === 'forward') { cursorDiv += Number(node.querySelector('duration')?.textContent || 0); continue; }
      if (node.tagName !== 'note') continue;
      if (node.querySelector('rest') || node.querySelector('grace')) {
        if (!node.querySelector('chord')) cursorDiv += Number(node.querySelector('duration')?.textContent || 0);
        continue;
      }
      const hasChord = !!node.querySelector('chord');
      const durDiv = Number(node.querySelector('duration')?.textContent || 0);
      const startDiv = hasChord ? lastChordStart : cursorDiv;
      const timeMs = divToMs(startDiv, tempos, divisions);
      const endMs = divToMs(startDiv + durDiv, tempos, divisions);
      raw.push({ timeMs, durationMs: endMs - timeMs });
      lastChordStart = startDiv;
      if (!hasChord) cursorDiv += durDiv;
    }
  }
  return raw;
}

// --- App 側 (src/App.tsx) と同じ実時間正規化 ---
const LEAD_IN_MS = 1200;
const TAIL_MS = 500;

function normalizeEvents(events, audioMs) {
  if (!(audioMs > 0)) return null;
  let firstMs = Infinity, lastMs = -Infinity, timed = 0;
  for (const e of events) {
    if (!Number.isFinite(e.timeMs)) continue;
    timed += 1;
    if (e.timeMs < firstMs) firstMs = e.timeMs;
    const end = e.timeMs + (e.durationMs || 0);
    if (end > lastMs) lastMs = end;
  }
  const span = lastMs - firstMs;
  if (timed < 2 || !(span > 0)) return null;
  const targetSpan = Math.max(1000, audioMs - LEAD_IN_MS - TAIL_MS);
  const ratio = targetSpan / span;
  return events.map((e) => ({
    ...e,
    timeMs: LEAD_IN_MS + (e.timeMs - firstMs) * ratio,
    durationMs: (e.durationMs || 0) * ratio,
  }));
}

// App の simplifyEventsForRhythm と同じ和音圧縮 + 最小間隔の間引きを模擬し，
// 生き残るノーツ数を数える（非 strict 曲の譜面密度の proxy）．
function countPlayableNotes(events, bpm) {
  const beatMs = 60000 / Math.max(1, bpm);
  const grouped = new Map();
  for (const e of events) {
    const k = Math.round(e.timeMs / 22);
    const list = grouped.get(k) ?? [];
    list.push(e);
    grouped.set(k, list);
  }
  const selected = [...grouped.values()]
    .map((l) => l[0])
    .sort((a, b) => a.timeMs - b.timeMs);
  const minGap = Math.max(190, beatMs * 0.5);
  let kept = 0;
  let last = -Infinity;
  for (const e of selected) {
    if (e.timeMs - last < minGap) continue;
    kept += 1;
    last = e.timeMs;
  }
  return kept;
}

async function extractXmlFromMxl(mxlPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(mxlPath));
  const xmlFile = Object.keys(zip.files).find(f =>
    /\.musicxml$/i.test(f) || (/\.xml$/i.test(f) && !f.toLowerCase().includes('container'))
  );
  if (!xmlFile) throw new Error('No XML in MXL');
  return zip.files[xmlFile].async('string');
}

async function main() {
  const indexPath = process.argv[2] || './public/scores/index.json';
  const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const results = [];

  for (const s of idx) {
    const scorePath = s.mxlPath || s.xmlPath;
    if (!scorePath) continue;
    const fullPath = path.join('./public', scorePath);
    if (!fs.existsSync(fullPath)) { results.push({ id: s.id, err: 'file missing' }); continue; }

    try {
      const xmlText = fullPath.endsWith('.mxl')
        ? await extractXmlFromMxl(fullPath)
        : fs.readFileSync(fullPath, 'utf8');
      const meta = {};
      const events = parseMusicXml(xmlText, meta);
      if (!events.length) { results.push({ id: s.id, err: 'no events' }); continue; }

      const firstMs = Math.min(...events.map(e => e.timeMs));
      const lastMs = Math.max(...events.map(e => e.timeMs + (e.durationMs || 0)));
      const audioMs = s.lengthSec * 1000;
      // 生の譜面時間軸と音源長の比（1.0 から離れるほど記載テンポが実演奏と乖離）
      const ratio = lastMs > 0 ? audioMs / lastMs : 0;

      // 正規化後の実効比（App が実時間へ正規化した後の譜面末尾 vs 音源長）
      const normalized = normalizeEvents(events, audioMs);
      let fixedRatio = null;
      if (normalized) {
        const normLast = Math.max(...normalized.map(e => e.timeMs + (e.durationMs || 0)));
        fixedRatio = parseFloat(((audioMs - TAIL_MS) / normLast).toFixed(3));
      }

      // 非 strict 曲の密度 proxy: 間引き後に残るノーツ数（旧: 譜面時間軸で間引き / 新: 実時間で間引き）
      const bpm = s.bpm || 120;
      const keptOld = countPlayableNotes(events, bpm);
      const keptNew = normalized ? countPlayableNotes(normalized, bpm) : keptOld;

      results.push({
        id: s.id,
        audioSec: s.lengthSec,
        scoreSec: Math.round(lastMs / 1000),
        firstMs: Math.round(firstMs),
        notes: events.length,
        tempoMarks: meta.tempoMarks ?? 0,
        ratio: parseFloat(ratio.toFixed(3)),
        fixedRatio,
        keptNotesOld: keptOld,
        keptNotesNew: keptNew,
        strictMode: !!s.strictMode,
        currentOffset: s.offsetMs || 0,
      });
    } catch (e) {
      results.push({ id: s.id, err: e.message?.slice(0, 50) });
    }
  }

  console.log('Song'.padEnd(30), 'Audio'.padStart(6), 'Score'.padStart(6), '#Note'.padStart(6), 'Tmp'.padStart(4), 'Ratio'.padStart(7), 'Fixed'.padStart(6), 'KeptO'.padStart(6), 'KeptN'.padStart(6), 'Off'.padStart(6));
  console.log('-'.repeat(96));
  for (const r of results) {
    if (r.err) { console.log(r.id.padEnd(30), 'ERR:', r.err); continue; }
    console.log(
      r.id.padEnd(30),
      (r.audioSec + 's').padStart(6),
      (r.scoreSec + 's').padStart(6),
      String(r.notes).padStart(6),
      String(r.tempoMarks).padStart(4),
      String(r.ratio).padStart(7),
      String(r.fixedRatio ?? '-').padStart(6),
      String(r.keptNotesOld).padStart(6),
      String(r.keptNotesNew).padStart(6),
      String(r.currentOffset).padStart(6),
    );
  }

  // Output JSON for programmatic use
  fs.writeFileSync('./scripts/timing-analysis.json', JSON.stringify(results, null, 2));
  console.log('\nSaved to scripts/timing-analysis.json');
}

main().catch(console.error);
