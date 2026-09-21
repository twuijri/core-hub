// `pnpm contract:test`: every operation in packages/contracts/openapi.yaml is exercised through
// the generated TypeScript client against the running app. Each must answer either a status
// documented for it with a schema-valid body, or the documented 501 not_implemented envelope.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HubApiError,
  createHubClient,
  isScaffoldStub,
  listOperations,
  loadOpenApiDocument,
  serverBasePath,
  type ClientMethod,
  type ContractOperation,
  type HubClient,
} from '@majlis/contracts';
import { testHub, type TestHub } from '../unit/helpers.js';
import { ajvFor } from './schema.js';

const doc = loadOpenApiDocument();
const CLIENT_METHODS: readonly ClientMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const ENVELOPE = {
  type: 'object',
  required: ['error', 'code'],
  properties: { error: { type: 'string', minLength: 1 }, code: { type: 'string', minLength: 1 } },
};

function exampleOf(
  media:
    | {
        example?: unknown;
        examples?: Record<string, { value?: unknown }>;
        schema?: Record<string, unknown>;
      }
    | undefined,
) {
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  const first = media.examples && Object.values(media.examples)[0];
  if (first && 'value' in first) return first.value;
  return media.schema?.example;
}

function pathParamsFor(op: ContractOperation): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const param of op.pathParameters) {
    const example = param.example ?? param.schema?.example;
    params[param.name] =
      example === undefined || example === null ? 'contract-test' : (example as string | number);
  }
  // Parameters declared on the path item (not the operation) are not in
  // op.pathParameters; every {token} in the path still needs a value.
  for (const match of op.path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1]!;
    if (!(name in params)) params[name] = 'contract-test';
  }
  return params;
}

describe.skipIf(!doc)('contract: every OpenAPI operation answers per the document', () => {
  const document = doc!;
  const operations = listOperations(document).filter((op) =>
    CLIENT_METHODS.includes(op.method as ClientMethod),
  );
  const schemas = ajvFor(document);
  let hub: TestHub;
  let client: HubClient;

  beforeAll(async () => {
    hub = await testHub();
    await hub.app.listen({ port: 0, host: '127.0.0.1' });
    const address = hub.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    client = createHubClient({
      baseUrl: `http://127.0.0.1:${port}`,
      apiBase: serverBasePath(document),
      profile: 'default',
    });
  });
  afterAll(async () => {
    await hub.close();
  });

  it('has at least one operation (and warns while the stub is in place)', () => {
    expect(operations.length).toBeGreaterThan(0);
    if (isScaffoldStub())
      console.warn(
        'contract:test  openapi.yaml is still the scaffold stub; only /health is covered.',
      );
  });

  it.each(operations.map((op) => [`${op.method.toUpperCase()} ${op.fullPath}`, op] as const))(
    '%s',
    async (_label, op) => {
      const body =
        exampleOf(op.operation.requestBody?.content?.['application/json']) ??
        (op.operation.requestBody ? {} : undefined);
      let status: number;
      let data: unknown;
      try {
        const res = await client.raw(op.method as ClientMethod, op.path, {
          params: pathParamsFor(op),
          ...(body !== undefined ? { body } : {}),
        });
        status = res.status;
        data = res.data;
      } catch (error) {
        if (!(error instanceof HubApiError)) throw error;
        status = error.status;
        data = error.body;
      }

      if (status === 501) {
        // Documented gap: declared in the contract, not implemented by any module yet.
        expect(schemas.validate(ENVELOPE, data)).toEqual([]);
        expect((data as { code: string }).code).toBe('not_implemented');
        return;
      }

      const responses = op.operation.responses ?? {};
      const documented =
        responses[String(status)] ?? responses[`${String(status)[0]}XX`] ?? responses.default;
      expect(documented, `status ${status} is not documented for ${op.operationId}`).toBeDefined();
      if (status >= 400) expect(schemas.validate(ENVELOPE, data)).toEqual([]);
      const schema = documented?.content?.['application/json']?.schema;
      if (schema) expect(schemas.validate(schema, data)).toEqual([]);
    },
  );
});
