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
      expect(html).toContain("if (!storedToken) {\n        renderView('welcome');");
      expect(html).toContain("renderView('welcome');\n          return;");

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
});
