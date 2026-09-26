ALTER TABLE `tasks` ADD `definition_of_done` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `constraints` text DEFAULT '[]' NOT NULL;