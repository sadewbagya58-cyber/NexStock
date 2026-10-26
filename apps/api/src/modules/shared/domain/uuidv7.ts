import { randomFillSync } from 'node:crypto';

let lastTimestampMs = -1;
let monotonicCounter = 0;

/**
 * Generates an RFC 9562 compliant time-ordered UUIDv7 string.
 * Guarantees strict chronological monotonicity within the same process even when multiple UUIDs
 * are generated within the same millisecond.
 */
export function generateUuidV7(nowMs: number = Date.now()): string {
  const randomBytes = new Uint8Array(10);
  randomFillSync(randomBytes);

  if (nowMs === lastTimestampMs) {
    monotonicCounter = (monotonicCounter + 1) & 0x0fff;
    if (monotonicCounter === 0) {
      // Counter overflow within the same ms: advance effective timestamp by 1ms
      nowMs = lastTimestampMs + 1;
      lastTimestampMs = nowMs;
    }
  } else if (nowMs > lastTimestampMs) {
    lastTimestampMs = nowMs;
    monotonicCounter = ((randomBytes[0]! << 8) | randomBytes[1]!) & 0x0fff;
  } else {
    // Clock moved backwards: preserve monotonicity from lastTimestampMs
    nowMs = lastTimestampMs;
    monotonicCounter = (monotonicCounter + 1) & 0x0fff;
  }

  const bytes = new Uint8Array(16);
  // 48-bit big-endian Unix epoch timestamp in milliseconds
  const timeBig = BigInt(nowMs);
  bytes[0] = Number((timeBig >> 40n) & 0xffn);
  bytes[1] = Number((timeBig >> 32n) & 0xffn);
  bytes[2] = Number((timeBig >> 24n) & 0xffn);
  bytes[3] = Number((timeBig >> 16n) & 0xffn);
  bytes[4] = Number((timeBig >> 8n) & 0xffn);
  bytes[5] = Number(timeBig & 0xffn);

  // Version 7 (0111) in high nibble of byte 6 + 12-bit monotonic rand_a
  bytes[6] = 0x70 | ((monotonicCounter >> 8) & 0x0f);
  bytes[7] = monotonicCounter & 0xff;

  // Variant 10xx in high bits of byte 8 + 62-bit random payload
  bytes[8] = 0x80 | (randomBytes[2]! & 0x3f);
  bytes[9] = randomBytes[3]!;
  bytes[10] = randomBytes[4]!;
  bytes[11] = randomBytes[5]!;
  bytes[12] = randomBytes[6]!;
  bytes[13] = randomBytes[7]!;
  bytes[14] = randomBytes[8]!;
  bytes[15] = randomBytes[9]!;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
