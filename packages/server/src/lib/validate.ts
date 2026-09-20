// zod helper: parse request parts into typed values or throw the validation envelope.
import type { ZodType } from 'zod';
import { validationFailed } from './errors.js';

export type RequestPart = 'body' | 'query' | 'params' | 'headers';

export interface ValidationIssue {
  source: RequestPart;
  path: string;
  message: string;
}

export function parse<T>(schema: ZodType<T>, input: unknown, source: RequestPart = 'body'): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    source,
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  throw validationFailed({ issues });
}

/** Validate several request parts at once; reports every issue, not just the first. */
export function parseRequest<B, Q, P>(
  schemas: { body?: ZodType<B>; query?: ZodType<Q>; params?: ZodType<P> },
  request: { body?: unknown; query?: unknown; params?: unknown },
): { body: B; query: Q; params: P } {
  const issues: ValidationIssue[] = [];
  const out: Partial<{ body: B; query: Q; params: P }> = {};
  for (const source of ['body', 'query', 'params'] as const) {
    const schema = schemas[source] as ZodType<unknown> | undefined;
    if (!schema) continue;
    const result = schema.safeParse(request[source]);
    if (result.success) {
      (out as Record<string, unknown>)[source] = result.data;
    } else {
      for (const issue of result.error.issues) {
        issues.push({ source, path: issue.path.map(String).join('.'), message: issue.message });
      }
    }
  }
  if (issues.length > 0) throw validationFailed({ issues });
  return out as { body: B; query: Q; params: P };
}
