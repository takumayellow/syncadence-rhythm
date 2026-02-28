# XML配置ルール

- 複数楽譜は `public/scores/xml/` に置く．
- 曲一覧は `public/scores/index.json` に追記する．
- ブラウザから手動読込する場合は Settings の file input でも可．

## index.json の必須項目

- `id`
- `title`
- `artist`
- `audioUrl`
- `xmlPath`
- `offsetMs`
- `bpm`
- `lengthSec`
