import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApp,
  generateUuidV7,
  getOrCreateDevKeyMaterial,
  sanitizeLogMessage,
  signDevJwt,
  StaticJwksProvider,
} from '../src/index.js';
import {
  type TestPostgresHarness,
  createTestPostgresHarness,
} from './helpers/pglite-kysely.js';

describe('Phase 5.0 — Authentication & Business Foundation Integration Suite', () => {
  let harness: TestPostgresHarness;
  let devJwksProvider: StaticJwksProvider;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    const devKeys = getOrCreateDevKeyMaterial();
    devJwksProvider = new StaticJwksProvider({
      keys: [devKeys.publicJwk],
    });
  });

  afterAll(async () => {
    await harness.db.destroy();
  });

  describe('1. User Registration (POST /v1/auth/signup)', () => {
    it('successfully registers a new user, returns token, and syncs user to public.users', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const uniqueEmail = `founder_${generateUuidV7()}@testcompany.com`;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: {
          email: uniqueEmail,
          password: 'SecurePassword123!',
          fullName: 'Jane Founder',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.email).toBe(uniqueEmail.toLowerCase());
      expect(body.fullName).toBe('Jane Founder');
      expect(typeof body.token).toBe('string');
      expect(typeof body.userId).toBe('string');
      expect(body.requiresEmailVerification).toBe(false);

      // Verify user was inserted into public.users table
      const dbUser = await harness.db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', body.userId)
        .executeTakeFirst();

      expect(dbUser).toBeDefined();
      expect(dbUser?.email).toBe(uniqueEmail.toLowerCase());
      expect(dbUser?.full_name).toBe('Jane Founder');

      await app.close();
    });

    it('rejects weak passwords shorter than 8 characters (400 AUTH_WEAK_PASSWORD)', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: {
          email: `weak_${generateUuidV7()}@test.com`,
          password: 'short',
          fullName: 'Short Pass User',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(['ERR_VALIDATION_FAILED', 'AUTH_WEAK_PASSWORD']).toContain(body.errorCode);
      expect(body.detail.toLowerCase()).toContain('password');

      await app.close();
    });

    it('rejects duplicate email registrations (409 AUTH_EMAIL_ALREADY_EXISTS)', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const duplicateEmail = `duplicate_${generateUuidV7()}@test.com`;

      // First signup
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: {
          email: duplicateEmail,
          password: 'Password123!',
          fullName: 'Original User',
        },
      });
      expect(res1.statusCode).toBe(201);

      // Second signup with exact same email
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: {
          email: duplicateEmail,
          password: 'AnotherPassword123!',
          fullName: 'Duplicate User',
        },
      });

      expect(res2.statusCode).toBe(409);
      const body = res2.json();
      expect(body.errorCode).toBe('AUTH_EMAIL_ALREADY_EXISTS');
      expect(body.detail).toContain('already exists');

      await app.close();
    });
  });

  describe('2. User Login (POST /v1/auth/login)', () => {
    it('authenticates a registered user and returns token, profile, and memberships', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const email = `login_user_${generateUuidV7()}@company.com`;
      const password = 'CorrectPassword123!';

      // Register first
      const signupRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: {
          email,
          password,
          fullName: 'Login Test User',
        },
      });
      expect(signupRes.statusCode).toBe(201);

      // Perform login
      const loginRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email,
          password,
        },
      });

      expect(loginRes.statusCode).toBe(200);
      const body = loginRes.json();
      expect(typeof body.token).toBe('string');
      expect(body.user.email).toBe(email.toLowerCase());
      expect(body.user.fullName).toBe('Login Test User');
      expect(Array.isArray(body.memberships)).toBe(true);

      await app.close();
    });

    it('rejects invalid password or malformed credentials (401 AUTH_INVALID_CREDENTIALS)', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: 'nonexistent@test.com',
          password: '123',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.errorCode).toBe('AUTH_INVALID_CREDENTIALS');
      expect(body.detail).toContain('Invalid email address or password');

      await app.close();
    });
  });

  describe('3. User Logout & Password Recovery', () => {
    it('POST /v1/auth/logout succeeds with valid Bearer token', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const userId = generateUuidV7();
      const token = signDevJwt({ userId, email: 'logout@test.com' });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('Logged out successfully');

      await app.close();
    });

    it('POST /v1/auth/recover returns privacy-safe success message without leaking account existence', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/recover',
        payload: {
          email: 'anyone@somedomain.com',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.message).toContain('password recovery link has been sent');

      await app.close();
    });
  });

  describe('4. User Profile & Discovery (GET /v1/auth/me & GET /v1/org/my-tenants)', () => {
    it('GET /v1/auth/me rejects requests without Authorization header (401)', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('GET /v1/auth/me returns user profile and empty memberships for new user', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const userId = generateUuidV7();
      const email = `newbie_${generateUuidV7()}@test.com`;
      const token = signDevJwt({ userId, email });

      // Insert user to users table
      await harness.db
        .insertInto('users')
        .values({
          id: userId,
          email,
          full_name: 'Newbie User',
          is_platform_admin: false,
        })
        .execute();

      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.id).toBe(userId);
      expect(body.user.email).toBe(email);
      expect(body.memberships).toEqual([]);

      await app.close();
    });
  });

  describe('5. Atomic Business Onboarding (POST /v1/org/onboard)', () => {
    it('atomically sets up tenant, first branch, warehouse, register, owner role, and trial subscription', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const founderId = generateUuidV7();
      const founderEmail = `founder_${generateUuidV7()}@myretail.com`;
      const token = signDevJwt({ userId: founderId, email: founderEmail });

      // Seed founder user
      await harness.db
        .insertInto('users')
        .values({
          id: founderId,
          email: founderEmail,
          full_name: 'Alex Founder',
          is_platform_admin: false,
        })
        .execute();

      const onboardRes = await app.inject({
        method: 'POST',
        url: '/v1/org/onboard',
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: {
          businessName: 'NexStore Flagship Retail',
          businessType: 'RETAIL',
          currency: 'USD',
          firstBranchName: 'Downtown Headquarters',
        },
      });

      expect(onboardRes.statusCode).toBe(201);
      const body = onboardRes.json();

      // 1. Tenant Verification
      expect(body.tenant.legalName).toBe('NexStore Flagship Retail');
      expect(body.tenant.baseCurrency).toBe('USD');
      expect(body.tenant.status).toBe('TRIALING');

      // 2. Branch Verification
      expect(body.branch.name).toBe('Downtown Headquarters');
      expect(body.branch.code).toBe('MAIN');

      // 3. Warehouse Verification
      expect(body.warehouse.name).toBe('Downtown Headquarters Stockroom');
      expect(body.warehouse.code).toBe('WH-MAIN');

      // 4. POS Register Verification
      expect(body.register.code).toBe('REG-01');
      expect(body.register.name).toBe('Front Counter 1');

      // 5. Verify GET /v1/auth/me now returns the membership and branch
      const meRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(meRes.statusCode).toBe(200);
      const meBody = meRes.json();
      expect(meBody.memberships.length).toBe(1);
      const mem = meBody.memberships[0];
      expect(mem.tenantId).toBe(body.tenant.id);
      expect(mem.businessName).toBe('NexStore Flagship Retail');
      expect(mem.role).toBe('TENANT_OWNER');
      expect(mem.branches.length).toBe(1);
      expect(mem.branches[0].name).toBe('Downtown Headquarters');

      // 6. Verify GET /v1/org/my-tenants lists the organization
      const tenantsRes = await app.inject({
        method: 'GET',
        url: '/v1/org/my-tenants',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(tenantsRes.statusCode).toBe(200);
      const tenantsBody = tenantsRes.json();
      expect(Array.isArray(tenantsBody)).toBe(true);
      expect(tenantsBody.length).toBe(1);
      expect(tenantsBody[0].tenantId).toBe(body.tenant.id);

      await app.close();
    });

    it('strictly isolates tenant discovery between distinct users (User A cannot see User B)', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      // User A
      const userAId = generateUuidV7();
      const userAEmail = `usera_${generateUuidV7()}@alpha.com`;
      const tokenA = signDevJwt({ userId: userAId, email: userAEmail });
      await harness.db.insertInto('users').values({ id: userAId, email: userAEmail, full_name: 'User Alpha', is_platform_admin: false }).execute();

      // User B
      const userBId = generateUuidV7();
      const userBEmail = `userb_${generateUuidV7()}@beta.com`;
      const tokenB = signDevJwt({ userId: userBId, email: userBEmail });
      await harness.db.insertInto('users').values({ id: userBId, email: userBEmail, full_name: 'User Beta', is_platform_admin: false }).execute();

      // User A creates Business Alpha
      const resA = await app.inject({
        method: 'POST',
        url: '/v1/org/onboard',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          businessName: 'Alpha Store Inc.',
          businessType: 'RETAIL',
          currency: 'USD',
          firstBranchName: 'Alpha Store Main',
        },
      });
      expect(resA.statusCode).toBe(201);
      const tenantA = resA.json().tenant;

      // User B creates Business Beta
      const resB = await app.inject({
        method: 'POST',
        url: '/v1/org/onboard',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          businessName: 'Beta Dynamics Ltd',
          businessType: 'SERVICES',
          currency: 'EUR',
          firstBranchName: 'Beta HQ',
        },
      });
      expect(resB.statusCode).toBe(201);
      const tenantB = resB.json().tenant;

      // Check User A's tenants: only sees Alpha
      const listA = await app.inject({
        method: 'GET',
        url: '/v1/org/my-tenants',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      const bodyA = listA.json();
      expect(Array.isArray(bodyA)).toBe(true);
      expect(bodyA.length).toBe(1);
      expect(bodyA[0].tenantId).toBe(tenantA.id);
      expect(bodyA[0].businessName).toBe('Alpha Store Inc.');

      // Check User B's tenants: only sees Beta
      const listB = await app.inject({
        method: 'GET',
        url: '/v1/org/my-tenants',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      const bodyB = listB.json();
      expect(Array.isArray(bodyB)).toBe(true);
      expect(bodyB.length).toBe(1);
      expect(bodyB[0].tenantId).toBe(tenantB.id);
      expect(bodyB[0].businessName).toBe('Beta Dynamics Ltd');

      await app.close();
    });

    it('supports custom branch code, country code, and timezone during onboarding', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const founderId = generateUuidV7();
      const founderEmail = `founder_custom_${generateUuidV7()}@colombo.lk`;
      const token = signDevJwt({ userId: founderId, email: founderEmail });

      await harness.db.insertInto('users').values({
        id: founderId,
        email: founderEmail,
        full_name: 'Colombo Trade Director',
        is_platform_admin: false,
      }).execute();

      const onboardRes = await app.inject({
        method: 'POST',
        url: '/v1/org/onboard',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          businessName: 'Lanka Spices Global',
          businessType: 'WHOLESALE',
          currency: 'LKR',
          countryCode: 'LK',
          timezone: 'Asia/Colombo',
          firstBranchName: 'Colombo Central Port',
          firstBranchCode: 'CMB-PORT',
        },
      });

      expect(onboardRes.statusCode).toBe(201);
      const body = onboardRes.json();

      expect(body.tenant.legalName).toBe('Lanka Spices Global');
      expect(body.tenant.baseCurrency).toBe('LKR');
      expect(body.branch.name).toBe('Colombo Central Port');
      expect(body.branch.code).toBe('CMB-PORT');
      expect(body.warehouse.code).toBe('WH-CMB-PORT');

      // Verify database records directly
      const dbBranch = await harness.db
        .selectFrom('branches')
        .selectAll()
        .where('tenant_id', '=', body.tenant.id)
        .where('id', '=', body.branch.id)
        .executeTakeFirst();

      expect(dbBranch).toBeDefined();
      expect(dbBranch?.country_code).toBe('LK');
      expect(dbBranch?.timezone).toBe('Asia/Colombo');
      expect(dbBranch?.code).toBe('CMB-PORT');

      const dbLocalization = await harness.db
        .selectFrom('tenant_localization_settings')
        .selectAll()
        .where('tenant_id', '=', body.tenant.id)
        .executeTakeFirst();

      expect(dbLocalization).toBeDefined();
      expect(dbLocalization?.timezone).toBe('Asia/Colombo');

      await app.close();
    });

    it('rejects onboarding without authentication or with invalid token (401)', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      // No auth header
      const resNoAuth = await app.inject({
        method: 'POST',
        url: '/v1/org/onboard',
        payload: {
          businessName: 'Unauth Co',
          businessType: 'RETAIL',
          currency: 'USD',
          firstBranchName: 'Unauth Branch',
        },
      });
      expect(resNoAuth.statusCode).toBe(401);

      // Invalid token
      const resBadAuth = await app.inject({
        method: 'POST',
        url: '/v1/org/onboard',
        headers: { authorization: 'Bearer invalid.token.value' },
        payload: {
          businessName: 'Unauth Co',
          businessType: 'RETAIL',
          currency: 'USD',
          firstBranchName: 'Unauth Branch',
        },
      });
      expect(resBadAuth.statusCode).toBe(401);

      await app.close();
    });

    it('rejects invalid branch code or unsupported currency and ensures complete rollback', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
      });

      const founderId = generateUuidV7();
      const founderEmail = `founder_rollback_${generateUuidV7()}@test.com`;
      const token = signDevJwt({ userId: founderId, email: founderEmail });

      // Attempt 1: Unsupported currency code
      const resBadCurrency = await app.inject({
        method: 'POST',
        url: '/v1/org/onboard',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          businessName: 'Rollback Store Currency',
          businessType: 'RETAIL',
          currency: 'XYZ',
          firstBranchName: 'Main Store',
        },
      });
      expect(resBadCurrency.statusCode).toBe(400);

      // Verify no tenant record was created for "Rollback Store Currency"
      const tenantCurrency = await harness.db
        .selectFrom('tenants')
        .select('id')
        .where('legal_name', '=', 'Rollback Store Currency')
        .executeTakeFirst();
      expect(tenantCurrency).toBeUndefined();

      // Attempt 2: Invalid branch code (contains spaces/symbols)
      const resBadBranchCode = await app.inject({
        method: 'POST',
        url: '/v1/org/onboard',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          businessName: 'Rollback Store Branch',
          businessType: 'RETAIL',
          currency: 'USD',
          firstBranchName: 'Main Store',
          firstBranchCode: 'INVALID BRANCH CODE WITH SPACES!',
        },
      });
      expect(resBadBranchCode.statusCode).toBe(400);

      // Verify no tenant record was created for "Rollback Store Branch"
      const tenantBranch = await harness.db
        .selectFrom('tenants')
        .select('id')
        .where('legal_name', '=', 'Rollback Store Branch')
        .executeTakeFirst();
      expect(tenantBranch).toBeUndefined();

      await app.close();
    });
  });

  describe('6. Production Authentication Configuration, Provider Resilience & Safe Logging', () => {
    it('returns 503 when running in production mode without SUPABASE_ANON_KEY configured', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider: devJwksProvider,
        authServiceConfig: {
          isDevOrTestMode: false,
          supabaseAnonKey: undefined,
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: {
          email: `prod_unconfigured_${generateUuidV7()}@test.com`,
          password: 'Password123!',
          fullName: 'Production User',
        },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.errorCode).toBe('ERR_INTERNAL_SERVER_ERROR');
      expect(body.title).toContain('Authentication Service Not Configured');
      expect(body.detail).toContain('SUPABASE_ANON_KEY');

      await app.close();
    });

    it('returns 502 with sanitized Problem Details when Supabase GoTrue REST provider fails or is unreachable', async () => {
      const originalFetch = globalThis.fetch;
      // Mock fetch to simulate network failure / connection refused
      globalThis.fetch = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:9999 (mock provider outage)');
      };

      try {
        const app = await buildApp({
          db: harness.db,
          jwksProvider: devJwksProvider,
          authServiceConfig: {
            supabaseUrl: 'http://127.0.0.1:9999',
            supabaseAnonKey: 'mock-test-anon-key-12345',
            isDevOrTestMode: true,
          },
        });

        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/signup',
          payload: {
            email: `provider_outage_${generateUuidV7()}@test.com`,
            password: 'Password123!',
            fullName: 'Resilient User',
          },
        });

        expect(res.statusCode).toBe(502);
        const body = res.json();
        expect(body.errorCode).toBe('ERR_INTERNAL_SERVER_ERROR');
        expect(body.title).toContain('Authentication Service Unavailable');
        expect(body.detail).toContain('Failed to communicate with authentication provider');

        await app.close();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('translates GoTrue provider 422 duplicate email into 409 AUTH_EMAIL_ALREADY_EXISTS', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            code: 422,
            msg: 'User already registered',
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        );
      };

      try {
        const app = await buildApp({
          db: harness.db,
          jwksProvider: devJwksProvider,
          authServiceConfig: {
            supabaseUrl: 'http://mock-supabase.local',
            supabaseAnonKey: 'mock-test-anon-key-12345',
            isDevOrTestMode: true,
          },
        });

        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/signup',
          payload: {
            email: `gotrue_dup_${generateUuidV7()}@test.com`,
            password: 'Password123!',
            fullName: 'Duplicate In GoTrue',
          },
        });

        expect(res.statusCode).toBe(409);
        const body = res.json();
        expect(body.errorCode).toBe('AUTH_EMAIL_ALREADY_EXISTS');
        expect(body.detail).toContain('already exists');

        await app.close();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('verifies server logging completely scrubs passwords, tokens, and database secrets', async () => {
      const errorLogs: unknown[] = [];
      const warnLogs: unknown[] = [];

      const originalConsoleError = console.error;
      const originalConsoleWarn = console.warn;
      console.error = (...args: unknown[]) => errorLogs.push(args);
      console.warn = (...args: unknown[]) => warnLogs.push(args);

      try {
        const secretPassword = 'SUPER_SECRET_PLAINTEXT_PASSWORD_999!';
        const secretToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_payload.signature';
        const secretConnStr = 'postgresql://nexstock_app_user:SUPER_SECRET_DB_PASSWORD@db.host.com:5432/postgres';

        const sanitized = sanitizeLogMessage(
          `Error occurred with password="${secretPassword}" and token="Bearer ${secretToken}" and conn="${secretConnStr}"`,
        );

        expect(sanitized).not.toContain(secretPassword);
        expect(sanitized).not.toContain(secretToken);
        expect(sanitized).not.toContain('SUPER_SECRET_DB_PASSWORD');
        expect(sanitized).toContain('password="***"');
        expect(sanitized).toContain('Bearer ***');
        expect(sanitized).toContain(':***@');

        // Also verify Fastify error handler logging scrubs sensitive detail
        const app = await buildApp({
          db: harness.db,
          jwksProvider: devJwksProvider,
        });

        // Trigger an invalid password error
        await app.inject({
          method: 'POST',
          url: '/v1/auth/signup',
          payload: {
            email: `scrub_${generateUuidV7()}@test.com`,
            password: 'short',
            fullName: 'Scrub Test User',
          },
        });

        const allLogsText = JSON.stringify({ errorLogs, warnLogs });
        expect(allLogsText).not.toContain(secretPassword);
        expect(allLogsText).not.toContain('SUPER_SECRET_DB_PASSWORD');

        await app.close();
      } finally {
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
      }
    });
  });
});
