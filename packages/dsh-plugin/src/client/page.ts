/**
 * The "Core Hub" page on the harness's Plugins page (the bundle's own configuration,
 * `plugins.bundle.config`, and the row's Configure page, `plugins.row.config`): link by pasting
 * the pairing, the link's state, the shared folders, the harness MCP servers offered to the hub,
 * Hermes's profile, screen tasks, the language, and the recent activity. Every change is written
 * at once through the plugin's host half (`panel.ts`), which keeps the token to itself.
 */
import {
  createElement as h,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { uiLanguage, uiTranslator, type UiTranslate } from '../ui-strings.js';
import type { PanelApi, SettingsPatch, StatusView } from './api.js';
import { PRODUCT_NAMES } from './product.js';

const POLL_MS = 5000;
const GREEN = '#16a34a';
const RED = '#dc2626';
const AMBER = '#d97706';
const BLUE = '#2563eb';

const s = {
  page: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 14,
    fontSize: 14,
    lineHeight: 1.5,
  },
  section: {
    border: '1px solid rgba(127,127,127,0.25)',
    borderRadius: 12,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  title: { margin: 0, fontSize: 15, fontWeight: 600 },
  hint: { margin: 0, fontSize: 13, opacity: 0.7 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    justifyItems: 'start',
    gap: '4px 12px',
    fontSize: 13,
  },
  input: {
    flex: '1 1 240px',
    minWidth: 0,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,0.4)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
  button: {
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,0.45)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  },
  primary: {
    padding: '6px 14px',
    borderRadius: 8,
    border: `1px solid ${BLUE}`,
    background: BLUE,
    color: '#fff',
    cursor: 'pointer',
    font: 'inherit',
  },
  danger: {
    padding: '6px 12px',
    borderRadius: 8,
    border: `1px solid ${RED}`,
    background: 'transparent',
    color: RED,
    cursor: 'pointer',
    font: 'inherit',
  },
};

function browserLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
}

function notice(ok: boolean, text: string): ReactNode {
  return h(
    'div',
    {
      role: ok ? 'status' : 'alert',
      dir: 'auto',
      style: {
        border: `1px solid ${ok ? GREEN : RED}`,
        background: ok ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)',
        color: 'inherit',
        borderRadius: 8,
        padding: '8px 10px',
        whiteSpace: 'pre-wrap',
        unicodeBidi: 'plaintext',
      },
    },
    h('strong', { style: { color: ok ? GREEN : RED } }, ok ? '✓ ' : '✕ '),
    text,
  );
}

