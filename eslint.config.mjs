import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Canonical Module Dependency DAG (NEX-DOC-03) enforced directly by ESLint.
 */
const ALLOWED_MODULE_DEPENDENCIES = {
  shared: [],
  iam: ['shared'],
  sub: ['shared'],
  i18n: ['shared'],
  org: ['shared', 'iam', 'sub', 'i18n'],
  cat: ['shared', 'sub', 'i18n', 'org', 'iam'],
  crm: ['shared', 'sub', 'i18n', 'org', 'iam'],
  fin: ['shared', 'sub', 'i18n', 'org', 'iam'],
  inv: ['shared', 'sub', 'cat', 'org', 'iam', 'fin', 'i18n'],
  pos: ['shared', 'sub', 'inv', 'cat', 'crm', 'i18n', 'org', 'iam', 'fin'],
  pur: ['shared', 'sub', 'inv', 'cat', 'i18n', 'org', 'iam', 'fin'],
  sync: ['shared', 'sub', 'pos', 'inv', 'cat', 'crm', 'org', 'iam'],
};

const VALID_MODULES = new Set(Object.keys(ALLOWED_MODULE_DEPENDENCIES));

function checkModuleBoundary(sourceFilePath, importSpecifier) {
  const normalizedSource = sourceFilePath.replace(/\\/g, '/');
  const sourceMatch = normalizedSource.match(/\/modules\/([a-z0-9_]+)\//);
  if (!sourceMatch?.[1] || !VALID_MODULES.has(sourceMatch[1])) {
    return null;
  }
  const sourceModule = sourceMatch[1];
  const normalizedSpec = importSpecifier.replace(/\\/g, '/');

  let targetModuleName;
  let targetSubpath;

  const targetMatch = normalizedSpec.match(
    /(?:^|\/)modules\/([a-z0-9_]+)(?:\/(.*))?$/,
  );
  if (targetMatch) {
    targetModuleName = targetMatch[1];
    targetSubpath = targetMatch[2];
  } else if (normalizedSpec.startsWith('.')) {
    const sourceParts = normalizedSource.split('/');
    const fileDirParts = sourceParts.slice(0, -1);
    const specParts = normalizedSpec.split('/');
    const resolvedParts = [...fileDirParts];
    for (const part of specParts) {
      if (part === '.' || part === '') continue;
      if (part === '..') resolvedParts.pop();
      else resolvedParts.push(part);
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

  if (
    !targetModuleName ||
    !VALID_MODULES.has(targetModuleName) ||
    targetModuleName === sourceModule
  ) {
    return null;
  }

  const allowed = ALLOWED_MODULE_DEPENDENCIES[sourceModule];
  if (!allowed.includes(targetModuleName)) {
    return `Architecture DAG violation: module "${sourceModule}" cannot depend on "${targetModuleName}".`;
  }

  const isFacade =
    !targetSubpath ||
    targetSubpath === '' ||
    targetSubpath === 'index' ||
    targetSubpath === 'index.js' ||
    targetSubpath === 'index.ts';

  if (!isFacade) {
    return `Module encapsulation violation: module "${sourceModule}" cannot import internal path "${targetSubpath}" of "${targetModuleName}". Import only its public index facade.`;
  }

  return null;
}

const nexstockBoundariesPlugin = {
  rules: {
    'enforce-module-dag': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Enforce NexStock modular monolith DAG and public facade boundaries (NEX-DOC-03)',
        },
        schema: [],
      },
      create(context) {
        const filename = context.filename ?? context.getFilename();
        function inspectNode(node) {
          if (node.source && typeof node.source.value === 'string') {
            const errorMsg = checkModuleBoundary(filename, node.source.value);
            if (errorMsg) {
              context.report({ node: node.source, message: errorMsg });
            }
          }
        }
        return {
          ImportDeclaration: inspectNode,
          ExportNamedDeclaration: inspectNode,
          ExportAllDeclaration: inspectNode,
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'nexstock-boundaries': nexstockBoundariesPlugin,
    },
    rules: {
      'nexstock-boundaries/enforce-module-dag': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
