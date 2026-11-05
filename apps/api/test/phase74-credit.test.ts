import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  DEFAULT_SUPABASE_JWT_AUDIENCE,
  DEFAULT_SUPABASE_JWT_ISSUER,
  StaticJwksProvider,
  type SupabaseJwk,
  buildApp,
  generateUuidV7,
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

describe('@nexstock/api — Phase 7.4: Customer Credit Management (Subphases 7.4.1 – 7.4.8)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ALPHA_ID = '0192d000-0000-7000-8000-000000000001';
  const OWNER_USER_ID = '0192d000-0000-7000-8000-000000000002';
  const ACCOUNTANT_USER_ID = '0192d000-0000-7000-8000-000000000003';
  const CASHIER_USER_ID = '0192d000-0000-7000-8000-000000000004';
  const STAFF_USER_ID = '0192d000-0000-7000-8000-000000000005';

  const TENANT_BETA_ID = '0192d000-0000-7000-8000-000000000010';
  const BETA_OWNER_ID = '0192d000-0000-7000-8000-000000000011';

  const primaryKey = createTestEs256KeyMaterial('test-key-phase74');
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
  let accountantToken: string;
  let cashierToken: string;
  let staffToken: string;
  let betaOwnerToken: string;
  let alphaBranchId: string;
  let posRegisterId: string;
  let posShiftId: string;
  let trackableProductId: string;

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    ownerToken = issueToken(OWNER_USER_ID, 'owner@alpha-credit.example.com');
    accountantToken = issueToken(ACCOUNTANT_USER_ID, 'accountant@alpha-credit.example.com');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@alpha-credit.example.com');
    staffToken = issueToken(STAFF_USER_ID, 'staff@alpha-credit.example.com');
    betaOwnerToken = issueToken(BETA_OWNER_ID, 'owner@beta-credit.example.com');

    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    // 1. Onboard Tenant Alpha (LKR base currency for credit management)
    const alphaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        slug: 'alpha-credit',
        legalName: 'Alpha Credit Enterprise (Pvt) Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@alpha-credit.example.com',
        ownerFullName: 'Alpha Owner',
        planCode: 'GROWTH',
      },
    });
    expect(alphaOnboardRes.statusCode).toBe(201);

    // Create branch for Alpha
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        code: 'BR-COL-01',
        name: 'Colombo Central Outlet',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    alphaBranchId = branchRes.json().id;

    // 2. Onboard Tenant Beta for cross-tenant testing
    const betaOnboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
      payload: {
        slug: 'beta-credit',
        legalName: 'Beta Credit Corp',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@beta-credit.example.com',
        ownerFullName: 'Beta Owner',
        planCode: 'GROWTH',
      },
    });
    expect(betaOnboardRes.statusCode).toBe(201);

    // 3. Provision Member Roles for Tenant Alpha
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ALPHA_ID, userId: OWNER_USER_ID, traceId: 'init_members' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: ACCOUNTANT_USER_ID,
          email: 'accountant@alpha-credit.example.com',
          fullName: 'Alpha Head Accountant',
          roleCodes: ['ACCOUNTANT'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@alpha-credit.example.com',
          fullName: 'Alpha POS Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
        await provisionTenantMember(trx, {
          userId: STAFF_USER_ID,
          email: 'staff@alpha-credit.example.com',
          fullName: 'Alpha Basic Staff',
          roleCodes: ['STAFF'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
      },
    );

    // 4. Setup Warehouse, POS register, shift, and product for credit sales
    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        branchId: alphaBranchId,
        code: 'WH-COL-01',
        name: 'Colombo Central Warehouse',
        allowNegativeStock: true,
      },
    });
    expect(whRes.statusCode).toBe(201);
    const alphaWarehouseId = whRes.json().id;

    posRegisterId = generateUuidV7();
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ALPHA_ID, userId: OWNER_USER_ID, traceId: 'seed_reg' },
      async (trx) => {
        await trx.db
          .insertInto('pos_registers')
          .values({
            id: posRegisterId,
            tenant_id: TENANT_ALPHA_ID,
            branch_id: alphaBranchId,
            warehouse_id: alphaWarehouseId,
            code: 'REG-01',
            name: 'Front Register 1',
            last_invoice_seq: 0,
            is_active: true,
          })
          .execute();
      },
    );

    // Open shift
    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        registerId: posRegisterId,
        openingCashFloat: '5000.0000',
      },
    });
    expect(shiftRes.statusCode).toBe(201);
    posShiftId = shiftRes.json().id;

    // Create a product
    const prodRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        sku: 'SKU-CREDIT-TEST',
        name: 'Bulk Industrial Cable 50m',
        baseUom: 'PCS',
        sellingPrice: '10000.0000',
        purchaseCost: '6000.0000',
        trackInventory: false,
      },
    });
    expect(prodRes.statusCode).toBe(201);
    trackableProductId = prodRes.json().id;
  });

  // ============================================================================
  // Subphase 7.4.2: Customer Registry & Master Data
  // ============================================================================
  let customerAlpha1Id: string;
  let customerAlpha2Id: string;

  it('7.4.2: creates customer record with sequential CUST-XXXXX numbering', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        name: 'Sunil Construction (Pvt) Ltd',
        email: 'accounts@sunilconst.lk',
        phone: '+94 11 234 5678',
        address: 'No 100, Kandy Road, Kelaniya 11600',
        taxId: 'TIN-987654321',
        notes: 'Preferred commercial contractor',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.customerNumber).toMatch(/^CUST-\d{5}$/);
    expect(body.name).toBe('Sunil Construction (Pvt) Ltd');
    expect(body.email).toBe('accounts@sunilconst.lk');
    expect(body.status).toBe('ACTIVE');
    customerAlpha1Id = body.id;

    // Create second customer
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        name: 'Lanka Logistics Hub',
        email: 'billing@lankalogistics.lk',
        phone: '+94 77 999 8888',
      },
    });
    expect(res2.statusCode).toBe(201);
    customerAlpha2Id = res2.json().id;
  });

  it('7.4.2: lists customers with search and filters, and gets customer by ID', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/customers?search=Sunil',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(listBody.items.length).toBe(1);
    expect(listBody.items[0].id).toBe(customerAlpha1Id);

    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/customers/${customerAlpha1Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().name).toBe('Sunil Construction (Pvt) Ltd');
  });

  it('7.4.2: updates customer details via PATCH', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerAlpha1Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        phone: '+94 11 234 9999',
        address: 'No 100, Kandy Road, Peliyagoda 11600',
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const updated = patchRes.json();
    expect(updated.phone).toBe('+94 11 234 9999');
    expect(updated.address).toBe('No 100, Kandy Road, Peliyagoda 11600');
  });

  // ============================================================================
  // Subphase 7.4.2: Customer Credit Accounts & Limits
  // ============================================================================
  let account1Id: string;
  let account2Id: string;

  it('7.4.2: opens credit account with initial limit and audit history', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credit/accounts',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        customerId: customerAlpha1Id,
        creditLimit: '100000.0000',
        creditTerms: 'NET_30',
        branchId: alphaBranchId,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.accountNumber).toMatch(/^CCA-\d{6}-\d{5}$/);
    expect(body.creditLimit).toBe('100000.0000');
    expect(body.availableCredit).toBe('100000.0000');
    expect(body.currentBalance).toBe('0.0000');
    expect(body.status).toBe('ACTIVE');
    expect(body.riskClassification).toBe('LOW_RISK');
    account1Id = body.id;

    // Verify limit history was recorded
    const historyRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account1Id}/limits/history`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json();
    expect(history.length).toBe(1);
    expect(history[0].changeType).toBe('INITIAL');
    expect(history[0].newLimit).toBe('100000.0000');
  });

  it('7.4.2: prevents opening duplicate credit account for same customer (409 Conflict)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credit/accounts',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        customerId: customerAlpha1Id,
        creditLimit: '50000.0000',
        creditTerms: 'NET_14',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('CREDIT_ACCOUNT_ALREADY_EXISTS');
  });

  it('7.4.2: opens second credit account with opening balance and custom terms', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credit/accounts',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        customerId: customerAlpha2Id,
        creditLimit: '50000.0000',
        creditTerms: 'CUSTOM',
        customTermDays: 45,
        openingBalance: '15000.0000',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.creditLimit).toBe('50000.0000');
    expect(body.currentBalance).toBe('15000.0000');
    expect(body.availableCredit).toBe('35000.0000');
    account2Id = body.id;

    // Check opening balance ledger entry was created
    const txRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/transactions?accountId=${account2Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(txRes.statusCode).toBe(200);
    const txs = txRes.json().items;
    expect(txs.length).toBe(1);
    expect(txs[0].transactionType).toBe('OPENING_BALANCE');
    expect(txs[0].amount).toBe('15000.0000');
    expect(txs[0].balanceAfter).toBe('15000.0000');
  });

  it('7.4.2: adjusts credit limit and logs audit trail', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/credit/accounts/${account1Id}/limits`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        newLimit: '150000.0000',
        changeType: 'INCREASE',
        reason: 'Customer credit score upgraded after audit',
      },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.creditLimit).toBe('150000.0000');
    expect(updated.availableCredit).toBe('150000.0000');

    // Verify limit history contains 2 entries
    const hist = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account1Id}/limits/history`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(hist.json().length).toBe(2);
    expect(hist.json()[0].changeType).toBe('INCREASE');
  });

  // ============================================================================
  // Subphase 7.4.3: POS Credit Sales & Checkout Integration
  // ============================================================================
  let creditSaleInvoiceId: string;

  it('7.4.3: rejects POS credit sale if customerId is missing (400 Bad Request)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId: posRegisterId,
        shiftId: posShiftId,
        lines: [{ productId: trackableProductId, quantity: '1.0000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CREDIT', amount: '10000.0000', tenderedAmount: '10000.0000' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('CREDIT_CUSTOMER_REQUIRED_FOR_CREDIT_SALE');
  });

  it('7.4.3: processes POS sale charged on customer credit account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId: posRegisterId,
        shiftId: posShiftId,
        customerId: customerAlpha1Id,
        customerName: 'Sunil Construction (Pvt) Ltd',
        lines: [{ productId: trackableProductId, quantity: '2.0000', uomCode: 'PCS' }],
        payments: [{ paymentMethod: 'CREDIT', amount: '20000.0000', tenderedAmount: '20000.0000' }],
      },
    });

    expect(res.statusCode).toBe(201);
    const sale = res.json();
    expect(sale.id).toBeDefined();
    expect(sale.invoiceNumber).toBeDefined();
    creditSaleInvoiceId = sale.id;

    // Verify account balance updated
    const accRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account1Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    const acc = accRes.json();
    expect(acc.currentBalance).toBe('20000.0000');
    expect(acc.availableCredit).toBe('130000.0000');
    expect(acc.totalCreditSales).toBe('20000.0000');

    // Verify ledger transaction was posted
    const txRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/transactions?accountId=${account1Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    const txs = txRes.json().items;
    expect(txs.length).toBe(1);
    expect(txs[0].transactionType).toBe('CREDIT_SALE');
    expect(txs[0].amount).toBe('20000.0000');
    expect(txs[0].balanceAfter).toBe('20000.0000');
    expect(txs[0].sourceReferenceId).toBe(creditSaleInvoiceId);
  });

  it('7.4.3: supports split payment sale (e.g. Cash 5,000 + Credit 15,000)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId: posRegisterId,
        shiftId: posShiftId,
        customerId: customerAlpha1Id,
        lines: [{ productId: trackableProductId, quantity: '2.0000', uomCode: 'PCS' }],
        payments: [
          { paymentMethod: 'CASH', amount: '5000.0000', tenderedAmount: '5000.0000' },
          { paymentMethod: 'CREDIT', amount: '15000.0000', tenderedAmount: '15000.0000' },
        ],
      },
    });

    expect(res.statusCode).toBe(201);

    // Verify balance increased by only the credit portion (15,000)
    const accRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account1Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    const acc = accRes.json();
    expect(acc.currentBalance).toBe('35000.0000'); // 20k + 15k
    expect(acc.availableCredit).toBe('115000.0000');
  });

  it('7.4.3: rejects POS credit sale exceeding available credit limit (409 Conflict)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pos/sales',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
        'idempotency-key': generateUuidV7(),
      },
      payload: {
        registerId: posRegisterId,
        shiftId: posShiftId,
        customerId: customerAlpha1Id,
        lines: [{ productId: trackableProductId, quantity: '15.0000', uomCode: 'PCS' }], // 15 * 10,000 = 150,000 > available 115,000
        payments: [{ paymentMethod: 'CREDIT', amount: '150000.0000', tenderedAmount: '150000.0000' }],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().errorCode).toBe('CREDIT_LIMIT_EXCEEDED');
  });

  // ============================================================================
  // Subphase 7.4.3: Manual Credit & Debit Ledger Transactions
  // ============================================================================
  it('7.4.3: posts manual debit note and manual credit note to ledger', async () => {
    // Manual debit note for extra freight charges (5,000 LKR)
    const debitRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/transactions',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        accountId: account1Id,
        transactionType: 'DEBIT_NOTE',
        amount: '5000.0000',
        description: 'Undercharged freight delivery charge',
      },
    });
    expect(debitRes.statusCode).toBe(201);
    expect(debitRes.json().balanceAfter).toBe('40000.0000'); // 35k + 5k

    // Manual credit note for discount concession (2,000 LKR)
    const creditRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/transactions',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        accountId: account1Id,
        transactionType: 'CREDIT_NOTE',
        amount: '2000.0000',
        description: 'Commercial concession credit',
      },
    });
    expect(creditRes.statusCode).toBe(201);
    expect(creditRes.json().balanceAfter).toBe('38000.0000'); // 40k - 2k
  });

  // ============================================================================
  // Subphase 7.4.4: Payments, Allocations & Reversals
  // ============================================================================
  let payment1Id: string;

  it('7.4.4: records customer payment with FIFO invoice allocation and unallocated advance', async () => {
    // Current debt is 38,000. Pay 45,000 (38,000 settles debt, 7,000 advance unallocated)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credit/payments',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        accountId: account1Id,
        paymentDate: new Date().toISOString().slice(0, 10),
        paymentMethod: 'BANK_TRANSFER',
        amount: '45000.0000',
        externalReference: 'SLT-FT-889900',
        notes: 'Direct transfer to Commercial Bank',
      },
    });

    expect(res.statusCode).toBe(201);
    const pay = res.json();
    expect(pay.id).toBeDefined();
    expect(pay.paymentReference).toMatch(/^CPAY-/);
    expect(pay.amount).toBe('45000.0000');
    expect(pay.allocatedAmount).toBe('38000.0000');
    expect(pay.unallocatedAmount).toBe('7000.0000');
    expect(pay.status).toBe('COMPLETED');
    payment1Id = pay.id;

    // Verify account balance: currentBalance is 0, unallocatedPaymentBalance is 7,000
    const accRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account1Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    const acc = accRes.json();
    expect(acc.currentBalance).toBe('0.0000');
    expect(acc.unallocatedPaymentBalance).toBe('7000.0000');
    expect(acc.availableCredit).toBe('150000.0000');
  });

  it('7.4.4: retrieves official printable payment receipt', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/credit/payments/${payment1Id}/receipt`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(res.statusCode).toBe(200);
    const receipt = res.json();
    expect(receipt.receiptNumber).toMatch(/^RCP-/);
    expect(receipt.amount).toBe('45000.0000');
    expect(receipt.customerName).toBe('Sunil Construction (Pvt) Ltd');
  });

  it('7.4.4: reverses customer payment and restores balances atomically', async () => {
    const revRes = await app.inject({
      method: 'POST',
      url: `/v1/credit/payments/${payment1Id}/reverse`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        reason: 'Cheque bounced / transfer cancelled by originating bank',
      },
    });

    expect(revRes.statusCode).toBe(200);
    const rev = revRes.json();
    expect(rev.status).toBe('REVERSED');
    expect(rev.unallocatedAmount).toBe('0.0000');

    // Balance should be restored to 38,000, unallocated advance to 0
    const accRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account1Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    const acc = accRes.json();
    expect(acc.currentBalance).toBe('38000.0000');
    expect(acc.unallocatedPaymentBalance).toBe('0.0000');

    // Attempting second reversal fails (409 Conflict)
    const secondRev = await app.inject({
      method: 'POST',
      url: `/v1/credit/payments/${payment1Id}/reverse`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: { reason: 'Duplicate reversal attempt' },
    });
    expect(secondRev.statusCode).toBe(409);
    expect(secondRev.json().errorCode).toBe('CREDIT_PAYMENT_ALREADY_REVERSED');
  });

  // ============================================================================
  // Subphase 7.4.5: Interest & Late Fee Engine
  // ============================================================================
  it('7.4.5: interest and late fees are disabled by default and rejected if triggered', async () => {
    // Attempting interest accrual when disabled -> 400
    const intRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/interest/accrue',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: { accountId: account1Id },
    });
    expect(intRes.statusCode).toBe(400);
    expect(intRes.json().errorCode).toBe('CREDIT_INTEREST_DISABLED');

    // Attempting late fee when disabled -> 400
    const feeRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/late-fees/apply',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: { accountId: account1Id },
    });
    expect(feeRes.statusCode).toBe(400);
    expect(feeRes.json().errorCode).toBe('CREDIT_LATE_FEE_DISABLED');
  });

  it('7.4.5: enables interest & late fees in organization credit settings', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/v1/credit/settings',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        interestEnabled: true,
        interestRatePercentage: '18.0000', // 18% p.a.
        interestGracePeriodDays: 0,
        lateFeeEnabled: true,
        lateFeeType: 'FIXED',
        lateFeeAmount: '1500.0000',
        lateFeeGracePeriodDays: 0,
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const settings = patchRes.json();
    expect(settings.interestEnabled).toBe(true);
    expect(settings.interestRatePercentage).toBe('18.0000');
    expect(settings.lateFeeEnabled).toBe(true);
    expect(settings.lateFeeAmount).toBe('1500.0000');
  });

  let feeEntryId: string;

  it('7.4.5: applies late fee and accrues interest when enabled', async () => {
    // Apply late fee with asOfDate in future so transactions are overdue
    const feeRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/late-fees/apply',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: { accountId: account1Id, asOfDate: '2026-12-31' },
    });
    expect(feeRes.statusCode).toBe(200);
    const feeResult = feeRes.json();
    expect(feeResult.processedCount).toBeGreaterThanOrEqual(1);
    expect(parseFloat(feeResult.totalLateFeesApplied)).toBeGreaterThan(0);

    // Get the late fee entry id from database
    const feeRow = await harness.db
      .selectFrom('customer_credit_late_fee_entries')
      .select(['id'])
      .where('tenant_id', '=', TENANT_ALPHA_ID)
      .where('account_id', '=', account1Id)
      .executeTakeFirst();
    expect(feeRow).toBeDefined();
    feeEntryId = feeRow!.id;

    // Check account balance increased
    const accRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account1Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(parseFloat(accRes.json().currentBalance)).toBeGreaterThan(38000);
  });

  it('7.4.5: waives late fee and credits customer account', async () => {
    const waiveRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/waivers',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        entryId: feeEntryId,
        feeType: 'LATE_FEE',
        reason: 'Customer negotiated fee waiver on prompt settlement agreement',
      },
    });
    expect(waiveRes.statusCode).toBe(200);
    expect(waiveRes.json().success).toBe(true);
    expect(waiveRes.json().waivedAmount).toBe('1500.0000');
  });

  // ============================================================================
  // Subphase 7.4.6: Collections & Bad Debt Write-Offs
  // ============================================================================
  it('7.4.6: logs collection follow-up and promise to pay', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credit/collections',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        accountId: account1Id,
        followUpDate: new Date().toISOString().slice(0, 10),
        contactMethod: 'PHONE',
        notes: 'Spoke with CFO Mr. Perera. Promised full settlement by end of month.',
        promiseToPayDate: '2026-11-30',
        promiseAmount: '38000.0000',
        outcome: 'PROMISED_TO_PAY',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.contactMethod).toBe('PHONE');
    expect(body.promiseAmount).toBe('38000.0000');
    expect(body.outcome).toBe('PROMISED_TO_PAY');

    // Retrieve collections log
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account1Id}/collections`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().length).toBe(1);
  });

  it('7.4.6: approves bad debt write-off for uncollectible balance', async () => {
    // On account 2 (balance is 15,000), write off 5,000
    const woffRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/writeoffs',
      headers: {
        authorization: `Bearer ${ownerToken}`, // Owner / Manager permission
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        accountId: account2Id,
        writeoffAmount: '5000.0000',
        reason: 'DISPUTE',
        supportingNotes: 'Settled commercial damaged goods dispute by writing off 5,000 LKR',
      },
    });

    expect(woffRes.statusCode).toBe(200);
    const woff = woffRes.json();
    expect(woff.success).toBe(true);
    expect(woff.writeoffAmount).toBe('5000.0000');
    expect(woff.remainingBalance).toBe('10000.0000');

    // Account 2 balance should now be 10,000
    const acc2 = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account2Id}`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(acc2.json().currentBalance).toBe('10000.0000');
    expect(acc2.json().totalWrittenOff).toBe('5000.0000');
  });

  it('7.4.6: rejects write-off exceeding current balance (400 Bad Request)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credit/writeoffs',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        accountId: account2Id,
        writeoffAmount: '20000.0000', // exceeds balance of 10,000
        reason: 'BAD_DEBT',
        supportingNotes: 'Excessive write-off',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('CREDIT_WRITEOFF_EXCEEDS_BALANCE');
  });

  // ============================================================================
  // Subphase 7.4.7: Reports, Statements & Dashboard Analytics
  // ============================================================================
  it('7.4.7: compiles receivables aging analysis report in LKR', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/credit/reports/aging',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(res.statusCode).toBe(200);
    const aging = res.json();
    expect(aging.asOfDate).toBeDefined();
    expect(aging.summary).toBeDefined();
    expect(parseFloat(aging.summary.totalOutstanding)).toBeGreaterThan(0);
    expect(aging.customers.length).toBeGreaterThanOrEqual(2);
  });

  it('7.4.7: compiles customer statement with opening, debits, credits, and closing balance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/credit/reports/statement/${customerAlpha1Id}?startDate=2026-01-01&endDate=2026-12-31`,
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(res.statusCode).toBe(200);
    const stmt = res.json();
    expect(stmt.customerName).toBe('Sunil Construction (Pvt) Ltd');
    expect(parseFloat(stmt.closingBalance)).toBeGreaterThan(0);
    expect(stmt.transactions.length).toBeGreaterThan(0);
  });

  it('7.4.7: compiles credit dashboard KPIs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/credit/reports/dashboard',
      headers: {
        authorization: `Bearer ${accountantToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(res.statusCode).toBe(200);
    const dash = res.json();
    expect(parseFloat(dash.totalOutstanding)).toBeGreaterThan(0);
    expect(parseFloat(dash.totalAvailableCredit)).toBeGreaterThan(0);
    expect(dash.activeCreditCustomers).toBe(2);
  });

  // ============================================================================
  // Subphase 7.4.7 & 7.4.8: RBAC Permissions & Security Separation of Duties
  // ============================================================================
  it('7.4.7: blocks STAFF role from accessing credit endpoints (403 Forbidden)', async () => {
    // Attempt to view credit accounts as STAFF
    const res = await app.inject({
      method: 'GET',
      url: '/v1/credit/accounts',
      headers: {
        authorization: `Bearer ${staffToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe('IAM_PERMISSION_DENIED');

    // Attempt to write off debt as STAFF
    const woffRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/writeoffs',
      headers: {
        authorization: `Bearer ${staffToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        accountId: account1Id,
        writeoffAmount: '100.0000',
        reason: 'BAD_DEBT',
        supportingNotes: 'Unauthorized attempt',
      },
    });
    expect(woffRes.statusCode).toBe(403);
    expect(woffRes.json().errorCode).toBe('IAM_PERMISSION_DENIED');
  });

  it('7.4.7: CASHIER role can process POS checkout but cannot approve write-offs or adjust limits (403 Forbidden)', async () => {
    const woffRes = await app.inject({
      method: 'POST',
      url: '/v1/credit/writeoffs',
      headers: {
        authorization: `Bearer ${cashierToken}`,
        'x-tenant-id': TENANT_ALPHA_ID,
      },
      payload: {
        accountId: account1Id,
        writeoffAmount: '100.0000',
        reason: 'BAD_DEBT',
        supportingNotes: 'Cashier unauthorized write-off',
      },
    });
    expect(woffRes.statusCode).toBe(403);
    expect(woffRes.json().errorCode).toBe('IAM_PERMISSION_DENIED');
  });

  // ============================================================================
  // Subphase 7.4.8: Cross-Tenant RLS Security Isolation
  // ============================================================================
  it('7.4.8: enforces Row Level Security (RLS) — Tenant Beta cannot view or modify Tenant Alpha customer accounts', async () => {
    // Beta owner queries Alpha accounts
    const betaList = await app.inject({
      method: 'GET',
      url: '/v1/credit/accounts',
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
    });
    expect(betaList.statusCode).toBe(200);
    expect(betaList.json().items.length).toBe(0); // Zero visibility of Alpha accounts

    // Beta owner attempts to directly fetch Alpha account by ID -> 404 Not Found (RLS isolation)
    const directGet = await app.inject({
      method: 'GET',
      url: `/v1/credit/accounts/${account1Id}`,
      headers: {
        authorization: `Bearer ${betaOwnerToken}`,
        'x-tenant-id': TENANT_BETA_ID,
      },
    });
    expect(directGet.statusCode).toBe(404);
  });
});
