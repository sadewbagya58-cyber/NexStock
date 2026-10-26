import { describe, expect, it } from 'vitest';
import { createSyncStatusBannerDescriptor } from '../src/index.js';

describe('@nexstock/ui — Presentation Status Descriptor (UD-02 & UD-04)', () => {
  it('blocks browser web client when offline while allowing Tauri desktop local outbox queue', () => {
    const webBanner = createSyncStatusBannerDescriptor({
      isOnline: false,
      clientPlatform: 'WEB_BROWSER',
      pendingOutboxCount: 0,
      isSyncInFlight: false,
    });
    expect(webBanner.state).toBe('OFFLINE_BROWSER_BLOCKED');
    expect(webBanner.variant).toBe('danger');

    const desktopBanner = createSyncStatusBannerDescriptor({
      isOnline: false,
      clientPlatform: 'TAURI_DESKTOP',
      pendingOutboxCount: 4,
      isSyncInFlight: false,
    });
    expect(desktopBanner.state).toBe('OFFLINE_LOCAL_QUEUE_ACTIVE');
    expect(desktopBanner.pendingOutboxCount).toBe(4);
  });
});
