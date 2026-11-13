/**
 * Deterministic Hybrid Barcode & GS1-128 / DataMatrix Parser (`packages/domain-core`).
 * Zero runtime dependencies; strictly side-effect free for shared use across API, Web & Tauri Desktop.
 */

export type BarcodeClassification =
  | 'INTERNAL_BATCH'
  | 'GS1_COMPOSITE'
  | 'PLAIN_BARCODE';

export interface ParsedGs1Barcode {
  readonly isGs1: boolean;
  readonly rawNormalized: string;
  readonly symbologyIdentifier?: string;
  readonly gtin14?: string;
  readonly candidateBarcodes: readonly string[];
  readonly batchNumber?: string;
  readonly manufacturingDate?: string; // YYYY-MM-DD
  readonly expiryDate?: string; // YYYY-MM-DD
  readonly serialNumber?: string;
  readonly warnings: readonly string[];
}

const FNC1_CHAR = '\u001d';
const SYMBOLOGY_PREFIX_RE = /^\](C1|d2|e0|e1|E0|Q3)/;
const INTERNAL_BATCH_PREFIX_RE = /^NB-B[A-Z0-9-]+$/i;

/**
 * Strips scanner symbology AIM identifiers (e.g. `]C1`, `]d2`, `]e0`, `]Q3`)
 * and normalizes literal `<GS>` / `{GS}` group separator tokens to ASCII 0x1D.
 */
export function normalizeScannerInput(rawInput: string): {
  readonly normalized: string;
  readonly symbologyIdentifier?: string;
} {
  const trimmed = rawInput.trim();
  const match = SYMBOLOGY_PREFIX_RE.exec(trimmed);
  let body = trimmed;
  let symbologyIdentifier: string | undefined;

  if (match) {
    symbologyIdentifier = match[0];
    body = trimmed.slice(match[0].length);
  }

  const normalized = body
    .replaceAll('<GS>', FNC1_CHAR)
    .replaceAll('{GS}', FNC1_CHAR)
    .replaceAll('\\x1d', FNC1_CHAR)
    .replaceAll('\\u001d', FNC1_CHAR)
    .trim();

  return symbologyIdentifier
    ? { normalized, symbologyIdentifier }
    : { normalized };
}

/**
 * Generates an expanded set of GTIN / EAN-13 / UPC-A / plain lookup candidates
 * without mutating non-numeric SKUs.
 */
export function normalizeBarcodeCandidates(rawCode: string): string[] {
  const { normalized } = normalizeScannerInput(rawCode);
  const candidates = new Set<string>();
  const clean = normalized.replaceAll(FNC1_CHAR, '').trim();
  if (!clean) return [];

  candidates.add(clean);

  if (/^\d{8,14}$/.test(clean)) {
    const padded14 = clean.padStart(14, '0');
    candidates.add(padded14);
    if (padded14.startsWith('0')) {
      candidates.add(padded14.slice(1)); // EAN-13 candidate
    }
    if (padded14.startsWith('00')) {
      candidates.add(padded14.slice(2)); // UPC-A candidate
    }
  }

  return [...candidates];
}

/**
 * Classifies whether scanned code is an immutable NexStock Internal Batch Barcode,
 * a GS1 composite string, or a plain EAN/UPC/Code128 barcode.
 */
export function classifyBarcodeKind(rawInput: string): BarcodeClassification {
  const { normalized, symbologyIdentifier } = normalizeScannerInput(rawInput);
  const compact = normalized.replaceAll(FNC1_CHAR, '').trim();

  if (INTERNAL_BATCH_PREFIX_RE.test(compact)) {
    return 'INTERNAL_BATCH';
  }

  const parsed = parseGs1Barcode(rawInput);
  if (
    parsed.isGs1 ||
    symbologyIdentifier === ']C1' ||
    symbologyIdentifier === ']d2'
  ) {
    if (
      parsed.gtin14 !== undefined ||
      parsed.batchNumber !== undefined ||
      parsed.expiryDate !== undefined ||
      parsed.serialNumber !== undefined
    ) {
      return 'GS1_COMPOSITE';
    }
  }

  return 'PLAIN_BARCODE';
}

function getLastDayOfMonth(year: number, month1To12: number): number {
  return new Date(Date.UTC(year, month1To12, 0)).getUTCDate();
}

/**
 * Parses a GS1 6-digit YYMMDD date into ISO `YYYY-MM-DD`.
 * Per GS1 General Specifications section 3.4.2:
 * - Century resolved to `20YY` (for standard shelf-life 2000-2099 inventory range).
 * - Day `'00'` resolves to the final valid calendar day of the month (leap-year aware).
 */
