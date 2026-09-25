# Client screen coverage

Every destination of the navigation map (`docs/mobile/NAVIGATION.md` of the
phone clients today; `docs/clients/NAVIGATION.md` once it is moved here) mapped
to the operations (`operationId` in `packages/contracts/openapi.yaml`) and the
realtime events (`packages/contracts/events/`) it uses. A screen with no row
is a contract bug. `scripts` in the contracts package will read this file and
fail if an `operationId` here does not exist or an operation exists that no
screen (or the "not reached from a screen" list) claims.

Legend: **reads** = data the screen shows · **acts** = what the person can do
· **events** = what changes it live. Cross-cutting rows come first.

## Cross-cutting

| Surface | Reads | Acts | Events |
|---|---|---|---|
| Sign-in / QR pairing | `meta.get` (compatibility, `setup_required`) | `auth.claimPairing` (scan), `auth.login` (fallback), `auth.refresh` (silent renew), `auth.logout` | — |
| Drawer footer: profile chip, model chip, connection dot, version, sign out | `auth.getMe`, `auth.listProfiles`, `models.getDefaults`, `models.listCatalogue`, `meta.get`, `meta.health` (connection dot, polled when no socket is open) | switch profile (header change + refetch), `auth.updateProfile` (default model, admin), `auth.logout` | socket connect state |
| Workspace switching | `auth.listProfiles` | change `X-Hub-Profile`, reconnect sockets | all namespaces re-subscribe |
| Pending-actions bar (approvals, questions and workflow gates anywhere; senders waiting to pair, for admins) | `sessions.listApprovals` (once per profile the person may enter), `agents.listPairing` (admins, the profile they are in) | `sessions.respondApproval`, open the item where it lives, open Global Agent | `approval.requested`, `approval.resolved` |
| Notices (bell) and push | `notify.listNotices`, `notify.getPreferences` | `notify.updateNotice`, `notify.markAllRead`, `notify.setPreferences`, `devices.registerPush` / `devices.unregisterPush` | `notice.created`, `notice.updated` |
| Attachments (composer `+` sheet, media cards, downloads) | `sessions.getAttachment`, `sessions.downloadAttachment` (Range) | `sessions.uploadAttachment`, `sessions.startUpload`, `sessions.uploadChunk`, `sessions.completeUpload`, `sessions.abortUpload`, `sessions.deleteAttachment` | — |
| Voice (mic, speak) | `models.getSpeech` (`stt.ready`, `tts.ready`) | `models.transcribe`, `models.synthesize` | — |
| Jobs (progress rows, "check for update", installs) | `jobs.list`, `jobs.get` | `jobs.cancel` | `job.queued`, `job.started`, `job.progress`, `job.completed`, `job.failed`, `job.cancelled` |

## Rail

