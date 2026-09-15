import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.STT_MODEL ||= "Xenova/whisper-base";
process.env.STT_DTYPE ||= "q8";

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
await import("./server.js");
