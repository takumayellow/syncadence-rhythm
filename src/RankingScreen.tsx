import { useState, useEffect } from "react";
import type { RankingEntry } from "./ranking";
import { getRanking, clearAllRankings } from "./ranking";
import type { ScoreMeta } from "./types";

const RANKING_API = "https://ranking-api-932581541278.asia-northeast1.run.app";

type GlobalEntry = {
  rank: number;
  nickname: string;
  score: number;
  accuracy: number;
  grade: string;
};

function getPlayerId(): string {
  let id = localStorage.getItem("pjsk_player_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("pjsk_player_id", id);
  }
  return id;
}

function getNickname(): string {
  return localStorage.getItem("pjsk_nickname") || "";
}

function setNicknameStorage(name: string) {
  localStorage.setItem("pjsk_nickname", name);
}

export async function submitScore(songId: string, score: number, accuracy: number, rank: string) {
  const nickname = getNickname();
  if (!nickname) return;
  const playerId = getPlayerId();
  try {
    await fetch(`${RANKING_API}/api/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId, playerId, nickname, score, accuracy, rank }),
    });
  } catch {
    // silent fail
  }
}

type Props = {
  scores: ScoreMeta[];
  onClose: () => void;
};

export function RankingScreen({ scores, onClose }: Props) {
  const [tab, setTab] = useState<"local" | "global">("local");
  const [selectedSongId, setSelectedSongId] = useState<string>(
    scores[0]?.id ?? ""
  );
  const [entries, setEntries] = useState<RankingEntry[]>([]);
  const [globalEntries, setGlobalEntries] = useState<GlobalEntry[]>([]);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [nickname, setNickname] = useState(getNickname());
  const [editingNickname, setEditingNickname] = useState(false);

  useEffect(() => {
    if (selectedSongId && tab === "local") {
      setEntries(getRanking(selectedSongId));
    }
    if (selectedSongId && tab === "global") {
      setGlobalLoading(true);
      fetch(`${RANKING_API}/api/rankings/${selectedSongId}`)
        .then((r) => r.json())
        .then((data) => setGlobalEntries(data.rankings || []))
        .catch(() => setGlobalEntries([]))
        .finally(() => setGlobalLoading(false));
    }
  }, [selectedSongId, tab]);

  function handleClear() {
    if (!window.confirm("ローカルランキングデータをすべて削除しますか？")) return;
    clearAllRankings();
    setEntries([]);
  }

  function handleSaveNickname() {
    const trimmed = nickname.trim().slice(0, 20);
    if (trimmed) {
      setNicknameStorage(trimmed);
      setNickname(trimmed);
    }
    setEditingNickname(false);
  }

  const selectedSong = scores.find((s) => s.id === selectedSongId);

  return (
    <div className="ranking-overlay" role="dialog" aria-modal="true" aria-label="ランキング">
      <div className="ranking-card">
        <div className="ranking-header">
          <h2 className="ranking-title">ランキング</h2>
          <button className="ranking-close" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>

        {/* ニックネーム設定 */}
        <div className="ranking-nickname" style={{ padding: "6px 0", fontSize: "0.85rem" }}>
          {editingNickname ? (
            <span>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={20}
                placeholder="ニックネーム（20文字以内）"
                style={{ width: "140px", fontSize: "0.85rem", padding: "2px 6px" }}
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveNickname(); }}
              />
              <button onClick={handleSaveNickname} style={{ marginLeft: "4px", fontSize: "0.8rem" }}>保存</button>
            </span>
          ) : (
            <span>
              プレイヤー: <strong>{nickname || "（未設定）"}</strong>
              <button onClick={() => setEditingNickname(true)} style={{ marginLeft: "6px", fontSize: "0.75rem" }}>変更</button>
            </span>
          )}
        </div>

        {/* タブ切替 */}
        <div className="ranking-tabs" style={{ display: "flex", gap: "4px", marginBottom: "8px" }}>
          <button
            className={`ranking-tab ${tab === "local" ? "active" : ""}`}
            onClick={() => setTab("local")}
            style={{
              flex: 1, padding: "6px", border: "1px solid #555", borderRadius: "6px",
              background: tab === "local" ? "#555" : "transparent", color: "#fff", cursor: "pointer",
            }}
          >個人</button>
          <button
            className={`ranking-tab ${tab === "global" ? "active" : ""}`}
            onClick={() => setTab("global")}
            style={{
              flex: 1, padding: "6px", border: "1px solid #555", borderRadius: "6px",
              background: tab === "global" ? "#555" : "transparent", color: "#fff", cursor: "pointer",
            }}
          >全体</button>
        </div>

        {scores.length === 0 ? (
          <p className="ranking-empty">曲データがありません。</p>
        ) : (
          <>
            <div className="ranking-song-select">
              <label className="ranking-label" htmlFor="ranking-song">曲を選択</label>
              <select
                id="ranking-song"
                className="ranking-select"
                value={selectedSongId}
                onChange={(e) => setSelectedSongId(e.target.value)}
              >
                {scores.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
            </div>

            {selectedSong && (
              <p className="ranking-song-info">{selectedSong.title} — {selectedSong.artist}</p>
            )}

            {/* ローカルランキング */}
            {tab === "local" && (
              entries.length === 0 ? (
                <p className="ranking-empty">この曲のプレイ履歴はまだありません。</p>
              ) : (
                <table className="ranking-table">
                  <thead>
                    <tr>
                      <th>#</th><th>スコア</th><th>精度</th><th>RANK</th><th>P/G/GO/M</th><th>日時</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, i) => (
                      <tr key={`${entry.date}-${i}`} className={i === 0 ? "ranking-row-best" : ""}>
                        <td className="ranking-cell-rank">
                          {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}
                        </td>
                        <td className="ranking-cell-score">{entry.score.toLocaleString()}</td>
                        <td>{entry.accuracy.toFixed(1)}%</td>
                        <td className={`ranking-rank-badge rank-${entry.rank.replace("RANK ", "")}`}>{entry.rank}</td>
                        <td className="ranking-judges">
                          <span className="judge-p">{entry.perfectCount}</span>/
                          <span className="judge-g">{entry.greatCount}</span>/
                          <span className="judge-go">{entry.goodCount}</span>/
                          <span className="judge-m">{entry.missCount}</span>
                        </td>
                        <td className="ranking-date">
                          {new Date(entry.date).toLocaleDateString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {/* 全体ランキング */}
            {tab === "global" && (
              globalLoading ? (
                <p className="ranking-empty">読み込み中...</p>
              ) : !nickname ? (
                <p className="ranking-empty">ニックネームを設定すると全体ランキングに参加できます。</p>
              ) : globalEntries.length === 0 ? (
                <p className="ranking-empty">まだスコアが登録されていません。プレイして記録を残そう！</p>
              ) : (
                <table className="ranking-table">
                  <thead>
                    <tr>
                      <th>#</th><th>プレイヤー</th><th>スコア</th><th>精度</th><th>RANK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {globalEntries.map((entry) => (
                      <tr key={`${entry.rank}-${entry.nickname}`}
                        className={entry.nickname === nickname ? "ranking-row-best" : ""}>
                        <td className="ranking-cell-rank">
                          {entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : entry.rank}
                        </td>
                        <td>{entry.nickname}</td>
                        <td className="ranking-cell-score">{entry.score.toLocaleString()}</td>
                        <td>{entry.accuracy}%</td>
                        <td>{entry.grade}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}
          </>
        )}

        <div className="ranking-footer">
          {tab === "local" && (
            <button className="ranking-btn-clear" onClick={handleClear}>全データ削除</button>
          )}
          <button className="ranking-btn-close primary" onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}
