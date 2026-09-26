CREATE TABLE `channel_conversation_hides` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`conversation_id` text(128) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_conversation_hides_uq` ON `channel_conversation_hides` (`workspace`,`owner_id`,`conversation_id`);