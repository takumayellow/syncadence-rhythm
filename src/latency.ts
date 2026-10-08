// 端末の音の遅れ (スピーカー/イヤホンの出力遅延 + タッチ入力の遅れ) を測る．
// 譜面は音源の再生位置そのものに合わせてあるので，残るずれは端末側の遅れだけになる．
// 曲と同じ <audio> の経路でクリック音を鳴らし，音に合わせたタップとの差から補正値を出す．

export const CLICK_INTERVAL_MS = 600;
export const LEAD_IN_CLICKS = 4;
export const MEASURED_CLICKS = 16;
const FIRST_CLICK_MS = 1000;
const TAIL_MS = 800;
const MIN_TAPS = 8;
// ばらつき (中央値からの絶対偏差の中央値) がこれを超えたら測り直しを勧める．
export const MAX_RELIABLE_SPREAD_MS = 35;
export const OFFSET_LIMIT_MS = 300;

export function clickTimesMs(): number[] {
  return Array.from({ length: LEAD_IN_CLICKS + MEASURED_CLICKS }, (_, k) => FIRST_CLICK_MS + k * CLICK_INTERVAL_MS);
}

// 立ち上がりの鋭いクリック音を並べた 16bit モノラル WAV を作る．
export function buildClickTrackWav(sampleRate = 44100): Blob {
  const clicks = clickTimesMs();
  const totalMs = clicks[clicks.length - 1] + TAIL_MS;
  const n = Math.ceil((totalMs / 1000) * sampleRate);
  const pcm = new Int16Array(n);
  const clickLen = Math.round(0.04 * sampleRate);
  clicks.forEach((ms, k) => {
    const start = Math.round((ms / 1000) * sampleRate);
    // 予備拍は高い音にして，測定の始まりを耳で分かるようにする．
    const freq = k < LEAD_IN_CLICKS ? 2000 : 1400;
    for (let i = 0; i < clickLen && start + i < n; i += 1) {
      const t = i / sampleRate;
      pcm[start + i] = Math.round(Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / 0.008) * 0.8 * 32767);
    }
  });
  const header = new DataView(new ArrayBuffer(44));
  const writeStr = (off: number, s: string) => [...s].forEach((c, i) => header.setUint8(off + i, c.charCodeAt(0)));
  writeStr(0, "RIFF");
  header.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  writeStr(36, "data");
  header.setUint32(40, pcm.byteLength, true);
  return new Blob([header.buffer, pcm.buffer], { type: "audio/wav" });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type LatencyEstimate = {
  // getSongTimeMs に足す補正値 (タップが音より遅れて記録されるなら負)．
  offsetMs: number;
  spreadMs: number;
  usedTaps: number;
  reliable: boolean;
};

// tapsMs は再生位置 (ms)．予備拍を除いたクリックに最も近いタップだけを使う．
export function estimateLatency(tapsMs: number[], clicksMs: number[] = clickTimesMs()): LatencyEstimate | null {
  const measured = clicksMs.slice(LEAD_IN_CLICKS);
  const window = CLICK_INTERVAL_MS * 0.4;
  const firstMeasured = measured[0] - window;
  const deltas: number[] = [];
  for (const t of tapsMs) {
    if (t < firstMeasured) continue;
    const nearest = measured.reduce((best, c) => (Math.abs(c - t) < Math.abs(best - t) ? c : best), measured[0]);
    const d = t - nearest;
    if (Math.abs(d) <= window) deltas.push(d);
  }
  if (deltas.length < MIN_TAPS) return null;
  const lag = median(deltas);
  const spreadMs = median(deltas.map((d) => Math.abs(d - lag)));
  const offsetMs = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, Math.round(-lag)));
  return { offsetMs, spreadMs: Math.round(spreadMs), usedTaps: deltas.length, reliable: spreadMs <= MAX_RELIABLE_SPREAD_MS };
}

// audio.currentTime は更新が粗いので，変化点の間を performance.now() で補間する (ゲーム本体と同じ方式)．
export class AudioClock {
  private syncMs = 0;
  private syncPerf = 0;
  private lastRaw = -1;

  constructor(private readonly audio: HTMLAudioElement) {}

  nowMs(): number {
    const raw = this.audio.currentTime * 1000;
    const now = performance.now();
    if (Math.abs(raw - this.lastRaw) > 0.5) {
      this.syncMs = raw;
      this.syncPerf = now;
      this.lastRaw = raw;
    }
    return this.syncMs + (now - this.syncPerf);
  }
}
