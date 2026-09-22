-- The Tasks module lands: two new tables, new columns on `projects` and `tasks`, and the
-- contract's own status vocabulary. SQLite cannot add a CHECK, so both tables are rebuilt.
-- The old statuses are mapped rather than dropped: `backlog` becomes `triage`,
-- `in_progress` becomes `running`, `cancelled` and `completed` become `archived`.
CREATE TABLE `subtasks` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`task_id` text(26) NOT NULL,
	`index` integer DEFAULT 0 NOT NULL,
	`title` text(300) NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`note` text,
	`blocked_reason` text,
	`completed_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "subtasks_status_check" CHECK("subtasks"."status" in ('todo', 'in_progress', 'review', 'done', 'blocked', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `subtasks_task_idx` ON `subtasks` (`task_id`,`index`);--> statement-breakpoint
CREATE TABLE `task_comments` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`task_id` text(26) NOT NULL,
	`author_kind` text DEFAULT 'user' NOT NULL,
	`author_id` text(26),
	`author_name` text(120),
	`body` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "task_comments_author_kind_check" CHECK("task_comments"."author_kind" in ('user', 'agent', 'system', 'schedule', 'workflow'))
);
--> statement-breakpoint
CREATE INDEX `task_comments_task_idx` ON `task_comments` (`task_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(120) NOT NULL,
	`key` text(10) NOT NULL,
	`description` text,
	`color` text(16),
	`repo_url` text,
	`local_path` text,
	`default_branch` text(120) DEFAULT 'main' NOT NULL,
	`default_agent_id` text(26),
	`report_room_id` text(26),
	`auto_dispatch` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`task_counter` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	CONSTRAINT "projects_status_check" CHECK("__new_projects"."status" in ('active', 'paused', 'archived'))
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "owner_id", "created_at", "updated_at", "workspace", "name", "key", "description", "color", "repo_url", "local_path", "default_branch", "default_agent_id", "report_room_id", "auto_dispatch", "status", "settings", "task_counter", "archived_at") SELECT "id", "owner_id", "created_at", "updated_at", "workspace", "name", "key", "description", "color", "repo_url", "local_path", "default_branch", "default_agent_id", NULL, 0, CASE "status" WHEN 'completed' THEN 'archived' ELSE "status" END, "settings", "task_counter", "archived_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_workspace_key_uq` ON `projects` (`workspace`,`key`);--> statement-breakpoint
CREATE INDEX `projects_workspace_idx` ON `projects` (`workspace`,`archived_at`);--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`project_id` text(26) NOT NULL,
	`number` integer NOT NULL,
	`title` text(300) NOT NULL,
	`description` text,
	`status` text DEFAULT 'triage' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignee_kind` text DEFAULT 'none' NOT NULL,
	`assignee_user_id` text(26),
	`assignee_agent_id` text(26),
	`parent_id` text(26),
	`sort_key` text(64) DEFAULT 'n' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`auto_start` integer DEFAULT false NOT NULL,
	`status_reason` text,
	`latest_summary` text,
	`attachment_ids` text DEFAULT '[]' NOT NULL,
	`due_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`blocked_reason` text,
	`session_id` text(26),
	`current_run_id` text(26),
	`room_id` text(26),
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_status_check" CHECK("__new_tasks"."status" in ('triage', 'todo', 'ready', 'scheduled', 'running', 'blocked', 'review', 'done', 'archived')),
	CONSTRAINT "tasks_priority_check" CHECK("__new_tasks"."priority" in ('urgent', 'high', 'normal', 'low')),
	CONSTRAINT "tasks_assignee_kind_check" CHECK("__new_tasks"."assignee_kind" in ('none', 'user', 'agent'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "owner_id", "created_at", "updated_at", "workspace", "project_id", "number", "title", "description", "status", "priority", "assignee_kind", "assignee_user_id", "assignee_agent_id", "parent_id", "sort_key", "labels", "auto_start", "status_reason", "latest_summary", "attachment_ids", "due_at", "started_at", "completed_at", "blocked_reason", "session_id", "current_run_id", "room_id", "attempt_count", "archived_at") SELECT "id", "owner_id", "created_at", "updated_at", "workspace", "project_id", "number", "title", "description", CASE "status" WHEN 'backlog' THEN 'triage' WHEN 'in_progress' THEN 'running' WHEN 'cancelled' THEN 'archived' ELSE "status" END, "priority", "assignee_kind", "assignee_user_id", "assignee_agent_id", "parent_id", "sort_key", "labels", 0, NULL, NULL, '[]', "due_at", "started_at", "completed_at", "blocked_reason", "session_id", "current_run_id", "room_id", "attempt_count", "archived_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_number_uq` ON `tasks` (`project_id`,`number`);--> statement-breakpoint
CREATE INDEX `tasks_workspace_status_idx` ON `tasks` (`workspace`,`archived_at`,`status`,`sort_key`);--> statement-breakpoint
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_agent_idx` ON `tasks` (`assignee_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_id`);