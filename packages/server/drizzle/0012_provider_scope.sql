DROP INDEX `providers_workspace_slug_uq`;--> statement-breakpoint
ALTER TABLE `providers` ADD `shared` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `providers_workspace_shared_slug_uq` ON `providers` (`workspace`,`shared`,`slug`);