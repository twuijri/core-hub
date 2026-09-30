/**
 * Free text that may carry a credential — an agent's stderr, an error it returned — made safe
 * to show a person or keep with a run: what looks like a key is replaced by `[redacted]`.
 *
 * By shape, since nothing else is known about such text: a bearer token, a `key=value` or
 * `"key": "value"` whose name says key, token, secret or password, the prefixes providers
 * give their keys (`sk-…`, `ghp_…`, `xai-…`, `AIza…`), a JWT, and any long unbroken run of
 * letters and digits. A path, a model name or a version is left alone.
 */
const PATTERNS: readonly [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [
    /(["']?[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|credential|auth)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\b|\[redacted\])[^\s"',}]{4,}/gi,
    '$1[redacted]',
  ],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|github_pat|xai|glpat|hf)_[A-Za-z0-9_]{12,}/g, '[redacted]'],
  [/\bxai-[A-Za-z0-9]{12,}/g, '[redacted]'],
  // The model gateway's own tokens (ADR 0029; a Hermes profile's, DECISIONS §143).
  [/\bchgwh?_[A-Za-z0-9_.-]{16,}/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/\b[A-Za-z0-9]{40,}\b/g, '[redacted]'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