function dot(color: string, label: string): ReactNode {
  return h(
    'span',
    { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
    h('span', {
      style: { width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' },
    }),
    label,
  );
}

function section(title: string, ...children: ReactNode[]): ReactNode {
  return h('section', { style: s.section }, h('h4', { style: s.title }, title), ...children);
}

function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false) {
  return h(
    'label',
    { style: { ...s.row, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 } },
    h('input', {
      type: 'checkbox',
      checked,
      disabled,
      onChange: (e: { target: { checked: boolean } }) => onChange(e.target.checked),
    }),
    h('span', { dir: 'auto' }, label),
  );
}

export interface CoreHubPageProps {
  api: PanelApi;
  view?: 'summary' | 'page';
}

/** One line for the row's summary: linked to which hub, or not. */
export function CoreHubSummary({ api }: CoreHubPageProps): ReactNode {
  const [state, setState] = useState<StatusView | null>(null);
  useEffect(() => {
    let live = true;
    api.state().then(
      (v) => live && setState(v),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);
  const lang = uiLanguage(state?.language, browserLanguages());
  const t = uiTranslator(lang, PRODUCT_NAMES[lang]);
  if (!state) return t('page.loading');
  return state.link ? `${state.link.hub} · ${state.link.user}` : t('link.unlinked');
}

export function CoreHubPage({ api, view }: CoreHubPageProps): ReactNode {
  if (view === 'summary') return h(CoreHubSummary, { api });
  return h(CoreHubSettings, { api });
}

function CoreHubSettings({ api }: { api: PanelApi }): ReactNode {
  const [state, setState] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [saveNote, setSaveNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pairing, setPairing] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [relink, setRelink] = useState(false);
  const live = useRef(true);

  const lang = uiLanguage(state?.language, browserLanguages());
  const t: UiTranslate = uiTranslator(lang, PRODUCT_NAMES[lang]);

  const load = useCallback(async () => {
    try {
      const next = await api.state();
      if (live.current) {
        setState(next);
        setError(null);
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    live.current = true;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!saveNote?.ok) return;
    const timer = setTimeout(() => setSaveNote(null), 2500);
    return () => clearTimeout(timer);
  }, [saveNote]);

  const save = async (patch: SettingsPatch) => {
    setBusy('save');
    try {
      const { state: next } = await api.settings(patch);
      setState(next);
      setSaveNote({ ok: true, text: t('saved') });
    } catch (e) {
      setSaveNote({
        ok: false,
        text: t('save.failed', { reason: e instanceof Error ? e.message : String(e) }),
      });
    } finally {
      setBusy(null);
    }
  };

  const act = async (
    name: string,
    run: () => Promise<{ outcome: { ok: boolean; text: string }; state: StatusView }>,
  ) => {
    setBusy(name);
    setResult(null);
    try {
      const { outcome, state: next } = await run();
      setState(next);
      setResult(outcome);
      if (name === 'link' && outcome.ok) {
        setPairing('');
        setRelink(false);
      }
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!state)
    return h(
      'div',
      { style: s.page, dir: lang === 'ar' ? 'rtl' : 'ltr' },
      error
        ? h(
            'div',
            { style: s.row },
            notice(false, t('page.error', { reason: error })),
            h(
              'button',
              { type: 'button', style: s.button, onClick: () => void load() },
              t('page.retry'),
            ),
          )
        : h('p', { style: s.hint }, t('page.loading')),
    );

  const link = state.link;
  const connection = link?.status ?? 'unlinked';
  const connColor =
    connection === 'connected'
      ? GREEN
      : connection === 'refused'
        ? RED
        : connection === 'connecting'
          ? AMBER
          : 'gray';

  // ---------------------------------------------------------------- link section
  const pasteForm = [
    h(
      'label',
      { key: 'l', htmlFor: 'corehub-pairing', style: { fontWeight: 600, fontSize: 13 } },
      t('link.paste'),
    ),
    h('p', { key: 'h', style: s.hint, dir: 'auto' }, t('link.paste.hint')),
    h(
      'div',
      { key: 'r', style: s.row },
      h('textarea', {
        id: 'corehub-pairing',
        value: pairing,
        rows: 2,
        dir: 'ltr',
        spellCheck: false,
        autoComplete: 'off',
        placeholder: '{"type":"corehub.pairing",…}',
        style: { ...s.input, ...s.mono, resize: 'vertical' },
        onChange: (e: { target: { value: string } }) => setPairing(e.target.value),
      }),
      h(
        'button',
        {
          type: 'button',
          style: { ...s.primary, opacity: !pairing.trim() || busy ? 0.6 : 1 },
          disabled: !pairing.trim() || !!busy,
          onClick: () => void act('link', () => api.link(pairing.trim())),
        },
        busy === 'link' ? t('link.busy') : t('link.button'),
      ),
    ),
  ];

  const linkSection = section(
    t('link.title'),
    link
      ? h(
          'div',
          { style: s.grid },
          h('span', { style: { opacity: 0.7 } }, t('link.connection')),
          h('span', null, dot(connColor, t(`conn.${connection}` as never))),
          h('span', { style: { opacity: 0.7 } }, t('link.hub')),
          h('bdi', { style: s.mono }, link.hub),
          h('span', { style: { opacity: 0.7 } }, t('link.user')),
          h('bdi', null, link.user),
          h('span', { style: { opacity: 0.7 } }, t('link.device')),
          h('bdi', { style: s.mono }, link.deviceId),
          ...(link.tokenExpires
            ? [
                h('span', { key: 'te', style: { opacity: 0.7 } }, t('link.token')),
                h(
                  'bdi',
                  { key: 'tv', style: s.mono },
                  link.tokenExpires.slice(0, 16).replace('T', ' '),
                ),
              ]
            : []),
          h('span', { style: { opacity: 0.7 } }, t('link.models')),
          h(
            'span',
            { dir: 'auto' },
            state.models === null
              ? '—'
              : state.models.ok
                ? t('link.models.count', { count: state.models.ids.length })
                : h('span', { style: { color: RED } }, state.models.detail || state.models.reason),
          ),
        )
      : h('p', { style: { margin: 0 } }, dot('gray', t('link.unlinked'))),
    result ? notice(result.ok, result.text) : null,
    link
      ? h(
          'div',
          { style: s.row },
          h(
            'button',
            {
              type: 'button',
              style: s.button,
              disabled: !!busy,
              onClick: () => void act('models', () => api.models()),
            },
            t('link.models.refresh'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: s.button,
              disabled: !!busy,
              onClick: () => setRelink((v) => !v),
            },
            t('link.relink'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: s.danger,
              disabled: !!busy,
              onClick: () => {
                if (globalThis.confirm?.(t('link.unlink.confirm', { hub: link.hub })) ?? true)
                  void act('unlink', () => api.unlink());
              },
            },
            t('link.unlink'),
          ),
        )
      : null,
    !link || relink
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, ...pasteForm)
      : null,
  );

  // ---------------------------------------------------------------- folders
  const folders = state.folders;
  const addFolder = (path: string) => {
    const clean = path.trim();
    if (!clean || folders.some((f) => f.path === clean)) return;
    setNewFolder('');
    void save({ folders: [...folders, { path: clean, write: false }] });
  };
  const foldersSection = section(
    t('folders.title'),
    h('p', { style: s.hint, dir: 'auto' }, t('folders.hint')),
    folders.length === 0
      ? h('p', { style: { margin: 0, opacity: 0.7 } }, t('folders.empty'))
      : h(
          'ul',
          {
            style: {
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            },
          },
          folders.map((f, i) =>
            h(
              'li',
              { key: f.path, style: { ...s.row, justifyContent: 'space-between' } },
              h(
                'bdi',
                { style: { ...s.mono, overflowWrap: 'anywhere', flex: '1 1 200px' } },
                f.path,
              ),
              toggle(
                t('folders.writable'),
                f.write,
                (v) =>
                  void save({ folders: folders.map((g, j) => (j === i ? { ...g, write: v } : g)) }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: s.danger,
                  disabled: !!busy,
                  onClick: () => void save({ folders: folders.filter((_, j) => j !== i) }),
                },
                t('folders.remove'),
              ),
            ),
          ),
        ),
    h(
      'div',
      { style: s.row },
      state.canPickFolder
        ? h(
            'button',
            {
              type: 'button',
              style: s.button,
              disabled: !!busy,
              onClick: async () => {
                setBusy('pick');
                try {
                  const { path } = await api.pickFolder();
                  if (path) addFolder(path);
                } catch (e) {
                  setSaveNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
                } finally {
                  setBusy(null);
                }
              },
            },
            t('folders.pick'),
          )
        : null,
      h('input', {
        type: 'text',
        dir: 'ltr',
        value: newFolder,
        placeholder: t('folders.path'),
        'aria-label': t('folders.path'),
        style: { ...s.input, ...s.mono },
        onChange: (e: { target: { value: string } }) => setNewFolder(e.target.value),
        onKeyDown: (e: { key: string }) => {
          if (e.key === 'Enter') addFolder(newFolder);
        },
      }),
      h(
        'button',
        {
          type: 'button',
          style: s.button,
          disabled: !newFolder.trim() || !!busy,
          onClick: () => addFolder(newFolder),
        },
        t('folders.add'),
      ),
    ),
    toggle(t('folders.allowOpen'), state.allowOpen, (v) => void save({ allowOpen: v })),
  );

  // ---------------------------------------------------------------- programs
  const hubProfiles = link?.profiles ?? [];
  const programsNow = Object.fromEntries(state.servers.map((sv) => [sv.name, sv.profiles]));
  const setProgram = (server: string, profiles: string[]) =>
    void save({ programs: { ...programsNow, [server]: profiles } });
  const programsSection = section(
    t('programs.title'),
    h('p', { style: s.hint, dir: 'auto' }, t('programs.hint')),
    state.servers.length === 0
      ? h('p', { style: { margin: 0, opacity: 0.7 } }, t('programs.empty'))
      : h(
          'ul',
          {
            style: {
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            },
          },
          state.servers.map((sv) =>
            h(
              'li',
              { key: sv.name, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h(
                'div',
                { style: s.row },
                toggle(
                  '',
                  sv.profiles.length > 0,
                  (on) =>
                    setProgram(
                      sv.name,
                      on ? [link?.defaultProfile ?? hubProfiles[0] ?? 'default'] : [],
                    ),
                  !link,
                ),
                h('bdi', { style: { ...s.mono, fontWeight: 600 } }, sv.name),
                h('span', { style: { opacity: 0.6, fontSize: 12 } }, sv.state),
              ),
              sv.profiles.length > 0 && hubProfiles.length > 0
                ? h(
                    'div',
                    { style: { ...s.row, paddingInlineStart: 26 } },
                    hubProfiles.map((p) =>
                      h(
                        'span',
                        { key: p },
                        toggle(p, sv.profiles.includes(p), (on) => {
                          const next = on
                            ? [...sv.profiles, p]
                            : sv.profiles.filter((x) => x !== p);
                          setProgram(sv.name, next);
                        }),
                      ),
                    ),
                  )
                : null,
            ),
          ),
        ),
    link ? null : h('p', { style: s.hint }, t('programs.noProfiles')),
  );

  // ---------------------------------------------------------------- hermes, screen, language
  const select = (
    label: string,
    value: string,
    options: Array<[string, string]>,
    onChange: (v: string) => void,
  ) =>
    h(
      'label',
      { style: s.row },
      h('span', { style: { minWidth: 90 } }, label),
      h(
        'select',
        {
          value,
          disabled: !!busy,
          style: { ...s.input, flex: '0 1 280px' },
          onChange: (e: { target: { value: string } }) => onChange(e.target.value),
        },
        options.map(([v, l]) => h('option', { key: v, value: v }, l)),
      ),
    );

  const hermesSection = section(
    t('hermes.title'),
    select(
      t('hermes.profile'),
      state.agentProfile,
      [['', t('hermes.default')], ...hubProfiles.map((p): [string, string] => [p, p])],
      (v) => void save({ agentProfile: v }),
    ),
  );

  const modelIds = state.models?.ok ? state.models.ids : [];
  const screenSection = section(
    t('screen.title'),
    toggle(t('screen.toggle'), state.screen.enabled, (v) => void save({ screenTasks: v })),
    select(
      t('screen.model'),
      state.screen.model,
      [
        ['', t('screen.model.auto')],
        ...[...new Set([...(state.screen.model ? [state.screen.model] : []), ...modelIds])].map(
          (m): [string, string] => [m, m],
        ),
      ],
      (v) => void save({ screenModel: v }),
    ),
    h(
      'p',
      { style: s.hint },
      state.screen.available
        ? dot(GREEN, t('screen.available'))
        : dot(
            'gray',
            t('screen.unavailable', {
              why: t(`screen.why.${state.screen.why ?? 'platform'}` as never),
            }),
          ),
    ),
  );

  const languageSection = section(
    t('language.title'),
    select(
      t('language.title'),
      state.language || 'auto',
      [
        ['auto', t('language.auto')],
        ['en', 'English'],
        ['ar', 'العربية'],
      ],
      (v) => void save({ language: v as 'auto' | 'en' | 'ar' }),
    ),
  );

  const activitySection = section(
    t('activity.title'),
    state.activity.length === 0
      ? h('p', { style: { margin: 0, opacity: 0.7 } }, t('activity.empty'))
      : h(
          'ul',
          { style: { listStyle: 'none', margin: 0, padding: 0, fontSize: 13 } },
          state.activity.map((a, i) =>
            h(
              'li',
              {
                key: `${a.at}-${i}`,
                dir: 'auto',
                style: { padding: '3px 0', borderBottom: '1px solid rgba(127,127,127,0.15)' },
              },
              h(
                'span',
                { style: { color: a.ok ? GREEN : RED, fontWeight: 700 } },
                a.ok ? '✓ ' : '✕ ',
              ),
              h('bdi', { style: { ...s.mono, opacity: 0.7 } }, a.at.slice(0, 19).replace('T', ' ')),
              ' ',
              h('bdi', null, `${a.kind} · ${a.tool}`),
              a.target ? h('bdi', { style: { ...s.mono, opacity: 0.8 } }, ` ${a.target}`) : null,
              a.detail ? h('span', { style: { opacity: 0.7 } }, ` — ${a.detail}`) : null,
            ),
          ),
        ),
  );

  return h(
    'div',
    { style: s.page, dir: lang === 'ar' ? 'rtl' : 'ltr', 'data-corehub-page': '' },
    h('p', { style: { ...s.hint, opacity: 0.8 } }, t('page.intro')),
    saveNote ? notice(saveNote.ok, saveNote.text) : null,
    linkSection,
    foldersSection,
    programsSection,
    hermesSection,
    screenSection,
    languageSection,
    activitySection,
    h('p', { style: { ...s.hint, ...s.mono, fontSize: 11 } }, `v${state.version}`),
  );
}
