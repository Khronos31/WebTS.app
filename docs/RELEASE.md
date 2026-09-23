# リリース手順

## リポジトリの構成

| | 役割 | 公開 |
| --- | --- | --- |
| `Khronos31/WebTS.app-dev` | **開発**。`origin`。散らかった履歴はここで抱える | private のまま |
| `Khronos31/WebTS.app` | **公開**。`upstream`。綺麗なコミットだけが載る | いずれ public |

**なぜ2つに分けるか**。公開するリポジトリには履歴も全部載る。試行錯誤の
コミットや、あとから間違いと分かった判断をそのまま公開したくない。

**なぜ fork ではないか**。GitHub は自分のアカウント内に自分のリポジトリを
fork させない。組織アカウントを作れば本物の cross-repo PR が使えるが、
そこまでの仕組みは要らないと判断した。fork 関係が無い以上、**リポジトリを
またいだ PR は出せない**。PR を立てるなら upstream の中で立てる。

## ふだんの開発

`origin`（開発リポ）へ好きなだけ push する。CI はこちらでも回る。

```sh
git push            # origin = WebTS.app-dev
```

## 公開リポジトリへ出すとき

**1コミットへ潰してから出す**。upstream には結果だけを載せる。

```sh
# 1. upstream の最新に合わせる
git fetch upstream

# 2. upstream/main から作業を1コミットに潰したブランチを作る
git checkout -b release/<話題> upstream/main
git merge --squash main
git commit        # ここで公開用のコミットメッセージを書く

# 3. upstream へ push して、upstream の中で PR を立てる
git push upstream release/<話題>
gh pr create --repo Khronos31/WebTS.app --base main --head release/<話題>
```

PR を squash merge すれば、公開側は1コミットだけ増える。

**コミットメッセージはここで書き直す**。開発中の「とりあえず」「直した」を
そのまま公開しない。何を変えたか、なぜそうしたかを、その変更しか知らない人が
読んで分かる形にする。

## 出す前に通すもの

CI が自動で見るが、手元でも同じものを走らせられる。

```sh
npm run check           # vendor 検査・型・テスト・ビルド
npm run history:check   # 履歴にバイナリが無いこと
```

WASM を作り直したときは、対応する `build:*` を先に走らせる。
`vite build` は `build/` が無いと失敗する（本番で 404 になるより良い）。

```sh
EMSCRIPTEN_ROOT="$HOME/scoop/apps/emscripten/current/upstream/emscripten" \
  npm run build:q3u4-descramble
```

## デプロイ

`.github/workflows/deploy.yml` を **手動で起動する**。push では動かない。
`preview` と `production` を選ぶ。

必要な secret は2つ。

| 名前 | 中身 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Pages の編集権限だけに絞ったトークン |
| `CLOUDFLARE_ACCOUNT_ID` | アカウント ID |

デプロイ前に、配信物へ WASM と交差オリジン分離のヘッダが入っているかを
workflow が確かめる。**どちらが欠けてもアプリは起動しない。**

SBOM と対応ソース bundle は artifact として90日残り、配信物からは除かれる。

## 注意

- **CI は両方のリポジトリで回る**。どちらも private のうちは、同じアカウントの
  無料枠を両方が食う。1 push あたり約5分（実測）。
- 開発リポの履歴は公開しない前提で書いてよいが、**秘密情報を置いてよいわけ
  ではない**。放送キャプチャ、カード情報、ファームウェアはどちらにも入れない。
