// Shared helpers for the contracts scripts. Plain ESM, no build step.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const contractsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(contractsRoot, '..', '..');
export const openapiPath = path.join(contractsRoot, 'openapi.yaml');
export const eventsDir = path.join(contractsRoot, 'events');
export const generatedDir = path.join(contractsRoot, 'generated');

export function bin(name) {
  return path.join(contractsRoot, 'node_modules', '.bin', name);
}

export function loadDocument(file = openapiPath) {
  if (!existsSync(file)) return null;
  const doc = parseYaml(readFileSync(file, 'utf8'));
  if (!doc || typeof doc !== 'object') throw new Error(`${file} is not a YAML object`);
  return doc;
}

export function isScaffoldStub(file = openapiPath) {
  return existsSync(file) && readFileSync(file, 'utf8').includes('x-majlis-scaffold-stub: true');
}

/** Path prefix declared by servers[0].url ('/api/v1' for a relative server). */
export function serverBase(doc) {
  const url = doc?.servers?.[0]?.url;
  if (!url || typeof url !== 'string') return '';
  if (url.startsWith('/')) return url.replace(/\/$/, '');
  try {
    return new URL(url).pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Flat list of every operation in the document with its full server path. */
export function listOperations(doc) {
  const base = serverBase(doc);
  const out = [];
  for (const [p, item] of Object.entries(doc?.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      out.push({
        method,
        path: p,
        fullPath: `${base}${p}`,
        operationId: op.operationId,
        operation: op,
        pathItem: item,
      });
    }
  }
  return out;
}

/** Recursively list files under dir with one of the given extensions. */
export function walk(dir, { extensions, skipDirs = new Set() } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!skipDirs.has(entry)) stack.push(full);
      } else if (!extensions || extensions.has(path.extname(entry))) {
        out.push(full);
      }
    }
  }
  return out.sort();
}
