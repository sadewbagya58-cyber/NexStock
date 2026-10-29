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
});
