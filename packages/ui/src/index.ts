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

/**
 * Phase 2 Enterprise Back-Office Theme Palette Tokens (Section 11)
 */
export interface ThemePaletteTokens {
  readonly mode: 'light' | 'dark';
  readonly backgroundPrimary: string;
  readonly surfaceCard: string;
  readonly borderSubtle: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly accentPrimary: string;
  readonly statusSuccess: string;
  readonly statusWarning: string;
  readonly statusDanger: string;
  readonly statusInfo: string;
}

export const NEXSTOCK_LIGHT_THEME_TOKENS: ThemePaletteTokens = {
  mode: 'light',
  backgroundPrimary: '#F8FAFC',
  surfaceCard: '#FFFFFF',
  borderSubtle: '#E2E8F0',
  textPrimary: '#0F172A',
  textSecondary: '#475569',
  accentPrimary: '#2563EB',
  statusSuccess: '#16A34A',
  statusWarning: '#D97706',
  statusDanger: '#DC2626',
  statusInfo: '#0284C7',
};

export const NEXSTOCK_DARK_THEME_TOKENS: ThemePaletteTokens = {
  mode: 'dark',
  backgroundPrimary: '#0B1120',
  surfaceCard: '#111827',
  borderSubtle: '#1E293B',
  textPrimary: '#F8FAFC',
  textSecondary: '#94A3B8',
  accentPrimary: '#3B82F6',
  statusSuccess: '#16A34A',
  statusWarning: '#D97706',
  statusDanger: '#DC2626',
  statusInfo: '#0284C7',
};

export type InventoryStockBadgeState =
  | 'OK'
  | 'LOW_STOCK'
  | 'ZERO_STOCK'
  | 'NEGATIVE_STOCK';

export interface StockLevelBadgeDescriptor {
  readonly stockState: InventoryStockBadgeState;
  readonly variant: 'success' | 'warning' | 'danger' | 'info';
  readonly label: string;
  readonly colorHex: string;
}

export function createStockLevelBadgeDescriptor(
  stockState: InventoryStockBadgeState,
): StockLevelBadgeDescriptor {
  switch (stockState) {
    case 'OK':
      return {
        stockState,
        variant: 'success',
        label: 'In Stock',
        colorHex: '#16A34A',
      };
    case 'LOW_STOCK':
      return {
        stockState,
        variant: 'warning',
        label: 'Low Stock',
        colorHex: '#D97706',
      };
    case 'ZERO_STOCK':
      return {
        stockState,
        variant: 'danger',
        label: 'Out of Stock',
        colorHex: '#DC2626',
      };
    case 'NEGATIVE_STOCK':
      return {
        stockState,
        variant: 'danger',
        label: 'Negative Balance',
        colorHex: '#DC2626',
      };
  }
}

// ============================================================================
// PHASE 3: POS PRESENTATION TOKENS & PURE VIEW HELPERS (UD-02)
// ============================================================================

/**
 * Standard CSS rules for 80mm and 58mm thermal receipt printing.
 * Injected into print dialogs or applied via `@media print`.
 */
export const POS_THERMAL_PRINT_CSS = `
@media print {
  @page {
    margin: 0;
    size: 80mm auto;
  }
  body {
    margin: 0;
    padding: 8px;
    font-family: 'Courier New', Courier, monospace;
    font-size: 12px;
    line-height: 1.25;
    color: #000;
    background: #fff;
  }
  .receipt-header {
    text-align: center;
    border-bottom: 1px dashed #000;
    padding-bottom: 8px;
    margin-bottom: 8px;
  }
  .receipt-title {
    font-size: 16px;
    font-weight: bold;
    text-transform: uppercase;
  }
  .receipt-meta {
    font-size: 11px;
    margin-top: 4px;
  }
  .receipt-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 8px;
  }
  .receipt-table th {
    border-bottom: 1px dashed #000;
    text-align: left;
    font-size: 11px;
    padding: 2px 0;
  }
  .receipt-table td {
    padding: 3px 0;
    vertical-align: top;
  }
  .receipt-table .num-col {
    text-align: right;
  }
  .receipt-totals {
    border-top: 1px dashed #000;
    padding-top: 4px;
    margin-bottom: 8px;
  }
  .receipt-row {
    display: flex;
    justify-content: space-between;
    padding: 2px 0;
  }
  .receipt-grand-total {
    font-weight: bold;
    font-size: 14px;
    border-top: 1px solid #000;
    border-bottom: 1px solid #000;
    padding: 4px 0;
    margin: 4px 0;
  }
  .receipt-footer {
    text-align: center;
    border-top: 1px dashed #000;
    padding-top: 8px;
    font-size: 11px;
  }
  .no-print {
    display: none !important;
  }
}
`;

export interface PosShiftBadgeDescriptor {
  readonly status: 'OPEN' | 'CLOSED';
  readonly variant: 'success' | 'info';
  readonly label: string;
  readonly colorHex: string;
}

export function createPosShiftStatusDescriptor(
  status: 'OPEN' | 'CLOSED',
): PosShiftBadgeDescriptor {
  if (status === 'OPEN') {
    return {
      status,
      variant: 'success',
      label: 'Shift Open',
      colorHex: '#16A34A',
    };
  }
  return {
    status,
    variant: 'info',
    label: 'Shift Closed',
    colorHex: '#64748B',
  };
}

export interface PosCartLineItemSummary {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly quantityStr: string;
  readonly unitPriceStr: string;
  readonly lineDiscountStr: string;
  readonly lineTotalStr: string;
}

export interface PosCartViewSummary {
  readonly itemCount: number;
  readonly totalUnits: string;
  readonly subtotal: string;
  readonly totalDiscount: string;
  readonly grandTotal: string;
}

/**
 * Pure keyboard-emulating USB barcode scanner detector.
 * Scanners emit characters with short inter-keystroke delays (< 50ms)
 * ending with an Enter key.
 */
export class BarcodeScannerBuffer {
  private buffer: string = '';
  private lastKeystrokeTime: number = 0;
  private readonly maxIntervalMs: number;

  constructor(maxIntervalMs = 50) {
    this.maxIntervalMs = maxIntervalMs;
  }

  handleKeyDown(event: { key: string; timeStamp?: number }): string | null {
    const now = event.timeStamp ?? Date.now();
    const interval = now - this.lastKeystrokeTime;
    this.lastKeystrokeTime = now;

    if (interval > this.maxIntervalMs) {
      // Human typing gap -> clear buffer
      this.buffer = '';
    }

    if (event.key === 'Enter') {
      if (this.buffer.length >= 3) {
        const barcode = this.buffer.trim();
        this.buffer = '';
        return barcode;
      }
      this.buffer = '';
      return null;
    }

    if (event.key.length === 1) {
      this.buffer += event.key;
    }

    return null;
  }

  clear(): void {
    this.buffer = '';
  }
}
