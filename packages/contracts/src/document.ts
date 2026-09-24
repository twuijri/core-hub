// Runtime access to the contract document. Used by the server to mount 501 stubs for
// operations that are declared but not yet implemented, and by the contract test.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, OpenApiMediaType> };
  responses?: Record<string, OpenApiResponse>;
  [key: string]: unknown;
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: Record<string, unknown>;
  example?: unknown;
  $ref?: string;
}

export interface OpenApiMediaType {
  schema?: Record<string, unknown>;
  example?: unknown;
  examples?: Record<string, { value?: unknown }>;
}

export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType>;
  $ref?: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  servers?: { url: string }[];
  paths?: Record<
    string,
    Partial<Record<HttpMethod, OpenApiOperation>> & { parameters?: OpenApiParameter[] }
  >;
  components?: { schemas?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ContractOperation {
  method: HttpMethod;
  /** Path as written in the document, e.g. `/sessions/{id}`. */
  path: string;
  /** Path with the server prefix, e.g. `/api/v1/sessions/{id}`. */
  fullPath: string;
  operationId: string | undefined;
  operation: OpenApiOperation;
  pathParameters: OpenApiParameter[];
}

/** Directory of packages/contracts, resolved from either src/ or dist/src/. */
export function contractsRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
        if (parsed.name === '@corehub/contracts') return dir;
      } catch {
        // keep walking
      }
    }
    dir = path.dirname(dir);
  }
  throw new Error('Cannot locate packages/contracts from ' + import.meta.url);
}

export function openapiDocumentPath(): string {
  return path.join(contractsRoot(), 'openapi.yaml');
}

/** Returns null when the document does not exist yet (tooling must tolerate that). */
export function loadOpenApiDocument(file: string = openapiDocumentPath()): OpenApiDocument | null {
  if (!existsSync(file)) return null;
  const doc = parseYaml(readFileSync(file, 'utf8')) as OpenApiDocument;
  if (!doc || typeof doc !== 'object' || typeof doc.openapi !== 'string') {
    throw new Error(`${file} is not an OpenAPI document`);
  }
  return doc;
}

/** True while openapi.yaml is still the scaffold placeholder. */
export function isScaffoldStub(file: string = openapiDocumentPath()): boolean {
  return existsSync(file) && readFileSync(file, 'utf8').includes('x-corehub-scaffold-stub: true');
}

/** Path prefix declared by `servers[0].url` (`/api/v1`), or '' when absent. */
export function serverBasePath(doc: OpenApiDocument): string {
  const url = doc.servers?.[0]?.url;
  if (!url) return '';
  if (url.startsWith('/')) return url.replace(/\/$/, '');
  try {
    return new URL(url).pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function listOperations(doc: OpenApiDocument): ContractOperation[] {
  const base = serverBasePath(doc);
  const out: ContractOperation[] = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    if (!item) continue;
    const shared = (item.parameters ?? []).filter((param) => param.in === 'path');
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const own = (operation.parameters ?? []).filter((param) => param.in === 'path');
      out.push({
        method,
        path: p,
        fullPath: `${base}${p}`,
        operationId: operation.operationId,
        operation,
        pathParameters: [...shared, ...own],
      });
    }
  }
  return out;
}

/** `/sessions/{id}` -> `/sessions/:id` (Fastify route syntax). */
export function toRoutePattern(contractPath: string): string {
  return contractPath.replace(/\{([^}]+)\}/g, ':$1');
}
