import assert from "node:assert/strict";
import test from "node:test";
import { UploadRate } from "./upload-rate";

test("calculates bytes per second from actual elapsed time, not timer frequency", () => {
  const rate = new UploadRate(0);
  assert.equal(rate.sample(1_024, 250), 4_096);
  assert.equal(rate.sample(4_096, 1_000), 4_096);
});

test("drops old transfer history and reaches zero when an upload stalls", () => {
  const rate = new UploadRate(0);
  for (let time = 500; time <= 3_000; time += 500) rate.sample(time * 1_000, time);
  assert.equal(rate.sample(3_000_000, 3_500), 2_500_000 / 3);
  for (let time = 4_000; time < 6_000; time += 500) rate.sample(3_000_000, time);
  assert.equal(rate.sample(3_000_000, 6_000), 0);
  assert.equal(rate.sample(4_500_000, 6_500), 500_000);
});

test("avoids division by zero and negative rates before bytes start flowing", () => {
  const rate = new UploadRate(100);
  assert.equal(rate.sample(0, 100), null);
  assert.equal(rate.sample(0, 99), null);
  assert.equal(rate.sample(0, 600), 0);
  assert.equal(rate.sample(0, 1_100), 0);
});
