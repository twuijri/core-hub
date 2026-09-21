// setup · login · logout · whoami
import { HubApiError } from '@majlis/contracts';
import type { CommandSpec } from '../args.js';
import { anonymousClient, expiresAt, normaliseServer } from '../client.js';
import type { CommandContext } from '../context.js';
import { CliError, isConnectionError } from '../errors.js';
import type { Meta } from '../types.js';
import { optionString, requireSession } from './shared.js';

/**
 * First run (ADR 0011): the hub has no account at all and printed a claim token when it
 * started. This command trades that token for the owner account and keeps the session, so a
 * headless box can be set up over SSH without ever putting a password in the compose file.
 * The token and the password are asked for here, never taken from argv (`args.ts`
 * §SECRET_OPTIONS refuses `--token` and `--password` outright).
 */
export const setupCommand: CommandSpec = {
  path: ['setup'],
  description: 'cmd.setup',
  options: {
    username: { type: 'string', short: 'u', description: 'option.username', value: 'NAME' },
    'display-name': { type: 'string', description: 'option.display_name', value: 'NAME' },
    'workspace-name': { type: 'string', description: 'option.workspace_name', value: 'NAME' },
  },
  async run(ctx: CommandContext): Promise<number> {
    const { t } = ctx;
    const server = normaliseServer(ctx.globals.server ?? ctx.store.session()?.server);
    const anonymous = anonymousClient({ server, language: ctx.language });

    const { data: state } = await anonymous.request('get', '/auth/setup');
    if (!state.required) throw new CliError('errors.setup_done');

    if (!ctx.globals.json) {
      ctx.out.notice(ctx.out.style.dim(t('setup.where', { server })));
    }
    // Shown, not hidden: the hub printed this token in its own log, and a paste the person
    // cannot read back is a paste they cannot check.
    const token = await ctx.prompter.ask(t('setup.token'));
    if (token === null || token.trim() === '') throw new CliError('errors.interrupted');
    const username = optionString(ctx, 'username') ?? (await ctx.prompter.ask(t('setup.username')));
    if (username === null || username.trim() === '') throw new CliError('errors.interrupted');
    const displayName =
      optionString(ctx, 'display-name') ?? (await ctx.prompter.ask(t('setup.display_name')));
    if (displayName === null) throw new CliError('errors.interrupted');
    const workspaceName =
      optionString(ctx, 'workspace-name') ?? (await ctx.prompter.ask(t('setup.workspace_name')));
    if (workspaceName === null) throw new CliError('errors.interrupted');
    const password = await ctx.prompter.ask(t('setup.password'), { hidden: true });
    if (password === null) throw new CliError('errors.interrupted');
    const confirm = await ctx.prompter.ask(t('setup.confirm'), { hidden: true });
    if (confirm === null) throw new CliError('errors.interrupted');
    if (password !== confirm) throw new CliError('errors.password_mismatch');

    const { data } = await anonymous.request('post', '/auth/setup', {
      body: {
        token: token.trim(),
        username: username.trim(),
        password,
        ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        ...(workspaceName.trim() ? { workspace_name: workspaceName.trim() } : {}),
      },
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
      return 0;
    }
    ctx.out.line(
      t('setup.success', { username: data.user.username, profile: session.profile, server }),
    );
    ctx.out.line(ctx.out.style.dim(t('login.stored', { file: ctx.store.file })));
    return 0;
  },
};

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
