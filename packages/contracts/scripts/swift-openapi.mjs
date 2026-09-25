// Prepares a copy of the OpenAPI document for the Swift generator (apps/ios). The source
// document is never rewritten; `generate-native.mjs` writes the copy next to the output.
//
// openapi-generator 7.x (`swift6`) reads four things in our 3.1 document wrongly, each seen
// in a generated client (docs/changes/2026-09-25-twuijri-ios-shell-chat.md and
// docs/changes/2026-09-25-twuijri-integration.md):
//
// 1. Nullability through `$ref`. `category_id: oneOf [{ $ref: Ulid }, { type: 'null' }]` in
//    `required` came out as a non-optional `String`, so decoding the hub's real `null` fails
//    and the whole list with it; an inline `oneOf [X, null]` inside `allOf` became a wrapper
//    type of its own (`JobAllOfStartedAt`). Every property that may be null becomes a plain
//    optional one: the `null` branch goes and the property leaves `required`. Swift then
//    declares it `T?`, which is what the contract says.
// 2. Path-item parameters. `/sessions/{session_id}/runs` declares `session_id` and the
//    profile header once for the path; the generator drops them from an operation that also
//    has parameters of its own, so `sessionsCreateRun` had no session id. They are copied
//    into each operation.
// 3. Names Swift already uses. A model named `Task` hides Swift's `Task` inside the client
//    (`Task.checkCancellation()` no longer compiles) and `Locale` hides Foundation's. Those
//    components are renamed with a `Hub` prefix everywhere they are referenced.
// 4. A boolean pinned to one value became `enum Applied: Bool`, which does not compile, and
//    the `webhooks` section (calls the hub makes) wrote a `NotifyAPI` over the one holding the
//    `notify.*` operations. Both passes are shared with Kotlin (scripts/kotlin-openapi.mjs).
//
//   import { prepareForSwift } from './swift-openapi.mjs';
//   const copy = prepareForSwift(structuredClone(doc));

import { dropWebhooks, plainBooleans } from './kotlin-openapi.mjs';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const SCHEMA_REF = '#/components/schemas/';

/** Components renamed because Swift or Foundation already owns the name. */
export const SWIFT_RENAMES = { Task: 'HubTask', Locale: 'HubLocale' };

const isNullType = (s) => !!s && typeof s === 'object' && s.type === 'null' && !s.$ref;

/** Whether `schema` admits `null`, following one `$ref` into `components`. */
export function admitsNull(schema, components = {}, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  for (const key of ['oneOf', 'anyOf'])
    if (Array.isArray(schema[key]) && schema[key].some(isNullType)) return true;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith(SCHEMA_REF)) {
    const name = schema.$ref.slice(SCHEMA_REF.length);
    if (seen.has(name) || !(name in components)) return false;
    seen.add(name);
    return admitsNull(components[name], components, seen);
  }
  return false;
}

/** The same schema without its `null` branch. */
export function withoutNull(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  let out = { ...schema };
  if (Array.isArray(out.type) && out.type.includes('null')) {
    const rest = out.type.filter((t) => t !== 'null');
    out.type = rest.length === 1 ? rest[0] : rest;
  }
  if (Array.isArray(out.enum) && out.enum.includes(null))
    out.enum = out.enum.filter((v) => v !== null);
  delete out.nullable;
  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(out[key]) || !out[key].some(isNullType)) continue;
    const rest = out[key].filter((s) => !isNullType(s));
    if (rest.length === 1) {
      const siblings = { ...out };
      delete siblings[key];
      out = { ...siblings, ...rest[0] };
    } else out[key] = rest;
  }
  return out;
}

function makeNullablesOptional(node, components) {
  if (Array.isArray(node)) {
    for (const child of node) makeNullablesOptional(child, components);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    const optional = new Set();
    for (const [name, prop] of Object.entries(node.properties)) {
      if (!admitsNull(prop, components)) continue;
      optional.add(name);
      node.properties[name] = withoutNull(prop);
    }
    if (Array.isArray(node.required)) {
      node.required = node.required.filter((name) => !optional.has(name));
      if (node.required.length === 0) delete node.required;
    }
  }
  for (const [key, value] of Object.entries(node))
    if (key !== 'example' && key !== 'examples') makeNullablesOptional(value, components);
}

/** Copies path-item parameters into every operation of the path (point 2 above). */
export function inlinePathParameters(doc) {
  const shared = doc?.components?.parameters ?? {};
  const keyOf = (p) => {
    const resolved = typeof p?.$ref === 'string' ? shared[p.$ref.split('/').pop()] : p;
    return resolved ? `${resolved.in}:${resolved.name}` : JSON.stringify(p);
  };
  for (const item of Object.values(doc?.paths ?? {})) {
    if (!item || !Array.isArray(item.parameters)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const ownKeys = new Set(own.map(keyOf));
      op.parameters = [...item.parameters.filter((p) => !ownKeys.has(keyOf(p))), ...own];
    }
    delete item.parameters;
  }
}

/** Renames components and every `$ref` / discriminator mapping that points at them. */
export function renameComponents(doc, renames) {
  const schemas = doc?.components?.schemas;
  if (!schemas) return;
  for (const [from, to] of Object.entries(renames)) {
    if (!(from in schemas)) continue;
    if (to in schemas) throw new Error(`swift-openapi: cannot rename ${from}, ${to} exists`);
    schemas[to] = schemas[from];
    delete schemas[from];
  }
  const rewrite = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF)) return ref;
    const name = ref.slice(SCHEMA_REF.length);
    return name in renames ? SCHEMA_REF + renames[name] : ref;
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string') node.$ref = rewrite(node.$ref);
    if (node.discriminator?.mapping)
      for (const [k, v] of Object.entries(node.discriminator.mapping))
        node.discriminator.mapping[k] = rewrite(v);
    for (const value of Object.values(node)) walk(value);
  };
  walk(doc);
}

export function prepareForSwift(doc) {
  dropWebhooks(doc);
  plainBooleans(doc);
  inlinePathParameters(doc);
  const components = doc?.components?.schemas ?? {};
  // Judge nullability against the untouched shapes, so a `$ref` to a nullable schema counts.
  const original = structuredClone(components);
  makeNullablesOptional(doc, original);
  // A component that is itself `X | null` (reached through `$ref`) becomes plain `X`; the
  // properties pointing at it were made optional above.
  for (const [name, schema] of Object.entries(components))
    if (admitsNull(schema, {})) components[name] = withoutNull(schema);
  renameComponents(doc, SWIFT_RENAMES);
  return doc;
}
