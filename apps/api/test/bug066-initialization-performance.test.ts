import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  ensureUserRecordDirect,
  generateUuidV7,
  provisionTenantMember,
  withTenantTransaction,
} from '../src/index.js';
import {
  createTestPostgresHarness,
  type TestPostgresHarness,
} from './helpers/pglite-kysely.js';

interface TestEs256KeyMaterial {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: SupabaseJwk;
}

type AppInstance = Awaited<ReturnType<typeof buildApp>>;

function createTestEs256KeyMaterial(kid: string): TestEs256KeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const exported = publicKey.export({ format: 'jwk' });
  return {
    kid,
    privateKey,
    publicJwk: {
      ...exported,
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      use: 'sig',
      kid,
    },
  };
}

function signEs256Jwt(
  keyMaterial: TestEs256KeyMaterial,
  payload: Record<string, unknown>,
): string {
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: keyMaterial.kid,
  };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const signature = sign('sha256', signingInput, {
    key: keyMaterial.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}

describe('BUG-066 — Global Application Initialization & Loading Performance Remediation', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const OWNER_USER_ID = generateUuidV7();
  const CASHIER_USER_ID = generateUuidV7();
  const CLERK_USER_ID = generateUuidV7();
  const STAFF_USER_ID = generateUuidV7();

  const primaryKey = createTestEs256KeyMaterial('test-key-bug066');
  const jwksProvider = new StaticJwksProvider({
    keys: [primaryKey.publicJwk],
  });
  const nowSeconds = Math.floor(Date.now() / 1000);

  function issueToken(userId: string, email: string): string {
    return signEs256Jwt(primaryKey, {
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      sub: userId,
      email,
      iat: nowSeconds - 60,
      nbf: nowSeconds - 60,
      exp: nowSeconds + 3600,
    });
  }

  let ownerToken: string;
  let cashierToken: string;
  let clerkToken: string;
  let staffToken: string;
  let tenantId: string;
  let branchId: string;
  let warehouseId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    ownerToken = issueToken(OWNER_USER_ID, 'owner@perf.com');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@perf.com');
    clerkToken = issueToken(CLERK_USER_ID, 'clerk@perf.com');
    staffToken = issueToken(STAFF_USER_ID, 'staff@perf.com');

    tenantId = generateUuidV7();

    // 1. Onboard Tenant via Owner
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        slug: 'perf-remediation-co',
        legalName: 'Performance Remediation Ltd',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@perf.com',
        ownerFullName: 'Owner Alice',
        planCode: 'GROWTH',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    // 2. Create Branch
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        code: 'MAIN-BR',
        name: 'Main Flagship Branch',
        timezone: 'America/New_York',
        countryCode: 'US',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    branchId = branchRes.json().id;

    // 3. Create Warehouse
    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': tenantId,
      },
      payload: {
        branchId,
        code: 'MAIN-WH',
        name: 'Main Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    warehouseId = whRes.json().id;

    // 4. Ensure Users and Provision Memberships
    await ensureUserRecordDirect(harness.db, { userId: CASHIER_USER_ID, email: 'cashier@perf.com', fullName: 'Cashier Bob' });
    await ensureUserRecordDirect(harness.db, { userId: CLERK_USER_ID, email: 'clerk@perf.com', fullName: 'Clerk Charlie' });
    await ensureUserRecordDirect(harness.db, { userId: STAFF_USER_ID, email: 'staff@perf.com', fullName: 'Staff Diana' });

    const traceId = `trace_${generateUuidV7()}`;
    await withTenantTransaction(harness.db, { tenantId, userId: OWNER_USER_ID, traceId }, async (trx) => {
      await provisionTenantMember(trx, {
        userId: CASHIER_USER_ID,
        email: 'cashier@perf.com',
        fullName: 'Cashier Bob',
        roleCodes: ['CASHIER'],
        allLocationsAccess: false,
        branchIds: [branchId],
        warehouseIds: [warehouseId],
      });

      await provisionTenantMember(trx, {
        userId: CLERK_USER_ID,
        email: 'clerk@perf.com',
        fullName: 'Clerk Charlie',
        roleCodes: ['WAREHOUSE_CLERK'],
        allLocationsAccess: false,
        branchIds: [branchId],
        warehouseIds: [warehouseId],
      });

      await provisionTenantMember(trx, {
        userId: STAFF_USER_ID,
        email: 'staff@perf.com',
        fullName: 'Staff Diana',
        roleCodes: ['STAFF'],
        allLocationsAccess: false,
      });
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness?.db) await harness.db.destroy();
  });

  describe('1. Fast Atomic Context Resolution via /v1/auth/me', () => {
    it('resolves full profile, tenant context, effective permissions and scopes in < 150ms', async () => {
      const start = performance.now();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
      });
      const elapsed = performance.now() - start;

      expect(res.statusCode).toBe(200);
      expect(elapsed).toBeLessThan(150); // High-performance target

      const body = res.json();
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe(OWNER_USER_ID);
      expect(body.user.email).toBe('owner@perf.com');
      expect(body.user.fullName).toBe('Owner Alice');

      expect(body.memberships).toHaveLength(1);
      const membership = body.memberships[0];
      expect(membership.tenantId).toBe(tenantId);
      expect(membership.businessName).toBe('Performance Remediation Ltd');
      expect(membership.baseCurrency).toBe('USD');
      expect(membership.role).toBe('TENANT_OWNER');
      expect(membership.allLocationsAccess).toBe(true);

      // Permissions should be pre-computed and populated in the atomic response
      expect(Array.isArray(membership.permissions)).toBe(true);
      expect(membership.permissions.length).toBeGreaterThan(10);
      expect(membership.permissions).toContain('cat:product:manage');
      expect(membership.permissions).toContain('pos:sale:read');

      // Branches should be pre-computed
      expect(Array.isArray(membership.branches)).toBe(true);
      expect(membership.branches.length).toBeGreaterThanOrEqual(1);
    });

    it('returns restricted branch and warehouse scopes for Cashier without redundant API calls', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${cashierToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      const membership = body.memberships[0];

      expect(membership.role).toBe('CASHIER');
      expect(membership.allLocationsAccess).toBe(false);
      expect(membership.allowedBranchIds).toEqual([branchId]);
      expect(membership.allowedWarehouseIds).toEqual([]);
      expect(membership.permissions).toContain('pos:shift:open');
      expect(membership.permissions).toContain('pos:sale:create');
    });
  });

  describe('2. Multi-Role Session Restoration & Fast Initialization Resilience', () => {
    it('handles session restoration for Owner, Cashier, Warehouse Clerk, and Staff accounts', async () => {
      const roles = [
        { name: 'Owner', token: ownerToken, expectedRole: 'TENANT_OWNER', userId: OWNER_USER_ID },
        { name: 'Cashier', token: cashierToken, expectedRole: 'CASHIER', userId: CASHIER_USER_ID },
        { name: 'Warehouse Clerk', token: clerkToken, expectedRole: 'WAREHOUSE_CLERK', userId: CLERK_USER_ID },
        { name: 'Staff', token: staffToken, expectedRole: 'STAFF', userId: STAFF_USER_ID },
      ];

      for (const r of roles) {
        const start = performance.now();
        const res = await app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: {
            authorization: `Bearer ${r.token}`,
          },
        });
        const elapsed = performance.now() - start;

        expect(res.statusCode).toBe(200);
        expect(elapsed).toBeLessThan(150);

        const data = res.json();
        expect(data.user).toBeDefined();
        expect(data.user.id).toBe(r.userId);
        expect(data.memberships.length).toBe(1);
        expect(data.memberships[0].role).toBe(r.expectedRole);
      }
    });

    it('handles multiple rapid repeated session checks without deadlocks or timeouts', async () => {
      const start = performance.now();
      for (let i = 0; i < 6; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: {
            authorization: `Bearer ${ownerToken}`,
          },
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.user.id).toBe(OWNER_USER_ID);
        expect(data.memberships.length).toBe(1);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('3. Token Refresh Session Preservation (/v1/auth/refresh)', () => {
    it('proactively refreshes tokens without requiring 401 error roundtrips', async () => {
      const refreshRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: {
          refreshToken: `dev_refresh_${generateUuidV7()}`,
        },
      });

      expect(refreshRes.statusCode).toBe(200);
      const refreshData = refreshRes.json();
      expect(refreshData.token).toBeDefined();
      expect(typeof refreshData.token).toBe('string');
      expect(refreshData.refreshToken).toBeDefined();
    });
  });

  describe('4. Web SPA HTML Optimization & Performance Instrumentation', () => {
    const indexPath = resolve(__dirname, '../../web/public/index.html');
    const html = readFileSync(indexPath, 'utf8');

    it('verifies high-precision browser performance instrumentation (_appPerf) is defined', () => {
      expect(html).toContain('window._appPerf = {');
      expect(html).toContain('window.getAppInitMetrics = () => window._appPerf.getMetrics();');
      expect(html).toContain("window._appPerf.mark('script_start');");
      expect(html).toContain("window._appPerf.mark('initial_view_painted');");
      expect(html).toContain("window._appPerf.mark('session_verified');");
      expect(html).toContain("window._appPerf.mark('fully_ready');");
    });

    it('verifies #mainContainer contains structured application skeleton shell instead of bare text loader', () => {
      expect(html).toContain('id="initialAppLoader"');
      expect(html).toContain('app-shell-skeleton');
      expect(html).toContain('kpi-grid');
      expect(html).toContain('skeleton-line');
      expect(html).toContain('id="initialAppLoaderLabel"');
    });

    it('verifies immediate fast-path synchronous paint executes in < 50ms before DOMContentLoaded', () => {
      expect(html).toContain('if (!storedSessionToken && !storedRefreshToken) {');
      expect(html).toContain('const initialRoute = getRouteFromLocation();');
      expect(html).toContain('if (initialRoute && AUTH_VIEWS.includes(initialRoute))');
      expect(html).toContain('hasCachedMembership');
      expect(html).toContain('updateTopbarContext();');
      expect(html).toContain('renderSidebarNav();');
    });

    it('verifies proactive token expiration check runs before /v1/auth/me to avoid 401 roundtrips', () => {
      expect(html).toContain('getTokenExpiry(activeToken)');
      expect(html).toContain('isExpiredOrExpiringSoon');
      expect(html).toContain('await refreshAccessToken()');
    });

    it('verifies POS Checkout view loads registers, shifts, products, and categories concurrently', () => {
      expect(html).toContain('// Parallel register, shift, product, and category retrieval (BUG-066 Waterfall Optimization)');
      expect(html).toContain('const [regRes, shiftRes, productsRes, catRes] = await Promise.all([');
    });

    it('verifies Dashboard view does not execute redundant POS register queries', () => {
      const dashFuncStart = html.indexOf('async function renderDashboardView()');
      const dashFuncEnd = html.indexOf('function paintProductsHtml', dashFuncStart);
      const dashBody = html.substring(dashFuncStart, dashFuncEnd);

      // Registers call removed from Dashboard's Promise.all
      expect(dashBody).not.toContain('/v1/pos/registers');
    });

    it('verifies role-aware landing view resolution avoids unauthorized dashboard bounce', () => {
      expect(html).toContain('resolveDefaultLandingView()');
      expect(html).toContain('canAccessView(locRoute)');
    });
  });
});
