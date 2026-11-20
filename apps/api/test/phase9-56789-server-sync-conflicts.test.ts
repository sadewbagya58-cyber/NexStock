import { randomUUID, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
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
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
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

describe('@nexstock/api — Phase 9.5–9.9 Multi-Device Sync, Concurrent Oversell Conflicts & Device Security', () => {
  let harness: TestPostgresHarness;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const keyMaterial = createTestEs256KeyMaterial('phase9-sync-key-1');
  const jwksProvider = new StaticJwksProvider({ keys: [keyMaterial.publicJwk] });

  const TENANT_A = '0192b900-1111-7000-8000-000000000010';
  const TENANT_B = '0192b900-2222-7000-8000-000000000020';
  const OWNER_A_ID = '0192b900-1111-7000-8000-000000000001';
  const OWNER_B_ID = '0192b900-2222-7000-8000-000000000001';

  let ownerAToken: string;
  let ownerBToken: string;
  let branchAId: string;
  let whAId: string;
  let branchBId: string;
  let registerId: string;
  let shiftId: string;
  let productId: string;

  const desktopDeviceId = randomUUID();
  const mobileDeviceId = randomUUID();

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
    ownerAToken = issueToken(OWNER_A_ID, 'owner-a@sync.test');
    ownerBToken = issueToken(OWNER_B_ID, 'owner-b@sync.test');
    app = await buildApp({ db: harness.db, jwksProvider });

    await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: headers(ownerAToken, TENANT_A),
      payload: {
        slug: 'phase9-sync-alpha',
        legalName: 'Phase 9 Sync Alpha Ltd',
        baseCurrency: 'LKR',
        ownerEmail: 'owner-a@sync.test',
        ownerFullName: 'Owner Alpha',
        planCode: 'ENTERPRISE',
      },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: headers(ownerBToken, TENANT_B),
      payload: {
        slug: 'phase9-sync-beta',
        legalName: 'Phase 9 Sync Beta Ltd',
        baseCurrency: 'USD',
        ownerEmail: 'owner-b@sync.test',
        ownerFullName: 'Owner Beta',
        planCode: 'ENTERPRISE',
      },
    });

    const b1 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerAToken),
      payload: { code: 'CMB-01', name: 'Colombo Main' },
    });
    branchAId = b1.json().id;
    whAId = b1.json().defaultWarehouseId;

    const b2 = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: headers(ownerAToken),
      payload: { code: 'KDY-01', name: 'Kandy Outlet' },
    });
    branchBId = b2.json().id;

    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers/ensure-default',
      headers: headers(ownerAToken),
      payload: { branchId: branchAId },
    });
    registerId = regRes.json().id;

    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts/open',
      headers: headers(ownerAToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        registerId,
        openingFloatAmount: '1000.0000',
      },
    });
    shiftId = shiftRes.json().id;

    const prodRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: headers(ownerAToken),
      payload: {
        sku: 'WATER-500ML',
        name: 'Mineral Water 500ml',
        baseUom: 'PCS',
        purchaseCost: '50.0000',
        sellingPrice: '100.0000',
        trackInventory: true,
        valuationMethod: 'MOVING_AVG',
        trackingMode: 'NONE',
      },
    });
    expect(prodRes.statusCode).toBe(201);
    productId = prodRes.json().id;

    const stockIn = await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headers(ownerAToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        productId,
        movementType: 'OPENING_STOCK',
        quantity: '10.000000',
        uomCode: 'PCS',
        unitCost: '50.0000',
        reason: 'Initial opening balance of 10 units',
      },
    });
    expect(stockIn.statusCode).toBe(201);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  it('prevents negative stock on concurrent offline oversell (7 + 6 > 10), preserves payment payload in sync_conflicts, resolves via audit trail, and enforces device revocation & RLS', async () => {
    // 1. Enroll Desktop & Mobile devices
    const enrollDesktop = await app.inject({
      method: 'POST',
      url: '/v1/sync/devices/enroll',
      headers: headers(ownerAToken),
      payload: {
        deviceId: desktopDeviceId,
        branchId: branchAId,
        clientPlatform: 'TAURI_DESKTOP',
        deviceName: 'Front Counter Terminal',
      },
    });
    expect(enrollDesktop.statusCode).toBe(200);

    const enrollMobile = await app.inject({
      method: 'POST',
      url: '/v1/sync/devices/enroll',
      headers: headers(ownerAToken),
      payload: {
        deviceId: mobileDeviceId,
        branchId: branchAId,
        clientPlatform: 'MOBILE_PWA',
        deviceName: 'Floor Tablet 2',
      },
    });
    expect(enrollMobile.statusCode).toBe(200);

    // 2. Desktop offline sale of 7 units syncs FIRST -> APPLIED (stock 10 -> 3)
    const desktopCmdId = randomUUID();
    const pushDesktop = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: headers(ownerAToken),
      payload: {
        deviceId: desktopDeviceId,
        branchId: branchAId,
        commands: [
          {
            localSeq: 1,
            commandId: desktopCmdId,
            tenantId: TENANT_A,
            branchId: branchAId,
            deviceId: desktopDeviceId,
            actorUserId: OWNER_A_ID,
            commandType: 'POS_RECORD_SALE',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              registerId,
              shiftId,
              lines: [{ productId, quantity: '7.000000', uomCode: 'PCS' }],
              payments: [{ paymentMethod: 'CASH', amount: '700.0000', tenderedAmount: '1000.0000' }],
            },
          },
        ],
      },
    });
    expect(pushDesktop.statusCode).toBe(200);
    expect(pushDesktop.json().receipts[0].status).toBe('APPLIED');
    expect(pushDesktop.json().receipts[0].serverReferenceNumber).toBeDefined();

    // 3. Mobile offline sale of 6 units syncs SECOND against remaining 3 units -> QUARANTINED INSUFFICIENT_STOCK_CONFLICT
    const mobileCmdId = randomUUID();
    const pushMobile = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: headers(ownerAToken),
      payload: {
        deviceId: mobileDeviceId,
        branchId: branchAId,
        commands: [
          {
            localSeq: 1,
            commandId: mobileCmdId,
            tenantId: TENANT_A,
            branchId: branchAId,
            deviceId: mobileDeviceId,
            actorUserId: OWNER_A_ID,
            commandType: 'POS_RECORD_SALE',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              registerId,
              shiftId,
              localInvoiceNumber: 'OFF-MOBILE-6UNITS',
              lines: [{ productId, quantity: '6.000000', uomCode: 'PCS' }],
              payments: [{ paymentMethod: 'CASH', amount: '600.0000', tenderedAmount: '600.0000' }],
            },
          },
        ],
      },
    });
    expect(pushMobile.statusCode).toBe(200);
    const mobileReceipt = pushMobile.json().receipts[0];
    expect(mobileReceipt.status).toBe('QUARANTINED');
    expect(mobileReceipt.conflictCode).toBe('INSUFFICIENT_STOCK_CONFLICT');
    const conflictId = mobileReceipt.conflictId as string;
    expect(conflictId).toBeTruthy();

    // Verify authoritative stock is STILL 3.000000 (NEVER went negative -3!)
    const balCheck = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?branchId=${branchAId}`,
      headers: headers(ownerAToken),
    });
    const waterBal = balCheck.json().data.find((x: { productId: string }) => x.productId === productId);
    expect(waterBal.qtyOnHand).toBe('3.000000');

    // 4. Inspect conflict via API — original payload & payment preserved + Tenant B isolated by RLS
    const conflictsResA = await app.inject({
      method: 'GET',
      url: `/v1/sync/conflicts?branchId=${branchAId}`,
      headers: headers(ownerAToken),
    });
    expect(conflictsResA.statusCode).toBe(200);
    expect(conflictsResA.json()).toHaveLength(1);
    expect(conflictsResA.json()[0].originalPayload.payments[0].amount).toBe('600.0000');

    const conflictsResB = await app.inject({
      method: 'GET',
      url: '/v1/sync/conflicts',
      headers: headers(ownerBToken, TENANT_B),
    });
    expect(conflictsResB.statusCode).toBe(200);
    expect(conflictsResB.json()).toHaveLength(0);

    // 5. Restock 5 units (3 -> 8), then resolve conflict via RETRY_REPLAY -> stock becomes 8 - 6 = 2!
    await app.inject({
      method: 'POST',
      url: '/v1/inventory/movements',
      headers: headers(ownerAToken, TENANT_A, { 'idempotency-key': randomUUID() }),
      payload: {
        branchId: branchAId,
        warehouseId: whAId,
        productId,
        movementType: 'STOCK_IN',
        quantity: '5.000000',
        uomCode: 'PCS',
        unitCost: '50.0000',
        reason: 'Restock arrival prior to conflict resolution',
      },
    });

    const resolveRes = await app.inject({
      method: 'POST',
      url: `/v1/sync/conflicts/${conflictId}/resolve`,
      headers: headers(ownerAToken),
      payload: {
        action: 'RETRY_REPLAY',
        notes: 'Stock arrived on morning truck; replayed preserved cash sale cleanly.',
      },
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json().conflict.status).toBe('RESOLVED');
    expect(resolveRes.json().replayedReferenceNumber).toBeDefined();

    const balAfterResolve = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?branchId=${branchAId}`,
      headers: headers(ownerAToken),
    });
    const waterBal2 = balAfterResolve.json().data.find((x: { productId: string }) => x.productId === productId);
    expect(waterBal2.qtyOnHand).toBe('2.000000');

    // 6. Sync offline INV_RECORD_ADJUSTMENT (+4 -> 6) and INV_REQUEST_TRANSFER (DRAFT request, does NOT mutate stock!)
    const adjCmdId = randomUUID();
    const trfCmdId = randomUUID();
    const invPush = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: headers(ownerAToken),
      payload: {
        deviceId: desktopDeviceId,
        branchId: branchAId,
        commands: [
          {
            localSeq: 2,
            commandId: adjCmdId,
            tenantId: TENANT_A,
            branchId: branchAId,
            deviceId: desktopDeviceId,
            actorUserId: OWNER_A_ID,
            commandType: 'INV_RECORD_ADJUSTMENT',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              branchId: branchAId,
              warehouseId: whAId,
              productId,
              movementType: 'ADJUSTMENT_POSITIVE',
              quantity: '4.000000',
              uomCode: 'PCS',
              reason: 'Found 4 intact cartons during offline cycle count',
            },
          },
          {
            localSeq: 3,
            commandId: trfCmdId,
            tenantId: TENANT_A,
            branchId: branchAId,
            deviceId: desktopDeviceId,
            actorUserId: OWNER_A_ID,
            commandType: 'INV_REQUEST_TRANSFER',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              sourceBranchId: branchAId,
              destinationBranchId: branchBId,
              autoComplete: true, // Server forces false on offline transfer request!
              notes: 'Requested while offline',
              lines: [{ productId, quantity: '2.000000' }],
            },
          },
        ],
      },
    });
    expect(invPush.statusCode).toBe(200);
    expect(invPush.json().receipts[0].status).toBe('APPLIED');
    expect(invPush.json().receipts[1].status).toBe('APPLIED');
    expect(invPush.json().receipts[1].serverReferenceNumber).toMatch(/^TRF-/);

    const balAfterInv = await app.inject({
      method: 'GET',
      url: `/v1/inventory/balances?branchId=${branchAId}`,
      headers: headers(ownerAToken),
    });
    expect(balAfterInv.json().data.find((x: { productId: string }) => x.productId === productId).qtyOnHand).toBe('6.000000');

    // Verify transfer was created in DRAFT (did not auto-complete or mutate stock)
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_A, userId: OWNER_A_ID, traceId: 'verify-offline-trf' },
      async (trx) => {
        const trfRow = await trx
          .selectFrom('stock_transfers')
          .select(['status'])
          .where('id', '=', invPush.json().receipts[1].serverReferenceId)
          .executeTakeFirstOrThrow();
        expect(trfRow.status).toBe('DRAFT');
      },
    );

    // 7. Sync Pull returns confirmed commands & snapshot
    const pullRes = await app.inject({
      method: 'GET',
      url: `/v1/sync/pull?branchId=${branchAId}&deviceId=${desktopDeviceId}`,
      headers: headers(ownerAToken),
    });
    expect(pullRes.statusCode).toBe(200);
    expect(pullRes.json().deviceAuthorized).toBe(true);
    expect(pullRes.json().openConflictsCount).toBe(0);
    expect(pullRes.json().recentConfirmedCommands.length).toBeGreaterThanOrEqual(3);

    // 8. Revoke Mobile device -> subsequent push/pull/snapshot with mobileDeviceId rejected with 403 SYNC_DEVICE_REVOKED
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/v1/sync/devices/${mobileDeviceId}/revoke`,
      headers: headers(ownerAToken),
      payload: { reason: 'Device misplaced on sales floor' },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().status).toBe('REVOKED');

    const blockedPush = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: headers(ownerAToken),
      payload: {
        deviceId: mobileDeviceId,
        branchId: branchAId,
        commands: [
          {
            localSeq: 2,
            commandId: randomUUID(),
            tenantId: TENANT_A,
            branchId: branchAId,
            deviceId: mobileDeviceId,
            actorUserId: OWNER_A_ID,
            commandType: 'POS_RECORD_SALE',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        ],
      },
    });
    expect(blockedPush.statusCode).toBe(403);
    expect(blockedPush.json().errorCode).toBe('SYNC_DEVICE_REVOKED');

    const blockedPull = await app.inject({
      method: 'GET',
      url: `/v1/sync/pull?branchId=${branchAId}&deviceId=${mobileDeviceId}`,
      headers: headers(ownerAToken),
    });
    expect(blockedPull.statusCode).toBe(403);
    expect(blockedPull.json().errorCode).toBe('SYNC_DEVICE_REVOKED');
  });
});
