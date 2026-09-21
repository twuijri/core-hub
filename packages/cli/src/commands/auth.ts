// login · logout · whoami
import { HubApiError } from '@majlis/contracts';
import type { CommandSpec } from '../args.js';
import { anonymousClient, expiresAt, normaliseServer } from '../client.js';
import type { CommandContext } from '../context.js';
import { CliError, isConnectionError } from '../errors.js';
import type { Meta } from '../types.js';
import { optionString, requireSession } from './shared.js';

export const loginCommand: CommandSpec = {
  path: ['login'],
  description: 'cmd.login',
  options: {
    username: { type: 'string', short: 'u', description: 'option.username', value: 'NAME' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const server = normaliseServer(ctx.globals.server ?? ctx.store.session()?.server);
    const anonymous = anonymousClient({ server, language: ctx.language });

    let meta: Meta | undefined;
    try {
      meta = (await anonymous.request('get', '/meta')).data;
    } catch (error) {
      if (isConnectionError(error)) throw error;
      // A hub that has not implemented `meta.get` yet still signs people in.
      if (!(error instanceof HubApiError && error.status === 501)) throw error;
    }
    if (meta?.setup_required) throw new CliError('errors.setup_required');
    if (meta && !ctx.globals.json)
      ctx.out.notice(
        ctx.out.style.dim(
          t('login.hub', {
            name: meta.name,
            version: meta.server_version,
            contract: meta.contract_version,
          }),
        ),
      );

    const username = optionString(ctx, 'username') ?? (await ctx.prompter.ask(t('login.username')));
    if (!username) throw new CliError('errors.interrupted');
    const password = await ctx.prompter.ask(t('login.password'), { hidden: true });
    if (password === null) throw new CliError('errors.interrupted');

    const { data } = await anonymous.request('post', '/auth/login', {
      body: { username: username.trim(), password },
    });
    const session = {
      server,
      profile: ctx.globals.profile ?? data.user.default_profile,
      token: data.access_token,
      token_kind: 'session' as const,
      refresh_token: data.refresh_token,
      expires_at: expiresAt(data.expires_in),
      user: pickUser(data.user),
    };
    ctx.store.saveSession(session);
    if (ctx.globals.json) {
      ctx.out.json({ server, profile: session.profile, user: data.user });
    } else {
      ctx.out.line(
        t('login.success', {
          username: data.user.username,
          role: data.user.role,
          profile: session.profile,
        }),
      );
      ctx.out.line(ctx.out.style.dim(t('login.stored', { file: ctx.store.file })));
    }
    return 0;
  },
};

export const logoutCommand: CommandSpec = {
  path: ['logout'],
  description: 'cmd.logout',
  async run(ctx: CommandContext): Promise<number> {
    const session = ctx.store.session();
    if (!session) {
      ctx.out.line(ctx.t('logout.nothing'));
      return 0;
    }
    try {
      await requireSession(ctx).client.request('post', '/auth/logout');
    } catch (error) {
      // Already revoked or expired on the hub: forgetting it locally is still right.
      if (!(error instanceof HubApiError && (error.status === 401 || error.status === 403)))
        throw error;
    } finally {
      ctx.store.clearSession();
    }
    if (ctx.globals.json) ctx.out.json({ server: session.server, signed_out: true });
    else ctx.out.line(ctx.t('logout.done', { server: session.server }));
    return 0;
  },
};

export const whoamiCommand: CommandSpec = {
  path: ['whoami'],
  description: 'cmd.whoami',
  async run(ctx: CommandContext): Promise<number> {
    const auth = requireSession(ctx);
    const { data: user } = await auth.client.request('get', '/auth/me');
    const session = auth.session();
    const profile = ctx.globals.profile ?? session.profile;
    if (ctx.globals.json) {
      ctx.out.json({ server: session.server, profile, token_kind: session.token_kind, user });
      return 0;
    }
    const { t } = ctx;
    ctx.out.kv([
      [t('whoami.user'), user.username],
      [t('whoami.name'), user.display_name],
      [t('whoami.role'), user.role],
      [t('whoami.server'), session.server],
      [t('whoami.profile'), profile],
      [t('whoami.profiles'), user.profiles.join(', ') || t('common.none')],
      [
        t('whoami.token'),
        t(session.token_kind === 'app' ? 'whoami.token_app' : 'whoami.token_session'),
      ],
    ]);
    return 0;
  },
};

export function pickUser(user: {
  id: string;
  username: string;
  display_name: string;
  role: string;
}): { id: string; username: string; display_name: string; role: string } {
  return { id: user.id, username: user.username, display_name: user.display_name, role: user.role };
}
