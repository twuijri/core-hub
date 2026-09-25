-- Session categories (contract decision §54): a profile's folders of its chats list, shared by
-- everyone who may enter it. `sessions.category_id` already existed; nothing pointed it anywhere.
CREATE TABLE `session_categories` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(60) NOT NULL,
	`name_key` text(60) NOT NULL,
	`color` text(7),
	`position` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_categories_workspace_name_uq` ON `session_categories` (`workspace`,`name_key`);--> statement-breakpoint
CREATE INDEX `session_categories_workspace_position_idx` ON `session_categories` (`workspace`,`position`);