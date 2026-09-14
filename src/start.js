process.env.STT_MODEL ||= "Xenova/whisper-base";
process.env.STT_DTYPE ||= "q8";

await import("./server.js");
