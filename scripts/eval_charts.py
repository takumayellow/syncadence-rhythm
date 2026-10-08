"""譜面と音源のずれを計測する.

基準は生成側 (build_charts.py) とは別設定の検出器にする:
- オンセット: librosa.onset.onset_detect の既定設定 (sr=22050, hop=512, STFT のスペクトル差分)
- 拍: librosa.beat.beat_track の既定設定. 拍とその中点 (8 分のグリッド) への距離を測る.
どちらも打鍵の瞬間より遅れて出るので, 打鍵時刻が既知の合成音
(scripts/calibrate_onset_bias.py) で測った遅れ REF_LATENCY_S を差し引く.

各ノーツについて最寄りの基準点までの距離 (ms) を取り, 中央値と 95 パーセンタイルを出す.
曲中でずれていかないかを見るため, 曲の前 1/3 と後 1/3 の符号付き中央値も出す.

使い方:
    python scripts/eval_charts.py <audio> <chart.json> [--format chart|times]
    (--format times は {"notes": [[hitMs, ...], ...]} 形式)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import librosa
import numpy as np

REF_LATENCY_S = 0.023


def reference(path: Path) -> tuple[np.ndarray, np.ndarray, float]:
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time") - REF_LATENCY_S
    _, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    beats = beats - REF_LATENCY_S
    grid = np.sort(np.concatenate([beats, (beats[:-1] + beats[1:]) / 2])) if len(beats) > 1 else beats
    return onsets, grid, len(y) / sr


def nearest_signed(times: np.ndarray, ref: np.ndarray) -> np.ndarray:
    if len(ref) == 0 or len(times) == 0:
        return np.full(len(times), np.nan)
    pos = np.clip(np.searchsorted(ref, times), 1, len(ref) - 1)
    left, right = ref[pos - 1], ref[pos]
    return np.where(times - left < right - times, times - left, times - right)


def metrics(note_ms: list[float], onsets: np.ndarray, grid: np.ndarray, duration: float) -> dict:
    t = np.unique(np.asarray(note_ms, dtype=float) / 1000.0)  # 同時押しは 1 回として数える
    t = t[(t >= 0) & (t <= duration)]
    do = nearest_signed(t, onsets) * 1000
    dg = nearest_signed(t, grid) * 1000
    n = len(t)
    if n == 0:
        return {"notes": len(note_ms), "nps": 0.0}
    third = n // 3
    return {
        "notes": len(note_ms),
        "nps": round(len(note_ms) / duration, 2),
        "onset_med": round(float(np.median(np.abs(do))), 1),
        "onset_p95": round(float(np.percentile(np.abs(do), 95)), 1),
        "within50": round(float(np.mean(np.abs(do) <= 50)) * 100, 1),
        "beat_med": round(float(np.median(np.abs(dg))), 1),
        "beat_p95": round(float(np.percentile(np.abs(dg), 95)), 1),
        "drift_first": round(float(np.median(do[:third])), 1) if third else None,
        "drift_last": round(float(np.median(do[-third:])), 1) if third else None,
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", type=Path)
    ap.add_argument("chart", type=Path)
    ap.add_argument("--format", choices=("chart", "times"), default="chart")
    args = ap.parse_args(argv)

    onsets, grid, duration = reference(args.audio)
    data = json.loads(args.chart.read_text(encoding="utf-8"))
    if args.format == "times":
        charts = {"current": [n[0] for n in data["notes"]]}
    else:
        charts = {k: [n[0] for n in v] for k, v in data["difficulties"].items()}
    out = {k: metrics(v, onsets, grid, duration) for k, v in charts.items()}
    out["_ref"] = {"onsets": len(onsets), "onset_rate": round(len(onsets) / duration, 2)}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
