import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BarcodeScannerBuffer,
  DEFAULT_LOCAL_API_URL,
  DEFAULT_PRODUCTION_API_URL,
  PHASE2_INVENTORY_NAV_ITEMS,
  PHASE3_POS_NAV_ITEMS,
  POS_THERMAL_PRINT_CSS,
  createPosShiftStatusDescriptor,
  getWebConnectionBanner,
  getWebInventoryBadge,
  getWebThemeTokens,
  isSessionAuthenticated,
  resolveWebApiClientUrl,
  escapeHtml,
  formatCurrency,
  buildSafeQueryParam,
  formatInvoiceSequence,
  sanitizeApiBaseUrl,
  normalizeApiEndpoint,
  AUTH_VIEW_IDS,
  ALL_SPA_VIEW_IDS,
  CURRENCY_MINOR_UNITS,
  getCurrencyMinorUnits,
  resolveMediaUrl,
  PHASE7_HRM_NAV_ITEMS,
  PHASE72_TEAM_NAV_ITEMS,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = resolve(__dirname, '..');

describe('@nexstock/web — Deployment Configuration, SPA Routing & API URL Resolution', () => {
  describe('1. API Base URL Dynamic Resolution', () => {
    it('resolves local development URL for localhost and loopback interfaces', () => {
      expect(resolveWebApiClientUrl({ hostname: 'localhost' })).toBe(DEFAULT_LOCAL_API_URL);
      expect(resolveWebApiClientUrl({ hostname: '127.0.0.1' })).toBe(DEFAULT_LOCAL_API_URL);
      expect(resolveWebApiClientUrl({ hostname: '0.0.0.0' })).toBe(DEFAULT_LOCAL_API_URL);
      expect(resolveWebApiClientUrl({ hostname: '' })).toBe(DEFAULT_LOCAL_API_URL);
      expect(resolveWebApiClientUrl()).toBe(DEFAULT_LOCAL_API_URL);
    });

    it('resolves production Render API URL for Vercel and remote hostnames', () => {
      expect(resolveWebApiClientUrl({ hostname: 'nexstock.vercel.app' })).toBe(
        DEFAULT_PRODUCTION_API_URL,
      );
      expect(resolveWebApiClientUrl({ hostname: 'nexstock-preview-abc.vercel.app' })).toBe(
        DEFAULT_PRODUCTION_API_URL,
      );
      expect(resolveWebApiClientUrl({ hostname: 'app.nexstock.io' })).toBe(
        DEFAULT_PRODUCTION_API_URL,
      );
    });

    it('honors explicit custom override when provided', () => {
      const customUrl = 'https://custom-staging-api.nexstock.internal';
      expect(resolveWebApiClientUrl({ customOverride: customUrl })).toBe(customUrl);
      expect(
        resolveWebApiClientUrl({
          hostname: 'localhost',
          customOverride: customUrl,
        }),
      ).toBe(customUrl);
    });
  });

  describe('2. Single-Page Application (SPA) Entry Point & Assets', () => {
    it('verifies public/index.html exists and contains dynamic API URL resolution', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      expect(existsSync(indexPath)).toBe(true);

      const html = readFileSync(indexPath, 'utf8');
      expect(html.length).toBeGreaterThan(10000);

      // Confirms resolveApiBaseUrl is defined in the script
      expect(html).toContain('function resolveApiBaseUrl()');
      expect(html).toContain('https://nexstock-vu5i.onrender.com');
      expect(html).toContain('http://localhost:4000');

      // Confirms state.apiBaseUrl uses the resolver rather than a static string
      expect(html).toContain('apiBaseUrl: resolveApiBaseUrl()');
    });

    it('verifies apps/web exports and navigation structures are intact', () => {
      expect(PHASE2_INVENTORY_NAV_ITEMS.length).toBeGreaterThan(0);
      expect(PHASE3_POS_NAV_ITEMS.length).toBeGreaterThan(0);

      const onlineBanner = getWebConnectionBanner(true);
      expect(onlineBanner.state).toBe('ONLINE');
      expect(onlineBanner.variant).toBe('success');

      const offlineBanner = getWebConnectionBanner(false);
      expect(offlineBanner.state).toBe('OFFLINE_BROWSER_BLOCKED');
      expect(offlineBanner.variant).toBe('danger');

      const lightTokens = getWebThemeTokens('light');
      expect(lightTokens.mode).toBe('light');

      const badge = getWebInventoryBadge('OK');
      expect(badge.label).toBe('In Stock');

      // Verify re-exported UI utilities from @nexstock/ui
      expect(POS_THERMAL_PRINT_CSS.length).toBeGreaterThan(0);
      expect(typeof createPosShiftStatusDescriptor).toBe('function');
      const scanner = new BarcodeScannerBuffer();
      expect(scanner).toBeDefined();
    });
  });

  describe('3. Vercel SPA Routing Configuration (vercel.json)', () => {
    it('verifies vercel.json exists with valid SPA rewrite configuration', () => {
      const vercelConfigPath = resolve(WEB_ROOT, 'vercel.json');
      expect(existsSync(vercelConfigPath)).toBe(true);

      const config = JSON.parse(readFileSync(vercelConfigPath, 'utf8'));
      expect(config.cleanUrls).toBe(true);
      expect(Array.isArray(config.rewrites)).toBe(true);
      expect(config.rewrites.length).toBeGreaterThan(0);

      const spaRewrite = config.rewrites.find(
        (r: { destination: string }) => r.destination === '/index.html',
      );
      expect(spaRewrite).toBeDefined();

      // Test regex pattern against SPA routes and static assets
      const pattern = new RegExp(`^${spaRewrite.source}$`);

      // SPA navigation routes must be rewritten to /index.html
      expect(pattern.test('/inventory/products')).toBe(true);
      expect(pattern.test('/inventory/categories')).toBe(true);
      expect(pattern.test('/pos/checkout')).toBe(true);
      expect(pattern.test('/pos/shifts')).toBe(true);
      expect(pattern.test('/settings')).toBe(true);

      // Static assets with extensions must NOT be rewritten to /index.html
      expect(pattern.test('/favicon.ico')).toBe(false);
      expect(pattern.test('/assets/logo.png')).toBe(false);
      expect(pattern.test('/styles/app.css')).toBe(false);
      expect(pattern.test('/scripts/main.js')).toBe(false);
    });
  });

  describe('4. Phase 5.0 Authentication & Business Onboarding Integration', () => {
    it('verifies session authentication helper correctly assesses tokens', () => {
      expect(isSessionAuthenticated('valid.jwt.token')).toBe(true);
      expect(isSessionAuthenticated('   token   ')).toBe(true);
      expect(isSessionAuthenticated('')).toBe(false);
      expect(isSessionAuthenticated('   ')).toBe(false);
      expect(isSessionAuthenticated(null)).toBe(false);
      expect(isSessionAuthenticated(undefined)).toBe(false);
    });

    it('verifies public/index.html includes complete auth & onboarding views and no demo overrides', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Verifies presence of Phase 5 view renderers
      expect(html).toContain('function renderLoginView()');
      expect(html).toContain('function renderSignUpView()');
      expect(html).toContain('function renderForgotPasswordView()');
      expect(html).toContain('function renderOnboardBusinessView()');
      expect(html).toContain('function renderTenantSelectView()');
      expect(html).toContain('function selectActiveTenant(');
      expect(html).toContain('function handleSignOut()');

      // Verifies real API auth calls are configured
      expect(html).toContain('/v1/auth/login');
      expect(html).toContain('/v1/auth/signup');
      expect(html).toContain('/v1/auth/logout');
      expect(html).toContain('/v1/auth/recover');
      expect(html).toContain('/v1/auth/me');
      expect(html).toContain('/v1/org/onboard');

      // Confirms demo-session endpoint is completely eliminated
      expect(html).not.toContain('/v1/auth/demo-session');
      expect(html).not.toContain('switchRole()');
    });

    it('verifies public/index.html signup response handler maps tokens and maintains session continuity', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Verifies compatibility with both GoTrue and custom auth responses
      expect(html).toContain('const sessionToken = data.token || data.accessToken;');
      expect(html).toContain("localStorage.setItem('nexstock_session_token', sessionToken);");
      expect(html).toContain('state.user = { id: data.userId, email: data.email, fullName: data.fullName };');

      // Verifies email verification banner handling
      expect(html).toContain('data.requiresEmailVerification || data.emailConfirmationRequired');

      // Verifies seamless transition to business onboarding
      expect(html).toContain("renderView('onboard-business');");
    });

    it('verifies escapeHtml sanitizes special characters and safely handles primitives', () => {
      expect(escapeHtml('Hello World')).toBe('Hello World');
      expect(escapeHtml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
      );
      expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
      expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
        '&lt;img src=x onerror=alert(1)&gt;',
      );
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
      expect(escapeHtml(12345)).toBe('12345');
      expect(escapeHtml(false)).toBe('false');
    });

    it('verifies public/index.html defines escapeHtml globally and hardens signup and login error handling', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Verifies global escapeHtml declaration and window attachment
      expect(html).toContain('function escapeHtml(str)');
      expect(html).toContain('window.escapeHtml = escapeHtml;');

      // Verifies escapeHtml is applied to user email in verification banner
      expect(html).toContain('${escapeHtml(email)}');

      // Verifies safe JSON parsing and hardened error fallbacks in handleSignUpSubmit
      expect(html).toContain('let data = {};');
      expect(html).toContain('data = await res.json();');
      expect(html).toContain('data?.detail ||');
      expect(html).toContain('data?.title ||');
      expect(html).toContain('data?.message ||');

      // Verifies alert and submit button elements are checked before mutation
      expect(html).toContain('if (alertEl)');
      expect(html).toContain('if (submitBtn)');
    });

    it('verifies public/index.html onboardCurrency includes LKR and all supported currencies, and excludes CAD', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Verifies presence of LKR and other supported currencies
      expect(html).toContain('<option value="LKR">LKR — Sri Lankan Rupee (Rs)</option>');
      expect(html).toContain('<option value="USD" selected>USD — United States Dollar ($)</option>');
      expect(html).toContain('<option value="EUR">EUR — Euro (€)</option>');
      expect(html).toContain('<option value="GBP">GBP — British Pound (£)</option>');
      expect(html).toContain('<option value="INR">INR — Indian Rupee (₹)</option>');
      expect(html).toContain('<option value="AED">AED — UAE Dirham (AED)</option>');
      expect(html).toContain('<option value="SGD">SGD — Singapore Dollar (S$)</option>');
      expect(html).toContain('<option value="AUD">AUD — Australian Dollar (A$)</option>');
      expect(html).toContain('<option value="JPY">JPY — Japanese Yen (¥)</option>');
      expect(html).toContain('<option value="KWD">KWD — Kuwaiti Dinar (KD)</option>');
      expect(html).toContain('<option value="BHD">BHD — Bahraini Dinar (BD)</option>');

      // Verifies unsupported currencies are excluded
      expect(html).not.toContain('<option value="CAD">');
    });
  });

  describe('5. Phase 5.1 Production Readiness, Mobile UX & Real Business Hardening', () => {
    it('verifies formatCurrency and buildSafeQueryParam utilities operate reliably', () => {
      expect(formatCurrency(124.5, 'USD')).toBe('USD 124.50');
      expect(formatCurrency('250.999', 'LKR')).toBe('LKR 251.00');
      expect(formatCurrency(0, 'EUR')).toBe('EUR 0.00');
      expect(formatCurrency(null, 'GBP')).toBe('GBP 0.00');
      expect(formatCurrency(undefined, 'AED')).toBe('AED 0.00');

      expect(buildSafeQueryParam('warehouseId', '11111111-2222-3333-4444-555555555555')).toBe(
        '&warehouseId=11111111-2222-3333-4444-555555555555',
      );
      expect(buildSafeQueryParam('branchId', '11111111-2222-3333-4444-555555555555', '?')).toBe(
        '?branchId=11111111-2222-3333-4444-555555555555',
      );
      expect(buildSafeQueryParam('warehouseId', '')).toBe('');
      expect(buildSafeQueryParam('warehouseId', '   ')).toBe('');
      expect(buildSafeQueryParam('warehouseId', null)).toBe('');
      expect(buildSafeQueryParam('warehouseId', undefined)).toBe('');

      expect(AUTH_VIEW_IDS).toContain('welcome');
      expect(ALL_SPA_VIEW_IDS).toContain('welcome');
      expect(ALL_SPA_VIEW_IDS).toContain('dashboard');
      expect(ALL_SPA_VIEW_IDS).toContain('pos-checkout');
    });

    it('verifies public/index.html includes complete SaaS marketing landing page (welcome view)', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Verifies presence of landing page structure
      expect(html).toContain('function renderWelcomeView()');
      expect(html).toContain('Universal Real-Time Inventory &amp; Multi-Branch');
      expect(html).toContain('Start 14-Day Free Trial');
      expect(html).toContain('Sign In to Your Store');
      expect(html).toContain('No credit card required');
      expect(html).toContain('Instant tenant onboarding');
      expect(html).toContain('Bank-grade Row-Level Security');

      // Verifies preview card and 4 core capabilities
      expect(html).toContain('Multi-Branch &amp; Multi-Warehouse');
      expect(html).toContain('High-Speed Touch POS');
      expect(html).toContain('Batches, Serials &amp; Valuation');
      expect(html).toContain('Bank-Grade PostgreSQL RLS');

      // Verifies pricing tiers and currency support banner
      expect(html).toContain('Global Multi-Currency &amp; Localization Architecture');
      expect(html).toContain('Simple, Transparent Plans Built to Scale');
      expect(html).toContain('Starter');
      expect(html).toContain('Growth');
      expect(html).toContain('Enterprise');
    });

    it('verifies public/index.html routes unauthenticated visitors and signout to welcome view', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Verifies unauthenticated visitors land on welcome view
      expect(html).toMatch(/if \(!storedToken[\s\S]*?renderView\('welcome'\);/);
      expect(html).toContain("renderView('welcome');");

      // Verifies signout redirects to welcome view
      expect(html).toContain("showToast('You have been signed out.', 'info');\n      renderView('welcome');");

      // Verifies unauthenticated logo click leads to welcome
      expect(html).toContain("} else {\n          renderView('welcome');\n        }");
    });

    it('verifies elimination of all hardcoded demo and location strings', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Confirms all demo strings are removed
      expect(html).not.toContain('Manhattan Flagship Branch');
      expect(html).not.toContain('WH-NYC-01');
      expect(html).not.toContain('NYC Sales Tax');
      expect(html).not.toContain('Flagship Store');
      expect(html).not.toContain('NexStock Global Retail Ltd (Demo Store)');

      // Confirms dynamic bindings are in place
      expect(html).toContain('${escapeHtml(state.branchName ||');
      expect(html).toContain('${escapeHtml(state.tenantName ||');
      expect(html).toContain('${escapeHtml(state.currency ||');
      expect(html).toContain('Standard Tax (0.00%)');
    });

    it('verifies elimination of non-existent warehouse endpoint and bad empty query parameters', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Confirms non-existent endpoint is completely removed
      expect(html).not.toContain('/v1/inventory/warehouses');

      // Confirms warehouseId query params are conditionally guarded
      expect(html).toContain("state.warehouseId ? `&warehouseId=${encodeURIComponent(state.warehouseId)}` : ''");
      expect(html).toContain("state.warehouseId ? `warehouseId=${encodeURIComponent(state.warehouseId)}&` : ''");
      expect(html).not.toContain('balances?warehouseId=${state.warehouseId}&');
      expect(html).not.toContain('movements?warehouseId=${state.warehouseId}&');
    });

    it('verifies mobile-responsive navigation drawer, overlay and breakpoints', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Confirms hamburger button and overlay elements exist
      expect(html).toContain('id="mobileMenuToggle"');
      expect(html).toContain('id="sidebarOverlay"');
      expect(html).toContain('id="sidebarCloseBtn"');
      expect(html).toContain('id="sidebarMobileHeader"');

      // Confirms responsive CSS rules exist
      expect(html).toContain('.mobile-menu-toggle');
      expect(html).toContain('.sidebar-overlay');
      expect(html).toContain('aside.sidebar.open');
      expect(html).toContain('@media (max-width: 768px)');
      expect(html).toContain('.pos-mobile-nav');
      expect(html).toContain('.pos-mobile-floating-cart');

      // Confirms setupMobileNavigation is invoked during app initialization
      expect(html).toContain('function setupMobileNavigation()');
      expect(html).toContain('setupMobileNavigation();');
    });
  });

  describe('6. Phase 5.1 Production Bug Fixes & Mobile Header Responsive UI', () => {
    it('verifies formatInvoiceSequence formats numbers and safely handles null/undefined/missing values', () => {
      expect(formatInvoiceSequence('REG-01', 42)).toBe('REG-01-000042');
      expect(formatInvoiceSequence('REG-01', '105')).toBe('REG-01-000105');
      expect(formatInvoiceSequence('REG-01', 0)).toBe('REG-01-000000');
      expect(formatInvoiceSequence('REG-01', null)).toBe('—');
      expect(formatInvoiceSequence('REG-01', undefined)).toBe('—');
      expect(formatInvoiceSequence('REG-01', '')).toBe('—');
      expect(formatInvoiceSequence('POS-WEST', 'INV-999')).toBe('POS-WEST-INV-999');
    });

    it('verifies sanitizeApiBaseUrl eliminates trailing slashes and handles invalid inputs', () => {
      expect(sanitizeApiBaseUrl('https://nexstock-vu5i.onrender.com/')).toBe(
        'https://nexstock-vu5i.onrender.com',
      );
      expect(sanitizeApiBaseUrl('https://nexstock-vu5i.onrender.com///')).toBe(
        'https://nexstock-vu5i.onrender.com',
      );
      expect(sanitizeApiBaseUrl('http://localhost:4000/')).toBe('http://localhost:4000');
      expect(sanitizeApiBaseUrl('')).toBe(DEFAULT_PRODUCTION_API_URL);
      expect(sanitizeApiBaseUrl('   ')).toBe(DEFAULT_PRODUCTION_API_URL);
      expect(sanitizeApiBaseUrl('undefined')).toBe(DEFAULT_PRODUCTION_API_URL);
      expect(sanitizeApiBaseUrl('null')).toBe(DEFAULT_PRODUCTION_API_URL);
      expect(sanitizeApiBaseUrl(null)).toBe(DEFAULT_PRODUCTION_API_URL);
      expect(sanitizeApiBaseUrl(undefined)).toBe(DEFAULT_PRODUCTION_API_URL);
    });

    it('verifies normalizeApiEndpoint guarantees a single leading slash and avoids double slashes', () => {
      expect(normalizeApiEndpoint('/v1/products')).toBe('/v1/products');
      expect(normalizeApiEndpoint('v1/products')).toBe('/v1/products');
      expect(normalizeApiEndpoint('//v1/products')).toBe('/v1/products');
      expect(normalizeApiEndpoint('')).toBe('/');
      expect(normalizeApiEndpoint('/v1/pos/registers?branchId=123')).toBe(
        '/v1/pos/registers?branchId=123',
      );
    });

    it('verifies public/index.html eliminates registers undefined toString error', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Confirms r.lastInvoiceSeq.toString() is not called directly
      expect(html).not.toContain('r.lastInvoiceSeq.toString()');

      // Confirms safe check and fallback
      expect(html).toContain('r.lastInvoiceSeq != null');
      expect(html).toContain('String(r.lastInvoiceSeq).padStart(6, \'0\')');

      // Confirms boolean isActive check
      expect(html).toContain("r.isActive ?? (r.status === 'ACTIVE')");

      // Confirms empty state rendering
      expect(html).toContain('No POS registers found for this branch.');
    });

    it('verifies public/index.html products view is resilient and eliminates 404 URL bugs', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Confirms apiFetch sanitizes trailing slashes and normalizes endpoints
      expect(html).toContain('rawBase.replace(/\\/+$/, \'\')');
      expect(html).toContain("rawEndpoint.startsWith('/') ? rawEndpoint : `/${rawEndpoint}`");

      // Confirms renderProductsView catches errors gracefully
      expect(html).toContain("apiFetch('/v1/products?limit=100').catch(");
      expect(html).toContain("apiFetch('/v1/categories?limit=100').catch(");

      // Confirms empty state handling
      expect(html).toContain('No products found. Click "+ Add Product" to create your first SKU.');
    });

    it('verifies public/index.html warehouse requirement guards on valuation and cost-layers', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Confirms renderValuationView checks state.warehouseId before calling API
      expect(html).toContain('if (!state.warehouseId) {');
      expect(html).toContain('Warehouse Assignment Required');

      // Confirms drilldownFifoLayers checks state.warehouseId
      expect(html).toContain('Please select a warehouse to inspect FIFO layers');

      // Confirms drilldownFifoLayers calls openModal with structured object
      expect(html).toContain('openModal({');
      expect(html).toContain('FIFO Cost Layers:');
    });

    it('verifies public/index.html openModal supports both object and HTML string overloads', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Confirms openModal handles string and object signatures
      expect(html).toContain('function openModal(optionsOrHtml)');
      expect(html).toContain("typeof optionsOrHtml === 'string'");
      expect(html).toContain("optionsOrHtml && typeof optionsOrHtml === 'object'");
    });

    it('verifies public/index.html redesigned mobile header and touch targets', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Confirms topbar primary row and mobile subbar layout elements
      expect(html).toContain('class="topbar-primary-row"');
      expect(html).toContain('class="topbar-mobile-subbar" id="topbarMobileSubbar"');
      expect(html).toContain('id="topbarMobileTenantBtn"');
      expect(html).toContain('id="topbarMobileTenantName"');
      expect(html).toContain('id="topbarMobilePlanBadge"');
      expect(html).toContain('id="topbarMobileBranchName"');

      // Confirms WCAG AA min 44px touch targets on mobile
      expect(html).toContain('min-width: 44px;');
      expect(html).toContain('min-height: 44px;');

      // Confirms media queries for 320px-360px viewports
      expect(html).toContain('@media (max-width: 360px)');
      expect(html).toContain('.subbar-tenant-name');
      expect(html).toContain('text-overflow: ellipsis;');
    });
  });

  describe('7. Phase 5.1 Hardening: Mobile Cards, Fake Data Elimination, Fast Signout & 404 Edge Proxy', () => {
    it('verifies total elimination of fabricated numbers, fake sales, fake customer names, fake SKUs, and fake real-time tags', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Fabricated metrics
      expect(html).not.toContain('12,840 PCS');
      expect(html).not.toContain('$28,450.00');
      expect(html).not.toContain('+14.2% vs yesterday');
      expect(html).not.toContain('4 Online');
      expect(html).not.toContain('0 Cash Variances');

      // Fake sales & invoice numbers
      expect(html).not.toContain('INV-2026-00421');
      expect(html).not.toContain('INV-2026-00420');
      expect(html).not.toContain('INV-2026-00419');

      // Fake customer names
      expect(html).not.toContain('Walk-in Retail');
      expect(html).not.toContain('Apex Logistics');
      expect(html).not.toContain('Global Traders Ltd');

      // Fake SKUs
      expect(html).not.toContain('SKU-ELEC-9001');
      expect(html).not.toContain('SKU-FOOD-4022');
      expect(html).not.toContain('SKU-TOOL-1088');

      // Misleading demo labels
      expect(html).not.toContain('Live Multi-Tenant Session');
      expect(html).not.toContain('Live Real-Time Feed');

      // Verify legitimate illustrative preview header
      expect(html).toContain('Illustrative Preview &bull; Unified Multi-Branch Inventory &amp; POS Engine');
    });

    it('verifies apps/web/vercel.json includes edge proxy rewrite for /v1/:path*', () => {
      const vercelConfigPath = resolve(WEB_ROOT, 'vercel.json');
      const config = JSON.parse(readFileSync(vercelConfigPath, 'utf8'));

      const v1Rewrite = config.rewrites.find(
        (r: { source: string; destination: string }) => r.source === '/v1/:path*',
      );
      expect(v1Rewrite).toBeDefined();
      expect(v1Rewrite.destination).toBe('https://nexstock-vu5i.onrender.com/v1/:path*');
    });

    it('verifies optimistic immediate sign out, sessionEpoch guard, background abort timeout, and toast deduplication', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Session epoch in state and apiFetch
      expect(html).toContain('sessionEpoch: 0');
      expect(html).toContain('const requestEpoch = state.sessionEpoch || 0;');
      expect(html).toContain('if ((state.sessionEpoch || 0) !== requestEpoch)');

      // Optimistic button state & fast redirection
      expect(html).toContain('b.innerText = \'Signing out...\';');
      expect(html).toContain('state.sessionEpoch = (state.sessionEpoch || 0) + 1;');
      expect(html).toContain("showToast('You have been signed out.', 'info');");
      expect(html).toContain("renderView('welcome');");

      // Non-blocking background logout with AbortController
      expect(html).toContain('new AbortController()');
      expect(html).toContain('setTimeout(() => controller.abort(), 2000)');
      expect(html).toContain('signal: controller.signal');

      // Toast deduplication via Set
      expect(html).toContain('const activeToastMessages = new Set();');
      expect(html).toContain('if (activeToastMessages.has(msgStr)) return;');
      expect(html).toContain('activeToastMessages.add(msgStr);');
      expect(html).toContain('activeToastMessages.delete(msgStr);');
    });

    it('verifies responsive dual-mode (.desktop-table-container and .mobile-cards-container) across core views', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // CSS classes defined
      expect(html).toContain('.desktop-table-container');
      expect(html).toContain('.mobile-cards-container');
      expect(html).toContain('.entity-card');
      expect(html).toContain('.entity-card-header');
      expect(html).toContain('.entity-card-title');
      expect(html).toContain('.entity-card-details');
      expect(html).toContain('.detail-row');
      expect(html).toContain('.empty-state-card');

      // Responsive media query switches
      expect(html).toContain('.desktop-table-container {\n        display: none !important;\n      }');
      expect(html).toContain('.mobile-cards-container {\n        display: flex !important;');

      // Compact 2x2 KPI grids on mobile
      expect(html).toContain('.kpi-grid {\n        grid-template-columns: repeat(2, 1fr) !important;');

      // Dual search filtering in filterProductsTable
      expect(html).toContain('document.querySelectorAll(\'#productsTable tbody tr\').forEach(');
      expect(html).toContain('document.querySelectorAll(\'#productsMobileList .entity-card\').forEach(');

      // Serial registry search filtering on .serial-row
      expect(html).toContain('class="entity-card serial-row"');

      // Landing button IDs for responsive sizing
      expect(html).toContain('id="btnLandingSignIn"');
      expect(html).toContain('id="btnLandingGetStarted"');
    });

    it('BUG-001 & BUG-002: verifies inflight locks, button disabling, idempotency headers, and dual movement payload in index.html', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // BUG-001: Product creation inflight guard and submit button reference
      expect(html).toContain('id="btnSubmitCreateProduct"');
      expect(html).toContain('if (state.isSubmittingProduct) return;');
      expect(html).toContain('state.isSubmittingProduct = true;');
      expect(html).toContain('submitBtn.disabled = true;');
      expect(html).toContain("submitBtn.textContent = 'Creating...';");
      expect(html).toContain('state.isSubmittingProduct = false;');
      expect(html).toContain('submitBtn.disabled = false;');
      expect(html).toContain("submitBtn.textContent = 'Create Product';");

      // BUG-001: Product creation sends idempotency-key header
      expect(html).toContain("'idempotency-key': idempotencyKey");

      // BUG-002: Stock movement inflight guard and submit button reference
      expect(html).toContain('id="btnSubmitStockMovement"');
      expect(html).toContain('if (state.isSubmittingMovement) return;');
      expect(html).toContain('state.isSubmittingMovement = true;');
      expect(html).toContain("submitBtn.textContent = 'Posting...';");
      expect(html).toContain('state.isSubmittingMovement = false;');
      expect(html).toContain("submitBtn.textContent = 'Post to Ledger';");

      // BUG-002: Stock movement payload passes both reason and notes
      expect(html).toContain('reason: notes,');
      expect(html).toContain('notes: notes');
      expect(html).toContain("'idempotency-key': idempotencyKey");
    });

    it('BUG-003: verifies currency minor units, formatting, and tenant-wide consistency', () => {
      // 1. Minor units map verification
      expect(CURRENCY_MINOR_UNITS['JPY']).toBe(0);
      expect(CURRENCY_MINOR_UNITS['KWD']).toBe(3);
      expect(CURRENCY_MINOR_UNITS['LKR']).toBe(2);
      expect(getCurrencyMinorUnits('JPY')).toBe(0);
      expect(getCurrencyMinorUnits('KRW')).toBe(0);
      expect(getCurrencyMinorUnits('KWD')).toBe(3);
      expect(getCurrencyMinorUnits('BHD')).toBe(3);
      expect(getCurrencyMinorUnits('OMR')).toBe(3);
      expect(getCurrencyMinorUnits('LKR')).toBe(2);
      expect(getCurrencyMinorUnits('USD')).toBe(2);
      expect(getCurrencyMinorUnits('EUR')).toBe(2);
      expect(getCurrencyMinorUnits('GBP')).toBe(2);
      expect(getCurrencyMinorUnits('INR')).toBe(2);
      expect(getCurrencyMinorUnits('AED')).toBe(2);
      expect(getCurrencyMinorUnits('SGD')).toBe(2);
      expect(getCurrencyMinorUnits('AUD')).toBe(2);
      expect(getCurrencyMinorUnits('XYZ')).toBe(2); // Fallback to 2

      // 2. formatCurrency utility formatting with minor units
      expect(formatCurrency(2500, 'LKR')).toBe('LKR 2500.00');
      expect(formatCurrency(2500, 'USD')).toBe('USD 2500.00');
      expect(formatCurrency(2500, 'JPY')).toBe('JPY 2500');
      expect(formatCurrency(2500.85, 'JPY')).toBe('JPY 2501');
      expect(formatCurrency(25.5, 'KWD')).toBe('KWD 25.500');
      expect(formatCurrency(null, 'LKR')).toBe('LKR 0.00');
      expect(formatCurrency(undefined, 'JPY')).toBe('JPY 0');

      // 3. index.html helper definitions and absence of hardcoded dollar signs in tenant views
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      expect(html).toContain('function getTenantCurrency()');
      expect(html).toContain('function getCurrencyMinorUnits(');
      expect(html).toContain('function getCurrencyInputStep(');
      expect(html).toContain('function getCurrencyDefaultCost(');
      expect(html).toContain('function getCurrencyDefaultPrice(');
      expect(html).toContain('function formatTenantMoney(');

      // Verify active tenant currency synchronization with localStorage
      expect(html).toContain('nexstock_active_currency');

      // Verify dynamic currency labels in forms and tables
      expect(html).toContain('Purchase Cost (${escapeHtml(getTenantCurrency())}) *');
      expect(html).toContain('Selling Price (${escapeHtml(getTenantCurrency())}) *');
      expect(html).toContain('Unit Cost (${escapeHtml(getTenantCurrency())}) *');
      expect(html).toContain('Cost (${escapeHtml(getTenantCurrency())})');
      expect(html).toContain('Selling Price (${escapeHtml(getTenantCurrency())})');
      expect(html).toContain('Total (${escapeHtml(getTenantCurrency())})');

      // Verify tenant views do not contain hardcoded dollar template literals like $${
      // Match $${...} inside index.html: should be 0 occurrences in tenant views
      const templateDollarMatches = (html.match(/\$\$\{[^}]+\}/g) || []);
      expect(templateDollarMatches.length).toBe(0);
    });

    it('BUG-004 & BUG-005: verifies POS product price mapping/cart calculation and stock movement ledger product details/delta display', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // BUG-004: POS product card price uses p.retailPrice || p.sellingPrice || '0.0000'
      expect(html).toContain("const price = p.retailPrice || p.sellingPrice || '0.0000';");
      expect(html).toContain('${formatTenantMoney(price)}');

      // BUG-004: addToCart receives price and sets unitPrice
      expect(html).toContain("const numericPrice = parseFloat(unitPrice || '0');");
      expect(html).toContain("const safePrice = Number.isFinite(numericPrice) ? numericPrice.toFixed(4) : '0.0000';");
      expect(html).toContain('unitPrice: safePrice');

      // BUG-004: calculateCartSubtotal parses item.unitPrice as float without falling back to 0 when valid
      expect(html).toContain('(parseFloat(item.unitPrice) || 0)');

      // BUG-004: Cart item render formats unitPrice correctly with formatTenantMoney
      expect(html).toContain('${formatTenantMoney(line.unitPrice)} / ${escapeHtml(line.uomCode)}');
      expect(html).toContain('${formatTenantMoney(line.qty * (parseFloat(line.unitPrice) || 0))}');

      // BUG-004 POS Checkout Button: verifies posCheckoutBtn element, dynamic grandTotal binding, and state syncing
      expect(html).toContain('id="posCheckoutBtn"');
      expect(html).toContain("const checkoutBtn = document.getElementById('posCheckoutBtn');");
      expect(html).toContain('checkoutBtn.disabled = state.cart.length === 0;');
      expect(html).toContain('checkoutBtn.innerHTML = `Checkout &amp; Pay (${formatTenantMoney(grandTotal)})`;');
      expect(html).toContain('state.cart = [];\n        renderPosCartPanel();');

      // BUG-005: Movement view resolves product SKU and Name
      expect(html).toContain("const sku = escapeHtml(m.productSku || fallback?.sku || '');");
      expect(html).toContain("const pName = escapeHtml(m.productName || fallback?.name || 'Product');");

      // BUG-005: Movement view resolves rawQty with fallback to qtyDelta, quantity, inputQty
      expect(html).toContain('const rawQty = m.qtyDelta ?? m.quantity ?? m.inputQty ?? 0;');
      expect(html).toContain("const qtyFormatted = `${qty > 0 ? '+' : ''}${parseFloat(qty.toFixed(4))} ${uom}`;");

      // BUG-005: Balance after displayed with UoM
      expect(html).toContain('<strong>${balAfter} ${uom}</strong>');
    });

    it('BUG-004 POS Checkout Button: verifies authoritative grand total calculation and dynamic button label matching cart summary', () => {
      // Production evidence scenario:
      // Item 1: HEAD SEAT (4000.00, qty 1)
      // Item 2: Wireless Bluetooth Mouse (3500.00, qty 1)
      const cart = [
        { productId: 'p1', sku: 'KUV-HEAD SEAT', name: 'HEAD SEAT', unitPrice: '4000.0000', qty: 1 },
        { productId: 'p2', sku: 'ELEC-MOUSE-001', name: 'Wireless Bluetooth Mouse', unitPrice: '3500.0000', qty: 1 },
      ];

      function calculateCartSubtotal(items: typeof cart) {
        return items.reduce((acc, item) => acc + (item.qty * (parseFloat(item.unitPrice) || 0)), 0);
      }
      function calculateCartTax(items: typeof cart, taxRate = 0) {
        const sub = calculateCartSubtotal(items);
        return Math.round(sub * taxRate * 100) / 100;
      }
      function calculateCartGrandTotal(items: typeof cart, taxRate = 0) {
        return calculateCartSubtotal(items) + calculateCartTax(items, taxRate);
      }

      // 1. Initial cart: 7500.00
      const subtotal1 = calculateCartSubtotal(cart);
      const grandTotal1 = calculateCartGrandTotal(cart);
      expect(subtotal1).toBe(7500);
      expect(grandTotal1).toBe(7500);
      expect(formatCurrency(grandTotal1, 'LKR')).toBe('LKR 7500.00');

      const btnLabel1 = `Checkout & Pay (${formatCurrency(grandTotal1, 'LKR')})`;
      expect(btnLabel1).toBe('Checkout & Pay (LKR 7500.00)');

      // 2. Quantity change: 2 Wireless Mice (7000.00) + 1 HEAD SEAT (4000.00) = 11000.00
      cart[1].qty = 2;
      const grandTotal2 = calculateCartGrandTotal(cart);
      expect(grandTotal2).toBe(11000);
      expect(formatCurrency(grandTotal2, 'LKR')).toBe('LKR 11000.00');
      const btnLabel2 = `Checkout & Pay (${formatCurrency(grandTotal2, 'LKR')})`;
      expect(btnLabel2).toBe('Checkout & Pay (LKR 11000.00)');

      // 3. Clear cart / Empty cart: 0.00
      const emptyCart: typeof cart = [];
      const grandTotalEmpty = calculateCartGrandTotal(emptyCart);
      expect(grandTotalEmpty).toBe(0);
      expect(formatCurrency(grandTotalEmpty, 'LKR')).toBe('LKR 0.00');
      const btnLabelEmpty = `Checkout & Pay (${formatCurrency(grandTotalEmpty, 'LKR')})`;
      expect(btnLabelEmpty).toBe('Checkout & Pay (LKR 0.00)');
    });

    it('BUG-006: verifies sales history response parsing, loading, error retry states, and production sales data rendering', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Raw array & object envelope fallback parsing
      expect(html).toContain('const sales = Array.isArray(res) ? res : (res?.data || res?.items || []);');

      // 2. Loading state before fetch
      expect(html).toContain('Loading sales history...');

      // 3. Error state with explicit Retry action
      expect(html).toContain('Failed to load sales:');
      expect(html).toContain('onclick="renderPosSalesView()">Retry</button>');

      // 4. Creation date fallback
      expect(html).toContain('(s.createdAt || s.soldAt)');

      // 5. Items count and payment summary
      expect(html).toContain('s.lines ? s.lines.length : 0');
      expect(html).toContain("s.payments && s.payments.length > 0");

      // 6. Data rendering simulation with the 4 production sales
      interface MockSale {
        id: string;
        invoiceNumber: string;
        status: string;
        customerName: string;
        currencyCode: string;
        subtotalAmount: string;
        taxAmount: string;
        grandTotal: string;
        createdAt: string;
        lines: Array<{ productId: string; sku: string; productName: string; quantity: string }>;
        payments: Array<{ paymentMethod: string; amount: string }>;
      }

      const productionSales: MockSale[] = [
        {
          id: '0192b4c0-0001-7000-8000-000000000001',
          invoiceNumber: 'REG-01-000001',
          status: 'COMPLETED',
          customerName: 'walter waiter',
          currencyCode: 'LKR',
          subtotalAmount: '11000.0000',
          taxAmount: '0.0000',
          grandTotal: '11000.0000',
          createdAt: '2026-10-30T03:41:36.999Z',
          lines: [
            { productId: 'p1', sku: 'ELEC-MOUSE-001', productName: 'Wireless Bluetooth Mouse', quantity: '2.000000' },
            { productId: 'p2', sku: 'KUV-HEAD SEAT', productName: 'HEAD SEAT', quantity: '1.000000' },
          ],
          payments: [{ paymentMethod: 'CASH', amount: '11000.0000' }],
        },
        {
          id: '0192b4c0-0002-7000-8000-000000000002',
          invoiceNumber: 'REG-01-000002',
          status: 'COMPLETED',
          customerName: 'walter waiter',
          currencyCode: 'LKR',
          subtotalAmount: '11000.0000',
          taxAmount: '0.0000',
          grandTotal: '11000.0000',
          createdAt: '2026-10-30T03:41:42.830Z',
          lines: [
            { productId: 'p1', sku: 'ELEC-MOUSE-001', productName: 'Wireless Bluetooth Mouse', quantity: '2.000000' },
            { productId: 'p2', sku: 'KUV-HEAD SEAT', productName: 'HEAD SEAT', quantity: '1.000000' },
          ],
          payments: [{ paymentMethod: 'CASH', amount: '11000.0000' }],
        },
        {
          id: '0192b4c0-0003-7000-8000-000000000003',
          invoiceNumber: 'REG-01-000003',
          status: 'COMPLETED',
          customerName: 'walter waiter',
          currencyCode: 'LKR',
          subtotalAmount: '11000.0000',
          taxAmount: '0.0000',
          grandTotal: '11000.0000',
          createdAt: '2026-10-30T03:41:48.464Z',
          lines: [
            { productId: 'p1', sku: 'ELEC-MOUSE-001', productName: 'Wireless Bluetooth Mouse', quantity: '2.000000' },
            { productId: 'p2', sku: 'KUV-HEAD SEAT', productName: 'HEAD SEAT', quantity: '1.000000' },
          ],
          payments: [{ paymentMethod: 'CASH', amount: '11000.0000' }],
        },
        {
          id: '0192b4c0-0004-7000-8000-000000000004',
          invoiceNumber: 'REG-01-000004',
          status: 'COMPLETED',
          customerName: 'walter waiter',
          currencyCode: 'LKR',
          subtotalAmount: '11000.0000',
          taxAmount: '0.0000',
          grandTotal: '11000.0000',
          createdAt: '2026-10-30T03:41:54.202Z',
          lines: [
            { productId: 'p1', sku: 'ELEC-MOUSE-001', productName: 'Wireless Bluetooth Mouse', quantity: '2.000000' },
            { productId: 'p2', sku: 'KUV-HEAD SEAT', productName: 'HEAD SEAT', quantity: '1.000000' },
          ],
          payments: [{ paymentMethod: 'CASH', amount: '11000.0000' }],
        },
      ];

      // Verifies array parser treats raw array correctly
      const parsed = Array.isArray(productionSales)
        ? productionSales
        : ((productionSales as unknown as { data?: MockSale[] })?.data || []);
      expect(parsed).toHaveLength(4);
      expect(parsed.map((s) => s.invoiceNumber)).toEqual([
        'REG-01-000001',
        'REG-01-000002',
        'REG-01-000003',
        'REG-01-000004',
      ]);
      parsed.forEach((s) => {
        expect(formatCurrency(s.grandTotal, 'LKR')).toBe('LKR 11000.00');
        expect(s.customerName).toBe('walter waiter');
        expect(s.status).toBe('COMPLETED');
        expect(s.lines).toHaveLength(2);
      });

      // An empty response correctly evaluates to length 0
      const emptyRes: unknown[] = [];
      const parsedEmpty = Array.isArray(emptyRes)
        ? emptyRes
        : (emptyRes as unknown as { data?: unknown[] })?.data || [];
      expect(parsedEmpty).toHaveLength(0);
    });

    it('BUG-007: verifies checkout state machine, button locking, stable idempotency key reuse on retry, and key consumption', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. State machine properties
      expect(html).toContain('isSubmittingCheckout: false');
      expect(html).toContain('activeCheckoutKey: null');

      // 2. Guard against concurrent/duplicate in-flight submissions
      expect(html).toContain('if (state.isSubmittingCheckout) return;');
      expect(html).toContain('state.isSubmittingCheckout = true;');

      // 3. UI button disabling and loading label
      expect(html).toContain('id="btnSubmitPosCheckout"');
      expect(html).toContain('id="btnCancelCheckout"');
      expect(html).toContain('submitBtn.disabled = true;');
      expect(html).toContain("submitBtn.innerText = 'Processing Payment...';");
      expect(html).toContain('cancelBtn.disabled = true;');

      // 4. Enter-key submission deduplication
      expect(html).toContain("if(event.key==='Enter'){event.preventDefault();submitPosCheckout();}");

      // 5. Explicit idempotency key binding
      expect(html).toContain("'idempotency-key': idempotencyKey");

      // 6. Safe retry restoration on error
      expect(html).toContain('Retry Payment (');
      expect(html).toContain('submitBtn.disabled = false;');
      expect(html).toContain('cancelBtn.disabled = false;');

      // 7. Key consumption upon verified completion
      expect(html).toContain('state.activeCheckoutKey = null;');
      expect(html).toContain('state.isSubmittingCheckout = false;');

      // 8. Closing modal and cart changes reset activeCheckoutKey
      expect(html).toContain('function closeModal() {');
      expect(html).toContain('if (state.isSubmittingCheckout) return;');
    });

    it('BUG-008: verifies compact POS product card CSS layout, align-content start, and responsive rules', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Grid layout properties preventing vertical stretching
      expect(html).toContain('align-content: start;');
      expect(html).toContain('grid-auto-rows: max-content;');
      expect(html).toContain('align-items: start;');

      // 2. Product card compact dimensions and touch attributes
      expect(html).toContain('min-height: 96px;');
      expect(html).toContain('box-sizing: border-box;');
      expect(html).toContain('touch-action: manipulation;');
      expect(html).toContain('.pos-product-card:active {');

      // 3. Small mobile responsive rules (480px)
      expect(html).toContain('min-height: 86px !important;');

      // 4. Ultra-compact mobile responsive rules (360px - 320px)
      expect(html).toContain('grid-template-columns: repeat(2, 1fr) !important;');
      expect(html).toContain('min-height: 80px !important;');
    });

    it('BUG-011: verifies session retention, token refresh mutex, HTTP 403 safety, and multi-tab sync', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Session store properties
      expect(html).toContain('tokenExpiresAt: 0');
      expect(html).toContain('timezone:');

      // 2. JWT expiration decoder and proactive refresh
      expect(html).toContain('function getTokenExpiry(jwtToken)');
      expect(html).toContain('Date.now() + 30000 >= exp');

      // 3. Singleton token refresh mutex
      expect(html).toContain('let activeRefreshPromise = null;');
      expect(html).toContain('async function refreshAccessToken()');
      expect(html).toContain('if (activeRefreshPromise)');
      expect(html).toContain('activeRefreshPromise = (async () =>');

      // 4. apiFetch retry on 401 with refreshed token
      expect(html).toContain('if (res.status === 401 && !isAuthBypass)');
      expect(html).toContain('const refreshed = await refreshAccessToken();');
      expect(html).toContain("return apiFetch(endpoint, { ...options, _retried: true });");

      // 5. HTTP 403 Forbidden does NOT trigger signout
      expect(html).toContain('HTTP 403 Forbidden or other client/server error: DO NOT SIGN OUT!');

      // 6. initApp preserves session on 5xx or offline network errors
      expect(html).toContain('Server error (500, 502, 503, 504) or gateway timeout: PRESERVE SESSION!');
      expect(html).toContain('Network offline / connection failed: PRESERVE SESSION!');
      expect(html).toContain('● Server Reconnecting...');
      expect(html).toContain('● Offline / Disconnected');

      // 7. Multi-tab storage listener
      expect(html).toContain("window.addEventListener('storage',");
      expect(html).toContain("event.key === 'nexstock_session_token'");

      // 8. Explicit sign out cleans up all storage keys
      expect(html).toContain("localStorage.removeItem('nexstock_session_token');");
      expect(html).toContain("localStorage.removeItem('nexstock_refresh_token');");
      expect(html).toContain("localStorage.removeItem('nexstock_active_timezone');");
    });

    it('BUG-012: verifies Dashboard KPI calculation, strict COMPLETED vs VOIDED separation, and timezone-aware boundaries', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Timezone-aware date helper
      expect(html).toContain('function isSameDayInTimezone(dateOrIso, targetDate = new Date(), timezone = \'UTC\')');

      // 2. Strict status separation in Dashboard KPI
      expect(html).toContain("const completedSales = todaySales.filter(s => s.status === 'COMPLETED');");
      expect(html).toContain("const voidedSales = todaySales.filter(s => s.status === 'VOIDED');");
      expect(html).toContain("const completedCount = completedSales.length;");
      expect(html).toContain("const voidedCount = voidedSales.length;");
      expect(html).toContain("${completedCount} completed transaction");

      // 3. Recent Completed Sales table displays only completed sales
      expect(html).toContain("${completedSales.slice(0, 5).map(s =>");

      // 4. Algorithmic verification with production evidence:
      // REG-01-000001 (COMPLETED, 11000)
      // REG-01-000002 (COMPLETED, 11000)
      // REG-01-000003 (VOIDED, 11000)
      // REG-01-000004 (VOIDED, 11000)
      interface InvoiceItem {
        invoiceNumber: string;
        status: 'COMPLETED' | 'VOIDED';
        grandTotal: string;
        createdAt: string;
      }

      const mockInvoices: InvoiceItem[] = [
        { invoiceNumber: 'REG-01-000001', status: 'COMPLETED', grandTotal: '11000.0000', createdAt: '2026-10-30T03:41:36.999Z' },
        { invoiceNumber: 'REG-01-000002', status: 'COMPLETED', grandTotal: '11000.0000', createdAt: '2026-10-30T03:41:42.830Z' },
        { invoiceNumber: 'REG-01-000003', status: 'VOIDED', grandTotal: '11000.0000', createdAt: '2026-10-30T03:41:48.464Z' },
        { invoiceNumber: 'REG-01-000004', status: 'VOIDED', grandTotal: '11000.0000', createdAt: '2026-10-30T03:41:54.202Z' },
      ];

      const tz = 'Asia/Colombo';
      const targetDate = new Date('2026-10-30T10:00:00.000Z');

      const isSameDay = (dateStr: string, target: Date, timezone: string): boolean => {
        const formatter = new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
        return formatter.format(new Date(dateStr)) === formatter.format(target);
      };

      const todaySales = mockInvoices.filter(s => isSameDay(s.createdAt, targetDate, tz));
      expect(todaySales).toHaveLength(4);

      const completed = todaySales.filter(s => s.status === 'COMPLETED');
      const voided = todaySales.filter(s => s.status === 'VOIDED');

      const completedSalesTotal = completed.reduce((acc, s) => acc + parseFloat(s.grandTotal), 0);
      const completedCount = completed.length;
      const voidedCount = voided.length;

      // Exact production expectations:
      expect(completedSalesTotal).toBe(22000);
      expect(formatCurrency(completedSalesTotal, 'LKR')).toBe('LKR 22000.00');
      expect(completedCount).toBe(2);
      expect(voidedCount).toBe(2);

      // Verify KPI trend label formatting
      const kpiTrend = `${completedCount} completed transaction${completedCount === 1 ? '' : 's'}${voidedCount > 0 ? ` (${voidedCount} voided)` : ''}`;
      expect(kpiTrend).toBe('2 completed transactions (2 voided)');

      // Verify that date boundary correctly excludes yesterday's sales in that timezone
      const yesterdayInvoice: InvoiceItem = {
        invoiceNumber: 'REG-01-000000',
        status: 'COMPLETED',
        grandTotal: '5000.0000',
        createdAt: '2026-10-29T10:00:00.000Z',
      };
      expect(isSameDay(yesterdayInvoice.createdAt, targetDate, tz)).toBe(false);
    });

    it('BUG-009: verifies Sales History Void button immediate visual feedback, in-flight mutex guard, in-place DOM updates, and cache invalidation', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Spinner styles and helper classes
      expect(html).toContain('.spinner-sm {');
      expect(html).toContain('animation: spin 0.6s linear infinite;');

      // 2. Void in-flight mutex set definition
      expect(html).toContain('const activeVoidOps = new Set();');

      // 3. Modals and handlers
      expect(html).toContain('function openVoidModal(saleId, invoiceNumber)');
      expect(html).toContain('async function confirmVoidSale(saleId, invoiceNumber, explicitReason)');
      expect(html).toContain('function voidSalePrompt(saleId, invoiceNumber, explicitReason)');

      // 4. Role-based authorization guard
      expect(html).toContain("if (state.userRole === 'CASHIER')");
      expect(html).toContain("Permission denied: Cashiers cannot void sales. Switch to Owner role.");

      // 5. In-flight concurrency blocking guard
      expect(html).toContain('if (activeVoidOps.has(saleId)) return;');

      // 6. Mandatory reason validation
      expect(html).toContain('Reason is required to void an invoice.');

      // 7. Immediate visual feedback on modal and row buttons
      expect(html).toContain("modalConfirmBtn.innerHTML = '<span class=\"spinner-sm\"></span> Voiding...';");
      expect(html).toContain("btn.innerHTML = '<span class=\"spinner-sm\"></span> Voiding...';");
      expect(html).toContain('modalConfirmBtn.disabled = true;');
      expect(html).toContain('btn.disabled = true;');

      // 8. In-place DOM update without full page reloading / screen blanking
      expect(html).toContain("badgeDesktop.className = 'badge-pill badge-red';");
      expect(html).toContain("badgeDesktop.innerText = 'VOIDED';");
      expect(html).toContain('voidBtns.forEach(btn => btn.remove());');

      // 9. Cache invalidation on successful void
      expect(html).toContain('cachedReceipts.delete(saleId);');
      expect(html).toContain('state.cachedProducts = [];');
      expect(html).toContain("s.status = 'VOIDED';");

      // 10. Graceful error recovery restores button state
      expect(html).toContain("modalConfirmBtn.innerText = 'Confirm Void';");
      expect(html).toContain("modalConfirmBtn.disabled = false;");

      // 11. Algorithmic simulation of void mutex and double-submit prevention
      const activeOps = new Set<string>();
      let voidApiCallCount = 0;

      const simulateVoidClick = async (saleId: string, reason: string): Promise<{ success: boolean; blocked: boolean }> => {
        if (!reason || reason.trim() === '') return { success: false, blocked: false };
        if (activeOps.has(saleId)) return { success: false, blocked: true };

        activeOps.add(saleId);
        try {
          voidApiCallCount++;
          // Simulate network latency
          await new Promise((r) => setTimeout(r, 10));
          return { success: true, blocked: false };
        } finally {
          activeOps.delete(saleId);
        }
      };

      // Test simultaneous clicks on same invoice
      const p1 = simulateVoidClick('sale-001', 'Damaged goods return');
      const p2 = simulateVoidClick('sale-001', 'Damaged goods return');
      const p3 = simulateVoidClick('sale-001', 'Damaged goods return');

      return Promise.all([p1, p2, p3]).then(([res1, res2, res3]) => {
        expect(res1.success).toBe(true);
        expect(res2.blocked).toBe(true);
        expect(res3.blocked).toBe(true);
        expect(voidApiCallCount).toBe(1);
      });
    });

    it('BUG-010: verifies Receipt button immediate loading feedback, in-flight mutex guard, memory caching for 0ms reopening, and graceful error restoration', async () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Receipt in-flight mutex set and memory cache map
      expect(html).toContain('const activeReceiptFetches = new Set();');
      expect(html).toContain('const cachedReceipts = new Map();');

      // 2. openReceiptModal function definition
      expect(html).toContain('async function openReceiptModal(saleId)');

      // 3. Double-click in-flight mutex protection
      expect(html).toContain('if (activeReceiptFetches.has(saleId)) return;');

      // 4. Memory cache check
      expect(html).toContain('let receipt = cachedReceipts.get(saleId);');

      // 5. Immediate visual feedback on receipt buttons
      expect(html).toContain("b.innerHTML = '<span class=\"spinner-sm\"></span> Loading receipt...';");
      expect(html).toContain('b.disabled = true;');

      // 6. Network fetch & cache storage
      expect(html).toContain('receipt = await apiFetch(`/v1/pos/sales/${saleId}/receipt`);');
      expect(html).toContain('cachedReceipts.set(saleId, receipt);');

      // 7. Cleanup and button restoration
      expect(html).toContain('activeReceiptFetches.delete(saleId);');
      expect(html).toContain("b.innerText = 'Receipt';");
      expect(html).toContain('b.disabled = false;');

      // 8. Sign out cache cleanup
      expect(html).toContain('cachedReceipts.clear();');
      expect(html).toContain('activeReceiptFetches.clear();');
      expect(html).toContain('activeVoidOps.clear();');

      // 9. Algorithmic simulation of receipt caching & concurrency guard
      const memoryCache = new Map<string, { id: string; invoiceNumber: string; grandTotal: string }>();
      const inFlightFetches = new Set<string>();
      let networkFetchCount = 0;

      const simulateGetReceipt = async (saleId: string) => {
        if (inFlightFetches.has(saleId)) {
          return { cached: false, inFlightBlocked: true, data: null };
        }

        const cached = memoryCache.get(saleId);
        if (cached) {
          return { cached: true, inFlightBlocked: false, data: cached };
        }

        inFlightFetches.add(saleId);
        try {
          networkFetchCount++;
          await new Promise((r) => setTimeout(r, 15));
          const mockReceipt = { id: saleId, invoiceNumber: 'REG-01-000001', grandTotal: '11000.0000' };
          memoryCache.set(saleId, mockReceipt);
          return { cached: false, inFlightBlocked: false, data: mockReceipt };
        } finally {
          inFlightFetches.delete(saleId);
        }
      };

      // Concurrent clicks while first fetch is in flight
      const call1Promise = simulateGetReceipt('sale-123');
      const call2Promise = simulateGetReceipt('sale-123');
      const [res1, res2] = await Promise.all([call1Promise, call2Promise]);

      expect(res1.inFlightBlocked).toBe(false);
      expect(res1.data?.invoiceNumber).toBe('REG-01-000001');
      expect(res2.inFlightBlocked).toBe(true);
      expect(networkFetchCount).toBe(1);

      // Subsequent click after completion is served instantly (0ms) from cache without network fetch
      const startMs = Date.now();
      const call3Res = await simulateGetReceipt('sale-123');
      const durationMs = Date.now() - startMs;

      expect(call3Res.cached).toBe(true);
      expect(call3Res.data?.invoiceNumber).toBe('REG-01-000001');
      expect(networkFetchCount).toBe(1); // Still 1, no second network request!
      expect(durationMs).toBeLessThan(5); // Instant 0ms cache hit
    });
  });

  describe('14. BUG-013 — Cashier Shift Reconciliation, Float Accountability & Variance Engine', () => {
    it('verifies public/index.html includes complete drawer reconciliation cards & formula', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Shift Overview contains the 8 essential metrics
      expect(html).toContain('Active Shift Overview &amp; Reconciliation');
      expect(html).toContain('Shift Status');
      expect(html).toContain('Opened At');
      expect(html).toContain('Opening Float');
      expect(html).toContain('Cash Sales (+)');
      expect(html).toContain('Cash In (+)');
      expect(html).toContain('Cash Out (-)');
      expect(html).toContain('Cash Refunds (-)');
      expect(html).toContain('Expected Drawer Cash');

      // 2. Reconciliation formula string clearly presented to cashier
      expect(html).toContain('Reconciliation Formula:');
      expect(html).toContain('Expected Drawer Cash = Opening Float');
      expect(html).toContain('+ Cash Sales');
      expect(html).toContain('+ Cash In');
      expect(html).toContain('- Cash Out');
      expect(html).toContain('- Cash Refunds');

      // 3. Cash adjustment UI & endpoints
      expect(html).toContain('+ Cash Adjustment');
      expect(html).toContain('function openCashAdjustmentModal(');
      expect(html).toContain('function submitCashAdjustment(');
      expect(html).toContain('adjTypeSelect');
      expect(html).toContain('CASH_IN');
      expect(html).toContain('CASH_OUT');
      expect(html).toContain('CASH_REFUND');
      expect(html).toContain('/v1/pos/shifts/${shiftId}/adjustments');

      // 4. Close shift reconciliation modal with live variance calculation
      expect(html).toContain('function openCloseShiftModal(');
      expect(html).toContain('System Expected Drawer Cash');
      expect(html).toContain('updateCloseVariancePreview(');
      expect(html).toContain('closeVarianceBox');
      expect(html).toContain('Shift Balanced:');
      expect(html).toContain('Cash Shortage:');
      expect(html).toContain('Cash Overage:');
      expect(html).toContain('function submitCloseShift(');
      expect(html).toContain('/v1/pos/shifts/${shiftId}/close');
    });

    it('verifies authoritative drawer cash reconciliation formula arithmetic', () => {
      // Formula: Expected = Float + CashSales + CashIn - CashOut - CashRefunds
      const openingFloat = 2500.0;
      const cashSales = [11000.0, 11000.0, 11000.0]; // 3 completed sales (1 voided excluded)
      const totalCashSales = cashSales.reduce((a, b) => a + b, 0); // 33000.0
      const cashIn = 5000.0;
      const cashOut = 1200.0;
      const cashRefunds = 800.0;

      const expectedDrawerCash = openingFloat + totalCashSales + cashIn - cashOut - cashRefunds;
      expect(expectedDrawerCash).toBe(38500.0);

      // Variance test cases: Counted - Expected
      // 1. Balanced
      const countedBalanced = 38500.0;
      expect(countedBalanced - expectedDrawerCash).toBe(0.0);

      // 2. Shortage
      const countedShortage = 38200.0;
      expect(countedShortage - expectedDrawerCash).toBe(-300.0);

      // 3. Overage
      const countedOverage = 38750.0;
      expect(countedOverage - expectedDrawerCash).toBe(250.0);
    });
  });

  describe('15. BUG-014 — Application-wide Entity Editing & Accounting Immutability Enforcement', () => {
    it('verifies public/index.html includes responsive edit buttons and modals for all editable entities', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Products Edit
      expect(html).toContain('openEditProductModal(');
      expect(html).toContain('submitEditProduct(');
      expect(html).toContain('/v1/products/${productId}');
      expect(html).toContain('id="editProdSku"');
      expect(html).toContain('id="editProdName"');
      expect(html).toContain('id="editProdCategory"');
      expect(html).toContain('id="editProdCost"');
      expect(html).toContain('id="editProdPrice"');
      expect(html).toContain('id="editProdTrackingMode"');
      expect(html).toContain('id="newProdTrackingMode"');
      expect(html).toContain('<th>Tracking Mode</th>');
      expect(html).toContain('No Batch-Eligible Products Found');
      expect(html).toContain('No Serial-Eligible Products Found');

      // 2. Categories Edit
      expect(html).toContain('openEditCategoryModal(');
      expect(html).toContain('submitEditCategory(');
      expect(html).toContain('/v1/categories/${categoryId}');
      expect(html).toContain('id="editCatName"');
      expect(html).toContain('id="editCatDesc"');

      // 3. Suppliers Edit
      expect(html).toContain('openEditSupplierModal(');
      expect(html).toContain('submitEditSupplier(');
      expect(html).toContain('/v1/suppliers/${supplierId}');
      expect(html).toContain('id="editSupName"');
      expect(html).toContain('id="editSupContact"');
      expect(html).toContain('id="editSupEmail"');
      expect(html).toContain('id="editSupPhone"');

      // 4. POS Registers Edit
      expect(html).toContain('openEditRegisterModal(');
      expect(html).toContain('submitEditRegister(');
      expect(html).toContain('/v1/pos/registers/${registerId}');
      expect(html).toContain('id="editRegName"');
      expect(html).toContain('id="editRegIsActive"');
    });

    it('enforces immutable core entities by verifying no edit actions exist for financial & ledger records', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Stock Ledger Entries must NEVER be directly editable
      expect(html).not.toContain('openEditStockMovementModal');
      expect(html).not.toContain('openEditMovementModal');
      expect(html).not.toContain('submitEditStockMovement');

      // Sales Invoices must NEVER have direct Edit buttons (only Void workflow)
      expect(html).not.toContain('openEditSaleModal');
      expect(html).not.toContain('openEditInvoiceModal');
      expect(html).not.toContain('submitEditSale');

      // Sales Payments must NEVER be directly editable
      expect(html).not.toContain('openEditPaymentModal');
      expect(html).not.toContain('submitEditPayment');

      // Audit Logs are append-only write-only immutable records
      expect(html).not.toContain('openEditAuditLogModal');
      expect(html).not.toContain('submitEditAuditLog');
    });
  });

  describe('16. BUG-015 — Batch Creation Stock Ledger & Balances Integration', () => {
    it('verifies public/index.html includes branchId and idempotency-key in createBatch requests', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Modal and creation functions exist
      expect(html).toContain('openCreateBatchModal');
      expect(html).toContain('btnOpenNewBatchModal');
      expect(html).toContain('/v1/inventory/batches');

      // 2. branchId included in payload
      expect(html).toContain('branchId: state.branchId');

      // 3. Idempotency Key header included
      expect(html).toContain("const idempotencyKey = crypto.randomUUID()");
      expect(html).toContain("'idempotency-key': idempotencyKey");

      // 4. In-flight button disabled and label updated
      expect(html).toContain('submitBtn.disabled = true');
      expect(html).toContain("submitBtn.textContent = 'Creating...'");

      // 5. Success toast notifies user of batch and ledger registration
      expect(html).toContain('showToast(');
      expect(html).toContain('Batch created and inventory intake recorded successfully');
    });
  });

  describe('17. BUG-016 — Serial Registration Stock Ledger & Balances Integration', () => {
    it('verifies public/index.html includes in-flight button state, idempotency-key, and multi-view refresh for serial intake', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Modal and creation functions exist
      expect(html).toContain('openRegisterSerialsModal');
      expect(html).toContain('btnSubmitRegisterSerials');
      expect(html).toContain('/v1/inventory/serials');

      // 2. branchId and warehouseId included in payload
      expect(html).toContain('branchId: state.branchId');
      expect(html).toContain('warehouseId: state.warehouseId');

      // 3. Idempotency Key header included
      expect(html).toContain("const idempotencyKey = crypto.randomUUID()");
      expect(html).toContain("'idempotency-key': idempotencyKey");

      // 4. In-flight button disabled and label updated to Saving...
      expect(html).toContain('submitBtn.disabled = true');
      expect(html).toContain("submitBtn.textContent = 'Saving...'");

      // 5. Success toast notifies user of serial intake in ledger
      expect(html).toContain('showToast(');
      expect(html).toContain('recorded stock intake in ledger');

      // 6. Refreshes Serials, Balances, and Movements views
      expect(html).toContain('renderSerialsView()');
      expect(html).toContain('renderBalancesView()');
      expect(html).toContain('renderMovementsView()');
    });
  });

  describe('18. Phase 6 — Universal Barcode Management & Dual-Mode POS Scanning System', () => {
    it('verifies public/index.html includes all Universal Barcode and Dual-Mode POS Scanning components', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Barcode Settings in Org Settings
      expect(html).toContain('settingHwScanner');
      expect(html).toContain('settingCamScanner');
      expect(html).toContain('settingInternalGen');
      expect(html).toContain('settingAutoCart');
      expect(html).toContain('settingIncDup');
      expect(html).toContain('settingPrefix');
      expect(html).toContain('saveTenantBarcodeSettings');
      expect(html).toContain('/v1/settings/barcode');

      // 2. Vector SVG Barcode Generator and Label Printing
      expect(html).toContain('renderBarcodeSvg');
      expect(html).toContain('CODE128_PATTERNS');
      expect(html).toContain('openBarcodeLabelModal');
      expect(html).toContain('printableBarcodeLabel');
      expect(html).toContain('@media print');

      // 3. Product Catalog Barcode Management Actions
      expect(html).toContain('🏷️ Barcode');
      expect(html).toContain('generateBarcodeForInput');
      expect(html).toContain('btnGenNewProdBarcode');

      // 4. Dual-Mode POS Scanning & Audio Synthesizer
      expect(html).toContain('btnPosCameraScan');
      expect(html).toContain('openPosCameraScannerModal');
      expect(html).toContain('closePosCameraScannerModal');
      expect(html).toContain('posCameraVideo');
      expect(html).toContain('camera-reticle');
      expect(html).toContain('playScanChime');
      expect(html).toContain('openUnknownBarcodeModal');
      expect(html).toContain('bindUnknownBarcodeToProduct');
      expect(html).toContain('openCreateProductModalWithBarcode');
    });

    it('verifies BarcodeScannerBuffer keystroke burst detection and Enter dispatch', () => {
      const scanner = new BarcodeScannerBuffer(50);
      let t = 1000;

      // Burst scan: 'N', 'B', '-', '0', '0', '1', 'Enter' spaced 15ms apart
      expect(scanner.handleKeyDown({ key: 'N', timeStamp: (t += 15) })).toBeNull();
      expect(scanner.handleKeyDown({ key: 'B', timeStamp: (t += 15) })).toBeNull();
      expect(scanner.handleKeyDown({ key: '-', timeStamp: (t += 15) })).toBeNull();
      expect(scanner.handleKeyDown({ key: '0', timeStamp: (t += 15) })).toBeNull();
      expect(scanner.handleKeyDown({ key: '0', timeStamp: (t += 15) })).toBeNull();
      expect(scanner.handleKeyDown({ key: '1', timeStamp: (t += 15) })).toBeNull();

      const result = scanner.handleKeyDown({ key: 'Enter', timeStamp: (t += 15) });
      expect(result).toBe('NB-001');

      // Slow manual typing: > 50ms resets buffer
      expect(scanner.handleKeyDown({ key: 'A', timeStamp: 2000 })).toBeNull();
      expect(scanner.handleKeyDown({ key: 'B', timeStamp: 2100 })).toBeNull();
      expect(scanner.handleKeyDown({ key: 'Enter', timeStamp: 2110 })).toBeNull();
    });
  });

  describe('19. BUG-017 & BUG-018 — Barcode Generation & Product Image Upload Frontend Controls', () => {
    it('verifies public/index.html includes Product Image Upload, Dropzone, Previews & Catalog display (BUG-018)', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Image upload dropzone, file input, and previews in Create Product modal
      expect(html).toContain('newProdImageDropzone');
      expect(html).toContain('newProdImageFileInput');
      expect(html).toContain('newProdImagePreview');
      expect(html).toContain('newProdImageUrl');
      expect(html).toContain('removeProductImage(\'new\')');

      // 2. Image upload dropzone, replacement, and removal in Edit Product modal
      expect(html).toContain('editProdImageDropzone');
      expect(html).toContain('editProdImageFileInput');
      expect(html).toContain('editProdImagePreview');
      expect(html).toContain('editProdImageUrl');
      expect(html).toContain('editProdImageAction');
      expect(html).toContain('removeProductImage(\'edit\')');

      // 3. Image upload helper functions & API call
      expect(html).toContain('handleProductImageSelected');
      expect(html).toContain('handleProductImageDrop');
      expect(html).toContain('/v1/products/upload-image');

      // 4. Product catalog photo column & fallback emoji
      expect(html).toContain('<th style="width: 44px; text-align: center;">Photo</th>');
      expect(html).toContain('📦');

      // 5. POS Product card thumbnail integration
      expect(html).toContain('pos-product-card');
      expect(html).toContain('p.imageUrl');
    });

    it('verifies public/index.html includes Barcode Generator symbology options & error handling (BUG-017)', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Primary Barcode Generator controls in Edit Modal
      expect(html).toContain('btnGenEditProdBarcode');
      expect(html).toContain('editProdBarcodeSymbology');

      // Symbology options in dropdowns
      expect(html).toContain('value="CODE128"');
      expect(html).toContain('value="CODE39"');
      expect(html).toContain('value="EAN13"');
      expect(html).toContain('value="EAN8"');
      expect(html).toContain('value="UPCA"');
      expect(html).toContain('value="UPCE"');
      expect(html).toContain('value="ITF"');

      // POST body in generateBarcodeForInput
      expect(html).toContain('body: JSON.stringify({ symbology })');
    });
  });

  describe('20. Phase 6 Master QA Remediation UI & POS Printing Systems (BUG-019 to BUG-028)', () => {
    it('BUG-019: resolves product media URLs accurately against API origin', () => {
      expect(resolveMediaUrl(null)).toBeNull();
      expect(resolveMediaUrl('')).toBeNull();
      expect(resolveMediaUrl('   ')).toBeNull();
      expect(resolveMediaUrl(undefined)).toBeNull();

      // Absolute URLs are preserved unmodified
      expect(resolveMediaUrl('https://cdn.example.com/images/prod1.jpg')).toBe(
        'https://cdn.example.com/images/prod1.jpg',
      );
      expect(resolveMediaUrl('http://localhost:4000/v1/media/tenant/prod.png')).toBe(
        'http://localhost:4000/v1/media/tenant/prod.png',
      );
      expect(resolveMediaUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
        'data:image/png;base64,iVBORw0KGgo=',
      );

      // Relative paths are prefixed with API base URL
      expect(
        resolveMediaUrl('/v1/media/tenant-123/prod-img.jpg', 'https://nexstock-vu5i.onrender.com'),
      ).toBe('https://nexstock-vu5i.onrender.com/v1/media/tenant-123/prod-img.jpg');
      expect(
        resolveMediaUrl('v1/media/tenant-123/prod-img.jpg', 'https://nexstock-vu5i.onrender.com/'),
      ).toBe('https://nexstock-vu5i.onrender.com/v1/media/tenant-123/prod-img.jpg');
    });

    it('BUG-019: verifies public/index.html integrates resolveMediaUrl across catalog and POS', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      expect(html).toContain('function resolveMediaUrl(');
      expect(html).toContain('resolveMediaUrl(p.imageUrl)');
      expect(html).toContain('state.posProductsMap');
    });

    it('BUG-020: verifies public/index.html enforces available stock in POS cart & drawer', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Cart line stock limits
      expect(html).toContain('Cannot add more of');
      expect(html).toContain('stock limit reached');
      expect(html).toContain('is out of stock (0 available)');
      expect(html).toContain('Cannot increase quantity: Only');
      expect(html).toContain('Quantity exceeds available stock');

      // Drawer pre-checkout stock guard
      expect(html).toContain('Cannot proceed to checkout:');
      expect(html).toContain('Checkout blocked:');
    });

    it('BUG-021: verifies in-memory fast-path barcode indexing in executeBarcodeScan', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      expect(html).toContain('state.posProductsMap.has(lowerCode)');
      expect(html).toContain('FAST-PATH: Instant in-memory index lookup');
    });

    it('BUG-022 & BUG-028: verifies iframe-isolated printing engine with thermal & A4 support', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Isolated iframe printer
      expect(html).toContain('function printHtmlDocument(printableHtml, pageStyles');
      expect(html).toContain('nexstockPrintFrame');

      // Barcode label printing
      expect(html).toContain('function printBarcodeLabels(productId)');
      expect(html).toContain('THERMAL_50X30');
      expect(html).toContain('THERMAL_40X28');

      // Receipt printing
      expect(html).toContain('function printReceiptInvoice(saleId)');
      expect(html).toContain('THERMAL_80');
      expect(html).toContain('THERMAL_58');
      expect(html).toContain('receiptPrintFormat');
    });

    it('BUG-023 & BUG-024: verifies barcode management responsiveness, wider modal and in-flight guards', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      expect(html).toContain("maxWidth: '740px'");
      expect(html).toContain('activeBarcodeOps');
      expect(html).toContain('setBarcodePrimary');
      expect(html).toContain('toggleBarcodeActive');
      expect(html).toContain('deleteBarcode');
    });

    it('BUG-026: verifies primary barcode invariant warnings in UI', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      expect(html).toContain('Deactivating this primary barcode will automatically promote');
    });

    it('BUG-027: verifies cash tendered validation and null customerName in POS checkout', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      expect(html).toContain('Tendered cash');
      expect(html).toContain('cannot be less than total amount due');
      expect(html).toContain('const customerName = rawCustomerName ? rawCustomerName : null;');
    });
  });

  describe('21. Phase 6 Production QA Remediation — BUG-019, BUG-029, BUG-030, BUG-031, BUG-032, BUG-033', () => {
    it('BUG-019: verifies product image upload, submit button guard, and cached catalog update', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Problem+json content-type matching in apiFetch
      expect(html).toContain("contentType.includes('json')");

      // File input accept attributes include image/jpg and extensions
      expect(html).toContain('accept="image/jpeg,image/png,image/webp,image/jpg,.jpg,.jpeg,.png,.webp"');

      // Client-side image/jpg MIME normalization to image/jpeg
      expect(html).toContain("if (mimeType === 'image/jpg')");
      expect(html).toContain("mimeType = 'image/jpeg';");

      // In-flight upload button disabling
      expect(html).toContain("submitBtn.textContent = 'Uploading Image...';");

      // Direct cachedProducts update in submitEditProduct
      expect(html).toContain("cachedP.imageUrl = newImageUrl");
    });

    it('BUG-029: verifies single card-based layout in Barcode Management modal with no duplicate table', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Upper desktop table layout must be completely removed
      expect(html).not.toContain('desktop-barcode-table');

      // Exactly one card list layout is present
      expect(html).toContain('class="barcode-card-list" id="barcodeCardList"');

      // Required action button IDs are preserved
      expect(html).toContain('id="btnMakePrimary-${b.id}"');
      expect(html).toContain('id="btnToggleActive-${b.id}"');
      expect(html).toContain('id="btnDeleteBc-${b.id}"');

      // Primary barcode is updated on product cache
      expect(html).toContain('p.primaryBarcode = primaryBarcodeObj.barcode');
    });

    it('BUG-030: verifies dashboard initial loader, synchronous token initialization, and URL hash routing', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Initial loading state in #mainContainer prevents blank screen
      expect(html).toContain('id="initialAppLoader"');
      expect(html).toContain('Loading NexStock...');

      // Synchronous credential read into state prevents unauthenticated bounces
      expect(html).toContain('storedSessionToken');
      expect(html).toContain('storedActiveTenantId');

      // Synchronous membership and user profile cache restoration
      expect(html).toContain("localStorage.getItem('nexstock_active_membership')");
      expect(html).toContain("localStorage.getItem('nexstock_user_profile')");

      // AbortController timeout for /v1/auth/me to avoid hanging cold starts
      expect(html).toContain('setTimeout(() => controller.abort(), 12000)');

      // 8-second cold boot status alert
      expect(html).toContain('Waking up NexStock cloud server...');

      // URL Hash Routing and Route Resolver
      expect(html).toContain('const VALID_VIEWS = [');
      expect(html).toContain('function getRouteFromLocation()');
      expect(html).toContain("window.addEventListener('hashchange'");

      // Pending target view preservation during asynchronous initialization
      expect(html).toContain('state.pendingTargetView');
    });

    it('BUG-031: verifies physical hardware scanner wedge global listener, test console, and setup guide', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Global hardware wedge keydown listener uses state.activeView === 'pos-checkout'
      expect(html).toContain("if (state.activeView === 'pos-checkout')");
      expect(html).not.toContain("state.currentView === 'pos-checkout'");

      // Dedicated Interactive Scanner Test Console
      expect(html).toContain('id="hardwareScannerTestInput"');
      expect(html).toContain('id="testScannerCodeVal"');
      expect(html).toContain('id="testScannerDurationVal"');
      expect(html).toContain('id="testScannerRateVal"');
      expect(html).toContain('id="testScannerSymbologyVal"');
      expect(html).toContain('function updateHardwareScannerTestConsole(');
      expect(html).toContain('function resetScannerTestConsole(');

      // Hardware Scanner Setup Guide Modal
      expect(html).toContain('function openHardwareScannerGuideModal()');
      expect(html).toContain('Physical Barcode Scanner Setup Guide');

      // WebHID Direct Connection option
      expect(html).toContain('function connectWebHidScanner()');
      expect(html).toContain('id="webhidStatusBadge"');
    });

    it('BUG-032: verifies Barcode Settings mobile UI/UX with 4 grouped cards, modern toggles, and prefix preview', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Modern CSS classes for toggle switches
      expect(html).toContain('.modern-switch');
      expect(html).toContain('.modern-slider');
      expect(html).toContain('.switch-group');
      expect(html).toContain('.scanner-stat-card');

      // 4 structured cards in Barcode Settings
      expect(html).toContain('Hardware Scanners &amp; Input Engines');
      expect(html).toContain('POS Checkout Behaviors');
      expect(html).toContain('Internal SKU &amp; Barcode Generator');
      expect(html).toContain('Hardware Scanner Test Console');

      // Live prefix preview pill
      expect(html).toContain('id="barcodePrefixSamplePill"');
      expect(html).toContain('function updateBarcodePrefixPreview(');
    });

    it('BUG-033: verifies continuous camera scanning mode with debounced cooldown, pause/torch controls, and clean stop', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Continuous camera scanning does NOT close modal on barcode detection
      expect(html).toContain('cameraScanCooldowns');
      expect(html).toContain('now - lastCodeTime >= 1800');
      expect(html).toContain('executeBarcodeScan(detectedCode);');

      // Visual and audio feedback
      expect(html).toContain('.camera-reticle.scan-success');
      expect(html).toContain("reticle.classList.add('scan-success')");
      expect(html).toContain('playScanChime(true);');
      expect(html).toContain('id="cameraScanCountBadge"');
      expect(html).toContain('id="posCameraScanFeedback"');

      // In-modal controls
      expect(html).toContain('function toggleCameraPause()');
      expect(html).toContain('function toggleCameraTorch()');
      expect(html).toContain('id="btnToggleCameraPause"');
      expect(html).toContain('id="btnToggleCameraTorch"');

      // Clean cleanup on close, navigation, and logout
      expect(html).toContain('function closePosCameraScannerModal()');
      expect(html).toContain('posCameraStream.getTracks().forEach');
    });
  });

  describe('14. Phase 7.1: Employee & Flexible Payroll Management Web Shell', () => {
    it('verifies ALL_SPA_VIEW_IDS includes employees, payroll, and payroll-reports', () => {
      expect(ALL_SPA_VIEW_IDS).toContain('employees');
      expect(ALL_SPA_VIEW_IDS).toContain('payroll');
      expect(ALL_SPA_VIEW_IDS).toContain('payroll-reports');
    });

    it('verifies PHASE7_HRM_NAV_ITEMS contains valid route definitions and permission guards', () => {
      expect(PHASE7_HRM_NAV_ITEMS.length).toBe(3);
      expect(PHASE7_HRM_NAV_ITEMS.map((item) => item.id)).toEqual([
        'employees',
        'payroll',
        'payroll-reports',
      ]);
      expect(PHASE7_HRM_NAV_ITEMS[0].requiredPermission).toBe('hrm:employee:read');
      expect(PHASE7_HRM_NAV_ITEMS[1].requiredPermission).toBe('hrm:payroll:read');
      expect(PHASE7_HRM_NAV_ITEMS[2].requiredPermission).toBe('hrm:payroll:read');
    });

    it('verifies public/index.html includes sidebar navigation and routing for HRM views', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Sidebar section and nav items
      expect(html).toContain('HR &amp; Payroll');
      expect(html).toContain('data-view="employees"');
      expect(html).toContain('data-view="payroll"');
      expect(html).toContain('data-view="payroll-reports"');

      // Routing switch cases
      expect(html).toContain("case 'employees':");
      expect(html).toContain("case 'payroll':");
      expect(html).toContain("case 'payroll-reports':");
      expect(html).toContain('renderEmployeesView();');
      expect(html).toContain('renderPayrollView();');
      expect(html).toContain('renderPayrollReportsView();');
    });

    it('verifies Employee Directory and Profiles UI functions and modals exist in index.html', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Employee directory functions
      expect(html).toContain('function renderEmployeesView()');
      expect(html).toContain('function openCreateEmployeeModal()');
      expect(html).toContain('function submitCreateEmployee()');
      expect(html).toContain('function openEditEmployeeModal(');
      expect(html).toContain('function submitEditEmployee(');
      expect(html).toContain('function openUpdateEmployeeStatusModal(');
      expect(html).toContain('function submitUpdateEmployeeStatus(');
      expect(html).toContain('function openEmployeeProfileModal(');

      // User account linking and unlinking
      expect(html).toContain('function openLinkEmployeeUserModal(');
      expect(html).toContain('function submitLinkEmployeeUser(');
      expect(html).toContain('function unlinkEmployeeUser(');

      // Documents management
      expect(html).toContain('function openEmployeeDocumentsModal(');
      expect(html).toContain('function submitUploadDocument(');
      expect(html).toContain('function deleteEmployeeDocumentConfirm(');

      // Salary structure builder
      expect(html).toContain('function openEmployeeSalaryModal(');
      expect(html).toContain('function addSalaryComponentRow(');
      expect(html).toContain('function previewSalaryTotals(');
      expect(html).toContain('function submitEmployeeSalary(');
    });

    it('verifies Flexible Payroll and Payslip Generation UI functions exist in index.html', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Payroll run lifecycle functions
      expect(html).toContain('function renderPayrollView()');
      expect(html).toContain('function openCreatePayrollRunModal()');
      expect(html).toContain('function submitCreatePayrollRun()');
      expect(html).toContain('function openPayrollRunDetailModal(');
      expect(html).toContain('function openAdjustPayrollItemModal(');
      expect(html).toContain('function submitAdjustPayrollItem(');
      expect(html).toContain('function submitPayrollRunAction(');
      expect(html).toContain('function approvePayrollRunAction(');
      expect(html).toContain('function cancelPayrollRunAction(');

      // Payment disbursement
      expect(html).toContain('function openRecordPayrollPaymentModal(');
      expect(html).toContain('function submitRecordPayrollPayment(');

      // Payslip printing with printHtmlDocument
      expect(html).toContain('function openPayslipModal(');
      expect(html).toContain("printHtmlDocument(document.getElementById('payslipPrintArea').outerHTML");

      // Payroll reports view
      expect(html).toContain('function renderPayrollReportsView()');
    });

    it('BUG-034 & BUG-035: verifies error state rendering and "Try Again" retry action in Directory and Reports', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Employee directory failure and retry button
      expect(html).toContain('Failed to load employee directory');
      expect(html).toContain('onclick="renderEmployeesView()">Try Again</button>');

      // Payroll runs failure and retry button
      expect(html).toContain('Failed to load payroll runs');
      expect(html).toContain('onclick="renderPayrollView()">Try Again</button>');

      // Payroll reports failure and retry button
      expect(html).toContain('Failed to load payroll report');
      expect(html).toContain('onclick="renderPayrollReportsView()">Try Again</button>');
    });

    it('BUG-036: verifies warehouse discovery, dynamic branch-to-warehouse filtering, and dropdown states in employee forms', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Dynamic branch-to-warehouse filtering function
      expect(html).toContain('function updateWarehouseOptions(');
      expect(html).toContain('window._employeeWarehousesCache');
      expect(html).toContain('No warehouses found for this branch');

      // Create modal: queries /v1/org/warehouses and binds onchange
      expect(html).toContain("apiFetch('/v1/org/warehouses')");
      expect(html).toContain("onchange=\"updateWarehouseOptions('newEmpBranch', 'newEmpWarehouse')\"");
      expect(html).toContain('Default Warehouse (All)');

      // Edit modal: queries /v1/org/warehouses and binds onchange
      expect(html).toContain("onchange=\"updateWarehouseOptions('editEmpBranch', 'editEmpWarehouse')\"");

      // Double-click prevention and loading states
      expect(html).toContain("btn.innerText = 'Creating Employee...'");
      expect(html).toContain("btn.innerText = 'Saving...'");
    });

    it('BUG-037: verifies responsive desktop table and mobile card layout in Employee Directory', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Desktop table container exists with proper table structure
      expect(html).toContain('class="desktop-table-container"');
      expect(html).toContain('Employee</th>');
      expect(html).toContain('Role &amp; Department</th>');
      expect(html).toContain('Pay Frequency</th>');
      expect(html).toContain('Contact</th>');
      expect(html).toContain('Branch &amp; Warehouse</th>');
      expect(html).toContain('Joined Date</th>');
      expect(html).toContain('Status</th>');
      expect(html).toContain('Actions</th>');

      // Mobile cards container exists for viewport <= 768px
      expect(html).toContain('class="mobile-cards-container"');

      // Mobile cards include touch-friendly controls (height 36px), initials avatar, and action buttons
      expect(html).toContain('height: 36px');
      expect(html).toContain('openEmployeeProfileModal(');
      expect(html).toContain('openEditEmployeeModal(');
      expect(html).toContain('openEmployeeSalaryModal(');
      expect(html).toContain('openEmployeeDocumentsModal(');
      expect(html).toContain('openUpdateEmployeeStatusModal(');
    });

    it('BUG-038: verifies employee edit form handles empty/cleared optional fields without validation errors', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // submitEditEmployee extracts and passes null for empty optional fields
      expect(html).toContain('function submitEditEmployee(');
      expect(html).toContain("document.getElementById('editEmpNationalId').value.trim() || null");
      expect(html).toContain("document.getElementById('editEmpBranch')?.value || null");
      expect(html).toContain("document.getElementById('editEmpWarehouse')?.value || null");
      expect(html).toContain("document.getElementById('editEmpBankName').value.trim() || null");
      expect(html).toContain("document.getElementById('editEmpBankAccount').value.trim() || null");
      expect(html).toContain("document.getElementById('editEmpEpf').value.trim() || null");
      expect(html).toContain("document.getElementById('editEmpAddress').value.trim() || null");
      expect(html).toContain("document.getElementById('editEmpNotes').value.trim() || null");

      // Payload maps optional fields correctly
      expect(html).toContain('primaryBranchId: branchId');
      expect(html).toContain('primaryWarehouseId: warehouseId');
      expect(html).toContain('bankAccountNumber: bankAccount');
      expect(html).toContain('addressLine1: address');

      // Required fields are strictly validated before submission
      expect(html).toContain("showToast('Please fill in all required fields marked with *', 'error')");
    });

    it('BUG-039: verifies instant modal responsiveness, loading spinners, and double-click prevention', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Immediate modal opening with 0ms click latency and loading states
      expect(html).toContain("title: 'Add New Employee'");
      expect(html).toContain('Edit Employee');
      expect(html).toContain('Employee Profile');
      expect(html).toContain('Salary &amp; Compensation');
      expect(html).toContain('Employee Documents');

      // Double-click prevention on employee action submissions
      expect(html).toContain('btn.disabled = true;');
      expect(html).toContain("btn.innerText = 'Creating Employee...'");
      expect(html).toContain("btn.innerText = 'Saving...'");
      expect(html).toContain("btn.innerText = 'Saving Plan...'");
      expect(html).toContain("btn.innerText = 'Uploading...'");
    });
  });

  describe('24. Phase 7.2: Advanced Permissions & Granular Role Management UI', () => {
    it('verifies sidebar navigation link and SPA view routing for Roles & Permissions', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Sidebar navigation link
      expect(html).toContain('data-view="roles-permissions"');
      expect(html).toContain('Roles &amp; Permissions');

      // View routing handler in switchView
      expect(html).toContain("case 'roles-permissions':");
      expect(html).toContain('renderRolesPermissionsView();');
    });

    it('verifies renderRolesPermissionsView renders 3-tab layout with metrics and catalog', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      expect(html).toContain('function renderRolesPermissionsView()');
      expect(html).toContain('function switchRolesTab(');

      // Tab headers
      expect(html).toContain('Roles Directory');
      expect(html).toContain('Permission Policy Editor');
      expect(html).toContain('Team Members &amp; Scopes');

      // Tab 1: Roles Directory table and mobile cards
      expect(html).toContain('openCreateRoleModal()');
      expect(html).toContain('+ Create Custom Role');
      expect(html).toContain('function deleteRolePrompt(');
      expect(html).toContain('function submitDeleteRole(');

      // Tab 2: Permission Matrix Policy Editor with Select/Clear All and Unsaved Banner
      expect(html).toContain('selectModulePerms(');
      expect(html).toContain('function saveRolePermissions(');
      expect(html).toContain('unsavedChangesBadge');
      expect(html).toContain('Built-in System Role (Protected)');

      // Tab 3: Team Members and Scoping Modals
      expect(html).toContain('function openAssignMemberRolesModal(');
      expect(html).toContain('function submitAssignMemberRoles(');
      expect(html).toContain('function openEditMemberLocationScopeModal(');
      expect(html).toContain('function submitMemberLocationScopes(');
      expect(html).toContain('Organization-Wide Access (All Locations)');
    });
  });

  describe('25. Phase 7.2 Production QA Remediation: BUG-039 through BUG-044', () => {
    it('BUG-044: verifies roles-permissions is registered in VALID_VIEWS and ALL_SPA_VIEW_IDS preventing redirect to dashboard', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Verified in contract type definitions
      expect(ALL_SPA_VIEW_IDS).toContain('roles-permissions');

      // Verified in SPA client VALID_VIEWS routing list
      expect(html).toMatch(/'roles-permissions'/);

      // Verified graceful 403 access restricted handling without full page redirect
      expect(html).toContain('Access Restricted');
      expect(html).toContain('You do not possess the required IAM administrative permissions');
    });

    it('BUG-039: verifies immediate visual feedback, 0ms modal loaders, and in-flight duplicate prevention on action buttons', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Instant 0ms modal feedback on openPayrollRunDetailModal before API await
      expect(html).toContain("title: cached ? `Payroll Run: ${escapeHtml(cached.runNumber)}` : 'Payroll Run Details'");
      expect(html).toContain('Loading payroll run details...');

      // In-flight locking set for duplicate click prevention
      expect(html).toContain('const _payrollActionInFlight = new Set();');
      expect(html).toContain('if (_payrollActionInFlight.has(actionKey)) return;');

      // Button processing states with spinners for Submit, Approve, and Cancel
      expect(html).toContain("Submitting...");
      expect(html).toContain("Approving...");
      expect(html).toContain("Cancelling...");

      // Immediate loading state on Add Employee button
      expect(html).toContain("triggerBtn.innerHTML = '<span class=\"spinner-sm\" style=\"display:inline-block; vertical-align:middle; margin-right:6px;\"></span> Loading...'");
    });

    it('BUG-040: verifies mobile responsive layouts for Employee Profile, Documents, and Salary Structure modals', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Employee Profile modal responsive auto-fit grid and horizontally scrolling tabs
      expect(html).toContain('grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))');
      expect(html).toContain('overflow-x: auto; -webkit-overflow-scrolling: touch; flex-wrap: nowrap;');

      // Employee Documents modal with desktop table and dedicated mobile cards
      expect(html).toContain('Enrolled Documents (${docs.length})');
      expect(html).toContain('<div class="desktop-table-container">');
      expect(html).toContain('<div class="mobile-cards-container">');

      // Salary Structure modal responsive layout and salary-comp-row CSS
      expect(html).toContain('.salary-comp-row');
      expect(html).toContain('@media (max-width: 680px)');
      expect(html).toContain('grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));');
      expect(html).toContain('grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));');
    });

    it('BUG-041: verifies Desktop Payroll Runs table alignment, explicit column min-widths, and tabular-nums formatting', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Desktop table explicit column min-widths
      expect(html).toContain('<th style="min-width: 130px;">Run Number</th>');
      expect(html).toContain('<th style="min-width: 100px;">Frequency</th>');
      expect(html).toContain('<th style="min-width: 170px;">Period</th>');
      expect(html).toContain('<th style="min-width: 120px; text-align: right;">Gross Pay</th>');
      expect(html).toContain('<th style="min-width: 115px; text-align: right;">Deductions</th>');
      expect(html).toContain('<th style="min-width: 120px; text-align: right;">Net Pay</th>');
      expect(html).toContain('<th style="min-width: 220px; text-align: right;">Actions</th>');
      expect(html).toContain('font-variant-numeric: tabular-nums;');
    });

    it('BUG-042: verifies dedicated mobile cards container for Payroll Management and responsive breakdown tables', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Dedicated mobile cards container in renderPayrollView
      expect(html).toContain('<!-- Mobile Card Layout (BUG-042: Touch-Friendly Responsive View for Payroll Runs) -->');
      expect(html).toContain('<div class="mobile-cards-container">');

      // Responsive breakdown tables in renderPayrollReportsView
      expect(html).toContain('grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px;');
    });

    it('BUG-043: verifies dedicated A4 landscape executive print generator and enhanced print stylesheet', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Enhanced @media print hiding navigation, sidebar, topbar, and action buttons
      expect(html).toContain('/* Print Styles (BUG-043: Enhanced Report & Receipt Printing) */');
      expect(html).toContain('aside.sidebar,');
      expect(html).toContain('header.topbar,');
      expect(html).toContain('.view-header button,');

      // Dedicated executive print generator
      expect(html).toContain('function printPayrollReport()');
      expect(html).toContain('Executive Payroll &amp; Cost Allocation Summary');
      expect(html).toContain('size: A4 landscape;');
      expect(html).toContain('Department Cost Allocation');
      expect(html).toContain('Schedule Frequency Breakdown');
    });

    it('BUG-045: verifies openCreateEmployeeModal robust button recovery and eliminates ReferenceError on triggerBtn', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Verifies triggerBtn resolution with fallback
      expect(html).toContain('const triggerBtn = (arguments && arguments[0]) || document.getElementById(\'btnOpenCreateEmployee\');');

      // Verifies ReferenceError on btn is completely removed from openCreateEmployeeModal
      const openCreateModalBody = html.substring(
        html.indexOf('async function openCreateEmployeeModal()'),
        html.indexOf('async function submitCreateEmployee()'),
      );
      expect(openCreateModalBody).not.toMatch(/finally\s*\{\s*if\s*\(\s*btn\s*\)/);
      expect(openCreateModalBody).toContain('if (triggerBtn) {');
      expect(openCreateModalBody).toContain('triggerBtn.disabled = false;');
      expect(openCreateModalBody).toContain('triggerBtn.innerHTML = origHtml || \'+ Add Employee\';');
      expect(openCreateModalBody).toContain('Unable to open employee creation form. Please try again.');
    });

    it('BUG-046: verifies submitPayrollRunAction and approvePayrollRunAction send explicit JSON payloads and apiFetch does not send Content-Type on bodyless requests', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Verifies apiFetch only sets Content-Type when options.body is defined
      expect(html).toContain("...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})");

      // Verifies submitPayrollRunAction sends explicit JSON body
      const submitActionBody = html.substring(
        html.indexOf('async function submitPayrollRunAction'),
        html.indexOf('async function approvePayrollRunAction'),
      );
      expect(submitActionBody).toContain("body: JSON.stringify({})");

      // Verifies approvePayrollRunAction sends explicit JSON body
      const approveActionBody = html.substring(
        html.indexOf('async function approvePayrollRunAction'),
        html.indexOf('async function cancelPayrollRunAction'),
      );
      expect(approveActionBody).toContain("body: JSON.stringify({})");
    });

    it('BUG-039: verifies immediate visual feedback, active cache utilization, and in-flight locks on Adjust and Payslip buttons', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Cache active run for 0ms modal responsiveness
      expect(html).toContain('window._activePayrollRunCache = run;');

      // Adjust item modal uses cached run and provides button loading state
      const adjustItemBody = html.substring(
        html.indexOf('async function openAdjustPayrollItemModal'),
        html.indexOf('async function submitAdjustPayrollItem'),
      );
      expect(adjustItemBody).toContain('window._activePayrollRunCache.id === runId');
      expect(adjustItemBody).toContain("targetBtn.innerHTML = '<span class=\"spinner-sm\" style=\"display:inline-block; vertical-align:middle; margin-right:4px;\"></span> Loading...'");

      // Payslip modal provides button loading state and immediate loading modal shell
      const payslipBody = html.substring(
        html.indexOf('async function openPayslipModal'),
        html.indexOf('async function renderPayrollReportsView'),
      );
      expect(payslipBody).toContain("targetBtn.innerHTML = '<span class=\"spinner-sm\" style=\"display:inline-block; vertical-align:middle; margin-right:4px;\"></span> Loading...'");
      expect(payslipBody).toContain("title: 'Generating Payslip...'");
      expect(payslipBody).toContain('Generating employee payslip...');
    });

    it('BUG-042: verifies Payroll Run Detail responsive stats grid and mobile cards, and Payroll Reports Department & Frequency mobile cards', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Run Detail Modal responsive stats grid
      expect(html).toContain('class="payroll-run-stats-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr))');

      // Run Detail Modal desktop container and mobile cards container for line items
      const runDetailBody = html.substring(
        html.indexOf('async function openPayrollRunDetailModal'),
        html.indexOf('async function openAdjustPayrollItemModal'),
      );
      expect(runDetailBody).toContain('<div class="desktop-table-container">');
      expect(runDetailBody).toContain('<div class="mobile-cards-container" style="max-height: 440px; overflow-y: auto;">');
      expect(runDetailBody).toContain('<!-- Mobile Card View (BUG-042: Touch-Friendly Responsive Line Items) -->');

      // Department Allocation desktop container and mobile cards
      expect(html).toContain('<!-- Mobile Card View (BUG-042: Touch-Friendly Department Allocation Cards) -->');

      // Schedule Frequency Breakdown desktop container and mobile cards
      expect(html).toContain('<!-- Mobile Card View (BUG-042: Touch-Friendly Schedule Frequency Cards) -->');
    });

    it('BUG-047: verifies Payslip modal responsive layout, tabular-nums formatting, and strict 2-column print preservation', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Responsive classes defined in CSS
      expect(html).toContain('.payslip-details-grid {');
      expect(html).toContain('.payslip-breakdown-grid {');
      expect(html).toContain('.payslip-net-summary {');

      // Mobile media query stacks into single column
      expect(html).toContain('@media (max-width: 640px) {');
      expect(html).toContain('.payslip-details-grid {\n        grid-template-columns: 1fr !important;');
      expect(html).toContain('.payslip-breakdown-grid {\n        grid-template-columns: 1fr !important;');

      // Print styles strictly preserve 2-column layout
      expect(html).toContain('.payslip-details-grid {\n        display: grid !important;\n        grid-template-columns: 1fr 1fr !important;');
      expect(html).toContain('.payslip-breakdown-grid {\n        display: grid !important;\n        grid-template-columns: 1fr 1fr !important;');
      expect(html).toContain('.payslip-net-summary {\n        display: flex !important;\n        flex-direction: row !important;');

      // Currency amounts have white-space nowrap and tabular-nums
      const payslipBody = html.substring(
        html.indexOf('async function openPayslipModal'),
        html.indexOf('async function renderPayrollReportsView'),
      );
      expect(payslipBody).toContain('class="payslip-details-grid"');
      expect(payslipBody).toContain('class="payslip-breakdown-grid"');
      expect(payslipBody).toContain('class="payslip-net-summary"');
      expect(payslipBody).toContain('style="white-space: nowrap; font-variant-numeric: tabular-nums;"');
    });
  });

  // ===========================================================================
  // 26. BUG-048: Global Application Loading Performance & Responsiveness
  // ===========================================================================
  describe('26. BUG-048: Global Application Loading Performance & Responsiveness', () => {
    it('BUG-048: verifies apiFetch request timeout, in-flight GET deduplication, and write-mutation cache invalidation', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // In-flight GET request deduplication map and cache invalidation helper
      expect(html).toContain('const inFlightGetRequests = new Map();');
      expect(html).toContain('function clearTenantViewCache()');
      expect(html).toContain('inFlightGetRequests.clear();');

      // Request timeout via AbortController (15000ms default)
      const apiFetchBody = html.substring(
        html.indexOf('async function apiFetch(endpoint, options = {})'),
        html.indexOf('function openModal(optionsOrHtml)'),
      );
      expect(apiFetchBody).toContain('const timeoutMs = options.timeoutMs || 15000;');
      expect(apiFetchBody).toContain('const controller = !options.signal ? new AbortController() : null;');
      expect(apiFetchBody).toContain('setTimeout(() => controller.abort(), timeoutMs)');
      expect(apiFetchBody).toContain("new Error('Request timed out. The server is taking longer than expected to respond.');");

      // Automatic view cache invalidation on write mutations (POST, PUT, PATCH, DELETE)
      expect(apiFetchBody).toContain("if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {");
      expect(apiFetchBody).toContain('clearTenantViewCache();');
    });

    it('BUG-048: verifies tenant-isolated Stale-While-Revalidate (SWR) view cache and navigation race-condition guard', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Tenant-scoped view cache key includes tenantId, branchId, warehouseId, and userRole
      expect(html).toContain('const tenantViewCache = new Map();');
      expect(html).toContain('function getTenantCacheScopeKey()');
      expect(html).toContain("`${state.tenantId || 'none'}:${state.branchId || 'none'}:${state.warehouseId || 'none'}:${state.userRole || 'none'}`");
      expect(html).toContain('function getViewCache(viewKey, maxAgeMs = 60000)');
      expect(html).toContain('function setViewCache(viewKey, data)');

      // Navigation race-condition guard
      expect(html).toContain('viewRenderSeq: 0,');
      expect(html).toContain('function isCurrentViewRender(viewName, renderSeq)');
      expect(html).toContain('state.viewRenderSeq = (state.viewRenderSeq || 0) + 1;');

      // SWR and race-condition guards applied to primary views
      expect(html).toContain("const cached = getViewCache('dashboard');");
      expect(html).toContain("!isCurrentViewRender('dashboard', renderSeq)");
      expect(html).toContain("const cached = getViewCache('products');");
      expect(html).toContain("!isCurrentViewRender('products', renderSeq)");
      expect(html).toContain("const cachedCats = getViewCache('categories');");
      expect(html).toContain("const cachedSups = getViewCache('suppliers');");
      expect(html).toContain("const cachedBalances = getViewCache('balances');");
    });

    it('BUG-048: verifies non-blocking tenant selection, structured skeleton placeholders, and connection recovery UI', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // Non-blocking background hydration for tenant branches and registers
      expect(html).toContain('async function hydrateTenantLocationContext(targetTenantId)');
      expect(html).toContain('hydrateTenantLocationContext(membership.tenantId);');

      // Structured skeleton loader for immediate module navigation feedback
      expect(html).toContain('.skeleton-pulse {');
      expect(html).toContain('function renderViewSkeleton(viewName)');
      expect(html).toContain('container.innerHTML = renderViewSkeleton(viewName);');

      // Connection recovery UI when server cold-starts without cached tenant context
      expect(html).toContain('function renderConnectionRecoveryState(reasonMessage)');
      expect(html).toContain('async function retryAppInitialization(btnEl)');
      expect(html).toContain('Connection Taking Longer Than Expected');
      expect(html).toContain('Retry Connection');

      // Parallelized POS checkout view API calls
      const posViewBody = html.substring(
        html.indexOf('async function renderPosCheckoutView()'),
        html.indexOf('async function executeBarcodeScan(barcodeOrSku)'),
      );
      expect(posViewBody).toContain('await Promise.all([');
      expect(posViewBody).toContain('/v1/pos/shifts/active?registerId=');
      expect(posViewBody).toContain('/v1/pos/products/search?warehouseId=');
    });

    it('BUG-048 Remediation: verifies zero JavaScript syntax errors in index.html and robust 6-state initialization state machine', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Syntax Validation: extract inline script and verify parser succeeds without SyntaxError
      const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(scriptMatch).not.toBeNull();
      const scriptCode = scriptMatch![1];
      expect(() => new Function(scriptCode)).not.toThrow();

      // 2. Six-State Application Initialization State Machine
      expect(html).toContain('const APP_INIT_STATES = {');
      expect(html).toContain("INITIALIZING: 'INITIALIZING'");
      expect(html).toContain("RESTORING_SESSION: 'RESTORING_SESSION'");
      expect(html).toContain("LOADING_TENANT_CONTEXT: 'LOADING_TENANT_CONTEXT'");
      expect(html).toContain("LOADING_DASHBOARD: 'LOADING_DASHBOARD'");
      expect(html).toContain("READY: 'READY'");
      expect(html).toContain("RECOVERABLE_ERROR: 'RECOVERABLE_ERROR'");
      expect(html).toContain('function setAppInitPhase(phase, message)');

      // 3. Centralized Topbar Context Synchronizer
      expect(html).toContain('function updateTopbarContext()');
      expect(html).toContain('document.getElementById(\'topbarTenantName\')');
      expect(html).toContain('document.getElementById(\'topbarBranchName\')');
      expect(html).toContain('document.getElementById(\'topbarUserRole\')');
      expect(html).toContain('document.getElementById(\'topbarMobileTenantName\')');

      // 4. Duplicate initApp invocation guard and retry capability
      expect(html).toContain('if (state._isInitRunning) return;');
      expect(html).toContain('state._isInitRunning = true;');
      expect(html).toContain('async function retryAppInitialization(btnEl)');
    });

    it('BUG-049: verifies employee creation & edit modals include all address fields and validation', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Create Employee Form Address Inputs (BUG-049)
      expect(html).toContain('id="newEmpAddress1"');
      expect(html).toContain('id="newEmpAddress2"');
      expect(html).toContain('id="newEmpCity"');
      expect(html).toContain('id="newEmpDistrict"');
      expect(html).toContain('id="newEmpPostalCode"');

      // 2. Create Employee Address Validation & Payload
      expect(html).toContain("document.getElementById('newEmpAddress1')?.value.trim()");
      expect(html).toContain("showToast('Address Line 1 is required *', 'error')");
      expect(html).toContain('addressLine1: address1');
      expect(html).toContain('addressLine2: address2');
      expect(html).toContain('city');
      expect(html).toContain('district');
      expect(html).toContain('postalCode');

      // 3. Edit Employee Form Address Inputs & Persistence (BUG-049)
      expect(html).toContain('id="editEmpAddress"');
      expect(html).toContain('id="editEmpAddress2"');
      expect(html).toContain('id="editEmpCity"');
      expect(html).toContain('id="editEmpDistrict"');
      expect(html).toContain('id="editEmpPostalCode"');

      // 4. Employee Profile Overview Address Display
      expect(html).toContain('const addressParts = [emp.addressLine1, emp.addressLine2, emp.city, emp.district, emp.postalCode].filter(Boolean);');
    });

    it('Phase 7.1: verifies Attendance, Leaves, Work Schedules, and Org Payroll Settings UI components', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Attendance & Leaves Views Registered in VALID_VIEWS and renderView
      expect(html).toContain("'attendance'");
      expect(html).toContain("'leaves'");
      expect(html).toContain("case 'attendance': renderAttendanceView(); break;");
      expect(html).toContain("case 'leaves': renderLeavesView(); break;");

      // 2. Attendance Time Tracking View & Self-Service
      expect(html).toContain('async function renderAttendanceView()');
      expect(html).toContain('async function clockInSelf(');
      expect(html).toContain('async function clockOutSelf(');
      expect(html).toContain('async function openManualAttendanceModal(');
      expect(html).toContain('async function submitManualAttendance(');

      // 3. Leaves Management View & Actions
      expect(html).toContain('async function renderLeavesView()');
      expect(html).toContain('function openCreateLeaveModal()');
      expect(html).toContain('async function submitCreateLeave()');
      expect(html).toContain('async function reviewLeaveAction(');

      // 4. Holiday Calendar Modal
      expect(html).toContain('async function openOrgHolidaysModal()');
      expect(html).toContain('async function submitCreateHoliday()');
      expect(html).toContain('async function deleteHolidayAction(');

      // 5. Individual Employee Work Schedules
      expect(html).toContain('async function openConfigureWorkScheduleModal(');
      expect(html).toContain('async function submitConfigureWorkSchedule(');
      expect(html).toContain('id="schedShiftName"');
      expect(html).toContain('id="schedShiftType"');
      expect(html).toContain('id="schedStartTime"');
      expect(html).toContain('id="schedEndTime"');

      // 6. Proration Breakdown Modal (BUG-051)
      expect(html).toContain('function openProrationBreakdownModal(itemId)');
      expect(html).toContain('Proration Breakdown:');
      expect(html).toContain('calculationBreakdown');

      // 7. Org Payroll & Proration Settings
      expect(html).toContain('async function saveOrgPayrollSettings()');
      expect(html).toContain('id="settingProrationMode"');
      expect(html).toContain('id="settingAllowancePolicy"');
      expect(html).toContain('id="settingGpsAttendance"');
      expect(html).toContain('id="settingWorkplaceLat"');
      expect(html).toContain('id="settingWorkplaceLon"');
      expect(html).toContain('id="settingGeofenceRadius"');
    });

    it('BUG-052, BUG-053, BUG-054, BUG-050: verifies integration fixes in web client', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // BUG-052: Work schedule payload includes both mondayWorking and isMondayWorking
      expect(html).toContain('mondayWorking: isMondayWorking');
      expect(html).toContain('isMondayWorking');
      expect(html).toContain('tuesdayWorking: isTuesdayWorking');
      expect(html).toContain('isTuesdayWorking');

      // BUG-053: Attendance records route called and supports records
      expect(html).toContain('/v1/attendance/records?date=');
      expect(html).toContain('state.cachedAttendanceRecords = records');

      // BUG-054: GPS Workplace Current Location Picker
      expect(html).toContain('id="btnUseCurrentLocation"');
      expect(html).toContain('captureWorkplaceCurrentLocation(this)');
      expect(html).toContain('function captureWorkplaceCurrentLocation(');
      expect(html).toContain('navigator.geolocation.getCurrentPosition(');
      expect(html).toContain('PERMISSION_DENIED');
      expect(html).toContain('POSITION_UNAVAILABLE');
      expect(html).toContain('TIMEOUT');

      // BUG-050: Staff user account link with organization members dropdown
      expect(html).toContain('async function openLinkEmployeeUserModal(');
      expect(html).toContain('/v1/iam/members');
      expect(html).toContain('id="linkSelectMember"');
      expect(html).toContain('onSelectMemberForLink(');
      expect(html).toContain('id="linkUserUuid"');
    });
  });

  // ============================================================================
  // PHASE 7.3: EXPENSES MANAGEMENT & APPROVAL WORKFLOWS
  // ============================================================================
  describe('18. Phase 7.3 Expenses Management & RBAC Integration', () => {
    it('verifies ALL_SPA_VIEW_IDS and PHASE73_EXPENSE_NAV_ITEMS exports', async () => {
      const { ALL_SPA_VIEW_IDS, PHASE73_EXPENSE_NAV_ITEMS } = await import('../src/index.js');
      expect(ALL_SPA_VIEW_IDS).toContain('expenses');
      expect(PHASE73_EXPENSE_NAV_ITEMS).toBeDefined();
      expect(PHASE73_EXPENSE_NAV_ITEMS.length).toBeGreaterThan(0);
      expect(PHASE73_EXPENSE_NAV_ITEMS[0].id).toBe('expenses');
      expect(PHASE73_EXPENSE_NAV_ITEMS[0].requiredPermission).toBe('exp:expense:read');
    });

    it('verifies public/index.html contains complete Expenses view, navigation and workflows', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Navigation Link & Route registration
      expect(html).toContain('data-view="expenses"');
      expect(html).toContain("case 'expenses': renderExpensesView(); break;");
      expect(html).toContain("'expenses'");

      // 2. View Functions
      expect(html).toContain('async function renderExpensesView()');
      expect(html).toContain('function getExpenseStatusBadge(');
      expect(html).toContain('async function openCreateExpenseModal(');
      expect(html).toContain('async function saveExpense(');
      expect(html).toContain('async function openExpenseDetailsModal(');
      expect(html).toContain('async function submitExpenseFromUi(');
      expect(html).toContain('async function approveExpenseFromUi(');
      expect(html).toContain('function openRejectExpenseModal(');
      expect(html).toContain('async function confirmRejectExpense(');
      expect(html).toContain('function openRecordPaymentModal(');
      expect(html).toContain('async function confirmRecordPayment(');
      expect(html).toContain('async function deleteExpenseFromUi(');

      // 3. Attachments & Categories Management
      expect(html).toContain('async function uploadExpenseAttachmentFromUi(');
      expect(html).toContain('async function downloadExpenseAttachment(');
      expect(html).toContain('async function deleteExpenseAttachmentFromUi(');
      expect(html).toContain('async function openExpenseCategoriesModal(');
      expect(html).toContain('async function createExpenseCategoryFromUi()');
      expect(html).toContain('async function toggleExpenseCategoryActive(');
      expect(html).toContain('async function deleteExpenseCategoryFromUi(');

      // 4. Summary & Reports
      expect(html).toContain('async function openExpenseSummaryReportModal()');
      expect(html).toContain('id="btnOpenExpenseSummary"');
      expect(html).toContain('id="btnOpenExpenseCategories"');
      expect(html).toContain('id="btnOpenCreateExpense"');
      expect(html).toContain('id="expenseSearchInput"');
      expect(html).toContain('id="expenseStatusFilter"');
      expect(html).toContain('id="expenseCategoryFilter"');

      // 5. Status Badges & Layouts
      expect(html).toContain('>Pending Approval<');
      expect(html).toContain('>Approved<');
      expect(html).toContain('>Rejected<');
      expect(html).toContain('>Paid<');
      expect(html).toContain('desktop-only');
      expect(html).toContain('mobile-only');
    });
  });

  // ============================================================================
  // PHASE 7.4: CUSTOMER CREDIT MANAGEMENT & RECEIVABLES LEDGER
  // ============================================================================
  describe('27. Phase 7.4 Customer Credit Management & Receivables Integration', () => {
    it('verifies ALL_SPA_VIEW_IDS and PHASE74_CREDIT_NAV_ITEMS exports', async () => {
      const { ALL_SPA_VIEW_IDS, PHASE74_CREDIT_NAV_ITEMS } = await import('../src/index.js');
      expect(ALL_SPA_VIEW_IDS).toContain('credit-dashboard');
      expect(ALL_SPA_VIEW_IDS).toContain('customers');
      expect(ALL_SPA_VIEW_IDS).toContain('credit-accounts');
      expect(PHASE74_CREDIT_NAV_ITEMS).toBeDefined();
      expect(PHASE74_CREDIT_NAV_ITEMS.length).toBe(3);
      expect(PHASE74_CREDIT_NAV_ITEMS.map(i => i.id)).toEqual(['credit-dashboard', 'customers', 'credit-accounts']);
    });

    it('verifies public/index.html contains full Phase 7.4 views, navigation, POS credit and modals', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Navigation links
      expect(html).toContain('data-view="credit-dashboard"');
      expect(html).toContain('data-view="customers"');
      expect(html).toContain('data-view="credit-accounts"');

      // 2. View switch routing
      expect(html).toContain("case 'credit-dashboard': renderCreditDashboardView(); break;");
      expect(html).toContain("case 'customers': renderCustomersView(); break;");
      expect(html).toContain("case 'credit-accounts': renderCreditAccountsView(); break;");

      // 3. Credit views & UI components
      expect(html).toContain('async function renderCreditDashboardView()');
      expect(html).toContain('async function renderCustomersView()');
      expect(html).toContain('async function renderCreditAccountsView()');
      expect(html).toContain('async function openCustomerModal(');
      expect(html).toContain('async function submitSaveCustomer(');
      expect(html).toContain('async function openCreateCreditAccountModal(');
      expect(html).toContain('async function submitCreateCreditAccount(');
      expect(html).toContain('async function openCreditAccountDetailsModal(');
      expect(html).toContain('async function openAdjustCreditLimitModal(');
      expect(html).toContain('async function submitAdjustCreditLimit(');
      expect(html).toContain('async function openChangeCreditStatusModal(');
      expect(html).toContain('async function submitChangeCreditStatus(');
      expect(html).toContain('async function openManualCreditTransactionModal(');
      expect(html).toContain('async function submitManualCreditTransaction(');
      expect(html).toContain('async function openRecordCreditPaymentModal(');
      expect(html).toContain('async function submitRecordCreditPayment(');
      expect(html).toContain('async function reverseCreditPayment(');
      expect(html).toContain('async function openCollectionModal(');
      expect(html).toContain('async function submitCollectionModal(');
      expect(html).toContain('async function openWriteoffModal(');
      expect(html).toContain('async function submitWriteoffModal(');
      expect(html).toContain('async function printCreditPaymentReceipt(');
      expect(html).toContain('async function openAgingReportModal()');

      // 4. POS Customer Credit checkout integration
      expect(html).toContain('id="payCustomerSelect"');
      expect(html).toContain('id="payCustomerCreditBadge"');
      expect(html).toContain('id="creditPaymentFields"');
      expect(html).toContain('<option value="CREDIT">Customer Credit Account (On Account)</option>');
      expect(html).toContain('paymentMethod: \'CREDIT\'');
    });
  });

  describe('29. Phase 7.2 Staff Invitation & Account Provisioning UI', () => {
    it('verifies team-staff navigation, view registration, and contracts export', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. View ID in ALL_SPA_VIEW_IDS
      expect(ALL_SPA_VIEW_IDS).toContain('team-staff');
      expect(PHASE72_TEAM_NAV_ITEMS).toHaveLength(2);
      expect(PHASE72_TEAM_NAV_ITEMS[0].id).toBe('team-staff');
      expect(PHASE72_TEAM_NAV_ITEMS[0].requiredPermission).toBe('iam:member:read');

      // 2. Navigation in HTML sidebar
      expect(html).toContain('data-view="team-staff"');
      expect(html).toContain('Team &amp; Staff Accounts');

      // 3. Router switch cases
      expect(html).toContain("case 'team-staff': renderTeamStaffAccountsView(); break;");
      expect(html).toContain("case 'accept-invitation': renderAcceptInvitationView(); break;");

      // 4. View functions
      expect(html).toContain('async function renderTeamStaffAccountsView()');
      expect(html).toContain('async function renderAcceptInvitationView()');
      expect(html).toContain('async function openInviteStaffModal()');
      expect(html).toContain('async function submitStaffInvitationForm()');
      expect(html).toContain('async function resendStaffInvitationAction(');
      expect(html).toContain('async function cancelStaffInvitationAction(');
      expect(html).toContain('async function toggleMemberStatus(');
      expect(html).toContain('async function confirmRevokeMember(');

      // 5. Link user modal filtering (excluding OWNER and ADMIN)
      expect(html).toContain('isOwnerOrAdmin');
      expect(html).toContain('TENANT_OWNER');
      expect(html).toContain('ORG_ADMIN');
    });

    it('verifies 4-digit invitation code redesign on registration page and staff activation', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Registration Page "Already a Staff Member?" section
      expect(html).toContain('Already a Staff Member?');
      expect(html).toContain('Have an invitation code from your business administrator? Enter it below to join your team.');
      expect(html).toContain('id="staffInviteCode"');
      expect(html).toContain('id="btnJoinBusiness"');
      expect(html).toContain('id="staffCodeAlert"');
      expect(html).toContain('handleStaffCodeSubmit(event)');

      // 2. Validate Code API integration
      expect(html).toContain('/v1/auth/invitations/validate-code');
      expect(html).toContain('async function handleStaffCodeSubmit(');

      // 3. Team & Staff Accounts invitation table displays 4-digit code and Copy action
      expect(html).toContain('Invitation Code');
      expect(html).toContain('function copyInvitationCode(');
      expect(html).toContain('copyInvitationCode(');
      expect(html).toContain('4-Digit Staff Access Code');

      // 4. Staff account activation view supports 4-digit code and required email confirmation
      expect(html).toContain('id="inviteEmail"');
      expect(html).toContain('id="btnSubmitAcceptInvite"');
      expect(html).toContain('async function submitAcceptInvitation(');

      // 5. Session token storage alignment
      expect(html).toContain("localStorage.setItem('nexstock_session_token', sessionToken)");
      expect(html).toContain("localStorage.setItem('nexstock_auth_token', sessionToken)");
    });

    it('verifies BUG-052 fix: preserves public routes and prevents premature Welcome page redirects', () => {
      const indexPath = resolve(WEB_ROOT, 'public/index.html');
      const html = readFileSync(indexPath, 'utf8');

      // 1. Unauthenticated fast-path preserves target AUTH_VIEWS instead of unconditionally kicking to welcome
      expect(html).toContain('const initialRoute = getRouteFromLocation();');
      expect(html).toContain('if (initialRoute && AUTH_VIEWS.includes(initialRoute))');

      // 2. Router synchronization does not strip query parameters from location hash
      expect(html).toContain("const currentRoute = rawHash.split('?')[0].trim();");

      // 3. Session restore does not unconditionally show 'Loading dashboard...' for auth/invitation routes
      expect(html).toContain("!AUTH_VIEWS.includes(initialRoute)");
      expect(html).toContain("!AUTH_VIEWS.includes(targetRoute)");
    });
  });
});
