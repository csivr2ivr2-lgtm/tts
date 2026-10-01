import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const JOB_DIR = process.env.BROADCAST_JOB_DIR || path.join(os.homedir(), ".cache", "aharon-tts", "broadcast-jobs");
const MAX_FILES = Math.max(20, Number(process.env.BROADCAST_JOB_MAX_FILES || 200));

function ensureDir() {
  fs.mkdirSync(JOB_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(JOB_DIR, 0o700); } catch {}
}

function jobPath(id) {
  const digest = crypto.createHash("sha256").update(String(id)).digest("hex");
  return path.join(JOB_DIR, digest + ".json");
}

function writeAtomic(file, value) {
  ensureDir();
  const tmp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function getBroadcastJob(id) {
  try {
    const parsed = JSON.parse(fs.readFileSync(jobPath(id), "utf8"));
    return parsed && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

export function saveBroadcastJob(job) {
  const now = Date.now();
  const value = { ...job, createdAt: Number(job.createdAt || now), updatedAt: now };
  writeAtomic(jobPath(value.id), value);
  return value;
}

export function patchBroadcastJob(id, patch) {
  const existing = getBroadcastJob(id);
  if (!existing) return null;
  return saveBroadcastJob({ ...existing, ...patch, id: existing.id });
}

export function createBroadcastJob(job) {
  const existing = getBroadcastJob(job.id);
  if (existing) return { created: false, job: existing };
  const value = saveBroadcastJob(job);
  pruneBroadcastJobs();
  return { created: true, job: value };
}

export function recoverableBroadcastJobs(limit = 50) {
  ensureDir();
  const recoverable = new Set(["pending", "generating", "streaming", "queued", "playing"]);
  const jobs = [];
  for (const name of fs.readdirSync(JOB_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(JOB_DIR, name), "utf8"));
      if (job && job.id && recoverable.has(job.status)) jobs.push(job);
    } catch {}
  }
  return jobs.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0)).slice(0, Math.max(1, Number(limit) || 50));
}

export function pruneBroadcastJobs() {
  ensureDir();
  const entries = [];
  for (const name of fs.readdirSync(JOB_DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      const file = path.join(JOB_DIR, name);
      entries.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {}
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(MAX_FILES)) {
    try { fs.unlinkSync(entry.file); } catch {}
  }
}

export function broadcastJobStoreInfo() {
  ensureDir();
  let files = 0;
  try { files = fs.readdirSync(JOB_DIR).filter((name) => name.endsWith(".json")).length; } catch {}
  return { directory: JOB_DIR, files, maxFiles: MAX_FILES };
}
