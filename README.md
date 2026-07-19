# 地盤解析Webアプリ

旧 `地盤シート.xls` の入力を取り込み、地盤増幅、液状化、時刻歴・応答スペクトルをブラウザ内で計算する静的Webアプリです。Excel、VBA、外部解析プログラム、実行時サーバーには依存しません。

## 機能

- 旧 `.xls` の入力値だけを抽出（数式・VBA・保存計算値は非採用）
- `.jiban.json`、地層CSV、N値CSV、時刻歴CSVのファイル交換
- Vs推定、弾性地盤周期、Gs略算・安全限界精算・旧シート照合
- 告示標準スペクトルと地表 `Sa` / `Sv` / `Sd`
- 150 gal / M7.0、350 gal / M7.5のFL・Dcy・PLスクリーニング
- PGA / PGV / PGDと5%減衰弾性応答スペクトル
- Web Workerの進捗・取消、7画面、SVGグラフ、A4印刷、JSON/CSV結果

## 起動

Node.js 22以上を使用します。

```bash
npm ci
npm run dev
```

ブラウザに表示されたローカルURLを開き、「ファイルを開く」から案件ファイルを読み込みます。何も読み込まない場合は、検証用の初期モデルで略算を実行できます。

## 検証と静的ビルド

```bash
npm run check
npm run test:e2e
```

`npm run check` はstrict型検査、ESLint、Vitest、本番ビルドを実行します。`npm run test:e2e` は静的ビルドをChromium、Firefox、WebKitで検査します。配信物は `dist/` に生成され、GitHub Pagesなどの静的ホスティングに置けます。

## 文書

- [構築準備調査](地盤解析Webアプリ構築準備調査.md)
- [作業計画](地盤解析Webアプリ作業計画.md)
- [アーキテクチャと計算仕様](docs/architecture.md)
- [仕様確定状況](docs/specification-status.md)
- [MVP受入チェックリスト](docs/acceptance-checklist.md)
- [実装完了メモ](docs/implementation-completion.md)
- [専門家レビュー依頼票](docs/expert-review-request.md)
- [セキュリティ](docs/security.md)
- [第三者表示](THIRD_PARTY_NOTICES.md)

## 重要事項

本アプリは開発・検証版です。専門家レビューが完了するまで、表示結果は法適合、設計妥当性、安全性を保証しません。特に液状化は旧シート由来のスクリーニング法であり、係数表の利用条件は未承認です。

元の `地盤シート.xls` は参照資産として保存し、Git管理対象外です。アプリは実行時にネットワーク送信を行いません。
