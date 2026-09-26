// @ts-check
// The download page in the browser: language, the visitor's system, the latest release's files
// and the store switches. The logic lives in releases.js (tested); this file only touches the DOM.
import { REPO, STORES } from './config.js';
import { STRINGS, t } from './i18n.js';
import { detectPlatform, formatSize, loadLatest, releasesPage, storeLink } from './releases.js';

/** @typedef {import('./i18n.js').Lang} Lang */
/** @typedef {import('./releases.js').Release} Release */
/** @typedef {import('./releases.js').Platform} Platform */
/** @typedef {import('./releases.js').AssetKey} AssetKey */

const LANG_KEY = 'corehub.download.lang';

/** Which file the big button offers on each system. */
/** @type {Record<Platform, AssetKey | null>} */
const PRIMARY = {
  windows: 'windows-exe',
  macos: 'macos-dmg',
  linux: 'linux-appimage',
  android: 'android-apk',
  ios: null,
};

/** @type {{ lang: Lang, platform: Platform | null, release: Release | null, failed: boolean }} */
const state = {
  lang: initialLang(),
  platform: detectPlatform(navigator),
  release: null,
  failed: false,
};

/** @returns {Lang} */
function initialLang() {
  const asked = new URLSearchParams(location.search).get('lang');
  if (asked === 'ar' || asked === 'en') return asked;
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'ar' || saved === 'en') return saved;
  } catch {
    // Storage blocked: English, the page's first language (owner, 2026-09-26).
  }
  return 'en';
}

/** @param {string} selector */
const all = (selector) => /** @type {HTMLElement[]} */ ([...document.querySelectorAll(selector)]);

/** @param {string} id */
const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

function applyLanguage() {
  const { lang } = state;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  for (const el of all('[data-i18n]')) el.textContent = t(lang, el.dataset.i18n ?? '');
  // Our own markup from i18n.js, never text from the network.
  for (const el of all('[data-i18n-html]')) el.innerHTML = t(lang, el.dataset.i18nHtml ?? '');
  for (const el of all('[data-i18n-aria]'))
    el.setAttribute('aria-label', t(lang, el.dataset.i18nAria ?? ''));
  for (const el of all('[data-i18n-content]'))
    el.setAttribute('content', t(lang, el.dataset.i18nContent ?? ''));
  byId('lang-toggle').lang = lang === 'ar' ? 'en' : 'ar';
  const privacy = byId('privacy-link');
  privacy.setAttribute('href', privacy.dataset[lang === 'ar' ? 'hrefAr' : 'hrefEn'] ?? '');
}

function applyStores() {
  for (const el of all('[data-store]')) {
    const key = /** @type {keyof typeof STORES} */ (el.dataset.store);
    const flag = STORES[key];
    /** @type {ReturnType<typeof storeLink>} */
    const link = flag ? storeLink(flag) : { available: false };
    const meta = el.querySelector('[data-store-state]');
    if (link.available) {
      el.setAttribute('href', link.href);
      el.removeAttribute('aria-disabled');
      if (meta) meta.textContent = t(state.lang, 'store.open');
    } else {
      el.removeAttribute('href');
      el.setAttribute('aria-disabled', 'true');
      if (meta) meta.textContent = t(state.lang, 'soon');
    }
  }
}

