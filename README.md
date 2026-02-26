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
- ロングノーツ対応（押しっぱなし判定）
- 空打ち時も`MISS`判定を表示
- スコア，コンボ表示
- プレイ中ライフゲージ表示（判定に応じて増減）
- 終了時リザルト表示（`CLEAR!/FAILED`，ランク，精度）
- `SETTINGS`からノーツ速度変更（6.0〜12.0，保存あり）
- `SETTINGS`からタイミングオフセット調整（-300〜+300ms，保存あり）
- `[` / `]` キーでタイミングオフセットを±20ms微調整
- ノーツ幅を拡張して視認性を改善
- JSON譜面読み込み（`charts/chopin_nocturne_easy.json`）
- ショパン音源再生（`assets/audio/Chopin_Nocturne_Op_9_No_2.ogg`）
- 再生失敗時も同一ローカル音源へフォールバック
- 公開音源が再生できない環境では，自動で内蔵シンセBGMにフォールバック
- 開始カウントダウン（3，2，1）と開始/終了ジングル
- 押下時は効果音なし，判定テキストのみ表示
- 3D遠近レーン（奥から手前に迫る見た目）
- 長尺プレイ（200秒，187ノーツ）
- 楽譜の拍感に寄せた譜面（3/4フレーズ基準）
- PCキーボード入力とモバイルタップの両対応

## 音源

- ファイル: `assets/audio/Chopin_Nocturne_Op_9_No_2.ogg`
- ライセンス: Public domain composition / Wikimedia recording

## Git操作メモ

```bash
git status
git add .
git commit -m "Add browser rhythm game prototype"
```
