/**
 * The "Core Hub" page on the harness's Plugins page (the bundle's own configuration,
 * `plugins.bundle.config`, and the row's Configure page, `plugins.row.config`): link by pasting
 * the pairing, the link's state, the shared folders, the harness MCP servers offered to the hub,
 * Hermes's profile, screen tasks, the language, and the recent activity. Every change is written
 * at once through the plugin's host half (`panel.ts`), which keeps the token to itself.
 *
 * Its controls are the harness's own (buttons, inputs, switches, checkboxes, menus, the dialog,
 * the toast, state dots), laid out like its own settings pages: a section title, the control, a
 * hint under it; groups of facts sit in the settings-card material (`styles.ts`).
 */
import {
  createElement as h,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Button,
  Checkbox,
  IconChevronDownOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Menu,
  Modal,
  PathLabel,
  StateDot,
  Switch,
  Tag,
  Toast,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { uiLanguage, uiTranslator, type UiTranslate } from '../ui-strings.js';
import type { PanelApi, SettingsPatch, StatusView } from './api.js';
import { PRODUCT_NAMES } from './product.js';

const POLL_MS = 5000;

function browserLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
}

function section(title: string, ...children: ReactNode[]): ReactNode {
  return h(
    'section',
    { className: 'corehub-section' },
    h('h4', { className: 'corehub-section-title' }, title),
    ...children,
  );
}

function hint(text: string): ReactNode {
  return h('p', { className: 'corehub-hint', dir: 'auto' }, text);
}

function result(ok: boolean, text: string): ReactNode {
  return h(
    'div',
    { className: 'corehub-result', 'data-ok': String(ok), role: ok ? 'status' : 'alert' },
    h(StateDot, { state: ok ? 'done' : 'error' }),
    h('span', null, text),
  );
}

function fact(label: string, value: ReactNode): ReactNode {
  return h(
    'div',
    { className: 'corehub-card-row' },
    h('span', { className: 'corehub-fact-label' }, label),
    h('span', { className: 'corehub-fact-value' }, value),
  );
}

function switchRow(
  label: string,
  checked: boolean,
  onChange: (v: boolean) => void,
  disabled = false,
) {
  return h(
    'div',
    { className: 'corehub-switch-row' },
    h('span', { dir: 'auto' }, label),
    h(Switch, { label, checked, onChange, disabled }),
  );
}

