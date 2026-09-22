// The router registry: exactly one screen per destination of docs/clients/navigation.json on
// this surface, at the path the manifest gives it (`surfaceRoutes.web`). The parity test
// (tests/navigation.parity.test.ts) compares this list with the manifest.
import type { ReactElement } from 'react';
import { AgentManagerScreen } from '../agents/AgentManagerScreen.js';
import { ChatScreen } from '../chat/ChatScreen.js';
import { ModelsScreen } from '../models/ModelsScreen.js';
import { DeviceConnectionsScreen } from '../screens/DeviceConnectionsScreen.js';
import { HistoryScreen } from '../screens/HistoryScreen.js';
import { NewChatScreen } from '../screens/NewChatScreen.js';
import { PlaceholderScreen } from '../screens/PlaceholderScreen.js';
import { SearchScreen } from '../screens/SearchScreen.js';
import { SettingsScreen } from '../settings/SettingsScreen.js';
import { navigation, preAuthRouteOf, routeOf, webDestinations } from './manifest.js';

export interface RouteEntry {
  /** The destination id (NAVIGATION). */
  id: string;
  path: string;
  element: ReactElement;
}

const SPECIAL: Record<string, () => ReactElement> = {
  new_chat: () => <NewChatScreen />,
  search: () => <SearchScreen />,
  device_connections: () => <DeviceConnectionsScreen />,
  agent_manager: () => <AgentManagerScreen />,
  chat: () => <ChatScreen />,
  history: () => <HistoryScreen />,
  models: () => <ModelsScreen />,
};

function elementFor(id: string): ReactElement {
  const special = SPECIAL[id];
  if (special) return special();
  // The management pages (agents, models, devices, knowledge) live under /settings but are
  // screens of their own, not sections of the Settings screen: they keep their own component.
  if (
    id === 'settings' ||
    navigation.settingsTabs.includes(id) ||
    navigation.settingsTools.includes(id)
  )
    return <SettingsScreen id={id} />;
  return <PlaceholderScreen id={id} />;
}

export const routes: readonly RouteEntry[] = webDestinations.map((d) => ({
  id: d.id,
  path: routeOf(d.id),
  element: elementFor(d.id),
}));

// Pre-auth screens come from the manifest too (`preAuth`), so no client invents a path.
export const LOGIN_PATH = preAuthRouteOf('login');
export const SETUP_PATH = preAuthRouteOf('setup');
export const HOME_PATH = routeOf('chat').split('/:')[0] ?? '/';
