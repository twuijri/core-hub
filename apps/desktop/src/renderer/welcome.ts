/**
 * The first-run screen (ADR 0009): remote or local, then the hub's address or a pairing
 * link. Plain DOM — this page shows before any hub is known, so it cannot be the web
 * client — and every string comes from the app's catalogue, in Arabic or English.
 */
import type { Language } from '../shared/config.js';
import { direction, translate } from '../shared/i18n.js';
import type {
  HermesMissing,
  LocalResult,
  WelcomeApi,
  WelcomeError,
  WelcomeInit,
} from '../shared/ipc.js';

declare global {
  interface Window {
    corehubWelcome: WelcomeApi;
  }
}

const api = window.corehubWelcome;
const root = document.getElementById('root') as HTMLElement;

let init: WelcomeInit;
let language: Language = 'en';
let view: 'choose' | 'remote' | 'local' = 'choose';
let error: WelcomeError | null = null;
let busy: 'connect' | 'pair' | 'local' | 'install' | null = null;
let hermesMissing: HermesMissing | null = null;
const installLog: string[] = [];
let address = '';
let pairText = '';

const t = (key: string, params?: Record<string, string>) => translate(language, key, params);

type Child = Node | string | null | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | ((event: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (typeof value === 'function') element.addEventListener(name.slice(2), value);
    else if (typeof value === 'boolean') {
      if (value) element.setAttribute(name, '');
    } else element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === false) continue;
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

function errorBox(): HTMLElement | null {
  if (!error) return null;
  return h(
    'p',
    { class: 'error', role: 'alert', 'data-testid': 'welcome-error' },
    t(error.key, error.params),
  );
}

function header(): HTMLElement {
  return h(
    'header',
    {},
    h('img', { src: './logo.svg', alt: '' }),
    h('h1', {}, t('welcome.title')),
    h(
      'button',
      {
        class: 'link',
        type: 'button',
        lang: language === 'ar' ? 'en' : 'ar',
        'data-testid': 'welcome-language',
        onclick: () => {
          language = language === 'ar' ? 'en' : 'ar';
          void api.setLanguage(language);
          render();
        },
      },
      t('welcome.language'),
    ),
  );
}

function chooseView(): HTMLElement[] {
  return [
    h('p', {}, t('welcome.intro')),
    h(
      'div',
      { class: 'choices' },
      h(
        'button',
        {
          class: 'choice',
          type: 'button',
          'data-testid': 'choose-remote',
          onclick: () => {
            view = 'remote';
            error = null;
            render();
            document.getElementById('hub-url')?.focus();
          },
        },
        h('strong', {}, t('welcome.remote.title')),
        h('span', { class: 'muted' }, t('welcome.remote.body')),
      ),
      h(
        'button',
        {
          class: 'choice',
          type: 'button',
          'data-testid': 'choose-local',
          disabled: busy !== null,
          onclick: () => void local(),
        },
        h('strong', {}, t('welcome.local.title')),
        h('span', { class: 'muted' }, t('welcome.local.body')),
        busy === 'local' && h('span', { class: 'muted' }, t('local.starting')),
      ),
    ),
    errorBox(),
  ].filter((node): node is HTMLElement => node !== null);
}

function settle(result: LocalResult): void {
  busy = null;
  if (result.ok) return;
  error = result.error;
  if (result.hermesMissing) {
    hermesMissing = result.hermesMissing;
    view = 'local';
  }
  render();
}

async function local(withoutHermes = false): Promise<void> {
  busy = 'local';
  error = null;
  render();
  settle(await api.chooseLocal({ withoutHermes }));
}

async function install(): Promise<void> {
  busy = 'install';
  error = null;
  installLog.length = 0;
  render();
  settle(await api.installHermes());
}

function localView(): HTMLElement[] {
  const missing = hermesMissing;
  const log =
    installLog.length > 0
      ? h(
          'pre',
          { class: 'log ltr', 'aria-label': t('local.log'), 'data-testid': 'install-log' },
          installLog.join('\n'),
        )
      : null;
  return [
    h(
      'div',
      {},
      h(
        'button',
        {
          class: 'link',
          type: 'button',
          disabled: busy === 'install',
          onclick: () => {
            view = 'choose';
            error = null;
            render();
          },
        },
        t('welcome.back'),
      ),
    ),
    h(
      'section',
      { class: 'card', 'data-testid': 'hermes-missing' },
      h('h2', {}, t('local.no_hermes_title')),
      h('p', {}, t('local.no_hermes_body')),
      missing && h('p', { class: 'muted' }, t('local.install_command')),
      missing && h('code', { class: 'ltr command' }, missing.command),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            type: 'button',
            disabled: busy !== null,
            'data-testid': 'install-hermes',
            onclick: () => void install(),
          },
          busy === 'install' ? t('local.installing') : t('local.install'),
        ),
        missing &&
          h(
            'a',
            { class: 'link', href: missing.docs, target: '_blank', rel: 'noreferrer' },
            t('local.docs'),
          ),
      ),
      log,
    ),
    errorBox(),
    h(
      'section',
      { class: 'card' },
      h('p', { class: 'muted' }, t('local.without_hint')),
      h(
        'div',
        {},
        h(
          'button',
          {
            class: 'secondary',
            type: 'button',
            disabled: busy !== null,
            'data-testid': 'local-without-hermes',
            onclick: () => void local(true),
          },
          busy === 'local' ? t('local.starting') : t('local.without'),
        ),
      ),
    ),
  ].filter((node): node is HTMLElement => node !== null);
}

