import {
  type StatusBannerDescriptor,
  createSyncStatusBannerDescriptor,
} from '@nexstock/ui';

/**
 * @nexstock/web — Online-First Browser Shell (UD-02 & UD-04).
 * Consumes @nexstock/ui and @nexstock/contracts. All business logic lives in @nexstock/api.
 */
export function getWebConnectionBanner(
  isOnline: boolean,
): StatusBannerDescriptor {
  return createSyncStatusBannerDescriptor({
    isOnline,
    clientPlatform: 'WEB_BROWSER',
    pendingOutboxCount: 0,
    isSyncInFlight: false,
  });
}
