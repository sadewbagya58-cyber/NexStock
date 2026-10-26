import { getCanonicalSqliteMigrations } from '@nexstock/sqlite-schema';
import {
  type StatusBannerDescriptor,
  createSyncStatusBannerDescriptor,
} from '@nexstock/ui';

/**
 * @nexstock/desktop — Offline-First Tauri + Vite React/TS SPA Shell (UD-02 & UD-04).
 */
export function getDesktopConnectionBanner(params: {
  readonly isOnline: boolean;
  readonly pendingOutboxCount: number;
  readonly isSyncInFlight: boolean;
}): StatusBannerDescriptor {
  return createSyncStatusBannerDescriptor({
    ...params,
    clientPlatform: 'TAURI_DESKTOP',
  });
}

export { getCanonicalSqliteMigrations };
