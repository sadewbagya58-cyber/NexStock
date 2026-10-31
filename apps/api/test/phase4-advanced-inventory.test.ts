import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  createTaxGroupWithRates,
  generateUuidV7,
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

const TENANT_ALPHA_ID = '0192b4c0-4444-7000-8000-000000000010';
const TENANT_ALPHA_OWNER = '0192b4c0-4444-7000-8000-000000000001';
const TENANT_ALPHA_MANAGER = '0192b4c0-4444-7000-8000-000000000002';
const TENANT_ALPHA_CLERK = '0192b4c0-4444-7000-8000-000000000003';
const TENANT_ALPHA_CASHIER = '0192b4c0-4444-7000-8000-000000000004';

const TENANT_BETA_ID = '0192b4c0-5555-7000-8000-000000000010';
const TENANT_BETA_OWNER = '0192b4c0-5555-7000-8000-000000000001';

describe('@nexstock/api — Phase 4: Advanced Inventory (Batches, Expiry, Serials, Costing & Counts)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const primaryKey = createTestEs256KeyMaterial(
    '01f76c4b-9743-48ad-bed6-a9c89dc99cc4',
  );
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

  let alphaOwnerToken: string;
  let alphaManagerToken: string;
  let alphaClerkToken: string;
  let alphaCashierToken: string;
  let betaOwnerToken: string;

  let alphaBranchId: string;
  let alphaWarehouseId: string;
  let alphaRegisterId: string;
  let alphaTaxGroupId: string;
  let alphaCategoryId: string;

  // Products
  let batchProductExpiryId: string; // trackingMode: 'BATCH_EXPIRY', valuationMethod: 'FIFO'
  let serialProductId: string; // trackingMode: 'SERIAL', valuationMethod: 'FIFO'
  let standardFifoProductId: string; // trackingMode: 'NONE', valuationMethod: 'FIFO'
  let nonBatchProductId: string; // trackingMode: 'NONE', valuationMethod: 'MOVING_AVG'

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    alphaOwnerToken = issueToken(
      TENANT_ALPHA_OWNER,
      'owner@alpha-adv.example.com',
    );
    alphaManagerToken = issueToken(
      TENANT_ALPHA_MANAGER,
      'manager@alpha-adv.example.com',
    );
    alphaClerkToken = issueToken(
      TENANT_ALPHA_CLERK,
      'clerk@alpha-adv.example.com',
    );
    alphaCashierToken = issueToken(
      TENANT_ALPHA_CASHIER,
      'cashier@alpha-adv.example.com',
    );
    betaOwnerToken = issueToken(
      TENANT_BETA_OWNER,
      'owner@beta-adv.example.com',
    );

    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    // 1. Onboard Tenant Alpha
    const alphaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        slug: 'alpha-adv-corp',
        legalName: 'Alpha Advanced Inventory Global Ltd',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@alpha-adv.example.com',
        ownerFullName: 'Alpha Owner',
        planCode: 'GROWTH',
      },
    });
    expect(alphaOnboardRes.statusCode).toBe(201);

    // 2. Create Branch & Warehouse
    const bRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'BR-MAIN',
        name: 'Main Distribution Hub',
        timezone: 'America/New_York',
        countryCode: 'US',
      },
    });
    expect(bRes.statusCode).toBe(201);
    alphaBranchId = bRes.json().id;

    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        branchId: alphaBranchId,
        code: 'WH-MAIN-01',
        name: 'Central Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    alphaWarehouseId = whRes.json().id;

    // 3. Create POS Register
    alphaRegisterId = generateUuidV7();
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ALPHA_ID,
        userId: TENANT_ALPHA_OWNER,
        traceId: 'seed_reg',
      },
      async (trx) => {
        await trx.db
          .insertInto('pos_registers')
          .values({
            id: alphaRegisterId,
            tenant_id: TENANT_ALPHA_ID,
            branch_id: alphaBranchId,
            warehouse_id: alphaWarehouseId,
            code: 'REG-ADV-01',
            name: 'Front Counter Register',
            last_invoice_seq: 0,
            is_active: true,
          })
          .execute();
      },
    );

    // 4. Seed Tax Group (10% sales tax)
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ALPHA_ID,
        userId: TENANT_ALPHA_OWNER,
        traceId: 'seed_tax',
      },
      async (trx) => {
        const group = await createTaxGroupWithRates(trx, {
          code: 'STANDARD-TAX',
          name: 'Standard Sales Tax (10%)',
          countryCode: 'US',
          rates: [
            {
              code: 'VAT-10',
              name: 'VAT 10%',
              ratePercentage: '10.0000',
              isCompound: false,
            },
          ],
        });
        alphaTaxGroupId = group.id;
      },
    );

    // 5. Seed Users & RBAC Roles (Manager, Clerk, Cashier)
    await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ALPHA_ID,
        userId: TENANT_ALPHA_OWNER,
        traceId: 'seed_users',
      },
      async (trx) => {
        await trx.db
          .insertInto('users')
          .values([
            {
              id: TENANT_ALPHA_MANAGER,
              email: 'manager@alpha-adv.example.com',
              full_name: 'Alpha Warehouse Manager',
              is_platform_admin: false,
            },
            {
              id: TENANT_ALPHA_CLERK,
              email: 'clerk@alpha-adv.example.com',
              full_name: 'Alpha Warehouse Clerk',
              is_platform_admin: false,
            },
            {
              id: TENANT_ALPHA_CASHIER,
              email: 'cashier@alpha-adv.example.com',
              full_name: 'Alpha Cashier',
              is_platform_admin: false,
            },
          ])
          .execute();

        const roles = await trx.db
          .selectFrom('roles')
          .select(['id', 'code'])
          .where('tenant_id', '=', TENANT_ALPHA_ID)
          .execute();

        const managerRole = roles.find((r) => r.code === 'BRANCH_MANAGER')!;
        const clerkRole = roles.find((r) => r.code === 'WAREHOUSE_CLERK')!;
        const cashierRole = roles.find((r) => r.code === 'CASHIER')!;

        // Manager membership
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: TENANT_ALPHA_MANAGER,
            tenant_id: TENANT_ALPHA_ID,
            user_id: TENANT_ALPHA_MANAGER,
            status: 'ACTIVE',
            all_locations_access: true,
          })
          .execute();
        await trx.db
          .insertInto('member_role_assignments')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ALPHA_ID,
            membership_id: TENANT_ALPHA_MANAGER,
            role_id: managerRole.id,
          })
          .execute();

        // Clerk membership
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: TENANT_ALPHA_CLERK,
            tenant_id: TENANT_ALPHA_ID,
            user_id: TENANT_ALPHA_CLERK,
            status: 'ACTIVE',
            all_locations_access: true,
          })
          .execute();
        await trx.db
          .insertInto('member_role_assignments')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ALPHA_ID,
            membership_id: TENANT_ALPHA_CLERK,
            role_id: clerkRole.id,
          })
          .execute();

        // Cashier membership
        await trx.db
          .insertInto('tenant_memberships')
          .values({
            id: TENANT_ALPHA_CASHIER,
            tenant_id: TENANT_ALPHA_ID,
            user_id: TENANT_ALPHA_CASHIER,
            status: 'ACTIVE',
            all_locations_access: true,
          })
          .execute();
        await trx.db
          .insertInto('member_role_assignments')
          .values({
            id: generateUuidV7(),
            tenant_id: TENANT_ALPHA_ID,
            membership_id: TENANT_ALPHA_CASHIER,
            role_id: cashierRole.id,
          })
          .execute();
      },
    );

    // 6. Onboard Tenant Beta for cross-tenant isolation tests
    const betaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
      payload: {
        slug: 'beta-adv-corp',
        legalName: 'Beta Isolated Global Ltd',
        baseCurrency: 'EUR',
        defaultLocale: 'de-DE',
        defaultTimezone: 'Europe/Berlin',
        countryCode: 'DE',
        ownerEmail: 'owner@beta-adv.example.com',
        ownerFullName: 'Beta Owner',
        planCode: 'STARTER',
      },
    });
    expect(betaOnboardRes.statusCode).toBe(201);

    // 7. Seed Category & Products
    const catRes = await app.inject({
      method: 'POST',
      url: '/v1/categories',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        name: 'Advanced Inventory Category',
        description: 'Test category for Phase 4 items',
      },
    });
    expect(catRes.statusCode).toBe(201);
    alphaCategoryId = catRes.json().id;

    // Product 1: Pharma / Food with BATCH_EXPIRY and FIFO
    const p1Res = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        sku: 'MED-ANTIBIOTIC-01',
        name: 'Amoxicillin 500mg Capsules',
        productType: 'STANDARD',
        baseUom: 'BOX',
        purchaseCost: '15.0000',
        sellingPrice: '35.0000',
        categoryId: alphaCategoryId,
        taxGroupId: alphaTaxGroupId,
        trackInventory: true,
        trackingMode: 'BATCH_EXPIRY',
        valuationMethod: 'FIFO',
      },
    });
    expect(p1Res.statusCode).toBe(201);
    batchProductExpiryId = p1Res.json().id;

    // Product 2: Chemicals / Materials with BATCH (no expiry) and MOVING_AVG
    const p2Res = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        sku: 'CHEM-POLYMER-01',
        name: 'Industrial Polymer Resin',
        productType: 'STANDARD',
        baseUom: 'KG',
        purchaseCost: '8.0000',
        sellingPrice: '20.0000',
        categoryId: alphaCategoryId,
        taxGroupId: alphaTaxGroupId,
        trackInventory: true,
        trackingMode: 'BATCH',
        valuationMethod: 'MOVING_AVG',
      },
    });
    expect(p2Res.statusCode).toBe(201);

    // Product 3: Electronics with SERIAL tracking and FIFO
    const p3Res = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        sku: 'PHONE-NEXUS-01',
        name: 'NexStock SmartPhone Pro',
        productType: 'STANDARD',
        baseUom: 'PCS',
        purchaseCost: '400.0000',
        sellingPrice: '800.0000',
        categoryId: alphaCategoryId,
        taxGroupId: alphaTaxGroupId,
        trackInventory: true,
        trackingMode: 'SERIAL',
        valuationMethod: 'FIFO',
      },
    });
    expect(p3Res.statusCode).toBe(201);
    serialProductId = p3Res.json().id;

    // Product 4: Standard Product with FIFO costing (no batch/serial)
    const p4Res = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        sku: 'FIFO-WIDGET-01',
        name: 'Precision FIFO Widget',
        productType: 'STANDARD',
        baseUom: 'PCS',
        purchaseCost: '10.0000',
        sellingPrice: '25.0000',
        categoryId: alphaCategoryId,
        taxGroupId: alphaTaxGroupId,
        trackInventory: true,
        trackingMode: 'NONE',
        valuationMethod: 'FIFO',
      },
    });
    expect(p4Res.statusCode).toBe(201);
    standardFifoProductId = p4Res.json().id;

    // Product 5: Non-batch product for negative testing
    const p5Res = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        sku: 'PLAIN-ITEM-01',
        name: 'Plain Non-Tracked Item',
        productType: 'STANDARD',
        baseUom: 'PCS',
        purchaseCost: '5.0000',
        sellingPrice: '10.0000',
        categoryId: alphaCategoryId,
        taxGroupId: alphaTaxGroupId,
        trackInventory: true,
        trackingMode: 'NONE',
        valuationMethod: 'MOVING_AVG',
      },
    });
    expect(p5Res.statusCode).toBe(201);
    nonBatchProductId = p5Res.json().id;
  });

  afterAll(async () => {
    await app.close();
    await harness.db.destroy();
  });

  describe('1. Batch Tracking, Expiry Date Management & FEFO Allocation', () => {
    let validBatchId: string;
    let expiringSoonBatchId: string;

    it('rejects batch registration for non-batch-tracked product (422 INV_PRODUCT_NOT_BATCH_TRACKED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: nonBatchProductId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'BATCH-FAIL-01',
          initialQuantity: '10.0000',
          unitCost: '5.0000',
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().errorCode).toBe('INV_PRODUCT_NOT_BATCH_TRACKED');
    });

    it('creates batches with VALID, EXPIRING_SOON, and EXPIRED statuses', async () => {
      const now = new Date();
      const validDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10); // +90 days
      const expiringSoonDate = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10); // +15 days
      const expiredDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10); // -10 days

      // Batch 1: Valid (+90d)
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: batchProductExpiryId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'LOT-VALID-2026',
          initialQuantity: '50.0000',
          unitCost: '15.0000',
          expiryDate: validDate,
        },
      });
      expect(res1.statusCode).toBe(201);
      const b1 = res1.json();
      expect(b1.batchNumber).toBe('LOT-VALID-2026');
      expect(b1.expiryStatus).toBe('VALID');
      expect(b1.status).toBe('ACTIVE');
      validBatchId = b1.id;

      // Batch 2: Expiring Soon (+15d)
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: batchProductExpiryId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'LOT-SOON-2026',
          initialQuantity: '30.0000',
          unitCost: '15.0000',
          expiryDate: expiringSoonDate,
        },
      });
      expect(res2.statusCode).toBe(201);
      const b2 = res2.json();
      expect(b2.expiryStatus).toBe('EXPIRING_SOON');
      expiringSoonBatchId = b2.id;

      // Batch 3: Expired (-10d)
      const res3 = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: batchProductExpiryId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'LOT-EXPIRED-2026',
          initialQuantity: '20.0000',
          unitCost: '15.0000',
          expiryDate: expiredDate,
        },
      });
      expect(res3.statusCode).toBe(201);
      const b3 = res3.json();
      expect(b3.expiryStatus).toBe('EXPIRED');
      expect(b3.id).toBeDefined();
    });

    it('rejects duplicate batch number for same product (409 INV_BATCH_DUPLICATE_NUMBER)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: batchProductExpiryId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'LOT-VALID-2026',
          initialQuantity: '10.0000',
          unitCost: '15.0000',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('INV_BATCH_DUPLICATE_NUMBER');
    });

    it('quarantines a batch and rejects stock movement on quarantined batch (409 INV_BATCH_QUARANTINED)', async () => {
      // Quarantine Batch 2
      const qRes = await app.inject({
        method: 'POST',
        url: `/v1/inventory/batches/${expiringSoonBatchId}/quarantine`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          reason: 'Temperature spike detected during storage inspection',
        },
      });
      expect(qRes.statusCode).toBe(200);
      expect(qRes.json().status).toBe('QUARANTINED');
      expect(qRes.json().quarantineReason).toContain('Temperature spike');

      // Attempt outbound stock movement on quarantined batch (negative quantity for outbound)
      const moveRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: batchProductExpiryId,
          batchId: expiringSoonBatchId,
          movementType: 'STOCK_OUT',
          quantity: '-5.0000',
        },
      });
      expect(moveRes.statusCode).toBe(409);
      expect(moveRes.json().errorCode).toBe('INV_BATCH_QUARANTINED');
    });

    it('releases quarantined batch back to ACTIVE status', async () => {
      const rRes = await app.inject({
        method: 'POST',
        url: `/v1/inventory/batches/${expiringSoonBatchId}/release`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          reason: 'Quality assurance inspected samples and cleared batch for distribution',
        },
      });
      expect(rRes.statusCode).toBe(200);
      expect(rRes.json().status).toBe('ACTIVE');
      expect(rRes.json().quarantineReason).toBeNull();
    });

    it('performs FEFO batch allocation: prioritizes earliest expiry and splits across batches', async () => {
      // Inbound physical stock for valid and expiring-soon batches
      await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: batchProductExpiryId,
          batchId: expiringSoonBatchId,
          movementType: 'STOCK_IN',
          quantity: '30.0000',
          unitCost: '15.0000',
        },
      });

      await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: batchProductExpiryId,
          batchId: validBatchId,
          movementType: 'STOCK_IN',
          quantity: '50.0000',
          unitCost: '16.0000',
        },
      });

      // Batch 2 (LOT-SOON-2026) has 30 initial + 30 received = 60 units
      // Batch 1 (LOT-VALID-2026) has 50 initial + 50 received = 100 units
      // Requesting 70 units should allocate all 60 from Batch 2 and 10 from Batch 1!
      const fefoRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches/fefo-select',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          warehouseId: alphaWarehouseId,
          productId: batchProductExpiryId,
          requiredQuantity: '70.0000',
        },
      });

      expect(fefoRes.statusCode).toBe(200);
      const fefo = fefoRes.json();
      expect(fefo.allocations).toHaveLength(2);
      expect(fefo.allocations[0].batchNumber).toBe('LOT-SOON-2026');
      expect(Number(fefo.allocations[0].allocatedQty)).toBe(60);
      expect(fefo.allocations[1].batchNumber).toBe('LOT-VALID-2026');
      expect(Number(fefo.allocations[1].allocatedQty)).toBe(10);
      expect(fefo.isFullyFulfilled).toBe(true);
    });

    it('POS checkout with batch depletes batch quantity and void restores it', async () => {
      // Checkout 5 units from LOT-VALID-2026 (currently 100 units)
      // Price $35.00 * 5 = $175.00 + 10% tax ($17.50) = $192.50
      const checkoutRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegisterId,
          lines: [
            {
              productId: batchProductExpiryId,
              quantity: '5.0000',
              batchId: validBatchId,
            },
          ],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '192.5000',
              tenderedAmount: '200.0000',
            },
          ],
        },
      });

      expect(checkoutRes.statusCode).toBe(201);
      const sale = checkoutRes.json();
      expect(sale.lines[0].batchId).toBe(validBatchId);

      // Verify batch current quantity decremented from 100 to 95
      const batchCheckRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/batches/${validBatchId}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(batchCheckRes.statusCode).toBe(200);
      expect(Number(batchCheckRes.json().currentQuantity)).toBe(95);

      // Void sale and verify batch quantity restored to 100
      const voidRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/sales/${sale.id}/void`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          reason: 'Customer requested cancellation immediately after checkout',
        },
      });
      expect(voidRes.statusCode).toBe(200);

      const batchRestoredRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/batches/${validBatchId}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(Number(batchRestoredRes.json().currentQuantity)).toBe(100);
    });
  });

  describe('2. Serial Number Tracking & Lifecycle State Machine', () => {
    let serialId1: string;
    let serialId2: string;
    const serialNumber1 = 'SN-PHONE-ALPHA-001';
    const serialNumber2 = 'SN-PHONE-ALPHA-002';

    it('rejects serial registration for non-serial-tracked product (422 INV_PRODUCT_NOT_SERIAL_TRACKED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: nonBatchProductId,
          serialNumbers: ['SN-FAIL-001'],
          unitCost: '5.0000',
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().errorCode).toBe('INV_PRODUCT_NOT_SERIAL_TRACKED');
    });

    it('registers serial numbers in bulk and records initial IN_STOCK status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: serialProductId,
          serialNumbers: [serialNumber1, serialNumber2, 'SN-PHONE-ALPHA-003'],
          unitCost: '400.0000',
        },
      });
      expect(res.statusCode).toBe(201);
      const serials = res.json();
      expect(serials).toHaveLength(3);
      expect(serials[0].status).toBe('IN_STOCK');
      expect(serials[0].serialNumber).toBe(serialNumber1);
      serialId1 = serials[0].id;
      serialId2 = serials[1].id;
      expect(serialId2).toBeDefined();
    });

    it('rejects duplicate serial number registration (409 INV_SERIAL_DUPLICATE)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: serialProductId,
          serialNumbers: [serialNumber1],
          unitCost: '400.0000',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('INV_SERIAL_DUPLICATE');
    });

    it('executes valid serial lifecycle transition (IN_STOCK -> RESERVED -> IN_STOCK)', async () => {
      // Transition to RESERVED
      const t1 = await app.inject({
        method: 'POST',
        url: `/v1/inventory/serials/${serialId1}/transition`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          toStatus: 'RESERVED',
          reason: 'Customer holds unit for pickup tomorrow',
        },
      });
      expect(t1.statusCode).toBe(200);
      expect(t1.json().status).toBe('RESERVED');

      // Unreserve back to IN_STOCK
      const t2 = await app.inject({
        method: 'POST',
        url: `/v1/inventory/serials/${serialId1}/transition`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          toStatus: 'IN_STOCK',
          reason: 'Customer reservation expired; returned to stock',
        },
      });
      expect(t2.statusCode).toBe(200);
      expect(t2.json().status).toBe('IN_STOCK');
    });

    it('rejects invalid serial lifecycle transition (409 INV_SERIAL_INVALID_TRANSITION)', async () => {
      // IN_STOCK cannot transition directly to RETURNED
      const res = await app.inject({
        method: 'POST',
        url: `/v1/inventory/serials/${serialId1}/transition`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          toStatus: 'RETURNED',
          reason: 'Invalid transition attempt',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('INV_SERIAL_INVALID_TRANSITION');
    });

    it('POS checkout with serial unit transitions status to SOLD and void restores IN_STOCK', async () => {
      // Inbound physical stock for serial product so warehouse balance exists
      await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: serialProductId,
          movementType: 'STOCK_IN',
          quantity: '3.0000',
          unitCost: '400.0000',
        },
      });

      // Checkout specific serial: serialId1
      // Selling price: $800.00 + 10% tax ($80.00) = $880.00
      const checkoutRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegisterId,
          lines: [
            {
              productId: serialProductId,
              quantity: '1.0000',
              serialId: serialId1,
            },
          ],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '880.0000',
              tenderedAmount: '900.0000',
            },
          ],
        },
      });
      expect(checkoutRes.statusCode).toBe(201);
      const sale = checkoutRes.json();
      expect(sale.lines[0].serialId).toBe(serialId1);

      // Verify serial is now SOLD
      const checkRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/serials/${serialId1}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(checkRes.statusCode).toBe(200);
      expect(checkRes.json().status).toBe('SOLD');

      // Attempt double-sale of serialId1 -> must fail
      const doubleSaleRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          registerId: alphaRegisterId,
          lines: [
            {
              productId: serialProductId,
              quantity: '1.0000',
              serialId: serialId1,
            },
          ],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '880.0000',
              tenderedAmount: '900.0000',
            },
          ],
        },
      });
      expect(doubleSaleRes.statusCode).toBe(409);
      expect(doubleSaleRes.json().errorCode).toBe('INV_SERIAL_NOT_AVAILABLE');

      // Void sale -> verify serial is restored to IN_STOCK
      const voidRes = await app.inject({
        method: 'POST',
        url: `/v1/pos/sales/${sale.id}/void`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          reason: 'Customer decided not to purchase smartphone',
        },
      });
      expect(voidRes.statusCode).toBe(200);

      const restoredCheck = await app.inject({
        method: 'GET',
        url: `/v1/inventory/serials/${serialId1}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(restoredCheck.statusCode).toBe(200);
      expect(restoredCheck.json().status).toBe('IN_STOCK');
    });
  });

  describe('3. Inventory Costing & Valuation (FIFO & Moving Average Cost)', () => {
    it('creates sequential FIFO cost layers on inbound receipts', async () => {
      // Inbound 1: 10 units @ $10.00
      const r1 = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: standardFifoProductId,
          movementType: 'STOCK_IN',
          quantity: '10.0000',
          unitCost: '10.0000',
        },
      });
      expect(r1.statusCode).toBe(201);

      // Inbound 2: 10 units @ $20.00
      const r2 = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: standardFifoProductId,
          movementType: 'STOCK_IN',
          quantity: '10.0000',
          unitCost: '20.0000',
        },
      });
      expect(r2.statusCode).toBe(201);

      // Inspect FIFO cost layers: both should be OPEN
      const layersRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/cost-layers?warehouseId=${alphaWarehouseId}&productId=${standardFifoProductId}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(layersRes.statusCode).toBe(200);
      const layers = layersRes.json();
      expect(layers).toHaveLength(2);
      expect(layers[0].unitCost).toBe('10.0000');
      expect(Number(layers[0].remainingQty)).toBe(10);
      expect(layers[1].unitCost).toBe('20.0000');
      expect(Number(layers[1].remainingQty)).toBe(10);
    });

    it('consumes FIFO layers in first-in first-out order on outbound issue', async () => {
      // Outbound issue: 15 units (strictly negative quantity for outbound)
      // FIFO consumption:
      // - 10 units from Layer 1 @ $10.00 = $100.00
      // - 5 units from Layer 2 @ $20.00 = $100.00
      // Total cost delta = -$200.00
      const issueRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: standardFifoProductId,
          movementType: 'STOCK_OUT',
          quantity: '-15.0000',
        },
      });
      expect(issueRes.statusCode).toBe(201);
      const movement = issueRes.json();
      expect(Number(movement.totalCostDelta)).toBe(-200);

      // Verify FIFO layers state:
      // Layer 1: DEPLETED, remaining = 0
      // Layer 2: OPEN, remaining = 5
      const layersRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/cost-layers?warehouseId=${alphaWarehouseId}&productId=${standardFifoProductId}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(layersRes.statusCode).toBe(200);
      const layers = layersRes.json();
      expect(layers[0].status).toBe('DEPLETED');
      expect(Number(layers[0].remainingQty)).toBe(0);
      expect(layers[1].status).toBe('OPEN');
      expect(Number(layers[1].remainingQty)).toBe(5);
    });

    it('returns accurate inventory valuation report via /v1/inventory/valuation', async () => {
      const valRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/valuation?warehouseId=${alphaWarehouseId}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(valRes.statusCode).toBe(200);
      const val = valRes.json();
      expect(val.items).toBeDefined();
      expect(Number(val.totalAssetValue)).toBeGreaterThan(0);

      const fifoItem = val.items.find(
        (i: { productId: string }) => i.productId === standardFifoProductId,
      );
      expect(fifoItem).toBeDefined();
      expect(Number(fifoItem.qtyOnHand)).toBe(5);
      // 5 units remaining @ $20.00 layer = $100.00 total valuation
      expect(Number(fifoItem.totalInventoryValue)).toBe(100);
    });
  });

  describe('4. Stock Counts & Reconciliation (Stocktake)', () => {
    let stocktakeSessionId: string;

    it('creates stocktake session with scope FULL_WAREHOUSE in DRAFT status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/stocktakes',
        headers: {
          authorization: `Bearer ${alphaClerkToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          scope: 'FULL_WAREHOUSE',
          notes: 'Annual Q4 Full Physical Inventory Audit',
        },
      });

      expect(res.statusCode).toBe(201);
      const session = res.json();
      expect(session.status).toBe('DRAFT');
      expect(session.scope).toBe('FULL_WAREHOUSE');
      expect(session.lines.length).toBeGreaterThan(0);
      stocktakeSessionId = session.id;
    });

    it('records physical counts and calculates positive, zero, and negative variances', async () => {
      // Find standardFifoProductId line (expected is 5.000000)
      // Count 8.000000 (+3.000000 variance)
      const res = await app.inject({
        method: 'POST',
        url: `/v1/inventory/stocktakes/${stocktakeSessionId}/counts`,
        headers: {
          authorization: `Bearer ${alphaClerkToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          lines: [
            {
              productId: standardFifoProductId,
              countedQty: '8.000000',
              notes: 'Found extra unopened box on shelf B2',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const session = res.json();
      const line = session.lines.find(
        (l: { productId: string }) => l.productId === standardFifoProductId,
      );
      expect(line).toBeDefined();
      expect(Number(line.countedQty)).toBe(8);
      expect(Number(line.varianceQty)).toBe(3);
    });

    it('warehouse clerk submits stocktake session for review', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/inventory/stocktakes/${stocktakeSessionId}/submit`,
        headers: {
          authorization: `Bearer ${alphaClerkToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('SUBMITTED');
    });

    it('warehouse clerk cannot approve stocktake session (403 Forbidden)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/inventory/stocktakes/${stocktakeSessionId}/review`,
        headers: {
          authorization: `Bearer ${alphaClerkToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          action: 'APPROVE',
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('branch manager approves stocktake session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/inventory/stocktakes/${stocktakeSessionId}/review`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          action: 'APPROVE',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('APPROVED');
    });

    it('posts stock adjustments atomically to the ledger and updates balances', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/inventory/stocktakes/${stocktakeSessionId}/post-adjustments`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const session = res.json();
      expect(session.status).toBe('POSTED');

      // Verify inventory balance for standardFifoProductId updated from 5.000000 to 8.000000
      const balRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?warehouseId=${alphaWarehouseId}&productId=${standardFifoProductId}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(balRes.statusCode).toBe(200);
      const balance = balRes.json().data[0];
      expect(balance).toBeDefined();
      expect(Number(balance.qtyOnHand)).toBe(8);
    });

    it('rejects duplicate posting of already posted stocktake session (409 INV_STOCKTAKE_ALREADY_POSTED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/inventory/stocktakes/${stocktakeSessionId}/post-adjustments`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('INV_STOCKTAKE_ALREADY_POSTED');
    });
  });

  describe('5. Multi-Tenant Isolation & Dashboard Non-NaN Regression', () => {
    it('prevents Tenant Beta from accessing Tenant Alpha batches, serials, and stocktakes', async () => {
      // Attempt to access Alpha batch
      const bRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/batches?productId=${batchProductExpiryId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(bRes.statusCode).toBe(200);
      expect(bRes.json().data).toHaveLength(0);

      // Attempt to access Alpha serials
      const sRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/serials?productId=${serialProductId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(sRes.statusCode).toBe(200);
      expect(sRes.json().data).toHaveLength(0);

      // Attempt to list Alpha stocktakes
      const stRes = await app.inject({
        method: 'GET',
        url: '/v1/inventory/stocktakes',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(stRes.statusCode).toBe(200);
      expect(stRes.json().data).toHaveLength(0);
    });

    it('confirms inventory balances endpoint returns availableQty as valid numeric string', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/inventory/balances',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const items = res.json().data;
      expect(items.length).toBeGreaterThan(0);

      for (const item of items) {
        expect(typeof item.availableQty).toBe('string');
        const parsed = Number.parseFloat(item.availableQty);
        expect(Number.isNaN(parsed)).toBe(false);
      }
    });
  });

  describe('6. BUG-015 — Batch Creation Stock Ledger & Balances Integration', () => {
    let qaBatchProductId: string;
    let nonTrackableBatchProductId: string;

    beforeAll(async () => {
      // 1. Create a dedicated BATCH product matching QA-BATCH-001
      const pRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'QA-BATCH-001',
          name: 'QA Batch Product 001',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '2500.0000',
          sellingPrice: '3500.0000',
          categoryId: alphaCategoryId,
          taxGroupId: alphaTaxGroupId,
          trackInventory: true,
          trackingMode: 'BATCH',
          valuationMethod: 'FIFO',
        },
      });
      expect(pRes.statusCode).toBe(201);
      qaBatchProductId = pRes.json().id;

      // 2. Create a non-trackable product
      const pNonTrackRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'QA-NONTRACK-ITEM',
          name: 'Non Trackable Item',
          productType: 'SERVICE',
          baseUom: 'PCS',
          purchaseCost: '10.0000',
          sellingPrice: '20.0000',
          categoryId: alphaCategoryId,
          taxGroupId: alphaTaxGroupId,
          trackInventory: false,
          trackingMode: 'NONE',
          valuationMethod: 'MOVING_AVG',
        },
      });
      expect(pNonTrackRes.statusCode).toBe(201);
      nonTrackableBatchProductId = pNonTrackRes.json().id;
    });

    it('creates batch with initialQuantity 100, posting STOCK_IN movement and updating inventory balance', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: qaBatchProductId,
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'QA-BATCH-2026-001',
          initialQuantity: '100.0000',
          unitCost: '2500.0000',
        },
      });

      expect(createRes.statusCode).toBe(201);
      const batch = createRes.json();
      expect(batch.batchNumber).toBe('QA-BATCH-2026-001');
      expect(Number(batch.initialQuantity)).toBe(100);
      expect(Number(batch.currentQuantity)).toBe(100);
      expect(batch.status).toBe('ACTIVE');

      // 1. Verify stock_ledger_entries row
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_MANAGER,
          traceId: 'verify_batch_ledger',
        },
        async (trx) => {
          const ledgerEntries = await trx.db
            .selectFrom('stock_ledger_entries')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('batch_id', '=', batch.id)
            .execute();

          expect(ledgerEntries).toHaveLength(1);
          const entry = ledgerEntries[0]!;
          expect(entry.movement_type).toBe('STOCK_IN');
          expect(entry.qty_delta).toBe('100.000000');
          expect(entry.balance_before).toBe('0.000000');
          expect(entry.balance_after).toBe('100.000000');
          expect(entry.reference_type).toBe('BATCH_REGISTRATION');
          expect(entry.reference_id).toBe('QA-BATCH-2026-001');

          // 2. Verify inventory_balances row
          const balanceRow = await trx.db
            .selectFrom('inventory_balances')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('warehouse_id', '=', alphaWarehouseId)
            .where('product_id', '=', qaBatchProductId)
            .executeTakeFirst();

          expect(balanceRow).toBeDefined();
          expect(balanceRow!.qty_on_hand).toBe('100.000000');
        },
      );

      // 3. Verify public API endpoints
      // GET /v1/inventory/movements
      const movRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/movements?warehouseId=${alphaWarehouseId}&productId=${qaBatchProductId}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(movRes.statusCode).toBe(200);
      const movements = movRes.json().data;
      expect(movements).toHaveLength(1);
      expect(movements[0].movementType).toBe('STOCK_IN');
      expect(movements[0].qtyDelta).toBe('100.000000');
      expect(movements[0].batchId).toBe(batch.id);

      // GET /v1/inventory/balances
      const balRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?warehouseId=${alphaWarehouseId}&productId=${qaBatchProductId}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(balRes.statusCode).toBe(200);
      const balances = balRes.json().data;
      expect(balances).toHaveLength(1);
      expect(Number(balances[0].qtyOnHand)).toBe(100);
    });

    it('creates batch with initialQuantity 0 without posting stock movement or changing balance', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: qaBatchProductId,
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'QA-BATCH-ZERO-001',
          initialQuantity: '0.0000',
          unitCost: '2500.0000',
        },
      });

      expect(createRes.statusCode).toBe(201);
      const batch = createRes.json();
      expect(batch.batchNumber).toBe('QA-BATCH-ZERO-001');
      expect(Number(batch.initialQuantity)).toBe(0);
      expect(Number(batch.currentQuantity)).toBe(0);

      // Verify no ledger entries created for this zero batch
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_MANAGER,
          traceId: 'verify_zero_batch',
        },
        async (trx) => {
          const ledgerEntries = await trx.db
            .selectFrom('stock_ledger_entries')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('batch_id', '=', batch.id)
            .execute();

          expect(ledgerEntries).toHaveLength(0);

          // Balance should remain 100 from previous test
          const balanceRow = await trx.db
            .selectFrom('inventory_balances')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('warehouse_id', '=', alphaWarehouseId)
            .where('product_id', '=', qaBatchProductId)
            .executeTakeFirst();

          expect(balanceRow!.qty_on_hand).toBe('100.000000');
        },
      );
    });

    it('rejects batch registration for non-batch-tracked product (422 INV_PRODUCT_NOT_BATCH_TRACKED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: nonBatchProductId,
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'QA-BATCH-NONBATCH',
          initialQuantity: '10.0000',
          unitCost: '5.0000',
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().errorCode).toBe('INV_PRODUCT_NOT_BATCH_TRACKED');
    });

    it('rejects batch registration for non-trackable product (422)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: nonTrackableBatchProductId,
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'QA-BATCH-NONTRACK',
          initialQuantity: '10.0000',
          unitCost: '5.0000',
        },
      });

      expect(res.statusCode).toBe(422);
    });

    it('replays duplicate submission with Idempotency-Key without duplicating ledger entries or balances', async () => {
      const idempotencyKey = generateUuidV7();

      // First call
      const firstRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': idempotencyKey,
        },
        payload: {
          productId: qaBatchProductId,
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'QA-BATCH-IDEMP-001',
          initialQuantity: '50.0000',
          unitCost: '2500.0000',
        },
      });

      expect(firstRes.statusCode).toBe(201);
      const batchId = firstRes.json().id;

      // Second duplicate call with same idempotency key
      const secondRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': idempotencyKey,
        },
        payload: {
          productId: qaBatchProductId,
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'QA-BATCH-IDEMP-001',
          initialQuantity: '50.0000',
          unitCost: '2500.0000',
        },
      });

      expect(secondRes.statusCode).toBe(201);
      expect(secondRes.headers['x-idempotent-replayed']).toBe('true');
      expect(secondRes.json().id).toBe(batchId);

      // Verify exactly ONE ledger entry exists for this batch
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_MANAGER,
          traceId: 'verify_idemp_batch',
        },
        async (trx) => {
          const ledgerEntries = await trx.db
            .selectFrom('stock_ledger_entries')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('batch_id', '=', batchId)
            .execute();

          expect(ledgerEntries).toHaveLength(1);

          // Total on hand should be 100 (batch 1) + 50 (batch idemp) = 150 (NOT 200)
          const balanceRow = await trx.db
            .selectFrom('inventory_balances')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('warehouse_id', '=', alphaWarehouseId)
            .where('product_id', '=', qaBatchProductId)
            .executeTakeFirst();

          expect(balanceRow!.qty_on_hand).toBe('150.000000');
        },
      );
    });

    it('rejects batch creation if warehouse does not belong to branch (400 ERR_VALIDATION_FAILED)', async () => {
      const dummyBranchId = generateUuidV7();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: qaBatchProductId,
          branchId: dummyBranchId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'QA-BATCH-BADBRANCH',
          initialQuantity: '10.0000',
          unitCost: '100.0000',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('ERR_VALIDATION_FAILED');
    });

    it('rolls back batch and ensures no ledger entries are created if registration transaction fails on duplicate', async () => {
      const initialEntryCount = await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_MANAGER,
          traceId: 'verify_rollback_initial',
        },
        async (trx) => {
          const entries = await trx.db
            .selectFrom('stock_ledger_entries')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('product_id', '=', qaBatchProductId)
            .execute();
          return entries.length;
        },
      );

      // Attempt duplicate batch number
      const dupRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: qaBatchProductId,
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'QA-BATCH-2026-001',
          initialQuantity: '25.0000',
          unitCost: '2500.0000',
        },
      });

      expect(dupRes.statusCode).toBe(409);
      expect(dupRes.json().errorCode).toBe('INV_BATCH_DUPLICATE_NUMBER');

      // Verify no extra ledger entries created
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_MANAGER,
          traceId: 'verify_rollback_final',
        },
        async (trx) => {
          const entries = await trx.db
            .selectFrom('stock_ledger_entries')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('product_id', '=', qaBatchProductId)
            .execute();
          expect(entries.length).toBe(initialEntryCount);
        },
      );
    });

    it('successfully allocates stock via FEFO from batch created with initialQuantity', async () => {
      // Create dedicated BATCH_EXPIRY product to test isolated FEFO allocation
      const pFefoRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'QA-FEFO-PROD-01',
          name: 'QA FEFO Isolated Product',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '15.0000',
          sellingPrice: '30.0000',
          categoryId: alphaCategoryId,
          taxGroupId: alphaTaxGroupId,
          trackInventory: true,
          trackingMode: 'BATCH_EXPIRY',
          valuationMethod: 'FIFO',
        },
      });
      expect(pFefoRes.statusCode).toBe(201);
      const fefoProdId = pFefoRes.json().id;

      // Create a batch with expiry date and initialQuantity: 30
      const expDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const batchRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: fefoProdId,
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          batchNumber: 'QA-FEFO-BATCH-001',
          initialQuantity: '30.0000',
          unitCost: '15.0000',
          expiryDate: expDate,
        },
      });
      expect(batchRes.statusCode).toBe(201);
      const newBatchId = batchRes.json().id;

      // Allocate 15 units via FEFO
      const fefoRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/batches/fefo-select',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          warehouseId: alphaWarehouseId,
          productId: fefoProdId,
          requiredQuantity: '15.0000',
        },
      });
      expect(fefoRes.statusCode).toBe(200);
      const fefo = fefoRes.json();
      expect(fefo.allocations.length).toBeGreaterThan(0);
      expect(fefo.allocations.some((a: { batchId: string }) => a.batchId === newBatchId)).toBe(true);
      const totalAllocated = fefo.allocations.reduce((acc: number, a: { allocatedQty: string }) => acc + Number(a.allocatedQty), 0);
      expect(totalAllocated).toBe(15);
    });

    it('enforces multi-tenant isolation: Tenant Beta cannot see Tenant Alpha batches or stock ledger', async () => {
      const bRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/batches?productId=${qaBatchProductId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(bRes.statusCode).toBe(200);
      expect(bRes.json().data).toHaveLength(0);

      const mRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/movements?productId=${qaBatchProductId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(mRes.statusCode).toBe(200);
      expect(mRes.json().data).toHaveLength(0);
    });
  });

  describe('7. BUG-016 — Serial Registration Stock Ledger & Balances Integration', () => {
    let qaSerialProductId: string;
    let nonTrackableSerialProductId: string;

    beforeAll(async () => {
      // 1. Create dedicated SERIAL product matching QA-SERIAL-001
      const pRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'QA-SERIAL-001',
          name: 'Serial Tracking QA Test',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '2500.0000',
          sellingPrice: '3500.0000',
          categoryId: alphaCategoryId,
          taxGroupId: alphaTaxGroupId,
          trackInventory: true,
          trackingMode: 'SERIAL',
          valuationMethod: 'FIFO',
        },
      });
      expect(pRes.statusCode).toBe(201);
      qaSerialProductId = pRes.json().id;

      // 2. Create a non-trackable product
      const pNonTrackRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'QA-NONTRACK-SERIAL-PROD',
          name: 'Non Trackable Serial Product',
          productType: 'SERVICE',
          baseUom: 'PCS',
          purchaseCost: '10.0000',
          sellingPrice: '20.0000',
          categoryId: alphaCategoryId,
          taxGroupId: alphaTaxGroupId,
          trackInventory: false,
          trackingMode: 'NONE',
          valuationMethod: 'MOVING_AVG',
        },
      });
      expect(pNonTrackRes.statusCode).toBe(201);
      nonTrackableSerialProductId = pNonTrackRes.json().id;
    });

    it('registers single serial, creates 1 serial record, 1 STOCK_IN ledger entry, and sets inventory balance to 1', async () => {
      const serialKey = generateUuidV7();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': serialKey,
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: qaSerialProductId,
          serialNumbers: ['QA-SN-SINGLE-01'],
          unitCost: '2500.0000',
        },
      });

      expect(res.statusCode).toBe(201);
      const serials = res.json();
      expect(serials).toHaveLength(1);
      expect(serials[0].serialNumber).toBe('QA-SN-SINGLE-01');
      expect(serials[0].status).toBe('IN_STOCK');
      expect(serials[0].lastMovementId).toBeDefined();
      const movementId = serials[0].lastMovementId;

      // 1. Verify stock_ledger_entries row
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_MANAGER,
          traceId: 'verify_single_serial_ledger',
        },
        async (trx) => {
          const ledgerEntries = await trx.db
            .selectFrom('stock_ledger_entries')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('id', '=', movementId)
            .execute();

          expect(ledgerEntries).toHaveLength(1);
          const entry = ledgerEntries[0]!;
          expect(entry.movement_type).toBe('STOCK_IN');
          expect(entry.qty_delta).toBe('1.000000');
          expect(entry.balance_before).toBe('0.000000');
          expect(entry.balance_after).toBe('1.000000');
          expect(entry.reference_type).toBe('SERIAL_REGISTRATION');
          expect(Number(entry.unit_cost)).toBe(2500);

          // 2. Verify inventory_balances row
          const balanceRow = await trx.db
            .selectFrom('inventory_balances')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('warehouse_id', '=', alphaWarehouseId)
            .where('product_id', '=', qaSerialProductId)
            .executeTakeFirst();

          expect(balanceRow).toBeDefined();
          expect(balanceRow!.qty_on_hand).toBe('1.000000');
          expect(balanceRow!.last_ledger_entry_id).toBe(movementId);
        },
      );
    });

    it('registers 3 serials (SN-10001, SN-10002, SN-10003), creating 3 records, 1 STOCK_IN +3 ledger entry, and updates balance to 4', async () => {
      const serialKey = generateUuidV7();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': serialKey,
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: qaSerialProductId,
          serialNumbers: ['SN-10001', 'SN-10002', 'SN-10003'],
          unitCost: '2500.0000',
        },
      });

      expect(res.statusCode).toBe(201);
      const serials = res.json();
      expect(serials).toHaveLength(3);
      expect(serials.every((s: { status: string }) => s.status === 'IN_STOCK')).toBe(true);
      const movementId = serials[0].lastMovementId;
      expect(movementId).toBeDefined();
      expect(serials.every((s: { lastMovementId: string }) => s.lastMovementId === movementId)).toBe(true);

      // Verify DB state
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_MANAGER,
          traceId: 'verify_triple_serial_ledger',
        },
        async (trx) => {
          // Exactly 1 new movement for the 3 serials
          const movementRow = await trx.db
            .selectFrom('stock_ledger_entries')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('id', '=', movementId)
            .executeTakeFirst();

          expect(movementRow).toBeDefined();
          expect(movementRow!.movement_type).toBe('STOCK_IN');
          expect(movementRow!.qty_delta).toBe('3.000000');
          expect(movementRow!.balance_before).toBe('1.000000');
          expect(movementRow!.balance_after).toBe('4.000000');
          expect(movementRow!.reference_type).toBe('SERIAL_REGISTRATION');
          expect(Number(movementRow!.unit_cost)).toBe(2500);

          // Balance is exactly 4
          const balanceRow = await trx.db
            .selectFrom('inventory_balances')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('warehouse_id', '=', alphaWarehouseId)
            .where('product_id', '=', qaSerialProductId)
            .executeTakeFirst();

          expect(balanceRow).toBeDefined();
          expect(balanceRow!.qty_on_hand).toBe('4.000000');
        },
      );

      // Verify GET /v1/inventory/balances returns 4
      const balRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?warehouseId=${alphaWarehouseId}&productId=${qaSerialProductId}`,
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(balRes.statusCode).toBe(200);
      expect(Number(balRes.json().data[0].qtyOnHand)).toBe(4);
    });

    it('rejects duplicate serial numbers within the same request (400 ERR_VALIDATION_FAILED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: qaSerialProductId,
          serialNumbers: ['SN-DUP-INTERNAL', 'SN-DUP-INTERNAL'],
          unitCost: '2500.0000',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('ERR_VALIDATION_FAILED');
    });

    it('rejects duplicate serial number against existing database serial (409 INV_SERIAL_DUPLICATE) with no stock delta', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: qaSerialProductId,
          serialNumbers: ['SN-10001'],
          unitCost: '2500.0000',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('INV_SERIAL_DUPLICATE');

      // Balance remains 4
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_MANAGER,
          traceId: 'verify_no_change_on_duplicate',
        },
        async (trx) => {
          const balanceRow = await trx.db
            .selectFrom('inventory_balances')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('warehouse_id', '=', alphaWarehouseId)
            .where('product_id', '=', qaSerialProductId)
            .executeTakeFirst();
          expect(balanceRow!.qty_on_hand).toBe('4.000000');
        },
      );
    });

    it('replays duplicate submission with Idempotency-Key without duplicating ledger entries or stock count', async () => {
      const idempotencyKey = generateUuidV7();

      // First call
      const firstRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': idempotencyKey,
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: qaSerialProductId,
          serialNumbers: ['SN-IDEMP-01', 'SN-IDEMP-02'],
          unitCost: '2500.0000',
        },
      });

      expect(firstRes.statusCode).toBe(201);
      const firstSerials = firstRes.json();
      expect(firstSerials).toHaveLength(2);

      // Second duplicate call with same idempotency key
      const secondRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': idempotencyKey,
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: qaSerialProductId,
          serialNumbers: ['SN-IDEMP-01', 'SN-IDEMP-02'],
          unitCost: '2500.0000',
        },
      });

      expect(secondRes.statusCode).toBe(201);
      expect(secondRes.headers['x-idempotent-replayed']).toBe('true');
      expect(secondRes.json()).toHaveLength(2);

      // Verify balance increased by only 2 (4 + 2 = 6, NOT 8)
      await withTenantTransaction(
        harness.db,
        {
          tenantId: TENANT_ALPHA_ID,
          userId: TENANT_ALPHA_MANAGER,
          traceId: 'verify_idemp_serial',
        },
        async (trx) => {
          const balanceRow = await trx.db
            .selectFrom('inventory_balances')
            .selectAll()
            .where('tenant_id', '=', TENANT_ALPHA_ID)
            .where('warehouse_id', '=', alphaWarehouseId)
            .where('product_id', '=', qaSerialProductId)
            .executeTakeFirst();

          expect(balanceRow!.qty_on_hand).toBe('6.000000');
        },
      );
    });

    it('rejects serial registration for non-serial-tracked product (422 INV_PRODUCT_NOT_SERIAL_TRACKED)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: nonBatchProductId,
          serialNumbers: ['SN-NONSERIAL-01'],
          unitCost: '10.0000',
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().errorCode).toBe('INV_PRODUCT_NOT_SERIAL_TRACKED');
    });

    it('rejects serial registration for non-trackable product (422 INV_PRODUCT_NOT_SERIAL_TRACKED or INV_PRODUCT_NOT_TRACKABLE)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranchId,
          warehouseId: alphaWarehouseId,
          productId: nonTrackableSerialProductId,
          serialNumbers: ['SN-NONTRACK-01'],
          unitCost: '10.0000',
        },
      });

      expect(res.statusCode).toBe(422);
    });

    it('rejects serial registration if warehouse does not belong to branch (400 ERR_VALIDATION_FAILED)', async () => {
      const dummyBranchId = generateUuidV7();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/inventory/serials',
        headers: {
          authorization: `Bearer ${alphaManagerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: dummyBranchId,
          warehouseId: alphaWarehouseId,
          productId: qaSerialProductId,
          serialNumbers: ['SN-BADBRANCH-01'],
          unitCost: '100.0000',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('ERR_VALIDATION_FAILED');
    });

    it('enforces multi-tenant isolation: Tenant Beta cannot see Tenant Alpha serials or stock ledger', async () => {
      const sRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/serials?productId=${qaSerialProductId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(sRes.statusCode).toBe(200);
      expect(sRes.json().data).toHaveLength(0);

      const mRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/movements?productId=${qaSerialProductId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(mRes.statusCode).toBe(200);
      expect(mRes.json().data).toHaveLength(0);
    });
  });
});
