# Claude（サブスク）+ ジャービス音声会話

Claude Pro/Max のサブスクリプションで、OpenJarvis と声で会話するための追加機能です。
Windows / macOS / Linux で動作し、API キーは不要です。

## できること

* **呼びかけで起動**：「ジャービス」と呼ぶと「はい、お呼びでしょうか」と応答。
  「ジャービス、明日の天気は？」のように続けて話せば、そのまま質問として扱います。
* **ハンズフリー会話**：話し終えて約1秒黙ると自動送信 → 返答を読み上げ → また聞き取り。
  20秒話さなければ待機（呼びかけ待ち）に戻ります。「おやすみ」「終了」で待機に戻ります。
* **すぐ話し始める**：返答を一文ずつ読み上げるので、全文の完成を待ちません。
  Claude の CLI はあらかじめ起動しておき、話し始めまでの待ち時間を約1秒にしています。
* **割り込み**：読み上げ中に話しかけると止まり、そのまま聞き取りに切り替わります。
* **自然な声**：Microsoft のニューラル音声（日本語は男性の Keita、英語は英国男性の Ryan）。
  オフライン時は OS 標準の声（Windows: Haruka / macOS: Kyoko）に自動で切り替わります。
* **ジャービスの人格**：落ち着いた執事口調で、短く話し言葉で答えます。

## 使い方

1. <http://127.0.0.1:5173> を開き、モデルで「Claude（サブスク・Haiku）」（最速）か「Claude（サブスク）」を選ぶ。
2. 入力欄右の **波形アイコン** を押す（初回はマイクの許可）。すぐ会話が始まります。
3. しばらく黙ると「待機中」になり、以後は「ジャービス」と呼べば再開します。
4. もう一度アイコンを押すと音声会話を終了します。

> スピーカーで使うと、ジャービス自身の声を拾って割り込みと誤認することがあります。
> 誤認した場合は自動で無視しますが、**ヘッドホン／イヤホン推奨**です。

## セットアップ（Mac / Windows 共通）

1. Claude Code をインストールしてログイン

   ```sh
   npm install -g @anthropic-ai/claude-code   # またはネイティブインストーラ
   claude            # 起動後 /login でサブスクのアカウントにログイン
   ```

2. このブランチを取得

   ```sh
   git clone -b claude-subscription-voice https://github.com/shutaro0320/OpenJarvis.git
   cd OpenJarvis
   uv sync --extra desktop --extra speech
   ```

3. 起動（2つのターミナルで）

   ```sh
   uv run --extra desktop jarvis serve --port 8001
   uv run jarvis gui --no-server --api-port 8001
   ```

## 構成

| 機能 | ファイル |
| --- | --- |
| Claude（サブスク）エンジン＋プロセス事前起動 | `src/openjarvis/engine/claude_subscription.py` |
| ニューラル音声（edge-tts） | `src/openjarvis/speech/edge_tts_backend.py` |
| OS 標準音声（予備） | `src/openjarvis/speech/system_tts.py` |
| 音声区間検出（話し終わり・割り込み） | `frontend/src/lib/voice-listen.ts` |
| 一文ずつ読み上げ・エコー判定 | `frontend/src/lib/voice-speaker.ts` |
| 会話ループ・呼びかけ・人格 | `frontend/src/components/Chat/InputArea.tsx` |
| エージェントを通さない直接ストリーミング（`direct: true`） | `src/openjarvis/server/routes.py` |

## 設定（環境変数・任意）

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `OPENJARVIS_CLAUDE_CLI` | 自動検出 | `claude` 実行ファイルのパス |
| `OPENJARVIS_CLAUDE_PREWARM` | `sonnet,haiku` | 事前起動しておくモデル |
| `OPENJARVIS_CLAUDE_WARM_SECONDS` | `600` | 事前起動プロセスの入れ替え間隔（秒） |
| `OPENJARVIS_EDGE_VOICE_JA` | `ja-JP-KeitaNeural` | 日本語の声（女性なら `ja-JP-NanamiNeural`） |
| `OPENJARVIS_EDGE_VOICE` | `en-GB-RyanNeural` | 日本語以外の声 |

## 補足

* macOS で日本語の予備音声が無い場合は「システム設定 → アクセシビリティ → 読み上げコンテンツ → システムの声」から Kyoko を追加してください。
* ニューラル音声は Microsoft のオンライン読み上げサービスに文章を送ります。送りたくない場合は `edge-tts` をアンインストールすると OS 標準の声のみになります。
* このエンジンはチャット専用です（Claude 側のファイル操作などのツールは無効化しています）。
