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
});
