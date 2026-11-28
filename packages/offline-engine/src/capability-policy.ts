import type {
  OfflineCapabilityClass,
  OfflineDeviceContext,
  OfflineOperationKey,
} from '@nexstock/contracts';
import type { OfflineCapabilityDescriptor } from './types.js';

export class OfflineEngineError extends Error {
  readonly code: string;
  readonly httpEquivalentStatus: number;

  constructor(code: string, message: string, httpEquivalentStatus = 400) {
    super(message);
    this.name = 'OfflineEngineError';
    this.code = code;
    this.httpEquivalentStatus = httpEquivalentStatus;
  }
}

export const OFFLINE_CAPABILITY_MATRIX: Readonly<
  Record<OfflineOperationKey, OfflineCapabilityDescriptor>
> = {
  POS_SEARCH_CATALOG: {
    operation: 'POS_SEARCH_CATALOG',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Searches locally synced branch catalog and inventory projection.',
  },
  POS_SCAN_BARCODE: {
    operation: 'POS_SCAN_BARCODE',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Resolves manufacturer barcodes, SKUs, and internal batch barcodes locally.',
  },
  POS_CART_MANAGE: {
    operation: 'POS_CART_MANAGE',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Manages POS cart items, quantities, discounts, taxes, and draft persistence.',
  },
  POS_CASH_CHECKOUT: {
    operation: 'POS_CASH_CHECKOUT',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Records cash POS sales locally and queues immutable POS_RECORD_SALE commands under Option A validation on sync.',
  },
  POS_LOCAL_RECEIPT: {
    operation: 'POS_LOCAL_RECEIPT',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Generates printable local OFF-* invoices marked PENDING_SYNC.',
  },
  POS_RECOVERY: {
    operation: 'POS_RECOVERY',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Recovers unfinished draft carts and pending local transactions after restart.',
  },
  POS_CARD_GATEWAY: {
    operation: 'POS_CARD_GATEWAY',
    capability: 'ONLINE_ONLY',
    reason: 'Card payment gateways require live authorization and cannot be marked settled offline.',
  },
  POS_CREDIT_CHECKOUT: {
    operation: 'POS_CREDIT_CHECKOUT',
    capability: 'ONLINE_ONLY',
    reason: 'Customer credit limit checks require authoritative live server balance validation.',
  },
  PRICING_APPROVAL: {
    operation: 'PRICING_APPROVAL',
    capability: 'ONLINE_ONLY',
    reason: 'Global/branch price approvals require server-side authorization.',
  },
  INV_TRANSFER_APPROVAL: {
    operation: 'INV_TRANSFER_APPROVAL',
    capability: 'ONLINE_ONLY',
    reason: 'Inter-branch stock transfers require multi-branch server coordination.',
  },
  IAM_STAFF_INVITE: {
    operation: 'IAM_STAFF_INVITE',
    capability: 'ONLINE_ONLY',
    reason: 'Staff invitations and RBAC policy changes require server authority.',
  },
  REPORT_DRILLDOWN: {
    operation: 'REPORT_DRILLDOWN',
    capability: 'ONLINE_ONLY',
    reason: 'Consolidated multi-branch accounting drilldowns require server aggregation.',
  },
  INV_OFFLINE_ADJUSTMENT: {
    operation: 'INV_OFFLINE_ADJUSTMENT',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Records offline stock adjustments locally and queues INV_RECORD_ADJUSTMENT for server validation on sync.',
  },
  INV_OFFLINE_MOVEMENT: {
    operation: 'INV_OFFLINE_MOVEMENT',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Records offline stock movements locally and queues INV_RECORD_MOVEMENT for server validation on sync.',
  },
  INV_OFFLINE_TRANSFER_REQUEST: {
    operation: 'INV_OFFLINE_TRANSFER_REQUEST',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Creates local TRANSFER_REQUEST_PENDING requests; authoritative stock movement happens only after server validation.',
  },
  INV_OFFLINE_BATCH_INSPECT: {
    operation: 'INV_OFFLINE_BATCH_INSPECT',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Inspects locally cached batches, expiry dates, and FEFO/FIFO order offline.',
  },
  INV_OFFLINE_SERIAL_OPS: {
    operation: 'INV_OFFLINE_SERIAL_OPS',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Looks up and queues validated serial number status operations offline.',
  },
  INV_OFFLINE_WASTE_DRAFT: {
    operation: 'INV_OFFLINE_WASTE_DRAFT',
    capability: 'OFFLINE_CAPABLE',
    reason: 'Captures local waste log drafts offline and queues INV_CREATE_WASTE_DRAFT for authoritative server valuation.',
  },
  INV_WASTE_CONFIRM: {
    operation: 'INV_WASTE_CONFIRM',
    capability: 'ONLINE_ONLY',
    reason: 'Waste confirmation posts immutable WASTE_OUT ledger deductions and authoritative MAC/FIFO costing on the server.',
  },
  SYNC_RESOLVE_CONFLICT: {
    operation: 'SYNC_RESOLVE_CONFLICT',
    capability: 'ONLINE_ONLY',
    reason: 'Conflict resolution requires authoritative server validation and audit trail.',
  },
};

export function getOperationCapability(operation: OfflineOperationKey): OfflineCapabilityClass {
  return OFFLINE_CAPABILITY_MATRIX[operation].capability;
}

