// Local ranking storage module
// Saves and retrieves play results per song using localStorage.

const RANKING_KEY = "syncadence_ranking_v1";

export type RankingEntry = {
  songId: string;
  songTitle: string;
  score: number;
  accuracy: number;
  rank: string;
  perfectCount: number;
  greatCount: number;
  goodCount: number;
  missCount: number;
  date: string; // ISO 8601
};

type RankingStore = {
  [songId: string]: RankingEntry[];
};

function loadStore(): RankingStore {
  try {
    return JSON.parse(localStorage.getItem(RANKING_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveStore(store: RankingStore): void {
  localStorage.setItem(RANKING_KEY, JSON.stringify(store));
}

/** Save a new result.  Returns true if it is a new personal best for this song. */
export function saveResult(entry: RankingEntry): boolean {
  const store = loadStore();
  const list: RankingEntry[] = store[entry.songId] ?? [];

  const prevBest = list.reduce<number | null>(
    (best, e) => (best === null || e.score > best ? e.score : best),
    null
  );
  const isNewBest = prevBest === null || entry.score > prevBest;

  // Keep top 10 per song.
  const updated = [...list, entry]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  store[entry.songId] = updated;
  saveStore(store);
  return isNewBest;
}

/** Get top-10 entries for a specific song, sorted by score descending. */
export function getRanking(songId: string): RankingEntry[] {
  const store = loadStore();
  return store[songId] ?? [];
}

/** Get all song IDs that have ranking data. */
export function getRankedSongIds(): string[] {
  return Object.keys(loadStore());
}

/** Clear all ranking data. */
export function clearAllRankings(): void {
  localStorage.removeItem(RANKING_KEY);
}
