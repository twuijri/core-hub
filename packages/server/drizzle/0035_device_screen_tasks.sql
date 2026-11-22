-- ADR 0033 (DECISIONS §156, §157): a computer linked through the Core Hub plugin of DeepSeek Harness
-- (`devices.platform` gains `dsh`), the screen task it may serve (`device_requests.capability` gains
-- `screen_task`), and the usage of the gateway's external entrance (`usage_records.origin_kind` gains
-- `external`). SQLite cannot alter a CHECK, so each table is copied as it is: every row keeps every
-- column; nothing is backfilled.
--
-- The order matters: migrations run inside one transaction, where `PRAGMA foreign_keys=OFF` does
-- nothing, so dropping `devices` would delete every request that points at it (ON DELETE CASCADE).
-- The new requests table therefore points at `__new_devices`; the old requests table is dropped
-- before the old devices table; renaming `__new_devices` to `devices` then rewrites the new
-- requests table's reference to `devices` (SQLite >= 3.26 does so whenever a table is renamed).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_devices` (
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
	`push_session_id` text(26),
	`push_blocker` text,
	`seen_session_id` text(26),
	`renamed_at` integer,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`profiles` text,
	`helper` text,
	`status` text DEFAULT 'paired' NOT NULL,
	`app_token_id` text(26),
	`paired_at` integer NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	CONSTRAINT "devices_platform_check" CHECK("__new_devices"."platform" in ('android', 'ios', 'web', 'macos', 'windows', 'linux', 'dsh')),
	CONSTRAINT "devices_kind_check" CHECK("__new_devices"."kind" in ('phone', 'tablet', 'computer', 'browser')),
	CONSTRAINT "devices_connection_check" CHECK("__new_devices"."connection" in ('lan', 'relay')),
	CONSTRAINT "devices_push_provider_check" CHECK("__new_devices"."push_provider" in ('none', 'fcm', 'apns', 'webpush')),
	CONSTRAINT "devices_status_check" CHECK("__new_devices"."status" in ('paired', 'revoked'))
);--> statement-breakpoint
INSERT INTO `__new_devices`("id", "owner_id", "created_at", "updated_at", "device_key", "name", "platform", "kind", "brand", "model", "os_version", "app_version", "connection", "push_provider", "push_token", "push_locale", "push_registered_at", "push_session_id", "push_blocker", "seen_session_id", "renamed_at", "capabilities", "profiles", "helper", "status", "app_token_id", "paired_at", "last_seen_at", "revoked_at") SELECT "id", "owner_id", "created_at", "updated_at", "device_key", "name", "platform", "kind", "brand", "model", "os_version", "app_version", "connection", "push_provider", "push_token", "push_locale", "push_registered_at", "push_session_id", "push_blocker", "seen_session_id", "renamed_at", "capabilities", "profiles", "helper", "status", "app_token_id", "paired_at", "last_seen_at", "revoked_at" FROM `devices`;--> statement-breakpoint
CREATE TABLE `__new_device_requests` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`device_id` text(26) NOT NULL,
	`capability` text NOT NULL,
	`purpose` text,
	`params` text DEFAULT '{}' NOT NULL,
	`session_id` text(26),
	`run_id` text(26),
	`job_id` text(26) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`result` text,
	`error` text,
	`answered_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `__new_devices`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_requests_capability_check" CHECK("__new_device_requests"."capability" in ('location', 'camera', 'microphone', 'notifications', 'clipboard', 'screen', 'files', 'apps', 'calendar', 'reminders', 'health', 'screen_task')),
	CONSTRAINT "device_requests_status_check" CHECK("__new_device_requests"."status" in ('pending', 'fulfilled', 'denied', 'failed', 'expired', 'cancelled'))
);--> statement-breakpoint
INSERT INTO `__new_device_requests`("id", "owner_id", "created_at", "updated_at", "workspace", "device_id", "capability", "purpose", "params", "session_id", "run_id", "job_id", "status", "expires_at", "result", "error", "answered_at") SELECT "id", "owner_id", "created_at", "updated_at", "workspace", "device_id", "capability", "purpose", "params", "session_id", "run_id", "job_id", "status", "expires_at", "result", "error", "answered_at" FROM `device_requests`;--> statement-breakpoint
DROP TABLE `device_requests`;--> statement-breakpoint
DROP TABLE `devices`;--> statement-breakpoint
ALTER TABLE `__new_devices` RENAME TO `devices`;--> statement-breakpoint
ALTER TABLE `__new_device_requests` RENAME TO `device_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `devices_owner_idx` ON `devices` (`owner_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_owner_key_uq` ON `devices` (`owner_id`,`device_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_app_token_uq` ON `devices` (`app_token_id`);--> statement-breakpoint
CREATE INDEX `device_requests_device_status_idx` ON `device_requests` (`device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `device_requests_workspace_owner_idx` ON `device_requests` (`workspace`,`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_usage_records` (
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
	CONSTRAINT "usage_records_cost_source_check" CHECK("__new_usage_records"."cost_source" in ('provider', 'estimated', 'unknown')),
	CONSTRAINT "usage_records_origin_kind_check" CHECK("__new_usage_records"."origin_kind" in ('user', 'task', 'schedule', 'workflow', 'room', 'api', 'external'))
);--> statement-breakpoint
INSERT INTO `__new_usage_records`("id", "owner_id", "created_at", "updated_at", "workspace", "run_id", "session_id", "agent_id", "provider_id", "model_label", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "cost_micro_usd", "cost_source", "origin_kind", "origin_id", "recorded_at") SELECT "id", "owner_id", "created_at", "updated_at", "workspace", "run_id", "session_id", "agent_id", "provider_id", "model_label", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "cost_micro_usd", "cost_source", "origin_kind", "origin_id", "recorded_at" FROM `usage_records`;--> statement-breakpoint
DROP TABLE `usage_records`;--> statement-breakpoint
ALTER TABLE `__new_usage_records` RENAME TO `usage_records`;--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_run_model_uq` ON `usage_records` (`run_id`,`model_label`);--> statement-breakpoint
CREATE INDEX `usage_records_workspace_time_idx` ON `usage_records` (`workspace`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `usage_records_session_idx` ON `usage_records` (`session_id`);--> statement-breakpoint
CREATE INDEX `usage_records_agent_time_idx` ON `usage_records` (`workspace`,`agent_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `usage_records_origin_idx` ON `usage_records` (`origin_kind`,`origin_id`);
