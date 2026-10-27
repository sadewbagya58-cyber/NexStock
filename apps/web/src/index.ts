import {
  type InventoryStockBadgeState,
  NEXSTOCK_DARK_THEME_TOKENS,
  NEXSTOCK_LIGHT_THEME_TOKENS,
  type StatusBannerDescriptor,
  type StockLevelBadgeDescriptor,
  type ThemePaletteTokens,
  createStockLevelBadgeDescriptor,
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

export interface BackofficeNavItem {
  readonly id:
    | 'products'
    | 'categories'
    | 'suppliers'
    | 'movements'
    | 'balances';
  readonly label: string;
  readonly href: string;
  readonly requiredPermission: string;
}

export const PHASE2_INVENTORY_NAV_ITEMS: readonly BackofficeNavItem[] = [
  {
    id: 'products',
    label: 'Products',
    href: '/inventory/products',
    requiredPermission: 'cat:product:read',
  },
  {
    id: 'categories',
    label: 'Categories',
    href: '/inventory/categories',
    requiredPermission: 'cat:category:read',
  },
  {
    id: 'suppliers',
    label: 'Suppliers',
    href: '/inventory/suppliers',
    requiredPermission: 'pur:supplier:read',
  },
  {
    id: 'movements',
    label: 'Stock Movements',
    href: '/inventory/movements',
    requiredPermission: 'inv:movement:read',
  },
  {
    id: 'balances',
    label: 'Inventory Balances',
    href: '/inventory/balances',
    requiredPermission: 'inv:balance:read',
  },
] as const;

export function getWebThemeTokens(mode: 'light' | 'dark'): ThemePaletteTokens {
  return mode === 'dark'
    ? NEXSTOCK_DARK_THEME_TOKENS
    : NEXSTOCK_LIGHT_THEME_TOKENS;
}

export function getWebInventoryBadge(
  stockState: InventoryStockBadgeState,
): StockLevelBadgeDescriptor {
  return createStockLevelBadgeDescriptor(stockState);
}

// ============================================================================
// PHASE 3: POS WEB APPLICATION SHELL HELPERS (UD-02)
// ============================================================================

export interface PosNavItem {
  readonly id: 'pos_checkout' | 'pos_registers' | 'pos_shifts' | 'pos_sales';
  readonly label: string;
  readonly href: string;
  readonly requiredPermission: string;
}

export const PHASE3_POS_NAV_ITEMS: readonly PosNavItem[] = [
  {
    id: 'pos_checkout',
    label: 'POS Checkout',
    href: '/pos/checkout',
    requiredPermission: 'pos:sale:create',
  },
  {
    id: 'pos_registers',
    label: 'Registers',
    href: '/pos/registers',
    requiredPermission: 'pos:register:read',
  },
  {
    id: 'pos_shifts',
    label: 'Cashier Shifts',
    href: '/pos/shifts',
    requiredPermission: 'pos:shift:open',
  },
  {
    id: 'pos_sales',
    label: 'Sales History',
    href: '/pos/sales',
    requiredPermission: 'pos:sale:read',
  },
] as const;

export {
  POS_THERMAL_PRINT_CSS,
  BarcodeScannerBuffer,
  createPosShiftStatusDescriptor,
} from '@nexstock/ui';
