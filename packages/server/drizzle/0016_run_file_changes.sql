-- The files each run changed in its working folder (contract decision §49): one row per file with
-- the diff recorded when the run ended, and the run's totals on `runs.changes`. Older runs keep
-- NULL and no rows: they recorded nothing, and no card is drawn under them.
CREATE TABLE `run_file_changes` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`run_id` text(26) NOT NULL,
	`seq` integer NOT NULL,
	`path` text NOT NULL,
	`old_path` text,
	`change` text NOT NULL,
	`additions` integer,
	`deletions` integer,
	`binary` integer DEFAULT false NOT NULL,
	`diff_state` text NOT NULL,
	`diff` text,
	`diff_truncated` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_file_changes_change_check" CHECK("run_file_changes"."change" in ('added', 'modified', 'deleted', 'renamed')),
	CONSTRAINT "run_file_changes_diff_state_check" CHECK("run_file_changes"."diff_state" in ('available', 'binary', 'too_large', 'unavailable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_file_changes_run_seq_uq` ON `run_file_changes` (`run_id`,`seq`);--> statement-breakpoint
ALTER TABLE `runs` ADD `changes` text;