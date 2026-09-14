# Aharon Voice AI v0.3.0

Local Hebrew voice backend for Hostinger Business, running entirely in Node.js 20+:

- **TTS:** `pocket-tts-onnx`, Hebrew, custom prepared `ari.voice`.
- **STT:** local multilingual Whisper Tiny through Transformers.js, default `q8`.
- **No external TTS/STT API required.**
- Persistent models and voice assets live under `/home/<user>/.cache/aharon-tts/` so Hostinger redeploys do not delete them.
- TTS and STT inference share one queue to avoid running two CPU-heavy inference jobs simultaneously.

## Deploy

Deploy `main` on Hostinger with Node.js 20+ and set a fresh `TTS_API_KEY`.

The important defaults are in `.env.example`.

## TTS

Generate a WAV:

```bash
curl -X POST "https://tts.aharon.cloud/v1/tts" \
  -H "Authorization: Bearer YOUR_NEW_KEY" \
  -H "Content-Type: application/json" \
  --data-raw '{"text":"שלום, זה מבחן של מערכת הקול."}' \
  --output speech.wav
```

`/v1/tts` cold-starts the TTS model automatically when Hostinger gives the request a fresh Node process.

TTS status:

```bash
curl "https://tts.aharon.cloud/ready"
```

Optional manual TTS warmup:

```bash
curl -N -X POST "https://tts.aharon.cloud/admin/warmup/" \
  -H "Authorization: Bearer YOUR_NEW_KEY"
```

### Custom voice profile

The prepared profile is stored by default at:

```text
/home/<user>/.cache/aharon-tts/ari.voice
```

Build or replace it:

```bash
curl -N -X POST "https://tts.aharon.cloud/admin/build-voice/?force=1" \
  -H "Authorization: Bearer YOUR_NEW_KEY"
```

Normal TTS does not need the source recording after `ari.voice` has been generated.

**Temporary bootstrap note:** a private encoded bootstrap recording may be committed to `voices/` only while replacing the prepared voice profile. After a successful `profile-saved`, remove that bootstrap from `main`; the persistent `ari.voice` remains outside the deployment tree.

## Local STT — Whisper

v0.3.0 adds local speech-to-text with `@huggingface/transformers` and `Xenova/whisper-tiny` in `q8` mode. The first load downloads the Whisper files; later loads reuse the persistent disk cache.

Default STT cache:

```text
/home/<user>/.cache/aharon-tts/whisper/
```

The STT model is lazy-loaded and is unloaded from RAM after the configured idle timeout (60 seconds by default). The disk cache stays in place.

### Warm up / download Whisper

```bash
curl -N -X POST "https://tts.aharon.cloud/admin/stt/warmup/" \
  -H "Authorization: Bearer YOUR_NEW_KEY"
```

Expected stages include:

```text
accepted
load-start
loading-model
model-progress ...
ready
complete
```

STT status:

```bash
curl "https://tts.aharon.cloud/admin/stt/status" \
  -H "Authorization: Bearer YOUR_NEW_KEY"
```

Unload STT from RAM manually:

```bash
curl -X POST "https://tts.aharon.cloud/admin/stt/unload" \
  -H "Authorization: Bearer YOUR_NEW_KEY"
```

### Transcribe WAV

```bash
curl -X POST "https://tts.aharon.cloud/v1/stt" \
  -H "Authorization: Bearer YOUR_NEW_KEY" \
  -H "Content-Type: audio/wav" \
  --data-binary @speech.wav
```

Example response:

```json
{
  "ok": true,
  "text": "שלום, זה מבחן תמלול.",
  "language": "hebrew",
  "model": "Xenova/whisper-tiny",
  "durationSec": 4.2,
  "sampleRate": 16000,
  "processingMs": 1200
}
```

### Telephony audio

`/v1/stt` also accepts raw telephony audio as `application/octet-stream`:

- signed PCM16: `encoding=s16le`
- G.711 μ-law / PCMU: `encoding=mulaw` or `encoding=pcmu`
- G.711 A-law / PCMA: `encoding=alaw` or `encoding=pcma`

Example for 8 kHz PCMU:

```bash
curl -X POST "https://tts.aharon.cloud/v1/stt?encoding=mulaw&sample_rate=8000" \
  -H "Authorization: Bearer YOUR_NEW_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @audio.pcmu
```

Input is converted internally to Whisper's 16 kHz mono waveform.

## STT environment variables

```env
STT_MODEL=Xenova/whisper-tiny
STT_DTYPE=q8
STT_LANGUAGE=hebrew
STT_IDLE_UNLOAD_MS=60000
STT_MAX_AUDIO_BYTES=8388608
STT_MAX_AUDIO_SECONDS=120
```

Optional:

```env
STT_CACHE_DIR=/home/USER/.cache/aharon-tts/whisper
```

## Health

```bash
curl "https://tts.aharon.cloud/health"
```

`/health` reports both TTS and STT state, model information, process ID and voice-build status.
