ALTER TABLE `tasks` ADD `external_source` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `external_id` text(64);--> statement-breakpoint
ALTER TABLE `tasks` ADD `external_synced_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_external_uq` ON `tasks` (`workspace`,`external_source`,`external_id`);