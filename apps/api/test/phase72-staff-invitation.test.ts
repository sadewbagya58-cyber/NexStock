import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  getOrCreateDevKeyMaterial,
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
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString(
    'base64url',
  );
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString(
    'base64url',
  );
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const signature = sign('sha256', signingInput, {
    key: keyMaterial.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}

describe('@nexstock/api — Phase 7.2: Staff Invitation, Account Provisioning & RBAC Lifecycle', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  // Tenant A: Primary Test Tenant
  const TENANT_A_ID = '0192b4c0-0000-7000-8000-0000000000a1';
  const OWNER_A_USER_ID = '0192b4c0-0000-7000-8000-0000000000a2';
  const OWNER_A_EMAIL = 'owner-a@nexstock-corp.com';

  // Tenant B: Isolated Tenant
  const TENANT_B_ID = '0192b4c0-0000-7000-8000-0000000000b1';
  const OWNER_B_USER_ID = '0192b4c0-0000-7000-8000-0000000000b2';
  const OWNER_B_EMAIL = 'owner-b@other-corp.com';

  const primaryKey = createTestEs256KeyMaterial(
    '01f76c4b-9743-48ad-bed6-a9c89dc99cc8',
  );
  const devKeyMaterial = getOrCreateDevKeyMaterial();
  const jwksProvider = new StaticJwksProvider({
    keys: [primaryKey.publicJwk, devKeyMaterial.publicJwk],
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

  let ownerAToken: string;
  let ownerBToken: string;

  let emp1Id: string;
  let emp2Id: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    ownerAToken = issueToken(OWNER_A_USER_ID, OWNER_A_EMAIL);
    ownerBToken = issueToken(OWNER_B_USER_ID, OWNER_B_EMAIL);

    // 1. Onboard Tenant A
    const onboardARes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': TENANT_A_ID,
      },
      payload: {
        slug: 'nexstock-corp-alpha',
        legalName: 'NexStock Alpha Corp',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: OWNER_A_EMAIL,
        ownerFullName: 'Saman Jayasuriya (Owner A)',
        planCode: 'GROWTH',
      },
    });
    expect(onboardARes.statusCode).toBe(201);

    // 2. Onboard Tenant B (for cross-tenant tests)
    const onboardBRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerBToken}`,
        'x-tenant-id': TENANT_B_ID,
      },
      payload: {
        slug: 'nexstock-corp-beta',
        legalName: 'NexStock Beta Corp',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: OWNER_B_EMAIL,
        ownerFullName: 'Ruwan Silva (Owner B)',
        planCode: 'GROWTH',
      },
    });
    expect(onboardBRes.statusCode).toBe(201);

    // 3. Create Employees in Tenant A
    const emp1Res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': TENANT_A_ID,
      },
      payload: {
        employeeCode: 'EMP-INV-001',
        firstName: 'QA',
        lastName: 'Phase71 Test01',
        designation: 'Senior QA Engineer',
        department: 'Engineering',
        joinedDate: '2026-01-15',
        email: 'qa-staff01@nexstock.test',
      },
    });
    expect(emp1Res.statusCode).toBe(201);
    emp1Id = emp1Res.json().id;

    const emp2Res = await app.inject({
      method: 'POST',
      url: '/v1/employees',
      headers: {
        authorization: `Bearer ${ownerAToken}`,
        'x-tenant-id': TENANT_A_ID,
      },
      payload: {
        employeeCode: 'EMP-INV-002',
        firstName: 'Nimal',
        lastName: 'Fernando',
        designation: 'Inventory Specialist',
        department: 'Operations',
        joinedDate: '2026-02-01',
        email: 'nimal-ops@nexstock.test',
      },
    });
    expect(emp2Res.statusCode).toBe(201);
    emp2Id = emp2Res.json().id;
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  describe('1. Invitation Creation & Validation Edge Cases', () => {
    it('rejects invitation creation with invalid email format (400 ERR_VALIDATION_FAILED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'not-an-email',
          roleCode: 'STAFF',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('ERR_VALIDATION_FAILED');
    });

    it('rejects sending an invitation to the Tenant Owner email address (400 IAM_CANNOT_INVITE_OWNER)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: OWNER_A_EMAIL,
          roleCode: 'STAFF',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('IAM_CANNOT_INVITE_OWNER');
    });

    it('rejects invitation creation with elevated roles like TENANT_OWNER or ORG_ADMIN (400 IAM_INVALID_INVITATION_ROLE)', async () => {
      const resOwnerRole = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'escalate@nexstock.test',
          roleCode: 'TENANT_OWNER',
        },
      });
      expect(resOwnerRole.statusCode).toBe(400);
      expect(resOwnerRole.json().errorCode).toBe('IAM_INVALID_INVITATION_ROLE');

      const resAdminRole = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'escalate-admin@nexstock.test',
          roleCode: 'ORG_ADMIN',
        },
      });
      expect(resAdminRole.statusCode).toBe(400);
      expect(resAdminRole.json().errorCode).toBe('IAM_INVALID_INVITATION_ROLE');
    });

    it('creates a staff invitation linked to an employee profile successfully (201 Created)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'qa-staff01@nexstock.test',
          roleCode: 'STAFF',
          employeeId: emp1Id,
        },
      });

      expect(res.statusCode).toBe(201);
      const invitation = res.json();
      expect(invitation.email).toBe('qa-staff01@nexstock.test');
      expect(invitation.roleCode).toBe('STAFF');
      expect(invitation.employeeId).toBe(emp1Id);
      expect(invitation.status).toBe('PENDING');
      expect(invitation.token).toBeDefined();
      expect(typeof invitation.token).toBe('string');
      expect(invitation.expiresAt).toBeDefined();

      // Check expiry is in the future (~24 hours per redesign)
      const expiry = new Date(invitation.expiresAt).getTime();
      expect(expiry).toBeGreaterThan(Date.now() + 20 * 3600 * 1000);
      expect(invitation.invitationCode).toBeDefined();
      expect(invitation.invitationCode).toMatch(/^\d{4}$/);
    });

    it('prevents duplicate pending invitations for the same email (409 IAM_INVITATION_ALREADY_EXISTS)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'qa-staff01@nexstock.test',
          roleCode: 'STAFF',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('IAM_INVITATION_ALREADY_EXISTS');
    });
  });

  describe('2. Invitation Management: Listing, Resending, and Cancellation', () => {
    let pendingInvitationId: string;

    it('lists tenant invitations and redacts token secrets (GET /v1/iam/invitations)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(1);

      const found = (list as Array<{ id: string; email: string; status: string; token?: string }>).find(
        (inv) => inv.email === 'qa-staff01@nexstock.test',
      );
      expect(found).toBeDefined();
      expect(found!.status).toBe('PENDING');
      // Token MUST NOT be exposed in listing
      expect(found!.token).toBeUndefined();

      pendingInvitationId = found!.id;
    });

    it('resends invitation, extends expiration, and returns fresh token (POST /v1/iam/invitations/:id/resend)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/iam/invitations/${pendingInvitationId}/resend`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const updated = res.json();
      expect(updated.id).toBe(pendingInvitationId);
      expect(updated.status).toBe('PENDING');
      expect(updated.token).toBeDefined();
      expect(typeof updated.token).toBe('string');
    });

    it('cancels pending invitation and validates status transitions to CANCELLED', async () => {
      // 1. Create a disposable invitation to cancel
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'to-cancel@nexstock.test',
          roleCode: 'STAFF',
        },
      });
      expect(createRes.statusCode).toBe(201);
      const disposableId = createRes.json().id;
      const disposableToken = createRes.json().token;

      // 2. Validate token is currently valid
      const validateBefore = await app.inject({
        method: 'GET',
        url: `/v1/auth/invitations/validate?token=${disposableToken}`,
      });
      expect(validateBefore.statusCode).toBe(200);
      expect(validateBefore.json().valid).toBe(true);

      // 3. Cancel invitation
      const cancelRes = await app.inject({
        method: 'POST',
        url: `/v1/iam/invitations/${disposableId}/cancel`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });
      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().status).toBe('CANCELLED');

      // 4. Validate token is now invalid (400 IAM_INVITATION_INACTIVE)
      const validateAfter = await app.inject({
        method: 'GET',
        url: `/v1/auth/invitations/validate?token=${disposableToken}`,
      });
      expect(validateAfter.statusCode).toBe(400);
      expect(validateAfter.json().errorCode).toBe('IAM_INVITATION_INACTIVE');

      // 5. Attempting to accept cancelled invitation fails with 400
      const acceptRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: {
          token: disposableToken,
          password: 'Password123!',
        },
      });
      expect(acceptRes.statusCode).toBe(400);
      expect(acceptRes.json().errorCode).toBe('IAM_INVITATION_INACTIVE');
    });
  });

  describe('3. Public Token Validation & Expiry Enforcement', () => {
    it('validates active invitation token and returns tenant details (GET /v1/auth/invitations/validate)', async () => {
      // Create new fresh invitation for validation tests
      const inviteRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'validate-test@nexstock.test',
          roleCode: 'STAFF',
          employeeId: emp2Id,
        },
      });
      expect(inviteRes.statusCode).toBe(201);
      const token = inviteRes.json().token;

      const valRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/invitations/validate?token=${token}`,
      });

      expect(valRes.statusCode).toBe(200);
      const body = valRes.json();
      expect(body.valid).toBe(true);
      expect(body.email).toBe('validate-test@nexstock.test');
      expect(body.roleCode).toBe('STAFF');
      expect(body.employeeName).toContain('Nimal Fernando');
      expect(body.tenantName).toBe('NexStock Alpha Corp');
    });

    it('rejects non-existent or tampered tokens with 404 IAM_INVITATION_NOT_FOUND', async () => {
      const valRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/invitations/validate?token=non_existent_token_1234567890abcdef',
      });

      expect(valRes.statusCode).toBe(404);
      expect(valRes.json().errorCode).toBe('IAM_INVITATION_NOT_FOUND');
    });

    it('rejects expired invitations during validation and acceptance', async () => {
      // 1. Create invitation
      const inviteRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'expired-test@nexstock.test',
          roleCode: 'STAFF',
        },
      });
      expect(inviteRes.statusCode).toBe(201);
      const invId = inviteRes.json().id;
      const expiredToken = inviteRes.json().token;

      // 2. Fast-forward expiration in DB to the past
      await withTenantTransaction(
        harness.db,
        { tenantId: TENANT_A_ID, userId: OWNER_A_USER_ID, traceId: 'test-expiry' },
        async (trx) => {
          await trx.db
            .updateTable('tenant_invitations')
            .set({
              expires_at: new Date(Date.now() - 3600 * 1000), // 1 hour ago
            })
            .where('id', '=', invId)
            .execute();
        },
      );

      // 3. Validation returns 410 IAM_INVITATION_EXPIRED
      const valRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/invitations/validate?token=${expiredToken}`,
      });
      expect(valRes.statusCode).toBe(410);
      expect(valRes.json().errorCode).toBe('IAM_INVITATION_EXPIRED');

      // 4. Acceptance returns 400 IAM_INVITATION_EXPIRED
      const acceptRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: {
          token: expiredToken,
          password: 'Password123!',
        },
      });
      expect([400, 410]).toContain(acceptRes.statusCode);
      expect(acceptRes.json().errorCode).toBe('IAM_INVITATION_EXPIRED');
    });
  });

  describe('4. Staff Account Activation, Role Provisioning & Employee Linking', () => {
    let staffUserId: string;
    let acceptedInvitationToken: string;

    it('successfully accepts invitation, provisions staff user, assigns STAFF role, and links employee', async () => {
      // Fetch latest pending invitation token for qa-staff01@nexstock.test
      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });
      const pendingInv = (listRes.json() as Array<{ id: string; email: string }>).find(
        (inv) => inv.email === 'qa-staff01@nexstock.test',
      );
      expect(pendingInv).toBeDefined();

      // Trigger resend to get a known valid token
      const resendRes = await app.inject({
        method: 'POST',
        url: `/v1/iam/invitations/${pendingInv!.id}/resend`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });
      acceptedInvitationToken = resendRes.json().token;

      // Public acceptance
      const acceptRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: {
          token: acceptedInvitationToken,
          password: 'StaffSecurePassword123!',
          fullName: 'QA Staff Member 01',
        },
      });

      expect(acceptRes.statusCode).toBe(200);
      const body = acceptRes.json();
      expect(body.token).toBeDefined();
      expect(body.user).toBeDefined();
      expect(body.user.email).toBe('qa-staff01@nexstock.test');
      expect(body.user.fullName).toBe('QA Staff Member 01');

      staffUserId = body.user.id;

      // Verify membership has STAFF role
      const staffMembership = (body.memberships as Array<{ tenantId: string; role: string }>).find(
        (m) => m.tenantId === TENANT_A_ID,
      );
      expect(staffMembership).toBeDefined();
      expect(staffMembership!.role).toBe('STAFF');

      // Verify employee record is linked
      const empRes = await app.inject({
        method: 'GET',
        url: `/v1/employees/${emp1Id}`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });
      expect(empRes.statusCode).toBe(200);
      expect(empRes.json().linkedUserId).toBe(staffUserId);

      // Verify invitation status in DB is now ACCEPTED
      const dbInv = await harness.db
        .selectFrom('tenant_invitations')
        .selectAll()
        .where('id', '=', pendingInv!.id)
        .executeTakeFirst();
      expect(dbInv?.status).toBe('ACCEPTED');
      expect(dbInv?.accepted_by_user_id).toBe(staffUserId);
      expect(dbInv?.accepted_at).toBeDefined();
    });

    it('rejects subsequent acceptance attempts on already accepted invitations (400 IAM_INVITATION_ALREADY_ACCEPTED)', async () => {
      const acceptAgainRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: {
          token: acceptedInvitationToken,
          password: 'AnotherPassword123!',
        },
      });

      expect(acceptAgainRes.statusCode).toBe(400);
      expect(acceptAgainRes.json().errorCode).toBe('IAM_INVITATION_ALREADY_ACCEPTED');
    });

    it('rejects inviting an already active tenant member (409 IAM_USER_ALREADY_MEMBER)', async () => {
      const inviteAgainRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'qa-staff01@nexstock.test',
          roleCode: 'STAFF',
        },
      });

      expect(inviteAgainRes.statusCode).toBe(409);
      expect(inviteAgainRes.json().errorCode).toBe('IAM_USER_ALREADY_MEMBER');
    });
  });

  describe('4b. 4-Digit Access Code System & Security Hardening (Phase 7.2 Redesign)', () => {
    let codeStaffInvitation: { id: string; email: string; invitationCode: string };
    let emp3Id: string;

    it('generates a 4-digit numeric code with AES-256-GCM encryption on invitation creation', async () => {
      // Create independent employee profile for 4b test suite
      const empRes = await app.inject({
        method: 'POST',
        url: '/v1/employees',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          employeeCode: 'EMP-INV-003',
          firstName: 'CodeStaff',
          lastName: 'Test',
          email: 'staff.fourdigit@nexstock.test',
          designation: 'Staff',
          department: 'Logistics',
          joinedDate: '2026-03-01',
        },
      });
      expect(empRes.statusCode).toBe(201);
      emp3Id = empRes.json().id;

      const res = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'staff.fourdigit@nexstock.test',
          roleCode: 'STAFF',
          employeeId: emp3Id,
        },
      });

      expect(res.statusCode).toBe(201);
      const data = res.json();
      expect(data.invitationCode).toBeDefined();
      expect(data.invitationCode).toMatch(/^\d{4}$/);
      expect(data.email).toBe('staff.fourdigit@nexstock.test');
      codeStaffInvitation = {
        id: data.id,
        email: data.email,
        invitationCode: data.invitationCode,
      };

      // Verify in DB: code_encrypted is stored (not plaintext code) and token_hash is SHA-256
      const dbRow = await harness.db
        .selectFrom('tenant_invitations')
        .select(['token_hash', 'code_encrypted', 'failed_attempts', 'locked_until'])
        .where('id', '=', data.id)
        .executeTakeFirst();

      expect(dbRow).toBeDefined();
      expect(dbRow!.token_hash).toHaveLength(64); // SHA-256 hex
      expect(dbRow!.code_encrypted).not.toBe(data.invitationCode); // Encrypted ciphertext
      expect(dbRow!.code_encrypted).toContain(':'); // IV : AuthTag : Ciphertext format
      expect(dbRow!.failed_attempts).toBe(0);
      expect(dbRow!.locked_until).toBeNull();
    });

    it('validates 4-digit code publicly via POST /v1/auth/invitations/validate-code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/validate-code',
        payload: {
          code: codeStaffInvitation.invitationCode,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.valid).toBe(true);
      expect(data.maskedEmail).toMatch(/^st\*\*\*@nexstock\.test$/);
      expect(data.roleCode).toBe('STAFF');
      expect(data.tenantName).toBe('NexStock Alpha Corp');
      expect(data.invitationCode).toBe(codeStaffInvitation.invitationCode);
    });

    it('rejects code validation when email mismatch is supplied in validate-code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/validate-code',
        payload: {
          code: codeStaffInvitation.invitationCode,
          email: 'wrong-staff@nexstock.test',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('IAM_INVITATION_EMAIL_MISMATCH');
    });

    it('rejects invalid 4-digit code with 404 IAM_INVITATION_NOT_FOUND', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/validate-code',
        payload: {
          code: '0000',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().errorCode).toBe('IAM_INVITATION_NOT_FOUND');
    });

    it('rejects account activation when email does not match invited email (400 IAM_INVITATION_EMAIL_MISMATCH)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: {
          code: codeStaffInvitation.invitationCode,
          email: 'attacker@nexstock.test',
          password: 'SecurePassword123!',
          fullName: 'Attacker Name',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('IAM_INVITATION_EMAIL_MISMATCH');
    });

    it('successfully accepts invitation with 4-digit code and matching email, unsetting encrypted code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: {
          code: codeStaffInvitation.invitationCode,
          email: codeStaffInvitation.email,
          password: 'ValidStaffPassword123!',
          fullName: 'Staff Four Digit Member',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.token).toBeDefined();
      expect(data.user.email).toBe(codeStaffInvitation.email);
      expect(data.user.fullName).toBe('Staff Four Digit Member');

      // Verify in DB that code_encrypted is cleared on acceptance
      const dbRow = await harness.db
        .selectFrom('tenant_invitations')
        .select(['status', 'code_encrypted', 'accepted_by_user_id'])
        .where('id', '=', codeStaffInvitation.id)
        .executeTakeFirst();

      expect(dbRow?.status).toBe('ACCEPTED');
      expect(dbRow?.code_encrypted).toBeNull();
      expect(dbRow?.accepted_by_user_id).toBe(data.user.id);
    });

    it('enforces brute-force lockout after 5 consecutive failed code attempts on an IP', async () => {
      const testIp = '198.51.100.99';
      // Attempt 5 incorrect attempts
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/auth/invitations/validate-code',
          headers: {
            'x-forwarded-for': testIp,
          },
          remoteAddress: testIp,
          payload: {
            code: '9999',
          },
        });
        expect([404, 429]).toContain(res.statusCode);
      }

      // 6th attempt from the same IP must be rejected with 429 IAM_INVITATION_TOO_MANY_ATTEMPTS
      const blockedRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/validate-code',
        headers: {
          'x-forwarded-for': testIp,
        },
        remoteAddress: testIp,
        payload: {
          code: '1234',
        },
      });

      expect(blockedRes.statusCode).toBe(429);
      expect(blockedRes.json().errorCode).toBe('IAM_INVITATION_TOO_MANY_ATTEMPTS');
    });

    it('strictly enforces PostgreSQL RLS on tenant_invitations with zero NULL-context bypass', async () => {
      // Query as nexstock_app_user without app.current_tenant_id returns 0 rows due to strict RLS
      const failClosedRows = await harness.db
        .transaction()
        .execute(async (trx) => {
          await sql`SET LOCAL ROLE nexstock_app_user`.execute(trx);
          await sql`SELECT set_config('app.current_tenant_id', '', true)`.execute(trx);
          return await trx.selectFrom('tenant_invitations').selectAll().execute();
        });

      expect(failClosedRows).toHaveLength(0);
    });
  });

  describe('5. Employee Account Linking Guardrails', () => {
    it('rejects linking TENANT_OWNER user account to an employee profile (400 HRM_INVALID_STAFF_LINK)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp2Id}/link-user`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          userId: OWNER_A_USER_ID,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('HRM_INVALID_STAFF_LINK');
    });

    it('rejects linking an already-linked employee without unlinking first (409 HRM_EMPLOYEE_ALREADY_LINKED)', async () => {
      // emp1 is already linked to staff user from Section 4
      const res = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp1Id}/link-user`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          userId: OWNER_A_USER_ID,
        },
      });

      // Employee is already linked check fires first
      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('HRM_EMPLOYEE_ALREADY_LINKED');
    });

    it('rejects linking a user who is not a member of the tenant (400 HRM_USER_NOT_TENANT_MEMBER)', async () => {
      // OWNER_B_USER_ID exists in the system (users table) but belongs to Tenant B, not Tenant A
      const res = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp2Id}/link-user`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          userId: OWNER_B_USER_ID,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('HRM_USER_NOT_TENANT_MEMBER');
    });

    it('rejects linking a user that does not exist in the system (404 AUTH_USER_NOT_FOUND)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/employees/${emp2Id}/link-user`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          userId: '0192b4c0-0000-7000-8000-999999999999',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().errorCode).toBe('AUTH_USER_NOT_FOUND');
    });
  });

  describe('6. Staff RBAC Enforcement & Self-Service Isolation', () => {
    let staffToken: string;

    beforeAll(async () => {
      // Find staff user id for qa-staff01@nexstock.test
      const member = await harness.db
        .selectFrom('users')
        .select(['id', 'email'])
        .where('email', '=', 'qa-staff01@nexstock.test')
        .executeTakeFirst();
      expect(member).toBeDefined();

      staffToken = issueToken(member!.id, member!.email);
    });

    it('allows authenticated staff user to access their own employee profile via GET /v1/employees/me', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/employees/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const me = res.json();
      expect(me.id).toBe(emp1Id);
      expect(me.firstName).toBe('QA');
      expect(me.lastName).toBe('Phase71 Test01');
    });

    it('allows authenticated staff user to view holiday calendar (GET /v1/org/holidays)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/org/holidays',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().items)).toBe(true);
    });

    it('allows authenticated staff user to perform self-service attendance check-in and check-out', async () => {
      // Check in
      const inRes = await app.inject({
        method: 'POST',
        url: '/v1/attendance/check-in',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          notes: 'Staff morning clock-in',
        },
      });

      expect(inRes.statusCode).toBe(200);
      const inRec = inRes.json();
      expect(inRec.employeeId).toBe(emp1Id);
      expect(['PRESENT', 'LATE']).toContain(inRec.status);

      // Check out
      const outRes = await app.inject({
        method: 'POST',
        url: '/v1/attendance/check-out',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          notes: 'Staff evening clock-out',
        },
      });

      expect(outRes.statusCode).toBe(200);
      const outRec = outRes.json();
      expect(outRec.employeeId).toBe(emp1Id);
      expect(outRec.checkOutTime).toBeDefined();
    });

    it('DENY-BY-DEFAULT: rejects staff user attempting to view other employee profiles (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/employees/${emp2Id}`,
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('DENY-BY-DEFAULT: rejects staff user attempting to manage invitations (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          email: 'illegal@nexstock.test',
          roleCode: 'STAFF',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('DENY-BY-DEFAULT: rejects staff user attempting to access organization member list (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('DENY-BY-DEFAULT: rejects staff user attempting to trigger payroll runs (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payroll/runs',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          frequency: 'MONTHLY',
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          paymentDate: '2026-11-30',
          currencyCode: 'LKR',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('DENY-BY-DEFAULT: rejects staff user attempting to access financial credit accounts (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/credit/accounts',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('7. Member Status Management & Access Revocation', () => {
    let staffMembershipId: string;
    let ownerMembershipId: string;
    let staffToken: string;

    beforeAll(async () => {
      const membersRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });
      const members = membersRes.json() as Array<{ id: string; userId: string; email: string }>;
      const staffMember = members.find((m) => m.email === 'qa-staff01@nexstock.test');
      const ownerMember = members.find((m) => m.email === OWNER_A_EMAIL);
      expect(staffMember).toBeDefined();
      expect(ownerMember).toBeDefined();

      staffMembershipId = staffMember!.id;
      ownerMembershipId = ownerMember!.id;

      staffToken = issueToken(staffMember!.userId, staffMember!.email);
    });

    it('rejects deactivating the Tenant Owner account (400 IAM_CANNOT_DISABLE_OWNER)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${ownerMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          status: 'DISABLED',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('IAM_CANNOT_DISABLE_OWNER');
    });

    it('deactivates staff member account (PATCH /v1/iam/members/:id/status -> DISABLED)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${staffMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          status: 'DISABLED',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('DISABLED');

      // Attempting to access self-service now fails because membership is DISABLED
      const accessRes = await app.inject({
        method: 'GET',
        url: '/v1/employees/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });
      expect([401, 403]).toContain(accessRes.statusCode);
    });

    it('re-activates staff member account (PATCH /v1/iam/members/:id/status -> ACTIVE)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${staffMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
        payload: {
          status: 'ACTIVE',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ACTIVE');

      // Access restored
      const accessRes = await app.inject({
        method: 'GET',
        url: '/v1/employees/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });
      expect(accessRes.statusCode).toBe(200);
    });

    it('rejects revoking the Tenant Owner account (400 IAM_CANNOT_REVOKE_OWNER)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/iam/members/${ownerMembershipId}`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('IAM_CANNOT_REVOKE_OWNER');
    });

    it('revokes staff member access and unlinks their employee record (DELETE /v1/iam/members/:id)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/iam/members/${staffMembershipId}`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // Verify employee record is now unlinked (linked_user_id is NULL)
      const empRes = await app.inject({
        method: 'GET',
        url: `/v1/employees/${emp1Id}`,
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });
      expect(empRes.statusCode).toBe(200);
      expect(empRes.json().linkedUserId).toBeNull();
    });
  });

  describe('8. Cross-Tenant Isolation Enforcement', () => {
    it('prevents Tenant B from listing or accessing Tenant A invitations', async () => {
      // Owner B requests Tenant A's invitations -> 403 Forbidden
      const res = await app.inject({
        method: 'GET',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerBToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('isolates invitation lists completely between tenants', async () => {
      // Create invitation in Tenant B
      const createBRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerBToken}`,
          'x-tenant-id': TENANT_B_ID,
        },
        payload: {
          email: 'beta-staff@other-corp.com',
          roleCode: 'STAFF',
        },
      });
      expect(createBRes.statusCode).toBe(201);

      // Tenant A listing does not contain beta-staff
      const listARes = await app.inject({
        method: 'GET',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerAToken}`,
          'x-tenant-id': TENANT_A_ID,
        },
      });
      const listA = listARes.json() as Array<{ email: string }>;
      expect(listA.some((inv) => inv.email === 'beta-staff@other-corp.com')).toBe(false);

      // Tenant B listing contains beta-staff
      const listBRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerBToken}`,
          'x-tenant-id': TENANT_B_ID,
        },
      });
      const listB = listBRes.json() as Array<{ email: string }>;
      expect(listB.some((inv) => inv.email === 'beta-staff@other-corp.com')).toBe(true);
    });
  });
});
