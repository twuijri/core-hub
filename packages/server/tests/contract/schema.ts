// Shared by the contract tests: validate a response body against a schema of the OpenAPI
// document (with `#/components/...` refs resolved) and look up documented response schemas.
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { listOperations, type ContractOperation, type OpenApiDocument } from '@corehub/contracts';

export interface SchemaValidator {
  validate(schema: Record<string, unknown>, data: unknown): string[];
}

export function ajvFor(document: OpenApiDocument): SchemaValidator {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  // ajv-formats is CommonJS: the callable lives on module.exports and on .default.
  const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
    addFormatsModule) as FormatsPlugin;
  addFormats(ajv);
  return {
    validate(schema: Record<string, unknown>, data: unknown): string[] {
      // Compile with the document's components alongside so `#/components/schemas/...` refs resolve.
      const compiled = ajv.compile({ allOf: [schema], components: document.components ?? {} });
      return compiled(data)
        ? []
        : (compiled.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
    },
  };
}

/** Operations by `operationId`. */
export function operationsById(document: OpenApiDocument): Map<string, ContractOperation> {
  return new Map(
    listOperations(document)
      .filter((op) => op.operationId)
      .map((op) => [op.operationId!, op] as const),
  );
}

/** The JSON schema documented for `status` on an operation, or undefined (204, binary). */
export function responseSchema(
  op: ContractOperation,
  status: number,
): Record<string, unknown> | undefined {
  const responses = op.operation.responses ?? {};
  const documented =
    responses[String(status)] ?? responses[`${String(status)[0]}XX`] ?? responses.default;
  if (!documented) throw new Error(`status ${status} is not documented for ${op.operationId}`);
  return documented.content?.['application/json']?.schema;
}
