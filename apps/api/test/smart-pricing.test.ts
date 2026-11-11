import { randomUUID, type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
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

describe('@nexstock/api — Phase 4 & 5: Smart Pricing Management System (PRICE-01..PRICE-20)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192f100-0000-7000-8000-000000000001';
  const OWNER_USER_ID = '0192f100-0000-7000-8000-000000000002';
  const MANAGER_A_USER_ID = '0192f100-0000-7000-8000-000000000003';
  const MANAGER_B_USER_ID = '0192f100-0000-7000-8000-000000000004';
  const CASHIER_USER_ID = '0192f100-0000-7000-8000-000000000005';

  const primaryKey = createTestEs256KeyMaterial('test-key-smart-pricing-p4');
  const jwksProvider = new StaticJwksProvider({ keys: [primaryKey.publicJwk] });
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
  let managerAToken: string;
  let managerBToken: string;
  let cashierToken: string;

  let branchAId: string;
  let branchBId: string;
  let warehouseAId: string;
  let warehouseBId: string;
  let registerAId: string;
  let registerBId: string;
  let shiftAId: string;
  let supplierId: string;

  let sugarId: string;
  let lowMarginId: string;

  const authHeaders = (token: string, extra?: Record<string, string>) => ({
    authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_ID,
    'content-type': 'application/json',
    ...extra,
  });

  const idemHeaders = (token: string) =>
    authHeaders(token, { 'idempotency-key': randomUUID() });

  beforeAll(async () => {
    harness = await createTestPostgresHarness();
    ownerToken = issueToken(OWNER_USER_ID, 'owner@smartpricing.test');
    managerAToken = issueToken(MANAGER_A_USER_ID, 'manager-a@smartpricing.test');
    managerBToken = issueToken(MANAGER_B_USER_ID, 'manager-b@smartpricing.test');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@smartpricing.test');

    app = await buildApp({ db: harness.db, jwksProvider });

    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: authHeaders(ownerToken),
      payload: {
        slug: 'lanka-smart-pricing',
        legalName: 'Lanka Smart Retail Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@smartpricing.test',
        ownerFullName: 'Owner Principal',
        planCode: 'GROWTH',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    const branchARes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: authHeaders(ownerToken),
      payload: {
        code: 'BR-COL-MAIN',
        name: 'Colombo Main',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branchARes.statusCode).toBe(201);
    branchAId = branchARes.json().id;

    const branchBRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: authHeaders(ownerToken),
      payload: {
        code: 'BR-KDY-01',
        name: 'Kandy Branch',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branchBRes.statusCode).toBe(201);
    branchBId = branchBRes.json().id;

    const whARes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: authHeaders(ownerToken),
      payload: {
        branchId: branchAId,
        code: 'WH-COL-01',
        name: 'Colombo Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(whARes.statusCode).toBe(201);
    warehouseAId = whARes.json().id;

    const whBRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: authHeaders(ownerToken),
      payload: {
        branchId: branchBId,
        code: 'WH-KDY-01',
        name: 'Kandy Warehouse',
        allowNegativeStock: false,
      },
    });
    expect(whBRes.statusCode).toBe(201);
    warehouseBId = whBRes.json().id;

    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'seed_pricing_staff' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: MANAGER_A_USER_ID,
          email: 'manager-a@smartpricing.test',
          fullName: 'Manager Colombo',
          roleCodes: ['BRANCH_MANAGER'],
          allLocationsAccess: false,
          branchIds: [branchAId],
          warehouseIds: [warehouseAId],
          status: 'ACTIVE',
        });
        await provisionTenantMember(trx, {
          userId: MANAGER_B_USER_ID,
          email: 'manager-b@smartpricing.test',
          fullName: 'Manager Kandy',
          roleCodes: ['BRANCH_MANAGER'],
          allLocationsAccess: false,
          branchIds: [branchBId],
          warehouseIds: [warehouseBId],
          status: 'ACTIVE',
        });
        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@smartpricing.test',
          fullName: 'Front Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
      },
    );

    const regARes = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers',
      headers: authHeaders(ownerToken),
      payload: {
        branchId: branchAId,
        warehouseId: warehouseAId,
        code: 'REG-COL-01',
        name: 'Colombo Register 1',
      },
    });
    expect(regARes.statusCode).toBe(201);
    registerAId = regARes.json().id;

    const regBRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/registers',
      headers: authHeaders(ownerToken),
      payload: {
        branchId: branchBId,
        warehouseId: warehouseBId,
        code: 'REG-KDY-01',
        name: 'Kandy Register 1',
      },
    });
    expect(regBRes.statusCode).toBe(201);
    registerBId = regBRes.json().id;

    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: idemHeaders(cashierToken),
      payload: {
        registerId: registerAId,
        openingCashFloat: '5000.0000',
      },
    });
    expect(shiftRes.statusCode).toBe(201);
    shiftAId = shiftRes.json().id;

    const supRes = await app.inject({
      method: 'POST',
      url: '/v1/suppliers',
      headers: authHeaders(ownerToken),
      payload: {
        code: 'SUP-LANKA-01',
        businessName: 'Lanka Sugar Mills',
      },
    });
    expect(supRes.statusCode).toBe(201);
    supplierId = supRes.json().id;

    const sugarRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders(ownerToken),
      payload: {
        sku: 'SUGAR-KG-01',
        name: 'White Cane Sugar (Loose)',
        productType: 'STANDARD',
        trackingMode: 'NONE',
        valuationMethod: 'MOVING_AVG',
        baseUom: 'KG',
        productQtyMode: 'VARIABLE',
        measurementCategory: 'WEIGHT',
        priceUom: 'KG',
        allowedSellingUoms: ['KG', 'G'],
        qtyDecimalPrecision: 3,
        featuredPos: true,
        purchaseCost: '200.0000',
        sellingPrice: '250.0000',
        trackInventory: true,
      },
    });
    expect(sugarRes.statusCode).toBe(201);
    sugarId = sugarRes.json().id;

    const lowMarginRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders(ownerToken),
      payload: {
        sku: 'LOSS-SKU-01',
        name: 'Promo Loss Leader',
        productType: 'STANDARD',
        trackingMode: 'NONE',
        valuationMethod: 'MOVING_AVG',
        baseUom: 'EA',
        purchaseCost: '150.0000',
        sellingPrice: '140.0000',
        trackInventory: false,
      },
    });
    expect(lowMarginRes.statusCode).toBe(201);
    lowMarginId = lowMarginRes.json().id;

    // Seed initial Sugar stock (50 KG) at Colombo Warehouse & Kandy Warehouse
    for (const whId of [warehouseAId, warehouseBId]) {
      const brId = whId === warehouseAId ? branchAId : branchBId;
      const moveRes = await app.inject({
        method: 'POST',
        url: '/v1/inventory/movements',
        headers: idemHeaders(ownerToken),
        payload: {
          branchId: brId,
          warehouseId: whId,
          productId: sugarId,
          movementType: 'OPENING_STOCK',
          quantity: '50.000000',
          uomCode: 'KG',
          unitCost: '200.0000',
        },
      });
      expect(moveRes.statusCode).toBe(201);
    }
  });

  afterAll(async () => {
    await app?.close();
    await harness?.db.destroy();
  });

  it('enforces Margin vs Markup math, rejects >= 100% Margin, and calculates deterministic suggestions', async () => {
    const invalidMarginRes = await app.inject({
      method: 'PUT',
      url: `/v1/products/${sugarId}/pricing-rule`,
      headers: authHeaders(ownerToken),
      payload: {
        pricingMethod: 'PROFIT_MARGIN',
        targetPercentage: '100.00',
        costBasis: 'LAST_PURCHASE_COST',
        roundingRule: 'NONE',
      },
    });
    expect(invalidMarginRes.statusCode).toBe(422);
    expect(invalidMarginRes.json().errorCode).toBe('PRICING_INVALID_MARGIN_RATE');

    const marginRuleRes = await app.inject({
      method: 'PUT',
      url: `/v1/products/${sugarId}/pricing-rule`,
      headers: authHeaders(ownerToken),
      payload: {
        pricingMethod: 'PROFIT_MARGIN',
        targetPercentage: '25.00',
        costBasis: 'LAST_PURCHASE_COST',
        roundingRule: 'NONE',
        recalculateGlobalSuggestion: true,
      },
    });
    expect(marginRuleRes.statusCode).toBe(200);
    const marginSugg = marginRuleRes.json().createdSuggestion;
    expect(marginSugg).toBeTruthy();
    // Cost 200 / (1 - 0.25) = 266.6667
    expect(marginSugg.suggestedSellingPrice).toBe('266.6667');

    // Reject suggestion -> catalog price must remain 250.0000
    const rejectRes = await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${marginSugg.id}/reject-or-defer`,
      headers: authHeaders(ownerToken),
      payload: {
        action: 'REJECT',
        reviewNotes: 'Testing formula only, hold global price',
      },
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().status).toBe('REJECTED');

    const prodAfterReject = await app.inject({
      method: 'GET',
      url: `/v1/products/${sugarId}`,
      headers: authHeaders(ownerToken),
    });
    expect(prodAfterReject.json().sellingPrice).toBe('250.0000');

    // Configure Markup 25% -> 200 * 1.25 = 250.0000
    const markupRuleRes = await app.inject({
      method: 'PUT',
      url: `/v1/products/${sugarId}/pricing-rule`,
      headers: authHeaders(ownerToken),
      payload: {
        pricingMethod: 'COST_MARKUP',
        targetPercentage: '25.00',
        costBasis: 'LAST_PURCHASE_COST',
        roundingRule: 'NEAREST_1',
        recalculateGlobalSuggestion: true,
      },
    });
    expect(markupRuleRes.statusCode).toBe(200);
    expect(markupRuleRes.json().createdSuggestion.suggestedSellingPrice).toBe('250.0000');

    // Defer this suggestion without applying price change
    const deferRes = await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${markupRuleRes.json().createdSuggestion.id}/reject-or-defer`,
      headers: authHeaders(ownerToken),
      payload: {
        action: 'DEFER',
        deferredUntil: '2026-12-31',
        reviewNotes: 'Review at month end',
      },
    });
    expect(deferRes.statusCode).toBe(200);
    expect(deferRes.json().status).toBe('DEFERRED');
  });

  it('generates pending suggestions on GRN cost increases & cost decreases without silently overwriting active selling prices', async () => {
    // Configure Sugar rule: 20% PROFIT_MARGIN, LAST_PURCHASE_COST, NEAREST_1, min floor 240, max discount 10%
    const ruleRes = await app.inject({
      method: 'PUT',
      url: `/v1/products/${sugarId}/pricing-rule`,
      headers: authHeaders(ownerToken),
      payload: {
        pricingMethod: 'PROFIT_MARGIN',
        targetPercentage: '20.00',
        costBasis: 'LAST_PURCHASE_COST',
        roundingRule: 'NEAREST_1',
        minSellingPrice: '240.0000',
        minMarginPct: '10.00',
        maxDiscountPct: '10.00',
        suggestionsEnabled: true,
      },
    });
    expect(ruleRes.statusCode).toBe(200);

    // Enable autoCreateSuggestionsOnCostDecrease
    const settingsRes = await app.inject({
      method: 'PUT',
      url: '/v1/pricing/settings',
      headers: authHeaders(ownerToken),
      payload: {
        autoCreateSuggestionsOnCostChange: true,
        autoCreateSuggestionsOnCostDecrease: true,
      },
    });
    expect(settingsRes.statusCode).toBe(200);

    const beforePoll = Date.now() - 10;

    // Receive GRN at higher cost LKR 240.0000 / KG -> 240 / 0.80 = LKR 300.0000
    const grnRes = await app.inject({
      method: 'POST',
      url: '/v1/goods-receipts',
      headers: idemHeaders(ownerToken),
      payload: {
        supplierId,
        branchId: branchAId,
        warehouseId: warehouseAId,
        lines: [
          {
            productId: sugarId,
            receivedUom: 'KG',
            receivedQty: '10.000000',
            unitCost: '240.0000',
          },
        ],
      },
    });
    expect(grnRes.statusCode).toBe(201);

    // Active catalog selling price MUST remain untouched (250.0000) until approved
    const sugarDuringPending = await app.inject({
      method: 'GET',
      url: `/v1/products/${sugarId}`,
      headers: authHeaders(ownerToken),
    });
    expect(sugarDuringPending.json().purchaseCost).toBe('240.0000');
    expect(sugarDuringPending.json().sellingPrice).toBe('250.0000');

    const pendingRes = await app.inject({
      method: 'GET',
      url: `/v1/pricing/suggestions?productId=${sugarId}&status=PENDING`,
      headers: authHeaders(ownerToken),
    });
    expect(pendingRes.statusCode).toBe(200);
    const pendingList = pendingRes.json();
    expect(pendingList.length).toBe(1);
    const grnSugg = pendingList[0];
    expect(grnSugg.sourceEventType).toBe('GRN_POSTED');
    expect(grnSugg.costChangeDirection).toBe('INCREASE');
    expect(grnSugg.suggestedSellingPrice).toBe('300.0000');

    // Approve with explicit override LKR 310.0000 ("Edit & Approve")
    const approveRes = await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${grnSugg.id}/approve`,
      headers: authHeaders(ownerToken),
      payload: {
        overridePrice: '310.0000',
        reviewNotes: 'Approved at rounded shelf price 310',
      },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().status).toBe('MODIFIED_APPROVED');
    expect(approveRes.json().finalApprovedPrice).toBe('310.0000');

    const sugarAfterApprove = await app.inject({
      method: 'GET',
      url: `/v1/products/${sugarId}`,
      headers: authHeaders(ownerToken),
    });
    expect(sugarAfterApprove.json().sellingPrice).toBe('310.0000');

    // Verify PRICE_CHANGED realtime event emitted for POS registers
    const pollRes = await app.inject({
      method: 'GET',
      url: `/v1/realtime/poll?since=${beforePoll}`,
      headers: authHeaders(cashierToken),
    });
    expect(pollRes.statusCode).toBe(200);
    const priceEvents = pollRes
      .json()
      .events.filter((e: { eventType: string }) => e.eventType === 'PRICE_CHANGED');
    expect(priceEvents.length).toBeGreaterThanOrEqual(1);

    // Cost decrease via product cost edit (240 -> 180) generates DECREASE suggestion clamped to min floor 240.0000
    const costEditRes = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${sugarId}`,
      headers: authHeaders(ownerToken),
      payload: {
        purchaseCost: '180.0000',
      },
    });
    expect(costEditRes.statusCode).toBe(200);
    // Selling price STILL preserved at 310.0000
    expect(costEditRes.json().sellingPrice).toBe('310.0000');

    const decreasePendingRes = await app.inject({
      method: 'GET',
      url: `/v1/pricing/suggestions?productId=${sugarId}&status=PENDING`,
      headers: authHeaders(ownerToken),
    });
    const decSugg = decreasePendingRes.json()[0];
    expect(decSugg.sourceEventType).toBe('COST_EDIT');
    expect(decSugg.costChangeDirection).toBe('DECREASE');
    // 180 / 0.80 = 225 -> clamped to minSellingPrice 240.0000
    expect(decSugg.suggestedSellingPrice).toBe('240.0000');

    // Clean up pending decrease suggestion
    await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${decSugg.id}/reject-or-defer`,
      headers: authHeaders(ownerToken),
      payload: { action: 'REJECT', reviewNotes: 'Keep retail price during promotion' },
    });
  });

  it('enforces Mode A vs Mode B branch approval policy, branch isolation, self-approval rules, and needs_review alerts on global edits', async () => {
    // Under Mode A (OWNER_ADMIN_ONLY), Manager A proposes a branch override
    const proposeRes = await app.inject({
      method: 'POST',
      url: '/v1/pricing/suggestions',
      headers: authHeaders(managerAToken),
      payload: {
        productId: sugarId,
        scope: 'BRANCH',
        branchId: branchAId,
        proposedPrice: '280.0000',
        reason: 'Colombo local wholesale competition match',
      },
    });
    expect(proposeRes.statusCode).toBe(201);
    const branchSuggId = proposeRes.json().id;

    // Mode A blocks Branch Manager A from approving even their own branch
    const modeABlocked = await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${branchSuggId}/approve`,
      headers: authHeaders(managerAToken),
      payload: {},
    });
    expect(modeABlocked.statusCode).toBe(403);
    expect(modeABlocked.json().errorCode).toBe('PRICING_APPROVAL_POLICY_FORBIDDEN');

    // Enable Mode B (BRANCH_MANAGER_OWN_BRANCH) with allowSelfApproval = false
    await app.inject({
      method: 'PUT',
      url: '/v1/pricing/settings',
      headers: authHeaders(ownerToken),
      payload: {
        branchApprovalPolicy: 'BRANCH_MANAGER_OWN_BRANCH',
        allowSelfApproval: false,
      },
    });

    // Self-approval blocked for Manager A on their own proposal
    const selfBlocked = await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${branchSuggId}/approve`,
      headers: authHeaders(managerAToken),
      payload: {},
    });
    expect(selfBlocked.statusCode).toBe(403);
    expect(selfBlocked.json().errorCode).toBe('PRICING_SELF_APPROVAL_FORBIDDEN');

    // Manager B blocked from Branch A (cross-branch isolation)
    const crossBranchBlocked = await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${branchSuggId}/approve`,
      headers: authHeaders(managerBToken),
      payload: {},
    });
    expect(crossBranchBlocked.statusCode).toBe(403);

    // Owner approves Branch A override at LKR 263.0000 (cleanly divides by 0.750 KG = 197.25)
    const ownerApproveBranch = await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${branchSuggId}/approve`,
      headers: authHeaders(ownerToken),
      payload: {
        overridePrice: '263.0000',
        reviewNotes: 'Approved Branch A override at 263/KG',
      },
    });
    expect(ownerApproveBranch.statusCode).toBe(200);

    // Global price update -> MUST preserve Branch A override at 263.0000 and set needsReview = true
    const globalEditRes = await app.inject({
      method: 'PATCH',
      url: `/v1/products/${sugarId}`,
      headers: authHeaders(ownerToken),
      payload: {
        sellingPrice: '320.0000',
      },
    });
    expect(globalEditRes.statusCode).toBe(200);

    const overridesRes = await app.inject({
      method: 'GET',
      url: `/v1/pricing/branch-overrides?branchId=${branchAId}&needsReviewOnly=true`,
      headers: authHeaders(ownerToken),
    });
    expect(overridesRes.statusCode).toBe(200);
    const flagged = overridesRes.json();
    expect(flagged.length).toBe(1);
    expect(flagged[0].sellingPrice).toBe('263.0000');
    expect(flagged[0].globalSellingPrice).toBe('320.0000');
    expect(flagged[0].needsReview).toBe(true);

    // Manager A acknowledges the review alert under Mode B
    const ackRes = await app.inject({
      method: 'POST',
      url: `/v1/pricing/branch-overrides/${flagged[0].id}/acknowledge`,
      headers: authHeaders(managerAToken),
      payload: {},
    });
    expect(ackRes.statusCode).toBe(200);
    expect(ackRes.json().needsReview).toBe(false);
    expect(ackRes.json().sellingPrice).toBe('263.0000');
  });

  it('resolves Branch Override prices on POS, enforces max discount & min price floor, and preserves historical invoice prices', async () => {
    // Warehouse A POS search -> Branch override 263.0000
    const searchARes = await app.inject({
      method: 'GET',
      url: `/v1/pos/products/search?warehouseId=${warehouseAId}&q=SUGAR`,
      headers: authHeaders(cashierToken),
    });
    expect(searchARes.statusCode).toBe(200);
    const itemA = searchARes.json().find((p: { id: string }) => p.id === sugarId);
    expect(itemA.retailPrice).toBe('263.0000');
    expect(itemA.globalRetailPrice).toBe('320.0000');
    expect(itemA.priceSource).toBe('BRANCH_OVERRIDE');

    // Warehouse B POS search -> Global default 320.0000
    const searchBRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/products/search?warehouseId=${warehouseBId}&q=SUGAR`,
      headers: authHeaders(cashierToken),
    });
    expect(searchBRes.statusCode).toBe(200);
    const itemB = searchBRes.json().find((p: { id: string }) => p.id === sugarId);
    expect(itemB.retailPrice).toBe('320.0000');
    expect(itemB.priceSource).toBe('GLOBAL');

    // Attempt POS discount exceeding 10% max_discount_pct (30.00 on 197.25 = 15.21%)
    const badDiscountRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: idemHeaders(cashierToken),
      payload: {
        registerId: registerAId,
        shiftId: shiftAId,
        lines: [
          {
            productId: sugarId,
            quantity: '750.000000',
            uomCode: 'G',
            entrySource: 'SCALE_WEIGHT',
            discountAmount: '30.0000',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '167.2500',
            tenderedAmount: '200.0000',
          },
        ],
      },
    });
    expect(badDiscountRes.statusCode).toBe(422);
    expect(badDiscountRes.json().errorCode).toBe('PRICING_MAX_DISCOUNT_EXCEEDED');

    // Attempt discount within 10% (19.00 on 197.25 -> net 178.25) that violates minSellingPrice floor (240 * 0.75 = 180.00)
    const floorViolationRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: idemHeaders(cashierToken),
      payload: {
        registerId: registerAId,
        shiftId: shiftAId,
        lines: [
          {
            productId: sugarId,
            quantity: '750.000000',
            uomCode: 'G',
            entrySource: 'SCALE_WEIGHT',
            discountAmount: '19.0000',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '178.2500',
            tenderedAmount: '200.0000',
          },
        ],
      },
    });
    expect(floorViolationRes.statusCode).toBe(422);
    expect(floorViolationRes.json().errorCode).toBe('PRICING_MIN_PRICE_VIOLATION');

    // Valid Branch A checkout: 750 G @ LKR 263.0000/KG = 197.2500
    const saleRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: idemHeaders(cashierToken),
      payload: {
        registerId: registerAId,
        shiftId: shiftAId,
        lines: [
          {
            productId: sugarId,
            quantity: '750.000000',
            uomCode: 'G',
            entrySource: 'SCALE_WEIGHT',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '197.2500',
            tenderedAmount: '200.0000',
          },
        ],
      },
    });
    expect(saleRes.statusCode).toBe(201);
    const invoice = saleRes.json();
    expect(invoice.grandTotal).toBe('197.2500');
    expect(invoice.lines[0].pricePerPriceUom).toBe('263.0000');

    // Subsequent branch price change must NOT alter historical invoice snapshot
    const newBranchProposal = await app.inject({
      method: 'POST',
      url: '/v1/pricing/suggestions',
      headers: authHeaders(ownerToken),
      payload: {
        productId: sugarId,
        scope: 'BRANCH',
        branchId: branchAId,
        proposedPrice: '350.0000',
        reason: 'Post-sale seasonal increase',
      },
    });
    expect(newBranchProposal.statusCode).toBe(201);

    await app.inject({
      method: 'PUT',
      url: '/v1/pricing/settings',
      headers: authHeaders(ownerToken),
      payload: { allowSelfApproval: true },
    });

    const approveNewBranch = await app.inject({
      method: 'POST',
      url: `/v1/pricing/suggestions/${newBranchProposal.json().id}/approve`,
      headers: authHeaders(ownerToken),
      payload: {},
    });
    expect(approveNewBranch.statusCode).toBe(200);

    const historicalInvoiceRes = await app.inject({
      method: 'GET',
      url: `/v1/pos/sales/${invoice.id}`,
      headers: authHeaders(cashierToken),
    });
    expect(historicalInvoiceRes.statusCode).toBe(200);
    expect(historicalInvoiceRes.json().grandTotal).toBe('197.2500');
    expect(historicalInvoiceRes.json().lines[0].pricePerPriceUom).toBe('263.0000');
  });

  it('serves pricing dashboard margin health, immutable price history, offline catalog snapshot, and blocks offline approvals & unauthorized roles', async () => {
    // Cashier cannot read pricing management dashboard
    const cashierDashRes = await app.inject({
      method: 'GET',
      url: '/v1/pricing/dashboard',
      headers: authHeaders(cashierToken),
    });
    expect(cashierDashRes.statusCode).toBe(403);

    // Owner dashboard shows low/zero/negative margin alerts on LOSS-SKU-01
    const dashRes = await app.inject({
      method: 'GET',
      url: '/v1/pricing/dashboard',
      headers: authHeaders(ownerToken),
    });
    expect(dashRes.statusCode).toBe(200);
    const dash = dashRes.json();
    expect(dash.kpis.zeroOrNegativeMarginCount).toBeGreaterThanOrEqual(1);
    const lossRow = dash.lowMarginProducts.find((r: { productId: string }) => r.productId === lowMarginId);
    expect(lossRow).toBeTruthy();
    expect(lossRow.isZeroOrNegativeMargin).toBe(true);

    // Price history contains immutable chronological records
    const histRes = await app.inject({
      method: 'GET',
      url: `/v1/pricing/history?productId=${sugarId}`,
      headers: authHeaders(ownerToken),
    });
    expect(histRes.statusCode).toBe(200);
    const history = histRes.json();
    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history[0].newPrice).toBe('350.0000');

    // Offline POS catalog pricing sync exposes active global + branch prices
    const syncPricingRes = await app.inject({
      method: 'GET',
      url: `/v1/sync/catalog-pricing?branchId=${branchAId}`,
      headers: authHeaders(cashierToken),
    });
    expect(syncPricingRes.statusCode).toBe(200);
    expect(syncPricingRes.json().branchOverrides.length).toBe(1);
    expect(syncPricingRes.json().branchOverrides[0].sellingPrice).toBe('350.0000');

    // Offline push attempting price approval is strictly quarantined
    const offlineDeviceId = randomUUID();
    const offlineApproveAttempt = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: {
        'x-tenant-id': TENANT_ID,
        'x-user-id': MANAGER_A_USER_ID,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: offlineDeviceId,
        branchId: branchAId,
        commands: [
          {
            localSeq: 1,
            commandId: randomUUID(),
            tenantId: TENANT_ID,
            branchId: branchAId,
            deviceId: offlineDeviceId,
            actorUserId: MANAGER_A_USER_ID,
            commandType: 'POS_RECORD_SALE',
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: { action: 'APPROVE_PRICE', sellingPrice: '10.0000' },
          },
        ],
      },
    });
    expect(offlineApproveAttempt.statusCode).toBe(200);
    expect(offlineApproveAttempt.json().receipts[0].status).toBe('QUARANTINED');
    expect(offlineApproveAttempt.json().receipts[0].conflictCode).toBe(
      'PRICING_OFFLINE_APPROVAL_FORBIDDEN',
    );
  });
});
