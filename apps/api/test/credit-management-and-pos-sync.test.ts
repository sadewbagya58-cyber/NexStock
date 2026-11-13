import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

describe('@nexstock/api — Customer Credit Management, POS Real-Time Sync & Cashier Policy (BUG-069, BUG-070, BUG-071, BUG-081)', () => {
  let harness: TestPostgresHarness;
  let app: AppInstance;

  const TENANT_ID = '0192e000-0000-7000-8000-000000000001';
  const OWNER_USER_ID = '0192e000-0000-7000-8000-000000000002';
  const CASHIER_USER_ID = '0192e000-0000-7000-8000-000000000003';
  const MANAGER_USER_ID = '0192e000-0000-7000-8000-000000000004';

  const primaryKey = createTestEs256KeyMaterial('test-key-sync-remediation');
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
  let cashierToken: string;
  let managerToken: string;

  let branchId: string;
  let warehouseId: string;
  let registerId: string;
  let shiftId: string;
  let testProductId: string;

  let customer1Id: string;
  let customer2Id: string;
  let customer1CreditAccountId: string;

  const authHeaders = (token: string, extra?: Record<string, string>) => ({
    authorization: `Bearer ${token}`,
    'x-tenant-id': TENANT_ID,
    'content-type': 'application/json',
    ...extra,
  });

  beforeAll(async () => {
    harness = await createTestPostgresHarness();

    ownerToken = issueToken(OWNER_USER_ID, 'owner@sync-test.com');
    cashierToken = issueToken(CASHIER_USER_ID, 'cashier@sync-test.com');
    managerToken = issueToken(MANAGER_USER_ID, 'manager@sync-test.com');

    app = await buildApp({
      db: harness.db,
      jwksProvider,
    });

    // 1. Onboard Tenant
    const onboardRes = await app.inject({
      method: 'POST',
      url: '/v1/org/tenants/onboard',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'x-tenant-id': TENANT_ID,
      },
      payload: {
        slug: 'sync-remediation-retail',
        legalName: 'Sync Remediation Retail Ltd',
        baseCurrency: 'LKR',
        defaultLocale: 'en-US',
        defaultTimezone: 'Asia/Colombo',
        countryCode: 'LK',
        ownerEmail: 'owner@sync-test.com',
        ownerFullName: 'Sync Owner',
        planCode: 'GROWTH',
      },
    });
    expect(onboardRes.statusCode).toBe(201);

    // Create branch
    const branchRes = await app.inject({
      method: 'POST',
      url: '/v1/org/branches',
      headers: authHeaders(ownerToken),
      payload: {
        code: 'BR-MAIN',
        name: 'Main Store Outlet',
        timezone: 'Asia/Colombo',
        countryCode: 'LK',
      },
    });
    expect(branchRes.statusCode).toBe(201);
    branchId = branchRes.json().id;

    // 2. Provision CASHIER and BRANCH_MANAGER
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'init_members' },
      async (trx) => {
        await provisionTenantMember(trx, {
          userId: CASHIER_USER_ID,
          email: 'cashier@sync-test.com',
          fullName: 'Main Cashier',
          roleCodes: ['CASHIER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
        await provisionTenantMember(trx, {
          userId: MANAGER_USER_ID,
          email: 'manager@sync-test.com',
          fullName: 'Branch Manager',
          roleCodes: ['BRANCH_MANAGER'],
          allLocationsAccess: true,
          status: 'ACTIVE',
        });
      },
    );

    // 3. Setup Warehouse & Register
    const whRes = await app.inject({
      method: 'POST',
      url: '/v1/org/warehouses',
      headers: authHeaders(ownerToken),
      payload: {
        branchId,
        code: 'WH-MAIN',
        name: 'Main Storage',
        allowNegativeStock: true,
      },
    });
    expect(whRes.statusCode).toBe(201);
    warehouseId = whRes.json().id;

    registerId = generateUuidV7();
    await withTenantTransaction(
      harness.db,
      { tenantId: TENANT_ID, userId: OWNER_USER_ID, traceId: 'seed_reg' },
      async (trx) => {
        await trx.db
          .insertInto('pos_registers')
          .values({
            id: registerId,
            tenant_id: TENANT_ID,
            branch_id: branchId,
            warehouse_id: warehouseId,
            code: 'REG-01',
            name: 'Front Register 1',
            last_invoice_seq: 0,
            is_active: true,
          })
          .execute();
      },
    );

    // 4. Open Shift
    const shiftRes = await app.inject({
      method: 'POST',
      url: '/v1/pos/shifts',
      headers: authHeaders(cashierToken),
      payload: {
        registerId,
        openingCashFloat: '5000.0000',
      },
    });
    expect(shiftRes.statusCode).toBe(201);
    shiftId = shiftRes.json().id;

    // 5. Create Test Product
    const prodRes = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: authHeaders(ownerToken),
      payload: {
        sku: 'RICE-SAMBA-5KG',
        name: 'Samba Rice 5kg Bag',
        baseUom: 'BAG',
        sellingPrice: '1500.0000',
        purchaseCost: '1200.0000',
        trackInventory: false,
      },
    });
    expect(prodRes.statusCode).toBe(201);
    testProductId = prodRes.json().id;

    // 6. Create Customer 1 (Kasun) and Customer 2 (Saman)
    const cust1Res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: authHeaders(ownerToken),
      payload: {
        name: 'Kasun Perera',
        companyName: 'Perera Stores',
        phone: '0771234567',
        email: 'kasun@perera.lk',
      },
    });
    expect(cust1Res.statusCode).toBe(201);
    customer1Id = cust1Res.json().id;

    const cust2Res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: authHeaders(cashierToken), // Cashier permitted to create customer
      payload: {
        name: 'Saman Silva',
        companyName: 'Silva Enterprises',
        phone: '0777654321',
        email: 'saman@silva.lk',
      },
    });
    expect(cust2Res.statusCode).toBe(201);
    customer2Id = cust2Res.json().id;

    // 7. Open Credit Account for Customer 1 only (Kasun)
    const acc1Res = await app.inject({
      method: 'POST',
      url: '/v1/credit/accounts',
      headers: authHeaders(ownerToken),
      payload: {
        customerId: customer1Id,
        creditLimit: '50000.0000',
        creditTerms: 'NET_30',
      },
    });
    expect(acc1Res.statusCode).toBe(201);
    customer1CreditAccountId = acc1Res.json().id;
  });

  afterAll(async () => {
    await app.close();
    if (harness?.db) {
      await harness.db.destroy();
    }
  });

  describe('BUG-069: Customer Credit Account Filtering & Isolation', () => {
    it('returns empty list when querying credit accounts for Customer 2 (Saman who has no credit account)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts?customerId=${customer2Id}`,
        headers: authHeaders(cashierToken),
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.items).toBeDefined();
      expect(data.items.length).toBe(0);
      expect(data.total).toBe(0);
    });

    it('returns exactly Customer 1 credit account when querying credit accounts for Customer 1', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts?customerId=${customer1Id}`,
        headers: authHeaders(cashierToken),
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.items.length).toBe(1);
      expect(data.items[0]!.id).toBe(customer1CreditAccountId);
      expect(data.items[0]!.customerId).toBe(customer1Id);
      expect(data.items[0]!.customerName).toBe('Kasun Perera');
      expect(data.items[0]!.creditLimit).toBe('50000.0000');
      expect(data.items[0]!.status).toBe('ACTIVE');
    });

    it('blocks POS credit checkout for Customer 2 with 404 No customer credit account found', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: authHeaders(cashierToken, {
          'idempotency-key': generateUuidV7(),
        }),
        payload: {
          registerId,
          shiftId,
          customerId: customer2Id,
          lines: [
            {
              productId: testProductId,
              quantity: '2.0000',
              uomCode: 'BAG',
            },
          ],
          payments: [
            {
              paymentMethod: 'CREDIT',
              amount: '3000.0000',
              tenderedAmount: '3000.0000',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.errorCode).toBe('CREDIT_ACCOUNT_NOT_FOUND');
    });

    it('successfully processes POS credit checkout for Customer 1 and decrements available credit', async () => {
      const saleRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: authHeaders(cashierToken, {
          'idempotency-key': generateUuidV7(),
        }),
        payload: {
          registerId,
          shiftId,
          customerId: customer1Id,
          lines: [
            {
              productId: testProductId,
              quantity: '2.0000',
              uomCode: 'BAG',
            },
          ],
          payments: [
            {
              paymentMethod: 'CREDIT',
              amount: '3000.0000',
              tenderedAmount: '3000.0000',
            },
          ],
        },
      });

      expect(saleRes.statusCode).toBe(201);
      const sale = saleRes.json();
      expect(parseFloat(sale.grandTotal)).toBe(3000);
      expect(sale.lines.length).toBe(1);

      // Verify Customer 1 credit balance and available credit
      const accRes = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts/${customer1CreditAccountId}`,
        headers: authHeaders(cashierToken),
      });
      expect(accRes.statusCode).toBe(200);
      const acc = accRes.json();
      expect(parseFloat(acc.currentBalance)).toBe(3000);
      expect(parseFloat(acc.availableCredit)).toBe(47000);
    });

    it('rejects credit sale when amount exceeds customer available credit (Cashier without override)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: authHeaders(cashierToken, {
          'idempotency-key': generateUuidV7(),
        }),
        payload: {
          registerId,
          shiftId,
          customerId: customer1Id,
          lines: [
            {
              productId: testProductId,
              quantity: '40.0000', // 40 * 1500 = 60,000 > 47,000 available
              uomCode: 'BAG',
            },
          ],
          payments: [
            {
              paymentMethod: 'CREDIT',
              amount: '60000.0000',
              tenderedAmount: '60000.0000',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().errorCode).toBe('CREDIT_LIMIT_EXCEEDED');
    });
  });

  describe('BUG-070: POS Sale Responsiveness & Immediate Receipt Generation', () => {
    it('returns complete receipt data immediately from /v1/pos/sales/:saleId/receipt without errors', async () => {
      // Execute a cash sale
      const saleRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: authHeaders(cashierToken, {
          'idempotency-key': generateUuidV7(),
        }),
        payload: {
          registerId,
          shiftId,
          lines: [
            {
              productId: testProductId,
              quantity: '1.0000',
              uomCode: 'BAG',
            },
          ],
          payments: [
            {
              paymentMethod: 'CASH',
              amount: '1500.0000',
              tenderedAmount: '2000.0000',
            },
          ],
        },
      });

      expect(saleRes.statusCode).toBe(201);
      const sale = saleRes.json();
      expect(parseFloat(sale.changeGiven)).toBe(500);

      // Fetch receipt
      const receiptRes = await app.inject({
        method: 'GET',
        url: `/v1/pos/sales/${sale.id}/receipt`,
        headers: authHeaders(cashierToken),
      });

      expect(receiptRes.statusCode).toBe(200);
      const receipt = receiptRes.json();
      expect(receipt.invoiceNumber).toBe(sale.invoiceNumber);
      expect(parseFloat(receipt.grandTotal)).toBe(1500);
      expect(receipt.lines.length).toBe(1);
      expect(receipt.lines[0]!.name).toBe('Samba Rice 5kg Bag');
      expect(parseFloat(receipt.changeGiven)).toBe(500);
    });

    it('operates idempotently when repeated checkout request is received with identical idempotency key', async () => {
      const stableKey = generateUuidV7();
      const payload = {
        registerId,
        shiftId,
        lines: [
          {
            productId: testProductId,
            quantity: '1.0000',
            uomCode: 'BAG',
          },
        ],
        payments: [
          {
            paymentMethod: 'CASH',
            amount: '1500.0000',
            tenderedAmount: '1500.0000',
          },
        ],
      };

      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: authHeaders(cashierToken, {
          'idempotency-key': stableKey,
        }),
        payload,
      });
      expect(res1.statusCode).toBe(201);
      const sale1 = res1.json();

      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: authHeaders(cashierToken, {
          'idempotency-key': stableKey,
        }),
        payload,
      });
      expect([200, 201]).toContain(res2.statusCode);
      expect(res2.headers['x-idempotent-replayed']).toBe('true');
      const sale2 = res2.json();
      expect(sale2.id).toBe(sale1.id);
      expect(sale2.invoiceNumber).toBe(sale1.invoiceNumber);
    });
  });

  describe('BUG-071: Global Application Real-Time Data Synchronization', () => {
    it('publishes STOCK_CHANGED event upon sale completion and verifies via realtime polling', async () => {
      const pollRes = await app.inject({
        method: 'GET',
        url: `/v1/realtime/poll?branchId=${branchId}`,
        headers: authHeaders(cashierToken),
      });

      expect(pollRes.statusCode).toBe(200);
      const body = pollRes.json() as {
        events: Array<{
          eventType: string;
          tenantId: string;
          branchId: string;
          data: { lines?: unknown };
        }>;
      };
      expect(Array.isArray(body.events)).toBe(true);

      const stockEvents = body.events.filter((e) => e.eventType === 'STOCK_CHANGED');
      expect(stockEvents.length).toBeGreaterThan(0);
      const latestStockEvent = stockEvents[stockEvents.length - 1]!;
      expect(latestStockEvent.tenantId).toBe(TENANT_ID);
      expect(latestStockEvent.branchId).toBe(branchId);
      expect(latestStockEvent.data.lines).toBeDefined();
    });

    it('publishes CREDIT_ACCOUNT_CHANGED event when credit payment is recorded', async () => {
      // Record payment for Customer 1 (LKR 1,000)
      const payRes = await app.inject({
        method: 'POST',
        url: '/v1/credit/payments',
        headers: authHeaders(cashierToken),
        payload: {
          accountId: customer1CreditAccountId,
          amount: '1000.0000',
          paymentMethod: 'CASH',
        },
      });

      expect(payRes.statusCode).toBe(201);

      // Verify event was emitted
      const pollRes = await app.inject({
        method: 'GET',
        url: `/v1/realtime/poll?branchId=${branchId}`,
        headers: authHeaders(cashierToken),
      });

      expect(pollRes.statusCode).toBe(200);
      const body = pollRes.json() as {
        events: Array<{ eventType: string; data: { accountId?: string } }>;
      };
      const creditEvents = body.events.filter((e) => e.eventType === 'CREDIT_ACCOUNT_CHANGED');
      expect(creditEvents.length).toBeGreaterThan(0);
      const latestCreditEvent = creditEvents[creditEvents.length - 1]!;
      expect(latestCreditEvent.data.accountId).toBe(customer1CreditAccountId);
    });
  });

  describe('BUG-081: Customer Credit Account Ledger, Payments & History Route Verification', () => {
    it('retrieves ledger transactions via /v1/credit/accounts/:accountId/transactions with correct debit/credit fields', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts/${customer1CreditAccountId}/transactions`,
        headers: authHeaders(cashierToken),
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBeGreaterThan(0);

      // Verify contract fields
      const firstTx = data.items[0];
      expect(firstTx.transactionReference).toBeDefined();
      expect(firstTx.entryDirection).toBeDefined(); // 'DEBIT' or 'CREDIT'
      expect(firstTx.amount).toBeDefined();
      expect(firstTx.balanceAfter).toBeDefined();
    });

    it('retrieves payments via /v1/credit/accounts/:accountId/payments', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts/${customer1CreditAccountId}/payments`,
        headers: authHeaders(cashierToken),
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items[0].paymentReference).toBeDefined();
      expect(data.items[0].amount).toBe('1000.0000');
      expect(data.items[0].status).toBe('COMPLETED');
    });

    it('retrieves limit audit history via /v1/credit/accounts/:accountId/limit-history', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts/${customer1CreditAccountId}/limit-history`,
        headers: authHeaders(cashierToken),
      });

      expect(res.statusCode).toBe(200);
      const items = res.json();
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].changeType).toBe('INITIAL');
      expect(items[0].newLimit).toBe('50000.0000');
    });

    it('allows Manager to adjust credit limit and logs change history', async () => {
      const adjRes = await app.inject({
        method: 'POST',
        url: `/v1/credit/accounts/${customer1CreditAccountId}/limit`,
        headers: authHeaders(managerToken),
        payload: {
          newLimit: '75000.0000',
          changeType: 'INCREASE',
          reason: 'Strong seasonal turnover & reliable repayment history',
        },
      });

      expect(adjRes.statusCode).toBe(200);
      const acc = adjRes.json();
      expect(acc.creditLimit).toBe('75000.0000');

      // Verify audit history updated
      const histRes = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts/${customer1CreditAccountId}/limit-history`,
        headers: authHeaders(cashierToken),
      });
      expect(histRes.statusCode).toBe(200);
      const history = histRes.json();
      expect(history.length).toBe(2);
      expect(history[0].changeType).toBe('INCREASE');
      expect(history[0].previousLimit).toBe('50000.0000');
      expect(history[0].newLimit).toBe('75000.0000');
    });
  });

  describe('Cashier Credit Access Policy Enforcement', () => {
    it('permits Cashier to initiate a new credit account with default approved limit (50,000.00)', async () => {
      // Create Customer 3 (Kamal)
      const cust3Res = await app.inject({
        method: 'POST',
        url: '/v1/customers',
        headers: authHeaders(cashierToken),
        payload: {
          name: 'Kamal Fernando',
          phone: '0711122334',
        },
      });
      expect(cust3Res.statusCode).toBe(201);
      const customer3Id = cust3Res.json().id;

      // Cashier initiates credit account with standard 50,000 limit
      const accRes = await app.inject({
        method: 'POST',
        url: '/v1/credit/accounts',
        headers: authHeaders(cashierToken),
        payload: {
          customerId: customer3Id,
          creditLimit: '50000.0000',
          creditTerms: 'NET_30',
        },
      });

      expect(accRes.statusCode).toBe(201);
      expect(accRes.json().creditLimit).toBe('50000.0000');
    });

    it('rejects Cashier attempting to initiate a credit account with excessive custom limit (> 50,000.00) with 403', async () => {
      // Create Customer 4
      const cust4Res = await app.inject({
        method: 'POST',
        url: '/v1/customers',
        headers: authHeaders(cashierToken),
        payload: {
          name: 'Nimal Bandara',
          phone: '0715566778',
        },
      });
      expect(cust4Res.statusCode).toBe(201);
      const customer4Id = cust4Res.json().id;

      // Cashier attempts to grant 150,000 limit
      const accRes = await app.inject({
        method: 'POST',
        url: '/v1/credit/accounts',
        headers: authHeaders(cashierToken),
        payload: {
          customerId: customer4Id,
          creditLimit: '150000.0000',
          creditTerms: 'NET_30',
        },
      });

      expect(accRes.statusCode).toBe(403);
      expect(accRes.json().errorCode).toBe('CREDIT_LIMIT_APPROVAL_REQUIRED');
    });

    it('rejects Cashier attempting to initiate a credit account with a non-zero opening balance with 403', async () => {
      const custRes = await app.inject({
        method: 'POST',
        url: '/v1/customers',
        headers: authHeaders(cashierToken),
        payload: {
          name: 'Sunil Wickrama',
          phone: '0718899001',
        },
      });
      expect(custRes.statusCode).toBe(201);
      const custId = custRes.json().id;

      const accRes = await app.inject({
        method: 'POST',
        url: '/v1/credit/accounts',
        headers: authHeaders(cashierToken),
        payload: {
          customerId: custId,
          creditLimit: '50000.0000',
          creditTerms: 'NET_30',
          openingBalance: '5000.0000',
        },
      });

      expect(accRes.statusCode).toBe(403);
      expect(accRes.json().errorCode).toBe('CREDIT_LIMIT_APPROVAL_REQUIRED');
    });

    it('rejects Cashier attempting to adjust credit limit with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/credit/accounts/${customer1CreditAccountId}/limit`,
        headers: authHeaders(cashierToken),
        payload: {
          newLimit: '100000.0000',
          changeType: 'INCREASE',
          reason: 'Cashier unauthorized limit bump',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects Cashier attempting to suspend/change credit account status with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/credit/accounts/${customer1CreditAccountId}/status`,
        headers: authHeaders(cashierToken),
        payload: {
          status: 'SUSPENDED',
          reason: 'Cashier unauthorized suspension',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects Cashier attempting to write off bad debt with 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/credit/writeoffs',
        headers: authHeaders(cashierToken),
        payload: {
          accountId: customer1CreditAccountId,
          writeoffAmount: '500.0000',
          reason: 'Cashier unauthorized write-off',
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('BUG-081 & BUG-079/BUG-082 Backend Contracts, paymentReference & Idempotency Remediation', () => {
    it('accepts paymentReference, enforces idempotency-key replay, and surfaces externalReference & allocations in list and receipt endpoints', async () => {
      // 1. Check initial account state & create an unpaid credit sale on Customer 1
      const beforeAccRes = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts/${customer1CreditAccountId}`,
        headers: authHeaders(cashierToken),
      });
      expect(beforeAccRes.statusCode).toBe(200);
      const beforeBalance = Number(beforeAccRes.json().currentBalance);

      const saleKey = generateUuidV7();
      const saleRes = await app.inject({
        method: 'POST',
        url: '/v1/pos/sales',
        headers: authHeaders(cashierToken, { 'idempotency-key': saleKey }),
        payload: {
          registerId,
          shiftId,
          customerId: customer1Id,
          lines: [
            {
              productId: testProductId,
              quantity: '1.0000',
              uomCode: 'BAG',
            },
          ],
          payments: [
            {
              paymentMethod: 'CREDIT',
              amount: '1500.0000',
              tenderedAmount: '1500.0000',
            },
          ],
        },
      });
      expect(saleRes.statusCode).toBe(201);

      // 2. Submit Bank Transfer payment WITH paymentReference & idempotency-key
      const idempKey = generateUuidV7();
      const payPayload = {
        accountId: customer1CreditAccountId,
        amount: '1000.0000',
        paymentMethod: 'BANK_TRANSFER',
        paymentReference: 'SLT-FT-990011',
        notes: 'Bank transfer verified on statement',
      };

      const payRes = await app.inject({
        method: 'POST',
        url: '/v1/credit/payments',
        headers: authHeaders(cashierToken, { 'idempotency-key': idempKey }),
        payload: payPayload,
      });

      expect(payRes.statusCode).toBe(201);
      const payment = payRes.json();
      expect(payment.externalReference).toBe('SLT-FT-990011');
      expect(payment.paymentMethod).toBe('BANK_TRANSFER');
      expect(payment.amount).toBe('1000.0000');
      expect(Array.isArray(payment.allocations)).toBe(true);
      expect(payment.allocations.length).toBeGreaterThan(0);

      // 3. Replay exact same idempotency-key -> must NOT duplicate payment or double-deduct balance
      const replayRes = await app.inject({
        method: 'POST',
        url: '/v1/credit/payments',
        headers: authHeaders(cashierToken, { 'idempotency-key': idempKey }),
        payload: payPayload,
      });
      expect([200, 201]).toContain(replayRes.statusCode);
      expect(replayRes.headers['x-idempotent-replayed']).toBe('true');
      expect(replayRes.json().id).toBe(payment.id);

      // Verify exact balance arithmetic: beforeBalance + 1500 - 1000
      const afterAccRes = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts/${customer1CreditAccountId}`,
        headers: authHeaders(cashierToken),
      });
      expect(afterAccRes.statusCode).toBe(200);
      const afterAcc = afterAccRes.json();
      expect(Number(afterAcc.currentBalance)).toBeCloseTo(beforeBalance + 500, 4);
      expect(Number(afterAcc.availableCredit)).toBeCloseTo(
        Math.max(0, Number(afterAcc.creditLimit) - Number(afterAcc.currentBalance)),
        4,
      );

      // 4. Verify list payments endpoint includes externalReference and allocations
      const listPayRes = await app.inject({
        method: 'GET',
        url: `/v1/credit/accounts/${customer1CreditAccountId}/payments`,
        headers: authHeaders(cashierToken),
      });
      expect(listPayRes.statusCode).toBe(200);
      const listPayBody = listPayRes.json() as {
        items: Array<{
          id: string;
          externalReference?: string;
          allocations: unknown[];
        }>;
      };
      const matchedPayment = listPayBody.items.find((p) => p.id === payment.id);
      expect(matchedPayment).toBeDefined();
      expect(matchedPayment!.externalReference).toBe('SLT-FT-990011');
      expect(Array.isArray(matchedPayment!.allocations)).toBe(true);
      expect(matchedPayment!.allocations.length).toBeGreaterThan(0);

      // 5. Verify payment receipt endpoint includes externalReference and allocations
      const receiptRes = await app.inject({
        method: 'GET',
        url: `/v1/credit/payments/${payment.id}/receipt`,
        headers: authHeaders(cashierToken),
      });
      expect(receiptRes.statusCode).toBe(200);
      const receipt = receiptRes.json();
      expect(receipt.externalReference).toBe('SLT-FT-990011');
      expect(Array.isArray(receipt.allocations)).toBe(true);
      expect(receipt.allocations.length).toBeGreaterThan(0);
    });

    it('accepts optional payment without paymentReference while strictly rejecting truly unknown properties with 400', async () => {
      const cashPayRes = await app.inject({
        method: 'POST',
        url: '/v1/credit/payments',
        headers: authHeaders(cashierToken),
        payload: {
          accountId: customer1CreditAccountId,
          amount: '100.0000',
          paymentMethod: 'CASH',
        },
      });
      expect(cashPayRes.statusCode).toBe(201);
      expect(cashPayRes.json().externalReference).toBeNull();

      const badRes = await app.inject({
        method: 'POST',
        url: '/v1/credit/payments',
        headers: authHeaders(cashierToken),
        payload: {
          accountId: customer1CreditAccountId,
          amount: '100.0000',
          paymentMethod: 'CASH',
          unexpectedExtraField: 'should-fail-validation',
        },
      });
      expect(badRes.statusCode).toBe(400);
    });

    it('supports customer pagination & status filtering via /v1/customers', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/v1/customers?limit=2&offset=0&status=ACTIVE',
        headers: authHeaders(cashierToken),
      });
      expect(listRes.statusCode).toBe(200);
      const body = listRes.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeLessThanOrEqual(2);
      expect(typeof body.total).toBe('number');
      for (const c of body.items) {
        expect(c.status).toBe('ACTIVE');
      }
    });
  });
});
