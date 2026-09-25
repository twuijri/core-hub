/**
 * The webhook catalogue (decision §59) is one list in the contract: `WebhookEventName`'s enum
 * and its `x-webhook-events`. The hub serves it and forwards exactly those events, and it
 * leaves out the content fields it names. These tests keep the three halves of that list —
 * the names, the realtime schema each one's `data` follows, and the content paths — from
 * drifting apart.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractsRoot, loadOpenApiDocument } from '../src/document.js';
import { derived } from '../src/product.js';

type Schema = Record<string, unknown>;

interface CatalogueEntry {
  source: string;
  description: { ar: string; en: string };
  content: string[];
}

const doc = loadOpenApiDocument() as unknown as {
  components: { schemas: Record<string, Schema> };
  webhooks?: Record<string, { post?: { parameters?: Array<{ name: string; in: string }> } }>;
};
const eventName = doc.components.schemas.WebhookEventName as Schema & {
  enum: string[];
  'x-webhook-events': Record<string, CatalogueEntry>;
};

/** The properties a schema declares, through `$ref` into `$defs` and `allOf`. */
function propertiesOf(schema: Schema, defs: Record<string, Schema>): Record<string, Schema> {
  const ref = schema.$ref as string | undefined;
  if (ref) return propertiesOf(defs[ref.replace('#/$defs/', '')] ?? {}, defs);
  const merged: Record<string, Schema> = {
    ...((schema.properties as Record<string, Schema>) ?? {}),
  };
  for (const part of (schema.allOf as Schema[] | undefined) ?? []) {
    Object.assign(merged, propertiesOf(part, defs));
  }
  for (const part of (schema.oneOf as Schema[] | undefined) ?? []) {
    Object.assign(merged, propertiesOf(part, defs));
  }
  return merged;
}

describe('webhook event catalogue (decision §59)', () => {
  const catalogue = eventName['x-webhook-events'];

  it('describes every name, and names nothing it does not describe', () => {
    expect(Object.keys(catalogue).sort()).toEqual([...eventName.enum].sort());
    for (const [name, entry] of Object.entries(catalogue)) {
      expect(entry.description.ar, name).toBeTruthy();
      expect(entry.description.en, name).toBeTruthy();
      expect(Array.isArray(entry.content), name).toBe(true);
    }
  });

  it('covers the events the owner asked a webhook to receive', () => {
    for (const name of [
      'run.completed',
      'run.failed',
      'approval.requested',
      'task.moved',
      'task.assigned',
      'schedule_run.completed',
      'workflow_run.completed',
      'workflow_run.failed',
      'step.waiting',
      'notice.created',
    ]) {
      expect(eventName.enum).toContain(name);
    }
  });

  it('points each name at a realtime schema, and each content path at a field of its payload', () => {
    for (const [name, entry] of Object.entries(catalogue)) {
      const file = path.join(contractsRoot(), 'events', entry.source, `${name}.schema.json`);
      expect(existsSync(file), file).toBe(true);
      const schema = JSON.parse(readFileSync(file, 'utf8')) as Schema;
      const defs = (schema.$defs as Record<string, Schema>) ?? {};
      const payload = (schema.properties as Record<string, Schema>).payload!;
      for (const dotted of entry.content) {
        let current: Schema = payload;
        for (const key of dotted.split('.')) {
          const properties = propertiesOf(current, defs);
          expect(properties, `${name}: ${dotted}`).toHaveProperty(key);
          current = properties[key]!;
        }
      }
    }
  });

  it('documents the headers the hub sends under the names it sends them', () => {
    const headers = (doc.webhooks?.hubEvent?.post?.parameters ?? [])
      .filter((p) => p.in === 'header')
      .map((p) => p.name.toLowerCase());
    expect(headers).toEqual(
      expect.arrayContaining([
        derived.webhookSignatureHeader,
        derived.webhookEventHeader,
        derived.webhookDeliveryHeader,
      ]),
    );
  });
});
