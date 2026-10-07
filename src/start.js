import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.STT_MODEL ||= "Xenova/whisper-base";
process.env.STT_DTYPE ||= "q8";

const formatError = (value) => value instanceof Error ? value.name + ": " + value.message + "\n" + (value.stack || "") : String(value);
process.on("uncaughtExceptionMonitor", (error, origin) => {
  console.error("[PROCESS] uncaughtException origin=" + origin + " pid=" + process.pid + " " + formatError(error));
});
process.on("unhandledRejection", (reason) => {
  console.error("[PROCESS] unhandledRejection pid=" + process.pid + " " + formatError(reason));
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    const mem = process.memoryUsage();
    console.log("[PROCESS] signal=" + signal + " pid=" + process.pid + " rssMb=" + (mem.rss / 1048576).toFixed(1));
    process.exit(0);
  });
}

const sipLogFile = process.env.SIP_LOG_FILE || path.join(os.homedir(), ".cache", "aharon-tts", "sip-events.log");
fs.mkdirSync(path.dirname(sipLogFile), { recursive: true });

const originalLog = console.log.bind(console);
console.log = (...args) => {
  const first = typeof args[0] === "string" ? args[0] : "";
  if (first.startsWith("[SIP]")) {
    try { fs.appendFileSync(sipLogFile, `${new Date().toISOString()} pid=${process.pid} ${first}\n`, "utf8"); } catch {}
  }
  originalLog(...args);
};

fs.appendFileSync(sipLogFile, `${new Date().toISOString()} pid=${process.pid} [SIP] process-start\n`, "utf8");
// YouTube must receive a continuous real-time stream from process startup, even
// when Pocket TTS has not been loaded and there are no radio music assets.
// server.js already primes the broadcast clock when RADIO_MUSIC_ENABLED=true;
// borrow that bootstrap only during module initialization, then restore the flag.
const originalRadioMusicEnabled = process.env.RADIO_MUSIC_ENABLED;
const primeYouTubeBroadcastClock = process.env.YOUTUBE_LIVE_ENABLED === "true" && originalRadioMusicEnabled !== "true";
if (primeYouTubeBroadcastClock) {
  process.env.BROADCAST_SAMPLE_RATE ||= "24000";
  process.env.RADIO_MUSIC_ENABLED = "true";
  console.log("[YOUTUBE] priming continuous broadcast clock at process startup");
}
try {
  await import("./server.js");
} finally {
  if (primeYouTubeBroadcastClock) {
    if (originalRadioMusicEnabled === undefined) delete process.env.RADIO_MUSIC_ENABLED;
    else process.env.RADIO_MUSIC_ENABLED = originalRadioMusicEnabled;
  }
}
