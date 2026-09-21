CREATE TABLE `app_tokens` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text(26) NOT NULL,
	`kind` text DEFAULT 'personal' NOT NULL,
	`name` text(120) NOT NULL,
	`token_hash` text(64) NOT NULL,
	`token_prefix` text(8) NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`device_id` text(26),
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "app_tokens_kind_check" CHECK("app_tokens"."kind" in ('personal', 'device', 'web'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_tokens_hash_uq` ON `app_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `app_tokens_user_idx` ON `app_tokens` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `login_lockouts` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`subject_kind` text NOT NULL,
	`subject` text(128) NOT NULL,
	`kind` text DEFAULT 'password' NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer,
	`locked_until` integer,
	CONSTRAINT "login_lockouts_subject_kind_check" CHECK("login_lockouts"."subject_kind" in ('ip', 'user')),
	CONSTRAINT "login_lockouts_kind_check" CHECK("login_lockouts"."kind" in ('password', 'token', 'pairing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_lockouts_subject_uq` ON `login_lockouts` (`subject_kind`,`subject`,`kind`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`code` text(12) NOT NULL,
	`created_by_user_id` text(26) NOT NULL,
	`initial_workspace_id` text(26),
	`connection` text DEFAULT 'lan' NOT NULL,
	`hub_url` text(512) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`cancelled_at` integer,
	`device_id` text(26),
	`app_token_id` text(26),
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`initial_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`app_token_id`) REFERENCES `app_tokens`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "pairing_codes_connection_check" CHECK("pairing_codes"."connection" in ('lan', 'relay'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_codes_code_uq` ON `pairing_codes` (`code`);--> statement-breakpoint
CREATE INDEX `pairing_codes_expires_idx` ON `pairing_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`username` text(64) NOT NULL,
	`display_name` text(120),
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`password_hash` text NOT NULL,
	`password_changed_at` integer,
	`locale` text DEFAULT 'ar' NOT NULL,
	`avatar_mime` text(64),
	`default_workspace_id` text(26),
	`preferences` text DEFAULT '{}' NOT NULL,
	`last_login_at` integer,
	FOREIGN KEY (`default_workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "users_role_check" CHECK("users"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "users_status_check" CHECK("users"."status" in ('active', 'disabled')),
	CONSTRAINT "users_locale_check" CHECK("users"."locale" in ('ar', 'en'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_uq` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`user_id` text(26) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_members_workspace_user_uq` ON `workspace_members` (`workspace`,`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`slug` text(64) NOT NULL,
	`name` text(120) NOT NULL,
	`description` text,
	`color` text(16),
	`icon` text(64),
	`avatar_mime` text(64),
	`is_default` integer DEFAULT false NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_uq` ON `workspaces` (`slug`);--> statement-breakpoint
CREATE TABLE `agent_adapters` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text(120) NOT NULL,
	`version` text(32) NOT NULL,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`last_probe_at` integer,
	`last_error` text,
	CONSTRAINT "agent_adapters_kind_check" CHECK("agent_adapters"."kind" in ('acp', 'hermes', 'process')),
	CONSTRAINT "agent_adapters_status_check" CHECK("agent_adapters"."status" in ('available', 'unavailable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_adapters_kind_uq` ON `agent_adapters` (`kind`);--> statement-breakpoint
CREATE TABLE `agent_settings` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`agent_id` text(26) NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`default_model_id` text(26),
	`approval_mode` text DEFAULT 'ask' NOT NULL,
	`max_turns` integer,
	`working_dir` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`secret_refs` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_settings_approval_mode_check" CHECK("agent_settings"."approval_mode" in ('ask', 'auto_safe', 'auto_all'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_settings_workspace_agent_uq` ON `agent_settings` (`workspace`,`agent_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`slug` text(64) NOT NULL,
	`name` text(120) NOT NULL,
	`description` text,
	`icon` text(64),
	`adapter_id` text(26) NOT NULL,
	`adapter_kind` text NOT NULL,
	`source` text DEFAULT 'detected' NOT NULL,
	`command` text DEFAULT '[]' NOT NULL,
	`executable_path` text,
	`endpoint` text,
	`version` text(64),
	`install_state` text DEFAULT 'not_installed' NOT NULL,
	`install_job_id` text(26),
	`detected_at` integer,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`limited` integer DEFAULT false NOT NULL,
	`last_error` text,
	`archived_at` integer,
	FOREIGN KEY (`adapter_id`) REFERENCES `agent_adapters`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agents_adapter_kind_check" CHECK("agents"."adapter_kind" in ('acp', 'hermes', 'process')),
	CONSTRAINT "agents_source_check" CHECK("agents"."source" in ('detected', 'manual', 'bundled')),
	CONSTRAINT "agents_install_state_check" CHECK("agents"."install_state" in ('not_installed', 'installing', 'installed', 'updating', 'broken'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_uq` ON `agents` (`slug`);--> statement-breakpoint
CREATE INDEX `agents_adapter_idx` ON `agents` (`adapter_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`run_id` text(26) NOT NULL,
	`tool_call_id` text(26),
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`title` text(200) NOT NULL,
	`description` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`response` text,
	`responded_by_user_id` text(26),
	`remember` integer DEFAULT false NOT NULL,
	`requested_at` integer NOT NULL,
	`responded_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "approvals_kind_check" CHECK("approvals"."kind" in ('tool_call', 'plan', 'memory_write', 'skill_write', 'question')),
	CONSTRAINT "approvals_status_check" CHECK("approvals"."status" in ('pending', 'approved', 'denied', 'answered', 'expired', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `approvals_workspace_pending_idx` ON `approvals` (`workspace`,`status`,`requested_at`);--> statement-breakpoint
CREATE INDEX `approvals_run_idx` ON `approvals` (`run_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`session_id` text(26) NOT NULL,
	`run_id` text(26),
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text(26),
	`content` text DEFAULT '' NOT NULL,
	`parts` text DEFAULT '[]' NOT NULL,
	`reasoning` text,
	`attachment_ids` text DEFAULT '[]' NOT NULL,
	`agent_message_ref` text(200),
	`edited_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "messages_role_check" CHECK("messages"."role" in ('user', 'assistant', 'system', 'command', 'tool', 'event')),
	CONSTRAINT "messages_author_kind_check" CHECK("messages"."author_kind" in ('user', 'agent', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_seq_uq` ON `messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_run_idx` ON `messages` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`session_id` text(26) NOT NULL,
	`agent_id` text(26) NOT NULL,
	`trigger_message_id` text(26),
	`final_message_id` text(26),
	`status` text DEFAULT 'queued' NOT NULL,
	`job_id` text(26) NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`origin_kind` text DEFAULT 'user' NOT NULL,
	`origin_id` text(26),
	`model_label` text(200),
	`provider` text(120),
	`reasoning_effort` text,
	`adapter_kind` text(16) NOT NULL,
	`agent_run_ref` text(200),
	`started_at` integer,
	`finished_at` integer,
	`interrupt_requested_at` integer,
	`cancel_reason` text(200),
	`error_code` text(64),
	`error_message` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`final_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "runs_status_check" CHECK("runs"."status" in ('queued', 'starting', 'streaming', 'waiting_approval', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'timed_out')),
	CONSTRAINT "runs_origin_kind_check" CHECK("runs"."origin_kind" in ('user', 'task', 'schedule', 'workflow', 'room', 'api'))
);
--> statement-breakpoint
CREATE INDEX `runs_session_idx` ON `runs` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_workspace_status_idx` ON `runs` (`workspace`,`status`);--> statement-breakpoint
CREATE INDEX `runs_origin_idx` ON `runs` (`origin_kind`,`origin_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`agent_id` text(26) NOT NULL,
	`title` text(200),
	`source` text DEFAULT 'chat' NOT NULL,
	`channel` text(60),
	`origin_kind` text DEFAULT 'user' NOT NULL,
	`origin_id` text(26),
	`model_id` text(26),
	`model_label` text(200),
	`provider` text(120),
	`reasoning_effort` text,
	`agent_session_ref` text(200),
	`working_dir` text,
	`worktree_id` text(26),
	`last_run_id` text(26),
	`last_message_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`preview` text(300),
	`pinned` integer DEFAULT false NOT NULL,
	`parent_session_id` text(26),
	`category_id` text(26),
	`notify` integer DEFAULT true NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`archived_at` integer,
	CONSTRAINT "sessions_origin_kind_check" CHECK("sessions"."origin_kind" in ('user', 'task', 'schedule', 'workflow', 'room', 'api')),
	CONSTRAINT "sessions_source_check" CHECK("sessions"."source" in ('chat', 'global_agent', 'room', 'task', 'schedule', 'workflow', 'channel', 'cli', 'api'))
);
--> statement-breakpoint
CREATE INDEX `sessions_workspace_recent_idx` ON `sessions` (`workspace`,`archived_at`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `sessions_workspace_agent_idx` ON `sessions` (`workspace`,`agent_id`);--> statement-breakpoint
CREATE INDEX `sessions_origin_idx` ON `sessions` (`origin_kind`,`origin_id`);--> statement-breakpoint
CREATE INDEX `sessions_workspace_source_idx` ON `sessions` (`workspace`,`source`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`run_id` text(26) NOT NULL,
	`message_id` text(26),
	`seq` integer NOT NULL,
	`agent_tool_call_ref` text(200),
	`name` text(120) NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`title` text(200),
	`input` text DEFAULT '{}' NOT NULL,
	`output` text,
	`output_truncated` integer DEFAULT false NOT NULL,
	`output_attachment_id` text(26),
	`subagent_id` text(120),
	`status` text DEFAULT 'pending' NOT NULL,
	`approval_id` text(26),
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`exit_code` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tool_calls_kind_check" CHECK("tool_calls"."kind" in ('shell', 'file_read', 'file_write', 'search', 'web', 'mcp', 'device', 'custom')),
	CONSTRAINT "tool_calls_status_check" CHECK("tool_calls"."status" in ('pending', 'running', 'succeeded', 'failed', 'denied', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_run_seq_uq` ON `tool_calls` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `tool_calls_message_idx` ON `tool_calls` (`message_id`);--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`room_id` text(26) NOT NULL,
	`from_seat_id` text(26) NOT NULL,
	`to_seat_id` text(26) NOT NULL,
	`request_message_id` text(26),
	`brief` text NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`accepted_at` integer,
	`completed_at` integer,
	`result_message_id` text(26),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_seat_id`) REFERENCES `seats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_seat_id`) REFERENCES `seats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`request_message_id`) REFERENCES `room_messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "handoffs_status_check" CHECK("handoffs"."status" in ('pending', 'accepted', 'completed', 'rejected', 'cancelled')),
	CONSTRAINT "handoffs_distinct_seats_check" CHECK("handoffs"."from_seat_id" <> "handoffs"."to_seat_id")
);
--> statement-breakpoint
CREATE INDEX `handoffs_room_status_idx` ON `handoffs` (`room_id`,`status`);--> statement-breakpoint
CREATE TABLE `room_members` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`room_id` text(26) NOT NULL,
	`user_id` text(26) NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "room_members_role_check" CHECK("room_members"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_members_room_user_uq` ON `room_members` (`room_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `room_messages` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`room_id` text(26) NOT NULL,
	`seq` integer NOT NULL,
	`author_kind` text NOT NULL,
	`author_user_id` text(26),
	`seat_id` text(26),
	`content` text DEFAULT '' NOT NULL,
	`parts` text DEFAULT '[]' NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`attachment_ids` text DEFAULT '[]' NOT NULL,
	`reply_to_id` text(26),
	`run_id` text(26),
	`handoff_id` text(26),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seat_id`) REFERENCES `seats`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reply_to_id`) REFERENCES `room_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`handoff_id`) REFERENCES `handoffs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "room_messages_author_kind_check" CHECK("room_messages"."author_kind" in ('user', 'seat', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_messages_room_seq_uq` ON `room_messages` (`room_id`,`seq`);--> statement-breakpoint
CREATE INDEX `room_messages_seat_idx` ON `room_messages` (`seat_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(120) NOT NULL,
	`description` text,
	`icon` text(64),
	`turn_policy` text DEFAULT 'mention' NOT NULL,
	`max_agent_turns` integer DEFAULT 4 NOT NULL,
	`memory` text,
	`memory_updated_at` integer,
	`message_count` integer DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`settings` text DEFAULT '{}' NOT NULL,
	`archived_at` integer,
	CONSTRAINT "rooms_turn_policy_check" CHECK("rooms"."turn_policy" in ('mention', 'round_robin', 'free'))
);
--> statement-breakpoint
CREATE INDEX `rooms_workspace_recent_idx` ON `rooms` (`workspace`,`archived_at`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `seats` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`room_id` text(26) NOT NULL,
	`agent_id` text(26) NOT NULL,
	`session_id` text(26) NOT NULL,
	`alias` text(64) NOT NULL,
	`persona` text,
	`color` text(16),
	`position` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	`last_spoke_at` integer,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "seats_status_check" CHECK("seats"."status" in ('active', 'muted', 'left'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seats_room_session_uq` ON `seats` (`room_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `seats_room_position_idx` ON `seats` (`room_id`,`position`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(120) NOT NULL,
	`key` text(10) NOT NULL,
	`description` text,
	`color` text(16),
	`repo_url` text,
	`local_path` text,
	`default_branch` text(120) DEFAULT 'main' NOT NULL,
	`default_agent_id` text(26),
	`status` text DEFAULT 'active' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`task_counter` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	CONSTRAINT "projects_status_check" CHECK("projects"."status" in ('active', 'paused', 'completed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_workspace_key_uq` ON `projects` (`workspace`,`key`);--> statement-breakpoint
CREATE INDEX `projects_workspace_idx` ON `projects` (`workspace`,`archived_at`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`task_id` text(26) NOT NULL,
	`depends_on_task_id` text(26) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_dependencies_no_self_check" CHECK("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_dependencies_pair_uq` ON `task_dependencies` (`task_id`,`depends_on_task_id`);--> statement-breakpoint
CREATE INDEX `task_dependencies_depends_on_idx` ON `task_dependencies` (`depends_on_task_id`);--> statement-breakpoint
CREATE TABLE `task_transitions` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`task_id` text(26) NOT NULL,
	`field` text DEFAULT 'status' NOT NULL,
	`from_value` text(64),
	`to_value` text(64) NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text(26),
	`run_id` text(26),
	`note` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_transitions_field_check" CHECK("task_transitions"."field" in ('status', 'assignee', 'priority', 'project')),
	CONSTRAINT "task_transitions_actor_kind_check" CHECK("task_transitions"."actor_kind" in ('user', 'agent', 'system', 'schedule', 'workflow'))
);
--> statement-breakpoint
CREATE INDEX `task_transitions_task_idx` ON `task_transitions` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`project_id` text(26) NOT NULL,
	`number` integer NOT NULL,
	`title` text(300) NOT NULL,
	`description` text,
	`status` text DEFAULT 'backlog' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignee_kind` text DEFAULT 'none' NOT NULL,
	`assignee_user_id` text(26),
	`assignee_agent_id` text(26),
	`parent_id` text(26),
	`sort_key` text(64) DEFAULT 'n' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`due_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`blocked_reason` text,
	`session_id` text(26),
	`current_run_id` text(26),
	`room_id` text(26),
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" in ('backlog', 'todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled')),
	CONSTRAINT "tasks_priority_check" CHECK("tasks"."priority" in ('urgent', 'high', 'normal', 'low')),
	CONSTRAINT "tasks_assignee_kind_check" CHECK("tasks"."assignee_kind" in ('none', 'user', 'agent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_number_uq` ON `tasks` (`project_id`,`number`);--> statement-breakpoint
CREATE INDEX `tasks_board_idx` ON `tasks` (`workspace`,`archived_at`,`status`,`sort_key`);--> statement-breakpoint
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_agent_idx` ON `tasks` (`assignee_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`project_id` text(26) NOT NULL,
	`task_id` text(26),
	`path` text NOT NULL,
	`branch` text(200) NOT NULL,
	`base_ref` text(64),
	`head_sha` text(64),
	`status` text DEFAULT 'creating' NOT NULL,
	`create_job_id` text(26),
	`pr_url` text,
	`stats` text DEFAULT '{}' NOT NULL,
	`last_synced_at` integer,
	`removed_at` integer,
	`error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "worktrees_status_check" CHECK("worktrees"."status" in ('creating', 'ready', 'dirty', 'merged', 'removed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_live_task_uq` ON `worktrees` (`task_id`) WHERE "worktrees"."removed_at" is null and "worktrees"."task_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_uq` ON `worktrees` (`path`);--> statement-breakpoint
CREATE INDEX `worktrees_project_idx` ON `worktrees` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `node_runs` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`workflow_run_id` text(26) NOT NULL,
	`node_key` text(64) NOT NULL,
	`node_type` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`input` text DEFAULT '{}' NOT NULL,
	`output` text,
	`error` text,
	`run_id` text(26),
	`approval_id` text(26),
	`task_id` text(26),
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "node_runs_node_type_check" CHECK("node_runs"."node_type" in ('agent_run', 'approval', 'condition', 'delay', 'webhook', 'task', 'notify', 'room_post')),
	CONSTRAINT "node_runs_status_check" CHECK("node_runs"."status" in ('pending', 'running', 'waiting_approval', 'succeeded', 'failed', 'skipped', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_runs_run_node_attempt_uq` ON `node_runs` (`workflow_run_id`,`node_key`,`attempt`);--> statement-breakpoint
CREATE TABLE `schedule_runs` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`schedule_id` text(26) NOT NULL,
	`scheduled_for` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`run_id` text(26),
	`workflow_run_id` text(26),
	`output_preview` text(500),
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "schedule_runs_status_check" CHECK("schedule_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_runs_schedule_tick_uq` ON `schedule_runs` (`schedule_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `schedule_runs_schedule_recent_idx` ON `schedule_runs` (`schedule_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(120) NOT NULL,
	`description` text,
	`kind` text DEFAULT 'cron' NOT NULL,
	`cron_expr` text(120),
	`timezone` text(64) DEFAULT 'UTC' NOT NULL,
	`interval_seconds` integer,
	`run_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`target_kind` text DEFAULT 'prompt' NOT NULL,
	`agent_id` text(26),
	`workflow_id` text(26),
	`prompt` text,
	`model_id` text(26),
	`skills` text DEFAULT '[]' NOT NULL,
	`delivery` text DEFAULT '{}' NOT NULL,
	`repeat_limit` integer,
	`repeat_count` integer DEFAULT 0 NOT NULL,
	`overlap_policy` text DEFAULT 'skip' NOT NULL,
	`misfire_policy` text DEFAULT 'skip' NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_status` text,
	`archived_at` integer,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "schedules_kind_check" CHECK("schedules"."kind" in ('cron', 'interval', 'once')),
	CONSTRAINT "schedules_target_kind_check" CHECK("schedules"."target_kind" in ('prompt', 'workflow')),
	CONSTRAINT "schedules_overlap_policy_check" CHECK("schedules"."overlap_policy" in ('skip', 'queue', 'parallel')),
	CONSTRAINT "schedules_misfire_policy_check" CHECK("schedules"."misfire_policy" in ('skip', 'run_once'))
);
--> statement-breakpoint
CREATE INDEX `schedules_due_idx` ON `schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `schedules_workspace_idx` ON `schedules` (`workspace`,`archived_at`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`workflow_id` text(26) NOT NULL,
	`schedule_id` text(26),
	`trigger_kind` text NOT NULL,
	`trigger_ref` text(26),
	`status` text DEFAULT 'queued' NOT NULL,
	`workflow_version` integer NOT NULL,
	`definition_snapshot` text NOT NULL,
	`input` text DEFAULT '{}' NOT NULL,
	`output` text,
	`active_node_keys` text DEFAULT '[]' NOT NULL,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workflow_runs_trigger_kind_check" CHECK("workflow_runs"."trigger_kind" in ('manual', 'schedule', 'event', 'api')),
	CONSTRAINT "workflow_runs_status_check" CHECK("workflow_runs"."status" in ('queued', 'running', 'waiting_approval', 'paused', 'succeeded', 'failed', 'cancelled', 'timed_out'))
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_idx` ON `workflow_runs` (`workflow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_workspace_status_idx` ON `workflow_runs` (`workspace`,`status`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(120) NOT NULL,
	`description` text,
	`version` integer DEFAULT 1 NOT NULL,
	`definition` text NOT NULL,
	`trigger_kind` text DEFAULT 'manual' NOT NULL,
	`event_key` text(64),
	`enabled` integer DEFAULT true NOT NULL,
	`archived_at` integer,
	CONSTRAINT "workflows_trigger_kind_check" CHECK("workflows"."trigger_kind" in ('manual', 'schedule', 'event'))
);
--> statement-breakpoint
CREATE INDEX `workflows_workspace_idx` ON `workflows` (`workspace`,`archived_at`);--> statement-breakpoint
CREATE INDEX `workflows_event_idx` ON `workflows` (`enabled`,`trigger_kind`,`event_key`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`filename` text(255) NOT NULL,
	`mime` text(120) NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text(64) NOT NULL,
	`storage_key` text NOT NULL,
	`kind` text DEFAULT 'file' NOT NULL,
	`source_kind` text DEFAULT 'upload' NOT NULL,
	`source_id` text(26),
	`meta` text DEFAULT '{}' NOT NULL,
	`expires_at` integer,
	`deleted_at` integer,
	CONSTRAINT "attachments_kind_check" CHECK("attachments"."kind" in ('image', 'audio', 'video', 'file', 'diff', 'log')),
	CONSTRAINT "attachments_source_kind_check" CHECK("attachments"."source_kind" in ('upload', 'agent_output', 'tool_output', 'device', 'journal', 'export'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_storage_key_uq` ON `attachments` (`storage_key`);--> statement-breakpoint
CREATE INDEX `attachments_workspace_sha_idx` ON `attachments` (`workspace`,`sha256`);--> statement-breakpoint
CREATE INDEX `attachments_expires_idx` ON `attachments` (`expires_at`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`date` text(10) NOT NULL,
	`seq` integer DEFAULT 1 NOT NULL,
	`mood` text(32),
	`body` text NOT NULL,
	`highlights` text DEFAULT '[]' NOT NULL,
	`author_kind` text DEFAULT 'user' NOT NULL,
	`author_agent_id` text(26),
	`attachment_ids` text DEFAULT '[]' NOT NULL,
	`run_id` text(26),
	`archived_at` integer,
	CONSTRAINT "journal_entries_author_kind_check" CHECK("journal_entries"."author_kind" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_entries_owner_day_seq_uq` ON `journal_entries` (`workspace`,`owner_id`,`date`,`seq`);--> statement-breakpoint
CREATE INDEX `journal_entries_workspace_date_idx` ON `journal_entries` (`workspace`,`date`);--> statement-breakpoint
CREATE TABLE `knowledge_notes` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`title` text(200) NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`source_kind` text DEFAULT 'user' NOT NULL,
	`source_agent_id` text(26),
	`project_id` text(26),
	`task_id` text(26),
	`links` text DEFAULT '[]' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	CONSTRAINT "knowledge_notes_kind_check" CHECK("knowledge_notes"."kind" in ('note', 'memory', 'snippet', 'report')),
	CONSTRAINT "knowledge_notes_source_kind_check" CHECK("knowledge_notes"."source_kind" in ('user', 'agent', 'import'))
);
--> statement-breakpoint
CREATE INDEX `knowledge_notes_workspace_idx` ON `knowledge_notes` (`workspace`,`archived_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `knowledge_notes_project_idx` ON `knowledge_notes` (`project_id`);--> statement-breakpoint
CREATE INDEX `knowledge_notes_task_idx` ON `knowledge_notes` (`task_id`);--> statement-breakpoint
CREATE TABLE `model_defaults` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`role` text NOT NULL,
	`model_id` text(26) NOT NULL,
	`fallback_model_ids` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "model_defaults_role_check" CHECK("model_defaults"."role" in ('chat', 'coding', 'titles', 'summaries', 'stt', 'tts', 'embedding'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_defaults_workspace_role_uq` ON `model_defaults` (`workspace`,`role`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`provider_id` text(26) NOT NULL,
	`model_key` text(200) NOT NULL,
	`label` text(200) NOT NULL,
	`kind` text DEFAULT 'chat' NOT NULL,
	`context_window` integer,
	`max_output_tokens` integer,
	`pricing` text DEFAULT '{}' NOT NULL,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'catalogue' NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "models_kind_check" CHECK("models"."kind" in ('chat', 'stt', 'tts', 'embedding', 'image')),
	CONSTRAINT "models_source_check" CHECK("models"."source" in ('catalogue', 'discovered', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_key_uq` ON `models` (`provider_id`,`model_key`);--> statement-breakpoint
CREATE INDEX `models_workspace_kind_idx` ON `models` (`workspace`,`kind`,`enabled`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`kind` text NOT NULL,
	`name` text(120) NOT NULL,
	`base_url` text,
	`api_key_secret_id` text(26),
	`headers` text DEFAULT '{}' NOT NULL,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'unconfigured' NOT NULL,
	`last_checked_at` integer,
	`last_error` text,
	`archived_at` integer,
	FOREIGN KEY (`api_key_secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "providers_kind_check" CHECK("providers"."kind" in ('anthropic', 'openai', 'openrouter', 'google', 'mistral', 'groq', 'ollama', 'openai_compatible', 'custom')),
	CONSTRAINT "providers_status_check" CHECK("providers"."status" in ('unconfigured', 'ok', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_workspace_name_uq` ON `providers` (`workspace`,`name`);--> statement-breakpoint
CREATE INDEX `providers_workspace_kind_idx` ON `providers` (`workspace`,`kind`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(120) NOT NULL,
	`kind` text DEFAULT 'generic' NOT NULL,
	`ciphertext` text,
	`nonce` text(32),
	`key_id` text(32) NOT NULL,
	`hint` text(4),
	`rotated_at` integer,
	`wiped_at` integer,
	`archived_at` integer,
	CONSTRAINT "secrets_kind_check" CHECK("secrets"."kind" in ('api_key', 'token', 'password', 'generic'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secrets_workspace_name_uq` ON `secrets` (`workspace`,`name`);--> statement-breakpoint
CREATE TABLE `device_commands` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`device_id` text(26) NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`requested_by_kind` text NOT NULL,
	`requested_by_id` text(26),
	`run_id` text(26),
	`result` text,
	`result_attachment_id` text(26),
	`error` text,
	`sent_at` integer,
	`completed_at` integer,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_commands_kind_check" CHECK("device_commands"."kind" in ('capture_photo', 'record_audio', 'read_clipboard', 'write_clipboard', 'open_url', 'locate', 'speak', 'show_notification', 'custom')),
	CONSTRAINT "device_commands_status_check" CHECK("device_commands"."status" in ('queued', 'sent', 'acked', 'completed', 'failed', 'expired', 'cancelled')),
	CONSTRAINT "device_commands_requester_check" CHECK("device_commands"."requested_by_kind" in ('user', 'agent', 'workflow'))
);
--> statement-breakpoint
CREATE INDEX `device_commands_device_pending_idx` ON `device_commands` (`device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `device_commands_run_idx` ON `device_commands` (`run_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`device_key` text(128) NOT NULL,
	`name` text(120) NOT NULL,
	`platform` text NOT NULL,
	`kind` text DEFAULT 'phone' NOT NULL,
	`brand` text(80),
	`model` text(120),
	`os_version` text(64),
	`app_version` text(32),
	`connection` text DEFAULT 'lan' NOT NULL,
	`push_provider` text DEFAULT 'none' NOT NULL,
	`push_token` text,
	`push_locale` text(8),
	`push_registered_at` integer,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'paired' NOT NULL,
	`app_token_id` text(26),
	`paired_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	CONSTRAINT "devices_platform_check" CHECK("devices"."platform" in ('android', 'ios', 'web', 'macos', 'windows', 'linux')),
	CONSTRAINT "devices_kind_check" CHECK("devices"."kind" in ('phone', 'tablet', 'computer', 'browser')),
	CONSTRAINT "devices_connection_check" CHECK("devices"."connection" in ('lan', 'relay')),
	CONSTRAINT "devices_push_provider_check" CHECK("devices"."push_provider" in ('none', 'fcm', 'apns', 'webpush')),
	CONSTRAINT "devices_status_check" CHECK("devices"."status" in ('paired', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `devices_owner_idx` ON `devices` (`owner_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_owner_key_uq` ON `devices` (`owner_id`,`device_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_app_token_uq` ON `devices` (`app_token_id`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`notification_id` text(26) NOT NULL,
	`channel` text NOT NULL,
	`device_id` text(26),
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`provider_ref` text(200),
	`last_error` text,
	`sent_at` integer,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_deliveries_channel_check" CHECK("notification_deliveries"."channel" in ('in_app', 'push', 'webhook')),
	CONSTRAINT "notification_deliveries_status_check" CHECK("notification_deliveries"."status" in ('queued', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_notification_idx` ON `notification_deliveries` (`notification_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_queue_idx` ON `notification_deliveries` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`kind` text(32) NOT NULL,
	`in_app` integer DEFAULT true NOT NULL,
	`push` integer DEFAULT true NOT NULL,
	`muted_until` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_owner_kind_uq` ON `notification_preferences` (`workspace`,`owner_id`,`kind`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`kind` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`title` text(200) NOT NULL,
	`body` text,
	`entity_kind` text(32),
	`entity_id` text(26),
	`data` text DEFAULT '{}' NOT NULL,
	`read_at` integer,
	`dismissed_at` integer,
	CONSTRAINT "notifications_kind_check" CHECK("notifications"."kind" in ('approval_requested', 'question_asked', 'run_completed', 'run_failed', 'task_assigned', 'task_moved', 'mention', 'handoff', 'schedule_failed', 'workflow_waiting', 'device_command', 'update_available', 'system')),
	CONSTRAINT "notifications_severity_check" CHECK("notifications"."severity" in ('info', 'warning', 'error', 'action_required'))
);
--> statement-breakpoint
CREATE INDEX `notifications_inbox_idx` ON `notifications` (`workspace`,`owner_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_entity_idx` ON `notifications` (`entity_kind`,`entity_id`);--> statement-breakpoint
CREATE TABLE `push_credentials` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`provider` text NOT NULL,
	`label` text(120) NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text(32) NOT NULL,
	`key_id` text(32) NOT NULL,
	`public_meta` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_error` text,
	CONSTRAINT "push_credentials_provider_check" CHECK("push_credentials"."provider" in ('fcm', 'apns', 'webpush'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_credentials_provider_uq` ON `push_credentials` (`provider`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`webhook_id` text(26) NOT NULL,
	`event_name` text(64) NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`response_status` integer,
	`last_error` text,
	`next_attempt_at` integer,
	`delivered_at` integer,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "webhook_deliveries_status_check" CHECK("webhook_deliveries"."status" in ('queued', 'delivered', 'failed', 'dead'))
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_retry_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(120) NOT NULL,
	`url` text NOT NULL,
	`signing_secret_id` text(26),
	`events` text DEFAULT '[]' NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_status` integer,
	`last_delivered_at` integer,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `webhooks_workspace_idx` ON `webhooks` (`workspace`,`enabled`,`archived_at`);--> statement-breakpoint
CREATE TABLE `channel_subscriptions` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`device_id` text(26) NOT NULL,
	`channel_id` text(26) NOT NULL,
	`last_reported_version` text(32),
	`last_checked_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `release_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_subscriptions_device_uq` ON `channel_subscriptions` (`device_id`);--> statement-breakpoint
CREATE TABLE `release_channels` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`key` text(32) NOT NULL,
	`name` text(120) NOT NULL,
	`description` text,
	`is_default` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_channels_key_uq` ON `release_channels` (`key`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`channel_id` text(26) NOT NULL,
	`platform` text NOT NULL,
	`version` text(32) NOT NULL,
	`build_number` integer,
	`notes_ar` text,
	`notes_en` text,
	`artifact_url` text,
	`artifact_sha256` text(64),
	`artifact_size_bytes` integer,
	`min_server_version` text(32),
	`mandatory` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`yanked_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `release_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "releases_platform_check" CHECK("releases"."platform" in ('android', 'ios', 'desktop_linux', 'desktop_macos', 'desktop_windows', 'web', 'server'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_channel_platform_version_uq` ON `releases` (`channel_id`,`platform`,`version`);--> statement-breakpoint
CREATE INDEX `releases_latest_idx` ON `releases` (`channel_id`,`platform`,`published_at`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26),
	`actor_kind` text NOT NULL,
	`actor_id` text(26),
	`action` text(64) NOT NULL,
	`entity_kind` text(32),
	`entity_id` text(26),
	`summary` text(300),
	`data` text DEFAULT '{}' NOT NULL,
	`device_id` text(26),
	`request_id` text(64),
	CONSTRAINT "audit_events_actor_kind_check" CHECK("audit_events"."actor_kind" in ('user', 'agent', 'system', 'schedule', 'workflow', 'device'))
);
--> statement-breakpoint
CREATE INDEX `audit_events_time_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_workspace_time_idx` ON `audit_events` (`workspace`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_entity_idx` ON `audit_events` (`entity_kind`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actor_kind`,`actor_id`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26),
	`job_id` text(26) NOT NULL,
	`seq` integer NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "job_events_level_check" CHECK("job_events"."level" in ('debug', 'info', 'warn', 'error', 'progress'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_events_job_seq_uq` ON `job_events` (`job_id`,`seq`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26),
	`kind` text(64) NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT -1 NOT NULL,
	`progress_message` text(300),
	`entity_kind` text(32),
	`entity_id` text(26),
	`input` text DEFAULT '{}' NOT NULL,
	`result` text,
	`error_code` text(64),
	`error_message` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`parent_job_id` text(26),
	`started_at` integer,
	`finished_at` integer,
	`cancel_requested_at` integer,
	`heartbeat_at` integer,
	FOREIGN KEY (`parent_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "jobs_status_check" CHECK("jobs"."status" in ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_workspace_idx` ON `jobs` (`workspace`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_entity_idx` ON `jobs` (`entity_kind`,`entity_id`);--> statement-breakpoint
CREATE TABLE `performance_snapshots` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`captured_at` integer NOT NULL,
	`cpu_percent` real,
	`memory_bytes` integer,
	`disk_free_bytes` integer,
	`db_bytes` integer,
	`active_runs` integer DEFAULT 0 NOT NULL,
	`queued_jobs` integer DEFAULT 0 NOT NULL,
	`connected_clients` integer DEFAULT 0 NOT NULL,
	`data` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `performance_snapshots_time_idx` ON `performance_snapshots` (`captured_at`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`run_id` text(26) NOT NULL,
	`session_id` text(26) NOT NULL,
	`agent_id` text(26) NOT NULL,
	`provider_id` text(26),
	`model_label` text(200) NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`cost_source` text DEFAULT 'unknown' NOT NULL,
	`origin_kind` text DEFAULT 'user' NOT NULL,
	`origin_id` text(26),
	`recorded_at` integer NOT NULL,
	CONSTRAINT "usage_records_cost_source_check" CHECK("usage_records"."cost_source" in ('provider', 'estimated', 'unknown')),
	CONSTRAINT "usage_records_origin_kind_check" CHECK("usage_records"."origin_kind" in ('user', 'task', 'schedule', 'workflow', 'room', 'api'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_run_model_uq` ON `usage_records` (`run_id`,`model_label`);--> statement-breakpoint
CREATE INDEX `usage_records_workspace_time_idx` ON `usage_records` (`workspace`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `usage_records_session_idx` ON `usage_records` (`session_id`);--> statement-breakpoint
CREATE INDEX `usage_records_agent_time_idx` ON `usage_records` (`workspace`,`agent_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `usage_records_origin_idx` ON `usage_records` (`origin_kind`,`origin_id`);--> statement-breakpoint
CREATE TABLE `plugin_bindings` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`plugin_id` text(26) NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`secret_refs` text DEFAULT '{}' NOT NULL,
	`exposed_to` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'stopped' NOT NULL,
	`last_started_at` integer,
	`last_error` text,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plugin_bindings_status_check" CHECK("plugin_bindings"."status" in ('stopped', 'starting', 'running', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_bindings_workspace_plugin_uq` ON `plugin_bindings` (`workspace`,`plugin_id`);--> statement-breakpoint
CREATE TABLE `plugin_tools` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`plugin_id` text(26) NOT NULL,
	`key` text(120) NOT NULL,
	`name` text(120) NOT NULL,
	`description` text,
	`kind` text DEFAULT 'tool' NOT NULL,
	`input_schema` text,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "plugin_tools_kind_check" CHECK("plugin_tools"."kind" in ('tool', 'skill', 'prompt', 'resource'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_tools_plugin_key_uq` ON `plugin_tools` (`plugin_id`,`key`);--> statement-breakpoint
CREATE INDEX `plugin_tools_kind_idx` ON `plugin_tools` (`kind`);--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`slug` text(64) NOT NULL,
	`name` text(120) NOT NULL,
	`description` text,
	`icon` text(64),
	`kind` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_ref` text,
	`version` text(64),
	`install_state` text DEFAULT 'not_installed' NOT NULL,
	`install_job_id` text(26),
	`manifest` text NOT NULL,
	`last_error` text,
	`archived_at` integer,
	CONSTRAINT "plugins_kind_check" CHECK("plugins"."kind" in ('mcp_server', 'docker', 'skill_pack')),
	CONSTRAINT "plugins_source_check" CHECK("plugins"."source" in ('registry', 'manual', 'git')),
	CONSTRAINT "plugins_install_state_check" CHECK("plugins"."install_state" in ('not_installed', 'installing', 'installed', 'updating', 'broken', 'removed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugins_slug_uq` ON `plugins` (`slug`);