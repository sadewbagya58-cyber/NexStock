/**
 * @nexstock/ui — Shared Presentation Design Tokens & Pure UI View Helpers
 * Consumed by Next.js (apps/web) and Tauri Vite React SPA (apps/desktop) per UD-02.
 * Principle #3: Zero business rules or authorization logic are permitted in this package.
 */

export type SyncConnectionState =
  | 'ONLINE'
  | 'OFFLINE_BROWSER_BLOCKED'
  | 'OFFLINE_LOCAL_QUEUE_ACTIVE'
  | 'SYNCING_OUTBOX';

export interface StatusBannerDescriptor {
  readonly state: SyncConnectionState;
  readonly variant: 'success' | 'warning' | 'danger' | 'info';
  readonly label: string;
  readonly pendingOutboxCount: number;
}

export function createSyncStatusBannerDescriptor(params: {
  readonly isOnline: boolean;
  readonly clientPlatform: 'WEB_BROWSER' | 'TAURI_DESKTOP' | 'FLUTTER_MOBILE';
  readonly pendingOutboxCount: number;
  readonly isSyncInFlight: boolean;
}): StatusBannerDescriptor {
  if (!params.isOnline) {
    if (params.clientPlatform === 'WEB_BROWSER') {
      return {
        state: 'OFFLINE_BROWSER_BLOCKED',
        variant: 'danger',
        label:
          'Connection lost. Browser POS & Backoffice require an active connection. Use NexStock Desktop or Mobile for offline checkout.',
        pendingOutboxCount: 0,
      };
    }
    return {
      state: 'OFFLINE_LOCAL_QUEUE_ACTIVE',
      variant: 'warning',
      label: `Offline Mode Active — Transactions saved to local SQLite outbox (${params.pendingOutboxCount} pending).`,
      pendingOutboxCount: params.pendingOutboxCount,
    };
  }

  if (params.isSyncInFlight || params.pendingOutboxCount > 0) {
    return {
      state: 'SYNCING_OUTBOX',
      variant: 'info',
      label: `Synchronizing ${params.pendingOutboxCount} offline transaction(s)...`,
      pendingOutboxCount: params.pendingOutboxCount,
    };
  }

  return {
    state: 'ONLINE',
    variant: 'success',
    label: 'Connected & Synchronized',
    pendingOutboxCount: 0,
  };
}