export function parseGs1DateYyMmDd(yyMmDd: string): string | null {
  if (!/^\d{6}$/.test(yyMmDd)) {
    return null;
  }

  const yy = Number.parseInt(yyMmDd.slice(0, 2), 10);
  const mm = Number.parseInt(yyMmDd.slice(2, 4), 10);
  const ddRaw = Number.parseInt(yyMmDd.slice(4, 6), 10);

  if (mm < 1 || mm > 12) {
    return null;
  }

  const year = 2000 + yy;
  const maxDay = getLastDayOfMonth(year, mm);
  const day = ddRaw === 0 ? maxDay : ddRaw;

  if (day < 1 || day > maxDay) {
    return null;
  }

  const mmStr = String(mm).padStart(2, '0');
  const ddStr = String(day).padStart(2, '0');
  return `${String(year)}-${mmStr}-${ddStr}`;
}

function readVariableAiValue(
  input: string,
  startIndex: number,
  maxLen: number,
): { readonly value: string; readonly nextIndex: number } {
  const gsIndex = input.indexOf(FNC1_CHAR, startIndex);
  if (gsIndex !== -1 && gsIndex - startIndex <= maxLen) {
    return {
      value: input.slice(startIndex, gsIndex),
      nextIndex: gsIndex + 1,
    };
  }
  const end = Math.min(input.length, startIndex + maxLen);
  return {
    value: input.slice(startIndex, end),
    nextIndex: end,
  };
}

function parseParenthesizedGs1(
  normalized: string,
  symbologyIdentifier?: string,
): ParsedGs1Barcode | null {
  // Parenthesized HRI form e.g. "(01)04901234567894(10)LOT-A(17)271231(21)SN123"
  if (!/^\((01|10|11|17|21)\)/.test(normalized)) {
    return null;
  }

  const warnings: string[] = [];
  let gtin14: string | undefined;
  let batchNumber: string | undefined;
  let manufacturingDate: string | undefined;
  let expiryDate: string | undefined;
  let serialNumber: string | undefined;

  const tokenRe = /\((\d{2,4})\)([^()]+)/g;
  let matchedAny = false;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(normalized)) !== null) {
    matchedAny = true;
    const ai = match[1]!;
    const val = match[2]!.replaceAll(FNC1_CHAR, '').trim();
    if (ai === '01') {
      if (/^\d{14}$/.test(val)) {
        gtin14 = val;
      } else {
        warnings.push(`Invalid AI (01) GTIN-14 length/format: "${val}"`);
      }
    } else if (ai === '10') {
      batchNumber = val.slice(0, 20);
    } else if (ai === '11') {
      const parsedDate = parseGs1DateYyMmDd(val.slice(0, 6));
      if (parsedDate) manufacturingDate = parsedDate;
      else warnings.push(`Invalid AI (11) manufacturing date: "${val}"`);
    } else if (ai === '17') {
      const parsedDate = parseGs1DateYyMmDd(val.slice(0, 6));
      if (parsedDate) expiryDate = parsedDate;
      else warnings.push(`Invalid AI (17) expiry date: "${val}"`);
    } else if (ai === '21') {
      serialNumber = val.slice(0, 20);
    }
  }

  if (!matchedAny) {
    return null;
  }

  const candidateBarcodes = gtin14 ? normalizeBarcodeCandidates(gtin14) : [];
  return {
    isGs1: true,
    rawNormalized: normalized,
    ...(symbologyIdentifier ? { symbologyIdentifier } : {}),
    ...(gtin14 ? { gtin14 } : {}),
    candidateBarcodes,
    ...(batchNumber ? { batchNumber } : {}),
    ...(manufacturingDate ? { manufacturingDate } : {}),
    ...(expiryDate ? { expiryDate } : {}),
    ...(serialNumber ? { serialNumber } : {}),
    warnings,
  };
}

/**
 * Deterministic GS1-128 / GS1 DataMatrix Application Identifier parser.
 * Supports AI `(01)` GTIN-14, `(10)` Batch/Lot, `(11)` Mfg Date, `(17)` Expiry Date, and `(21)` Serial Number.
 */
