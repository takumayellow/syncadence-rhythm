// タイミング調整画面．クリック音に合わせたタップから端末の音の遅れを測り，補正値を返す．
import { useEffect, useRef, useState } from "react";
import {
  AudioClock,
  buildClickTrackWav,
  estimateLatency,
  LEAD_IN_CLICKS,
  MEASURED_CLICKS,
  type LatencyEstimate,
} from "./latency";

type Props = {
  currentOffsetMs: number;
  onApply: (offsetMs: number) => void;
  onClose: () => void;
};

type Phase = "idle" | "running" | "done";

const TAP_KEYS = ["Space", "KeyD", "KeyF", "KeyJ", "KeyK"];

export default function LatencyCalibration({ currentOffsetMs, onApply, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [tapCount, setTapCount] = useState(0);
  const [result, setResult] = useState<LatencyEstimate | null>(null);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clockRef = useRef<AudioClock | null>(null);
  const tapsRef = useRef<number[]>([]);
  const rafRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    const url = URL.createObjectURL(buildClickTrackWav());
    const audio = new Audio(url);
    audio.preload = "auto";
    audioRef.current = audio;
    clockRef.current = new AudioClock(audio);
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      audio.pause();
      audio.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, []);

  function finish(): void {
    cancelAnimationFrame(rafRef.current);
    setResult(estimateLatency(tapsRef.current));
    setPhase("done");
  }

  async function start(): Promise<void> {
    const audio = audioRef.current;
    if (!audio) return;
    tapsRef.current = [];
    setTapCount(0);
    setResult(null);
    setError("");
    audio.currentTime = 0;
    audio.onended = finish;
    try {
      await audio.play();
    } catch {
      if (mountedRef.current) setError("音を再生できませんでした．もう一度押してください．");
      return;
    }
    // 再生開始を待つ間に閉じられていたら，ここで止める．
    if (!mountedRef.current) {
      audio.pause();
      return;
    }
    setPhase("running");
    // ゲーム本体と同じく毎フレーム時計を進め，補間の基準点を最新に保つ．
    const tick = () => {
      clockRef.current?.nowMs();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function tap(): void {
    const audio = audioRef.current;
    const clock = clockRef.current;
    if (phase !== "running" || !audio || !clock || audio.paused) return;
    tapsRef.current.push(clock.nowMs());
    setTapCount(tapsRef.current.length);
  }

  // キーボードでも測れるようにする．開いている間はキーをゲーム本体へ渡さない
  // (補正値やレーンのショートカットが測定中に動かないように)．
  // tap() が最新の phase を見るよう，依存配列なしで描画ごとに付け直す．
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.code === "Escape") {
        onClose();
        return;
      }
      if (!TAP_KEYS.includes(e.code)) return;
      e.preventDefault();
      if (!e.repeat) tap();
    };
    const onKeyUp = (e: KeyboardEvent) => e.stopPropagation();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  });

  return (
    <div className="latency-panel" role="dialog" aria-label="タイミング調整">
      <div className="latency-card">
        <h2>タイミング調整</h2>
        <p className="latency-help">
          画面は見ずに，聞こえたクリック音に合わせて下の枠をタップしてください（キーボードなら Space）．
          最初の高い音 {LEAD_IN_CLICKS} 回は準備で，その後の {MEASURED_CLICKS} 回で測ります．
          実際にプレイするときと同じイヤホン・スピーカーで測ってください．
        </p>
        <button
          className={`latency-pad${phase === "running" ? " active" : ""}`}
          onPointerDown={(e) => {
            // 測定中だけ既定動作を止める (開始はタッチでも click で確実に受ける)．
            if (phase !== "running") return;
            e.preventDefault();
            tap();
          }}
          onClick={() => {
            if (phase !== "running") void start();
          }}
        >
          {phase === "running" ? `タップ ${tapCount}` : phase === "done" ? "もう一度測る" : "スタート"}
        </button>
        {error && <p className="latency-error">{error}</p>}
        {phase === "done" && !result && <p className="latency-error">タップが足りませんでした．もう一度測ってください．</p>}
        {phase === "done" && result && (
          <div className="latency-result">
            <p>
              補正値 <strong>{result.offsetMs > 0 ? "+" : ""}{result.offsetMs} ms</strong>（現在 {Math.round(currentOffsetMs)} ms）
              <br />
              ばらつき ±{result.spreadMs} ms / 有効タップ {result.usedTaps}
            </p>
            {!result.reliable && <p className="latency-error">ばらつきが大きいので，もう一度測ると正確になります．</p>}
          </div>
        )}
        <div className="latency-actions">
          {phase === "done" && result && (
            <button className="primary" onClick={() => onApply(result.offsetMs)}>この値を使う</button>
          )}
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
