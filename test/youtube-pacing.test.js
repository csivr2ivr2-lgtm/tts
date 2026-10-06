import test from "node:test";
import assert from "node:assert/strict";
import { nextRealtimeVideoDue } from "../src/youtube/pacing.js";

test("video pacing never catches up with a zero-delay burst after a stall", () => {
  const frame = 1000 / 30;
  const firstDue = nextRealtimeVideoDue({ now: 1000, previousDue: 1000, durationMs: frame, fps: 30 });
  assert.ok(firstDue >= 1033);

  // Simulate the event loop waking up 4 seconds late. The next frame must be
  // scheduled one frame into the future from *now*, not immediately.
  const afterStall = nextRealtimeVideoDue({ now: 5000, previousDue: firstDue, durationMs: frame, fps: 30 });
  assert.ok(afterStall >= 5033);
  assert.ok(afterStall - 5000 >= 33);
});

test("video pacing preserves normal cadence when the timer is on time", () => {
  const due = nextRealtimeVideoDue({ now: 1000, previousDue: 1033.333, durationMs: 33.333, fps: 30 });
  assert.ok(due > 1066 && due < 1067);
});

test("invalid sample duration falls back to configured fps", () => {
  const due = nextRealtimeVideoDue({ now: 1000, previousDue: 1000, durationMs: 0, fps: 25 });
  assert.equal(due, 1040);
});
