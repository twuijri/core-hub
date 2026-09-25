DROP TABLE `device_commands`;--> statement-breakpoint
CREATE TABLE `device_requests` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`device_id` text(26) NOT NULL,
	`capability` text NOT NULL,
	`purpose` text,
	`params` text DEFAULT '{}' NOT NULL,
	`session_id` text(26),
	`run_id` text(26),
	`job_id` text(26) NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`result` text,
	`error` text,
	`answered_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "device_requests_capability_check" CHECK("device_requests"."capability" in ('location', 'camera', 'microphone', 'notifications', 'clipboard', 'screen', 'files', 'apps', 'calendar', 'reminders', 'health')),
	CONSTRAINT "device_requests_status_check" CHECK("device_requests"."status" in ('pending', 'fulfilled', 'denied', 'failed', 'expired', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `device_requests_device_status_idx` ON `device_requests` (`device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `device_requests_workspace_owner_idx` ON `device_requests` (`workspace`,`owner_id`,`created_at`);