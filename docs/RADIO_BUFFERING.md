# Full-segment broadcast buffering — 0.9.1-rc.1

Base: ab18a7022f709b41478a2e3cb1bf463bbccb8c05 (package 0.9.0, server label 0.8.4).
This is a release candidate, not an approved production deployment. Existing YouTube code/assets and model dependencies are preserved.

Broadcast TTS collects the complete utterance and validates Float32 samples and PCM16 bounds before atomically saving an audio record containing its sample rate, byte count, checksum and generation metrics. Only then is the utterance enqueued as one contiguous segment. The generation queue runs one task at a time; playback does not hold that queue. Breaking priority is applied to pending generation and ready playout without cutting the current voice segment.

The default POST /v1/broadcast/segment and GET /v1/broadcast/jobs/:id paths remain. New optional POST fields:
- prepareOnly: true — persist audio without releasing it to the station.
- notBefore, validUntil: Unix milliseconds.
- POST /v1/broadcast/jobs/:id/release releases a prepared job idempotently.

Status lifecycle: pending → generating → audio-ready → queued → playing → completed.
New terminal statuses: expired and interrupted. NanoClaw consumers must recognize audio-ready as in progress. Metrics include generationMs, generatedAudioSec, generationRtRatio (audio seconds / generation seconds), audioBytes, readyAt, queueWaitMs, playbackStartedAt, playbackFinishedAt.

Recovery chooses at-most-once playback: a job with a persisted first-byte claim is interrupted on restart rather than replayed. A crash between claim and actual output can therefore omit a segment; exactly-once physical audio cannot be guaranteed by a JSON transaction. Completed idempotency tombstones are retained; only older terminal audio is pruned. A single writer process per BROADCAST_JOB_DIR is required. Files are private and checksummed. Full buffering removes producer underrun, but OS/event-loop/network stalls still need measurement on the real host.

Optional music configuration:

```env
RADIO_MUSIC_ENABLED=true
BROADCAST_SAMPLE_RATE=24000
RADIO_ASSET_DIR=/absolute/path/to/assets/radio
BROADCAST_MAX_SEGMENT_BYTES=33554432
```

Subdirectories: jingles/, fillers/, night-music/. Supply your own licensed PCM16 mono WAV files at the broadcast sample rate. No music is bundled. Assets load asynchronously with a 32 MiB cache cap; a music transition is available every ten seconds. Missing/invalid assets are ignored; silence remains possible when neither voice nor valid music is available. Overnight mode uses Asia/Jerusalem, 00:00–06:00. Start music explicitly with RADIO_MUSIC_ENABLED so existing deployments keep their startup behavior.

Verification: `npm test`; syntax checks with `npm run check`. Tests use a controlled synthetic TTS generator; Pocket TTS model execution, HTTP server startup with native dependencies, YouTube encoding, and live listening have not been verified in this restricted environment. Do not deploy until the combined NanoClaw and real-host gates have passed and a real rollback snapshot exists.
