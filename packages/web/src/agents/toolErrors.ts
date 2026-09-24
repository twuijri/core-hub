/**
 * The agent tool pages' refusals in the person's language — and Hermes's own sentence, unchanged,
 * wherever Hermes gave one. A pack that is refused says which skill and which file.
 */
import { HubApiError } from '@corehub/contracts';
import { describeError } from '../auth/client.js';

type T = (key: string, p?: Record<string, string | number>) => string;

interface Details {
  reason?: string;
  message?: string;
  skill?: string | null;
  file?: string | null;
  profile?: string;
  limit?: number;
  length?: number;
}

/** Every reason the import route can give (`skill-import.ts`, `zip.ts` on the hub). */
export const IMPORT_REASONS = [
  'pack_unrecognised',
  'pack_has_no_skill',
  'pack_path_unsafe',
  'pack_unsupported',
  'pack_corrupt',
  'pack_too_large',
  'skill_empty',
  'skill_too_large',
  'skill_front_matter_missing',
  'skill_front_matter_unclosed',
  'skill_front_matter_invalid',
  'skill_name_required',
  'skill_description_required',
  'skill_description_too_long',
  'skill_body_empty',
  'skill_name_invalid',
  'skill_not_utf8',
  'skill_nested',
  'skill_duplicate',
  'skill_exists',
] as const;

/**
 * `nameOf` turns a Hermes profile id in a refusal into the name people gave that profile
 * (contract decision §44); without it the id is shown.
 */
export function describeToolError(
  error: unknown,
  t: T,
  nameOf: (profile: string) => string = (profile) => profile,
): string {
  if (error instanceof HubApiError) {
    const details = (error.body as { details?: Details } | undefined)?.details;
    const reason = details?.reason;
    if (reason && (IMPORT_REASONS as readonly string[]).includes(reason)) {
      const lead = t(`skills.import.reason.${reason}`, { skill: details?.skill ?? '' });
      const where = details?.file ? ` (${details.file})` : '';
      // The hub's precise sentence (a line number, a size) follows the translated lead.
      return details?.message ? `${lead}${where}: ${details.message}` : `${lead}${where}`;
    }
    switch (reason) {
      case 'hermes_not_supervised':
        return t('agents.tools.not_supervised');
      case 'hermes_refused':
        return t('agents.tools.refused', { message: details?.message ?? '' });
      case 'hermes_api_unavailable':
        return t('agents.tools.api_unavailable', { message: details?.message ?? '' });
      case 'hermes_profile_absent':
        return t('agents.tools.profile_absent', { profile: details?.profile ?? '' });
      case 'runtime_absent':
        return t('agents.tools.runtime_absent');
      case 'login_not_supported':
        return t('channels.login.not_supported');
      case 'not_linked':
        return t('channels.unlink_not_linked');
      case 'unlink_not_supported':
        return t('channels.unlink_not_supported');
      case 'token_invalid':
        return t('channels.telegram.token_invalid');
      case 'token_rejected':
        return t('channels.telegram.token_rejected', { message: details?.message ?? '' });
      case 'telegram_unreachable':
        return t('channels.telegram.unreachable');
      case 'token_in_use':
        return t('channels.telegram.token_in_use', {
          profile: details?.profile ? nameOf(details.profile) : '',
        });
      case 'skill_bundled':
        return t('skills.bundled_refused');
      case 'plugin_bundled':
        return t('agent_plugins.bundled_refused');
      case 'memory_too_long':
        return t('memory.too_long', { limit: details?.limit ?? 0, length: details?.length ?? 0 });
    }
  }
  return describeError(error, t);
}
