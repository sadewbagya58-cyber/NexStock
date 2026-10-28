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
export const DEFAULT_LOCAL_API_URL = 'http://localhost:4000';
export const DEFAULT_PRODUCTION_API_URL = 'https://nexstock-vu5i.onrender.com';

/**
 * Resolves the backend API base URL based on runtime hostname or explicit override.
 * Preserves local development on localhost/127.0.0.1 (http://localhost:4000) while routing
 * production/staging environments to the deployed Fastify API on Render (https://nexstock-vu5i.onrender.com).
 */
export function resolveWebApiClientUrl(options?: {
  readonly hostname?: string | undefined;
  readonly customOverride?: string | undefined;
}): string {
  if (options?.customOverride && options.customOverride.trim() !== '') {
    return options.customOverride.trim();
  }
  const hostname = options?.hostname?.toLowerCase().trim() ?? '';
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === ''
  ) {
    return DEFAULT_LOCAL_API_URL;
  }
  return DEFAULT_PRODUCTION_API_URL;
}

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

// ============================================================================
// PHASE 5: AUTHENTICATION & BUSINESS FOUNDATION (UD-01 & UD-02)
// ============================================================================

export interface WebAuthState {
  readonly isAuthenticated: boolean;
  readonly token: string | null;
  readonly activeTenantId: string | null;
}

export function isSessionAuthenticated(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.trim().length > 0;
}