async function connect(target: string): Promise<void> {
  busy = 'connect';
  error = null;
  address = target;
  render();
  const result = await api.connect(target);
  busy = null;
  if (!result.ok) {
    error = result.error;
    render();
  }
}

async function pair(): Promise<void> {
  busy = 'pair';
  error = null;
  render();
  const result = await api.pair(pairText);
  busy = null;
  if (!result.ok) {
    error = result.error;
    render();
  }
}

function remoteView(): HTMLElement[] {
  const urlInput = h('input', {
    id: 'hub-url',
    // Plain text: the browser's URL check would refuse `192.168.1.20:8080` and speak English.
    type: 'text',
    dir: 'ltr',
    inputmode: 'url',
    autocomplete: 'url',
    spellcheck: 'false',
    placeholder: 'hub.example.com',
    'aria-describedby': 'hub-url-hint',
    'data-testid': 'hub-url',
  });
  urlInput.value = address;
  urlInput.addEventListener('input', () => (address = urlInput.value));
  const pairInput = h('input', {
    id: 'pair-text',
    type: 'text',
    dir: 'ltr',
    spellcheck: 'false',
    placeholder: 'corehub://pair?…',
    'aria-describedby': 'pair-hint',
    'data-testid': 'pair-text',
  });
  pairInput.value = pairText;
  pairInput.addEventListener('input', () => (pairText = pairInput.value));

  const connectForm = h(
    'form',
    {
      class: 'card',
      novalidate: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        void connect(address);
      },
    },
    h('h2', {}, t('remote.heading')),
    h('label', { for: 'hub-url' }, t('remote.url_label')),
    h(
      'div',
      { class: 'row' },
      urlInput,
      h(
        'button',
        { class: 'primary', type: 'submit', disabled: busy !== null, 'data-testid': 'connect' },
        busy === 'connect' ? t('remote.checking') : t('remote.connect'),
      ),
    ),
    h('p', { id: 'hub-url-hint', class: 'muted' }, t('remote.url_hint')),
    init.recent.length > 0 && h('p', { class: 'muted' }, t('remote.recent')),
    init.recent.length > 0 &&
      h(
        'div',
        { class: 'recent' },
        ...init.recent.map((url) =>
          h(
            'button',
            {
              class: 'secondary ltr',
              type: 'button',
              disabled: busy !== null,
              onclick: () => void connect(url),
            },
            url,
          ),
        ),
      ),
  );
  const pairForm = h(
    'form',
    {
      class: 'card',
      onsubmit: (event: Event) => {
        event.preventDefault();
        void pair();
      },
    },
    h('h2', {}, t('remote.pair_heading')),
    h('p', { id: 'pair-hint', class: 'muted' }, t('remote.pair_hint')),
    h('label', { for: 'pair-text' }, t('remote.pair_label')),
    h(
      'div',
      { class: 'row' },
      pairInput,
      h(
        'button',
        { class: 'secondary', type: 'submit', disabled: busy !== null, 'data-testid': 'pair' },
        busy === 'pair' ? t('remote.pairing') : t('remote.pair'),
      ),
    ),
  );
  return [
    h(
      'div',
      {},
      h(
        'button',
        {
          class: 'link',
          type: 'button',
          onclick: () => {
            view = 'choose';
            error = null;
            render();
          },
        },
        t('welcome.back'),
      ),
    ),
    connectForm,
    errorBox(),
    pairForm,
  ].filter((node): node is HTMLElement => node !== null);
}

function render(): void {
  document.documentElement.lang = language;
  document.documentElement.dir = direction(language);
  document.title = t('app.name');
  const focused = document.activeElement?.id;
  root.replaceChildren(
    header(),
    ...(view === 'choose' ? chooseView() : view === 'remote' ? remoteView() : localView()),
    h('footer', { class: 'ltr' }, `${t('app.name')} ${init.appVersion}`),
  );
  if (focused) document.getElementById(focused)?.focus();
}

void api.init().then((value) => {
  init = value;
  language = value.language;
  address = value.prefill ?? value.remoteUrl ?? '';
  error = value.notice;
  if (value.prefill) view = 'remote';
  render();
});
api.onInstallLog((line) => {
  installLog.push(line);
  if (installLog.length > 400) installLog.shift();
  const box = document.querySelector<HTMLElement>('[data-testid="install-log"]');
  if (box) {
    box.textContent = installLog.join('\n');
    box.scrollTop = box.scrollHeight;
  } else render();
});
api.onPrefill((url) => {
  address = url;
  view = 'remote';
  error = null;
  render();
});
