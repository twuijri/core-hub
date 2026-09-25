-- Usage analytics (contract decision §47): skill use is recorded from now on — one row per skill an
-- agent loaded in a run — and `audit_counters` keeps the moment this install started counting, which
-- the Skills usage screen shows ("counting started on"): past use was never recorded and is not rebuilt.
-- `runs_workspace_time_idx` lets the Usage report count a period's runs and conversations by day.
CREATE TABLE `audit_counters` (
	`name` text(64) PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill_uses` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`skill` text(200) NOT NULL,
	`agent_id` text(26) NOT NULL,
	`session_id` text(26) NOT NULL,
	`run_id` text(26) NOT NULL,
	`used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_uses_run_skill_uq` ON `skill_uses` (`run_id`,`skill`);--> statement-breakpoint
CREATE INDEX `skill_uses_workspace_time_idx` ON `skill_uses` (`workspace`,`used_at`);--> statement-breakpoint
CREATE INDEX `skill_uses_agent_time_idx` ON `skill_uses` (`workspace`,`agent_id`,`used_at`);--> statement-breakpoint
CREATE INDEX `runs_workspace_time_idx` ON `runs` (`workspace`,`created_at`);--> statement-breakpoint
INSERT INTO `audit_counters` (`name`, `started_at`) VALUES ('skill_uses', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
