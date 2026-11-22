import type {
  OnboardBusinessRequest,
  OnboardBusinessResponse,
} from '@nexstock/contracts';
import type { Kysely } from 'kysely';
import { upsertTenantLocalizationSettings } from '../../i18n/index.js';
import {
  provisionTenantMember,
  seedDefaultSystemRoles,
} from '../../iam/index.js';
import { provisionTenantSubscription } from '../../sub/index.js';
import {
  AppError,
  type NexStockDatabase,
  appendAuditLog,
  enqueueOutboxEvent,
  generateUuidV7,
  withAppUserTransaction,
  withTenantTransaction,
  withUserTransaction,
} from '../../shared/index.js';

export const SUPPORTED_ONBOARDING_CURRENCIES = [
  'USD',
  'LKR',
  'EUR',
  'GBP',
  'INR',
  'AED',
  'SGD',
  'AUD',
  'JPY',
  'KWD',
  'BHD',
] as const;

export type SupportedOnboardingCurrency =
  (typeof SUPPORTED_ONBOARDING_CURRENCIES)[number];

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length >= 2 ? base.slice(0, 48) : `biz-${base || 'store'}`;
}

/**
 * Atomically onboards a new business, creating:
 * 1. Tenant organization record (`tenants`)
 * 2. System roles and founding TENANT_OWNER membership (`tenant_memberships`)
 * 3. Initial active branch (`branches`)
 * 4. Default warehouse (`warehouses`) and branch-warehouse link
 * 5. Default POS register (`pos_registers`)
 * 6. Starter trial subscription (`tenant_subscriptions`)
 * 7. Tenant localization settings (`tenant_localization_settings`)
 * 8. Comprehensive audit log and outbox event
 *
 * All executed inside a single atomic database transaction ensuring zero orphaned records.
 */
