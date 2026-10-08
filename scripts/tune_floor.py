"""曲ごとに, 弱い山を捨てる下限 (build_charts.py の --floor) を決める.

下限を上げるほど誤検出は減るが, 本物の小さい音も落ちる. そこで,
生成側とは別設定の検出器 (eval_charts.reference) を基準にして
- 精度: 残した山のうち, 基準のオンセットから 50 ms 以内にあるものの割合
- 網羅: 基準のオンセットのうち, 残した山から 50 ms 以内にあるものの割合
を下限ごとに測り, 精度が MIN_PRECISION 以上になる最小の下限を採る.
その下限で網羅が MIN_RECALL に届かない曲は, 音の立ち上がりを信頼して取り出せないので
収録しない (exclude) と判定する.

使い方:
    python scripts/tune_floor.py <id>=<audio> [<id>=<audio> ...] --out scripts/chart_floors.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_charts  # noqa: E402
import eval_charts  # noqa: E402

FLOORS = tuple(round(x, 2) for x in np.arange(0.5, 3.01, 0.25))
MIN_PRECISION = 90.0
MIN_RECALL = 60.0
TOL_S = 0.05


def match_rate(times: np.ndarray, ref: np.ndarray) -> float:
    if len(times) == 0:
        return 0.0
    return float(np.mean(np.abs(eval_charts.nearest_signed(times, ref)) <= TOL_S)) * 100


def tune(audio: Path) -> dict:
    c = build_charts.candidates(audio)
    ref, _, _ = eval_charts.reference(audio)
    for floor in FLOORS:
        onsets = build_charts.frames_to_onsets(build_charts.strong_frames(c, floor))
        precision = match_rate(onsets, ref)
        if precision >= MIN_PRECISION:
            recall = match_rate(ref, onsets)
            return {
                "floor": floor,
                "precision": round(precision, 1),
                "recall": round(recall, 1),
                "include": recall >= MIN_RECALL,
            }
    return {"floor": None, "precision": round(precision, 1), "recall": None, "include": False}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("songs", nargs="+", help="<id>=<audio path>")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)

    result = json.loads(args.out.read_text(encoding="utf-8")) if args.out.exists() else {}
    for spec in args.songs:
        song_id, _, path = spec.partition("=")
        result[song_id] = tune(Path(path))
        print(song_id, result[song_id], flush=True)
    args.out.write_text(json.dumps(dict(sorted(result.items())), indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
