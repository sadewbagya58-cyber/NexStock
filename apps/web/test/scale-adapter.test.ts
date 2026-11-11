import { describe, expect, it } from 'vitest';
import {
  BridgeScaleAdapter,
  ScaleManager,
  ScaleReadError,
  SerialScaleAdapter,
  SimulatedScaleAdapter,
  convertScaleWeight,
  parseScaleSerialLine,
} from '../src/scale-adapter.js';

describe('@nexstock/web — UOM-06 Hardware-Independent Electronic Scale Adapter', () => {
  it('parses Web Serial weight frames including stable/unstable markers and units', () => {
    expect(parseScaleSerialLine('ST,GS,+  0.750kg')).toEqual({
      weight: 0.75,
      unit: 'KG',
      stable: true,
    });
    expect(parseScaleSerialLine('US,NT,  0.425 kg')).toEqual({
      weight: 0.425,
      unit: 'KG',
      stable: false,
    });
    expect(parseScaleSerialLine('S   750 g')).toEqual({
      weight: 750,
      unit: 'G',
      stable: true,
    });
    expect(parseScaleSerialLine('GARBAGE')).toBeNull();
  });

  it('rejects unstable readings, supports tare/zero offset, prevents duplicate capture, and converts units', async () => {
    const adapter = new SimulatedScaleAdapter();
    const manager = new ScaleManager();

    // Disconnected fallback
    await expect(manager.captureStableReading()).rejects.toMatchObject({
      code: 'SCALE_NOT_CONNECTED',
    });

    await manager.connect(adapter);

    // Reject unstable reading
    adapter.setSimulatedReading({ rawWeight: 0.75, unit: 'KG', stable: false, readingId: 'r1' });
    await expect(manager.captureStableReading()).rejects.toMatchObject({
      code: 'SCALE_UNSTABLE_READING',
    });

    // Container tare workflow (0.120 KG tray + 0.750 KG sugar = 0.870 KG gross -> 0.750 KG net = 750 G)
    adapter.setSimulatedReading({ rawWeight: 0.12, unit: 'KG', stable: true, readingId: 'r-tare' });
    await manager.tare();
    expect(manager.getSnapshot().tareOffset).toBe(0.12);

    adapter.setSimulatedReading({ rawWeight: 0.87, unit: 'KG', stable: true, readingId: 'r-sugar-1' });
    const captured = await manager.captureStableReading({ targetUnit: 'G' });
    expect(captured).toMatchObject({
      readingId: 'r-sugar-1',
      weight: 750,
      unit: 'G',
      netWeight: 0.75,
      rawWeight: 0.87,
      tareOffset: 0.12,
      entrySource: 'SCALE_WEIGHT',
      requiresConfirmation: true,
    });

    // Duplicate reading prevention for identical readingId
    await expect(manager.captureStableReading({ targetUnit: 'G' })).rejects.toMatchObject({
      code: 'SCALE_DUPLICATE_READING',
    });

    // Zero clears tare offset and allows subsequent capture
    await manager.zero();
    expect(manager.getSnapshot().tareOffset).toBe(0);
    adapter.setSimulatedReading({ rawWeight: 1.25, unit: 'KG', stable: true, readingId: 'r-sugar-2' });
    const second = await manager.captureStableReading({ targetUnit: 'KG' });
    expect(second.weight).toBe(1.25);

    // Disconnect cleanly restores disconnected fallback state
    await manager.disconnect();
    expect(manager.getSnapshot().status).toBe('DISCONNECTED');
  });

  it('supports Localhost / Tauri HTTP bridge adapter and Web Serial port adapter cleanly', async () => {
    const bridge = new BridgeScaleAdapter({
      baseUrl: 'http://127.0.0.1:18432',
      transport: 'TAURI_BRIDGE',
      fetchImpl: (async (url: RequestInfo | URL) => {
        const s = String(url);
        if (s.endsWith('/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (s.endsWith('/weight')) {
          return new Response(
            JSON.stringify({ readingId: 'b-100', weight: 2.5, unit: 'KG', stable: true }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    const manager = new ScaleManager();
    await manager.connect(bridge);
    const res = await manager.captureStableReading({ targetUnit: 'G' });
    expect(res.weight).toBe(2500);
    expect(res.entrySource).toBe('SCALE_WEIGHT');

    const encoder = new TextEncoder();
    let closed = false;
    const serial = new SerialScaleAdapter({
      requestPort: async () => ({
        async open() {},
        async close() {
          closed = true;
        },
        readable: {
          getReader() {
            let sent = false;
            return {
              async read() {
                if (!sent) {
                  sent = true;
                  return { value: encoder.encode('ST,GS,+  0.500kg\r\n'), done: false };
                }
                return { done: true };
              },
              releaseLock() {},
            };
          },
        },
      }),
    });

    await manager.connect(serial);
    const serialRes = await manager.captureStableReading({ targetUnit: 'G' });
    expect(serialRes.weight).toBe(500);
    await manager.disconnect();
    expect(closed).toBe(true);
    expect(convertScaleWeight(1.5, 'KG', 'G')).toBe(1500);
    expect(new ScaleReadError('SCALE_NOT_CONNECTED', 'Disconnected').code).toBe('SCALE_NOT_CONNECTED');
  });
});