| # | Destination | Reads | Acts | Events |
|---|---|---|---|---|
| 1 | `newChat` — New chat (draft over Conversation) | `agents.list` (agent picker), `models.listCatalogue`, `models.getDefaults` | `sessions.create` on first send, then Conversation | `session.created` |
| 2 | `search` — Search sheet | `sessions.list` with `q` (items carry `match`) | open Conversation, or Global Agent when `source = global_agent` | — |
| 3 | `deviceConnections` — Device connections › **App › Direct** | `devices.list`, `devices.get` | `auth.createPairing` (show QR), `auth.getPairing`, `auth.cancelPairing`, `devices.update` (rename), `devices.unlink` | `pairing.claimed`, `device.linked`, `device.updated`, `device.unlinked`, `device.online`, `device.offline` |
| 3 | `deviceConnections` › **App › Message push** | `devices.getRelay`, `devices.get` (`push`) | `devices.setRelay`, `devices.registerPush`, `devices.unregisterPush` | `device.updated` |
| 3 | `deviceConnections` › **Devices** (admin: peer hubs) | `devices.listPeers` | `devices.requestPeer`, `devices.updatePeer` (approve/reject/block/unblock), `devices.deletePeer`, `devices.createPeerInvite` (QR) | `job.*` (link request) |
| 4 | `agentManager` — Agent Manager (admin) | `agents.list`, `agents.getAvatar` | `agents.install`, `agents.upgrade`, `agents.uninstall`, `agents.checkUpdate`, `agents.update` (auto-update switch), `agents.discover`, open agent card | `agent.updated`, `job.*` |
| 5 | `models` — Models › **General Models** | `models.listProviders` (the ones added), `models.listProviderPresets` (what can be added, + `host` for the loopback warning), `models.getDefaults` | `models.probeProvider` (the dialog's Fetch), `models.createProvider` (preset or custom), `models.updateProvider` (key, base URL, visibility), `models.deleteProvider`, `models.refreshProvider`, `models.testProvider`, `models.putModel` (alias, visibility, context, custom), `models.deleteModel`, `models.startProviderSignIn`, `models.getProviderSignIn`, `models.completeProviderSignIn`, `models.setDefaults` (default + fallbacks) | `job.completed` (refresh) |
| 5 | `models` › **Auxiliary Models** | `models.getDefaults` (`auxiliary.tasks`, `assignments`) | `models.setDefaults` | — |
| 5 | `models` › **Model Ensembles** | `models.listEnsembles` | `models.createEnsemble`, `models.updateEnsemble` (enable, activate), `models.deleteEnsemble` | — |
| 5 | `models` › **STT providers** | `models.getSpeech` (`stt`) | `models.updateSpeech` (`stt_provider_id`, keys, settings) | — |
| 5 | `models` › **TTS providers** | `models.getSpeech` (`tts`), `models.listVoices` | `models.updateSpeech` (`tts_provider_id`, voice, keys) | — |

## Segments

| # | Destination | Reads | Acts | Events |
|---|---|---|---|---|
| 6 | `chat` — session list (RECENT, pinned, categories, uncategorized, profile filter) | `sessions.list`, `sessions.listCategories` | `sessions.update` (rename, pin, category, archive), `sessions.delete`, `sessions.export`, `sessions.createCategory`, `sessions.updateCategory`, `sessions.deleteCategory` | `session.created`, `session.updated`, `session.deleted`, `run.started` / `run.completed` (streaming ring) |
| 7 | `groupChat` — rooms list, New room, Join by code | `rooms.list` (rows embed seats and `member_count`), `rooms.previewInvite` | `rooms.create`, `rooms.join`, `rooms.clone`, `rooms.update` (rename), `rooms.delete` | `room.created`, `room.updated`, `room.deleted` |
| 8 | `workflow` — workflow list with status badges | `schedules.listWorkflows` | `schedules.createWorkflow`, `schedules.runWorkflow`, `schedules.deleteWorkflow`, `schedules.getWorkflow` (export = the document), `schedules.previewWorkflowImport`, `schedules.confirmWorkflowImport` | `workflow.created`, `workflow.updated`, `workflow.deleted` |
| 9 | `history` — History page (grouped by `source`, archived, multi-select) | `sessions.list` (`archived=all`, `source`), `sessions.listCategories` | `sessions.bulkUpdate` (archive / unarchive / category), `sessions.bulkDelete`, `sessions.update`, `sessions.export` | `session.updated`, `session.deleted` |

## Settings (one screen) and its Tools

| # | Destination / tab | Reads | Acts | Events |
|---|---|---|---|---|
| 10 | `settings` › **Current Account** | `auth.getMe`, `auth.getUserAvatar`, `auth.listLockouts` (admin), `auth.listAppTokens` | `auth.updateMe` (display name, username, avatar, locale), `auth.changePassword`, `auth.clearLockouts`, `auth.createAppToken`, `auth.revokeAppToken`, `auth.logout` | — |
| 10 | `settings` › **Account Management** (admin) | `auth.listUsers`, `auth.getUser`, `auth.listProfiles` (profile chips) | `auth.createUser`, `auth.updateUser`, `auth.deleteUser` | — |
| 10 | `settings` › **Webhooks** (admin) | `notify.listWebhooks`, `notify.listWebhookEvents`, `notify.listWebhookDeliveries` | `notify.createWebhook`, `notify.updateWebhook`, `notify.deleteWebhook`, `notify.testWebhook`, `notify.redeliverWebhookDelivery` | `job.completed` (test); outgoing: `webhooks.hubEvent` (§59) |
| 10 | `settings` › **Display** | `auth.getPreferences` (theme, locale, text scale, link target, busy-input mode, streaming, compact, reasoning, tool calls, cost, diffs, sounds, notify flags) | `auth.setPreferences` | — |
| 10 | `settings` › **Proxy** / **Compression** / **Privacy** | `auth.getProfileSettings` | `auth.updateProfileSettings` (one section per save; proxy returns a restart job) | `job.*` |
| 10 | `settings` › **Models** (provider keys only) | `models.listProviders` | `models.updateProvider` (`api_key`) | — |
| 10 | `settings` › **This device** | `devices.get` (`this_device`), `auth.getPreferences` (`voice`), `updates.check`, `notify.getPreferences` | `devices.update` (name, capabilities, app version), `auth.setPreferences` (voice modes, dictation language, reasoning effort), `updates.download` (Range), `devices.registerPush` | `device.updated`, `notice.created` (`update_available`) |
| 10 | `settings` › **About** | `meta.get` (server name/version/contract), `updates.check` | — | — |
| 11 | `logs` — Logs | `audit.getReport` (`kind=logs`, `q`, `level`) — Phase 4 stub, `501` until then | — | — |
| 12 | `usage` — Usage | `audit.getReport` (`kind=usage`, `days`) — Phase 4 stub | — | — |
| 13 | `performance` — Performance (admin) | `audit.getReport` (`kind=performance`) — Phase 4 stub, pollable | — | — |
| 14 | `skillsUsage` — Skills Usage | `audit.getReport` (`kind=skills`, `days`) — Phase 4 stub | — | — |
| 15 | `theme` — Theme (server theme and background, per workspace) | `auth.getProfileSettings` (`appearance`), `sessions.getAttachment` (background) | `auth.updateProfileSettings` (`appearance`), `sessions.uploadAttachment` (`purpose=background`), `sessions.deleteAttachment` | — |
| 16 | `profiles` — Profiles (admin) | `auth.listProfiles`, `auth.getProfile`, `agents.list` (`runtime.state` per agent) | `auth.createProfile` (incl. clone), `auth.updateProfile` (rename, slug, avatar, default model), `auth.deleteProfile`, `auth.exportProfile`, `auth.importProfile`, `agents.restart` (runtime restart), "Edit config" → `files` | `agent.updated`, `job.*` |

## Root content with a payload

| # | Destination | Reads | Acts | Events |
|---|---|---|---|---|
| 17 | `conversation` — Conversation (transcript, composer, session settings sheet, interaction cards, location consent, media players, message actions) | `sessions.get` (session + active/queued runs + pending approvals + context), `sessions.listMessages` (backwards paging), `sessions.listRuns`, `sessions.getRun`, `sessions.getTrajectory` (the Trajectory tab and its session log), `sessions.getApproval`, `models.listCatalogue`, `devices.listRequests` (`status=pending`), `devices.getRequest` | `sessions.createRun` (`when: queue / next / interrupt`), `sessions.cancelRun`, `sessions.update` (model, reasoning effort, working dir, notify, title, category, archive), `sessions.fork`, `sessions.export`, `sessions.delete`, `sessions.respondApproval`, `devices.respondRequest` (share / decline location), attachments and voice rows above | `message.created`, `message.delta`, `reasoning.delta`, `tool.started`, `tool.completed`, `tool.failed`, `run.queued`, `run.started`, `run.completed`, `run.failed`, `run.cancelled`, `approval.requested`, `approval.resolved`, `context.updated`, `session.updated`, `session.deleted`, `request.created`, `request.completed` |
| 18 | `room` — Room (transcript, panels: banners, activity strip, queue, handoff chains; composer with mentions; room settings sheet; seat editor; invite QR) | `rooms.get` (room + seats + members + runs + approvals + chains + memory + typing), `rooms.listMessages`, `rooms.listRuns`, `rooms.listMembers`, `rooms.getMemory`, `rooms.listHandoffs`, `rooms.listSeatPresets`, `agents.list`, `models.listCatalogue` | `rooms.postMessage` (structured `mentions`), `rooms.stopSeat`, `rooms.update`, `rooms.rotateInviteCode`, `rooms.addSeat`, `rooms.updateSeat`, `rooms.removeSeat`, `rooms.removeMember` (leave / kick), `rooms.putMemory`, `rooms.refreshMemory`, `rooms.clearContext`, `rooms.continueHandoff`, `rooms.createSeatPreset`, `rooms.updateSeatPreset`, `rooms.deleteSeatPreset`, `sessions.respondApproval`, `sessions.cancelRun` (queue item), attachments and voice rows above | `room.updated`, `room.deleted`, `room.cleared`, `member.joined`, `member.left`, `member.typing`, `seat.added`, `seat.updated`, `seat.removed`, `message.created`, `message.delta`, `reasoning.delta`, `tool.*`, `run.*`, `approval.*`, `handoff.updated`, `memory.updated` |
| 19 | `workflowDetail` — Workflow details (graph summary, run history, schedules tab) | `schedules.getWorkflow`, `schedules.listWorkflowRuns`, `schedules.list` (`workflow_id`), `schedules.listDeliveryTargets` | `schedules.updateWorkflow`, `schedules.runWorkflow`, `schedules.deleteWorkflowRun`, `schedules.create` / `schedules.update` / `schedules.delete` (workflow schedules), `schedules.runNow` | `workflow.updated`, `workflow_run.started`, `workflow_run.completed`, `workflow_run.failed`, `workflow_run.cancelled`, `schedule.created`, `schedule.updated`, `schedule.deleted`, `schedule.fired` |
| 20 | `workflowRun` — Workflow run (node timeline, approve/reject, rerun from node, show output) | `schedules.getWorkflowRun`, `sessions.listMessages` (a step's `session_id` → its output), `sessions.getApproval` | `schedules.cancelWorkflowRun`, `schedules.rerunWorkflowFromNode`, `sessions.respondApproval` (step gate) | `workflow_run.*`, `step.started`, `step.waiting`, `step.completed`, `step.failed`, `approval.requested`, `approval.resolved` |

## Under the agent (entered from an Agent Manager card)

| # | Destination | Reads | Acts | Events |
|---|---|---|---|---|
| 21–23 | `agentHermes` / `agentEkko` / `agentCoding` — the agent screen (card header, CLI details, capability rows from `agent.sections`, settings row last) | `agents.get`, `agents.getAvatar` | `agents.install`, `agents.upgrade`, `agents.uninstall`, `agents.checkUpdate`, `agents.restart`, `agents.update` | `agent.updated`, `job.*` |
| 24 | `jobs` — Jobs (schedules of this agent, editor, run history, run output) | `schedules.list` (`agent_id`), `schedules.get`, `schedules.listRuns`, `schedules.getRun`, `schedules.listDeliveryTargets`, `agents.listSkills` (skills picker), `models.listCatalogue` (model picker) | `schedules.create`, `schedules.update` (pause = `enabled:false`), `schedules.delete`, `schedules.runNow`, `schedules.deleteRun` | `schedule.created`, `schedule.updated`, `schedule.deleted`, `schedule.fired`, `schedule_run.started`, `schedule_run.completed`, `schedule_run.failed` |
| 25 | `tasks` — Tasks (project picker, stats chips, columns, card, drop sheets, task detail with subtasks/comments/runs/activity) | `tasks.listProjects`, `tasks.getProject`, `tasks.getColumns` (columns + counts in one call), `tasks.listTasks` (filters), `tasks.getTask`, `tasks.listActivity`, `tasks.getWorktree`, `agents.list` (assignees) | `tasks.createProject`, `tasks.updateProject`, `tasks.deleteProject`, `tasks.createTask`, `tasks.updateTask`, `tasks.moveTask` (every drop; `409 state_invalid` lists allowed targets), `tasks.assignTask`, `tasks.unassignTask`, `tasks.stopTask`, `tasks.bulkUpdateTasks` (archive), `tasks.bulkDeleteTasks`, `tasks.deleteTask`, `tasks.createSubtask`, `tasks.updateSubtask`, `tasks.deleteSubtask`, `tasks.setDependencies`, `tasks.createComment`, `tasks.createWorktree`, `tasks.deleteWorktree`, `tasks.dispatch` | `project.created`, `project.updated`, `project.deleted`, `task.created`, `task.updated`, `task.moved`, `task.deleted`, `task.assigned`, `task.unassigned`, `subtask.updated`, `comment.created`, `worktree.updated`, plus `run.*` on the task session |
| 26 | `channels` — Channels (per-platform fields, enable/disable, clear credentials, QR login) | `agents.listChannels` (fields served per platform) | `agents.updateChannel`, `agents.clearChannel`, `agents.loginChannel`, `agents.restart` | `agent.updated`, `job.queued`, `job.progress` (QR), `job.completed`, `job.failed` |
| 27 | `skills` — Skills (categories, toggle, pin, content, import, pending write approvals) | `agents.listSkills`, `agents.getSkill`, `sessions.listApprovals` (`kind = skill_write`) | `agents.putSkill`, `agents.updateSkill`, `agents.deleteSkill`, `agents.importSkills` (via `sessions.uploadAttachment` `purpose=skill`), `sessions.respondApproval` | `agent.updated`, `approval.requested`, `approval.resolved` |
| 28 | `plugins` — Plugins (Hermes plugins; dsh plugin inventory with tri-state entries) | `agents.listPlugins` | `agents.updatePlugin` (enable/disable when `manageable`) | `agent.updated` |
| 29 | `presets` — Presets (dsh only) | `agents.listPresets`, `agents.getPreset` | `agents.activatePreset`, `agents.deletePreset` | `agent.updated` |
| 30 | `mcp` — MCP (servers, tools, test, reload) | `agents.listMcpServers` | `agents.createMcpServer`, `agents.updateMcpServer` (config or toggle), `agents.deleteMcpServer`, `agents.testMcpServer` | `agent.updated` |
| 31 | `memory` — Memory (Hermes documents `memory` / `user` / `soul`; Ekko entries with revisions) | `agents.listMemory` (`q`) | `agents.putMemoryItem` (`revision` for optimistic concurrency; `202` when a write needs approval), `agents.deleteMemoryItem`, `sessions.respondApproval` (`kind = memory_write`) | `agent.updated`, `approval.requested`, `approval.resolved` |
| 32 | `journey` — Journey (graph of skills/tools used) | `agents.getJourney` | — | — |
| 33 | `hermesSettings` — Settings (tabs Agent / Memory / Session / Gateway from `sections`) | `agents.getSettings` | `agents.updateSettings` (one section per save; `restart_job_id` when needed) | `agent.updated`, `job.*` |
| 34 | `ekkoSettings` — Settings (Runtime / Model / Compression / Tools / Modules / Advanced from `sections`; `json` fields) | `agents.getSettings` | `agents.updateSettings` | `agent.updated` |
| 35 | `codingAgentSettings` — Settings (the agent's two config files) | `agents.listConfigFiles`, `agents.getConfigFile` | `agents.putConfigFile` (`revision`) | `agent.updated` |

## No menu entry (reached from elsewhere)

| # | Destination | Reads | Acts | Events |
|---|---|---|---|---|
| 36 | `globalAgent` — Global Agent (from a search hit or the pending-actions bar) | `sessions.openGlobalAgent` (the caller's own conversation in the profile, made on first open), then the Conversation row | Conversation row (archive is refused with `409 state_invalid`) | as Conversation |
| 37 | `files` — Files (from a profile card's "Edit config": the workspace's Hermes config files) | `agents.listConfigFiles`, `agents.getConfigFile` (for the profile's `hermes` agent) | `agents.putConfigFile` | `agent.updated` |

## Operations not reached from a phone screen

These exist for other clients or for machines; they are still part of Phase 0/1
because the web/desktop clients or adapters need them.

| Operation | Who uses it |
|---|---|
| `devices.createRequest` | agent adapters and integrations with the `device` scope (the phone only answers) |
| `updates.listReleases`, `updates.publishRelease`, `updates.deleteRelease`, `updates.getSettings`, `updates.setSettings` | the web admin "Updates" page (Phase 2) and CI publishing the `test` channel |
| `knowledge.listItems`, `plugins.list` | Phase 4 screens (Journal / Notes, Hub plugins); reserved so clients generate against them now |
| `rooms.previewInvite`, `rooms.join` when opened from a `https://<hub>/join/<code>` link | the web client's public join route; the phones call them from "Join by code" (row 7) |

## Inventory reconciliation

Every screen in `NavDestination` (Kotlin and Swift, 37 cases) has a row above;
the Settings tabs and Models tabs, which are not destinations, have their own
rows. Nothing the phone shows today lacks a source, and every source is in the
contract, including the data the phone currently hard-codes: the agent
catalogue (`agents.list`, visible to every user), channel field sets
(`agents.listChannels`), webhook event names (`notify.listWebhookEvents`),
auxiliary model roles (`models.getDefaults.auxiliary.tasks`), settings choices
(`agents.getSettings` options) and STT/TTS provider lists (`models.getSpeech`).
