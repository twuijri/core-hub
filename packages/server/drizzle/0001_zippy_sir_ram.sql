CREATE TABLE `ensembles` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(80) NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`members` text DEFAULT '[]' NOT NULL,
	`aggregator` text NOT NULL,
	`max_tokens` integer,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ensembles_workspace_name_uq` ON `ensembles` (`workspace`,`name`);--> statement-breakpoint
-- The `providers`, `models` and `model_defaults` tables are recreated rather than
-- altered. They were declared in 0000 and never written to: the `models` module had no
-- routes and no other module inserts into them, so there is no row anywhere to migrate.
-- Recreating them keeps this file honest — a column-copy would name columns the old
-- tables never had.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE IF EXISTS `model_defaults`;--> statement-breakpoint
DROP TABLE IF EXISTS `models`;--> statement-breakpoint
DROP TABLE IF EXISTS `providers`;--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`slug` text(64) NOT NULL,
	`label` text(80) NOT NULL,
	`kind` text DEFAULT 'llm' NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`base_url` text,
	`api_mode` text DEFAULT 'native' NOT NULL,
	`auth_kind` text DEFAULT 'api_key' NOT NULL,
	`api_key_secret_id` text(26),
	`family` text(64) NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`visibility_mode` text DEFAULT 'all' NOT NULL,
	`visible_models` text DEFAULT '[]' NOT NULL,
	`catalogue_status` text DEFAULT 'loading' NOT NULL,
	`catalogue_refreshed_at` integer,
	`catalogue_error` text,
	`status` text DEFAULT 'unconfigured' NOT NULL,
	`last_checked_at` integer,
	`last_error` text,
	`archived_at` integer,
	FOREIGN KEY (`api_key_secret_id`) REFERENCES `secrets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "providers_kind_check" CHECK("providers"."kind" in ('llm', 'stt', 'tts')),
	CONSTRAINT "providers_api_mode_check" CHECK("providers"."api_mode" in ('native', 'chat_completions', 'responses')),
	CONSTRAINT "providers_auth_kind_check" CHECK("providers"."auth_kind" in ('api_key', 'oauth', 'none')),
	CONSTRAINT "providers_catalogue_status_check" CHECK("providers"."catalogue_status" in ('ready', 'loading', 'error', 'unsupported')),
	CONSTRAINT "providers_status_check" CHECK("providers"."status" in ('unconfigured', 'ok', 'error')),
	CONSTRAINT "providers_visibility_mode_check" CHECK("providers"."visibility_mode" in ('all', 'include'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_workspace_slug_uq` ON `providers` (`workspace`,`slug`);--> statement-breakpoint
CREATE INDEX `providers_workspace_kind_idx` ON `providers` (`workspace`,`kind`);--> statement-breakpoint
CREATE INDEX `providers_workspace_family_idx` ON `providers` (`workspace`,`family`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`provider_id` text(26) NOT NULL,
	`model_key` text(200) NOT NULL,
	`label` text(200) NOT NULL,
	`alias` text(200),
	`kind` text DEFAULT 'chat' NOT NULL,
	`context_window` integer,
	`max_output_tokens` integer,
	`pricing` text DEFAULT '{}' NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	`preview` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'catalogue' NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "models_kind_check" CHECK("models"."kind" in ('chat', 'embedding', 'stt', 'tts')),
	CONSTRAINT "models_source_check" CHECK("models"."source" in ('catalogue', 'discovered', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_key_uq` ON `models` (`provider_id`,`model_key`);--> statement-breakpoint
CREATE INDEX `models_workspace_kind_idx` ON `models` (`workspace`,`kind`,`enabled`);--> statement-breakpoint
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
	CONSTRAINT "model_defaults_role_check" CHECK("model_defaults"."role" in ('chat', 'coding', 'title', 'summary', 'embedding'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_defaults_workspace_role_uq` ON `model_defaults` (`workspace`,`role`);--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `speech_settings` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`stt_provider_id` text(26),
	`tts_provider_id` text(26),
	FOREIGN KEY (`stt_provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tts_provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speech_settings_workspace_uq` ON `speech_settings` (`workspace`);
