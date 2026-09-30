# AI Radio MVP

This is the deployable proof-of-concept for continuous AI radio on `main`.

Endpoints:

- `GET /radio` — browser player
- `GET /live.wav` — one continuous live stream for all listeners
- `GET /health` — TTS + broadcast state
- `GET /v1/voices` — available built-in voices
- `POST /v1/tts` — simple WAV generation
- `POST /v1/broadcast/segment` — generate and queue a spoken segment
- `GET /v1/broadcast/status` — queue/listener status

Example segment:

```bash
curl -X POST "https://tts.aharon.cloud/v1/broadcast/segment" \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  --data-raw '{"id":"demo-1","type":"news","priority":50,"speaker":{"id":"main","voice":"michael"},"content":{"text":"ערב טוב. זהו שידור הניסיון הראשון של מערכת החדשות החכמה."}}'
```

Breaking/newsroom segments can use priority 100. Higher-priority queued segments play first; the current segment is not interrupted in this MVP.