function applyRelease() {
  const { release, lang } = state;
  const fallback = releasesPage(REPO);
  for (const el of all('[data-asset]')) {
    const key = /** @type {AssetKey} */ (el.dataset.asset);
    const download = release?.downloads[key];
    const meta = el.querySelector('.btn-meta');
    if (download) {
      el.setAttribute('href', download.url);
      el.setAttribute('download', '');
      if (meta)
        meta.textContent = [el.dataset.ext, formatSize(download.size)].filter(Boolean).join(' · ');
    } else {
      // No release read, or this file missing from it: the release page, never a guessed URL.
      el.setAttribute('href', release?.pageUrl ?? fallback);
      el.removeAttribute('download');
      if (meta) meta.textContent = release ? t(lang, 'dl.missing') : (el.dataset.ext ?? '');
    }
  }

  const status = byId('release-status');
  const notes = byId('release-notes');
  if (release) {
    const date = release.publishedAt
      ? new Intl.DateTimeFormat(lang === 'ar' ? 'ar-u-nu-latn' : 'en', {
          dateStyle: 'long',
        }).format(new Date(release.publishedAt))
      : '';
    status.textContent = [t(lang, 'release.version', { version: release.version }), date]
      .filter(Boolean)
      .join(' · ');
    notes.setAttribute('href', release.pageUrl);
    notes.hidden = false;
  } else if (state.failed) {
    status.textContent = '';
    notes.hidden = true;
  } else {
    status.textContent = t(lang, 'release.loading');
  }
  byId('release-unavailable').hidden = !state.failed;
}

function applyPlatform() {
  const { platform, release, lang } = state;
  for (const card of all('.card[data-platform]')) {
    const mine = card.dataset.platform === platform;
    card.classList.toggle('is-detected', mine);
    const chip = card.querySelector('.chip-detected');
    if (chip instanceof HTMLElement) chip.hidden = !mine;
  }

  const cta = byId('hero-cta');
  const label = byId('hero-cta-label');
  const meta = byId('hero-cta-meta');
  meta.hidden = true;
  if (!platform) {
    label.textContent = t(lang, 'hero.choose');
    cta.setAttribute('href', '#downloads');
    cta.removeAttribute('download');
    return;
  }
  const name = t(lang, `platform.${platform}`);
  const key = PRIMARY[platform];
  if (!key) {
    // iPhone and iPad: the App Store when it is switched on, else its card with "Coming soon".
    const link = storeLink(STORES.appStore);
    label.textContent = link.available
      ? t(lang, 'hero.for', { platform: name })
      : t(lang, 'hero.soon', { platform: name });
    cta.setAttribute('href', link.available ? link.href : `#${platform}`);
    cta.removeAttribute('download');
    return;
  }
  label.textContent = t(lang, 'hero.for', { platform: name });
  const download = release?.downloads[key];
  if (download) {
    cta.setAttribute('href', download.url);
    cta.setAttribute('download', '');
    meta.textContent = [download.name, formatSize(download.size)].filter(Boolean).join(' · ');
    meta.hidden = false;
  } else {
    // Until the release is read (or if it cannot be): the platform's card, whose buttons lead
    // to the release page.
    cta.setAttribute('href', `#${platform}`);
    cta.removeAttribute('download');
  }
}

function render() {
  applyLanguage();
  applyStores();
  applyRelease();
  applyPlatform();
}

function wireLanguage() {
  byId('lang-toggle').addEventListener('click', () => {
    state.lang = state.lang === 'ar' ? 'en' : 'ar';
    try {
      localStorage.setItem(LANG_KEY, state.lang);
    } catch {
      // Not remembered; the toggle still works on this visit.
    }
    render();
  });
}

function wireCopy() {
  for (const button of all('[data-copy]')) {
    button.addEventListener('click', async () => {
      const source = document.getElementById(button.dataset.copy ?? '');
      if (!source) return;
      try {
        await navigator.clipboard.writeText(source.textContent ?? '');
      } catch {
        return;
      }
      const label = button.querySelector('.copy-label');
      button.classList.add('is-done');
      if (label) label.textContent = t(state.lang, 'copied');
      setTimeout(() => {
        button.classList.remove('is-done');
        if (label) label.textContent = t(state.lang, 'copy');
      }, 1600);
    });
  }
}

async function main() {
  if (!STRINGS[state.lang]) state.lang = 'en';
  wireLanguage();
  wireCopy();
  render();
  state.release = await loadLatest({
    repo: REPO,
    fetch: (url, init) => window.fetch(url, init),
  });
  state.failed = state.release === null;
  render();
}

void main();
