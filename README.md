# Aharon TTS Server v0.2.3

Node.js server-side Hebrew TTS for Hostinger Business, with a prepared custom voice profile.

## Why v0.2.3 exists

On this Hostinger Business account, loading the 177 MB TTS model and the ~39 MB voice encoder at the same time caused the Node process to restart around 60% of the encoder load.

v0.2.3 keeps the v0.2.2 split between encoder and TTS, and also handles Hostinger process recycling automatically:

1. **One-time voice build:** load only `encoder.onnx` + a private local `voices/ari.wav`, write a small persistent `ari.voice` profile, release the encoder.
2. **Normal TTS:** load the TTS model + the prepared `ari.voice`. The encoder is never loaded during normal speech generation.
3. **Cold-process recovery:** if Hostinger gives `/v1/tts` a fresh Node PID in `idle`, that same TTS request loads the model and prepared `ari.voice` before generating the WAV. No separate warmup is required.

The profile and encoder cache are stored by default under:

```text
~/.cache/aharon-tts/
├── ari.voice
└── encoder.onnx
```

That path is outside Hostinger's versioned `hbuilds/...` deployment directory, so process restarts do not delete the prepared voice profile.

## Deploy

Upload the complete project and redeploy with Node.js 20+.

Set a fresh `TTS_API_KEY`. Do not reuse an API key that has already appeared in chat/logs.

## Step 1 — build Ari voice once

Run from the Hostinger SSH terminal:

```bash
curl -N -X POST "https://tts.aharon.cloud/admin/build-voice/" \
  -H "Authorization: Bearer YOUR_NEW_KEY"
```

Expected stages include:

```text
accepted
manifest
encoder-download 0% ... 100%
voice-decode
voice-decoded
encoder-session-create
encoder-run
profile-saved
ready
complete
```

If Hostinger restarts the process during the encoder **download**, run the same command again. v0.2.2 keeps `encoder.onnx.part` and resumes it with HTTP Range instead of starting from zero.

If the full encoder was already downloaded, later attempts show:

```text
encoder-cache-hit 100%
```

Check whether the persistent profile exists:

```bash
curl "https://tts.aharon.cloud/admin/voice-status" \
  -H "Authorization: Bearer YOUR_NEW_KEY"
```

Look for:

```json
"profile":{"exists":true}
```

## Step 2 — optional manual warmup

After the voice profile exists, manual warmup is optional. You can still run:

```bash
curl -N -X POST "https://tts.aharon.cloud/admin/warmup/" \
  -H "Authorization: Bearer YOUR_NEW_KEY"
```

The warmup no longer downloads or loads the voice encoder. A successful end is:

```text
[TTS] loading prepared voice 'ari' from .../.cache/aharon-tts/ari.voice
[TTS] prepared voice 'ari' loaded ...
[TTS] ready sampleRate=24000 defaultVoice=ari customVoiceLoaded=true
```

## Step 3 — verify (optional)

```bash
curl "https://tts.aharon.cloud/ready"
```

Expected:

```json
{
  "ok": true,
  "ready": true,
  "language": "hebrew",
  "sampleRate": 24000,
  "defaultVoice": "ari",
  "customVoiceLoaded": true
}
```

## Generate WAV

This endpoint now auto-loads the model if Hostinger recycled the Node process. A cold request will therefore be slower, but it should still return a real WAV instead of `warming_up`.

```bash
curl -X POST "https://tts.aharon.cloud/v1/tts" \
  -H "Authorization: Bearer YOUR_NEW_KEY" \
  -H "Content-Type: application/json" \
  --data-raw '{"text":"שלום, זה הקול המשובט שלי."}' \
  --output speech.wav
```

The personal source recording is intentionally **not committed to GitHub**. On the current Hostinger deployment, the prepared profile already exists at `~/.cache/aharon-tts/ari.voice`, so normal TTS does not need the WAV. To rebuild the profile later, place a private recording at `voices/ari.wav` (or set `TTS_VOICE_FILE`) and call `/admin/build-voice/`. A clean 15–20 second sample should improve similarity.
