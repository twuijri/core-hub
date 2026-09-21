-- agents: the curated catalog (ADR 0006) and the contract's vocabulary.
--
-- Hand-written, because drizzle-kit's generated table-recreation copies every column of
-- the NEW table out of the OLD one and SQLite rejects that for columns the old table
-- never had (`no such column: "vendor"`). SQLite also cannot alter a CHECK constraint, so
-- the two tables whose enums changed are recreated the long way — copying only the
-- columns that exist in 0000 and letting the added ones take their defaults
-- (packages/server/src/db/README.md §Migrations, rule 3).
--
-- What changes:
--   agent_adapters.kind        'acp'|'hermes'|'process'  ->  the contract's AgentKind
--   agent_adapters.capabilities  object  ->  array (contract `AgentCapability[]`)
--   agents.adapter_kind        same as above
--   agents.source              'detected'|'manual'|'bundled'  ->  contract AgentInstall.source
--   agents.install_state       'broken'  ->  'failed'  (ADR 0006 names the states)
--   agents + vendor, licence, package_name, latest_version, auto_update, checked_at,
--           sections, selectable
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_adapters` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text(120) NOT NULL,
	`version` text(32) NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`last_probe_at` integer,
	`last_error` text,
	CONSTRAINT "agent_adapters_kind_check" CHECK("__new_agent_adapters"."kind" in ('hermes', 'acp', 'harness', 'builtin')),
	CONSTRAINT "agent_adapters_status_check" CHECK("__new_agent_adapters"."status" in ('available', 'unavailable'))
);
--> statement-breakpoint
INSERT INTO `__new_agent_adapters`("id", "owner_id", "created_at", "updated_at", "kind", "name", "version", "capabilities", "status", "last_probe_at", "last_error") SELECT "id", "owner_id", "created_at", "updated_at", CASE "kind" WHEN 'process' THEN 'harness' ELSE "kind" END, "name", "version", '[]', "status", "last_probe_at", "last_error" FROM `agent_adapters`;--> statement-breakpoint
DROP TABLE `agent_adapters`;--> statement-breakpoint
ALTER TABLE `__new_agent_adapters` RENAME TO `agent_adapters`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_adapters_kind_uq` ON `agent_adapters` (`kind`);--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`slug` text(64) NOT NULL,
	`name` text(120) NOT NULL,
	`vendor` text(120),
	`licence` text(64),
	`description` text,
	`icon` text(64),
	`adapter_id` text(26) NOT NULL,
	`adapter_kind` text NOT NULL,
	`source` text DEFAULT 'none' NOT NULL,
	`command` text DEFAULT '[]' NOT NULL,
	`executable_path` text,
	`package_name` text(200),
	`endpoint` text,
	`version` text(64),
	`latest_version` text(64),
	`auto_update` integer DEFAULT false NOT NULL,
	`checked_at` integer,
	`install_state` text DEFAULT 'not_installed' NOT NULL,
	`install_job_id` text(26),
	`detected_at` integer,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`sections` text DEFAULT '[]' NOT NULL,
	`limited` integer DEFAULT false NOT NULL,
	`selectable` integer DEFAULT true NOT NULL,
	`last_error` text,
	`archived_at` integer,
	FOREIGN KEY (`adapter_id`) REFERENCES `agent_adapters`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agents_adapter_kind_check" CHECK("__new_agents"."adapter_kind" in ('hermes', 'acp', 'harness', 'builtin')),
	CONSTRAINT "agents_source_check" CHECK("__new_agents"."source" in ('managed', 'user_cli', 'builtin', 'none')),
	CONSTRAINT "agents_install_state_check" CHECK("__new_agents"."install_state" in ('not_installed', 'installing', 'installed', 'updating', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "owner_id", "created_at", "updated_at", "slug", "name", "description", "icon", "adapter_id", "adapter_kind", "source", "command", "executable_path", "endpoint", "version", "install_state", "install_job_id", "detected_at", "capabilities", "limited", "last_error", "archived_at") SELECT "id", "owner_id", "created_at", "updated_at", "slug", "name", "description", "icon", "adapter_id", CASE "adapter_kind" WHEN 'process' THEN 'harness' ELSE "adapter_kind" END, CASE "source" WHEN 'bundled' THEN 'builtin' WHEN 'detected' THEN 'user_cli' WHEN 'manual' THEN 'user_cli' ELSE 'none' END, "command", "executable_path", "endpoint", "version", CASE "install_state" WHEN 'broken' THEN 'failed' ELSE "install_state" END, "install_job_id", "detected_at", '[]', "limited", "last_error", "archived_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_uq` ON `agents` (`slug`);--> statement-breakpoint
CREATE INDEX `agents_adapter_idx` ON `agents` (`adapter_id`);
