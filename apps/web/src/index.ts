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

export const AUTH_VIEW_IDS = [
  'welcome',
  'login',
  'signup',
  'forgot-password',
  'onboard-business',
  'tenant-select',
] as const;

export type AuthViewId = (typeof AUTH_VIEW_IDS)[number];

export const ALL_SPA_VIEW_IDS = [
  ...AUTH_VIEW_IDS,
  'dashboard',
  'products',
  'categories',
  'suppliers',
  'movements',
  'balances',
  'batches',
  'serials',
  'valuation',
  'stocktakes',
  'pos-checkout',
  'pos-registers',
  'pos-shifts',
  'pos-sales',
  'org-settings',
] as const;

export type SpaViewId = (typeof ALL_SPA_VIEW_IDS)[number];

export function isSessionAuthenticated(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.trim().length > 0;
}

/**
 * Safely escapes HTML special characters to prevent XSS during dynamic DOM interpolation.
 */
export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  USD: 2,
  LKR: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  AED: 2,
  SGD: 2,
  AUD: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
};

export function getCurrencyMinorUnits(currencyCode: string): number {
  const code = (currencyCode || '').trim().toUpperCase();
  return CURRENCY_MINOR_UNITS[code] ?? 2;
}

/**
 * Safely formats monetary amounts with proper minor unit decimals and currency code.
 */
export function formatCurrency(
  amount: number | string | null | undefined,
  currencyCode = 'USD',
): string {
  const code = (currencyCode || 'USD').trim().toUpperCase();
  const numeric = typeof amount === 'number' ? amount : parseFloat(String(amount ?? '0'));
  const safe = Number.isFinite(numeric) ? numeric : 0;
  const decimals = getCurrencyMinorUnits(code);
  return `${code} ${safe.toFixed(decimals)}`;
}

/**
 * Construct safe query string parameter, omitting empty/whitespace values.
 */
export function buildSafeQueryParam(
  key: string,
  value: string | null | undefined,
  prefix = '&',
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return '';
  }
  return `${prefix}${encodeURIComponent(key)}=${encodeURIComponent(value.trim())}`;
}

/**
 * Safely formats register last invoice sequence string, avoiding TypeError on undefined or null.
 */
export function formatInvoiceSequence(
  code: string,
  seq: number | string | null | undefined,
): string {
  if (seq === null || seq === undefined || String(seq).trim() === '') {
    return '—';
  }
  const numeric = parseInt(String(seq), 10);
  const formattedSeq = Number.isNaN(numeric)
    ? String(seq)
    : numeric.toString().padStart(6, '0');
  return `${code}-${formattedSeq}`;
}

/**
 * Sanitizes and normalizes API base URL, eliminating trailing slashes, blank strings,
 * or corrupted values.
 */
export function sanitizeApiBaseUrl(
  rawUrl: string | null | undefined,
  fallbackUrl: string = DEFAULT_PRODUCTION_API_URL,
): string {
  if (typeof rawUrl !== 'string') return fallbackUrl;
  const trimmed = rawUrl.trim();
  if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') {
    return fallbackUrl;
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Resolves media URLs (e.g., product images) against the API base URL.
 * Prevents 404s when loading relative paths like '/v1/media/...' from frontend origin (BUG-019).
 */
export function resolveMediaUrl(
  imageUrl: string | null | undefined,
  apiBaseUrl: string = DEFAULT_PRODUCTION_API_URL,
): string | null {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  const trimmed = imageUrl.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed) || /^blob:/i.test(trimmed)) {
    return trimmed;
  }
  const cleanBase = apiBaseUrl.replace(/\/+$/, '');
  const cleanPath = trimmed.replace(/^\/+/, '');
  return `${cleanBase}/${cleanPath}`;
}

/**
 * Normalizes an API route endpoint to ensure a single leading slash and no double slashes.
 */
export function normalizeApiEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return '/';
  const leading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return leading.replace(/^\/+/, '/');
}
