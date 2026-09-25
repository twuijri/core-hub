-- The image model is a role like the chat model (contract decision §72, the Models → Images tab):
-- the role check gains `image`. SQLite cannot alter a CHECK, so the table is copied as it is —
-- every row keeps its id, role, model and chain; nothing is backfilled.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_model_defaults` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`role` text NOT NULL,
	`model_id` text(26) NOT NULL,
	`fallback_model_ids` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "model_defaults_role_check" CHECK("__new_model_defaults"."role" in ('chat', 'coding', 'title', 'summary', 'embedding', 'image'))
);
--> statement-breakpoint
INSERT INTO `__new_model_defaults`("id", "owner_id", "created_at", "updated_at", "workspace", "role", "model_id", "fallback_model_ids") SELECT "id", "owner_id", "created_at", "updated_at", "workspace", "role", "model_id", "fallback_model_ids" FROM `model_defaults`;--> statement-breakpoint
DROP TABLE `model_defaults`;--> statement-breakpoint
ALTER TABLE `__new_model_defaults` RENAME TO `model_defaults`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `model_defaults_workspace_role_uq` ON `model_defaults` (`workspace`,`role`);