/**
 * Contract-derived request validation (ADR 0003).
 *
 * Every implemented route names its `operationId`; this module reads that operation out of
 * `packages/contracts/openapi.yaml` and compiles AJV validators for its request body, query
 * and path parameters from the contract's own schemas. A route therefore cannot accept a
 * body the document forbids, and a contract change is picked up without touching the route.
 *
 * It also exposes the operation's `security` and `x-roles`, so the authorisation a route
 * enforces is the one the document advertises rather than a second, hand-kept copy.
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import {
  listOperations,
  type ContractOperation,
  type OpenApiDocument,
  type OpenApiParameter,
} from '@majlis/contracts';
import { validationFailed } from './errors.js';

export const PROFILE_PARAMETER = 'X-Hub-Profile';

export interface ContractOperationInfo {
  operationId: string;
  method: string;
  path: string;
  /** The operation declares `X-Hub-Profile`: it is workspace-scoped (ADR 0005). */
  requiresProfile: boolean;
  /** `security: []` in the document — the operation is reachable without a token. */
  public: boolean;
  /** A bearer token is accepted but not required (`auth.refresh`). */
  optionalAuth: boolean;
  /** `x-roles`, or null when every signed-in user may call it. */
  roles: readonly ('owner' | 'admin' | 'member')[] | null;
  validateBody(data: unknown): void;
  validateQuery(data: unknown): unknown;
  validateParams(data: unknown): unknown;
}

export interface ContractIndex {
  /** Throws if the operation is not in the document: a typo cannot reach production. */
  operation(operationId: string): ContractOperationInfo;
  has(operationId: string): boolean;
  document: OpenApiDocument;
}

function createAjv(coerce: boolean) {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    validateFormats: true,
    coerceTypes: coerce,
    useDefaults: coerce,
  });
  // ajv-formats is CommonJS: the callable lives on module.exports and on .default.
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
    addFormatsModule) as FormatsPlugin;
  addFormats(ajv);
  return ajv;
}

type Resolver = (node: unknown) => unknown;

/** Resolves local `$ref`s (`#/components/...`) so parameter objects can be read. */
function makeResolver(document: OpenApiDocument): Resolver {
  return function resolve(node: unknown): unknown {
    if (!node || typeof node !== 'object') return node;
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
    let current: unknown = document;
    for (const segment of ref.slice(2).split('/')) {
      if (!current || typeof current !== 'object') return node;
      current = (current as Record<string, unknown>)[
        segment.replace(/~1/g, '/').replace(/~0/g, '~')
      ];
    }
    return resolve(current);
  };
}

function issuesOf(validate: ValidateFunction, source: string) {
  return (validate.errors ?? []).map((error) => ({
    source,
    path: (error.instancePath || '/').replace(/^\//, '').replace(/\//g, '.'),
    message: error.message ?? 'is invalid',
  }));
}

export function createContractIndex(document: OpenApiDocument): ContractIndex {
  const bodyAjv = createAjv(false);
  const inputAjv = createAjv(true);
  const resolve = makeResolver(document);
  const components = document.components ?? {};
  const byId = new Map<string, ContractOperation>();
  for (const op of listOperations(document)) {
    if (op.operationId) byId.set(op.operationId, op);
  }
  const cache = new Map<string, ContractOperationInfo>();

  function compile(ajv: Ajv2020, schema: Record<string, unknown> | null): ValidateFunction | null {
    if (!schema) return null;
    // Compiling the schema next to the document's `components` makes `#/components/...`
    // references resolve without registering 248 schemas one by one.
    return ajv.compile({ ...schema, components });
  }

  function parametersOf(op: ContractOperation): OpenApiParameter[] {
    const item = document.paths?.[op.path];
    const shared = (item?.parameters ?? []).map((p) => resolve(p) as OpenApiParameter);
    const own = (op.operation.parameters ?? []).map((p) => resolve(p) as OpenApiParameter);
    return [...shared, ...own];
  }

  function objectSchemaFor(
    parameters: OpenApiParameter[],
    location: 'query' | 'path',
  ): Record<string, unknown> | null {
    const chosen = parameters.filter((p) => p.in === location);
    if (chosen.length === 0) return null;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const parameter of chosen) {
      properties[parameter.name] = parameter.schema ?? {};
      if (parameter.required) required.push(parameter.name);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }

  function build(operationId: string): ContractOperationInfo {
    const op = byId.get(operationId);
    if (!op) {
      throw new Error(
        `operationId "${operationId}" is not in packages/contracts/openapi.yaml — ` +
          'declare the operation in the contract before implementing it (ADR 0003).',
      );
    }
    const parameters = parametersOf(op);
    const security = op.operation.security as unknown[] | undefined;
    const roles = (op.operation['x-roles'] as ('owner' | 'admin' | 'member')[] | undefined) ?? null;
    const bodySchema =
      (op.operation.requestBody?.content?.['application/json']?.schema as
        Record<string, unknown> | undefined) ?? null;
    const bodyRequired = op.operation.requestBody?.required === true;

    const validateBodyFn = compile(bodyAjv, bodySchema);
    const validateQueryFn = compile(inputAjv, objectSchemaFor(parameters, 'query'));
    const validateParamsFn = compile(inputAjv, objectSchemaFor(parameters, 'path'));

    return {
      operationId,
      method: op.method,
      path: op.path,
      requiresProfile: parameters.some(
        (p) => p.in === 'header' && p.name.toLowerCase() === PROFILE_PARAMETER.toLowerCase(),
      ),
      public: Array.isArray(security) && security.length === 0,
      optionalAuth: Array.isArray(security) && security.some((entry) => isEmptyObject(entry)),
      roles,
      validateBody(data) {
        if (data === undefined || data === null) {
          if (bodyRequired)
            throw validationFailed({ fields: [{ path: '', message: 'body is required' }] });
          return;
        }
        if (!validateBodyFn) return;
        if (!validateBodyFn(data)) {
          throw validationFailed({ fields: issuesOf(validateBodyFn, 'body') });
        }
      },
      validateQuery(data) {
        if (!validateQueryFn) return data ?? {};
        const value = (data ?? {}) as Record<string, unknown>;
        if (!validateQueryFn(value)) {
          throw validationFailed({ fields: issuesOf(validateQueryFn, 'query') });
        }
        return value;
      },
      validateParams(data) {
        if (!validateParamsFn) return data ?? {};
        const value = (data ?? {}) as Record<string, unknown>;
        if (!validateParamsFn(value)) {
          throw validationFailed({ fields: issuesOf(validateParamsFn, 'path') });
        }
        return value;
      },
    };
  }

  return {
    document,
    has: (operationId) => byId.has(operationId),
    operation(operationId) {
      const cached = cache.get(operationId);
      if (cached) return cached;
      const built = build(operationId);
      cache.set(operationId, built);
      return built;
    },
  };
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}
