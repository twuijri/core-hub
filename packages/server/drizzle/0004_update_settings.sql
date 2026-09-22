CREATE TABLE `update_settings` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`default_channel` text(32) DEFAULT 'stable' NOT NULL,
	`source_kind` text(32) DEFAULT 'manual' NOT NULL,
	`source_repo` text,
	`source_token` text,
	`auto_publish` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE `releases` ADD `artifact_attachment_id` text(26);--> statement-breakpoint
ALTER TABLE `releases` ADD `artifact_workspace` text(26);