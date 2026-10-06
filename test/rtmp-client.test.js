import test from "node:test";
import assert from "node:assert/strict";
import { RtmpPublisher, amf0DecodeAll } from "../src/youtube/rtmp-client.js";

function publisher() {
  const p = new RtmpPublisher({ url: "rtmps://a.rtmps.youtube.com/live2", streamKey: "test-key" });
  const sent = [];
  p.socket = { destroyed: false, write: data => { sent.push(Buffer.from(data)); return true; }, destroy() {} };
  p._sendMessage = message => sent.push(message);
  return { p, sent };
}

test("Set Peer Bandwidth is acknowledged with Window Acknowledgement Size", () => {
  const { p, sent } = publisher();
  const payload = Buffer.alloc(5); payload.writeUInt32BE(2500000, 0); payload[4] = 2;
  p._handleMessage({ typeId: 6, payload });
  assert.equal(p.peerBandwidth, 2500000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].typeId, 5);
  assert.equal(sent[0].payload.readUInt32BE(0), 2500000);
});

test("optional FMLE command errors do not abort create/publish flow", () => {
  const { p } = publisher();
  let failed = false; p._fail = () => { failed = true; };
  const amf = Buffer.concat([
    Buffer.from([2,0,6]), Buffer.from("_error"),
    Buffer.from([0,0x40,0,0,0,0,0,0,0]),
    Buffer.from([5]),
    Buffer.from([3,0,4]), Buffer.from("code"), Buffer.from([2,0,11]), Buffer.from("Net.Error.X"), Buffer.from([0,0,9])
  ]);
  p._handleMessage({ typeId: 20, payload: amf });
  assert.equal(failed, false);
});

test("AMF0 decoder tolerates date and reference values", () => {
  const date = Buffer.alloc(11); date[0] = 11; date.writeDoubleBE(1234,1); date.writeInt16BE(0,9);
  const ref = Buffer.from([7,0,1]);
  assert.deepEqual(amf0DecodeAll(Buffer.concat([date,ref])), [1234,null]);
});
