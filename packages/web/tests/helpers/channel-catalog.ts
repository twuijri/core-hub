/**
 * The hub's platform catalog as `agents.listChannelPlatforms` serves it, built from the server's
 * own declaration so a component test never drifts from what the hub says.
 */
import { PLATFORMS } from '../../../server/src/modules/agents/channel-platforms.js';
import type { ChannelPlatform } from '../../src/agents/skills.js';

export function catalogOf(): ChannelPlatform[] {
  const order = { full: 0, generic: 1 } as const;
  return [...PLATFORMS]
    .sort((a, b) => order[a.support] - order[b.support])
    .map((spec) => ({
      platform: spec.platform,
      label: spec.label,
      support: spec.support,
      login: spec.login,
      credentials: spec.credentials.map(({ key, kind, required }) => ({ key, kind, required })),
      allowed_users_key: spec.allowedUsers?.key ?? null,
      validates: spec.validates,
      pairs: spec.pairs,
      allowlist: spec.allowlist,
      settings: spec.settings !== null || spec.platform === 'telegram',
      exclusive: spec.exclusive,
      packages: spec.packages,
      inbound: spec.inbound,
      program: spec.program,
      docs_url: spec.docsUrl,
    }));
}
