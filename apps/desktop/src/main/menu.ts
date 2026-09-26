/**
 * The application menu and the tray menu, as templates. Pure: the labels come from the
 * app's catalogue (Electron's own role labels are English-only outside macOS), and the
 * actions are handed in, so a test can read the menu without starting Electron.
 */
import type { MenuItemConstructorOptions } from 'electron';
import { isolate } from '../shared/i18n.js';

export interface MenuActions {
  showWindow(): void;
  changeConnection(): void;
  openWebsite(): void;
  quit(): void;
  /** Looks for a new version now and shows the answer (DECISIONS §108). */
  checkForUpdates(): void;
  /** Installs the downloaded version and starts it again. */
  restartToUpdate(): void;
}

/**
 * The update items: "Check for updates…" unless the app never looks (the Store build), and
 * "Restart to update" once a new version is downloaded.
 */
export interface MenuUpdates {
  check: boolean;
  /** The downloaded version waiting for a restart, or null. */
  ready: string | null;
}

type T = (key: string, params?: Record<string, string>) => string;

function updateItems(t: T, actions: MenuActions, updates: MenuUpdates | undefined) {
  const items: MenuItemConstructorOptions[] = [];
  if (updates?.check)
    items.push({ label: t('menu.check_updates'), click: () => actions.checkForUpdates() });
  if (updates?.ready)
    items.push({
      label: t('menu.restart_to_update', { version: isolate(updates.ready) }),
      click: () => actions.restartToUpdate(),
    });
  return items;
}

export function appMenuTemplate(
  t: T,
  actions: MenuActions,
  options: { platform: NodeJS.Platform; devTools: boolean; updates?: MenuUpdates },
): MenuItemConstructorOptions[] {
  const mac = options.platform === 'darwin';
  const updates = updateItems(t, actions, options.updates);
  const template: MenuItemConstructorOptions[] = [];
  if (mac)
    template.push({
      label: t('app.name'),
      submenu: [
        { role: 'about', label: t('menu.about') },
        ...updates,
        { type: 'separator' },
        { label: t('menu.change_connection'), click: () => actions.changeConnection() },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide') },
        { role: 'hideOthers', label: t('menu.hide_others') },
        { role: 'unhide', label: t('menu.show_all') },
        { type: 'separator' },
        { label: t('menu.quit'), accelerator: 'Cmd+Q', click: () => actions.quit() },
      ],
    });
  else
    template.push({
      label: t('menu.file'),
      submenu: [
        { label: t('menu.change_connection'), click: () => actions.changeConnection() },
        { type: 'separator' },
        { label: t('menu.quit'), accelerator: 'Ctrl+Q', click: () => actions.quit() },
      ],
    });
  template.push(
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.select_all') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        ...(options.devTools
          ? [{ role: 'toggleDevTools', label: t('menu.devtools') } as MenuItemConstructorOptions]
          : []),
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.zoom_reset') },
        { role: 'zoomIn', label: t('menu.zoom_in') },
        { role: 'zoomOut', label: t('menu.zoom_out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'close', label: t('menu.close') },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        { label: t('menu.website'), click: () => actions.openWebsite() },
        // On macOS they sit in the app menu, under About.
        ...(mac || updates.length === 0
          ? []
          : [{ type: 'separator' } as MenuItemConstructorOptions, ...updates]),
      ],
    },
  );
  return template;
}

export function trayMenuTemplate(
  t: T,
  actions: MenuActions,
  updates?: MenuUpdates,
): MenuItemConstructorOptions[] {
  const items = updateItems(t, actions, updates);
  return [
    { label: t('tray.show'), click: () => actions.showWindow() },
    { label: t('tray.change_connection'), click: () => actions.changeConnection() },
    ...(items.length > 0 ? [{ type: 'separator' } as MenuItemConstructorOptions, ...items] : []),
    { type: 'separator' },
    { label: t('tray.quit'), click: () => actions.quit() },
  ];
}
