export type ScaleTransport =
  | 'WEB_SERIAL'
  | 'LOCAL_BRIDGE'
  | 'TAURI_BRIDGE'
  | 'SIMULATED';

export type ScaleUnit = 'KG' | 'G' | 'LB';

export type ScaleConnectionStatus = 'DISCONNECTED' | 'CONNECTED' | 'ERROR';

export type ScaleErrorCode =
  | 'SCALE_NOT_CONNECTED'
  | 'SCALE_UNSTABLE_READING'
  | 'SCALE_DUPLICATE_READING'
  | 'SCALE_NON_POSITIVE_WEIGHT'
  | 'SCALE_READ_FAILED';

export class ScaleReadError extends Error {
  readonly code: ScaleErrorCode;

  constructor(code: ScaleErrorCode, message: string) {
    super(message);
    this.name = 'ScaleReadError';
    this.code = code;
  }
}

export interface ScaleReading {
  readonly readingId: string;
  readonly rawWeight: number;
  readonly unit: ScaleUnit;
  readonly stable: boolean;
  readonly capturedAtMs: number;
  readonly rawFrame?: string;
}

export interface ScaleDeviceAdapter {
  readonly name: string;
  readonly transport: ScaleTransport;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readWeight(): Promise<ScaleReading>;
  tare?(): Promise<void>;
  zero?(): Promise<void>;
}

export interface ParsedScaleFrame {
  readonly weight: number;
  readonly unit: ScaleUnit;
  readonly stable: boolean;
}

export function parseScaleSerialLine(frame: string): ParsedScaleFrame | null {
  const trimmed = String(frame ?? '').trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  const isUnstable =
    /\bUS\b/.test(upper) ||
    upper.startsWith('U,') ||
    upper.startsWith('U ') ||
    upper.includes('UNSTABLE') ||
    upper.includes('?');

  const match = upper.match(/([+-]?\s*\d+(?:\.\d+)?)\s*(KG|G|LB|LBS|GRM)?\b/);
  if (!match) return null;

  const numericStr = (match[1] ?? '').replace(/\s+/g, '');
  const weight = Number.parseFloat(numericStr);
  if (!Number.isFinite(weight)) return null;

  const rawUnit = match[2] ?? 'KG';
  const unit: ScaleUnit =
    rawUnit === 'G' || rawUnit === 'GRM'
      ? 'G'
      : rawUnit === 'LB' || rawUnit === 'LBS'
        ? 'LB'
        : 'KG';

  return {
    weight,
    unit,
    stable: !isUnstable,
  };
}

export function convertScaleWeight(
  value: number,
  fromUnit: ScaleUnit,
  toUnit: ScaleUnit,
): number {
  if (fromUnit === toUnit) return Number(value.toFixed(6));
  const kgFactor: Record<ScaleUnit, number> = {
    KG: 1,
    G: 0.001,
    LB: 0.45359237,
  };
  const inKg = value * kgFactor[fromUnit];
  const converted = inKg / kgFactor[toUnit];
  return Number(converted.toFixed(6));
}

export interface SerialPortLike {
  readable?: { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }>; releaseLock(): void } };
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export class SerialScaleAdapter implements ScaleDeviceAdapter {
  readonly name = 'Web Serial Electronic Scale';
  readonly transport = 'WEB_SERIAL' as const;
  private port: SerialPortLike | null = null;
  private seq = 0;

  constructor(
    private readonly options: {
      baudRate?: number;
      requestPort?: () => Promise<SerialPortLike>;
    } = {},
  ) {}

  async connect(): Promise<void> {
    if (this.port) return;
    const requester =
      this.options.requestPort ??
      (() => {
        const nav = (globalThis as { navigator?: { serial?: { requestPort(): Promise<SerialPortLike> } } })
          .navigator;
        if (!nav?.serial?.requestPort) {
          throw new ScaleReadError(
            'SCALE_NOT_CONNECTED',
            'Web Serial API is unavailable in this browser; switch to manual entry or Local Bridge.',
          );
        }
        return nav.serial.requestPort();
      });

    const port = await requester();
    await port.open({ baudRate: this.options.baudRate ?? 9600 });
    this.port = port;
  }

  async disconnect(): Promise<void> {
    if (!this.port) return;
    try {
      await this.port.close();
    } finally {
      this.port = null;
    }
  }

  async readWeight(): Promise<ScaleReading> {
    if (!this.port?.readable) {
      throw new ScaleReadError('SCALE_NOT_CONNECTED', 'Serial scale port is not connected.');
    }
    const reader = this.port.readable.getReader();
    const decoder = new TextDecoder();
    try {
      let buffer = '';
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          for (let i = lines.length - 1; i >= 0; i -= 1) {
            const parsed = parseScaleSerialLine(lines[i] ?? '');
            if (parsed) {
              this.seq += 1;
              return {
                readingId: `serial-${this.seq}`,
                rawWeight: parsed.weight,
                unit: parsed.unit,
                stable: parsed.stable,
                capturedAtMs: Date.now(),
                rawFrame: lines[i] ?? '',
              };
            }
          }
        }
      }
      throw new ScaleReadError('SCALE_READ_FAILED', 'No valid weight frame received from serial scale.');
    } finally {
      reader.releaseLock();
    }
  }
}

