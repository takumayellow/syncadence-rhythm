# SynCadence Rhythm — プロセカ風リズムゲーム

> React + TypeScript + Vite で動くブラウザ完結型リズムゲーム。
> MusicXML / MIDI ファイルを読み込んで、プロジェクトセカイ風の斜め4レーンでプレイできます。

---

## デモ

> **ライブデモ**: GitHub Pages にデプロイ済みです。
> `https://takumayellow.github.io/syncadence-rhythm/`

---

## 主な機能

| 機能 | 説明 |
|------|------|
| 斜め4レーン | D / F / J / K キーに対応した斜めレーン配置 |
| ロングノーツ | 入り判定と終端判定を独立して処理 |
| MusicXML 読込 | `.musicxml` / `.xml` / `.mxl` に対応 |
| MIDI 同期 | `.mid` ファイルでタイミングを精密に同期 |
| 自動キャリブレーション | プレイ中の打鍵統計からオフセットを自動補正 |
| TAP TEMPO | 四分打ちからBPMとオフセットを推定 |
| 曲別設定の保存 | 速度・タイミング・BPM・判定ラインを曲ごとに保存 |
| 判定システム | PERFECT / GREAT / GOOD / MISS の4段階 |
| スコア計算 | PERFECT=1000 / GREAT=700 / GOOD=400 / MISS=0 |
| 複数楽譜対応 | `public/scores/index.json` で曲一覧を管理 |

---

## セットアップ手順

### 必要環境

- Node.js v20 以上
- npm v9 以上

### インストールと起動

```bash
# 1. リポジトリをクローン
git clone https://github.com/takumayellow/syncadence-rhythm.git
cd syncadence-rhythm

# 2. 依存パッケージをインストール
npm install

# 3. 開発サーバーを起動
npm run dev
```

ブラウザで `http://localhost:5173` を開いてください。

### ビルド（本番用）

```bash
npm run build
# dist/ ディレクトリに成果物が生成されます

# ビルド結果をローカルでプレビュー
npm run preview
```

---

## 楽譜の追加方法

### ディレクトリ構成

```
public/
  scores/
    index.json          # 曲一覧（ここに追加）
    songs/
      my-song/
        score.mxl       # 圧縮MusicXML
        score.musicxml  # 非圧縮MusicXML（どちらか）
        timing.mid      # MIDIタイミング（任意）
        audio.mp3       # 音源ファイル
```

### index.json への追加例

```json
{
  "id": "my-song",
  "title": "My Song Title",
  "artist": "Artist Name",
  "mxlPath": "/scores/songs/my-song/score.mxl",
  "midiPath": "/scores/songs/my-song/timing.mid",
  "audioUrl": "/scores/songs/my-song/audio.mp3",
  "bpm": 120,
  "offsetMs": 0,
  "strictMode": false
}
```

### index.json の主なキー

| キー | 型 | 説明 |
|------|-----|------|
| `id` | string | 曲の一意識別子 |
| `title` | string | 曲名 |
| `artist` | string | アーティスト名 |
| `xmlPath` | string | 非圧縮MusicXMLのパス |
| `mxlPath` | string | 圧縮MusicXML（MXL）のパス |
| `midiPath` | string | MIDIタイミング取得用パス |
| `audioUrl` | string | 音源URL（MIDIを指定した場合はブラウザ再生不可時に簡易シンセで再生） |
| `bpm` | number | 基準BPM |
| `offsetMs` | number | 音源オフセット（ミリ秒） |
| `strictMode` | boolean | 厳密モード（終端ミス判定） |

---

## キーボード操作

| キー | アクション |
|------|---------|
| `D` | レーン1（左外） |
| `F` | レーン2（左内） |
| `J` | レーン3（右内） |
| `K` | レーン4（右外） |

---

## 技術スタック

| 技術 | バージョン | 用途 |
|------|-----------|------|
| React | ^18.3.1 | UIフレームワーク |
| TypeScript | ^5.6.2 | 型安全な開発 |
| Vite | ^5.4.8 | ビルドツール・開発サーバー |
| JSZip | ^3.10.1 | MXL（ZIP）解凍 |
| jsdom | ^28.1.0 | MusicXMLパース補助 |

---

## 音源・楽譜について

- 音源は `public/assets/audio/` または `public/scores/songs/<id>/` に配置してください。
- 楽譜と音源は同じアレンジ由来のものを使用すると同期精度が向上します。
- `mxl + midi` を同時指定した場合、ノーツ列は楽譜ベース、タイミングはMIDIベースで同期されます。
- 著作権のある楽曲を使用する場合は、適切なライセンスを確認してください。

---

## ライセンス

このプロジェクトは個人・学習目的で公開されています。
楽譜・音源ファイルは各自で用意してください。
