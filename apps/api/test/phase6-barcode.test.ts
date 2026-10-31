import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  generateUuidV7,
} from '../src/index.js';
import {
  calculateEanCheckDigit,
  validateBarcodeCheckDigit,
} from '../src/modules/cat/application/barcode.service.js';
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

const TENANT_ALPHA_ID = '0192b4c0-7777-7000-8000-000000000010';
const TENANT_ALPHA_OWNER = '0192b4c0-7777-7000-8000-000000000001';

const TENANT_BETA_ID = '0192b4c0-8888-7000-8000-000000000010';
const TENANT_BETA_OWNER = '0192b4c0-8888-7000-8000-000000000001';

describe('@nexstock/api — Phase 6: Universal Barcode Management & Dual-Mode POS Scanning System', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const primaryKey = createTestEs256KeyMaterial(
    '01f76c4b-9743-48ad-bed6-a9c89dc99cc5',
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
  let betaOwnerToken: string;

  let alphaBranchId: string;
  let alphaWarehouseId: string;
  let alphaProductAId: string;
  let alphaProductBId: string;
  let alphaSerialProductId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    alphaOwnerToken = issueToken(
      TENANT_ALPHA_OWNER,
      'owner@alpha-barcodes.example.com',
    );
    betaOwnerToken = issueToken(
      TENANT_BETA_OWNER,
      'owner@beta-barcodes.example.com',
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
        slug: 'alpha-barcodes',
        legalName: 'Alpha Universal Barcode Systems',
        baseCurrency: 'USD',
        defaultLocale: 'en-US',
        defaultTimezone: 'America/New_York',
        countryCode: 'US',
        ownerEmail: 'owner@alpha-barcodes.example.com',
        ownerFullName: 'Alpha Barcode Admin',
        planCode: 'GROWTH',
      },
    });
    expect(alphaOnboardRes.statusCode).toBe(201);

    // 2. Onboard Tenant Beta
    const betaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
      payload: {
        slug: 'beta-barcodes',
        legalName: 'Beta Isolated Retail Ltd',
        baseCurrency: 'EUR',
        defaultLocale: 'en-GB',
        defaultTimezone: 'Europe/London',
        countryCode: 'GB',
        ownerEmail: 'owner@beta-barcodes.example.com',
        ownerFullName: 'Beta Retail Owner',
        planCode: 'GROWTH',
      },
    });
    expect(betaOnboardRes.statusCode).toBe(201);

    // 3. Create Alpha Branch & Warehouse
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'BR-MAIN',
        name: 'Main Flagship Store',
        timezone: 'America/New_York',
        countryCode: 'US',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    alphaBranchId = branchRes.json().id;

    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        branchId: alphaBranchId,
        code: 'WH-MAIN',
        name: 'Main Store Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(whRes.statusCode).toBe(201);
    alphaWarehouseId = whRes.json().id;

    // 4. Create Product A (with initial Primary Barcode)
    const prodARes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        sku: 'SCAN-PROD-001',
        name: 'Laser Wireless Barcode Scanner',
        baseUom: 'PCS',
        purchaseCost: '45.0000',
        sellingPrice: '89.9900',
        trackInventory: true,
        primaryBarcode: '2001234567893', // Valid EAN-13
      },
    });
    expect(prodARes.statusCode).toBe(201);
    alphaProductAId = prodARes.json().id;

    // 5. Create Product B (No initial barcode - test barcode-optional principle)
    const prodBRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        sku: 'MANUAL-PROD-002',
        name: 'Manual POS Generic Widget',
        baseUom: 'PCS',
        purchaseCost: '10.0000',
        sellingPrice: '19.9900',
        trackInventory: true,
      },
    });
    expect(prodBRes.statusCode).toBe(201);
    alphaProductBId = prodBRes.json().id;

    // 6. Create Serial Tracked Product
    const serialProdRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        sku: 'SERIAL-PROD-003',
        name: 'Industrial Rugged Terminal',
        baseUom: 'PCS',
        purchaseCost: '350.0000',
        sellingPrice: '699.0000',
        trackInventory: true,
        trackingMode: 'SERIAL',
      },
    });
    expect(serialProdRes.statusCode).toBe(201);
    alphaSerialProductId = serialProdRes.json().id;

    // Register a serial number in stock for SERIAL-PROD-003
    const registerSerialRes = await app.inject({
      method: 'POST',
      url: `/v1/inventory/serials`,
      headers: {
        authorization: `Bearer ${alphaOwnerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        productId: alphaSerialProductId,
        branchId: alphaBranchId,
        warehouseId: alphaWarehouseId,
        serialNumbers: ['SN-RUGGED-998811'],
        unitCost: '350.0000',
      },
    });
    expect(registerSerialRes.statusCode).toBe(201);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (harness) await harness.db.destroy();
  });

  // ===========================================================================
  // 1. Checksum Calculation & Validation Unit Tests
  // ===========================================================================
  describe('1. Check Digit Invariants (Modulo-10 GS1)', () => {
    it('accurately calculates EAN-13 / UPC-A check digits', () => {
      // 12 digits: 200123456789 -> check digit must be '3'
      const checkEan13 = calculateEanCheckDigit('200123456789');
      expect(checkEan13).toBe('3');

      // 7 digits: 4006381 -> check digit must be '2' (EAN-8: 40063812)
      const checkEan8 = calculateEanCheckDigit('4006381');
      expect(checkEan8).toBe('2');

      // 11 digits: 01234567890 -> check digit must be '5' (UPC-A: 012345678905)
      const checkUpca = calculateEanCheckDigit('01234567890');
      expect(checkUpca).toBe('5');
    });

    it('validates barcode check digits accurately and rejects corrupted numbers', () => {
      expect(validateBarcodeCheckDigit('2001234567893', 'EAN13')).toBe(true);
      expect(validateBarcodeCheckDigit('2001234567890', 'EAN13')).toBe(false); // corrupted
      expect(validateBarcodeCheckDigit('40063812', 'EAN8')).toBe(true);
      expect(validateBarcodeCheckDigit('40063815', 'EAN8')).toBe(false); // corrupted
      expect(validateBarcodeCheckDigit('012345678905', 'UPCA')).toBe(true);
      expect(validateBarcodeCheckDigit('012345678909', 'UPCA')).toBe(false); // corrupted

      // Code 128 has internal check characters, format check passes alphanumeric
      expect(validateBarcodeCheckDigit('NB-100234', 'CODE128')).toBe(true);
    });
  });

  // ===========================================================================
  // 2. Internal Barcode Generation Endpoint
  // ===========================================================================
  describe('2. Internal Barcode Generator (POST /v1/products/generate-barcode)', () => {
    it('generates collision-free EAN-13 barcodes with valid GS1 checksum', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/products/generate-barcode?symbology=EAN13',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.symbology).toBe('EAN13');
      expect(body.barcode).toHaveLength(13);
      expect(/^\d{13}$/.test(body.barcode)).toBe(true);
      expect(validateBarcodeCheckDigit(body.barcode, 'EAN13')).toBe(true);
    });

    it('generates valid EAN-8 barcodes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/products/generate-barcode?symbology=EAN8',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.symbology).toBe('EAN8');
      expect(body.barcode).toHaveLength(8);
      expect(/^\d{8}$/.test(body.barcode)).toBe(true);
      expect(validateBarcodeCheckDigit(body.barcode, 'EAN8')).toBe(true);
    });

    it('generates Code 128 barcodes using tenant prefix (default NB)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/products/generate-barcode?symbology=CODE128',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.symbology).toBe('CODE128');
      expect(body.barcode.startsWith('NB-')).toBe(true);
    });
  });

  // ===========================================================================
  // 3. Product Barcode Management CRUD & RLS Isolation
  // ===========================================================================
  describe('3. Barcode CRUD, Validation & Multi-Tenant Isolation', () => {
    let secondaryBarcodeId: string;

    it('lists existing primary barcode from product creation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/products/${alphaProductAId}/barcodes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const barcodes = res.json();
      expect(barcodes.length).toBeGreaterThanOrEqual(1);
      const primary = barcodes.find((b: { isPrimary?: boolean }) => b.isPrimary);
      expect(primary).toBeDefined();
      expect(primary.barcode).toBe('2001234567893');
      expect(primary.isActive).toBe(true);
    });

    it('rejects registering invalid EAN-13 checksum with 400 Bad Request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/products/${alphaProductAId}/barcodes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          barcode: '2001234567890', // invalid check digit
          symbology: 'EAN13',
          isPrimary: false,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('ERR_VALIDATION_FAILED');
    });

    it('registers valid secondary barcode for Product A', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/products/${alphaProductAId}/barcodes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          barcode: 'NB-ALT-001099',
          symbology: 'CODE128',
          isPrimary: false,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.barcode).toBe('NB-ALT-001099');
      expect(body.symbology).toBe('CODE128');
      expect(body.isPrimary).toBe(false);
      expect(body.isActive).toBe(true);
      secondaryBarcodeId = body.id;
    });

    it('rejects duplicate barcode within the same tenant (409 Conflict)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/products/${alphaProductBId}/barcodes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          barcode: 'NB-ALT-001099', // Already registered on Product A
          symbology: 'CODE128',
          isPrimary: false,
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('CAT_DUPLICATE_BARCODE');
    });

    it('allows Tenant Beta to register the exact same barcode (Multi-Tenant Isolation)', async () => {
      // 1. Create a product in Tenant Beta
      const betaProdRes = await app.inject({
        method: 'POST',
        url: '/v1/products',
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
          'idempotency-key': generateUuidV7(),
        },
        payload: {
          sku: 'BETA-SKU-100',
          name: 'Beta Isolated Product',
          baseUom: 'PCS',
          purchaseCost: '5.0000',
          sellingPrice: '10.0000',
        },
      });
      expect(betaProdRes.statusCode).toBe(201);
      const betaProductId = betaProdRes.json().id;

      // 2. Register 'NB-ALT-001099' in Tenant Beta — must succeed without 409
      const betaBarcodeRes = await app.inject({
        method: 'POST',
        url: `/v1/products/${betaProductId}/barcodes`,
        headers: {
          authorization: `Bearer ${betaOwnerToken}`,
          'x-tenant-id': TENANT_BETA_ID,
        },
        payload: {
          barcode: 'NB-ALT-001099',
          symbology: 'CODE128',
          isPrimary: true,
        },
      });

      expect(betaBarcodeRes.statusCode).toBe(201);
      expect(betaBarcodeRes.json().barcode).toBe('NB-ALT-001099');
    });

    it('updates barcode active status (deactivation) via PATCH', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${alphaProductAId}/barcodes/${secondaryBarcodeId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          isActive: false,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().isActive).toBe(false);
    });

    it('promotes a barcode to primary and updates product primary_barcode', async () => {
      // Reactivate and promote
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/products/${alphaProductAId}/barcodes/${secondaryBarcodeId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          isActive: true,
          isPrimary: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().isPrimary).toBe(true);

      // Verify Product A now reflects NB-ALT-001099 as its primaryBarcode
      const prodRes = await app.inject({
        method: 'GET',
        url: `/v1/products/${alphaProductAId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(prodRes.statusCode).toBe(200);
      expect(prodRes.json().primaryBarcode).toBe('NB-ALT-001099');
    });

    it('deletes secondary barcode via DELETE', async () => {
      // First register another secondary barcode
      const addRes = await app.inject({
        method: 'POST',
        url: `/v1/products/${alphaProductAId}/barcodes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          barcode: 'TEMP-DEL-999',
          symbology: 'CUSTOM',
          isPrimary: false,
        },
      });
      expect(addRes.statusCode).toBe(201);
      const tempId = addRes.json().id;

      // Delete it
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/v1/products/${alphaProductAId}/barcodes/${tempId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json().success).toBe(true);

      // Verify deletion
      const listRes = await app.inject({
        method: 'GET',
        url: `/v1/products/${alphaProductAId}/barcodes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      const exists = listRes.json().some((b: { id?: string }) => b.id === tempId);
      expect(exists).toBe(false);
    });
  });

  // ===========================================================================
  // 4. Tenant Barcode Settings Endpoints
  // ===========================================================================
  describe('4. Tenant Barcode & Scanner Configuration (GET & PUT /v1/settings/barcode)', () => {
    it('returns default barcode settings when unconfigured', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/settings/barcode',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const settings = res.json();
      expect(settings.tenantId).toBe(TENANT_ALPHA_ID);
      expect(settings.barcodeManagementEnabled).toBe(true);
      expect(settings.internalGenerationEnabled).toBe(true);
      expect(settings.internalPrefix).toBe('NB');
      expect(settings.hardwareScannerEnabled).toBe(true);
      expect(settings.cameraScannerEnabled).toBe(true);
      expect(settings.autoAddToCart).toBe(true);
      expect(settings.incrementOnDuplicate).toBe(true);
      expect(settings.unknownBarcodeAction).toBe('PROMPT');
    });

    it('updates tenant barcode configuration (PUT)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings/barcode',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          internalPrefix: 'SCANX',
          autoAddToCart: false,
          unknownBarcodeAction: 'MANUAL_SEARCH',
        },
      });

      expect(res.statusCode).toBe(200);
      const updated = res.json();
      expect(updated.internalPrefix).toBe('SCANX');
      expect(updated.autoAddToCart).toBe(false);
      expect(updated.unknownBarcodeAction).toBe('MANUAL_SEARCH');
      expect(updated.hardwareScannerEnabled).toBe(true); // preserved

      // Generate barcode now uses the new prefix 'SCANX'
      const genRes = await app.inject({
        method: 'POST',
        url: '/v1/products/generate-barcode?symbology=CODE128',
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });
      expect(genRes.statusCode).toBe(200);
      expect(genRes.json().barcode.startsWith('SCANX-')).toBe(true);
    });
  });

  // ===========================================================================
  // 5. Dual-Mode POS Product Search Resolution
  // ===========================================================================
  describe('5. POS Dual-Mode Barcode Search & Fallback Resolution', () => {
    it('resolves product by primary barcode', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaWarehouseId}&barcode=NB-ALT-001099`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const results = res.json();
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(alphaProductAId);
      expect(results[0].sku).toBe('SCAN-PROD-001');
    });

    it('resolves product by active secondary barcode', async () => {
      // Register an alternate EAN barcode on Product B
      const addRes = await app.inject({
        method: 'POST',
        url: `/v1/products/${alphaProductBId}/barcodes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          barcode: '40063812', // Valid EAN-8
          symbology: 'EAN8',
          isPrimary: false,
        },
      });
      expect(addRes.statusCode).toBe(201);

      // Search POS with this EAN-8
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaWarehouseId}&barcode=40063812`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const results = res.json();
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(alphaProductBId);
      expect(results[0].name).toBe('Manual POS Generic Widget');
    });

    it('does NOT resolve product when barcode has been deactivated (isActive: false)', async () => {
      // Register and deactivate a barcode on Product B
      const addRes = await app.inject({
        method: 'POST',
        url: `/v1/products/${alphaProductBId}/barcodes`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: {
          barcode: 'INACTIVE-BC-88',
          symbology: 'CUSTOM',
          isPrimary: false,
        },
      });
      const bcId = addRes.json().id;

      // Deactivate it
      await app.inject({
        method: 'PATCH',
        url: `/v1/products/${alphaProductBId}/barcodes/${bcId}`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
        payload: { isActive: false },
      });

      // Search in POS should return empty array
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaWarehouseId}&barcode=INACTIVE-BC-88`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(0);
    });

    it('resolves product directly when scanning an in-stock serial number barcode', async () => {
      // Scanned barcode corresponds to registered serial number 'SN-RUGGED-998811'
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaWarehouseId}&barcode=SN-RUGGED-998811`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const results = res.json();
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(alphaSerialProductId);
      expect(results[0].sku).toBe('SERIAL-PROD-003');
    });

    it('upholds optional barcode principle: manual search by SKU / name continues working', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/pos/products/search?warehouseId=${alphaWarehouseId}&q=MANUAL-PROD`,
        headers: {
          authorization: `Bearer ${alphaOwnerToken}`,
          'x-tenant-id': TENANT_ALPHA_ID,
        },
      });

      expect(res.statusCode).toBe(200);
      const results = res.json();
      expect(results.length).toBe(1);
      expect(results[0].sku).toBe('MANUAL-PROD-002');
    });
  });
});
