#!/usr/bin/env node
// Generates the Kotlin (Android) and Swift (iOS) clients with openapi-generator-cli.
// Needs a Java runtime. Locally without Java it skips with a warning; in CI it fails.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { bin, contractsRoot, generatedDir, openapiPath } from './lib.mjs';

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

const targets = [
  { name: 'kotlin', config: 'openapi-generator/kotlin.yaml' },
  { name: 'swift', config: 'openapi-generator/swift.yaml' },
];

for (const { name, config } of targets) {
  const out = path.join(generatedDir, name);
  rmSync(out, { recursive: true, force: true });
  console.log(`contracts:generate:native  ${name} -> ${path.relative(process.cwd(), out)}`);
  execFileSync(
    bin('openapi-generator-cli'),
    [
      'generate',
      '-i',
      openapiPath,
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
console.log('contracts:generate:native  OK');