export function assertOfflineSecurityAndCapability(params: {
  readonly operation: OfflineOperationKey;
  readonly isOnline: boolean;
  readonly deviceContext: OfflineDeviceContext | null;
  readonly tenantId: string;
  readonly branchId: string;
  readonly requiredPermission?: string;
  readonly deviceSecurityStatus?: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | null;
  readonly nowMs?: number;
}): OfflineDeviceContext {
  if (params.deviceSecurityStatus === 'REVOKED') {
    throw new OfflineEngineError(
      'OFFLINE_DEVICE_REVOKED',
      'This device has been revoked by an administrator. New offline operations are locked; pending data remains safe for supervisor recovery.',
      403,
    );
  }
  const descriptor = OFFLINE_CAPABILITY_MATRIX[params.operation];
  if (!params.isOnline && descriptor.capability === 'ONLINE_ONLY') {
    throw new OfflineEngineError(
      'OFFLINE_ONLINE_ONLY_BLOCKED',
      descriptor.reason,
      503,
    );
  }

  const ctx = params.deviceContext;
  if (!ctx) {
    throw new OfflineEngineError(
      'OFFLINE_DEVICE_UNBOUND',
      'No authorized offline device session is bound on this device.',
      401,
    );
  }

  if (ctx.tenantId !== params.tenantId) {
    throw new OfflineEngineError(
      'OFFLINE_TENANT_ISOLATION_DENIED',
      `Device is bound to tenant "${ctx.tenantId}" and cannot access tenant "${params.tenantId}".`,
      403,
    );
  }

  const now = params.nowMs ?? Date.now();
  const expMs = Date.parse(ctx.offlineAuthExpiresAt);
  if (!params.isOnline && (!Number.isFinite(expMs) || now > expMs)) {
    throw new OfflineEngineError(
      'OFFLINE_AUTH_EXPIRED',
      'Offline authorization window has expired. Connect to the internet to re-authenticate.',
      401,
    );
  }

  if (!ctx.allLocationsAccess && !ctx.allowedBranchIds.includes(params.branchId)) {
    throw new OfflineEngineError(
      'OFFLINE_BRANCH_SCOPE_DENIED',
      `User is not authorized for branch "${params.branchId}".`,
      403,
    );
  }

  if (
    params.requiredPermission &&
    !ctx.roleCodes.includes('TENANT_OWNER') &&
    !ctx.roleCodes.includes('ORG_ADMIN') &&
    !ctx.permissions.includes(params.requiredPermission)
  ) {
    throw new OfflineEngineError(
      'OFFLINE_PERMISSION_DENIED',
      `Missing required permission "${params.requiredPermission}".`,
      403,
    );
  }

  // Phase 10.5 — Offline Subscription Status & Feature Entitlement Enforcement
  const snap = ctx.subscriptionSnapshot;
  if (snap) {
    const isWriteOp =
      params.operation === 'POS_CASH_CHECKOUT' ||
      params.operation === 'POS_CARD_GATEWAY' ||
      params.operation === 'POS_CREDIT_CHECKOUT' ||
      params.operation === 'INV_OFFLINE_ADJUSTMENT' ||
      params.operation === 'INV_OFFLINE_MOVEMENT' ||
      params.operation === 'INV_OFFLINE_TRANSFER_REQUEST' ||
      params.operation === 'INV_OFFLINE_SERIAL_OPS';

    if (snap.status === 'SUSPENDED' || snap.status === 'CANCELLED') {
      throw new OfflineEngineError(
        'OFFLINE_SUBSCRIPTION_INACTIVE',
        `Subscription is "${snap.status}". Unsynchronized transactions are preserved safely until subscription restoration.`,
        403,
      );
    }

    if (
      isWriteOp &&
      (snap.isReadOnly ||
        snap.status === 'READ_ONLY' ||
        snap.status === 'EXPIRED' ||
        snap.status === 'PAST_DUE')
    ) {
      throw new OfflineEngineError(
        'OFFLINE_SUBSCRIPTION_READ_ONLY',
        `Subscription is in Read-Only Mode (${snap.status}). Existing offline records and pending transactions are preserved safely; renew subscription to resume writes.`,
        403,
      );
    }

    if (!params.isOnline && isWriteOp && snap.offlineEntitled === false) {
      throw new OfflineEngineError(
        'OFFLINE_SUBSCRIPTION_NOT_ENTITLED',
        `Offline POS & Offline Inventory require a Pro or Enterprise plan (current plan: ${snap.planCode}).`,
        403,
      );
    }

    if (
      params.operation === 'INV_OFFLINE_TRANSFER_REQUEST' &&
      snap.features?.stockTransfers === false
    ) {
      throw new OfflineEngineError(
        'OFFLINE_SUBSCRIPTION_NOT_ENTITLED',
        'Offline stock transfer requests require a Pro or Enterprise plan.',
        403,
      );
    }

    if (
      params.operation === 'INV_OFFLINE_SERIAL_OPS' &&
      snap.features?.serialTracking === false
    ) {
      throw new OfflineEngineError(
        'OFFLINE_SUBSCRIPTION_NOT_ENTITLED',
        'Serial number tracking requires a Pro or Enterprise plan.',
        403,
      );
    }
  }

  return ctx;
}
