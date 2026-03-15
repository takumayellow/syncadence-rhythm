import { useState, useEffect } from "react";
import type { RankingEntry } from "./ranking";
import { getRanking, clearAllRankings } from "./ranking";
import type { ScoreMeta } from "./types";

type Props = {
  scores: ScoreMeta[];
  onClose: () => void;
};

export function RankingScreen({ scores, onClose }: Props) {
  const [selectedSongId, setSelectedSongId] = useState<string>(
    scores[0]?.id ?? ""
  );
  const [entries, setEntries] = useState<RankingEntry[]>([]);

  useEffect(() => {
    if (selectedSongId) {
      setEntries(getRanking(selectedSongId));
    }
  }, [selectedSongId]);

  function handleClear() {
    if (!window.confirm("ランキングデータをすべて削除しますか？")) return;
    clearAllRankings();
    setEntries([]);
  }

  const selectedSong = scores.find((s) => s.id === selectedSongId);

  return (
    <div className="ranking-overlay" role="dialog" aria-modal="true" aria-label="ローカルランキング">
      <div className="ranking-card">
        <div className="ranking-header">
          <h2 className="ranking-title">ローカルランキング</h2>
          <button className="ranking-close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        {scores.length === 0 ? (
          <p className="ranking-empty">曲データがありません。</p>
        ) : (
          <>
            <div className="ranking-song-select">
              <label className="ranking-label" htmlFor="ranking-song">
                曲を選択
              </label>
              <select
                id="ranking-song"
                className="ranking-select"
                value={selectedSongId}
                onChange={(e) => setSelectedSongId(e.target.value)}
              >
                {scores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>

            {selectedSong && (
              <p className="ranking-song-info">
                {selectedSong.title} — {selectedSong.artist}
              </p>
            )}

            {entries.length === 0 ? (
              <p className="ranking-empty">この曲のプレイ履歴はまだありません。</p>
            ) : (
              <table className="ranking-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>スコア</th>
                    <th>精度</th>
                    <th>RANK</th>
                    <th>P/G/GO/M</th>
                    <th>日時</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, i) => (
                    <tr
                      key={`${entry.date}-${i}`}
                      className={i === 0 ? "ranking-row-best" : ""}
                    >
                      <td className="ranking-cell-rank">
                        {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}
                      </td>
                      <td className="ranking-cell-score">{entry.score.toLocaleString()}</td>
                      <td>{entry.accuracy.toFixed(1)}%</td>
                      <td className={`ranking-rank-badge rank-${entry.rank.replace("RANK ", "")}`}>
                        {entry.rank}
                      </td>
                      <td className="ranking-judges">
                        <span className="judge-p">{entry.perfectCount}</span>/
                        <span className="judge-g">{entry.greatCount}</span>/
                        <span className="judge-go">{entry.goodCount}</span>/
                        <span className="judge-m">{entry.missCount}</span>
                      </td>
                      <td className="ranking-date">
                        {new Date(entry.date).toLocaleDateString("ja-JP", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        <div className="ranking-footer">
          <button className="ranking-btn-clear" onClick={handleClear}>
            全データ削除
          </button>
          <button className="ranking-btn-close primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