/** A selector like the harness's own settings pages: a field-shaped trigger and its menu. */
function Select(props: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  disabled: boolean;
  onChange: (value: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const current = props.options.find(([v]) => v === props.value)?.[1] ?? props.value;
  return h(Menu, {
    open,
    portal: true,
    minWidthFromAnchor: true,
    autoFocus: true,
    selectedId: props.value,
    items: props.options.map(([id, label]) => ({ id, label })),
    onSelect: (id: string) => {
      setOpen(false);
      if (id !== props.value) props.onChange(id);
    },
    onClose: () => setOpen(false),
    anchor: h(
      'button',
      {
        type: 'button',
        className: 'corehub-select',
        'aria-label': props.label,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        disabled: props.disabled,
        onClick: () => setOpen((v) => !v),
      },
      h('span', { dir: 'auto' }, current),
      h(IconChevronDownOutlineRegular, { size: 14 }),
    ),
  });
}

function field(label: string, control: ReactNode, note?: ReactNode): ReactNode {
  return h(
    'div',
    { className: 'corehub-section' },
    h('span', { className: 'corehub-fact-label', style: { flex: 'none' } }, label),
    h('div', null, control),
    note ?? null,
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

const CONNECTION_DOT: Record<string, StateDotState> = {
  connected: 'done',
  connecting: 'ongoing',
  offline: 'warning',
  refused: 'error',
  stopped: 'idle',
  unlinked: 'idle',
};

function CoreHubSettings({ api }: { api: PanelApi }): ReactNode {
  const [state, setState] = useState<StatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const [saveNote, setSaveNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pairing, setPairing] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [relink, setRelink] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
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
    setOutcome(null);
    try {
      const { outcome: answer, state: next } = await run();
      setState(next);
      setOutcome(answer);
      if (name === 'link' && answer.ok) {
        setPairing('');
        setRelink(false);
      }
    } catch (e) {
      setOutcome({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  if (!state)
    return h(
      'div',
      { className: 'corehub-page', dir },
      error
        ? h(
            'div',
            { className: 'corehub-row' },
            result(false, t('page.error', { reason: error })),
            h(
              Button,
              { variant: 'outline', size: 'sm', type: 'button', onClick: () => void load() },
              t('page.retry'),
            ),
          )
        : hint(t('page.loading')),
    );

  const link = state.link;
  const connection = link?.status ?? 'unlinked';

  // ---------------------------------------------------------------- link
  const pasteForm = h(
    'div',
    { className: 'corehub-section' },
    h('label', { htmlFor: 'corehub-pairing', className: 'corehub-section-title' }, t('link.paste')),
    h(
      'div',
      { className: 'corehub-row' },
      h(Input, {
        id: 'corehub-pairing',
        className: 'corehub-grow',
        value: pairing,
        dir: 'ltr',
        spellCheck: false,
        autoComplete: 'off',
        placeholder: '{"type":"corehub.pairing",…}',
        onChange: (e) => setPairing(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter' && pairing.trim() && !busy)
            void act('link', () => api.link(pairing.trim()));
        },
      }),
      h(
        Button,
        {
          variant: 'primary',
          type: 'button',
          disabled: !pairing.trim() || !!busy,
          onClick: () => void act('link', () => api.link(pairing.trim())),
        },
        busy === 'link' ? t('link.busy') : t('link.button'),
      ),
    ),
    hint(t('link.paste.hint')),
  );

  const modelsValue =
    state.models === null
      ? '—'
      : state.models.ok
        ? t('link.models.count', { count: state.models.ids.length })
        : h(Tag, { tone: 'danger' }, state.models.detail || state.models.reason);

  const linkSection = section(
    t('link.title'),
    link
      ? h(
          'div',
          { className: 'corehub-card' },
          fact(t('link.connection'), [
            h(StateDot, { key: 'd', state: CONNECTION_DOT[connection] ?? 'idle' }),
            h('span', { key: 't' }, t(`conn.${connection}` as never)),
          ]),
          fact(t('link.hub'), h('span', { className: 'corehub-mono' }, link.hub)),
          fact(t('link.user'), h('bdi', null, link.user)),
          fact(t('link.device'), h('span', { className: 'corehub-mono' }, link.deviceId)),
          link.tokenExpires
            ? fact(
                t('link.token'),
                h(
                  'span',
                  { className: 'corehub-mono' },
                  link.tokenExpires.slice(0, 16).replace('T', ' '),
                ),
              )
            : null,
          fact(t('link.models'), modelsValue),
        )
      : h(
          'div',
          { className: 'corehub-result', 'data-ok': 'true' },
          h(StateDot, { state: 'idle' }),
          h('span', null, t('link.unlinked')),
        ),
    outcome ? result(outcome.ok, outcome.text) : null,
    link
      ? h(
          'div',
          { className: 'corehub-row' },
          h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              type: 'button',
              icon: h(IconRefreshOutlineRegular, { size: 14 }),
              disabled: !!busy,
              onClick: () => void act('models', () => api.models()),
            },
            t('link.models.refresh'),
          ),
          h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              type: 'button',
              disabled: !!busy,
              onClick: () => setRelink((v) => !v),
            },
            t('link.relink'),
          ),
          h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              type: 'button',
              className: 'corehub-danger',
              disabled: !!busy,
              onClick: () => setConfirmUnlink(true),
            },
            t('link.unlink'),
          ),
        )
      : null,
    !link || relink ? pasteForm : null,
    link
      ? h(Modal, {
          open: confirmUnlink,
          onClose: () => setConfirmUnlink(false),
          title: t('link.unlink'),
          tone: 'warning',
          description: t('link.unlink.confirm', { hub: link.hub }),
          closeLabel: t('close'),
          footer: h(
            'div',
            { className: 'corehub-row', style: { justifyContent: 'flex-end' } },
            h(
              Button,
              { variant: 'outline', type: 'button', onClick: () => setConfirmUnlink(false) },
              t('cancel'),
            ),
            h(
              Button,
              {
                variant: 'primary',
                type: 'button',
                onClick: () => {
                  setConfirmUnlink(false);
                  void act('unlink', () => api.unlink());
                },
              },
              t('link.unlink'),
            ),
          ),
        })
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
    hint(t('folders.hint')),
    folders.length === 0
      ? hint(t('folders.empty'))
      : h(
          'div',
          { className: 'corehub-card' },
          folders.map((f, i) =>
            h(
              'div',
              { key: f.path, className: 'corehub-card-row' },
              h(PathLabel, { path: f.path, className: 'corehub-grow', dir: 'ltr' }),
              h(Checkbox, {
                label: t('folders.writable'),
                checked: f.write,
                disabled: !!busy,
                onChange: (v: boolean) =>
                  void save({ folders: folders.map((g, j) => (j === i ? { ...g, write: v } : g)) }),
              }),
              h(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  type: 'button',
                  className: 'corehub-danger',
                  icon: h(IconTrashOutlineRegular, { size: 14 }),
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
      { className: 'corehub-row' },
      state.canPickFolder
        ? h(
            Button,
            {
              variant: 'outline',
              type: 'button',
              icon: h(IconFolderOpenOutlineRegular, { size: 16 }),
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
      h(Input, {
        className: 'corehub-grow',
        dir: 'ltr',
        value: newFolder,
        placeholder: t('folders.path'),
        'aria-label': t('folders.path'),
        onChange: (e) => setNewFolder(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter') addFolder(newFolder);
        },
      }),
      h(
        Button,
        {
          variant: 'outline',
          type: 'button',
          disabled: !newFolder.trim() || !!busy,
          onClick: () => addFolder(newFolder),
        },
        t('folders.add'),
      ),
    ),
    switchRow(t('folders.allowOpen'), state.allowOpen, (v) => void save({ allowOpen: v }), !!busy),
  );

  // ---------------------------------------------------------------- programs
  const hubProfiles = link?.profiles ?? [];
  const programsNow = Object.fromEntries(state.servers.map((sv) => [sv.name, sv.profiles]));
  const setProgram = (server: string, profiles: string[]) =>
    void save({ programs: { ...programsNow, [server]: profiles } });
  const programsSection = section(
    t('programs.title'),
    hint(t('programs.hint')),
    state.servers.length === 0
      ? hint(t('programs.empty'))
      : h(
          'div',
          { className: 'corehub-card' },
          state.servers.map((sv) =>
            h(
              'div',
              { key: sv.name, className: 'corehub-card-row' },
              h('span', { className: 'corehub-grow', dir: 'ltr' }, sv.name),
              h(Tag, { tone: 'neutral' }, sv.state),
              h(Switch, {
                label: `${t('programs.on')}: ${sv.name}`,
                checked: sv.profiles.length > 0,
                disabled: !link || !!busy,
                onChange: (on: boolean) =>
                  setProgram(
                    sv.name,
                    on ? [link?.defaultProfile ?? hubProfiles[0] ?? 'default'] : [],
                  ),
              }),
              sv.profiles.length > 0 && hubProfiles.length > 0
                ? h(
                    'div',
                    { className: 'corehub-row', style: { flexBasis: '100%' } },
                    hubProfiles.map((p) =>
                      h(Checkbox, {
                        key: p,
                        label: p,
                        checked: sv.profiles.includes(p),
                        disabled: !!busy,
                        onChange: (on: boolean) =>
                          setProgram(
                            sv.name,
                            on ? [...sv.profiles, p] : sv.profiles.filter((x) => x !== p),
                          ),
                      }),
                    ),
                  )
                : null,
            ),
          ),
        ),
    link ? null : hint(t('programs.noProfiles')),
  );

  // ---------------------------------------------------------------- hermes, screen, language
  const hermesSection = section(
    t('hermes.title'),
    field(
      t('hermes.profile'),
      h(Select, {
        label: t('hermes.profile'),
        value: state.agentProfile,
        disabled: !!busy,
        options: [['', t('hermes.default')], ...hubProfiles.map((p): [string, string] => [p, p])],
        onChange: (v) => void save({ agentProfile: v }),
      }),
    ),
  );

  const modelIds = state.models?.ok ? state.models.ids : [];
  const screenSection = section(
    t('screen.title'),
    switchRow(
      t('screen.toggle'),
      state.screen.enabled,
      (v) => void save({ screenTasks: v }),
      !!busy,
    ),
    field(
      t('screen.model'),
      h(Select, {
        label: t('screen.model'),
        value: state.screen.model,
        disabled: !!busy,
        options: [
          ['', t('screen.model.auto')],
          ...[...new Set([...(state.screen.model ? [state.screen.model] : []), ...modelIds])].map(
            (m): [string, string] => [m, m],
          ),
        ],
        onChange: (v) => void save({ screenModel: v }),
      }),
      h(
        'div',
        { className: 'corehub-result', 'data-ok': 'true' },
        h(StateDot, { state: state.screen.available ? 'done' : 'idle' }),
        h(
          'span',
          { className: 'corehub-hint' },
          state.screen.available
            ? t('screen.available')
            : t('screen.unavailable', {
                why: t(`screen.why.${state.screen.why ?? 'platform'}` as never),
              }),
        ),
      ),
    ),
  );

  const languageSection = section(
    t('language.title'),
    h(Select, {
      label: t('language.title'),
      value: state.language || 'auto',
      disabled: !!busy,
      options: [
        ['auto', t('language.auto')],
        ['en', 'English'],
        ['ar', 'العربية'],
      ],
      onChange: (v) => void save({ language: v as 'auto' | 'en' | 'ar' }),
    }),
  );

  const activitySection = section(
    t('activity.title'),
    state.activity.length === 0
      ? hint(t('activity.empty'))
      : h(
          'div',
          { className: 'corehub-card' },
          state.activity.map((a, i) =>
            h(
              'div',
              { key: `${a.at}-${i}`, className: 'corehub-card-row', dir: 'auto' },
              h(StateDot, { state: a.ok ? 'done' : 'error' }),
              h(
                'span',
                { className: 'corehub-activity-time corehub-mono' },
                a.at.slice(0, 19).replace('T', ' '),
              ),
              h(
                'span',
                { className: 'corehub-fact-value' },
                h('bdi', null, `${a.kind} · ${a.tool}`),
                a.target ? h('span', { className: 'corehub-mono' }, a.target) : null,
                a.detail ? h('span', { className: 'corehub-hint' }, a.detail) : null,
              ),
            ),
          ),
        ),
  );

  return h(
    'div',
    { className: 'corehub-page', dir, 'data-corehub-page': '' },
    h('p', { className: 'corehub-intro' }, t('page.intro')),
    saveNote && !saveNote.ok ? result(false, saveNote.text) : null,
    saveNote?.ok
      ? h(Toast, {
          text: saveNote.text,
          tone: 'success',
          holdMs: 1500,
          onDone: () => setSaveNote(null),
        })
      : null,
    linkSection,
    foldersSection,
    programsSection,
    hermesSection,
    screenSection,
    languageSection,
    activitySection,
    h('p', { className: 'corehub-version corehub-mono' }, `v${state.version}`),
  );
}
