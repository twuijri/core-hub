// Prepares the OpenAPI document for the Kotlin generator (apps/android).
//
// openapi-generator 7.x reads OpenAPI 3.1 nullability poorly for Kotlin: a property written
// `oneOf: [{ $ref: Ulid }, { type: 'null' }]` (or `type: [string, 'null']`) that is also in
// `required` comes out as a non-null `String`, and kotlinx.serialization then refuses the
// hub's real `null`. It also wraps an inline `oneOf [X, null]` in a class of its own
// (`JobAllOfFinishedAt`). This pass rewrites a copy of the document — never the source — so
// that every property that may be null becomes a plain optional one: the `null` branch is
// dropped and the property leaves `required`. Kotlin then declares it `T? = null`, which is
// exactly what the contract says. Nothing else changes.
//
//   import { prepareForKotlin } from './kotlin-openapi.mjs';
//   const copy = prepareForKotlin(structuredClone(doc));

/** The line of the generated `Serializer.kt` that the Kotlin JSON options are added after. */
export const KOTLIN_JSON_ANCHOR = 'encodeDefaults = true';
export const KOTLIN_JSON_OPTIONS = 'encodeDefaults = true\n            explicitNulls = false';

const isNullType = (s) => !!s && typeof s === 'object' && s.type === 'null' && !s.$ref;

/** True when the schema itself admits `null`. `components` resolves one level of `$ref`. */
export function admitsNull(schema, components = {}, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.nullable === true) return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  for (const key of ['oneOf', 'anyOf'])
    if (Array.isArray(schema[key]) && schema[key].some(isNullType)) return true;
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    if (seen.has(name) || !(name in components)) return false;
    seen.add(name);
    return admitsNull(components[name], components, seen);
  }
  return false;
}

/** Drops the `null` branch of a schema in place; returns the schema to use. */
export function withoutNull(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    const rest = schema.type.filter((t) => t !== 'null');
    schema.type = rest.length === 1 ? rest[0] : rest;
  }
  if (Array.isArray(schema.enum) && schema.enum.includes(null))
    schema.enum = schema.enum.filter((v) => v !== null);
  delete schema.nullable;
  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(schema[key]) || !schema[key].some(isNullType)) continue;
    const rest = schema[key].filter((s) => !isNullType(s));
    if (rest.length === 1) {
      const siblings = { ...schema };
      delete siblings[key];
      const only = rest[0];
      // `$ref` with siblings is valid 3.1; the generator keeps the `$ref` type.
      return only.$ref ? { ...siblings, $ref: only.$ref } : { ...siblings, ...only };
    }
    schema[key] = rest;
  }
  return schema;
}

function visit(node, components) {
  if (Array.isArray(node)) {
    node.forEach((child) => visit(child, components));
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node.properties && typeof node.properties === 'object') {
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    for (const [name, prop] of Object.entries(node.properties)) {
      if (admitsNull(prop, components)) {
        required.delete(name);
        node.properties[name] = withoutNull(prop);
      }
    }
    if (Array.isArray(node.required)) node.required = node.required.filter((n) => required.has(n));
  }
  for (const value of Object.values(node)) visit(value, components);
}

/** The properties of an object schema, following `allOf` and `$ref`. */
function collectProperties(schema, components, out = {}) {
  if (!schema || typeof schema !== 'object') return out;
  if (typeof schema.$ref === 'string')
    return collectProperties(components[schema.$ref.split('/').pop()], components, out);
  for (const part of schema.allOf ?? []) collectProperties(part, components, out);
  Object.assign(out, structuredClone(schema.properties ?? {}));
  return out;
}

/**
 * A `oneOf` of objects told apart by a discriminator (only `ContentBlock` today) becomes one
 * object with every variant's properties, all optional but the discriminator, whose values
 * are the mapping's keys. kotlinx.serialization cannot read the generator's polymorphic
 * interface (the discriminator is also a property of every variant); a flat class with a
 * `type` enum reads every block the hub sends, and a client switches on `type`.
 */
export function flattenDiscriminated(components) {
  for (const [name, schema] of Object.entries(components)) {
    const tag = schema?.discriminator?.propertyName;
    if (!tag || !Array.isArray(schema.oneOf)) continue;
    const properties = {};
    for (const variant of schema.oneOf) collectProperties(variant, components, properties);
    const values = Object.keys(schema.discriminator.mapping ?? {});
    properties[tag] = { type: 'string', enum: values };
    components[name] = {
      ...(schema.description ? { description: schema.description } : {}),
      type: 'object',
      required: [tag],
      properties,
    };
  }
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * Parameters declared on a path item (`/sessions/{session_id}/runs: parameters: [...]`) are
 * copied into each of its operations. The generator drops them from an operation that also
 * declares parameters of its own, so `createRun` came out without its `session_id`.
 */
export function inlinePathParameters(doc) {
  const params = doc?.components?.parameters ?? {};
  const key = (p) => {
    const r = typeof p?.$ref === 'string' ? params[p.$ref.split('/').pop()] : p;
    return r ? `${r.in}:${r.name}` : JSON.stringify(p);
  };
  for (const item of Object.values(doc?.paths ?? {})) {
    if (!item || !Array.isArray(item.parameters)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const ownKeys = new Set(own.map(key));
      op.parameters = [...item.parameters.filter((p) => !ownKeys.has(key(p))), ...own];
    }
    delete item.parameters;
  }
}

/**
 * A form field (`multipart/form-data`) whose schema is a `$ref` to an enum with a default
 * comes out as `purpose: AttachmentPurpose? = message` — an unquoted, unresolved default that
 * does not compile. The field gets an inline copy of the enum without its default; the hub
 * applies the default when the field is absent, as the contract says.
 */
export function inlineFormEnums(doc) {
  const components = doc?.components?.schemas ?? {};
  for (const item of Object.values(doc?.paths ?? {})) {
    for (const method of METHODS) {
      const content = item?.[method]?.requestBody?.content ?? {};
      for (const [type, media] of Object.entries(content)) {
        if (!type.startsWith('multipart/') && type !== 'application/x-www-form-urlencoded')
          continue;
        for (const [name, prop] of Object.entries(media?.schema?.properties ?? {})) {
          const target =
            typeof prop?.$ref === 'string' ? components[prop.$ref.split('/').pop()] : null;
          if (!target || !Array.isArray(target.enum) || !('default' in target)) continue;
          const copy = structuredClone(target);
          delete copy.default;
          media.schema.properties[name] = copy;
        }
      }
    }
  }
}

export function prepareForKotlin(doc) {
  const components = doc?.components?.schemas ?? {};
  inlinePathParameters(doc);
  inlineFormEnums(doc);
  flattenDiscriminated(components);
  // Resolve against the untouched shapes first, so a `$ref` to a nullable schema still counts.
  const original = structuredClone(components);
  visit(doc, original);
  // A component that is itself `X | null` (used through `$ref`) becomes plain `X`; the
  // properties pointing at it were made optional above.
  for (const [name, schema] of Object.entries(components))
    if (admitsNull(schema, {})) components[name] = withoutNull(schema);
  return doc;
}
