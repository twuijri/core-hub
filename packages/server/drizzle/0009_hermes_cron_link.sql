ALTER TABLE `schedules` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `last_delivery_error` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `external_source` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `external_id` text(64);--> statement-breakpoint
ALTER TABLE `schedules` ADD `external_state` text(16);--> statement-breakpoint
ALTER TABLE `schedules` ADD `external_synced_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_external_uq` ON `schedules` (`workspace`,`external_source`,`external_id`);