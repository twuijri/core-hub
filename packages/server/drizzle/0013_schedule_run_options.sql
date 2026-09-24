-- Two options per schedule (owner, 2026-09-24): "run if missed" and "if the previous run is still going".
-- "Run if missed" is the existing `misfire_policy` (`skip` = off, `run_once` = on); every schedule starts
-- off, as the owner chose. The overlap choice is a new column, `overlap`, defaulting to `wait`: the old
-- `overlap_policy` column's CHECK has no `replace`, and SQLite changes a CHECK only by rebuilding the
-- table — which, inside the migrator's transaction, would cascade-delete every schedule's history.
-- `schedule_runs.waiting` marks the one time a schedule holds back until its previous run ends.
ALTER TABLE `schedule_runs` ADD `waiting` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `overlap` text DEFAULT 'wait' NOT NULL;--> statement-breakpoint
UPDATE `schedules` SET `misfire_policy` = 'skip';
