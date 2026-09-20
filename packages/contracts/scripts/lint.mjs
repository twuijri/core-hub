#!/usr/bin/env node
// `pnpm contracts:lint`: Redocly lint of the OpenAPI document, JSON-Schema validity of
// every realtime event schema, and the house rules from ADR 0003 (examples on responses).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import {
  bin,
  contractsRoot,
  eventsDir,
  isScaffoldStub,
  listOperations,
  loadDocument,
  openapiPath,
  walk,
} from './lib.mjs';

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  error  ${msg}`);
};
const warn = (msg) => console.warn(`  warn   ${msg}`);

// 1) OpenAPI document ------------------------------------------------------------
if (!existsSync(openapiPath)) {
  console.log(
    `contracts:lint  openapi.yaml is absent — skipping OpenAPI checks (nothing to lint yet).`,
  );
} else {
  if (isScaffoldStub()) warn('openapi.yaml is still the scaffold placeholder stub.');
  console.log('contracts:lint  redocly lint openapi.yaml');
  try {
    execFileSync(
      bin('redocly'),
      ['lint', 'openapi.yaml', '--config', 'redocly.yaml', '--format', 'stylish'],
      {
        cwd: contractsRoot,
        stdio: 'inherit',
        env: { ...process.env, REDOCLY_TELEMETRY: 'off', REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true' },
      },
    );
  } catch {
    fail('redocly lint reported problems');
  }

  const doc = loadDocument();
  if (!String(doc.openapi ?? '').startsWith('3.1'))
    fail(`openapi must be 3.1.x (ADR 0003), got ${doc.openapi}`);
  for (const { method, path: p, operation, operationId } of listOperations(doc)) {
    const label = `${method.toUpperCase()} ${p}`;
    if (!operationId) fail(`${label}: missing operationId`);
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (!/^2\d\d$/.test(status)) continue;
      const json = response?.content?.['application/json'];
      if (!json) continue;
      const hasExample =
        json.example !== undefined ||
        (json.examples && Object.keys(json.examples).length > 0) ||
        json.schema?.example !== undefined ||
        (typeof json.schema?.$ref === 'string' && refHasExample(doc, json.schema.$ref));
      if (!hasExample) fail(`${label}: ${status} response has no example (ADR 0003 requires one)`);
    }
    const body = operation.requestBody?.content?.['application/json'];
    if (
      body &&
      body.example === undefined &&
      !body.examples &&
      body.schema?.example === undefined
    ) {
      const viaRef = typeof body.schema?.$ref === 'string' && refHasExample(doc, body.schema.$ref);
      if (!viaRef) fail(`${label}: request body has no example (ADR 0003 requires one)`);
    }
  }
}

function refHasExample(doc, ref) {
  if (!ref.startsWith('#/')) return false;
  const node = ref
    .slice(2)
    .split('/')
    .reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), doc);
  return node?.example !== undefined || (node?.examples && node.examples.length > 0);
}

// 2) Realtime event schemas --------------------------------------------------------
const eventFiles = walk(eventsDir, { extensions: new Set(['.json', '.yaml', '.yml']) });
if (eventFiles.length === 0) {
  console.log('contracts:lint  events/ has no schema files yet — skipping event checks.');
} else {
  console.log(`contracts:lint  validating ${eventFiles.length} event schema file(s)`);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const file of eventFiles) {
    const rel = path.relative(contractsRoot, file);
    let schema;
    try {
      schema = parseYaml(readFileSync(file, 'utf8'));
    } catch (error) {
      fail(`${rel}: cannot parse (${error.message})`);
      continue;
    }
    if (!schema || typeof schema !== 'object') {
      fail(`${rel}: not a schema object`);
      continue;
    }
    // Support either one schema per file or a map of event name -> schema.
    const entries = looksLikeSchema(schema)
      ? [
          [
            path
              .basename(file)
              .replace(/\.schema\.json$/, '')
              .replace(/\.json$/, ''),
            schema,
          ],
        ]
      : Object.entries(schema);
    for (const [name, eventSchema] of entries) {
      if (!looksLikeSchema(eventSchema)) {
        fail(`${rel}: "${name}" is not a JSON Schema`);
        continue;
      }
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name) && !/^[a-z][a-z0-9_-]*$/.test(name)) {
        warn(`${rel}: "${name}" does not look like <entity>.<verb> (ARCHITECTURE §Realtime)`);
      }
      try {
        ajv.compile(eventSchema);
      } catch (error) {
        fail(`${rel}: "${name}" is not a valid JSON Schema (${error.message})`);
      }
    }
  }
}

function looksLikeSchema(value) {
  return (
    value &&
    typeof value === 'object' &&
    ('type' in value ||
      '$ref' in value ||
      'properties' in value ||
      'oneOf' in value ||
      'anyOf' in value ||
      'allOf' in value)
  );
}

if (failures > 0) {
  console.error(`contracts:lint  FAILED with ${failures} problem(s)`);
  process.exit(1);
}
console.log('contracts:lint  OK');
