# Full-duplex SIP call design

## Goal
A real-time AI phone call with two simultaneous audio directions and optional human takeover.

## Media directions
- **RX:** SIP/RTP caller audio -> jitter buffer -> codec decode -> VAD -> utterance framing -> STT.
- **TX:** AI text -> TTS -> codec encode -> paced RTP/SIP media back to caller.

RX and TX are independent. RX must remain active during TX playback.

## Session state
Each call has a unique `callId` and owns:
- mode: `ai | human | hybrid | ending`
- caller/callee metadata
- selected SIP codec and clock rate
- STT partial/final transcript
- AI conversation context
- current TTS generation/playback id
- RX sequence/timestamps and TX sequence/timestamps
- human bridge metadata when attached

## Barge-in
When VAD detects caller speech while AI audio is playing:
1. cancel the active TTS/playback generation;
2. flush queued TX audio not yet sent;
3. continue RX capture without interruption;
4. finalize the caller utterance;
5. send the new transcript plus existing context to the AI.

## Human handoff
A live call may switch to `human` without creating a new conversation. The AI stops transmitting audio, while the same media session is bridged to the human leg. Context remains available so the human or AI can resume later.

## Hostinger resource rule
Large local models must not compete for memory. STT stays lazy-loaded/unloaded. Heavy STT/TTS inference may be serialized where required, while media I/O itself remains full-duplex and non-blocking.

## Next transport milestone
Implement the SIP/RTP adapter with inbound and outbound media queues, codec negotiation starting with PCMU/PCMA at 8 kHz, jitter handling, pacing, call lifecycle, barge-in hooks, and human bridge/handoff hooks.
