# 実装完了メモ

- 対象版: 0.1.0
- 実施日: 2026-07-19
- 実施ブランチ: `agent/build-ground-analysis-webapp`

## 結果

作業計画のPhase 1〜4に対応する静的WebアプリMVPを実装した。Phase 0は計算法と保留事項を文書化し、画面と帳票を「開発・検証版」に制限した。専門家による承認自体は外部プロセスのため未了である。

| フェーズ | 実施内容 | 状態 |
|---|---|---|
| Phase 0 | 仕様確定メモ、非法適合表示、専門家レビュー依頼票 | 実装完了 / 承認待ち |
| Phase 1 | Vite/TS、strict、CI、ドメイン、Schema、JSON/CSV/旧XLS、層正規化 | 完了 |
| Phase 2 | Vs/Tg、Gs略算・現行精算・旧照合、S0・Sa/Sv/Sd、Worker | 完了 |
| Phase 3 | nf・ganmacy、FL・Dcy・PL、層別根拠、共通層分割 | 完了 |
| Phase 4 | 時刻歴、7画面、ECharts、印刷、JSON/CSV、3ブラウザE2E | 完了 |
| Phase 5 | 一次元地盤応答、β、BORING/XML、支持力等の任意拡張 | MVP対象外 |

## 検証結果

| 検証 | 結果 |
|---|---:|
| TypeScript strict | 合格 |
| ESLint | 合格（0 warning / 0 error） |
| Vitest | 12ファイル、112件合格 |
| 行カバレッジ | 86.43% |
| Playwright | 15件合格（Chromium / Firefox / WebKit 各5件） |
| 外部通信監視 | 検出0件 |
| 本番静的ビルド | 合格 |
| `npm audit` | 既知脆弱性0件 |
| `git diff --check` | 合格 |

E2EはVite開発サーバーではなく、`npm run build` で生成した本番静的成果物を `vite preview` で配信して実施した。CSP下でAjvの実行時コード生成を許可しないため、JSON Schema validatorはビルド前に生成した純粋JavaScriptを静的に同梱する。

## 終了時点の外部ブロッカー

1. 構造設計者・地盤技術者による法令、適用条件、液状化係数の承認。
2. 建築研究所資料162号例②③の全入力値を承認したデータ化とゴールデン回帰。結果表の数値だけをゴールデンにすることは避けた。
3. GitHubリモートと有効なGitHub CLI認証。ワークフローは準備済みだが、配信URLとDraft PRはリモート準備後に生成する。
4. 配信URL上での実案件1件の有資格者手順確認。

## データ保全

元 `地盤シート.xls` は変更せず、`.gitignore` でGit管理対象外とした。自動テストは合成BIFF8ワークブックを使用し、実案情報をリポジトリに含めていない。
完了時の参照ファイルSHA-256は `db51fb2eef92f957773916510af7aa9129050d992b04c1c4ca361441d38a0284` である。
