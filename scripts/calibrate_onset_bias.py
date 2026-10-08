"""オンセット検出器の遅れを, 打鍵時刻が既知の合成音で測る.

ピアノに近い音 (立ち上がり 3 ms・指数減衰・倍音つき) を不規則な間隔で 400 回鳴らし,
生成側 (build_charts.py) と評価側 (eval_charts.py) の検出結果を真の時刻と比べる.
build_charts.ONSET_LATENCY_S と eval_charts.REF_LATENCY_S はこの結果から決めている.
補正後の値を表示するので, 補正済みなら bias は 0 付近になる.

使い方:
    python scripts/calibrate_onset_bias.py <作業用の wav パス>
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_charts  # noqa: E402
import eval_charts  # noqa: E402


def synth(path: Path) -> np.ndarray:
    rng = np.random.default_rng(1)
    sr = 44100
    times = np.cumsum(rng.uniform(0.09, 0.6, 400)) + 1.0
    y = np.zeros(int((times[-1] + 2) * sr))
    tt = np.arange(int(1.5 * sr)) / sr
    env = np.minimum(tt / 0.003, 1) * np.exp(-tt * 3)
    for t in times:
        f0 = 440 * 2 ** (rng.integers(-24, 20) / 12)
        tone = sum(np.sin(2 * np.pi * f0 * k * tt) / k**1.3 for k in range(1, 8)) * env
        i = int(t * sr)
        seg = y[i : i + len(tt)]
        seg += tone[: len(seg)] * rng.uniform(0.05, 0.5)
    y += rng.normal(0, 0.002, len(y))
    sf.write(str(path), y / np.max(np.abs(y)) * 0.9, sr)
    return times


def report(name: str, detected: np.ndarray, truth: np.ndarray) -> None:
    d = eval_charts.nearest_signed(detected, truth) * 1000
    m = np.abs(d) < 50
    if not m.any():
        print(f"{name}: detected={len(detected)} truth={len(truth)} matched=0")
        return
    print(
        f"{name}: detected={len(detected)} truth={len(truth)} matched={int(m.sum())} "
        f"bias={np.median(d[m]):+.1f}ms p95={np.percentile(np.abs(d[m]), 95):.1f}ms"
    )


def main() -> int:
    path = Path(sys.argv[1])
    truth = synth(path)
    report("build_charts", build_charts.analyze(path, floor=0.0).onsets, truth)
    report("eval_charts", eval_charts.reference(path)[0], truth)
    return 0


if __name__ == "__main__":
    sys.exit(main())
