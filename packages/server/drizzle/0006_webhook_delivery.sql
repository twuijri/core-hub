ALTER TABLE `webhooks` ADD `signing_secret` text;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `profiles` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `include_content` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `allow_private_network` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `max_retries` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `delivered_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `last_error` text;