// The router registry: exactly one screen per destination of docs/clients/navigation.json on
// this surface, at the path the manifest gives it (`surfaceRoutes.web`). The parity test
// (tests/navigation.parity.test.ts) compares this list with the manifest.
import type { ReactElement } from 'react';
import { AgentManagerScreen } from '../agents/AgentManagerScreen.js';
import { AgentSettingsScreen } from '../agents/AgentSettingsScreen.js';
import { AgentChannelsScreen } from '../agents/AgentChannelsScreen.js';
import { AgentConfigFilesScreen } from '../agents/AgentConfigFilesScreen.js';
import { AgentJobsScreen } from '../agents/AgentJobsScreen.js';
import { AgentMcpScreen } from '../agents/AgentMcpScreen.js';
import { AgentMemoryScreen } from '../agents/AgentMemoryScreen.js';
import { AgentPluginsScreen } from '../agents/AgentPluginsScreen.js';
import { AgentSkillsScreen } from '../agents/AgentSkillsScreen.js';
import { SchedulesScreen } from '../schedules/SchedulesScreen.js';
import { TasksScreen } from '../tasks/TasksScreen.js';
import { RoomsScreen } from '../rooms/RoomsScreen.js';
import { ChatScreen } from '../chat/ChatScreen.js';
import { ModelsScreen } from '../models/ModelsScreen.js';
import { DeviceConnectionsScreen } from '../screens/DeviceConnectionsScreen.js';
import { GlobalAgentScreen } from '../screens/GlobalAgentScreen.js';
import { LinkedHubsScreen } from '../screens/LinkedHubsScreen.js';
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
  linked_hubs: () => <LinkedHubsScreen />,
  agent_manager: () => <AgentManagerScreen />,
  agent_settings: () => <AgentSettingsScreen />,
  agent_skills: () => <AgentSkillsScreen />,
  agent_mcp: () => <AgentMcpScreen />,
  agent_memory: () => <AgentMemoryScreen />,
  agent_channels: () => <AgentChannelsScreen />,
  agent_jobs: () => <AgentJobsScreen />,
  agent_plugins: () => <AgentPluginsScreen />,
  agent_config_files: () => <AgentConfigFilesScreen />,
  chat: () => <ChatScreen />,
  rooms: () => <RoomsScreen />,
  tasks: () => <TasksScreen />,
  schedules: () => <SchedulesScreen />,
  models: () => <ModelsScreen />,
  global_agent: () => <GlobalAgentScreen />,
};

function elementFor(id: string): ReactElement {
  const special = SPECIAL[id];
  if (special) return special();
  // The pages that need a screen of their own (the agents and their pages, models, devices)
  // are in SPECIAL above. Everything else under /settings — tabs, tools, and `knowledge`, which
  // is a list and not a manager — is a section of the Settings screen.
  if (
    id === 'settings' ||
    navigation.settingsTabs.includes(id) ||
    navigation.settingsTools.includes(id) ||
    navigation.settingsManagement.includes(id)
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
