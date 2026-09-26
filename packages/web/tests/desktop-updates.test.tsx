// The desktop app's new versions in the page (DECISIONS §108): which notice floats over the page
// for each state, "Restart to update" and "Later", and the Updates part of This device in the
// `install` and `notify` modes.
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge, DesktopUpdatesState } from '../src/desktop/bridge-types.js';
import { DesktopUpdateNotice } from '../src/desktop/UpdateNotice.js';
import { UpdatesSection } from '../src/desktop/UpdatesSection.js';
import { updateNoticeOf } from '../src/desktop/updates.js';
import { I18nProvider } from '../src/i18n/context.js';

const RELEASES = 'https://github.com/twuijri/core-hub/releases';
const DOWNLOAD_PAGE = 'https://twuijri.github.io/core-hub/';

const available = (version: string) => ({
  status: 'available' as const,
  current: '1.1.3',
  checkedAt: '2026-09-26T10:00:00Z',
  update: {
    version,
    download: `${RELEASES}/download/v${version}/corehub_${version}_amd64.deb`,
    size: 100_000_000,
    page: `${RELEASES}/tag/v${version}`,
  },
});

const base = (over: Partial<DesktopUpdatesState> = {}): DesktopUpdatesState => ({
  channel: 'github',
  mode: 'install',
  auto: true,
  last: null,
  releasesPage: RELEASES,
  pending: null,
  downloadPage: DOWNLOAD_PAGE,
  dismissed: null,
  ...over,
});

describe('which notice floats over the page', () => {
  it('asks to restart once a version is downloaded, never while it downloads', () => {
    expect(
      updateNoticeOf(base({ pending: { version: '1.2.0', status: 'ready', percent: 100 } })),
    ).toEqual({ kind: 'ready', version: '1.2.0' });
    expect(
      updateNoticeOf(
        base({
          last: available('1.2.0'),
          pending: { version: '1.2.0', status: 'downloading', percent: 40 },
        }),
      ),
    ).toBeNull();
  });

  it('on the .deb, says a version is out and links the download page', () => {
    expect(updateNoticeOf(base({ mode: 'notify', last: available('1.2.0') }))).toEqual({
      kind: 'available',
      version: '1.2.0',
      href: DOWNLOAD_PAGE,
    });
  });

  it('stays away after "Later", when up to date, in the Store build and in an older app', () => {
    expect(
      updateNoticeOf(
        base({
          pending: { version: '1.2.0', status: 'ready', percent: 100 },
          dismissed: '1.2.0',
        }),
      ),
    ).toBeNull();
    expect(
      updateNoticeOf(base({ mode: 'notify', last: available('1.2.0'), dismissed: '1.2.0' })),
    ).toBeNull();
    // A newer version than the one put off is announced again.
    expect(
      updateNoticeOf(base({ mode: 'notify', last: available('1.3.0'), dismissed: '1.2.0' })),
    ).toMatchObject({ version: '1.3.0' });
    expect(
      updateNoticeOf(
        base({
          mode: 'notify',
          last: { status: 'up_to_date', current: '1.2.0', checkedAt: '2026-09-26T10:00:00Z' },
        }),
      ),
    ).toBeNull();
    expect(
      updateNoticeOf(base({ channel: 'store', mode: 'off', last: available('1.2.0') })),
    ).toBeNull();
    expect(updateNoticeOf(base({ mode: undefined, last: available('1.2.0') }))).toBeNull();
    expect(updateNoticeOf(null)).toBeNull();
  });
});

function fakeBridge(initial: DesktopUpdatesState) {
  let current = initial;
  const listeners = new Set<(state: DesktopUpdatesState) => void>();
  const updates = {
    get: vi.fn(async () => current),
    check: vi.fn(async () => current),
    setAuto: vi.fn(async (auto: boolean) => (current = { ...current, auto })),
    restart: vi.fn(async () => {}),
    dismiss: vi.fn(async (version: string) => (current = { ...current, dismissed: version })),
    onChange: vi.fn((listener: (state: DesktopUpdatesState) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }),
  };
  const bridge = { surface: 'desktop', getState: vi.fn(), updates } as unknown as DesktopBridge;
  const push = (next: DesktopUpdatesState) => {
    current = next;
    for (const listener of listeners) listener(next);
  };
  (globalThis as { corehubDesktop?: unknown }).corehubDesktop = bridge;
  return { bridge, updates, push };
}

