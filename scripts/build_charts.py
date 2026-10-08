"""音源から難易度別の譜面 (chart.json) を生成する.

方針: ノーツは音源から検出した音の立ち上がり (オンセット) の上にだけ置く.
楽譜の時間軸を音源へ写像する方式 (DTW・一様伸縮) は, 演奏のテンポ揺れや
リピートの扱いの違いで曲中にずれが積もるため使わない.

使い方:
    python scripts/build_charts.py public/scores/songs/<id>/audio.ogg \
        public/scores/songs/<id>/chart.json

必要なもの: librosa (0.10 以降), numpy
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np

SR = 44100
HOP = 256  # 5.8 ms
LANES = 4
# 検出器はスペクトル差分の山を返すので, 打鍵の瞬間より遅れて出る.
# 打鍵時刻が既知の合成音 (scripts/calibrate_onset_bias.py) で測った遅れを差し引く.
ONSET_LATENCY_S = 0.017


@dataclass(frozen=True)
class Difficulty:
    name: str
    level_nps: float  # 1 秒あたりのノーツ数の上限 (プロセカの同程度の難易度を目安)
    onset_ratio: float  # 曲のオンセット密度に対する採用率の上限
    min_gap: float  # 連続するノーツの最小間隔 (秒)
    chord_ratio: float  # 同時押しにする割合の上限
    hold_min_gap: float  # ロングにできる次ノーツまでの最小間隔 (秒)
    hold_ratio: float  # ロングの割合の上限


DIFFICULTIES = (
    Difficulty("easy", 1.7, 0.40, 0.42, 0.0, 1.0, 0.12),
    Difficulty("normal", 2.8, 0.60, 0.26, 0.03, 0.85, 0.12),
    Difficulty("hard", 4.3, 0.80, 0.16, 0.06, 0.75, 0.10),
    Difficulty("expert", 6.2, 1.00, 0.105, 0.08, 0.65, 0.08),
)


@dataclass(frozen=True)
class Analysis:
    duration: float
    onsets: np.ndarray  # 秒
    salience: np.ndarray  # 局所正規化した強さ + 拍への近さ
    strength: np.ndarray  # 局所正規化した強さ
    pitch: np.ndarray  # オンセットで新しく鳴った音の高さ (CQT bin)
    beats: np.ndarray  # 秒
    tempo: float
    rms_t: np.ndarray
    rms: np.ndarray


def local_percentile(x: np.ndarray, win: int, q: float) -> np.ndarray:
    """win フレーム窓の q パーセンタイル (間引いて計算し補間する)."""
    step = max(1, win // 8)
    centers = np.arange(0, len(x), step)
    vals = np.array(
        [np.percentile(x[max(0, c - win // 2) : c + win // 2 + 1], q) for c in centers]
    )
    return np.interp(np.arange(len(x)), centers, vals)


@dataclass(frozen=True)
class Candidates:
    y: np.ndarray
    env: np.ndarray  # オンセット包絡 (正規化前)
    env_n: np.ndarray  # 局所正規化した包絡
    frames: np.ndarray  # 候補の山のフレーム (無音区間を除いたもの)
    level: float  # 有音区間の包絡の 90 パーセンタイル
    rms: np.ndarray


def candidates(path: Path) -> Candidates:
    y, sr = librosa.load(str(path), sr=SR, mono=True)

    # SuperFlux 型のオンセット包絡 (log-mel のスペクトル差分 + 周波数方向の最大値フィルタ).
    mel = librosa.feature.melspectrogram(
        y=y, sr=sr, n_fft=2048, hop_length=HOP, n_mels=138, fmin=27.5, fmax=16000
    )
    log_mel = librosa.power_to_db(mel, ref=np.max)
    env = librosa.onset.onset_strength(
        S=log_mel, sr=sr, hop_length=HOP, lag=2, max_size=3
    )

    # 小さい音の区間でもオンセットを拾えるよう, 包絡を局所 (約 3 秒) の上位値で割る.
    win = int(3.0 * sr / HOP)
    norm = local_percentile(env, win, 95) + 1e-6
    env_n = env / norm

    frames = librosa.onset.onset_detect(
        onset_envelope=env_n,
        sr=sr,
        hop_length=HOP,
        backtrack=False,
        pre_max=3,
        post_max=3,
        pre_avg=12,
        post_avg=6,
        delta=0.25,
        wait=int(0.06 * sr / HOP),
        normalize=False,
    )

    # 無音・残響だけの区間の検出を捨てる.
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    rms_db = librosa.amplitude_to_db(rms, ref=np.max)
    frames = frames[rms_db[np.minimum(frames + 2, len(rms_db) - 1)] > -45]
    voiced = rms_db[: len(env)] > -45
    level = float(np.percentile(env[: len(voiced)][voiced], 90)) if voiced.any() else 0.0
    return Candidates(y=y, env=env, env_n=env_n, frames=frames, level=level, rms=rms)


def frames_to_onsets(frames: np.ndarray) -> np.ndarray:
    return np.maximum(0.0, librosa.frames_to_time(frames, sr=SR, hop_length=HOP) - ONSET_LATENCY_S)


def strong_frames(c: Candidates, floor: float) -> np.ndarray:
    """局所正規化だけだと, 静かな区間のペダルノイズや残響の揺れまで強い山に見える.
    曲全体の包絡の水準 (level) の floor 倍を下回る山を捨てる."""
    return c.frames[c.env[c.frames] >= floor * c.level]


def analyze(path: Path, floor: float) -> Analysis:
    c = candidates(path)
    y, sr, env, env_n, rms = c.y, SR, c.env, c.env_n, c.rms
    duration = len(y) / sr
    frames = strong_frames(c, floor)

    onsets = frames_to_onsets(frames)
    strength = np.clip(env_n[frames], 0, 3)

    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=env, sr=sr, hop_length=HOP, trim=False, units="frames"
    )
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)

    salience = strength.copy()
    if len(beats) > 1:
        ibi = float(np.median(np.diff(beats)))
        for i, t in enumerate(onsets):
            d = np.min(np.abs(beats - t))
            if d < 0.04:
                salience[i] += 0.35
            else:
                half = np.min(np.abs((beats[:-1] + beats[1:]) / 2 - t)) if len(beats) > 1 else 1.0
                if half < 0.04 and ibi > 0.3:
                    salience[i] += 0.15

    # オンセットで新しく鳴った音の高さ: CQT の正の差分が最大の bin.
    cqt = np.abs(
        librosa.cqt(y=y, sr=sr, hop_length=HOP, fmin=librosa.note_to_hz("A0"), n_bins=88)
    )
    cqt_db = librosa.amplitude_to_db(cqt, ref=np.max)
    pitch = np.empty(len(frames))
    for i, f in enumerate(frames):
        a = cqt_db[:, min(f + 2, cqt_db.shape[1] - 1)]
        b = cqt_db[:, max(f - 2, 0)]
        pitch[i] = float(np.argmax(np.maximum(a - b, 0) + 1e-3 * a))

    rms_t = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=HOP)
    return Analysis(
        duration=duration,
        onsets=onsets,
        salience=salience,
        strength=strength,
        pitch=pitch,
        beats=beats,
        tempo=float(np.atleast_1d(tempo)[0]),
        rms_t=rms_t,
        rms=rms,
    )


def select_onsets(a: Analysis, d: Difficulty) -> np.ndarray:
    """強い順に, 最小間隔を守りながら目標数まで採用する. 戻り値はオンセットの添字 (時刻順)."""
    if len(a.onsets) == 0:
        return np.array([], dtype=int)
    span = max(1.0, a.onsets[-1] - a.onsets[0])
    onset_rate = len(a.onsets) / span
    target_nps = min(d.level_nps, onset_rate * d.onset_ratio)
    target = int(round(target_nps * span))
    taken: list[float] = []
    chosen: list[int] = []
    for i in np.argsort(-a.salience, kind="stable"):
        t = a.onsets[i]
        pos = np.searchsorted(taken, t)
        if pos > 0 and t - taken[pos - 1] < d.min_gap:
            continue
        if pos < len(taken) and taken[pos] - t < d.min_gap:
            continue
        taken.insert(pos, t)
        chosen.append(int(i))
        if len(chosen) >= target:
            break
    return np.array(sorted(chosen), dtype=int)


def sustain_ok(a: Analysis, t0: float, t1: float) -> bool:
    """t0 で鳴った音が t1 付近まで鳴り続けているか (RMS が大きく落ちていないか)."""
    i0 = np.searchsorted(a.rms_t, t0 + 0.05)
    i1 = np.searchsorted(a.rms_t, t1)
    if i1 <= i0:
        return False
    head = float(np.max(a.rms[i0 : min(i0 + 8, len(a.rms))]))
    tail = float(np.mean(a.rms[max(i0, i1 - 20) : i1]))
    return head > 0 and tail >= 0.3 * head


def assign_lanes(pitch: np.ndarray, times: np.ndarray, d: Difficulty) -> list[int]:
    """音の高さを近傍 (前後 4 秒) の中での順位に直してレーンを決める. 速い同レーン連打は避ける."""
    lanes: list[int] = []
    for i, (p, t) in enumerate(zip(pitch, times)):
        lo, hi = np.searchsorted(times, [t - 4.0, t + 4.0])
        window = pitch[lo:hi]
        rank = (np.sum(window < p) + 0.5 * np.sum(window == p)) / max(1, len(window))
        lane = int(min(LANES - 1, rank * LANES))
        if lanes:
            prev = lanes[-1]
            gap = t - times[i - 1]
            if lane == prev and gap < max(0.3, 2.2 * d.min_gap):
                # 音高が上がったら右, 下がったら左へずらす.
                direction = 1 if p >= pitch[i - 1] else -1
                cand = lane + direction
                lane = cand if 0 <= cand < LANES else lane - direction
            elif abs(lane - prev) == 3 and gap < 0.2:
                lane = prev + (1 if lane > prev else -1) * 2
        lanes.append(lane)
    return lanes


def build_difficulty(a: Analysis, d: Difficulty) -> list[list[float]]:
    idx = select_onsets(a, d)
    times = a.onsets[idx]
    pitch = a.pitch[idx]
    strength = a.strength[idx]
    lanes = assign_lanes(pitch, times, d)

    holds = [0.0] * len(times)
    max_holds = int(d.hold_ratio * len(times))
    hold_count = 0
    for i in range(len(times) - 1):
        gap = times[i + 1] - times[i]
        if hold_count >= max_holds or gap < d.hold_min_gap:
            continue
        end = times[i] + min(gap - 0.2, 3.0)
        if sustain_ok(a, times[i], end):
            holds[i] = end - times[i]
            hold_count += 1

    notes: list[list[float]] = []
    chord_budget = int(d.chord_ratio * len(times))
    chord_cut = np.quantile(strength, 1 - 2 * d.chord_ratio) if d.chord_ratio > 0 and len(strength) else np.inf
    for i, t in enumerate(times):
        notes.append([round(float(t) * 1000), lanes[i], round(holds[i] * 1000)])
        if chord_budget > 0 and strength[i] >= chord_cut and holds[i] == 0:
            gap_prev = t - times[i - 1] if i > 0 else np.inf
            gap_next = times[i + 1] - t if i + 1 < len(times) else np.inf
            if min(gap_prev, gap_next) >= max(0.25, 2 * d.min_gap):
                partner = (lanes[i] + 2) % LANES
                notes.append([round(float(t) * 1000), partner, 0])
                chord_budget -= 1

    return drop_lane_conflicts(notes)


def drop_lane_conflicts(notes: list[list[float]]) -> list[list[float]]:
    """ロングの押下中に同じレーンへ来るノーツは別レーンへ逃がす (逃がせなければ捨てる)."""
    notes = sorted(notes, key=lambda n: (n[0], n[1]))
    busy_until = [-1.0] * LANES
    out: list[list[float]] = []
    taken_at: dict[float, set[int]] = {}
    for t, lane, dur in notes:
        used = taken_at.setdefault(t, set())
        if busy_until[lane] >= t - 60 or lane in used:
            free = [l for l in range(LANES) if busy_until[l] < t - 60 and l not in used]
            if not free:
                continue
            lane = min(free, key=lambda l: abs(l - lane))
        used.add(lane)
        busy_until[lane] = t + dur
        out.append([t, lane, dur])
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("audio", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument(
        "--floor",
        type=float,
        required=True,
        help="曲全体の包絡の水準に対する山の下限 (scripts/tune_floor.py で決める)",
    )
    args = ap.parse_args(argv)

    a = analyze(args.audio, args.floor)
    chart = {
        "version": 1,
        "generator": "scripts/build_charts.py (onset-aligned)",
        "audioSha1": hashlib.sha1(args.audio.read_bytes()).hexdigest(),
        "durationMs": round(a.duration * 1000),
        "tempo": round(a.tempo, 1),
        "difficulties": {d.name: build_difficulty(a, d) for d in DIFFICULTIES},
    }
    args.out.write_text(json.dumps(chart, separators=(",", ":")), encoding="utf-8")
    counts = {k: len(v) for k, v in chart["difficulties"].items()}
    print(f"{args.out}: onsets={len(a.onsets)} tempo={a.tempo:.1f} {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
