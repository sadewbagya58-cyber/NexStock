/**
 * Canonical Module Dependency Directed Acyclic Graph (DAG) & Boundary Validator
 * Specification Reference: NEX-DOC-03 (03-module-boundaries.md)
 */

export type BackendModuleName =
  | 'shared'
  | 'iam'
  | 'sub'
  | 'i18n'
  | 'org'
  | 'cat'
  | 'crm'
  | 'fin'
  | 'inv'
  | 'pos'
  | 'pur'
  | 'sync';

/**
 * Explicit allowed dependencies per backend module (Tier 0 -> Tier 5 DAG).
 * Any dependency not listed here is strictly forbidden.
 */
export const ALLOWED_MODULE_DEPENDENCIES: Readonly<
  Record<BackendModuleName, readonly BackendModuleName[]>
> = {
  // Tier 0: Foundation Kernel
  shared: [],

  // Tier 1: Platform Governance
  iam: ['shared'],
  sub: ['shared'],
  i18n: ['shared'],
  org: ['shared', 'iam', 'sub', 'i18n'],

  // Tier 2: Master Data & Financial Core
  cat: ['shared', 'sub', 'i18n', 'org', 'iam'],
  crm: ['shared', 'sub', 'i18n', 'org', 'iam'],
  fin: ['shared', 'sub', 'i18n', 'org', 'iam'],

  // Tier 3: Core Inventory Engine
  inv: ['shared', 'sub', 'cat', 'org', 'iam', 'fin', 'i18n'],

  // Tier 4: Transactional Flows
  pos: ['shared', 'sub', 'inv', 'cat', 'crm', 'i18n', 'org', 'iam', 'fin'],
  pur: ['shared', 'sub', 'inv', 'cat', 'i18n', 'org', 'iam', 'fin'],

  // Tier 5: Edge Orchestration
  sync: ['shared', 'sub', 'pos', 'inv', 'cat', 'crm', 'org', 'iam'],
};

export interface BoundaryViolation {
  readonly code: 'CROSS_MODULE_INTERNAL_IMPORT' | 'DAG_DEPENDENCY_VIOLATION';
  readonly sourceModule: BackendModuleName;
  readonly targetModule: BackendModuleName;
  readonly importSpecifier: string;
  readonly message: string;
}

const VALID_MODULES = new Set<string>(Object.keys(ALLOWED_MODULE_DEPENDENCIES));

function isBackendModuleName(name: string): name is BackendModuleName {
  return VALID_MODULES.has(name);
}

/**
 * Validates whether an import from `sourceFilePath` to `importSpecifier` obeys:
 * 1. Public Facade Rule: Cross-module imports may ONLY target `modules/<target>` or `modules/<target>/index(.js|.ts)`.
 * 2. Acyclic Dependency Rule: `sourceModule` may only import `targetModule` if listed in ALLOWED_MODULE_DEPENDENCIES.
 */
export function validateModuleImport(
  sourceFilePath: string,
  importSpecifier: string,
): BoundaryViolation | null {
  const normalizedSource = sourceFilePath.replace(/\\/g, '/');
  const sourceMatch = normalizedSource.match(/\/modules\/([a-z0-9_]+)\//);
  if (!sourceMatch?.[1] || !isBackendModuleName(sourceMatch[1])) {
    return null;
  }
  const sourceModule = sourceMatch[1];

  const normalizedSpec = importSpecifier.replace(/\\/g, '/');
  // Match imports that traverse into another module under modules/<target>
  const targetMatch = normalizedSpec.match(
    /(?:^|\/)modules\/([a-z0-9_]+)(?:\/(.*))?$/,
  );

  // Also match relative sibling imports from inside modules/<source>/... like ../<target>/...
  let targetModuleName: string | undefined = targetMatch?.[1];
  let targetSubpath: string | undefined = targetMatch?.[2];

  if (!targetModuleName && normalizedSpec.startsWith('.')) {
    const sourceParts = normalizedSource.split('/');
    const modulesIdx = sourceParts.lastIndexOf('modules');
    if (modulesIdx !== -1) {
      const fileDirParts = sourceParts.slice(0, -1);
      const specParts = normalizedSpec.split('/');
      const resolvedParts = [...fileDirParts];
      for (const part of specParts) {
        if (part === '.' || part === '') continue;
        if (part === '..') {
          resolvedParts.pop();
        } else {
          resolvedParts.push(part);
        }
      }
      const resolvedModulesIdx = resolvedParts.lastIndexOf('modules');
      if (
        resolvedModulesIdx !== -1 &&
        resolvedParts.length > resolvedModulesIdx + 1
      ) {
        targetModuleName = resolvedParts[resolvedModulesIdx + 1];
        targetSubpath = resolvedParts.slice(resolvedModulesIdx + 2).join('/');
      }
    }
  }

  if (!targetModuleName || !isBackendModuleName(targetModuleName)) {
    return null;
  }

  const targetModule = targetModuleName;
  if (targetModule === sourceModule) {
    // Intra-module imports are permitted
    return null;
  }

  // Rule 1: Check DAG dependency permission
  const allowedTargets = ALLOWED_MODULE_DEPENDENCIES[sourceModule];
  if (!allowedTargets.includes(targetModule)) {
    return {
      code: 'DAG_DEPENDENCY_VIOLATION',
      sourceModule,
      targetModule,
      importSpecifier,
      message: `Architecture DAG violation: module "${sourceModule}" is not permitted to depend on module "${targetModule}". Allowed dependencies for "${sourceModule}": [${allowedTargets.join(', ')}].`,
    };
  }

  // Rule 2: Check Public Facade encapsulation
  const isFacade =
    !targetSubpath ||
    targetSubpath === '' ||
    targetSubpath === 'index' ||
    targetSubpath === 'index.js' ||
    targetSubpath === 'index.ts';

  if (!isFacade) {
    return {
      code: 'CROSS_MODULE_INTERNAL_IMPORT',
      sourceModule,
      targetModule,
      importSpecifier,
      message: `Module encapsulation violation: module "${sourceModule}" cannot import internal path "${targetSubpath}" of module "${targetModule}". Import only via its public facade ("modules/${targetModule}/index.js").`,
    };
  }

  return null;
}

/**
 * Verifies mathematically that ALLOWED_MODULE_DEPENDENCIES contains zero cycles.
 */
export function assertAcyclicModuleGraph(): void {
  const visited = new Set<BackendModuleName>();
  const visiting = new Set<BackendModuleName>();

  function dfs(node: BackendModuleName, path: BackendModuleName[]): void {
    if (visiting.has(node)) {
      throw new Error(
        `Circular module dependency detected: ${[...path, node].join(' -> ')}`,
      );
    }
    if (visited.has(node)) return;

    visiting.add(node);
    for (const dep of ALLOWED_MODULE_DEPENDENCIES[node]) {
      dfs(dep, [...path, node]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const mod of Object.keys(
    ALLOWED_MODULE_DEPENDENCIES,
  ) as BackendModuleName[]) {
    dfs(mod, []);
  }
}
