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

describe('@nexstock/api — Phase 8: Multi-Branch Management, Auto Default Warehouse, Inter-Branch Transfers & Access Scope', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const keyMaterial = createTestEs256KeyMaterial('phase8-key-1');
  const jwksProvider = new StaticJwksProvider({
    keys: [keyMaterial.publicJwk],
  });

  const TENANT_A = '0192b4e0-1111-7000-8000-000000000010';
  const TENANT_B = '0192b4e0-2222-7000-8000-000000000020';
  const OWNER_A_ID = '0192b4e0-1111-7000-8000-000000000001';
  const OWNER_B_ID = '0192b4e0-2222-7000-8000-000000000001';
  const SCOPED_EMP_ID = '0192b4e0-1111-7000-8000-000000000002';

  let ownerAToken: string;
  let ownerBToken: string;
  let scopedEmpToken: string;

  let mainBranchId: string;
  let mainWhId: string;
  let branch2Id: string;
  let branch2WhId: string;
  let branch3Id: string;
  let branch3WhId: string;

  let stdProductId: string;
  let batchProductId: string;
  let serialProductId: string;
  let serial1Id: string;

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
    ownerAToken = issueToken(OWNER_A_ID, 'owner-a@phase8.test');
    ownerBToken = issueToken(OWNER_B_ID, 'owner-b@phase8.test');
    scopedEmpToken = issueToken(SCOPED_EMP_ID, 'emp@phase8.test');
    app = await buildApp({ db: harness.db, jwksProvider });

    const onboardA = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: headers(ownerAToken, TENANT_A),
      payload: {
        slug: 'phase8-retail-a',
        legalName: 'Phase 8 Multi-Branch Stores Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner-a@phase8.test',
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
        slug: 'phase8-retail-b',
        legalName: 'Other Tenant LLC',
        baseCurrency: 'USD',
        ownerEmail: 'owner-b@phase8.test',
        ownerFullName: 'Owner Beta',
        planCode: 'ENTERPRISE',
      },
    });
    expect(onboardB.statusCode).toBe(201);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  it('1. Branch Creation, Auto Default Warehouse with Zero Initial Stock, Edit, Archive, Restore & Main Branch Designation', async () => {
    // 1a. Create Main Branch (first branch -> auto-designated Main Branch + auto Default Warehouse)
    const createMain = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerAToken),
      payload: {
        code: 'CMB-01',
        name: 'Colombo Flagship',
        city: 'Colombo',
        address: 'No. 10 Galle Road',
        phone: '+94 11 234 5678',
        email: 'colombo@phase8.test',
        managerName: 'Nimal Perera',
      },
    });
    expect(createMain.statusCode).toBe(201);
    const mainB = createMain.json();
    mainBranchId = mainB.id;
    mainWhId = mainB.defaultWarehouseId;
    expect(mainB.isMainBranch).toBe(true);
    expect(mainB.status).toBe('ACTIVE');
    expect(mainWhId).toBeTruthy();
    expect(mainB.defaultWarehouseCode).toBe('WH-CMB-01-DEF');
    expect(mainB.city).toBe('Colombo');
    expect(mainB.managerName).toBe('Nimal Perera');

    // Duplicate branch code must be rejected with 409
    const dupCodeRes = await app.inject({
      method: 'POST',
      url: '/v1/branches',
      headers: headers(ownerAToken),
      payload: { code: 'cmb-01', name: 'Duplicate Branch' },
    });
    expect(dupCodeRes.statusCode).toBe(409);

    // 1b. Seed products & stock ONLY in Main Branch BEFORE creating Branch 2
    const prodStdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerAToken),
      payload: {
        sku: 'TEA-500',
        name: 'Ceylon Gold Tea 500g',
        productType: 'STANDARD',
        trackingMode: 'NONE',
        valuationMethod: 'MOVING_AVG',
        baseUom: 'PCS',
        purchaseCost: '500.0000',
        sellingPrice: '850.0000',
        trackInventory: true,
      },
    });
    expect(prodStdRes.statusCode).toBe(201);
    stdProductId = prodStdRes.json().id;

    const prodBatchRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerAToken),
      payload: {
        sku: 'MILK-1K',
        name: 'Milk Powder 1KG',
        productType: 'STANDARD',
        trackingMode: 'BATCH_EXPIRY',
        valuationMethod: 'FIFO',
        allocationPolicy: 'FEFO',
        baseUom: 'PCS',
        purchaseCost: '1200.0000',
        sellingPrice: '1650.0000',
        trackInventory: true,
      },
    });
    expect(prodBatchRes.statusCode).toBe(201);
    batchProductId = prodBatchRes.json().id;

    const prodSerialRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerAToken),
      payload: {
        sku: 'SCAN-USB',
        name: 'Barcode Scanner USB',
        productType: 'STANDARD',
        trackingMode: 'SERIAL',
        valuationMethod: 'MOVING_AVG',
        baseUom: 'PCS',
        purchaseCost: '9000.0000',
        sellingPrice: '14500.0000',
        trackInventory: true,
      },
    });
    expect(prodSerialRes.statusCode).toBe(201);
    serialProductId = prodSerialRes.json().id;

    // Receive stock into Main Branch Default Warehouse ONLY
    const openStd = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headers(ownerAToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: mainBranchId,
        warehouseId: mainWhId,
        productId: stdProductId,
        movementType: 'OPENING_STOCK',
        quantity: '25.000000',
        unitCost: '500.0000',
      },
    });
    expect(openStd.statusCode).toBe(201);

    const openBatch = await app.inject({
      method: 'POST',
      url: '/v1/inventory/batches',
      headers: headers(ownerAToken),
      payload: {
        branchId: mainBranchId,
        warehouseId: mainWhId,
        productId: batchProductId,
        batchNumber: 'LOT-MILK-01',
        initialQuantity: '10.000000',
        unitCost: '1200.0000',
        sellingPrice: '1700.0000',
        expiryDate: '2028-12-31',
      },
    });
    expect(openBatch.statusCode).toBe(201);

    const regSerial = await app.inject({
      method: 'POST',
      url: '/v1/inventory/serials',
      headers: headers(ownerAToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: mainBranchId,
        warehouseId: mainWhId,
        productId: serialProductId,
        serialNumbers: ['SN-P8-001', 'SN-P8-002'],
        unitCost: '9000.0000',
      },
    });
    expect(regSerial.statusCode).toBe(201);
    serial1Id = regSerial.json()[0].id;

    // 1c. Create Branch 2 & Branch 3: verify Default Warehouse created automatically AND ZERO stock copied!
    const createB2 = await app.inject({
      method: 'POST',
      url: '/v1/branches',
      headers: headers(ownerAToken),
      payload: {
        code: 'KDY-02',
        name: 'Kandy City Outlet',
        city: 'Kandy',
        phone: '+94 81 223 4455',
        managerName: 'Kasun Silva',
      },
    });
    expect(createB2.statusCode).toBe(201);
    const b2 = createB2.json();
    branch2Id = b2.id;
    branch2WhId = b2.defaultWarehouseId;
    expect(b2.isMainBranch).toBe(false);
    expect(branch2WhId).toBeTruthy();

    // Branch 2 Default Warehouse MUST start with ZERO stock
    const b2Bal = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?branchId=${branch2Id}`,
      headers: headers(ownerAToken),
    });
    expect(b2Bal.statusCode).toBe(200);
    expect(b2Bal.json().data).toHaveLength(0);

    const createB3 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerAToken),
      payload: { code: 'GAL-03', name: 'Galle Fort Shop', city: 'Galle' },
    });
    expect(createB3.statusCode).toBe(201);
    branch3Id = createB3.json().id;
    branch3WhId = createB3.json().defaultWarehouseId;
    expect(branch3WhId).toBeTruthy();

    // 1d. Edit Branch details & verify persistence
    const editB2 = await app.inject({
      method: 'PATCH',
      url: `/v1/org/branches/${branch2Id}`,
      headers: headers(ownerAToken),
      payload: {
        name: 'Kandy Dalada Veediya Branch',
        address: '45 Dalada Veediya',
        phone: '+94 81 999 0000',
      },
    });
    expect(editB2.statusCode).toBe(200);
    expect(editB2.json().name).toBe('Kandy Dalada Veediya Branch');
    expect(editB2.json().address).toBe('45 Dalada Veediya');
    expect(editB2.json().city).toBe('Kandy');

    // 1e. Main Branch cannot be archived while Main
    const archiveMainAttempt = await app.inject({
      method: 'POST',
      url: `/v1/org/branches/${mainBranchId}/archive`,
      headers: headers(ownerAToken),
      payload: {},
    });
    expect(archiveMainAttempt.statusCode).toBe(409);

    // 1f. Archive Branch 3 -> excluded from status=ACTIVE, present in status=ARCHIVED & ALL -> Restore Branch 3
    const archiveB3 = await app.inject({
      method: 'POST',
      url: `/v1/branches/${branch3Id}/archive`,
      headers: headers(ownerAToken),
      payload: {},
    });
    expect(archiveB3.statusCode).toBe(200);
    expect(archiveB3.json().isActive).toBe(false);
    expect(archiveB3.json().status).toBe('ARCHIVED');

    const activeList = await app.inject({
      method: 'GET',
      url: '/v1/org/branches?status=ACTIVE',
      headers: headers(ownerAToken),
    });
    expect(activeList.statusCode).toBe(200);
    expect(activeList.json().items.some((b: { id: string }) => b.id === branch3Id)).toBe(false);

    const archivedList = await app.inject({
      method: 'GET',
      url: '/v1/org/branches?status=ARCHIVED',
      headers: headers(ownerAToken),
    });
    expect(archivedList.statusCode).toBe(200);
    expect(archivedList.json().items.some((b: { id: string }) => b.id === branch3Id)).toBe(true);

    // Transfer to archived branch must be blocked
    const transferArchivedAttempt = await app.inject({
      method: 'POST',
      url: '/v1/inventory/transfers',
      headers: headers(ownerAToken),
      payload: {
        sourceBranchId: mainBranchId,
        destinationBranchId: branch3Id,
        autoComplete: true,
        lines: [{ productId: stdProductId, quantity: '2.000000' }],
      },
    });
    expect(transferArchivedAttempt.statusCode).toBe(409);

    const restoreB3 = await app.inject({
      method: 'POST',
      url: `/v1/branches/${branch3Id}/restore`,
      headers: headers(ownerAToken),
      payload: {},
    });
    expect(restoreB3.statusCode).toBe(200);
    expect(restoreB3.json().isActive).toBe(true);
    expect(restoreB3.json().status).toBe('ACTIVE');

    // Designate Branch 2 as Main Branch and then restore Main designation to Colombo
    const setMain2 = await app.inject({
      method: 'POST',
      url: `/v1/org/branches/${branch2Id}/set-main`,
      headers: headers(ownerAToken),
      payload: {},
    });
    expect(setMain2.statusCode).toBe(200);
    expect(setMain2.json().isMainBranch).toBe(true);

    const setMain1 = await app.inject({
      method: 'POST',
      url: `/v1/org/branches/${mainBranchId}/set-main`,
      headers: headers(ownerAToken),
      payload: {},
    });
    expect(setMain1.statusCode).toBe(200);
    expect(setMain1.json().isMainBranch).toBe(true);
  });

  it('2. Simple Inter-Branch Stock Transfers (MAC, FEFO Batch & Serial), Overdraft Block, Traceability & Zero Financial Distortion', async () => {
    // 2a. Overdraft blocked (25 available, request 30 -> 409)
    const overdraftRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/transfers',
      headers: headers(ownerAToken),
      payload: {
        sourceBranchId: mainBranchId,
        destinationBranchId: branch2Id,
        autoComplete: true,
        lines: [{ productId: stdProductId, quantity: '30.000000' }],
      },
    });
    expect(overdraftRes.statusCode).toBe(409);
    expect(overdraftRes.json().errorCode).toBe('INV_INSUFFICIENT_AVAILABLE_STOCK');

    // Same-branch blocked (422)
    const sameBranchRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/transfers',
      headers: headers(ownerAToken),
      payload: {
        sourceBranchId: mainBranchId,
        destinationBranchId: mainBranchId,
        autoComplete: true,
        lines: [{ productId: stdProductId, quantity: '1.000000' }],
      },
    });
    expect(sameBranchRes.statusCode).toBe(422);

    // 2b. Single-step transfer of MAC, FEFO Batch, and Serial products (warehouses auto-resolved)
    const transferRes = await app.inject({
      method: 'POST',
      url: '/v1/inventory/transfers',
      headers: headers(ownerAToken),
      payload: {
        sourceBranchId: mainBranchId,
        destinationBranchId: branch2Id,
        autoComplete: true,
        notes: 'Initial branch stock replenishment',
        lines: [
          { productId: stdProductId, quantity: '10.000000' },
          { productId: batchProductId, quantity: '4.000000' },
          { productId: serialProductId, quantity: '1.000000', serialIds: [serial1Id] },
        ],
      },
    });
    expect(transferRes.statusCode).toBe(201);
    const tr = transferRes.json();
    expect(tr.status).toBe('RECEIVED');
    expect(tr.transferNumber).toMatch(/^TRF-/);
    expect(tr.sourceBranchName).toBe('Colombo Flagship');
    expect(tr.destinationBranchName).toBe('Kandy Dalada Veediya Branch');
    expect(tr.createdByName).toBe('Owner Alpha');
    expect(tr.lines).toHaveLength(3);
    expect(tr.lines[0].productSku).toBe('TEA-500');
    expect(tr.lines[1].batchNumberSnapshot).toBe('LOT-MILK-01');
    expect(tr.lines[1].sellingPriceSnapshot).toBe('1700.0000');
    expect(tr.lines[2].serialNumber).toBe('SN-P8-001');

    // Verify Main Branch balances decreased accurately
    const mainBals = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?branchId=${mainBranchId}`,
      headers: headers(ownerAToken),
    });
    expect(mainBals.statusCode).toBe(200);
    const mainMap = new Map(
      mainBals.json().data.map((r: { productId: string; qtyOnHand: string }) => [r.productId, r.qtyOnHand]),
    );
    expect(mainMap.get(stdProductId)).toBe('15.000000');
    expect(mainMap.get(batchProductId)).toBe('6.000000');
    expect(mainMap.get(serialProductId)).toBe('1.000000');

    // Verify Branch 2 balances increased accurately
    const b2Bals = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?branchId=${branch2Id}`,
      headers: headers(ownerAToken),
    });
    expect(b2Bals.statusCode).toBe(200);
    const b2Map = new Map(
      b2Bals.json().data.map((r: { productId: string; qtyOnHand: string }) => [r.productId, r.qtyOnHand]),
    );
    expect(b2Map.get(stdProductId)).toBe('10.000000');
    expect(b2Map.get(batchProductId)).toBe('4.000000');
    expect(b2Map.get(serialProductId)).toBe('1.000000');

    // Verify serial identity moved to Branch 2 & remains IN_STOCK
    const b2Serials = await app.inject({
      method: 'GET',
      url: `/v1/inventory/serials?branchId=${branch2Id}`,
      headers: headers(ownerAToken),
    });
    expect(b2Serials.statusCode).toBe(200);
    expect(b2Serials.json().data).toHaveLength(1);
    expect(b2Serials.json().data[0].serialNumber).toBe('SN-P8-001');
    expect(b2Serials.json().data[0].status).toBe('IN_STOCK');
    expect(b2Serials.json().data[0].branchId).toBe(branch2Id);

    // Verify transfers are NOT counted as sales, purchases, revenue, or expenses in Business Reports
    const [salesRep, purRep, profitRep] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/reports/business?category=SALES', headers: headers(ownerAToken) }),
      app.inject({ method: 'GET', url: '/v1/reports/business?category=PURCHASING', headers: headers(ownerAToken) }),
      app.inject({ method: 'GET', url: '/v1/reports/business?category=PROFITABILITY', headers: headers(ownerAToken) }),
    ]);
    expect(salesRep.statusCode).toBe(200);
    expect(Number(salesRep.json().sales.summary.netSales)).toBe(0);
    expect(Number(purRep.json().purchasing.summary.netPurchasesValue)).toBe(0);
    expect(Number(profitRep.json().profitability.summary.grossProfit)).toBe(0);
  });

  it('3. Branch Scope Isolation for Multi-Branch Employee vs Owner Business-Wide Visibility & Tenant Isolation', async () => {
    // Provision an employee authorized ONLY for Branch 2 and Branch 3 (NOT Main Branch!)
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_A, userId: OWNER_A_ID, traceId: 'seed_scoped_emp_phase8' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: SCOPED_EMP_ID,
          email: 'emp@phase8.test',
          fullName: 'Regional Manager (B2 & B3)',
          roleCodes: ['BRANCH_MANAGER'],
          allLocationsAccess: false,
          branchIds: [branch2Id, branch3Id],
          warehouseIds: [branch2WhId, branch3WhId],
          status: 'ACTIVE',
        });
      },
    );

    // Employee sees ONLY Branch 2 & Branch 3 in /v1/org/branches
    const empBranchesRes = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: headers(scopedEmpToken),
    });
    expect(empBranchesRes.statusCode).toBe(200);
    const empBranchIds = empBranchesRes.json().items.map((b: { id: string }) => b.id);
    expect(empBranchIds).toContain(branch2Id);
    expect(empBranchIds).toContain(branch3Id);
    expect(empBranchIds).not.toContain(mainBranchId);

    // Employee attempting to tamper ID to Main Branch gets 403 IAM_LOCATION_SCOPE_DENIED across APIs
    const empReadMainBranch = await app.inject({
      method: 'GET',
      url: `/v1/org/branches/${mainBranchId}`,
      headers: headers(scopedEmpToken),
    });
    expect(empReadMainBranch.statusCode).toBe(403);
    expect(empReadMainBranch.json().errorCode).toBe('IAM_LOCATION_SCOPE_DENIED');

    const empReadMainBal = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?branchId=${mainBranchId}`,
      headers: headers(scopedEmpToken),
    });
    expect(empReadMainBal.statusCode).toBe(403);
    expect(empReadMainBal.json().errorCode).toBe('IAM_LOCATION_SCOPE_DENIED');

    const empTransferFromMain = await app.inject({
      method: 'POST',
      url: '/v1/inventory/transfers',
      headers: headers(scopedEmpToken),
      payload: {
        sourceBranchId: mainBranchId,
        destinationBranchId: branch2Id,
        autoComplete: true,
        lines: [{ productId: stdProductId, quantity: '1.000000' }],
      },
    });
    expect(empTransferFromMain.statusCode).toBe(403);
    expect(empTransferFromMain.json().errorCode).toBe('IAM_LOCATION_SCOPE_DENIED');

    // Employee CAN view Branch 2 inventory and transfer between their two authorized branches (Branch 2 -> Branch 3)
    const empB2ToB3Transfer = await app.inject({
      method: 'POST',
      url: '/v1/inventory/transfers',
      headers: headers(scopedEmpToken),
      payload: {
        sourceBranchId: branch2Id,
        destinationBranchId: branch3Id,
        autoComplete: true,
        lines: [{ productId: stdProductId, quantity: '3.000000' }],
      },
    });
    expect(empB2ToB3Transfer.statusCode).toBe(201);

    // Owner sees all 3 branches' balances business-wide (no branchId filter)
    const ownerAllBals = await app.inject({
      method: 'GET',
      url: '/v1/inventory/balances?limit=100',
      headers: headers(ownerAToken),
    });
    expect(ownerAllBals.statusCode).toBe(200);
    const stdRows = ownerAllBals.json().data.filter((r: { productId: string }) => r.productId === stdProductId);
    expect(stdRows).toHaveLength(3); // Branch 1: 15, Branch 2: 7, Branch 3: 3
    const sumStd = stdRows.reduce((s: number, r: { qtyOnHand: string }) => s + Number(r.qtyOnHand), 0);
    expect(sumStd).toBe(25);

    // Tenant B Owner is strictly isolated (0 branches, 403 on Tenant A)
    const tenantBBranches = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: headers(ownerBToken, TENANT_B),
    });
    expect(tenantBBranches.statusCode).toBe(200);
    expect(tenantBBranches.json().items).toHaveLength(0);

    const crossTenantAttempt = await app.inject({
      method: 'GET',
      url: '/v1/org/branches',
      headers: headers(ownerBToken, TENANT_A),
    });
    expect(crossTenantAttempt.statusCode).toBe(403);
  });
});
