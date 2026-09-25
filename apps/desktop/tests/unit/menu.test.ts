// The menus in both languages, without starting Electron.
import { describe, expect, it, vi } from 'vitest';
import { translate } from '../../src/shared/i18n.js';
import { appMenuTemplate, trayMenuTemplate, type MenuActions } from '../../src/main/menu.js';

const actions = (): MenuActions => ({
  showWindow: vi.fn(),
  changeConnection: vi.fn(),
  openWebsite: vi.fn(),
  quit: vi.fn(),
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
});
