# プロセカ風リズムゲーム（ブラウザ版デモ）

このフォルダは独立したGitリポジトリとして初期化済みです．

## 起動方法

1. このフォルダでローカルサーバーを起動する．
   `python -m http.server 8000`
2. ブラウザで `http://localhost:8000` を開く．
3. `START / RESTART` ボタンを押す．
4. `D / F / J / K` キー，または各レーンをタップしてノーツを叩く．

## 実装内容

- 4レーン落下ノーツ
- 判定: `Perfect / Great / Good / Miss`
- 空打ち時も`MISS`判定を表示
- スコア，コンボ表示
- JSON譜面読み込み（`charts/chopin_nocturne_easy.json`）
- 実クラシック音源を優先再生（Moonlight Sonata 1st，Wikimedia）
- 実クラシック再生が失敗した場合はローカル音源（`assets/audio/classical_long_3min.wav`）へフォールバック
- 公開音源が再生できない環境では，自動で内蔵シンセBGMにフォールバック
- 開始カウントダウン（3，2，1）と開始/終了ジングル
- 押下時は効果音なし，判定テキストのみ表示
- 3D遠近レーン（奥から手前に迫る見た目）
- 約3分の長尺プレイ（180秒，619ノーツ）
- PCキーボード入力とモバイルタップの両対応

## 音源

- ファイル: `assets/audio/classical_long_3min.wav`
- 形式: 22.05kHz/16bit/mono WAV
- ライセンス: プロジェクト内生成のフリー利用想定音源

## Git操作メモ

```bash
git status
git add .
git commit -m "Add browser rhythm game prototype"
```
