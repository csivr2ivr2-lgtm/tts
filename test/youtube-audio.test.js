import test from "node:test";
import assert from "node:assert/strict";
import * as lame from "@breezystack/lamejs";

test("@breezystack/lamejs exposes a working ESM Mp3Encoder", () => {
  const Mp3Encoder = lame.Mp3Encoder || lame.default?.Mp3Encoder;
  assert.equal(typeof Mp3Encoder, "function");
  const encoder = new Mp3Encoder(2, 44100, 128);
  const silence = new Int16Array(1152);
  const first = encoder.encodeBuffer(silence, silence);
  const final = encoder.flush();
  assert.ok((first?.length || 0) + (final?.length || 0) > 0);
});
