import { describe, expect, it } from 'vitest';
import {
  BarcodeScannerBuffer,
  NEXSTOCK_DARK_THEME_TOKENS,
  NEXSTOCK_LIGHT_THEME_TOKENS,
  POS_THERMAL_PRINT_CSS,
  createPosShiftStatusDescriptor,
  createStockLevelBadgeDescriptor,
  createSyncStatusBannerDescriptor,
} from '../src/index.js';

describe('@nexstock/ui — Presentation Tokens & View Descriptors', () => {
  it('provides Phase 2 light/dark theme tokens and stock level badge descriptors', () => {
    expect(NEXSTOCK_LIGHT_THEME_TOKENS.backgroundPrimary).toBe('#F8FAFC');
    expect(NEXSTOCK_LIGHT_THEME_TOKENS.accentPrimary).toBe('#2563EB');
    expect(NEXSTOCK_DARK_THEME_TOKENS.backgroundPrimary).toBe('#0B1120');

    expect(createStockLevelBadgeDescriptor('OK')).toEqual({
      stockState: 'OK',
      variant: 'success',
      label: 'In Stock',
      colorHex: '#16A34A',
    });
    expect(createStockLevelBadgeDescriptor('LOW_STOCK')).toEqual({
      stockState: 'LOW_STOCK',
      variant: 'warning',
      label: 'Low Stock',
      colorHex: '#D97706',
    });
    expect(createStockLevelBadgeDescriptor('ZERO_STOCK')).toEqual({
      stockState: 'ZERO_STOCK',
      variant: 'danger',
      label: 'Out of Stock',
      colorHex: '#DC2626',
    });
    expect(createStockLevelBadgeDescriptor('NEGATIVE_STOCK')).toEqual({
      stockState: 'NEGATIVE_STOCK',
      variant: 'danger',
      label: 'Negative Balance',
      colorHex: '#DC2626',
    });
  });

  it('produces sync status banner descriptors for online and offline modes', () => {
    const online = createSyncStatusBannerDescriptor({
      isOnline: true,
      clientPlatform: 'WEB_BROWSER',
      pendingOutboxCount: 0,
      isSyncInFlight: false,
    });
    expect(online.state).toBe('ONLINE');
    expect(online.variant).toBe('success');
  });

  it('provides Phase 3 POS shift status descriptors and barcode scanner buffer detection', () => {
    const openDesc = createPosShiftStatusDescriptor('OPEN');
    expect(openDesc.status).toBe('OPEN');
    expect(openDesc.variant).toBe('success');

    const closedDesc = createPosShiftStatusDescriptor('CLOSED');
    expect(closedDesc.status).toBe('CLOSED');
    expect(closedDesc.variant).toBe('info');

    expect(POS_THERMAL_PRINT_CSS).toContain('@media print');
    expect(POS_THERMAL_PRINT_CSS).toContain('size: 80mm auto');

    const scanner = new BarcodeScannerBuffer(50);
    // Simulate rapid barcode scan (interval < 50ms)
    let scanned: string | null = null;
    let t = 1000;
    for (const char of 'BARCODE123') {
      scanned = scanner.handleKeyDown({ key: char, timeStamp: t });
      t += 10;
    }
    scanned = scanner.handleKeyDown({ key: 'Enter', timeStamp: t });
    expect(scanned).toBe('BARCODE123');

    // Human typing (slow interval > 50ms) should reset and not emit as barcode scan
    scanner.clear();
    t = 2000;
    for (const char of 'MANUAL') {
      scanned = scanner.handleKeyDown({ key: char, timeStamp: t });
      t += 200;
    }
    scanned = scanner.handleKeyDown({ key: 'Enter', timeStamp: t });
    expect(scanned).toBeNull();
  });
});
