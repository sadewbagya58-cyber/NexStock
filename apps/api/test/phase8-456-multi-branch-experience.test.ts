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

describe('@nexstock/api — Phase 8.4, 8.5 & 8.6: Staff Branch RBAC, Multi-Branch POS & Centralized Dashboard', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const keyMaterial = createTestEs256KeyMaterial('phase8-456-key-1');
  const jwksProvider = new StaticJwksProvider({
    keys: [keyMaterial.publicJwk],
  });

  const TENANT_A = '0192b5e0-1111-7000-8000-000000000010';
  const TENANT_B = '0192b5e0-2222-7000-8000-000000000020';
  const OWNER_A_ID = '0192b5e0-1111-7000-8000-000000000001';
  const OWNER_B_ID = '0192b5e0-2222-7000-8000-000000000001';
  const MANAGER_ID = '0192b5e0-1111-7000-8000-000000000002';
  const CASHIER_ID = '0192b5e0-1111-7000-8000-000000000003';

  let ownerAToken: string;
  let ownerBToken: string;
  let managerToken: string;
  let cashierToken: string;

  let branch1Id: string;
  let wh1Id: string;
  let branch2Id: string;
  let wh2Id: string;
  let branch3Id: string;
  let wh3Id: string;

  let cashierMembershipId: string;

  let reg1Id: string;
  let reg2Id: string;

  let prodAId: string;
  let prodBNoCostId: string;

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
    ownerAToken = issueToken(OWNER_A_ID, 'owner-a@phase8456.test');
    ownerBToken = issueToken(OWNER_B_ID, 'owner-b@phase8456.test');
    managerToken = issueToken(MANAGER_ID, 'mgr@phase8456.test');
    cashierToken = issueToken(CASHIER_ID, 'cashier@phase8456.test');

    app = await buildApp({ db: harness.db, jwksProvider });

    const onboardA = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: headers(ownerAToken, TENANT_A),
      payload: {
        slug: 'phase8456-store-a',
        legalName: 'NexStock Multi-Branch Enterprises',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner-a@phase8456.test',
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
        slug: 'phase8456-store-b',
        legalName: 'Foreign Tenant Co',
        baseCurrency: 'USD',
        ownerEmail: 'owner-b@phase8456.test',
        ownerFullName: 'Owner Beta',
        planCode: 'ENTERPRISE',
      },
    });
    expect(onboardB.statusCode).toBe(201);

    // Create 3 branches with auto default warehouses
    const b1 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerAToken),
      payload: { code: 'CMB-01', name: 'Colombo Flagship', city: 'Colombo' },
    });
    expect(b1.statusCode).toBe(201);
    branch1Id = b1.json().id;
    wh1Id = b1.json().defaultWarehouseId;

    const b2 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerAToken),
      payload: { code: 'KDY-01', name: 'Kandy Outlet', city: 'Kandy' },
    });
    expect(b2.statusCode).toBe(201);
    branch2Id = b2.json().id;
    wh2Id = b2.json().defaultWarehouseId;

    const b3 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerAToken),
      payload: { code: 'GLE-01', name: 'Galle Express', city: 'Galle' },
    });
    expect(b3.statusCode).toBe(201);
    branch3Id = b3.json().id;
    wh3Id = b3.json().defaultWarehouseId;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  it('1. Phase 8.4 — Invitations with branch scopes, multi-branch assignment, removal & privilege escalation defense', async () => {
    // Owner invites Branch Manager assigned ONLY to [branch1, branch2]
    const invRes = await app.inject({
      method: 'POST',
      url: '/v1/iam/invitations',
      headers: headers(ownerAToken),
      payload: {
        email: 'mgr@phase8456.test',
        roleCode: 'BRANCH_MANAGER',
        allLocationsAccess: false,
        branchIds: [branch1Id, branch2Id],
        warehouseIds: [wh1Id, wh2Id],
      },
    });
    expect(invRes.statusCode).toBe(201);
    const invBody = invRes.json();
    expect(invBody.allLocationsAccess).toBe(false);
    expect(invBody.branchIds).toEqual([branch1Id, branch2Id]);
    expect(invBody.warehouseIds).toEqual([wh1Id, wh2Id]);

    // Manager accepts invitation
    const acceptRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      headers: { 'content-type': 'application/json' },
      payload: {
        code: invBody.invitationCode,
        email: 'mgr@phase8456.test',
        password: 'Password123!',
        fullName: 'Manager MultiBranch',
      },
    });
    expect(acceptRes.statusCode).toBe(200);
    const acceptedUserId = acceptRes.json().user.id as string;
    managerToken = issueToken(acceptedUserId, 'mgr@phase8456.test');

    // Provision Cashier scoped strictly to branch2 initially
    const cashierProvision = await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_A, userId: OWNER_A_ID, traceId: 'seed-cashier-8456' },
      async (trx) =>
        provisionTenantMember(trx, {
          userId: CASHIER_ID,
          email: 'cashier@phase8456.test',
          fullName: 'Cashier Kandy',
          roleCodes: ['CASHIER'],
          allLocationsAccess: false,
          branchIds: [branch2Id],
          warehouseIds: [wh2Id],
        }),
    );
    cashierMembershipId = cashierProvision.membershipId;

    // Owner checks /v1/iam/members -> sees populated assignedBranches summaries
    const membersRes = await app.inject({
      method: 'GET',
      url: '/v1/iam/members',
      headers: headers(ownerAToken),
    });
    expect(membersRes.statusCode).toBe(200);
    const members = membersRes.json();
    const mgrRow = members.find((m: { userId: string }) => m.userId === acceptedUserId);
    const cashRow = members.find((m: { userId: string }) => m.userId === CASHIER_ID);
    expect(mgrRow).toBeTruthy();
    expect(cashRow).toBeTruthy();
    expect(mgrRow.id).toBeTruthy();
    expect(mgrRow.allLocationsAccess).toBe(false);
    expect(mgrRow.assignedBranches.map((b: { code: string }) => b.code).sort()).toEqual([
      'CMB-01',
      'KDY-01',
    ]);
    expect(cashRow.assignedBranches.map((b: { code: string }) => b.code)).toEqual(['KDY-01']);

    // Verify Manager sees only branch1 and branch2 in /v1/org/branches (never branch3!)
    const mgrBranchesRes = await app.inject({
      method: 'GET',
      url: '/v1/org/branches?status=ACTIVE',
      headers: headers(managerToken),
    });
    expect(mgrBranchesRes.statusCode).toBe(200);
    expect(mgrBranchesRes.json().items.map((b: { id: string }) => b.id).sort()).toEqual(
      [branch1Id, branch2Id].sort(),
    );

    // Privilege escalation guard: even if a role had iam:member:manage, restricted actor cannot grant allLocations or branch3
    const branchManagerEsc = await app.inject({
      method: 'PUT',
      url: `/v1/iam/members/${cashierMembershipId}/location-scopes`,
      headers: headers(managerToken),
      payload: {
        allLocationsAccess: true,
        branchIds: [],
        warehouseIds: [],
      },
    });
    expect(branchManagerEsc.statusCode).toBe(403);

    // Owner adds branch1 temporarily to Cashier, then removes it
    const addScopeRes = await app.inject({
      method: 'PUT',
      url: `/v1/iam/members/${cashierMembershipId}/location-scopes`,
      headers: headers(ownerAToken),
      payload: {
        allLocationsAccess: false,
        branchIds: [branch1Id, branch2Id],
        warehouseIds: [wh1Id, wh2Id],
      },
    });
    expect(addScopeRes.statusCode).toBe(200);
    expect(
      addScopeRes.json().assignedBranches.map((b: { code: string }) => b.code).sort(),
    ).toEqual(['CMB-01', 'KDY-01']);

    // Owner removes branch1 from Cashier -> back to branch2 ONLY
    const removeScopeRes = await app.inject({
      method: 'PUT',
      url: `/v1/iam/members/${cashierMembershipId}/location-scopes`,
      headers: headers(ownerAToken),
      payload: {
        allLocationsAccess: false,
        branchIds: [branch2Id],
        warehouseIds: [wh2Id],
      },
    });
    expect(removeScopeRes.statusCode).toBe(200);
    expect(removeScopeRes.json().assignedBranches.map((b: { code: string }) => b.code)).toEqual([
      'KDY-01',
    ]);
  });

  it('2. Phase 8.5 — Multi-Branch POS isolation, on-demand default register, branch-strict stock deduction & sales/shifts scoping', async () => {
    // Seed 2 products
    const pARes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerAToken),
      payload: {
        sku: 'POS-MILK-1L',
        name: 'Fresh Milk 1L',
        baseUom: 'PCS',
        purchaseCost: '600.0000',
        sellingPrice: '1000.0000',
        trackInventory: true,
        reorderPoint: '6.0000',
        reorderQty: '10.0000',
      },
    });
    expect(pARes.statusCode).toBe(201);
    prodAId = pARes.json().id;

    const pBRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerAToken),
      payload: {
        sku: 'POS-CUP-01',
        name: 'Gift Mug (No Cost Seeded)',
        baseUom: 'PCS',
        purchaseCost: '0.0000',
        sellingPrice: '500.0000',
        trackInventory: true,
        reorderPoint: '5.0000',
        reorderQty: '10.0000',
      },
    });
    expect(pBRes.statusCode).toBe(201);
    prodBNoCostId = pBRes.json().id;

    // Opening stock across branches: branch1=20, branch2=8, branch3=12 for Product A; branch1=3 for Product B (LOW_STOCK)
    const stockSeed = [
      { branchId: branch1Id, warehouseId: wh1Id, productId: prodAId, qty: '20.0000', cost: '600.0000', key: 'seed-b1-a' },
      { branchId: branch2Id, warehouseId: wh2Id, productId: prodAId, qty: '8.0000', cost: '600.0000', key: 'seed-b2-a' },
      { branchId: branch3Id, warehouseId: wh3Id, productId: prodAId, qty: '12.0000', cost: '600.0000', key: 'seed-b3-a' },
      { branchId: branch1Id, warehouseId: wh1Id, productId: prodBNoCostId, qty: '3.0000', cost: '0.0000', key: 'seed-b1-b' },
    ];
    for (const s of stockSeed) {
      const mRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: headers(ownerAToken, TENANT_A, { 'idempotency-key': randomUUID() }),
        payload: {
          branchId: s.branchId,
          warehouseId: s.warehouseId,
          productId: s.productId,
          movementType: 'OPENING_STOCK',
          quantity: s.qty,
          unitCost: s.cost,
          reason: 'Initial branch stock',
        },
      });
      expect(mRes.statusCode).toBe(201);
    }

    // Ensure default POS registers on branch1, branch2, branch3
    const ensure1 = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: headers(ownerAToken),
      payload: { branchId: branch1Id },
    });
    expect(ensure1.statusCode).toBe(200);
    reg1Id = ensure1.json().id;
    expect(ensure1.json().branchCode).toBe('CMB-01');

    // Calling ensure-default a second time returns the exact same register
    const ensure1Again = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: headers(ownerAToken),
      payload: { branchId: branch1Id },
    });
    expect(ensure1Again.statusCode).toBe(200);
    expect(ensure1Again.json().id).toBe(reg1Id);

    const ensure2 = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: headers(ownerAToken),
      payload: { branchId: branch2Id },
    });
    expect(ensure2.statusCode).toBe(200);
    reg2Id = ensure2.json().id;

    const ensure3 = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: headers(ownerAToken),
      payload: { branchId: branch3Id },
    });
    expect(ensure3.statusCode).toBe(200);
    expect(ensure3.json().id).toBeTruthy();

    // Cashier assigned ONLY to branch2 cannot see branch1 or branch3 registers
    const cashierRegsRes = await app.inject({
      method: 'GET',
      url: '/v1/pos/registers',
      headers: headers(cashierToken),
    });
    expect(cashierRegsRes.statusCode).toBe(200);
    expect(cashierRegsRes.json().map((r: { id: string }) => r.id)).toEqual([reg2Id]);

    // Cashier querying branch1 registers or warehouse1 catalog MUST be rejected 403
    const cashierForbiddenReg = await app.inject({
      method: 'GET',
      url: `/v1/pos/registers?branchId=${branch1Id}`,
      headers: headers(cashierToken),
    });
    expect(cashierForbiddenReg.statusCode).toBe(403);

    const cashierForbiddenCatalog = await app.inject({
      method: 'GET',
      url: `/v1/pos/products/search?warehouseId=${wh1Id}`,
      headers: headers(cashierToken),
    });
    expect(cashierForbiddenCatalog.statusCode).toBe(403);

    // Cashier searches branch2 catalog -> sees only 8 units in wh2
    const cashierCatalogRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/products/search?warehouseId=${wh2Id}`,
      headers: headers(cashierToken),
    });
    expect(cashierCatalogRes.statusCode).toBe(200);
    const prodAInWh2 = cashierCatalogRes.json().find((p: { id: string }) => p.id === prodAId);
    expect(Number(prodAInWh2.availableQuantity)).toBe(8);

    // Cashier opens shift on branch2 register, cannot open on branch1 register
    const badShiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: headers(cashierToken),
      payload: { registerId: reg1Id, openingCashFloat: '5000.0000' },
    });
    expect(badShiftRes.statusCode).toBe(403);

    const openShift2Res = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: headers(cashierToken),
      payload: { registerId: reg2Id, openingCashFloat: '5000.0000' },
    });
    expect(openShift2Res.statusCode).toBe(201);
    const shift2Id = openShift2Res.json().id;

    // Cashier sells 3 units of Product A at branch2 (3 x 1000 = 3000)
    const sale2Res = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(cashierToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId: reg2Id,
        shiftId: shift2Id,
        lines: [{ productId: prodAId, uomCode: 'PCS', quantity: '3.0000' }],
        payments: [{ paymentMethod: 'CASH', amount: '3000.0000', tenderedAmount: '3000.0000' }],
      },
    });
    expect(sale2Res.statusCode).toBe(201);
    expect(sale2Res.json().branchId).toBe(branch2Id);

    // Verify branch2 stock dropped 8 -> 5 while branch1=20 and branch3=12 remain untouched
    const balB1 = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh1Id}`,
      headers: headers(ownerAToken),
    });
    const balB2 = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh2Id}`,
      headers: headers(ownerAToken),
    });
    const balB3 = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?warehouseId=${wh3Id}`,
      headers: headers(ownerAToken),
    });
    expect(Number(balB1.json().data.find((x: { productId: string }) => x.productId === prodAId).qtyOnHand)).toBe(20);
    expect(Number(balB2.json().data.find((x: { productId: string }) => x.productId === prodAId).qtyOnHand)).toBe(5);
    expect(Number(balB3.json().data.find((x: { productId: string }) => x.productId === prodAId).qtyOnHand)).toBe(12);

    // Branch Manager (assigned branch1 & branch2) opens shift & executes sale on branch1 (2 x Milk + 1 x Gift Mug = 2500)
    const openShift1Res = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: headers(managerToken),
      payload: { registerId: reg1Id, openingCashFloat: '10000.0000' },
    });
    expect(openShift1Res.statusCode).toBe(201);
    const shift1Id = openShift1Res.json().id;

    const sale1Res = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(managerToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId: reg1Id,
        shiftId: shift1Id,
        lines: [
          { productId: prodAId, uomCode: 'PCS', quantity: '2.0000' },
          { productId: prodBNoCostId, uomCode: 'PCS', quantity: '1.0000' },
        ],
        payments: [{ paymentMethod: 'CASH', amount: '2500.0000', tenderedAmount: '2500.0000' }],
      },
    });
    expect(sale1Res.statusCode).toBe(201);

    // Also record a voided sale on branch1 (must NOT add to sales total)
    const voidTargetRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: headers(managerToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        registerId: reg1Id,
        shiftId: shift1Id,
        lines: [{ productId: prodAId, uomCode: 'PCS', quantity: '1.0000' }],
        payments: [{ paymentMethod: 'CASH', amount: '1000.0000', tenderedAmount: '1000.0000' }],
      },
    });
    expect(voidTargetRes.statusCode).toBe(201);
    const voidRes = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${voidTargetRes.json().id}/void`,
      headers: headers(managerToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: { reason: 'QA mistake void' },
    });
    expect(voidRes.statusCode).toBe(200);

    // Branch isolation on GET /v1/pos/sales & GET /v1/pos/shifts
    const cashierSales = await app.inject({
      method: 'GET',
      url: '/v1/pos/sales',
      headers: headers(cashierToken),
    });
    expect(cashierSales.statusCode).toBe(200);
    expect(cashierSales.json().every((s: { branchId: string }) => s.branchId === branch2Id)).toBe(true);
    expect(cashierSales.json().length).toBe(1);

    const mgrForbiddenSales = await app.inject({
      method: 'GET',
      url: `/v1/pos/sales?branchId=${branch3Id}`,
      headers: headers(managerToken),
    });
    expect(mgrForbiddenSales.statusCode).toBe(403);

    // Branch shifts filter checks branch1 vs branch2 cleanly
    const b2Shifts = await app.inject({
      method: 'GET',
      url: `/v1/pos/shifts?branchId=${branch2Id}`,
      headers: headers(ownerAToken),
    });
    expect(b2Shifts.statusCode).toBe(200);
    expect(b2Shifts.json().length).toBe(1);
    expect(b2Shifts.json()[0].id).toBe(shift2Id);
  });

  it('3. Phase 8.6 — Centralized Business Dashboard KPIs, Branch Comparison, Transfer Exclusion, Cost Coverage & Security', async () => {
    // Perform an inter-branch stock transfer (branch1 -> branch2, 2 units of Product A) — must NOT count as sales!
    const trfRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/transfers',
      headers: headers(ownerAToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        sourceBranchId: branch1Id,
        destinationBranchId: branch2Id,
        autoComplete: true,
        notes: 'Replenish Kandy',
        lines: [{ productId: prodAId, quantity: '2.0000' }],
      },
    });
    expect(trfRes.statusCode).toBe(201);

    // Also process a customer return on branch2 sale for 1 unit (refund 1000) -> net Kandy sales = 3000 - 1000 = 2000
    const b2SalesRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/sales?branchId=${branch2Id}`,
      headers: headers(ownerAToken),
    });
    const b2Sale = b2SalesRes.json()[0];
    const retRes = await app.inject({
      method: 'POST',
      url: `/v1/pos/sales/${b2Sale.id}/returns`,
      headers: headers(ownerAToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        reason: 'Customer changed mind',
        refundMethod: 'CASH',
        lines: [
          {
            invoiceLineId: b2Sale.lines[0].id,
            returnQty: '1.0000',
            returnUom: 'PCS',
            restockCondition: 'RESELLABLE',
          },
        ],
      },
    });
    expect(retRes.statusCode).toBe(201);

    // Business-Wide Dashboard (Owner)
    const dashAll = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?datePreset=TODAY',
      headers: headers(ownerAToken),
    });
    expect(dashAll.statusCode).toBe(200);
    const bodyAll = dashAll.json();
    expect(bodyAll.scopeMode).toBe('BUSINESS_WIDE');
    expect(bodyAll.allLocationsAccess).toBe(true);
    // Gross = 2500 (branch1) + 3000 (branch2) = 5500; Void (1000) & Transfer excluded; Refund = 1000; Net = 4500
    expect(Number(bodyAll.kpis.grossSales)).toBeCloseTo(5500, 2);
    expect(Number(bodyAll.kpis.refundTotal)).toBeCloseTo(1000, 2);
    expect(Number(bodyAll.kpis.totalSales)).toBeCloseTo(4500, 2);
    expect(bodyAll.kpis.totalOrders).toBe(2);
    expect(bodyAll.kpis.voidedOrders).toBe(1);
    expect(bodyAll.kpis.returnsCount).toBe(1);
    // Product B had zero cost -> costCoveragePct < 100 & hasIncompleteCostData === true
    expect(bodyAll.kpis.hasIncompleteCostData).toBe(true);
    expect(bodyAll.kpis.costCoveragePct).toBeLessThan(100);
    // Best performing branch = Colombo Flagship (2500 net > Kandy 2000 net)
    expect(bodyAll.bestPerformingBranch?.branchCode).toBe('CMB-01');
    expect(bodyAll.branchComparison.length).toBe(3);
    // Stock transfer appears in recentActivities with null amount
    const trfActivity = bodyAll.recentActivities.find(
      (a: { activityType: string }) => a.activityType === 'STOCK_TRANSFER',
    );
    expect(trfActivity).toBeTruthy();
    expect(trfActivity.amount).toBeNull();
    // Low stock watchlist catches Gift Mug (2 remaining <= 5 reorder point)
    expect(bodyAll.lowStockWatchlist.some((w: { sku: string }) => w.sku === 'POS-CUP-01')).toBe(true);

    // Single-Branch Filter Dashboard (Kandy = 2000 net)
    const dashB2 = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/summary?datePreset=TODAY&branchId=${branch2Id}`,
      headers: headers(ownerAToken),
    });
    expect(dashB2.statusCode).toBe(200);
    expect(dashB2.json().scopeMode).toBe('SINGLE_BRANCH');
    expect(Number(dashB2.json().kpis.totalSales)).toBeCloseTo(2000, 2);
    expect(dashB2.json().branchComparison.length).toBe(1);
    expect(dashB2.json().branchComparison[0].branchId).toBe(branch2Id);

    // Date presets: YESTERDAY returns 0 orders for today's sales; THIS_WEEK & THIS_MONTH include today
    const dashYesterday = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?datePreset=YESTERDAY',
      headers: headers(ownerAToken),
    });
    expect(dashYesterday.statusCode).toBe(200);
    expect(dashYesterday.json().kpis.totalOrders).toBe(0);
    expect(Number(dashYesterday.json().kpis.totalSales)).toBe(0);

    const dashMonth = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?datePreset=THIS_MONTH',
      headers: headers(ownerAToken),
    });
    expect(dashMonth.statusCode).toBe(200);
    expect(Number(dashMonth.json().kpis.totalSales)).toBeCloseTo(4500, 2);

    // Multi-branch Manager sees only branch1 & branch2 (NOT branch3!)
    const dashMgr = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?datePreset=TODAY',
      headers: headers(managerToken),
    });
    expect(dashMgr.statusCode).toBe(200);
    expect(dashMgr.json().allLocationsAccess).toBe(false);
    expect(dashMgr.json().branchComparison.map((b: { branchId: string }) => b.branchId).sort()).toEqual(
      [branch1Id, branch2Id].sort(),
    );
    const dashMgrForbidden = await app.inject({
      method: 'GET',
      url: `/v1/dashboard/summary?datePreset=TODAY&branchId=${branch3Id}`,
      headers: headers(managerToken),
    });
    expect(dashMgrForbidden.statusCode).toBe(403);

    // Cross-tenant isolation: Tenant B sees zero data from Tenant A
    const dashTenantB = await app.inject({
      method: 'GET',
      url: '/v1/dashboard/summary?datePreset=TODAY',
      headers: headers(ownerBToken, TENANT_B),
    });
    expect(dashTenantB.statusCode).toBe(200);
    expect(dashTenantB.json().kpis.totalOrders).toBe(0);
    expect(Number(dashTenantB.json().kpis.totalSales)).toBe(0);
  });
});
