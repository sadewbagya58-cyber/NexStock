import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  getOrCreateDevKeyMaterial,
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

describe('@nexstock/api — Master Remediation: Membership Lifecycle, Owner Protection & POS Category System (BUG-067, BUG-076, BUG-077)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192b4c0-0000-7000-8000-0000000000a1';
  const OWNER_USER_ID = '0192b4c0-0000-7000-8000-0000000000a2';
  const OWNER_EMAIL = 'owner@nexstock-remediation.com';

  const STAFF_EMAIL = 'staff.john@nexstock-remediation.com';
  let staffUserId = '';
  let staffToken = '';
  let staffMembershipId = '';
  let ownerMembershipId = '';

  let branchId = '';
  let warehouseId = '';

  const primaryKey = createTestEs256KeyMaterial('01f76c4b-9743-48ad-bed6-a9c89dc99cc8');
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

  let ownerToken: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    ownerToken = issueToken(OWNER_USER_ID, OWNER_EMAIL);

    // Onboard organization
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        slug: 'nexstock-remediation-corp',
        legalName: 'NexStock Remediation Corp',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'UTC',
        countryCode: 'US',
        ownerEmail: OWNER_EMAIL,
        ownerFullName: 'Primary Owner',
      },
    });

    expect(onboardRes.statusCode).toBe(201);
    ownerMembershipId = onboardRes.json().ownerMembershipId;

    // Create Branch
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        code: 'BR-MAIN',
        name: 'Main Store',
        timezone: 'UTC',
        countryCode: 'US',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    branchId = branchRes.json().id;

    // Create Warehouse
    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        branchId,
        code: 'WH-MAIN',
        name: 'Main Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    warehouseId = whRes.json().id;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  describe('Group A (BUG-067): Staff Membership Lifecycle Transitions & Same-Email Re-invitation', () => {
    let invitationCode = '';

    it('1. Invites and provisions a staff member account', async () => {
      const inviteRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          email: STAFF_EMAIL,
          roleCode: 'STAFF',
        },
      });

      expect(inviteRes.statusCode).toBe(201);
      const inviteData = inviteRes.json();
      invitationCode = inviteData.invitationCode;
      expect(invitationCode).toMatch(/^\d{4}$/);

      // Validate invitation
      const valRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/invitations/validate?token=${invitationCode}`,
      });
      expect(valRes.statusCode).toBe(200);
      expect(valRes.json().valid).toBe(true);

      // Accept invitation
      const acceptRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: {
          code: invitationCode,
          email: STAFF_EMAIL,
          password: 'Password123!',
          fullName: 'Staff John',
        },
      });

      expect(acceptRes.statusCode).toBe(200);
      const acceptData = acceptRes.json();
      staffUserId = acceptData.user.id;
      expect(staffUserId).toBeDefined();

      staffToken = issueToken(staffUserId, STAFF_EMAIL);

      // Verify active membership exists
      const membersRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(membersRes.statusCode).toBe(200);
      const staffMember = membersRes.json().find((m: { email: string }) => m.email === STAFF_EMAIL);
      expect(staffMember).toBeDefined();
      expect(staffMember.status).toBe('ACTIVE');
      staffMembershipId = staffMember.id;
    });

    it('2. Deactivates member account and rejects subsequent API calls (403 IAM_MEMBERSHIP_DEACTIVATED)', async () => {
      const deactRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${staffMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          status: 'DEACTIVATED',
        },
      });

      expect(deactRes.statusCode).toBe(200);
      expect(deactRes.json().status).toBe('DEACTIVATED');

      // Attempting to access API using staffToken returns 403 IAM_MEMBERSHIP_DEACTIVATED
      const readRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(readRes.statusCode).toBe(403);
      expect(readRes.json().errorCode).toBe('IAM_MEMBERSHIP_DEACTIVATED');
    });

    it('3. Reactivates deactivated member account back to ACTIVE', async () => {
      const reactRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${staffMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          status: 'ACTIVE',
        },
      });

      expect(reactRes.statusCode).toBe(200);
      expect(reactRes.json().status).toBe('ACTIVE');

      // Staff can access API again
      const readRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(readRes.statusCode).toBe(200);
    });

    it('4. Rejects suspension without reason (400 IAM_SUSPENSION_REASON_REQUIRED)', async () => {
      const noReasonRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${staffMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          status: 'SUSPENDED',
        },
      });

      expect(noReasonRes.statusCode).toBe(400);
      expect(noReasonRes.json().errorCode).toBe('IAM_SUSPENSION_REASON_REQUIRED');
    });

    it('5. Suspends member with valid reason and rejects subsequent API calls (403 IAM_MEMBERSHIP_SUSPENDED)', async () => {
      const suspRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${staffMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          status: 'SUSPENDED',
          reason: 'Internal security audit investigation',
        },
      });

      expect(suspRes.statusCode).toBe(200);
      const suspData = suspRes.json();
      expect(suspData.status).toBe('SUSPENDED');
      expect(suspData.suspensionReason).toBe('Internal security audit investigation');

      // Staff access returns 403 IAM_MEMBERSHIP_SUSPENDED
      const readRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(readRes.statusCode).toBe(403);
      expect(readRes.json().errorCode).toBe('IAM_MEMBERSHIP_SUSPENDED');
    });

    it('6. Unsuspends suspended member back to ACTIVE and clears suspension reason', async () => {
      const unsuspRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${staffMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          status: 'ACTIVE',
        },
      });

      expect(unsuspRes.statusCode).toBe(200);
      const unsuspData = unsuspRes.json();
      expect(unsuspData.status).toBe('ACTIVE');
      expect(unsuspData.suspensionReason).toBeNull();

      // Access restored
      const readRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(readRes.statusCode).toBe(200);
    });

    it('7. Revokes member access completely (status REVOKED, access denied)', async () => {
      const revokeRes = await app.inject({
        method: 'DELETE',
        url: `/v1/iam/members/${staffMembershipId}`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(revokeRes.statusCode).toBe(200);

      // Verify member list retains record as REVOKED
      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const revokedMember = listRes.json().find((m: { id: string }) => m.id === staffMembershipId);
      expect(revokedMember).toBeDefined();
      expect(revokedMember.status).toBe('REVOKED');
      expect(revokedMember.roles).toEqual([]);

      // Staff access returns 403 IAM_MEMBERSHIP_REVOKED
      const readRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members/me',
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(readRes.statusCode).toBe(403);
      expect(readRes.json().errorCode).toBe('IAM_MEMBERSHIP_REVOKED');
    });

    it('8. Rejects direct reactivation of REVOKED membership (400 IAM_INVALID_MEMBERSHIP_TRANSITION)', async () => {
      const directReactivateRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${staffMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          status: 'ACTIVE',
        },
      });

      expect(directReactivateRes.statusCode).toBe(400);
      expect(directReactivateRes.json().errorCode).toBe('IAM_INVALID_MEMBERSHIP_TRANSITION');
    });

    it('9. Re-invites same email: generates fresh invitation, indicates isExistingUser, reuses auth user_id and provisions new ACTIVE membership', async () => {
      // Re-invite same email
      const reInviteRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          email: STAFF_EMAIL,
          roleCode: 'CASHIER',
        },
      });

      expect(reInviteRes.statusCode).toBe(201);
      const newCode = reInviteRes.json().invitationCode;

      // Validate new invitation indicates isExistingUser: true
      const valRes = await app.inject({
        method: 'GET',
        url: `/v1/auth/invitations/validate?token=${newCode}`,
      });
      expect(valRes.statusCode).toBe(200);
      const valData = valRes.json();
      expect(valData.valid).toBe(true);
      expect(valData.isExistingUser).toBe(true);

      // Accept new invitation
      const acceptRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: {
          code: newCode,
          email: STAFF_EMAIL,
          password: 'Password123!',
          fullName: 'Staff John Re-invited',
        },
      });

      expect(acceptRes.statusCode).toBe(200);
      const acceptData = acceptRes.json();
      // Verifies user_id is identical to original user
      expect(acceptData.user.id).toBe(staffUserId);

      // Verify database state: 2 memberships exist for this user (1 REVOKED, 1 ACTIVE)
      const dbMemberships = await harness.db
        .selectFrom('tenant_memberships')
        .select(['id', 'status', 'created_at'])
        .where('tenant_id', '=', TENANT_ID)
        .where('user_id', '=', staffUserId)
        .orderBy('created_at', 'asc')
        .execute();

      expect(dbMemberships.length).toBe(2);
      const first = dbMemberships[0]!;
      const second = dbMemberships[1]!;
      expect(first.status).toBe('REVOKED');
      expect(first.id).toBe(staffMembershipId);
      expect(second.status).toBe('ACTIVE');
      expect(second.id).not.toBe(staffMembershipId);

      // Verify active membership has CASHIER role
      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const activeStaff = listRes.json().find((m: { id: string }) => m.id === second.id);
      expect(activeStaff).toBeDefined();
      expect(activeStaff.status).toBe('ACTIVE');
      expect(activeStaff.roles.some((r: { code: string }) => r.code === 'CASHIER')).toBe(true);
    });
  });

  describe('Group B (BUG-076): Owner & Organization Protection', () => {
    it('1. Lists Owner account with TENANT_OWNER role and ACTIVE status in /v1/iam/members', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(listRes.statusCode).toBe(200);
      const ownerMember = listRes.json().find((m: { id: string }) => m.id === ownerMembershipId);
      expect(ownerMember).toBeDefined();
      expect(ownerMember.status).toBe('ACTIVE');
      expect(ownerMember.email).toBe(OWNER_EMAIL);
      expect(ownerMember.roles.some((r: { code: string }) => r.code === 'TENANT_OWNER')).toBe(true);
    });

    it('2. Rejects disabling or suspending Owner account (400 IAM_CANNOT_DISABLE_OWNER)', async () => {
      const deactRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${ownerMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          status: 'DEACTIVATED',
        },
      });
      expect(deactRes.statusCode).toBe(400);
      expect(deactRes.json().errorCode).toBe('IAM_CANNOT_DISABLE_OWNER');

      const suspRes = await app.inject({
        method: 'PATCH',
        url: `/v1/iam/members/${ownerMembershipId}/status`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          status: 'SUSPENDED',
          reason: 'Cannot suspend owner',
        },
      });
      expect(suspRes.statusCode).toBe(400);
      expect(suspRes.json().errorCode).toBe('IAM_CANNOT_DISABLE_OWNER');
    });

    it('3. Rejects revoking Owner account access (400 IAM_CANNOT_REVOKE_OWNER)', async () => {
      const revokeRes = await app.inject({
        method: 'DELETE',
        url: `/v1/iam/members/${ownerMembershipId}`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(revokeRes.statusCode).toBe(400);
      expect(revokeRes.json().errorCode).toBe('IAM_CANNOT_REVOKE_OWNER');
    });

    it('4. Returns membershipStatus: REVOKED in /v1/auth/me when a member has only a revoked membership', async () => {
      // Create a temporary staff member and revoke them
      const tempEmail = 'temp.revoked@nexstock-remediation.com';
      const inviteRes = await app.inject({
        method: 'POST',
        url: '/v1/iam/invitations',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          email: tempEmail,
          roleCode: 'STAFF',
        },
      });
      expect(inviteRes.statusCode).toBe(201);
      const code = inviteRes.json().invitationCode;

      const acceptRes = await app.inject({
        method: 'POST',
        url: '/v1/auth/invitations/accept',
        payload: {
          code,
          email: tempEmail,
          password: 'Password123!',
          fullName: 'Temp User',
        },
      });
      expect(acceptRes.statusCode).toBe(200);
      const tempUserId = acceptRes.json().user.id;
      const tempToken = issueToken(tempUserId, tempEmail);

      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/iam/members',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      const tempMember = listRes.json().find((m: { email: string }) => m.email === tempEmail);
      expect(tempMember).toBeDefined();

      // Revoke the temp member
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/v1/iam/members/${tempMember.id}`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });
      expect(delRes.statusCode).toBe(200);

      // Now query /v1/auth/me as the revoked user
      const meRes = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${tempToken}`,
        },
      });
      expect(meRes.statusCode).toBe(200);
      const meData = meRes.json();
      expect(meData.memberships.length).toBe(1);
      expect(meData.memberships[0].membershipStatus).toBe('REVOKED');
      expect(meData.memberships[0].tenantId).toBe(TENANT_ID);
    });
  });

  describe('Group C (BUG-077): POS Category Mapping & Vertical POS Layout Products', () => {
    let catBeveragesId = '';
    let catSnacksId = '';
    let prodEspressoId = '';
    let prodChipsId = '';
    let prodGenericBagId = '';

    it('1. Creates categories and products with category assignments', async () => {
      // Create category Beverages
      const cat1Res = await app.inject({
        method: 'POST',
        url: '/v1/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          name: 'Beverages',
          color: '#3b82f6',
        },
      });
      expect(cat1Res.statusCode).toBe(201);
      catBeveragesId = cat1Res.json().id;

      // Create category Snacks
      const cat2Res = await app.inject({
        method: 'POST',
        url: '/v1/categories',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          name: 'Snacks',
          color: '#10b981',
        },
      });
      expect(cat2Res.statusCode).toBe(201);
      catSnacksId = cat2Res.json().id;

      // Create Espresso in Beverages
      const prod1Res = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          sku: 'BEV-ESP-01',
          name: 'Espresso Single',
          baseUom: 'PCS',
          categoryId: catBeveragesId,
          purchaseCost: '1.5000',
          sellingPrice: '3.5000',
        },
      });
      expect(prod1Res.statusCode).toBe(201);
      prodEspressoId = prod1Res.json().id;

      // Create Potato Chips in Snacks
      const prod2Res = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          sku: 'SNK-CHP-01',
          name: 'Crispy Potato Chips',
          baseUom: 'PCS',
          categoryId: catSnacksId,
          purchaseCost: '0.8000',
          sellingPrice: '2.0000',
        },
      });
      expect(prod2Res.statusCode).toBe(201);
      prodChipsId = prod2Res.json().id;

      // Create Generic Paper Bag without category
      const prod3Res = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
        payload: {
          sku: 'GEN-BAG-01',
          name: 'Generic Paper Bag',
          baseUom: 'PCS',
          purchaseCost: '0.1000',
          sellingPrice: '0.2500',
        },
      });
      expect(prod3Res.statusCode).toBe(201);
      prodGenericBagId = prod3Res.json().id;
    });

    it('2. Search POS products returns categoryId and categoryName accurately', async () => {
      const searchRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${warehouseId}&limit=50`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(searchRes.statusCode).toBe(200);
      const items = searchRes.json();
      expect(items.length).toBeGreaterThanOrEqual(3);

      const espresso = items.find((p: { id: string }) => p.id === prodEspressoId);
      expect(espresso).toBeDefined();
      expect(espresso.categoryId).toBe(catBeveragesId);
      expect(espresso.categoryName).toBe('Beverages');

      const chips = items.find((p: { id: string }) => p.id === prodChipsId);
      expect(chips).toBeDefined();
      expect(chips.categoryId).toBe(catSnacksId);
      expect(chips.categoryName).toBe('Snacks');

      const genericBag = items.find((p: { id: string }) => p.id === prodGenericBagId);
      expect(genericBag).toBeDefined();
      expect(genericBag.categoryId).toBeNull();
      expect(genericBag.categoryName).toBeNull();
    });

    it('3. Filters POS products by categoryId', async () => {
      const filterRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${warehouseId}&categoryId=${catBeveragesId}`,
        headers: {
          authorization: `Bearer ${ownerToken}`,
          'x-tenant-id': TENANT_ID,
        },
      });

      expect(filterRes.statusCode).toBe(200);
      const items = filterRes.json();
      expect(items.length).toBe(1);
      expect(items[0].id).toBe(prodEspressoId);
      expect(items[0].categoryId).toBe(catBeveragesId);
      expect(items[0].categoryName).toBe('Beverages');
    });
  });
});
