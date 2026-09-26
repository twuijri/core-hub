// The menus in both languages, without starting Electron.
import { describe, expect, it, vi } from 'vitest';
import { translate } from '../../src/shared/i18n.js';
import { appMenuTemplate, trayMenuTemplate, type MenuActions } from '../../src/main/menu.js';

const actions = (): MenuActions => ({
  showWindow: vi.fn(),
  changeConnection: vi.fn(),
  openWebsite: vi.fn(),
  quit: vi.fn(),
  checkForUpdates: vi.fn(),
  restartToUpdate: vi.fn(),
});

describe('menus', () => {
  it('labels every item in Arabic, not with Electron English role names', () => {
    const t = (key: string) => translate('ar', key);
    const template = appMenuTemplate(t, actions(), { platform: 'linux', devTools: false });
    const labels = template.flatMap((top) => [
      top.label,
      ...((top.submenu as Array<{ label?: string; type?: string }>) ?? [])
        .filter((item) => item.type !== 'separator')
        .map((item) => item.label),
    ]);
    for (const label of labels) {
      expect(label).toBeTruthy();
      expect(label).toMatch(/[؀-ۿ]|GitHub/);
    }
  });

  it('shows developer tools only when asked', () => {
    const t = (key: string) => translate('en', key);
    const roles = (devTools: boolean) =>
      appMenuTemplate(t, actions(), { platform: 'linux', devTools }).flatMap((top) =>
        ((top.submenu as Array<{ role?: string }>) ?? []).map((item) => item.role),
      );
    expect(roles(false)).not.toContain('toggleDevTools');
    expect(roles(true)).toContain('toggleDevTools');
  });

  it('has the app menu on macOS and a File menu elsewhere', () => {
    const t = (key: string) => translate('en', key);
    expect(appMenuTemplate(t, actions(), { platform: 'darwin', devTools: false })[0]?.label).toBe(
      'Core Hub',
    );
    expect(appMenuTemplate(t, actions(), { platform: 'win32', devTools: false })[0]?.label).toBe(
      'File',
    );
  });

  it('the tray opens the app, changes the connection, and quits', () => {
    const a = actions();
    const items = trayMenuTemplate((key) => translate('en', key), a).filter(
      (item) => item.type !== 'separator',
    );
    expect(items.map((item) => item.label)).toEqual([
      'Open Core Hub',
      'Change connection…',
      'Quit Core Hub',
    ]);
    for (const item of items) (item.click as () => void)();
    expect(a.showWindow).toHaveBeenCalledOnce();
    expect(a.changeConnection).toHaveBeenCalledOnce();
    expect(a.quit).toHaveBeenCalledOnce();
  });

  it('offers "Check for updates…" where the app looks, and a restart once one is downloaded', () => {
    const t = (key: string, params?: Record<string, string>) => translate('en', key, params);
    const labels = (items: Array<{ label?: string; type?: string }>) =>
      items.filter((item) => item.type !== 'separator').map((item) => item.label);
    const submenu = (template: ReturnType<typeof appMenuTemplate>, label: string) =>
      (template.find((top) => top.label === label)?.submenu ?? []) as Array<{
        label?: string;
        type?: string;
        click?: () => void;
      }>;

    // The Store build never looks: no item.
    const store = appMenuTemplate(t, actions(), {
      platform: 'win32',
      devTools: false,
      updates: { check: false, ready: null },
    });
    expect(labels(submenu(store, 'Help'))).toEqual(['Core Hub on GitHub']);
    expect(labels(trayMenuTemplate(t, actions(), { check: false, ready: null }))).toEqual([
      'Open Core Hub',
      'Change connection…',
      'Quit Core Hub',
    ]);

    // Windows and Linux: in Help; macOS: in the app menu under About.
    const a = actions();
    const help = submenu(
      appMenuTemplate(t, a, {
        platform: 'linux',
        devTools: false,
        updates: { check: true, ready: '1.2.0' },
      }),
      'Help',
    );
    expect(labels(help)).toEqual([
      'Core Hub on GitHub',
      'Check for updates…',
      'Restart to update to \u20681.2.0\u2069',
    ]);
    for (const item of help.slice(2)) item.click?.();
    expect(a.checkForUpdates).toHaveBeenCalledOnce();
    expect(a.restartToUpdate).toHaveBeenCalledOnce();
    const mac = appMenuTemplate(t, actions(), {
      platform: 'darwin',
      devTools: false,
      updates: { check: true, ready: null },
    });
    expect(labels(submenu(mac, 'Core Hub')).slice(0, 2)).toEqual([
      'About Core Hub',
      'Check for updates…',
    ]);
    expect(labels(submenu(mac, 'Help'))).toEqual(['Core Hub on GitHub']);

    const tray = trayMenuTemplate(t, actions(), { check: true, ready: '1.2.0' });
    expect(labels(tray)).toEqual([
      'Open Core Hub',
      'Change connection…',
      'Check for updates…',
      'Restart to update to \u20681.2.0\u2069',
      'Quit Core Hub',
    ]);
  });
});