export async function onboardBusinessAtomic(
  db: Kysely<NexStockDatabase>,
  input: {
    readonly userId: string;
    readonly userEmail?: string | undefined;
    readonly userFullName?: string | undefined;
    readonly idempotencyKey?: string | undefined;
    readonly request: OnboardBusinessRequest;
    readonly traceId: string;
  },
): Promise<OnboardBusinessResponse> {
  const currency = input.request.currency.trim().toUpperCase();
  const normalizedIdemKey = input.idempotencyKey?.trim() || null;

  // 1. Authoritative domain validation against supported onboarding currencies
  const isSupportedDomainCurrency = (
    SUPPORTED_ONBOARDING_CURRENCIES as readonly string[]
  ).includes(currency);

  if (!isSupportedDomainCurrency) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Currency',
      detail: `Currency code "${currency}" is not supported. Supported currencies include ${SUPPORTED_ONBOARDING_CURRENCIES.join(', ')}.`,
    });
  }

  const baseSlug = slugify(input.request.businessName);

  // 2. Single preflight transaction: idempotency check, currency status, user profile, and slug check
  const preflight = await withUserTransaction(
    db,
    { userId: input.userId, traceId: input.traceId },
    async (trx) => {
      if (normalizedIdemKey) {
        const existingTenant = await trx
          .selectFrom('tenants')
          .innerJoin('tenant_memberships', 'tenant_memberships.tenant_id', 'tenants.id')
          .select([
            'tenants.id as tenant_id',
            'tenants.slug',
            'tenants.legal_name',
            'tenants.base_currency',
            'tenants.status',
            'tenant_memberships.id as membership_id',
          ])
          .where('tenants.onboarding_idempotency_key', '=', normalizedIdemKey)
          .where('tenant_memberships.user_id', '=', input.userId)
          .executeTakeFirst();

        if (existingTenant) {
          return {
            existingTenant,
          };
        }
      }

      const [currencyRecord, userRecord, existingSlug] = await Promise.all([
        trx
          .selectFrom('currencies')
          .select(['code', 'is_active'])
          .where('code', '=', currency)
          .executeTakeFirst()
          .catch(() => undefined),
        trx
          .selectFrom('users')
          .select(['id', 'email', 'full_name'])
          .where('id', '=', input.userId)
          .executeTakeFirst(),
        trx
          .selectFrom('tenants')
          .select('id')
          .where('slug', '=', baseSlug)
          .executeTakeFirst()
          .catch(() => undefined),
      ]);

      return {
        existingTenant: null,
        currencyRecord,
        userRecord,
        existingSlug,
      };
    },
  );

  if (preflight.existingTenant) {
    const existingTenant = preflight.existingTenant;
    const replayResult = await withTenantTransaction(
      db,
      { tenantId: existingTenant.tenant_id, userId: input.userId, traceId: input.traceId },
      async (trx) => {
        const [branchRow, whRow, regRow] = await Promise.all([
          trx.db
            .selectFrom('branches')
            .select(['id', 'code', 'name'])
            .where('tenant_id', '=', existingTenant.tenant_id)
            .orderBy('created_at', 'asc')
            .executeTakeFirst(),
          trx.db
            .selectFrom('warehouses')
            .select(['id', 'code', 'name'])
            .where('tenant_id', '=', existingTenant.tenant_id)
            .orderBy('created_at', 'asc')
            .executeTakeFirst(),
          trx.db
            .selectFrom('pos_registers')
            .select(['id', 'code', 'name'])
            .where('tenant_id', '=', existingTenant.tenant_id)
            .orderBy('created_at', 'asc')
            .executeTakeFirst(),
        ]);

        if (!branchRow || !whRow || !regRow) {
          return null;
        }

        return {
          tenant: {
            id: existingTenant.tenant_id,
            slug: existingTenant.slug,
            legalName: existingTenant.legal_name,
            baseCurrency: existingTenant.base_currency,
            status: existingTenant.status,
          },
          branch: {
            id: branchRow.id,
            code: branchRow.code,
            name: branchRow.name,
          },
          warehouse: {
            id: whRow.id,
            code: whRow.code,
            name: whRow.name,
          },
          register: {
            id: regRow.id,
            code: regRow.code,
            name: regRow.name,
          },
          ownerMembershipId: existingTenant.membership_id,
        } satisfies OnboardBusinessResponse;
      },
    );

    if (replayResult) {
      return replayResult;
    }
  }

  if (preflight.currencyRecord && preflight.currencyRecord.is_active === false) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Currency',
      detail: `Currency code "${currency}" is currently inactive. Supported currencies include ${SUPPORTED_ONBOARDING_CURRENCIES.join(', ')}.`,
    });
  }

  const email = preflight.userRecord?.email ?? input.userEmail ?? `${input.userId}@nexstock.local`;
  const fullName = preflight.userRecord?.full_name ?? input.userFullName ?? input.request.businessName;

  if (!preflight.userRecord) {
    await withAppUserTransaction(db, { userId: input.userId, traceId: input.traceId }, async (trx) => {
      await trx
        .insertInto('users')
        .values({
          id: input.userId,
          email: email.trim().toLowerCase(),
          full_name: fullName.trim(),
          is_platform_admin: false,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    });
  }

  let slug = baseSlug;
  if (preflight.existingSlug) {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
    slug = `${baseSlug}-${randomSuffix}`.slice(0, 64);
  }

  const newTenantId = generateUuidV7();
  const timezone = (input.request.timezone && input.request.timezone.trim().length > 0)
    ? input.request.timezone.trim()
    : 'UTC';
  const countryCode = (input.request.countryCode && input.request.countryCode.trim().length === 2)
    ? input.request.countryCode.trim().toUpperCase()
    : 'US';

  const rawBranchCode = input.request.firstBranchCode?.trim().toUpperCase();
  const branchCode = rawBranchCode && rawBranchCode.length > 0 ? rawBranchCode : 'MAIN';

  if (!/^[A-Z0-9_-]{1,32}$/.test(branchCode)) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'ERR_VALIDATION_FAILED',
      title: 'Invalid Branch Code',
      detail: 'First branch code must be 1 to 32 alphanumeric characters, hyphens, or underscores.',
    });
  }

  return withTenantTransaction(
    db,
    {
      tenantId: newTenantId,
      userId: input.userId,
      traceId: input.traceId,
    },
    async (trx) => {
      // 1. Create Tenant
      await trx.db
        .insertInto('tenants')
        .values({
          id: newTenantId,
          slug,
          legal_name: input.request.businessName.trim(),
          base_currency: currency,
          default_locale: 'en-US',
          default_timezone: timezone,
          country_code: countryCode,
          status: 'TRIALING',
          ...(normalizedIdemKey ? { onboarding_idempotency_key: normalizedIdemKey } : {}),
        })
        .execute();

      // 2. Seed Default System Roles (TENANT_OWNER, ORG_ADMIN, etc.)
      await seedDefaultSystemRoles(trx);

      // 3. Provision Founder as TENANT_OWNER
      const ownerMembership = await provisionTenantMember(trx, {
        userId: input.userId,
        email,
        fullName,
        roleCodes: ['TENANT_OWNER'],
        allLocationsAccess: true,
        status: 'ACTIVE',
      });

      // 4. Create First Branch
      const branchId = generateUuidV7();
      await trx.db
        .insertInto('branches')
        .values({
          id: branchId,
          tenant_id: newTenantId,
          code: branchCode,
          name: input.request.firstBranchName.trim(),
          timezone,
          country_code: countryCode,
          default_warehouse_id: null,
          is_active: true,
        })
        .execute();

      // 5. Create Default Warehouse for this Branch
      const warehouseId = generateUuidV7();
      const warehouseCode = `WH-${branchCode}`.slice(0, 32);
      const warehouseName = `${input.request.firstBranchName.trim()} Stockroom`;
      await trx.db
        .insertInto('warehouses')
        .values({
          id: warehouseId,
          tenant_id: newTenantId,
          branch_id: branchId,
          code: warehouseCode,
          name: warehouseName,
          allow_negative_stock: false,
          is_active: true,
        })
        .execute();

      // 6. Link Branch to Warehouse
      await trx.db
        .insertInto('branch_warehouse_links')
        .values({
          id: generateUuidV7(),
          tenant_id: newTenantId,
          branch_id: branchId,
          warehouse_id: warehouseId,
          is_primary: true,
        })
        .execute();

      // 7. Set Default Warehouse on Branch
      await trx.db
        .updateTable('branches')
        .set({
          default_warehouse_id: warehouseId,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', newTenantId)
        .where('id', '=', branchId)
        .execute();

      // 8. Create Default POS Register
      const registerId = generateUuidV7();
      const registerCode = 'REG-01';
      const registerName = 'Front Counter 1';
      await trx.db
        .insertInto('pos_registers')
        .values({
          id: registerId,
          tenant_id: newTenantId,
          branch_id: branchId,
          warehouse_id: warehouseId,
          code: registerCode,
          name: registerName,
          last_invoice_seq: 0,
          is_active: true,
        })
        .execute();

      // 9. Provision Subscription Plan (STARTER, 30-day no-card free trial)
      await provisionTenantSubscription(trx, {
        planCode: 'STARTER',
        status: 'TRIALING',
        trialDays: 30,
      });

      // 10. Upsert Localization Settings
      await upsertTenantLocalizationSettings(trx, {
        locale: 'en-US',
        timezone,
        dateFormat: 'YYYY-MM-DD',
        numberFormat: '1,234.56',
        currencyDisplayMode: 'SYMBOL',
      });

      // 11. Append Audit Log
      await appendAuditLog(trx, {
        action: 'ORG_BUSINESS_ONBOARDED',
        resourceType: 'TENANT',
        resourceId: newTenantId,
        metadata: {
          slug,
          businessName: input.request.businessName,
          businessType: input.request.businessType,
          currency,
          firstBranchName: input.request.firstBranchName,
          firstBranchCode: branchCode,
          countryCode,
          timezone,
          ownerUserId: input.userId,
        },
      });

      // 12. Enqueue Outbox Event
      await enqueueOutboxEvent(trx, {
        aggregateType: 'TENANT',
        aggregateId: newTenantId,
        eventType: 'BUSINESS_ONBOARDED',
        payload: {
          tenantId: newTenantId,
          slug,
          firstBranchId: branchId,
          firstBranchCode: branchCode,
        },
      });

      return {
        tenant: {
          id: newTenantId,
          slug,
          legalName: input.request.businessName.trim(),
          baseCurrency: currency,
          status: 'TRIALING',
        },
        branch: {
          id: branchId,
          code: branchCode,
          name: input.request.firstBranchName.trim(),
        },
        warehouse: {
          id: warehouseId,
          code: warehouseCode,
          name: warehouseName,
        },
        register: {
          id: registerId,
          code: registerCode,
          name: registerName,
        },
        ownerMembershipId: ownerMembership.membershipId,
      };
    },
  );
}
