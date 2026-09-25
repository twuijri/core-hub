import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain ESM script without types
import {
  admitsNull,
  plainBooleans,
  prepareForKotlin,
  wideByteCounts,
} from '../scripts/kotlin-openapi.mjs';
// @ts-expect-error — a plain ESM script without types
import { loadDocument } from '../scripts/lib.mjs';

type Schema = Record<string, unknown> & {
  properties?: Record<string, Schema>;
  required?: string[];
};

const ulid = { $ref: '#/components/schemas/Ulid' };

function doc(extra: Record<string, unknown> = {}) {
  return {
    openapi: '3.1.0',
    paths: {
      '/sessions/{session_id}/runs': {
        parameters: [{ $ref: '#/components/parameters/SessionId' }],
        post: {
          operationId: 'sessions.createRun',
          parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
        },
      },
      '/attachments': {
        post: {
          operationId: 'sessions.uploadAttachment',
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: { purpose: { $ref: '#/components/schemas/Purpose' } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      parameters: { SessionId: { name: 'session_id', in: 'path', required: true } },
      schemas: {
        Ulid: { type: 'string' },
        Purpose: { type: 'string', enum: ['message', 'avatar'], default: 'message' },
        MaybeError: { oneOf: [{ $ref: '#/components/schemas/Error' }, { type: 'null' }] },
        Error: { type: 'object', properties: { code: { type: 'string' } } },
        Message: {
          type: 'object',
          required: ['id', 'room_id', 'name', 'error', 'content'],
          properties: {
            id: ulid,
            room_id: { oneOf: [ulid, { type: 'null' }] },
            name: { type: ['string', 'null'] },
            error: { $ref: '#/components/schemas/MaybeError' },
            content: { type: 'array', items: { $ref: '#/components/schemas/Block' } },
          },
        },
        Block: {
          oneOf: [
            { $ref: '#/components/schemas/TextBlock' },
            { $ref: '#/components/schemas/FileBlock' },
          ],
          discriminator: {
            propertyName: 'type',
            mapping: {
              text: '#/components/schemas/TextBlock',
              file: '#/components/schemas/FileBlock',
            },
          },
        },
        TextBlock: {
          type: 'object',
          required: ['type', 'text'],
          properties: { type: { type: 'string', enum: ['text'] }, text: { type: 'string' } },
        },
        FileBlock: {
          allOf: [
            { type: 'object', required: ['attachment_id'], properties: { attachment_id: ulid } },
            { type: 'object', properties: { type: { type: 'string', enum: ['file'] } } },
          ],
        },
      },
    },
    ...extra,
  };
}

describe('prepareForKotlin', () => {
  it('makes every property that may be null an optional one, dropping the null branch', () => {
    const d = prepareForKotlin(doc());
    const message = d.components.schemas.Message as Schema;
    expect(message.required).toEqual(['id', 'content']);
    expect(message.properties?.room_id).toEqual(ulid);
    expect(message.properties?.name).toEqual({ type: 'string' });
    expect(d.components.schemas.MaybeError).toEqual({ $ref: '#/components/schemas/Error' });
  });

  it('flattens a discriminated oneOf into one object told apart by its tag', () => {
    const block = prepareForKotlin(doc()).components.schemas.Block as Schema;
    expect(block.type).toBe('object');
    expect(block.required).toEqual(['type']);
    expect(Object.keys(block.properties ?? {}).sort()).toEqual(['attachment_id', 'text', 'type']);
    expect(block.properties?.type).toEqual({ type: 'string', enum: ['text', 'file'] });
  });

  it('copies path-level parameters into operations that declare their own', () => {
    const op = prepareForKotlin(doc()).paths['/sessions/{session_id}/runs'].post;
    expect(op.parameters).toHaveLength(2);
    expect(op.parameters[0]).toEqual({ $ref: '#/components/parameters/SessionId' });
  });

  it('inlines a form field enum without its default', () => {
    const d = prepareForKotlin(doc());
    const media = d.paths['/attachments'].post.requestBody.content['multipart/form-data'];
    expect(media.schema.properties.purpose).toEqual({
      type: 'string',
      enum: ['message', 'avatar'],
    });
    expect(d.components.schemas.Purpose.default).toBe('message');
  });

  it('drops a boolean pinned to one value, keeping it a plain boolean', () => {
    const node = {
      properties: {
        applied: { type: 'boolean', const: true },
        on: { type: ['boolean', 'null'], enum: [true, null] },
        kind: { type: 'string', enum: ['memory', 'skills'] },
      },
    };
    plainBooleans(node);
    expect(node.properties.applied).toEqual({ type: 'boolean' });
    expect(node.properties.on).toEqual({ type: ['boolean', 'null'] });
    expect(node.properties.kind).toEqual({ type: 'string', enum: ['memory', 'skills'] });
  });

  it('widens every integer byte count to int64, leaving other integers alone', () => {
    const node = {
      properties: {
        memory_total_bytes: { type: 'integer', minimum: 0 },
        rss_bytes: { type: ['integer', 'null'] },
        pid: { type: 'integer' },
        label_bytes: { type: 'string' },
      },
    };
    wideByteCounts(node);
    expect(node.properties.memory_total_bytes).toEqual({
      type: 'integer',
      minimum: 0,
      format: 'int64',
    });
    expect(node.properties.rss_bytes).toEqual({ type: ['integer', 'null'], format: 'int64' });
    expect(node.properties.pid).toEqual({ type: 'integer' });
    expect(node.properties.label_bytes).toEqual({ type: 'string' });
  });

  it('leaves the webhooks out and pins no boolean in the real contract', () => {
    const real = loadDocument();
    expect(real.webhooks).toBeDefined();
    const prepared = prepareForKotlin(structuredClone(real));
    expect(prepared.webhooks).toBeUndefined();
    expect(prepared.components.schemas.PendingWriteApplied.properties.applied).toEqual({
      type: 'boolean',
    });
  });

  it('leaves the source document untouched when given a copy, and covers the real contract', () => {
    const real = loadDocument();
    const before = JSON.stringify(real.components.schemas.Message);
    const prepared = prepareForKotlin(structuredClone(real));
    expect(JSON.stringify(real.components.schemas.Message)).toBe(before);
    const all = Object.values(prepared.components.schemas) as Schema[];
    for (const schema of all)
      for (const [name, prop] of Object.entries(schema.properties ?? {}))
        if (schema.required?.includes(name))
          expect(admitsNull(prop, prepared.components.schemas), name).toBe(false);
  });
});
