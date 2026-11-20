import { randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  provisionTenantMember,
  withTenantTransaction,
} from '../src/index.js';
import {
  type TestPostgresHarness,
  createTestPostgresHarness,
} from './helpers/pglite-kysely.js';

interface TestEs256KeyMaterial {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: SupabaseJwk;
}

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
  const header = { alg: 'ES256', typ: 'JWT', kid: keyMaterial.kid };
  const headerB64 = Buffer.from(JSON.stringify(header), 'utf-8').toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf-8');
  const signature = sign('sha256', signingInput, {
    key: keyMaterial.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}

describe('@nexstock/api — Phase 9.1 & 9.2 Offline Snapshot & Branch Authorization', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const keyMaterial = createTestEs256KeyMaterial('phase9-snap-key-1');
  const jwksProvider = new StaticJwksProvider({
    keys: [keyMaterial.publicJwk],
  });

  const TENANT_A = '0192b700-1111-7000-8000-000000000010';
  const TENANT_B = '0192b700-2222-7000-8000-000000000020';
  const OWNER_A_ID = '0192b700-1111-7000-8000-000000000001';
  const OWNER_B_ID = '0192b700-2222-7000-8000-000000000001';
  const CASHIER_B1_ID = '0192b700-1111-7000-8000-000000000003';

  let ownerAToken: string;
  let ownerBToken: string;
  let cashierB1Token: string;

  let branch1Id: string;
  let wh1Id: string;
  let branch2Id: string;
  let wh2Id: string;

  const issueToken = (userId: string, email: string) =>
    signEs256Jwt(keyMaterial, {
      sub: userId,
      aud: DEFAULT_SUPABASE_JWT_AUDIENCE,
      iss: DEFAULT_SUPABASE_JWT_ISSUER,
      email,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

  const headers = (token: string, tenantId = TENANT_A, extra?: Record<string, string>) => ({
    authorization: `Bearer ${token}`,
    'x-tenant-id': tenantId,
    'content-type': 'application/json',
    ...extra,
  });

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    ownerAToken = issueToken(OWNER_A_ID, 'owner-a@phase9.test');
    ownerBToken = issueToken(OWNER_B_ID, 'owner-b@phase9.test');
    cashierB1Token = issueToken(CASHIER_B1_ID, 'cashier-b1@phase9.test');
    app = await buildApp({ db: harness.db, jwksProvider });

    const onboardA = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: headers(ownerAToken, TENANT_A),
      payload: {
        slug: 'phase9-offline-a',
        legalName: 'Phase 9 Offline Stores',
        baseCurrency: 'LKR',
        ownerEmail: 'owner-a@phase9.test',
        ownerFullName: 'Owner Alpha',
        planCode: 'ENTERPRISE',
      },
    });
    expect(onboardA.statusCode).toBe(201);

    const onboardB = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: headers(ownerBToken, TENANT_B),
      payload: {
        slug: 'phase9-offline-b',
        legalName: 'Tenant Beta Stores',
        baseCurrency: 'USD',
        ownerEmail: 'owner-b@phase9.test',
        ownerFullName: 'Owner Beta',
        planCode: 'ENTERPRISE',
      },
    });
    expect(onboardB.statusCode).toBe(201);

    const b1 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerAToken),
      payload: { code: 'CMB-01', name: 'Colombo Main' },
    });
    branch1Id = b1.json().id;
    wh1Id = b1.json().defaultWarehouseId;

    const b2 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerAToken),
      payload: { code: 'KDY-01', name: 'Kandy Outlet' },
    });
    branch2Id = b2.json().id;
    wh2Id = b2.json().defaultWarehouseId;

    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_A, userId: OWNER_A_ID, traceId: 'seed-p9-cashier' },
      async (trx) =>
        provisionTenantMember(trx, {
          userId: CASHIER_B1_ID,
          email: 'cashier-b1@phase9.test',
          fullName: 'Cashier Colombo',
          roleCodes: ['CASHIER'],
          allLocationsAccess: false,
          branchIds: [branch1Id],
          warehouseIds: [wh1Id],
        }),
    );

    await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: headers(ownerAToken),
      payload: { branchId: branch1Id },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: headers(ownerAToken),
      payload: { branchId: branch2Id },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  it('returns complete branch-scoped Phase 9.2 catalog, categories, customers, balances, registers, and deviceAuthorization while blocking unauthorized branches', async () => {
    const catRes = await app.inject({
      method: 'POST',
      url: '/v1/categories',
      headers: headers(ownerAToken),
      payload: { name: 'Beverages' },
    });
    expect(catRes.statusCode).toBe(201);

    const prodRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerAToken),
      payload: {
        sku: 'OFF-SODA-1',
        name: 'Ginger Beer 330ml',
        categoryId: catRes.json().id,
        baseUom: 'PCS',
        purchaseCost: '110.0000',
        sellingPrice: '150.0000',
        primaryBarcode: '4795555666677',
        trackInventory: true,
      },
    });
    expect(prodRes.statusCode).toBe(201);
    const prodId = prodRes.json().id;

    // Seed stock into BOTH branch1 (10) and branch2 (25)
    for (const seed of [
      { branchId: branch1Id, warehouseId: wh1Id, quantity: '10.000000' },
      { branchId: branch2Id, warehouseId: wh2Id, quantity: '25.000000' },
    ]) {
      const mv = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: headers(ownerAToken, TENANT_A, { 'idempotency-key': randomUUID() }),
        payload: {
          ...seed,
          productId: prodId,
          movementType: 'OPENING_STOCK',
          unitCost: '110.0000',
        },
      });
      expect(mv.statusCode).toBe(201);
    }

    const custRes = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: headers(ownerAToken),
      payload: { name: 'Offline Buyer', phone: '+94771112233' },
    });
    expect(custRes.statusCode).toBe(201);

    // Branch1-restricted Cashier fetches /v1/sync/catalog-pricing
    const snapRes = await app.inject({
      method: 'GET',
      url: `/v1/sync/catalog-pricing?branchId=${branch1Id}`,
      headers: headers(cashierB1Token),
    });
    expect(snapRes.statusCode).toBe(200);
    const body = snapRes.json();

    expect(body.tenantId).toBe(TENANT_A);
    expect(body.categories.some((c: { name: string }) => c.name === 'Beverages')).toBe(true);
    expect(body.customers.some((c: { name: string }) => c.name === 'Offline Buyer')).toBe(true);
    expect(body.globalPrices[0].primaryBarcode).toBe('4795555666677');
    expect(body.branches.map((b: { id: string }) => b.id)).toEqual([branch1Id]);
    expect(body.registers.every((r: { branchId: string }) => r.branchId === branch1Id)).toBe(true);
    expect(body.balances).toHaveLength(1);
    expect(Number(body.balances[0].availableQty)).toBe(10);
    expect(body.deviceAuthorization.allowedBranchIds).toEqual([branch1Id]);
    expect(body.deviceAuthorization.allLocationsAccess).toBe(false);

    // Cashier requesting Branch2 offline snapshot must be rejected 403
    const forbiddenSnap = await app.inject({
      method: 'GET',
      url: `/v1/sync/catalog-pricing?branchId=${branch2Id}`,
      headers: headers(cashierB1Token),
    });
    expect(forbiddenSnap.statusCode).toBe(403);

    // Tenant B sees zero Tenant A offline data
    const tenantBSnap = await app.inject({
      method: 'GET',
      url: '/v1/sync/catalog-pricing',
      headers: headers(ownerBToken, TENANT_B),
    });
    expect(tenantBSnap.statusCode).toBe(200);
    expect(tenantBSnap.json().customers).toHaveLength(0);
    expect(tenantBSnap.json().globalPrices).toHaveLength(0);
  });
});
