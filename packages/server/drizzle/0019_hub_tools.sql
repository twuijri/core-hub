CREATE TABLE `hub_tool_calls` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`tool` text(80) NOT NULL,
	`ok` integer NOT NULL,
	`error_code` text(80),
	`user_id` text(26),
	`session_id` text(26),
	`run_id` text(26),
	`duration_ms` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hub_tool_calls_workspace_idx` ON `hub_tool_calls` (`workspace`,`created_at`);--> statement-breakpoint
CREATE TABLE `hub_tool_settings` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`groups` text DEFAULT '{}' NOT NULL,
	`key_hash` text(64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hub_tool_settings_workspace_uq` ON `hub_tool_settings` (`workspace`);--> statement-breakpoint
CREATE UNIQUE INDEX `hub_tool_settings_key_uq` ON `hub_tool_settings` (`key_hash`);