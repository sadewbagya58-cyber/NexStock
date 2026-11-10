import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export type RealtimeEventType =
  | 'STOCK_CHANGED'
  | 'PRODUCT_CHANGED'
  | 'CATEGORY_CHANGED'
  | 'CREDIT_ACCOUNT_CHANGED'
  | 'SALE_COMPLETED'
  | 'HEARTBEAT';

export interface RealtimeEventPayload {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId?: string | null;
  readonly eventType: RealtimeEventType;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}

class RealtimeEventHub extends EventEmitter {
  private recentEvents: RealtimeEventPayload[] = [];
  private maxHistory = 300;

  public publish(
    event: Omit<RealtimeEventPayload, 'id' | 'timestamp'> & {
      id?: string;
      timestamp?: string;
    },
  ): RealtimeEventPayload {
    const fullEvent: RealtimeEventPayload = {
      id: event.id || crypto.randomUUID(),
      timestamp: event.timestamp || new Date().toISOString(),
      tenantId: event.tenantId,
      branchId: event.branchId ?? null,
      eventType: event.eventType,
      data: event.data,
    };

    this.recentEvents.push(fullEvent);
    if (this.recentEvents.length > this.maxHistory) {
      this.recentEvents.shift();
    }

    this.emit(`tenant:${event.tenantId}`, fullEvent);
    if (event.branchId) {
      this.emit(`tenant:${event.tenantId}:branch:${event.branchId}`, fullEvent);
    }
    this.emit('event', fullEvent);

    return fullEvent;
  }

  public getEventsSince(
    tenantId: string,
    sinceEpochMs: number,
    branchId?: string | null,
  ): RealtimeEventPayload[] {
    return this.recentEvents.filter((e) => {
      if (e.tenantId !== tenantId) return false;
      if (branchId && e.branchId && e.branchId !== branchId) return false;
      return new Date(e.timestamp).getTime() > sinceEpochMs;
    });
  }
}

export const realtimeEventHub = new RealtimeEventHub();