export class BridgeScaleAdapter implements ScaleDeviceAdapter {
  readonly name: string;
  readonly transport: 'LOCAL_BRIDGE' | 'TAURI_BRIDGE';
  private connected = false;
  private seq = 0;

  constructor(
    private readonly options: {
      baseUrl?: string;
      transport?: 'LOCAL_BRIDGE' | 'TAURI_BRIDGE';
      fetchImpl?: typeof fetch;
    } = {},
  ) {
    this.transport = options.transport ?? 'LOCAL_BRIDGE';
    this.name =
      this.transport === 'TAURI_BRIDGE'
        ? 'Desktop Tauri Scale Bridge'
        : 'Localhost / LAN Scale Bridge';
  }

  private get baseUrl(): string {
    return (this.options.baseUrl ?? 'http://127.0.0.1:18432').replace(/\/+$/, '');
  }

  private get fetcher(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  async connect(): Promise<void> {
    const res = await this.fetcher(`${this.baseUrl}/health`, { method: 'GET' });
    if (!res.ok) {
      throw new ScaleReadError('SCALE_NOT_CONNECTED', `Scale bridge health check failed (${res.status}).`);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async readWeight(): Promise<ScaleReading> {
    if (!this.connected) {
      throw new ScaleReadError('SCALE_NOT_CONNECTED', 'Scale bridge is disconnected.');
    }
    const res = await this.fetcher(`${this.baseUrl}/weight`, { method: 'GET' });
    if (!res.ok) {
      throw new ScaleReadError('SCALE_READ_FAILED', `Scale bridge returned HTTP ${res.status}.`);
    }
    const payload = (await res.json()) as {
      readingId?: string;
      weight?: number;
      unit?: ScaleUnit;
      stable?: boolean;
    };
    if (typeof payload.weight !== 'number' || !Number.isFinite(payload.weight)) {
      throw new ScaleReadError('SCALE_READ_FAILED', 'Invalid weight payload from scale bridge.');
    }
    this.seq += 1;
    return {
      readingId: payload.readingId ?? `bridge-${this.seq}`,
      rawWeight: payload.weight,
      unit: payload.unit ?? 'KG',
      stable: Boolean(payload.stable),
      capturedAtMs: Date.now(),
    };
  }

  async tare(): Promise<void> {
    await this.fetcher(`${this.baseUrl}/tare`, { method: 'POST' });
  }

  async zero(): Promise<void> {
    await this.fetcher(`${this.baseUrl}/zero`, { method: 'POST' });
  }
}

export class SimulatedScaleAdapter implements ScaleDeviceAdapter {
  readonly name = 'Virtual Bench Scale (Simulation)';
  readonly transport = 'SIMULATED' as const;
  private connected = false;
  private currentReading: ScaleReading = {
    readingId: 'sim-0',
    rawWeight: 0,
    unit: 'KG',
    stable: true,
    capturedAtMs: Date.now(),
  };

  setSimulatedReading(input: {
    rawWeight: number;
    unit?: ScaleUnit;
    stable?: boolean;
    readingId?: string;
  }): void {
    this.currentReading = {
      readingId: input.readingId ?? `sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      rawWeight: input.rawWeight,
      unit: input.unit ?? this.currentReading.unit,
      stable: input.stable ?? true,
      capturedAtMs: Date.now(),
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async readWeight(): Promise<ScaleReading> {
    if (!this.connected) {
      throw new ScaleReadError('SCALE_NOT_CONNECTED', 'Simulated scale is disconnected.');
    }
    return { ...this.currentReading };
  }

  async tare(): Promise<void> {
    if (!this.connected) {
      throw new ScaleReadError('SCALE_NOT_CONNECTED', 'Simulated scale is disconnected.');
    }
  }

  async zero(): Promise<void> {
    if (!this.connected) {
      throw new ScaleReadError('SCALE_NOT_CONNECTED', 'Simulated scale is disconnected.');
    }
    this.setSimulatedReading({
      rawWeight: 0,
      unit: this.currentReading.unit,
      stable: true,
    });
  }
}

export interface CapturedScaleWeightResult {
  readonly readingId: string;
  readonly weight: number;
  readonly unit: ScaleUnit;
  readonly netWeight: number;
  readonly rawWeight: number;
  readonly tareOffset: number;
  readonly entrySource: 'SCALE_WEIGHT';
  readonly requiresConfirmation: true;
}

export interface ScaleManagerSnapshot {
  readonly status: ScaleConnectionStatus;
  readonly adapterName: string | null;
  readonly transport: ScaleTransport | null;
  readonly rawWeight: number;
  readonly tareOffset: number;
  readonly netWeight: number;
  readonly unit: ScaleUnit;
  readonly isStable: boolean;
  readonly lastReadingId: string | null;
  readonly lastCapturedReadingId: string | null;
  readonly lastError: string | null;
}

export class ScaleManager {
  private adapter: ScaleDeviceAdapter | null = null;
  private status: ScaleConnectionStatus = 'DISCONNECTED';
  private rawWeight = 0;
  private tareOffset = 0;
  private unit: ScaleUnit = 'KG';
  private isStable = false;
  private lastReadingId: string | null = null;
  private lastCapturedReadingId: string | null = null;
  private lastError: string | null = null;

  async connect(adapter: ScaleDeviceAdapter): Promise<void> {
    await adapter.connect();
    this.adapter = adapter;
    this.status = 'CONNECTED';
    this.lastError = null;
  }

  async disconnect(): Promise<void> {
    if (this.adapter) {
      try {
        await this.adapter.disconnect();
      } finally {
        this.adapter = null;
      }
    }
    this.status = 'DISCONNECTED';
    this.isStable = false;
  }

  async refreshReading(): Promise<ScaleReading> {
    if (!this.adapter || this.status === 'DISCONNECTED') {
      throw new ScaleReadError(
        'SCALE_NOT_CONNECTED',
        'No electronic scale connected — enter weight manually.',
      );
    }
    try {
      const reading = await this.adapter.readWeight();
      this.rawWeight = reading.rawWeight;
      this.unit = reading.unit;
      this.isStable = reading.stable;
      this.lastReadingId = reading.readingId;
      this.status = 'CONNECTED';
      this.lastError = null;
      return reading;
    } catch (err) {
      const msg = (err as Error).message;
      this.status = 'ERROR';
      this.isStable = false;
      this.lastError = msg;
      throw err instanceof ScaleReadError
        ? err
        : new ScaleReadError('SCALE_READ_FAILED', msg);
    }
  }

  async tare(): Promise<void> {
    if (!this.adapter || this.status === 'DISCONNECTED') {
      throw new ScaleReadError('SCALE_NOT_CONNECTED', 'Connect a scale before setting tare.');
    }
    const reading = await this.refreshReading();
    this.tareOffset = reading.rawWeight;
    this.lastCapturedReadingId = null;
    if (typeof this.adapter.tare === 'function') {
      await this.adapter.tare();
    }
  }

  async zero(): Promise<void> {
    if (!this.adapter || this.status === 'DISCONNECTED') {
      throw new ScaleReadError('SCALE_NOT_CONNECTED', 'Connect a scale before zeroing.');
    }
    if (typeof this.adapter.zero === 'function') {
      await this.adapter.zero();
    }
    this.tareOffset = 0;
    this.rawWeight = 0;
    this.lastCapturedReadingId = null;
  }

  async captureStableReading(
    options: { targetUnit?: ScaleUnit; allowDuplicate?: boolean } = {},
  ): Promise<CapturedScaleWeightResult> {
    const reading = await this.refreshReading();

    if (!reading.stable) {
      throw new ScaleReadError(
        'SCALE_UNSTABLE_READING',
        'Scale reading is still settling (UNSTABLE). Wait for a STABLE reading or enter weight manually.',
      );
    }

    if (!options.allowDuplicate && this.lastCapturedReadingId === reading.readingId) {
      throw new ScaleReadError(
        'SCALE_DUPLICATE_READING',
        'Duplicate scale reading blocked — place the next item or clear tare before capturing again.',
      );
    }

    const netWeight = Number((reading.rawWeight - this.tareOffset).toFixed(6));
    if (netWeight <= 0) {
      throw new ScaleReadError(
        'SCALE_NON_POSITIVE_WEIGHT',
        'Net weight must be greater than zero after tare offset.',
      );
    }

    const targetUnit = options.targetUnit ?? reading.unit;
    const convertedWeight = convertScaleWeight(netWeight, reading.unit, targetUnit);
    this.lastCapturedReadingId = reading.readingId;

    return {
      readingId: reading.readingId,
      weight: convertedWeight,
      unit: targetUnit,
      netWeight,
      rawWeight: reading.rawWeight,
      tareOffset: this.tareOffset,
      entrySource: 'SCALE_WEIGHT',
      requiresConfirmation: true,
    };
  }

  getSnapshot(): ScaleManagerSnapshot {
    return {
      status: this.status,
      adapterName: this.adapter?.name ?? null,
      transport: this.adapter?.transport ?? null,
      rawWeight: this.rawWeight,
      tareOffset: this.tareOffset,
      netWeight: Number((this.rawWeight - this.tareOffset).toFixed(6)),
      unit: this.unit,
      isStable: this.isStable,
      lastReadingId: this.lastReadingId,
      lastCapturedReadingId: this.lastCapturedReadingId,
      lastError: this.lastError,
    };
  }
}
