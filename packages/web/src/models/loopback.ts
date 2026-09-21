/**
 * The container trap, in two pure functions.
 *
 * The hub runs in a container on the owner's server, so `http://127.0.0.1:1234/v1` — the
 * address LM Studio and Ollama print in their own UI — is the *container's* loopback and
 * reaches nothing. The hub reports whether it is containerized
 * (`models.listProviderPresets` → `host`); the client warns, and suggests the host alias.
 *
 * It never rewrites what somebody typed: a hub that edits your address is a hub you
 * cannot debug, and the alias is wrong on a host that did not map it.
 */
import type { ProviderHost } from '../types.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The same URL with the container-to-host alias in place of loopback. A suggestion. */
export function suggestedHostUrl(url: string, host: ProviderHost): string {
  try {
    const parsed = new URL(url);
    parsed.hostname = host.loopback_alias;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** Whether this address, on this hub, deserves the warning. */
export function needsLoopbackWarning(url: string, host: ProviderHost | undefined): boolean {
  return Boolean(host?.containerized) && isLoopbackUrl(url);
}
