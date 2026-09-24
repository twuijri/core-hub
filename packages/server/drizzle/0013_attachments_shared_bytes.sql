DROP INDEX `attachments_storage_key_uq`;--> statement-breakpoint
CREATE INDEX `attachments_workspace_storage_key_idx` ON `attachments` (`workspace`,`storage_key`);