afterEach(() => {
  cleanup();
  delete (globalThis as { corehubDesktop?: unknown }).corehubDesktop;
});

const inEnglish = (ui: React.ReactNode) => render(<I18nProvider language="en">{ui}</I18nProvider>);

describe('the floating notice', () => {
  it('appears when the app says the download is ready, and restarts on the person’s word', async () => {
    const { updates, push } = fakeBridge(base());
    inEnglish(<DesktopUpdateNotice />);
    await act(async () => {});
    expect(screen.queryByTestId('update-notice')).toBeNull();
    act(() => push(base({ pending: { version: '1.2.0', status: 'downloading', percent: 10 } })));
    expect(screen.queryByTestId('update-notice')).toBeNull();
    act(() => push(base({ pending: { version: '1.2.0', status: 'ready', percent: 100 } })));
    const notice = await screen.findByTestId('update-notice');
    expect(notice.textContent).toContain('Core Hub ⁨1.2.0⁩ is ready to install.');
    expect(notice.textContent).toContain('installed the next time you quit');
    expect(updates.restart).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('update-restart'));
    expect(updates.restart).toHaveBeenCalledOnce();
  });

  it('goes away for that version on "Later", and the app remembers it', async () => {
    const { updates } = fakeBridge(
      base({ pending: { version: '1.2.0', status: 'ready', percent: 100 } }),
    );
    inEnglish(<DesktopUpdateNotice />);
    await userEvent.click(await screen.findByTestId('update-later'));
    expect(updates.dismiss).toHaveBeenCalledWith('1.2.0');
    expect(updates.restart).not.toHaveBeenCalled();
    expect(screen.queryByTestId('update-notice')).toBeNull();
  });

  it('on the .deb, links the download page instead of installing', async () => {
    fakeBridge(base({ mode: 'notify', last: available('1.2.0') }));
    inEnglish(<DesktopUpdateNotice />);
    const link = await screen.findByTestId('update-get');
    expect(link.getAttribute('href')).toBe(DOWNLOAD_PAGE);
    expect(link.textContent).toBe('Open the download page');
    expect(screen.queryByTestId('update-restart')).toBeNull();
  });

  it('shows nothing in a browser', () => {
    inEnglish(<DesktopUpdateNotice />);
    expect(screen.queryByTestId('update-notice')).toBeNull();
  });
});

describe('Updates in This device', () => {
  it('install mode: the download’s progress, then "Restart to update"', async () => {
    const { bridge, updates, push } = fakeBridge(base());
    inEnglish(<UpdatesSection bridge={bridge} version="1.1.3" />);
    const section = await screen.findByTestId('desktop-updates');
    expect(section.getAttribute('data-mode')).toBe('install');
    expect(section.textContent).toContain('every six hours');
    act(() => push(base({ pending: { version: '1.2.0', status: 'downloading', percent: 42 } })));
    expect(screen.getByTestId('updates-downloading').textContent).toBe(
      'Downloading Core Hub ⁨1.2.0⁩… 42%',
    );
    act(() => push(base({ pending: { version: '1.2.0', status: 'ready', percent: 100 } })));
    await userEvent.click(screen.getByTestId('updates-restart'));
    expect(updates.restart).toHaveBeenCalledOnce();
  });

  it('notify mode: nothing is downloaded, the download page is linked', async () => {
    const { bridge, updates } = fakeBridge(base({ mode: 'notify' }));
    updates.check.mockImplementation(async () =>
      base({ mode: 'notify', last: available('1.2.0') }),
    );
    inEnglish(<UpdatesSection bridge={bridge} version="1.1.3" />);
    expect((await screen.findByTestId('desktop-updates')).textContent).toContain(
      'nothing is downloaded',
    );
    await userEvent.click(screen.getByTestId('updates-check'));
    const link = await screen.findByTestId('updates-download');
    expect(link.getAttribute('href')).toBe(DOWNLOAD_PAGE);
    expect(screen.queryByTestId('updates-restart')).toBeNull();
  });

  it('shows "Checking…" while a check the menu started runs', async () => {
    const { bridge, push } = fakeBridge(base());
    inEnglish(<UpdatesSection bridge={bridge} version="1.1.3" />);
    await screen.findByTestId('desktop-updates');
    act(() => push(base({ checking: true })));
    expect(screen.getByTestId('updates-check').textContent).toBe('Checking…');
    expect(screen.getByTestId('updates-check').hasAttribute('disabled')).toBe(true);
  });
});
