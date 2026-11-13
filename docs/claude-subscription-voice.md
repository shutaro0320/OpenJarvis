# Claude（サブスク）+ 音声会話

Claude Pro/Max のサブスクリプションで OpenJarvis とチャット・音声会話するための追加機能です。
Windows / macOS / Linux で動作します。API キーは不要です。

## 追加されたもの

| 機能 | ファイル | 内容 |
| --- | --- | --- |
| Claude（サブスク）エンジン | `src/openjarvis/engine/claude_subscription.py` | ログイン済みの Claude Code CLI（`claude -p`）経由で応答。モデル一覧に「Claude（サブスク）」「Claude（サブスク・Opus）」「Claude（サブスク・Haiku）」が出ます |
| OS 標準の読み上げ | `src/openjarvis/speech/system_tts.py` | Windows: SAPI（Haruka など）/ macOS: `say`（Kyoko など）/ Linux: espeak-ng。日本語の文は自動で日本語の声に |
| 音声会話モード | `frontend/src/lib/voice-listen.ts`, `InputArea.tsx` | 入力欄の波形ボタンでハンズフリー会話（聞く → 話し終えたら自動送信 → 返答を読み上げ → また聞く） |

## セットアップ（Mac / Windows 共通）

1. Claude Code をインストールしてログイン

   ```sh
   npm install -g @anthropic-ai/claude-code   # またはネイティブインストーラ
   claude            # 起動後 /login でサブスクのアカウントにログイン
   ```

2. このブランチを取得

   ```sh
   git clone https://github.com/shutaro0320/OpenJarvis.git
   cd OpenJarvis
   git checkout claude-subscription-voice
   uv sync --extra desktop --extra speech
   ```

3. 起動

   ```sh
   uv run --extra desktop jarvis serve --port 8001
   uv run jarvis gui --no-server --api-port 8001    # 別ターミナル
   ```

4. ブラウザで <http://127.0.0.1:5173> を開き、モデルに「Claude（サブスク）」を選択。
   入力欄の波形アイコンを押すと音声会話が始まります（初回はマイクの許可が必要）。

## 補足

* `claude` が見つからない場合は `OPENJARVIS_CLAUDE_CLI=/path/to/claude` を設定してください。
* macOS で日本語の声が無い場合は「システム設定 → アクセシビリティ → 読み上げコンテンツ → システムの声」から Kyoko を追加してください。
* 音声認識は faster-whisper（`base`）を使い、ブラウザの言語（日本語なら `ja`）を指定して認識します。
* このエンジンはチャット専用です（Claude 側のファイル操作などのツールは無効化しています）。
