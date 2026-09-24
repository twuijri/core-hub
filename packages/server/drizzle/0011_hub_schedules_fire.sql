-- The hub fires its own schedules, and a workflow can pause at an approval.
-- `approvals` is rebuilt: `run_id` becomes optional (a workflow step's gate has no session run),
-- it gains `workflow_run_id` and `node_id`, and the kind `workflow_step`. SQLite cannot relax a
-- NOT NULL or change a CHECK in place. The migrator runs inside a transaction, where
-- `PRAGMA foreign_keys=OFF` does nothing, so dropping the old table would null every
-- `tool_calls.approval_id` (ON DELETE SET NULL): those links are kept aside and put back.
CREATE TABLE `__keep_tool_call_approvals` AS SELECT `id`, `approval_id` FROM `tool_calls` WHERE `approval_id` IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_approvals` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`run_id` text(26),
	`workflow_run_id` text(26),
	`node_id` text(64),
	`tool_call_id` text(26),
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`title` text(200) NOT NULL,
	`description` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`response` text,
	`responded_by_user_id` text(26),
	`remember` integer DEFAULT false NOT NULL,
	`requested_at` integer NOT NULL,
	`responded_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`) REFERENCES `tool_calls`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "approvals_kind_check" CHECK("__new_approvals"."kind" in ('tool_call', 'plan', 'memory_write', 'skill_write', 'question', 'workflow_step')),
	CONSTRAINT "approvals_status_check" CHECK("__new_approvals"."status" in ('pending', 'approved', 'denied', 'answered', 'expired', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_approvals`("id", "owner_id", "created_at", "updated_at", "workspace", "run_id", "workflow_run_id", "node_id", "tool_call_id", "kind", "status", "title", "description", "payload", "response", "responded_by_user_id", "remember", "requested_at", "responded_at", "expires_at") SELECT "id", "owner_id", "created_at", "updated_at", "workspace", "run_id", NULL, NULL, "tool_call_id", "kind", "status", "title", "description", "payload", "response", "responded_by_user_id", "remember", "requested_at", "responded_at", "expires_at" FROM `approvals`;--> statement-breakpoint
DROP TABLE `approvals`;--> statement-breakpoint
ALTER TABLE `__new_approvals` RENAME TO `approvals`;--> statement-breakpoint
UPDATE `tool_calls` SET `approval_id` = (SELECT `k`.`approval_id` FROM `__keep_tool_call_approvals` `k` WHERE `k`.`id` = `tool_calls`.`id`) WHERE `id` IN (SELECT `id` FROM `__keep_tool_call_approvals`);--> statement-breakpoint
DROP TABLE `__keep_tool_call_approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `approvals_workspace_pending_idx` ON `approvals` (`workspace`,`status`,`requested_at`);--> statement-breakpoint
CREATE INDEX `approvals_run_idx` ON `approvals` (`run_id`);--> statement-breakpoint
CREATE INDEX `approvals_workflow_run_idx` ON `approvals` (`workflow_run_id`);--> statement-breakpoint
ALTER TABLE `schedule_runs` ADD `session_id` text(26);--> statement-breakpoint
ALTER TABLE `schedule_runs` ADD `trigger` text DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `resume_state` text;