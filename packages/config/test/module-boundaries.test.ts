import { describe, expect, it } from 'vitest';
import {
  assertAcyclicModuleGraph,
  validateModuleImport,
} from '../src/module-boundaries.js';

describe('NexStock Module Boundary & DAG Validator (NEX-DOC-03)', () => {
  it('verifies the canonical module dependency graph is strictly acyclic (DAG)', () => {
    expect(() => assertAcyclicModuleGraph()).not.toThrow();
  });

  it('allows intra-module imports across internal layers (domain, application, infrastructure)', () => {
    const violation = validateModuleImport(
      'c:/repo/apps/api/src/modules/inv/application/adjust-stock.ts',
      '../domain/stock-entry.js',
    );
    expect(violation).toBeNull();
  });

  it('allows valid cross-module imports that target the public index.js facade and follow the DAG', () => {
    // POS (Tier 4) is allowed to depend on INV (Tier 3) via index.js
    const violation = validateModuleImport(
      'c:/repo/apps/api/src/modules/pos/application/complete-sale.ts',
      '../../inv/index.js',
    );
    expect(violation).toBeNull();
  });

  it('rejects cross-module imports that reach into internal domain/infrastructure layers', () => {
    // POS importing INV's internal repository directly is forbidden
    const violation = validateModuleImport(
      'c:/repo/apps/api/src/modules/pos/application/complete-sale.ts',
      '../../inv/infrastructure/stock-ledger.repository.js',
    );
    expect(violation).not.toBeNull();
    expect(violation?.code).toBe('CROSS_MODULE_INTERNAL_IMPORT');
    expect(violation?.sourceModule).toBe('pos');
    expect(violation?.targetModule).toBe('inv');
  });

  it('rejects reverse-tier DAG violations (e.g., FIN depending on POS or INV, or SHARED depending on IAM)', () => {
    const finToPos = validateModuleImport(
      'c:/repo/apps/api/src/modules/fin/application/post-journal.ts',
      '../../pos/index.js',
    );
    expect(finToPos).not.toBeNull();
    expect(finToPos?.code).toBe('DAG_DEPENDENCY_VIOLATION');

    const sharedToIam = validateModuleImport(
      'c:/repo/apps/api/src/modules/shared/infrastructure/tx.ts',
      '../../iam/index.js',
    );
    expect(sharedToIam).not.toBeNull();
    expect(sharedToIam?.code).toBe('DAG_DEPENDENCY_VIOLATION');
  });
});
