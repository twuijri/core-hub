CREATE TABLE `channel_identities` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text(26) NOT NULL,
	`platform` text NOT NULL,
	`sender_id` text(320) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_identities_platform_check" CHECK("channel_identities"."platform" in ('telegram', 'whatsapp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_identities_account_uq` ON `channel_identities` (`platform`,`sender_id`);--> statement-breakpoint
CREATE INDEX `channel_identities_user_idx` ON `channel_identities` (`user_id`);