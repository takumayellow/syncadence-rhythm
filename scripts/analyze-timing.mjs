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

function parseMusicXml(xmlText) {
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

async function extractXmlFromMxl(mxlPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(mxlPath));
  const xmlFile = Object.keys(zip.files).find(f =>
    /\.musicxml$/i.test(f) || (/\.xml$/i.test(f) && !f.toLowerCase().includes('container'))
  );
  if (!xmlFile) throw new Error('No XML in MXL');
  return zip.files[xmlFile].async('string');
}

async function main() {
  const idx = JSON.parse(fs.readFileSync('./public/scores/index.json', 'utf8'));
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
      const events = parseMusicXml(xmlText);
      if (!events.length) { results.push({ id: s.id, err: 'no events' }); continue; }

      const firstMs = Math.min(...events.map(e => e.timeMs));
      const lastMs = Math.max(...events.map(e => e.timeMs + (e.durationMs || 0)));
      const audioMs = s.lengthSec * 1000;
      const ratio = lastMs > 0 ? audioMs / lastMs : 0;

      results.push({
        id: s.id,
        audioSec: s.lengthSec,
        scoreSec: Math.round(lastMs / 1000),
        firstMs: Math.round(firstMs),
        notes: events.length,
        ratio: parseFloat(ratio.toFixed(3)),
        currentOffset: s.offsetMs || 0,
      });
    } catch (e) {
      results.push({ id: s.id, err: e.message?.slice(0, 50) });
    }
  }

  console.log('Song'.padEnd(35), 'Audio'.padStart(6), 'Score'.padStart(6), '1stNote'.padStart(8), '#Note'.padStart(6), 'Ratio'.padStart(6), 'CurOff'.padStart(7));
  console.log('-'.repeat(80));
  for (const r of results) {
    if (r.err) { console.log(r.id.padEnd(35), 'ERR:', r.err); continue; }
    console.log(
      r.id.padEnd(35),
      (r.audioSec + 's').padStart(6),
      (r.scoreSec + 's').padStart(6),
      (r.firstMs + 'ms').padStart(8),
      String(r.notes).padStart(6),
      String(r.ratio).padStart(6),
      String(r.currentOffset).padStart(7),
    );
  }

  // Output JSON for programmatic use
  fs.writeFileSync('./scripts/timing-analysis.json', JSON.stringify(results, null, 2));
  console.log('\nSaved to scripts/timing-analysis.json');
}

main().catch(console.error);
