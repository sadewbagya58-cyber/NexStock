import type { ReceiptResponse } from '@nexstock/contracts';

export interface FormatReceiptInput {
  readonly businessName: string;
  readonly branchName: string;
  readonly registerCode: string;
  readonly invoiceNumber: string;
  readonly cashierName: string;
  readonly createdAt: Date;
  readonly timezone?: string | undefined;
  readonly locale?: string | undefined;
  readonly currencyCode: string;
  readonly lines: ReadonlyArray<{
    sku: string;
    name: string;
    quantity: string;
    uomCode: string;
    unitPrice: string;
    discountAmount: string;
    taxAmount: string;
    lineTotal: string;
  }>;
  readonly subtotalAmount: string;
  readonly discountAmount: string;
  readonly taxAmount: string;
  readonly grandTotal: string;
  readonly payments: ReadonlyArray<{
    method: string;
    amount: string;
    tenderedAmount: string;
    changeAmount: string;
  }>;
  readonly changeGiven: string;
  readonly notes?: string | null | undefined;
}

export function formatReceiptData(input: FormatReceiptInput): ReceiptResponse {
  const tz = input.timezone || 'UTC';
  const loc = input.locale || 'en-US';

  let formattedTimestamp: string;
  try {
    formattedTimestamp = new Intl.DateTimeFormat(loc, {
      timeZone: tz,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(input.createdAt);
  } catch {
    formattedTimestamp = input.createdAt.toISOString();
  }

  return {
    businessName: input.businessName,
    branchName: input.branchName,
    registerCode: input.registerCode,
    invoiceNumber: input.invoiceNumber,
    cashierName: input.cashierName,
    formattedTimestamp,
    currencyCode: input.currencyCode,
    lines: input.lines.map((l) => ({
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      uomCode: l.uomCode,
      unitPrice: l.unitPrice,
      discountAmount: l.discountAmount,
      taxAmount: l.taxAmount,
      lineTotal: l.lineTotal,
    })),
    subtotalAmount: input.subtotalAmount,
    discountAmount: input.discountAmount,
    taxAmount: input.taxAmount,
    grandTotal: input.grandTotal,
    payments: input.payments.map((p) => ({
      method: p.method,
      amount: p.amount,
      tenderedAmount: p.tenderedAmount,
      changeAmount: p.changeAmount,
    })),
    changeGiven: input.changeGiven,
    notes: input.notes ?? null,
  };
}
