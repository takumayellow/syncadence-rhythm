# プロセカ風リズムゲーム（React + TypeScript）

## 起動

```bash
npm install
npm run dev
```

`http://localhost:5173` を開く．

## 主要機能

- 斜め4レーンのリズムゲーム
- ロングノーツ（入り判定と終端判定を独立）
- Settings で速度/タイミング/BPM/判定ライン調整
- TAP TEMPO で四分打ちからBPMとオフセット補正
- 曲ごと調整値を保存（SAVE FOR THIS SONG）
- MusicXML（`.musicxml`/`.xml`/`.mxl`）とMIDI（`.mid`）読込
- `mxl + midi` 同時指定時は，ノーツ列は楽譜ベース，タイミングはMIDIベースで同期

## 複数楽譜の保持

- 楽譜配置: `public/scores/songs/<id>/`
- 曲一覧: `public/scores/index.json`

`index.json`に1曲追加すると，画面右上の`Score Set`で選択できます．

### `index.json` の主なキー

- `xmlPath`: 非圧縮MusicXML
- `mxlPath`: 圧縮MusicXML（MXL）
- `midiPath`: MIDIタイミング取得用
- `audioUrl`: 音源URL（MIDIを指定した場合はブラウザ再生不可時に簡易シンセで再生）
- `lengthSec`: 曲の長さ（秒）**必須**
- `category`: カテゴリ（任意。`クラシック` / `ボカロ` / `アニメ` / `東方` / `J-POP`）

## 補足

- 必要環境: Node.js v20 以上
- 音源は `public/scores/songs/<id>/` に配置する．
- 楽譜と音源は同じアレンジ由来を使うと同期精度が上がる．
