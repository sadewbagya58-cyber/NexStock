import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  generateUuidV7,
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

describe('@nexstock/api — Master Production Remediation V2 Test Suite', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192e000-0000-7000-8000-000000000010';
  const OWNER_USER_ID = '0192e000-0000-7000-8000-000000000011';
  const STAFF_USER_ID = '0192e000-0000-7000-8000-000000000012';

  const primaryKey = createTestEs256KeyMaterial('test-key-master-v2');
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
  let staffToken: string;
  let branchId: string;
  let warehouseId: string;
  let registerId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    ownerToken = issueToken(OWNER_USER_ID, 'owner@masterv2.com');
    staffToken = issueToken(STAFF_USER_ID, 'staff@masterv2.com');

    // 1. Onboard Tenant
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        slug: 'master-remediation-v2',
        legalName: 'Master Remediation V2 Store',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@masterv2.com',
        ownerFullName: 'Master Owner',
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
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        code: 'BR-MAIN',
        name: 'Main Store Branch',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
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
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        branchId,
        code: 'WH-MAIN',
        name: 'Main Central Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    warehouseId = whRes.json().id;

    // 4. Create Register
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        branchId,
        code: 'REG-01',
        name: 'Front Counter Terminal 01',
      },
    });
    expect(regRes.statusCode).toBe(201);
    registerId = regRes.json().id;
  });

  it('BUG-068: Products pagination limit accepts up to 250 without union validation failure', async () => {
    // limit = 100
    const res100 = await app.inject({
      method: 'GET',
      url: '/v1/products?limit=100',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(res100.statusCode).toBe(200);

    // limit = 250
    const res250 = await app.inject({
      method: 'GET',
      url: '/v1/products?limit=250',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(res250.statusCode).toBe(200);

    // limit = 251 exceeds maximum of 250
    const res251 = await app.inject({
      method: 'GET',
      url: '/v1/products?limit=251',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(res251.statusCode).toBe(400);
  });

  it('BUG-067: Staff account revocation (status REVOKED, access denied) and re-invitation with same email succeeds', async () => {
    // Step 1: Invite a staff member
    const inviteRes = await app.inject({
      method: 'POST',
      url: '/v1/iam/invitations',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        email: 'staff@masterv2.com',
        roleCode: 'BRANCH_MANAGER',
      },
    });
    expect(inviteRes.statusCode).toBe(201);
    const invitationCode = inviteRes.json().invitationCode;
    expect(invitationCode).toBeDefined();

    // Step 2: Accept invitation with staff user
    const acceptRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      headers: {
        authorization: `Bearer ${staffToken}`,
      },
      payload: {
        code: invitationCode,
        password: 'Password123!',
        fullName: 'Test Staff',
      },
    });
    expect(acceptRes.statusCode).toBe(200);
    const staffAuthUserId = acceptRes.json().user.id;
    const acceptedStaffToken = issueToken(staffAuthUserId, 'staff@masterv2.com');

    const firstMembership = await harness.db
      .selectFrom('tenant_memberships')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('user_id', '=', staffAuthUserId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();
    const firstMembershipId = firstMembership.id;
    expect(firstMembershipId).toBeDefined();

    // Step 3: Staff member can successfully access tenant resource
    const checkActiveRes = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${acceptedStaffToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(checkActiveRes.statusCode).toBe(200);

    // Step 4: Revoke the staff member's access
    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `/v1/iam/members/${firstMembershipId}`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().success).toBe(true);

    // Step 5: Verify the membership in DB is status = 'REVOKED' (not hard deleted, preserving audit)
    const dbMembership = await harness.db
      .selectFrom('tenant_memberships')
      .selectAll()
      .where('id', '=', firstMembershipId)
      .executeTakeFirst();
    expect(dbMembership?.status).toBe('REVOKED');

    // Step 6: Verify staff token is now rejected with 403
    const checkRevokedRes = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${acceptedStaffToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(checkRevokedRes.statusCode).toBe(403);

    // Step 7: Owner re-invites the same email
    const reInviteRes = await app.inject({
      method: 'POST',
      url: '/v1/iam/invitations',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        email: 'staff@masterv2.com',
        roleCode: 'BRANCH_MANAGER',
      },
    });
    expect(reInviteRes.statusCode).toBe(201);
    const newInvitationCode = reInviteRes.json().invitationCode;

    // Step 8: Staff accepts new invitation
    const reAcceptRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      headers: {
        authorization: `Bearer ${staffToken}`,
      },
      payload: {
        code: newInvitationCode,
        password: 'Password123!',
        fullName: 'Test Staff Reinvited',
      },
    });
    expect(reAcceptRes.statusCode).toBe(200);
    const secondMembership = await harness.db
      .selectFrom('tenant_memberships')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('user_id', '=', staffAuthUserId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();
    const secondMembershipId = secondMembership.id;
    expect(secondMembershipId).toBeDefined();
    expect(secondMembershipId).not.toBe(firstMembershipId);

    // Step 9: Staff access is restored with new membership
    const checkRestoredRes = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${acceptedStaffToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(checkRestoredRes.statusCode).toBe(200);
  });

  it('Stage I: Variable batch selling price overrides product default selling price in POS checkout', async () => {
    // 1. Create a product with default selling price 100.00
    const prodRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        sku: 'SKU-BATCH-PRICE',
        name: 'Batch Pricing Test Item',
        baseUom: 'PCS',
        sellingPrice: '100.0000',
        purchaseCost: '60.0000',
        trackInventory: true,
        trackingMode: 'BATCH_EXPIRY',
        valuationMethod: 'FIFO',
      },
    });
    expect(prodRes.statusCode).toBe(201);
    const batchProductId = prodRes.json().id;

    // 2. Create Batch A with higher selling price: 145.00
    const batchRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        warehouseId,
        productId: batchProductId,
        batchNumber: 'BATCH-PREMIUM-01',
        initialQuantity: '50.0000',
        unitCost: '60.0000',
        sellingPrice: '145.0000',
        expiryDate: '2028-12-31',
      },
    });
    expect(batchRes.statusCode).toBe(201);
    const batchId = batchRes.json().id;

    // 3. Receive stock of Batch A into warehouse
    const moveRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        branchId,
        warehouseId,
        productId: batchProductId,
        movementType: 'OPENING_STOCK',
        quantity: '50.0000',
        uomCode: 'PCS',
        unitCost: '60.0000',
        batchId,
        referenceType: 'MANUAL',
        referenceId: 'OB-BATCH-001',
      },
    });
    expect(moveRes.statusCode).toBe(201);

    // 4. Open POS Shift
    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        registerId,
        openingCashFloat: '1000.0000',
      },
    });
    expect(shiftRes.statusCode).toBe(201);

    // 5. Checkout 2 units of this product with explicit batchId
    const checkoutRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId,
        lines: [
          {
            productId: batchProductId,
            quantity: '2.0000',
            uomCode: 'PCS',
            batchId,
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '290.0000', // 2 * 145.00 = 290.00 (not 2 * 100.00 = 200.00)
            tenderedAmount: '300.0000',
          },
        ],
      },
    });
    expect(checkoutRes.statusCode).toBe(201);
    const sale = checkoutRes.json();
    // 2 units * 145.00 batch price = 290.00 total
    expect(parseFloat(sale.grandTotal)).toBe(290);
    expect(parseFloat(sale.lines[0].unitPrice)).toBe(145);
    expect(parseFloat(sale.lines[0].lineTotal)).toBe(290);
  });

  it('Stage C: Stocktake lifecycle (DRAFT -> COUNTS -> SUBMITTED -> APPROVED -> POSTED) and posting idempotency', async () => {
    // 1. Create Stocktake session in DRAFT
    const createStRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/stocktakes',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        branchId,
        warehouseId,
        scope: 'FULL_WAREHOUSE',
        notes: 'Monthly Physical Stock Audit',
      },
    });
    expect(createStRes.statusCode).toBe(201);
    const session = createStRes.json();
    expect(session.status).toBe('DRAFT');
    const sessionId = session.id;

    // 2. Record physical counts
    const countRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/stocktakes/${sessionId}/counts`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        lines: session.lines.map((l: { productId: string }) => ({
          productId: l.productId,
          countedQty: '10.000000',
          notes: 'Verified physical box count',
        })),
      },
    });
    expect(countRes.statusCode).toBe(200);

    // 3. Submit stocktake
    const submitRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/stocktakes/${sessionId}/submit`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(submitRes.statusCode).toBe(200);
    expect(submitRes.json().status).toBe('SUBMITTED');

    // 4. Review & Approve
    const approveRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/stocktakes/${sessionId}/review`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        action: 'APPROVE',
      },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().status).toBe('APPROVED');

    // 5. Post Adjustments
    const postRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/stocktakes/${sessionId}/post-adjustments`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(postRes.statusCode).toBe(200);
    expect(postRes.json().status).toBe('POSTED');

    // 6. Idempotency / Duplicate Post Rejection (409)
    const dupRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/stocktakes/${sessionId}/post-adjustments`,
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
    });
    expect(dupRes.statusCode).toBe(409);
    expect(dupRes.json().errorCode).toBe('INV_STOCKTAKE_ALREADY_POSTED');
  });
});