export function parseGs1Barcode(rawInput: string): ParsedGs1Barcode {
  const { normalized, symbologyIdentifier } = normalizeScannerInput(rawInput);

  if (!normalized || INTERNAL_BATCH_PREFIX_RE.test(normalized)) {
    return {
      isGs1: false,
      rawNormalized: normalized,
      ...(symbologyIdentifier ? { symbologyIdentifier } : {}),
      candidateBarcodes: normalizeBarcodeCandidates(normalized),
      warnings: [],
    };
  }

  // 1. Check HRI parenthesized GS1 form first
  const hri = parseParenthesizedGs1(normalized, symbologyIdentifier);
  if (hri) {
    return hri;
  }

  // 2. Concise binary/FNC1 scanner form
  // A plain 13-digit EAN/12-digit UPC without ]C1/]d2 and without trailing AI is NOT treated as GS1 composite.
  const hasExplicitGs1Aim =
    symbologyIdentifier === ']C1' || symbologyIdentifier === ']d2';
  const startsWith01 = normalized.startsWith('01') && normalized.length >= 16 && /^\d{14}/.test(normalized.slice(2, 16));
  const startsWithLotOrExp =
    normalized.includes(FNC1_CHAR) && /^(01|10|11|17|21)/.test(normalized);

  if (!hasExplicitGs1Aim && !startsWith01 && !startsWithLotOrExp) {
    return {
      isGs1: false,
      rawNormalized: normalized,
      ...(symbologyIdentifier ? { symbologyIdentifier } : {}),
      candidateBarcodes: normalizeBarcodeCandidates(normalized),
      warnings: [],
    };
  }

  // Edge case: Exact 16 chars "01" + 14 digits without explicit AIM prefix might just be a 16-char numeric barcode,
  // unless length > 16 or AIM prefix ]C1/]d2 was transmitted.
  if (startsWith01 && normalized.length === 16 && !hasExplicitGs1Aim) {
    return {
      isGs1: false,
      rawNormalized: normalized,
      candidateBarcodes: normalizeBarcodeCandidates(normalized),
      warnings: [],
    };
  }

  const warnings: string[] = [];
  let gtin14: string | undefined;
  let batchNumber: string | undefined;
  let manufacturingDate: string | undefined;
  let expiryDate: string | undefined;
  let serialNumber: string | undefined;

  let cursor = 0;
  let parsedAiCount = 0;

  while (cursor < normalized.length) {
    if (normalized[cursor] === FNC1_CHAR) {
      cursor += 1;
      continue;
    }

    const ai = normalized.slice(cursor, cursor + 2);
    if (ai === '01' && cursor + 16 <= normalized.length) {
      const candidateGtin = normalized.slice(cursor + 2, cursor + 16);
      if (/^\d{14}$/.test(candidateGtin)) {
        gtin14 = candidateGtin;
        cursor += 16;
        parsedAiCount += 1;
        continue;
      }
      break;
    }

    if (ai === '17' && cursor + 8 <= normalized.length) {
      const yyMmDd = normalized.slice(cursor + 2, cursor + 8);
      const parsedDate = parseGs1DateYyMmDd(yyMmDd);
      if (parsedDate) {
        expiryDate = parsedDate;
      } else {
        warnings.push(`Invalid AI (17) expiry date: "${yyMmDd}"`);
      }
      cursor += 8;
      parsedAiCount += 1;
      continue;
    }

    if (ai === '11' && cursor + 8 <= normalized.length) {
      const yyMmDd = normalized.slice(cursor + 2, cursor + 8);
      const parsedDate = parseGs1DateYyMmDd(yyMmDd);
      if (parsedDate) {
        manufacturingDate = parsedDate;
      } else {
        warnings.push(`Invalid AI (11) manufacturing date: "${yyMmDd}"`);
      }
      cursor += 8;
      parsedAiCount += 1;
      continue;
    }

    if (ai === '10') {
      const res = readVariableAiValue(normalized, cursor + 2, 20);
      if (res.value) {
        batchNumber = res.value;
        parsedAiCount += 1;
      }
      cursor = res.nextIndex;
      continue;
    }

    if (ai === '21') {
      const res = readVariableAiValue(normalized, cursor + 2, 20);
      if (res.value) {
        serialNumber = res.value;
        parsedAiCount += 1;
      }
      cursor = res.nextIndex;
      continue;
    }

    // Unknown AI encountered after valid prefix -> stop scanning cleanly rather than corrupting parsed fields
    if (parsedAiCount > 0) {
      warnings.push(`Stopped parsing at unsupported AI near "${normalized.slice(cursor, cursor + 4)}"`);
    }
    break;
  }

  if (parsedAiCount === 0) {
    return {
      isGs1: false,
      rawNormalized: normalized,
      ...(symbologyIdentifier ? { symbologyIdentifier } : {}),
      candidateBarcodes: normalizeBarcodeCandidates(normalized),
      warnings,
    };
  }

  const candidateBarcodes = gtin14
    ? normalizeBarcodeCandidates(gtin14)
    : normalizeBarcodeCandidates(normalized);

  return {
    isGs1: true,
    rawNormalized: normalized,
    ...(symbologyIdentifier ? { symbologyIdentifier } : {}),
    ...(gtin14 ? { gtin14 } : {}),
    candidateBarcodes,
    ...(batchNumber ? { batchNumber } : {}),
    ...(manufacturingDate ? { manufacturingDate } : {}),
    ...(expiryDate ? { expiryDate } : {}),
    ...(serialNumber ? { serialNumber } : {}),
    warnings,
  };
}

/**
 * Generates a compact, Code 128 ASCII-safe immutable internal batch barcode string
 * using a globally unique suffix token (`NB-B` + Crockford/hex body).
 */
export function buildInternalBatchBarcodeValue(
  uniqueSeed: string,
  prefix = 'NB-B',
): string {
  const safePrefix = prefix
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '');
  const compactSeed = uniqueSeed
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(-12)
    .padStart(10, '0');
  return `${safePrefix || 'NB-B'}${compactSeed}`;
}
