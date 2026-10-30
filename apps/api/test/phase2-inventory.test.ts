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

const TENANT_ALPHA_ID = '0192b4c0-1111-7000-8000-000000000010';
const TENANT_ALPHA_OWNER = '0192b4c0-1111-7000-8000-000000000001';
const TENANT_ALPHA_CASHIER = '0192b4c0-1111-7000-8000-000000000002';
const TENANT_ALPHA_BRANCH1_CLERK = '0192b4c0-1111-7000-8000-000000000003';

const TENANT_BETA_ID = '0192b4c0-2222-7000-8000-000000000010';
const TENANT_BETA_OWNER = '0192b4c0-2222-7000-8000-000000000001';

describe('@nexstock/api — Phase 2: Core Inventory (CAT, PUR, INV, RLS, RBAC & Ledger Integrity)', () => {
  let harness: TestPostgresHarness;
  const primaryKey = createTestEs256KeyMaterial(
    '01f76c4b-9743-48ad-bed6-a9c89dc99cc2',
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
  let alphaCashierToken: string;
  let alphaBranch1ClerkToken: string;
  let betaOwnerToken: string;

  let alphaBranch1Id: string;
  let alphaMainWarehouseId: string;
  let alphaBranch2Id: string;
  let alphaBranch2WarehouseId: string;
  let alphaTaxGroupId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    alphaOwnerToken = issueToken(
      TENANT_ALPHA_OWNER,
      'owner@alpha-inventory.example.com',
    );
    alphaCashierToken = issueToken(
      TENANT_ALPHA_CASHIER,
      'cashier@alpha-inventory.example.com',
    );
    alphaBranch1ClerkToken = issueToken(
      TENANT_ALPHA_BRANCH1_CLERK,
      'clerk-b1@alpha-inventory.example.com',
    );
    betaOwnerToken = issueToken(
      TENANT_BETA_OWNER,
      'owner@beta-inventory.example.com',
    );

    const app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    // Onboard Tenant Alpha (GROWTH plan to allow multiple branches/warehouses/users)
    const alphaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        slug: 'alpha-inventory-corp',
        legalName: 'Alpha Inventory Global Ltd',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@alpha-inventory.example.com',
        ownerFullName: 'Alpha Owner',
        planCode: 'GROWTH',
      },
    });
    expect(alphaOnboardRes.statusCode).toBe(201);

    // Create Branch 1 & Warehouse 1 in Tenant Alpha
    const branch1Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'BR-NY',
        name: 'New York Headquarters Branch',
        timezone: 'America/New_York',
        countryCode: 'US',
      },
    });
    expect(branch1Res.statusCode).toBe(201);
    alphaBranch1Id = branch1Res.json().id;

    const wh1Res = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        branchId: alphaBranch1Id,
        code: 'WH-NY-01',
        name: 'New York Central Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(wh1Res.statusCode).toBe(201);
    alphaMainWarehouseId = wh1Res.json().id;

    // Create Branch 2 & Warehouse 2 in Tenant Alpha
    const branch2Res = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'BR-LA',
        name: 'Los Angeles Branch',
        timezone: 'America/Los_Angeles',
        countryCode: 'US',
      },
    });
    expect(branch2Res.statusCode).toBe(201);
    alphaBranch2Id = branch2Res.json().id;

    const wh2Res = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        branchId: alphaBranch2Id,
        code: 'WH-LA-01',
        name: 'Los Angeles Fulfillment Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(wh2Res.statusCode).toBe(201);
    alphaBranch2WarehouseId = wh2Res.json().id;

    // Create a Tax Group for Tenant Alpha
    const taxGroup = await withTenantTransaction(
      harness.db,
      {
        tenantId: TENANT_ALPHA_ID,
        userId: TENANT_ALPHA_OWNER,
        traceId: 'trace_seed_tax_group',
      },
      async (trx) => {
        return createTaxGroupWithRates(trx, {
          code: 'STD-VAT',
          name: 'Standard Sales Tax',
          countryCode: 'US',
          rates: [
            {
              code: 'NY-SALES',
              name: 'NY State Sales Tax',
              ratePercentage: '0.0800',
              isCompound: false,
              priority: 1,
            },
          ],
        });
      },
    );
    alphaTaxGroupId = taxGroup.id;

    // Provision Cashier (global branch scope, CASHIER role) and Branch 1 Inventory Clerk (scoped to Branch 1 only)
    const cashierProvisionRes = await app.inject({
      method: 'POST',
      url: '/v1/iam/members',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        userId: TENANT_ALPHA_CASHIER,
        email: 'cashier@alpha-inventory.example.com',
        fullName: 'Alpha Cashier',
        roleCodes: ['CASHIER'],
        allLocationsAccess: true,
      },
    });
    expect(cashierProvisionRes.statusCode).toBe(201);

    const clerkProvisionRes = await app.inject({
      method: 'POST',
      url: '/v1/iam/members',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        userId: TENANT_ALPHA_BRANCH1_CLERK,
        email: 'clerk-b1@alpha-inventory.example.com',
        fullName: 'NY Branch Clerk',
        roleCodes: ['WAREHOUSE_CLERK'],
        allLocationsAccess: false,
        branchIds: [alphaBranch1Id],
      },
    });
    expect(clerkProvisionRes.statusCode).toBe(201);

    // Onboard Tenant Beta
    const betaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
      payload: {
        slug: 'beta-retail-group',
        legalName: 'Beta Retail Group PLC',
        baseCurrency: 'EUR',
        defaultLocale: 'de-DE',
        defaultTimezone: 'Europe/Berlin',
        countryCode: 'DE',
        ownerEmail: 'owner@beta-inventory.example.com',
        ownerFullName: 'Beta Owner',
        planCode: 'STARTER',
      },
    });
    expect(betaOnboardRes.statusCode).toBe(201);

    await app.close();
  });

  afterAll(async () => {
    await harness.db.destroy();
  });

  describe('1. Category Management (CAT): Hierarchy, Circular Detection, Uniqueness & Archive Rules', () => {
    it('creates, updates, searches, paginates, prevents circular hierarchy, and blocks archiving categories with active children', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider,
      });

      // 1. Create root category "Electronics"
      const rootRes = await app.inject({
        method: 'POST',
        url: '/v1/categories',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'Electronics',
          description: 'Consumer and commercial electronics',
        },
      });
      expect(rootRes.statusCode).toBe(201);
      const electronics = rootRes.json();
      expect(electronics.name).toBe('Electronics');
      expect(electronics.parentId).toBeNull();
      expect(electronics.status).toBe('ACTIVE');

      // 2. Duplicate root category name (case-insensitive) in same tenant must fail with 409 CAT_DUPLICATE_CATEGORY_NAME
      const dupRootRes = await app.inject({
        method: 'POST',
        url: '/v1/categories',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'electronics',
        },
      });
      expect(dupRootRes.statusCode).toBe(409);
      expect(dupRootRes.json().errorCode).toBe('CAT_DUPLICATE_CATEGORY_NAME');

      // 3. Same category name in Tenant Beta succeeds (tenant-scoped uniqueness)
      const betaCatRes = await app.inject({
        method: 'POST',
        url: '/v1/categories',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
        payload: {
          name: 'Electronics',
        },
      });
      expect(betaCatRes.statusCode).toBe(201);
      const betaCategoryId = betaCatRes.json().id;

      // 4. Cross-tenant parent category reference (Tenant Alpha using Tenant Beta category as parent) must fail with 404
      const crossTenantParentRes = await app.inject({
        method: 'POST',
        url: '/v1/categories',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'Illegal Cross-Tenant Child',
          parentId: betaCategoryId,
        },
      });
      expect(crossTenantParentRes.statusCode).toBe(404);
      expect(crossTenantParentRes.json().errorCode).toBe('ERR_NOT_FOUND');

      // 5. Create child category "Computers" -> "Laptops"
      const computersRes = await app.inject({
        method: 'POST',
        url: '/v1/categories',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'Computers',
          parentId: electronics.id,
        },
      });
      expect(computersRes.statusCode).toBe(201);
      const computers = computersRes.json();

      const laptopsRes = await app.inject({
        method: 'POST',
        url: '/v1/categories',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          name: 'Laptops',
          parentId: computers.id,
        },
      });
      expect(laptopsRes.statusCode).toBe(201);
      const laptops = laptopsRes.json();

      // 6. Self-parenting (Electronics -> parent = Electronics) must fail with 409 CAT_CIRCULAR_CATEGORY_HIERARCHY
      const selfCycleRes = await app.inject({
        method: 'PATCH',
        url: `/v1/categories/${electronics.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          parentId: electronics.id,
        },
      });
      expect(selfCycleRes.statusCode).toBe(409);
      expect(selfCycleRes.json().errorCode).toBe(
        'CAT_CIRCULAR_CATEGORY_HIERARCHY',
      );

      // 7. Multi-hop cycle (Electronics -> parent = Laptops, where Laptops -> Computers -> Electronics) must fail with 409
      const multiHopCycleRes = await app.inject({
        method: 'PATCH',
        url: `/v1/categories/${electronics.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          parentId: laptops.id,
        },
      });
      expect(multiHopCycleRes.statusCode).toBe(409);
      expect(multiHopCycleRes.json().errorCode).toBe(
        'CAT_CIRCULAR_CATEGORY_HIERARCHY',
      );

      // 8. Archiving "Computers" while child "Laptops" is still ACTIVE must fail with 409
      const blockedArchiveRes = await app.inject({
        method: 'POST',
        url: `/v1/categories/${computers.id}/archive`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(blockedArchiveRes.statusCode).toBe(409);
      expect(blockedArchiveRes.json().errorCode).toBe(
        'CAT_CATEGORY_HAS_ACTIVE_CHILDREN_OR_PRODUCTS',
      );

      // 9. Archiving leaf category "Laptops" succeeds
      const archiveLaptopsRes = await app.inject({
        method: 'POST',
        url: `/v1/categories/${laptops.id}/archive`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(archiveLaptopsRes.statusCode).toBe(200);
      expect(archiveLaptopsRes.json().status).toBe('ARCHIVED');

      // 10. Search and cursor pagination
      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/categories?status=ACTIVE&limit=1',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(listRes.statusCode).toBe(200);
      const page1 = listRes.json();
      expect(page1.data).toHaveLength(1);
      expect(page1.pageInfo.hasNextPage).toBe(true);
      expect(page1.pageInfo.nextCursor).toBeTruthy();

      const page2Res = await app.inject({
        method: 'GET',
        url: `/v1/categories?status=ACTIVE&limit=1&cursor=${page1.pageInfo.nextCursor}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(page2Res.statusCode).toBe(200);
      expect(page2Res.json().data).toHaveLength(1);

      await app.close();
    });
  });

  describe('2. Product Management (CAT): SKU/Barcode Uniqueness, UoM Conversions, Product Types & Hard-Delete Trigger', () => {
    it('creates, updates, filters, paginates, enforces SKU & barcode uniqueness, validates UoM conversions, and blocks hard deletion', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider,
      });

      // Fetch active category for Tenant Alpha
      const catsRes = await app.inject({
        method: 'GET',
        url: '/v1/categories?search=Electronics',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const categoryId = catsRes.json().data[0].id as string;

      // 1. Create a STANDARD product with primary barcode, alternate barcodes, and UoM conversions
      const createProdRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'SKU-MON-27-4K',
          name: 'UltraSharp 27 4K Monitor',
          description: '27-inch IPS 4K USB-C Hub Monitor',
          categoryId,
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '285.5000',
          sellingPrice: '449.9900',
          taxGroupId: alphaTaxGroupId,
          trackInventory: true,
          reorderPoint: '10.0000',
          reorderQty: '25.0000',
          primaryBarcode: '8800112233441',
          alternateBarcodes: [
            { barcode: '8800112233442', barcodeType: 'EAN13', uomCode: 'PCS' },
            { barcode: '8800112233443', barcodeType: 'EAN13', uomCode: 'BOX' },
          ],
          unitConversions: [
            {
              uomCode: 'BOX',
              uomName: 'Box of 4',
              conversionFactorToBase: '4.0000',
            },
            {
              uomCode: 'PALLET',
              uomName: 'Pallet of 32',
              conversionFactorToBase: '32.0000',
            },
          ],
          imageUrl: 'https://cdn.nexstock.example.com/products/mon-27-4k.webp',
          imageAlt: '27-inch 4K monitor front view',
        },
      });
      expect(createProdRes.statusCode).toBe(201);
      const monitor = createProdRes.json();
      expect(monitor.sku).toBe('SKU-MON-27-4K');
      expect(monitor.primaryBarcode).toBe('8800112233441');
      expect(monitor.barcodes).toHaveLength(3);
      expect(
        monitor.unitConversions.map(
          (u: { uomCode: string; conversionFactorToBase: string }) => ({
            uomCode: u.uomCode,
            conversionFactorToBase: u.conversionFactorToBase,
          }),
        ),
      ).toEqual([
        { uomCode: 'BOX', conversionFactorToBase: '4.000000' },
        { uomCode: 'PALLET', conversionFactorToBase: '32.000000' },
      ]);

      // 2. Duplicate SKU in same tenant -> 409 CAT_DUPLICATE_PRODUCT_SKU
      const dupSkuRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'sku-mon-27-4k',
          name: 'Duplicate SKU Monitor',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '100.0000',
          sellingPrice: '150.0000',
        },
      });
      expect(dupSkuRes.statusCode).toBe(409);
      expect(dupSkuRes.json().errorCode).toBe('CAT_DUPLICATE_SKU');

      // 3. Duplicate barcode (colliding with existing alternate barcode) -> 409 CAT_DUPLICATE_BARCODE
      const dupBarcodeRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'SKU-CABLE-HDMI',
          name: 'HDMI 2.1 Cable',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '5.0000',
          sellingPrice: '19.9900',
          primaryBarcode: '8800112233442',
        },
      });
      expect(dupBarcodeRes.statusCode).toBe(409);
      expect(dupBarcodeRes.json().errorCode).toBe('CAT_DUPLICATE_BARCODE');

      // 4. Same SKU and barcode in Tenant Beta succeeds (tenant-isolated uniqueness)
      const betaProdRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
        payload: {
          sku: 'SKU-MON-27-4K',
          name: 'Beta Monitor',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '250.0000',
          sellingPrice: '399.0000',
          primaryBarcode: '8800112233441',
        },
      });
      expect(betaProdRes.statusCode).toBe(201);

      // 4b. Phase 5.1 BUG-001: Idempotent Product Creation replays successfully without 409
      const prodIdempotencyKey = generateUuidV7();
      const firstCreateRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': prodIdempotencyKey,
        },
        payload: {
          sku: 'ELEC-MOUSE-001',
          name: 'Wireless Bluetooth Mouse',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '2500.0000',
          sellingPrice: '3500.0000',
        },
      });
      expect(firstCreateRes.statusCode).toBe(201);
      expect(firstCreateRes.headers['x-idempotent-replayed']).toBe('false');
      const createdProd = firstCreateRes.json();
      expect(createdProd.sku).toBe('ELEC-MOUSE-001');

      // Replay with identical idempotency key returns cached outcome (201) rather than 409
      const secondCreateRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': prodIdempotencyKey,
        },
        payload: {
          sku: 'ELEC-MOUSE-001',
          name: 'Wireless Bluetooth Mouse',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '2500.0000',
          sellingPrice: '3500.0000',
        },
      });
      expect(secondCreateRes.statusCode).toBe(201);
      expect(secondCreateRes.headers['x-idempotent-replayed']).toBe('true');
      expect(secondCreateRes.json().id).toBe(createdProd.id);

      // 5. SERVICE product with trackInventory: true must be rejected with 400 ERR_VALIDATION_FAILED
      const badServiceRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'SRV-INSTALL-01',
          name: 'On-Site Installation Service',
          productType: 'SERVICE',
          baseUom: 'HR',
          purchaseCost: '0.0000',
          sellingPrice: '95.0000',
          trackInventory: true,
        },
      });
      expect(badServiceRes.statusCode).toBe(400);
      expect(badServiceRes.json().errorCode).toBe('ERR_VALIDATION_FAILED');

      // 6. Valid SERVICE product (trackInventory defaults to false)
      const serviceRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'SRV-INSTALL-01',
          name: 'On-Site Installation Service',
          productType: 'SERVICE',
          baseUom: 'HR',
          purchaseCost: '0.0000',
          sellingPrice: '95.0000',
        },
      });
      expect(serviceRes.statusCode).toBe(201);
      expect(serviceRes.json().trackInventory).toBe(false);

      // 7. Invalid UoM conversion (factor = 0 or UoM matching baseUom) -> 400 CAT_INVALID_UOM_CONVERSION
      const badUomRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'SKU-BAD-UOM',
          name: 'Bad UoM Product',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '10.0000',
          sellingPrice: '20.0000',
          unitConversions: [
            {
              uomCode: 'BOX',
              uomName: 'Zero Box',
              conversionFactorToBase: '0.0000',
            },
          ],
        },
      });
      expect(badUomRes.statusCode).toBe(400);
      expect(badUomRes.json().errorCode).toBe('CAT_INVALID_UOM_CONVERSION');

      // 8. Search by barcode & SKU
      const barcodeSearchRes = await app.inject({
        method: 'GET',
        url: '/v1/products?search=8800112233443',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(barcodeSearchRes.statusCode).toBe(200);
      expect(barcodeSearchRes.json().data).toHaveLength(1);
      expect(barcodeSearchRes.json().data[0].id).toBe(monitor.id);

      // 9. Update product details, prices, and unitConversions
      const updateProdRes = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${monitor.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sellingPrice: '469.9900',
          unitConversions: [
            {
              uomCode: 'BOX',
              uomName: 'Box of 6',
              conversionFactorToBase: '6.0000',
            },
          ],
        },
      });
      expect(updateProdRes.statusCode).toBe(200);
      expect(updateProdRes.json().sellingPrice).toBe('469.9900');
      expect(updateProdRes.json().unitConversions).toHaveLength(1);
      expect(
        updateProdRes.json().unitConversions[0].conversionFactorToBase,
      ).toBe('6.000000');

      // BUG-014 Regression: Update product with isActive: false (archives product)
      const archiveProdRes = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${monitor.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          isActive: false,
        },
      });
      expect(archiveProdRes.statusCode).toBe(200);
      expect(archiveProdRes.json().status).toBe('ARCHIVED');
      expect(archiveProdRes.json().archivedAt).not.toBeNull();

      // BUG-014 Regression: Update product with isActive: true (restores product to ACTIVE)
      const unarchiveProdRes = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${monitor.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          isActive: true,
        },
      });
      expect(unarchiveProdRes.statusCode).toBe(200);
      expect(unarchiveProdRes.json().status).toBe('ACTIVE');
      expect(unarchiveProdRes.json().archivedAt).toBeNull();

      // BUG-014 Regression: Update product trackingMode to BATCH when zero stock exists (succeeds)
      const trackingModeRes = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${monitor.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          trackingMode: 'BATCH',
        },
      });
      expect(trackingModeRes.statusCode).toBe(200);
      expect(trackingModeRes.json().trackingMode).toBe('BATCH');

      // BUG-014 Regression: Revert trackingMode to NONE when zero stock exists (succeeds)
      const revertTrackingRes = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${monitor.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          trackingMode: 'NONE',
        },
      });
      expect(revertTrackingRes.statusCode).toBe(200);
      expect(revertTrackingRes.json().trackingMode).toBe('NONE');

      // BUG-014 Regression: Duplicate SKU check returns 409 CAT_DUPLICATE_SKU
      const dupSkuPatchRes = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${monitor.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'ELEC-MOUSE-001',
        },
      });
      expect(dupSkuPatchRes.statusCode).toBe(409);
      expect(dupSkuPatchRes.json().errorCode).toBe('CAT_DUPLICATE_SKU');

      // 10. Direct SQL hard delete of master product or category must be blocked by both ACLs and database trigger
      // Layer 1: Runtime role lacks DELETE privilege
      await expect(
        withTenantTransaction(
          harness.db,
          {
            tenantId: TENANT_ALPHA_ID,
            userId: TENANT_ALPHA_OWNER,
            traceId: 'trace_hard_delete_product',
          },
          async (trx) => {
            await trx.db
              .deleteFrom('products')
              .where('id', '=', monitor.id)
              .execute();
          },
        ),
      ).rejects.toThrow(/permission denied for table products/);

      // Layer 2: Even privileged table owner is blocked by prevent_master_record_hard_delete trigger
      await expect(
        harness.db
          .deleteFrom('products')
          .where('id', '=', monitor.id)
          .execute(),
      ).rejects.toThrow(/HARD_DELETE_FORBIDDEN/);

      await app.close();
    });
  });

  describe('3. Supplier Management (PUR): Code/Tax-ID Uniqueness, Validation & Supplier-Product Linking', () => {
    it('creates, updates, archives suppliers, validates contact fields, enforces code/tax-ID uniqueness, and links supplier products', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider,
      });

      // 1. Create Supplier
      const createSupRes = await app.inject({
        method: 'POST',
        url: '/v1/suppliers',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'SUP-TECH-001',
          businessName: 'Pacific Display Distributors Inc.',
          contactPerson: 'Elena Rostova',
          email: 'orders@pacificdisplay.example.com',
          phone: '+1-415-555-0192',
          address: '750 Market St, San Francisco, CA 94102',
          taxRegistrationNumber: 'US-EIN-94-1234567',
          notes: 'Primary North America display distributor',
        },
      });
      expect(createSupRes.statusCode).toBe(201);
      const supplier = createSupRes.json();
      expect(supplier.code).toBe('SUP-TECH-001');
      expect(supplier.taxRegistrationNumber).toBe('US-EIN-94-1234567');

      // 2. Duplicate supplier code in same tenant -> 409 PUR_DUPLICATE_SUPPLIER_CODE
      const dupCodeRes = await app.inject({
        method: 'POST',
        url: '/v1/suppliers',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'sup-tech-001',
          businessName: 'Another Supplier',
        },
      });
      expect(dupCodeRes.statusCode).toBe(409);
      expect(dupCodeRes.json().errorCode).toBe('PUR_DUPLICATE_SUPPLIER_CODE');

      // 3. Duplicate taxRegistrationNumber in same tenant -> 409 PUR_DUPLICATE_SUPPLIER_TAX_ID
      const dupTaxRes = await app.inject({
        method: 'POST',
        url: '/v1/suppliers',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'SUP-TECH-002',
          businessName: 'Secondary Entity Same Tax ID',
          taxRegistrationNumber: 'us-ein-94-1234567',
        },
      });
      expect(dupTaxRes.statusCode).toBe(409);
      expect(dupTaxRes.json().errorCode).toBe('PUR_DUPLICATE_SUPPLIER_TAX_ID');

      // 4. Invalid email format -> 400 ERR_VALIDATION_FAILED
      const badEmailRes = await app.inject({
        method: 'POST',
        url: '/v1/suppliers',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          code: 'SUP-BAD-EMAIL',
          businessName: 'Bad Email Supplier',
          email: 'not-an-email',
        },
      });
      expect(badEmailRes.statusCode).toBe(400);
      expect(badEmailRes.json().errorCode).toBe('ERR_VALIDATION_FAILED');

      // 5. Link supplier to Tenant Alpha's monitor product
      const prodsRes = await app.inject({
        method: 'GET',
        url: '/v1/products?search=SKU-MON-27-4K',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const monitorId = prodsRes.json().data[0].id as string;

      const linkRes = await app.inject({
        method: 'POST',
        url: `/v1/suppliers/${supplier.id}/products`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          productId: monitorId,
          supplierSku: 'PDD-DELL-274K',
          unitCost: '280.0000',
          currencyCode: 'USD',
          minimumOrderQty: '5.0000',
          leadTimeDays: 7,
          isPreferred: true,
        },
      });
      expect(linkRes.statusCode).toBe(201);
      expect(linkRes.json().supplierSku).toBe('PDD-DELL-274K');
      expect(linkRes.json().isPreferred).toBe(true);

      // 6. Verify GET /v1/suppliers/:supplierId returns linked products
      const getSupRes = await app.inject({
        method: 'GET',
        url: `/v1/suppliers/${supplier.id}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(getSupRes.statusCode).toBe(200);
      expect(getSupRes.json().products).toHaveLength(1);
      expect(getSupRes.json().products[0].productId).toBe(monitorId);

      await app.close();
    });
  });

  describe('4. Stock Movements & Inventory Balances (INV): Ledger Immutability, UoM Conversion, Idempotency, Concurrency, Negative-Stock Policy & Reversal', () => {
    let monitorProductId: string;
    let serviceProductId: string;

    beforeAll(async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider,
      });

      const prodsRes = await app.inject({
        method: 'GET',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const items = prodsRes.json().data as Array<{
        id: string;
        sku: string;
      }>;
      monitorProductId = items.find((p) => p.sku === 'SKU-MON-27-4K')!.id;
      serviceProductId = items.find((p) => p.sku === 'SRV-INSTALL-01')!.id;

      await app.close();
    });

    it('processes OPENING_STOCK, STOCK_IN (with UoM conversion), STOCK_OUT, adjustments, returns, idempotency replay, and single-use reversal', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider,
      });

      // 1. Post OPENING_STOCK of 20.0000 PCS
      const openingKey = generateUuidV7();
      const openingRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': openingKey,
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'OPENING_STOCK',
          quantity: '20.0000',
          uomCode: 'PCS',
          unitCost: '285.5000',
          referenceType: 'OPENING_BALANCE',
          referenceId: 'OB-2026-001',
          reason: 'Initial warehouse count',
        },
      });
      expect(openingRes.statusCode).toBe(201);
      expect(openingRes.headers['x-idempotent-replayed']).toBe('false');
      const openingMov = openingRes.json();
      expect(openingMov.qtyDelta).toBe('20.000000');
      expect(openingMov.balanceAfter).toBe('20.000000');

      // 2. Replay identical request with same Idempotency-Key -> returns 201 with x-idempotent-replayed: true, balance stays 20.0000
      const replayRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': openingKey,
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'OPENING_STOCK',
          quantity: '20.0000',
          uomCode: 'PCS',
          unitCost: '285.5000',
          referenceType: 'OPENING_BALANCE',
          referenceId: 'OB-2026-001',
          reason: 'Initial warehouse count',
        },
      });
      expect(replayRes.statusCode).toBe(201);
      expect(replayRes.headers['x-idempotent-replayed']).toBe('true');
      expect(replayRes.json().id).toBe(openingMov.id);

      // 3. Reuse same Idempotency-Key with different quantity -> 422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH
      const mismatchRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': openingKey,
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'OPENING_STOCK',
          quantity: '99.0000',
        },
      });
      expect(mismatchRes.statusCode).toBe(422);
      expect(mismatchRes.json().errorCode).toBe(
        'ERR_IDEMPOTENCY_KEY_REUSED_DIFFERENT_PAYLOAD',
      );

      // BUG-014 Regression: Reject tracking mode change when on-hand stock exists (409 CAT_INVALID_TRACKING_MODE_TRANSITION)
      const invalidTransitionRes = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${monitorProductId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          trackingMode: 'BATCH',
        },
      });
      expect(invalidTransitionRes.statusCode).toBe(409);
      expect(invalidTransitionRes.json().errorCode).toBe(
        'CAT_INVALID_TRACKING_MODE_TRANSITION',
      );

      // 3b. Phase 5.1 BUG-002: Post stock movement accepting `notes` field without 400 validation error
      const testNotesProdRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          sku: 'SKU-MOUSE-BUG002',
          name: 'Optical Mouse Bug 002',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '2500.0000',
          sellingPrice: '3500.0000',
        },
      });
      expect(testNotesProdRes.statusCode).toBe(201);
      const testNotesProdId = testNotesProdRes.json().id;

      const movementWithNotesKey = generateUuidV7();
      const movementWithNotesRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': movementWithNotesKey,
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: testNotesProdId,
          movementType: 'OPENING_STOCK',
          quantity: '50.0000',
          uomCode: 'PCS',
          unitCost: '2500.0000',
          notes: 'Initial warehouse intake note',
        },
      });
      expect(movementWithNotesRes.statusCode).toBe(201);
      const movNotesJson = movementWithNotesRes.json();
      expect(movNotesJson.reason).toBe('Initial warehouse intake note');
      expect(movNotesJson.notes).toBe('Initial warehouse intake note');

      // 4. Post STOCK_IN using alternate UoM "BOX" (2 BOX * 6.000000 PCS/BOX = +12.000000 PCS -> balanceAfter = 32.000000)
      const stockInBoxRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'STOCK_IN',
          quantity: '2.0000',
          uomCode: 'BOX',
          unitCost: '280.0000',
          referenceType: 'SUPPLIER_DELIVERY',
          referenceId: 'DEL-001',
        },
      });
      expect(stockInBoxRes.statusCode).toBe(201);
      expect(stockInBoxRes.json().qtyDelta).toBe('12.000000');
      expect(stockInBoxRes.json().balanceAfter).toBe('32.000000');
      expect(stockInBoxRes.json().conversionFactorToBase).toBe('6.000000');

      // 5. Post STOCK_OUT of -5.0000 PCS -> balanceAfter = 27.000000
      const stockOutRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'STOCK_OUT',
          quantity: '-5.0000',
          uomCode: 'PCS',
          referenceType: 'DISPATCH',
          referenceId: 'DISP-101',
        },
      });
      expect(stockOutRes.statusCode).toBe(201);
      expect(stockOutRes.json().qtyDelta).toBe('-5.000000');
      expect(stockOutRes.json().balanceAfter).toBe('27.000000');

      // 6. Post ADJUSTMENT_NEGATIVE (-2.0000), CUSTOMER_RETURN_RESTOCK (+1.0000), SUPPLIER_RETURN (-1.0000) -> balanceAfter = 25.000000
      const adjNegRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'ADJUSTMENT_NEGATIVE',
          quantity: '-2.0000',
          reason: 'Damaged display panel during inspection',
        },
      });
      expect(adjNegRes.statusCode).toBe(201);
      expect(adjNegRes.json().balanceAfter).toBe('25.000000');

      const custRetRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'CUSTOMER_RETURN_RESTOCK',
          quantity: '1.0000',
          referenceId: 'RMA-009',
        },
      });
      expect(custRetRes.statusCode).toBe(201);
      expect(custRetRes.json().balanceAfter).toBe('26.000000');

      const supRetRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'SUPPLIER_RETURN',
          quantity: '-1.0000',
          referenceId: 'RTV-004',
        },
      });
      expect(supRetRes.statusCode).toBe(201);
      expect(supRetRes.json().balanceAfter).toBe('25.000000');

      // 7. Reverse the ADJUSTMENT_NEGATIVE (-2.0000) -> posts CORRECTION_REVERSAL (+2.000000) -> balanceAfter = 27.000000
      const adjNegId = adjNegRes.json().id as string;
      const reverseRes = await app.inject({
        method: 'POST',
        url: `/v1/inventory/movements/${adjNegId}/reverse`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          reason: 'Inspection error — units were intact in Secondary Bin B',
        },
      });
      expect(reverseRes.statusCode).toBe(201);
      const reversalEntry = reverseRes.json();
      expect(reversalEntry.movementType).toBe('CORRECTION_REVERSAL');
      expect(reversalEntry.qtyDelta).toBe('2.000000');
      expect(reversalEntry.balanceAfter).toBe('27.000000');
      expect(reversalEntry.reversedEntryId).toBe(adjNegId);

      // 8. Attempting to reverse the same movement a second time must fail with 409 INV_MOVEMENT_ALREADY_REVERSED
      const doubleReverseRes = await app.inject({
        method: 'POST',
        url: `/v1/inventory/movements/${adjNegId}/reverse`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          reason: 'Attempting second reversal',
        },
      });
      expect(doubleReverseRes.statusCode).toBe(409);
      expect(doubleReverseRes.json().errorCode).toBe(
        'INV_MOVEMENT_ALREADY_REVERSED',
      );

      // 9. Attempting to reverse a CORRECTION_REVERSAL entry must also fail with 422 INV_INVALID_MOVEMENT_QUANTITY
      const reverseTheReversalRes = await app.inject({
        method: 'POST',
        url: `/v1/inventory/movements/${reversalEntry.id}/reverse`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          reason: 'Reversing a reversal',
        },
      });
      expect(reverseTheReversalRes.statusCode).toBe(409);
      expect(reverseTheReversalRes.json().errorCode).toBe(
        'INV_MOVEMENT_ALREADY_REVERSED',
      );

      // 10. Reject zero quantity, wrong sign, and SERVICE (non-trackable) product movements
      const zeroQtyRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'STOCK_IN',
          quantity: '0.0000',
        },
      });
      expect(zeroQtyRes.statusCode).toBe(422);
      expect(zeroQtyRes.json().errorCode).toBe('INV_INVALID_MOVEMENT_QUANTITY');

      const wrongSignRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'STOCK_IN',
          quantity: '-5.0000',
        },
      });
      expect(wrongSignRes.statusCode).toBe(422);
      expect(wrongSignRes.json().errorCode).toBe(
        'INV_INVALID_MOVEMENT_QUANTITY',
      );

      const serviceMovRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: serviceProductId,
          movementType: 'STOCK_IN',
          quantity: '1.0000',
        },
      });
      expect(serviceMovRes.statusCode).toBe(422);
      expect(serviceMovRes.json().errorCode).toBe('INV_PRODUCT_NOT_TRACKABLE');

      await app.close();
    });

    it('serializes concurrent stock movement requests accurately and enforces negative-stock policy and privileged override', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider,
      });

      // Current balance is 27.0000. Fire 5 concurrent ADJUSTMENT_POSITIVE movements of +3.0000 each (+15.0000 total -> 42.0000)
      const concurrentResponses = await Promise.all(
        Array.from({ length: 5 }, (_, idx) =>
          app.inject({
            method: 'POST',
            url: '/v1/inventory/movements',
            headers: {
              authorization: `Bearer ${alphaOwnerToken}`,
              'x-tenant-id': TENANT_ALPHA_ID,
              'idempotency-key': generateUuidV7(),
            },
            payload: {
              branchId: alphaBranch1Id,
              warehouseId: alphaMainWarehouseId,
              productId: monitorProductId,
              movementType: 'ADJUSTMENT_POSITIVE',
              quantity: '3.0000',
              reason: `Concurrent batch ${idx + 1}`,
            },
          }),
        ),
      );

      for (const res of concurrentResponses) {
        expect(res.statusCode).toBe(201);
      }

      // Check balance is exactly 42.0000
      const balancesRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?warehouseId=${alphaMainWarehouseId}&productId=${monitorProductId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(balancesRes.statusCode).toBe(200);
      expect(balancesRes.json().data[0].qtyOnHand).toBe('42.000000');
      expect(balancesRes.json().data[0].stockState).toBe('OK');

      // Attempt STOCK_OUT of -50.0000 when warehouse allowNegativeStock = false -> 409 INV_INSUFFICIENT_AVAILABLE_STOCK
      const insufficientRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'STOCK_OUT',
          quantity: '-50.0000',
        },
      });
      expect(insufficientRes.statusCode).toBe(409);
      expect(insufficientRes.json().errorCode).toBe(
        'INV_INSUFFICIENT_AVAILABLE_STOCK',
      );

      // Attempt negative-stock override by INVENTORY_CLERK (who has inv:movement:post but NOT inv:movement:reverse) -> 403 IAM_PERMISSION_DENIED
      const clerkOverrideRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaBranch1ClerkToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'STOCK_OUT',
          quantity: '-50.0000',
          allowNegativeStockOverride: true,
          overrideReason: 'Clerk trying to force negative stock',
        },
      });
      expect(clerkOverrideRes.statusCode).toBe(403);
      expect(clerkOverrideRes.json().errorCode).toBe('IAM_PERMISSION_DENIED');

      // Authorized Manager/Owner override with allowNegativeStockOverride: true and overrideReason -> succeeds, balance becomes -8.000000 (NEGATIVE_STOCK)
      const managerOverrideRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'STOCK_OUT',
          quantity: '-50.0000',
          allowNegativeStockOverride: true,
          overrideReason:
            'Emergency customer fulfillment while inbound truck is at dock gate',
        },
      });
      expect(managerOverrideRes.statusCode).toBe(201);
      expect(managerOverrideRes.json().balanceAfter).toBe('-8.000000');

      // Check stockState is NEGATIVE_STOCK
      const negBalanceRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?warehouseId=${alphaMainWarehouseId}&stockState=NEGATIVE_STOCK`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(negBalanceRes.statusCode).toBe(200);
      expect(negBalanceRes.json().data).toHaveLength(1);
      expect(negBalanceRes.json().data[0].qtyOnHand).toBe('-8.000000');
      expect(negBalanceRes.json().data[0].stockState).toBe('NEGATIVE_STOCK');

      // Receive +15.0000 STOCK_IN -> balance becomes +7.000000, which is <= reorderPoint (10.000000) -> stockState = LOW_STOCK
      const replenishRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: monitorProductId,
          movementType: 'STOCK_IN',
          quantity: '15.0000',
        },
      });
      expect(replenishRes.statusCode).toBe(201);
      expect(replenishRes.json().balanceAfter).toBe('7.000000');

      const lowStockRes = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?warehouseId=${alphaMainWarehouseId}&stockState=LOW_STOCK`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(lowStockRes.statusCode).toBe(200);
      expect(lowStockRes.json().data).toHaveLength(1);
      expect(lowStockRes.json().data[0].stockState).toBe('LOW_STOCK');

      // Reconcile ledger vs materialized inventory_balances -> must be 100% consistent
      const reconcileRes = await app.inject({
        method: 'GET',
        url: '/v1/inventory/balances/reconcile',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(reconcileRes.statusCode).toBe(200);
      expect(reconcileRes.json().isConsistent).toBe(true);
      expect(reconcileRes.json().discrepancies).toHaveLength(0);

      await app.close();
    });

    it('blocks direct SQL mutation of stock_ledger_entries and blocks direct manipulation of inventory_balances bypassing the ledger', async () => {
      // 1. Direct UPDATE on stock_ledger_entries: Layer 1 (runtime role) lacks UPDATE privilege
      await expect(
        withTenantTransaction(
          harness.db,
          {
            tenantId: TENANT_ALPHA_ID,
            userId: TENANT_ALPHA_OWNER,
            traceId: 'trace_tamper_ledger_acl',
          },
          async (trx) => {
            await trx.db
              .updateTable('stock_ledger_entries')
              .set({ qty_delta: '9999.0000' })
              .where('product_id', '=', monitorProductId)
              .execute();
          },
        ),
      ).rejects.toThrow(/permission denied for table stock_ledger_entries/);

      // Layer 2: Privileged table owner is blocked by prevent_immutable_row_mutation trigger
      await expect(
        harness.db
          .updateTable('stock_ledger_entries')
          .set({ qty_delta: '9999.0000' })
          .where('product_id', '=', monitorProductId)
          .execute(),
      ).rejects.toThrow(/IMMUTABLE_TABLE_VIOLATION/);

      // 2. Direct DELETE on stock_ledger_entries: Layer 1 (runtime role) lacks DELETE privilege
      await expect(
        withTenantTransaction(
          harness.db,
          {
            tenantId: TENANT_ALPHA_ID,
            userId: TENANT_ALPHA_OWNER,
            traceId: 'trace_delete_ledger_acl',
          },
          async (trx) => {
            await trx.db
              .deleteFrom('stock_ledger_entries')
              .where('product_id', '=', monitorProductId)
              .execute();
          },
        ),
      ).rejects.toThrow(/permission denied for table stock_ledger_entries/);

      // Layer 2: Privileged table owner is blocked by prevent_immutable_row_mutation trigger
      await expect(
        harness.db
          .deleteFrom('stock_ledger_entries')
          .where('product_id', '=', monitorProductId)
          .execute(),
      ).rejects.toThrow(/IMMUTABLE_TABLE_VIOLATION/);

      // 3. Direct UPDATE on inventory_balances (trying to set qty_on_hand = '5000.0000' without a matching ledger entry)
      // must be rejected by trg_inventory_balances_ledger_integrity!
      await expect(
        harness.db
          .updateTable('inventory_balances')
          .set({ qty_on_hand: '5000.0000' })
          .where('product_id', '=', monitorProductId)
          .execute(),
      ).rejects.toThrow(/BALANCE_LEDGER_INVARIANT_VIOLATION/);
    });
  });

  describe('5. Security, RBAC, Location Scope, Multi-Tenant RLS Isolation & Subscription Gating', () => {
    it('enforces JWT authentication, CASHIER read-only inventory access, branch/warehouse location scoping, cross-tenant IDOR protection, and subscription write gating', async () => {
      const app = await buildApp({
        db: harness.db,
        jwksProvider,
      });

      // 1. Anonymous request -> 401
      const anonRes = await app.inject({
        method: 'GET',
        url: '/v1/products',
        headers: {
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(anonRes.statusCode).toBe(401);

      // 2. CASHIER can list products and balances (200), but cannot create products, suppliers, or post movements (403 IAM_PERMISSION_DENIED)
      const cashierReadProd = await app.inject({
        method: 'GET',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(cashierReadProd.statusCode).toBe(200);
      const alphaProdId = cashierReadProd.json().data[0].id as string;

      const cashierCreateProd = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          sku: 'CASHIER-UNAUTHORIZED',
          name: 'Cashier Product',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '1.0000',
          sellingPrice: '2.0000',
        },
      });
      expect(cashierCreateProd.statusCode).toBe(403);
      expect(cashierCreateProd.json().errorCode).toBe('IAM_PERMISSION_DENIED');

      const cashierPostMovement = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaCashierToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: alphaProdId,
          movementType: 'STOCK_IN',
          quantity: '10.0000',
        },
      });
      expect(cashierPostMovement.statusCode).toBe(403);
      expect(cashierPostMovement.json().errorCode).toBe(
        'IAM_PERMISSION_DENIED',
      );

      // 3. Location Scope Enforcement:
      // alphaBranch1Clerk is scoped to Branch 1 (alphaBranch1Id -> alphaMainWarehouseId).
      // Posting a movement to alphaMainWarehouseId succeeds (201), but posting to or reading from alphaBranch2WarehouseId fails with 403 IAM_LOCATION_SCOPE_DENIED!
      const clerkAllowedMov = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaBranch1ClerkToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch1Id,
          warehouseId: alphaMainWarehouseId,
          productId: alphaProdId,
          movementType: 'STOCK_IN',
          quantity: '3.0000',
        },
      });
      expect(clerkAllowedMov.statusCode).toBe(201);

      const clerkForbiddenWhMov = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: {
          authorization: `Bearer ${alphaBranch1ClerkToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          branchId: alphaBranch2Id,
          warehouseId: alphaBranch2WarehouseId,
          productId: alphaProdId,
          movementType: 'STOCK_IN',
          quantity: '3.0000',
        },
      });
      expect(clerkForbiddenWhMov.statusCode).toBe(403);
      expect(clerkForbiddenWhMov.json().errorCode).toBe(
        'IAM_LOCATION_SCOPE_DENIED',
      );

      const clerkForbiddenWhBalances = await app.inject({
        method: 'GET',
        url: `/v1/inventory/balances?warehouseId=${alphaBranch2WarehouseId}`,
        headers: {
          authorization: `Bearer ${alphaBranch1ClerkToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(clerkForbiddenWhBalances.statusCode).toBe(403);
      expect(clerkForbiddenWhBalances.json().errorCode).toBe(
        'IAM_LOCATION_SCOPE_DENIED',
      );

      // 4. Cross-Tenant IDOR Protection via PostgreSQL RLS:
      // Tenant Beta owner attempting to read or mutate Tenant Alpha's product under Tenant Beta context gets 404
      const idorGetProd = await app.inject({
        method: 'GET',
        url: `/v1/products/${alphaProdId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(idorGetProd.statusCode).toBe(404);

      const idorPatchProd = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${alphaProdId}`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
        payload: {
          name: 'Hacked Product Name',
        },
      });
      expect(idorPatchProd.statusCode).toBe(404);

      // 5. Subscription Lifecycle Gating:
      // First, set Tenant Beta's subscription to PAST_DUE -> Beta can still GET products (200), but POST /v1/products fails with 403 SUB_SUBSCRIPTION_INACTIVE
      const pastDueBetaRes = await app.inject({
        method: 'PATCH',
        url: '/v1/subscriptions/lifecycle',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
        payload: {
          status: 'PAST_DUE',
          overrideReason: 'Grace period test',
        },
      });
      expect(pastDueBetaRes.statusCode).toBe(200);

      const betaReadWhilePastDue = await app.inject({
        method: 'GET',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(betaReadWhilePastDue.statusCode).toBe(200);

      const betaWriteWhilePastDue = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
        payload: {
          sku: 'BLOCKED-BY-SUB',
          name: 'Blocked Product',
          productType: 'STANDARD',
          baseUom: 'PCS',
          purchaseCost: '10.0000',
          sellingPrice: '20.0000',
        },
      });
      expect(betaWriteWhilePastDue.statusCode).toBe(403);
      expect(betaWriteWhilePastDue.json().errorCode).toBe(
        'SUB_SUBSCRIPTION_INACTIVE',
      );

      // Next, transition to SUSPENDED -> Both GET and POST are blocked with 403 SUB_SUBSCRIPTION_INACTIVE
      const suspendBetaRes = await app.inject({
        method: 'PATCH',
        url: '/v1/subscriptions/lifecycle',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
        payload: {
          status: 'SUSPENDED',
          overrideReason: 'Suspended account test',
        },
      });
      expect(suspendBetaRes.statusCode).toBe(200);

      const betaReadWhileSuspended = await app.inject({
        method: 'GET',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
      });
      expect(betaReadWhileSuspended.statusCode).toBe(403);
      expect(betaReadWhileSuspended.json().errorCode).toBe(
        'SUB_SUBSCRIPTION_INACTIVE',
      );

      await app.close();
    });
  });
});
