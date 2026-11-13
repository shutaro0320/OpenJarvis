# JARVIS HUD ― 全画面ホログラム音声インターフェース

ダッシュボード無しの、声だけで使うジャービス専用画面です。
常に待機し、**手を2回叩く**か **「ジャービス」と呼ぶ** と応答します。

```
http://127.0.0.1:5173/jarvis
```

または `uv run jarvis gui --hud` で直接開きます。

## 体と頭脳

```
┌──────────── 体（このリポジトリ） ─────────────┐        ┌──── 頭脳（差し替え可能） ────┐
│ /jarvis 画面: ホログラム・拍手検出・字幕       │        │ ・OpenJarvis（Claude サブスク等）│
│ 音声認識（faster-whisper）・読み上げ（edge-tts）│ ─────▶ │ ・Hermes Agent                │
│ /v1/jarvis/chat: 頭脳への中継（CORS・鍵を隠す） │  OpenAI │ ・OpenClaw（Mac mini など）    │
└────────────────────────────────────────────┘  互換API └──────────────────────────────┘
```

頭脳は **OpenAI 互換の `/v1/chat/completions`** を話すものなら何でも使えます。
画面右上の ⚙（設定）で切り替えます。設定は `~/.openjarvis/jarvis.json` に保存され、
API キーはサーバー側だけに保持されます（ブラウザには返しません）。

| 頭脳 | 頭脳側の準備 | URL | モデル | キー |
| --- | --- | --- | --- | --- |
| OpenJarvis（既定） | なし | 空欄 | `Claude（サブスク・Haiku）` など | 不要 |
| Hermes Agent | `~/.hermes/.env` に `API_SERVER_ENABLED=true` と `API_SERVER_KEY=...`、`hermes gateway` を起動 | `http://127.0.0.1:8642/v1` | `hermes-agent` | `API_SERVER_KEY` |
| OpenClaw | 設定で `gateway.http.endpoints.chatCompletions.enabled: true` | `http://<ホスト>:18789/v1` | `openclaw/default` | `gateway.auth.token` |
| その他 | OpenAI 互換サーバー | 任意 | 任意 | 任意 |

Hermes / OpenClaw のようなエージェントを頭脳にすると、PC操作・家電操作など
**そのエージェントが持つツール**を声で使えるようになります。

> OpenClaw のエンドポイントはローカル／tailnet／プライベートネットワーク内だけで公開してください。

## Mac mini（OpenClaw）で使う

Mac mini にこのリポジトリを入れて、体と頭脳を同じマシンで動かすのが簡単です。

```sh
git clone -b claude-subscription-voice https://github.com/shutaro0320/OpenJarvis.git
cd OpenJarvis && uv sync --extra desktop --extra speech
uv run --extra desktop jarvis serve --port 8001 &
uv run jarvis gui --no-server --api-port 8001 --hud
```

開いた画面の ⚙ で「OpenClaw」を選び、URL `http://127.0.0.1:18789/v1`、トークンを入力して保存。
Mac mini をディスプレイ付きの常設端末にすれば「部屋のジャービス」になります。

## 使い方

1. 画面中央をクリック（またはスペースキー）で起動。初回はマイクを許可。
2. 「システム起動。待機します。」の後、**パン・パン** と2回叩くか「ジャービス」と呼ぶ。
3. 「はい、お呼びでしょうか。」の後に話す。話し終えると自動で送信され、返答が読み上げられます。
4. 20秒黙るか「おやすみ」「終了」で待機に戻ります。
5. 応答中に話しかける、または2回叩くと応答を止めます。
6. `F` キーで全画面。

* 拍手は「鋭く大きく、すぐ消える音」を検出しています。声やテーブルを叩く音では反応しにくくしていますが、
  誤反応する場合は ⚙ で拍手起動を切れます。
* スピーカー使用時は自分の声を拾うことがあるため、ヘッドホン、またはマイクとスピーカーを離すのがおすすめです。
* 画面を開いている間だけ動作します（ブラウザのタブを閉じると止まります）。
