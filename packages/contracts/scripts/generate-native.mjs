#!/usr/bin/env node
// Generates the Kotlin (Android) and Swift (iOS) clients with openapi-generator-cli.
// Needs a Java runtime. Locally without Java it skips with a warning; in CI it fails.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import {
  KOTLIN_JSON_ANCHOR,
  KOTLIN_JSON_OPTIONS,
  prepareForKotlin,
  withoutPartContentType,
} from './kotlin-openapi.mjs';
import { bin, contractsRoot, generatedDir, loadDocument, openapiPath } from './lib.mjs';
import { prepareForSwift } from './swift-openapi.mjs';

if (!existsSync(openapiPath)) {
  console.warn('contracts:generate:native  openapi.yaml absent — nothing to generate.');
  process.exit(0);
}

function hasJava() {
  try {
    execFileSync('java', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!hasJava()) {
  const message =
    'contracts:generate:native  Java runtime not found; Kotlin/Swift clients not generated.';
  if (process.env.CI) {
    console.error(`${message} CI must install Java (see .github/workflows/ci.yml).`);
    process.exit(1);
  }
  console.warn(`${message} Install a JRE (17+) to generate them locally.`);
  process.exit(0);
}

// Kotlin reads a prepared copy of the document (scripts/kotlin-openapi.mjs: nullable
// properties become optional ones); the source document is never rewritten.
mkdirSync(generatedDir, { recursive: true });
const kotlinInput = path.join(generatedDir, 'openapi.kotlin.yaml');
writeFileSync(kotlinInput, stringify(prepareForKotlin(loadDocument(openapiPath))));

// Swift reads a prepared copy of the document (scripts/swift-openapi.mjs: nullable
// properties become optional ones, path parameters reach every operation, names Swift owns
// are prefixed); the source document is never rewritten.
const swiftInput = path.join(generatedDir, 'openapi.swift.yaml');
writeFileSync(swiftInput, stringify(prepareForSwift(loadDocument(openapiPath))));

const targets = [
  { name: 'kotlin', config: 'openapi-generator/kotlin.yaml', input: kotlinInput },
  { name: 'swift', config: 'openapi-generator/swift.yaml', input: swiftInput },
];

for (const { name, config, input } of targets) {
  const out = path.join(generatedDir, name);
  rmSync(out, { recursive: true, force: true });
  console.log(`contracts:generate:native  ${name} -> ${path.relative(process.cwd(), out)}`);
  execFileSync(
    bin('openapi-generator-cli'),
    [
      'generate',
      '-i',
      input,
      '-c',
      path.join(contractsRoot, config),
      '-o',
      out,
      '--skip-validate-spec',
    ],
    {
      cwd: contractsRoot,
      stdio: 'inherit',
      env: { ...process.env, JAVA_OPTS: process.env.JAVA_OPTS ?? '-Dlog.level=warn' },
    },
  );
}
// The generated JSON writes every `null` a model holds, so a PATCH built from a model would
// clear every field it did not mean to touch. Leave nulls out (the contract's optional
// fields are absent, not null) and read an absent nullable field as null.
const serializer = path.join(
  generatedDir,
  'kotlin/src/main/kotlin/hub/core/client/infrastructure/Serializer.kt',
);
const source = readFileSync(serializer, 'utf8');
if (!source.includes(KOTLIN_JSON_ANCHOR)) {
  console.error(`contracts:generate:native  ${serializer} no longer has "${KOTLIN_JSON_ANCHOR}".`);
  process.exit(1);
}
writeFileSync(serializer, source.replace(KOTLIN_JSON_ANCHOR, KOTLIN_JSON_OPTIONS));
// A multipart part must not carry its own Content-Type header for OkHttp (kotlin-openapi.mjs).
const apiClient = path.join(
  generatedDir,
  'kotlin/src/main/kotlin/hub/core/client/infrastructure/ApiClient.kt',
);
try {
  writeFileSync(apiClient, withoutPartContentType(readFileSync(apiClient, 'utf8')));
} catch (error) {
  console.error(
    `contracts:generate:native  ${String(error instanceof Error ? error.message : error)}`,
  );
  process.exit(1);
}
console.log('contracts:generate:native  OK');
