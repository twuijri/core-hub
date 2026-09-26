CREATE TABLE `agent_presets` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`agent_id` text(26) NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`content` text NOT NULL,
	`last_activated_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_presets_name_uq` ON `agent_presets` (`workspace`,`agent_id`,`name`);--> statement-breakpoint
CREATE INDEX `agent_presets_agent_idx` ON `agent_presets` (`workspace`,`agent_id`);--> statement-breakpoint
CREATE TABLE `peer_events` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`peer_id` text(26) NOT NULL,
	`kind` text NOT NULL,
	`ok` integer NOT NULL,
	`detail` text(200),
	`actor_id` text(26),
	`created_at` integer NOT NULL,
	CONSTRAINT "peer_events_kind_check" CHECK("peer_events"."kind" in ('joined', 'requested', 'approved', 'approved_by_peer', 'updated', 'unlinked', 'unlinked_by_peer', 'list_in', 'list_out', 'ask_in', 'ask_out', 'refused'))
);
--> statement-breakpoint
CREATE INDEX `peer_events_peer_idx` ON `peer_events` (`peer_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `peer_identity` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text(32) NOT NULL,
	`key_id` text(32) NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `peer_invites` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`code_hash` text(64) NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peer_invites_code_hash_uq` ON `peer_invites` (`code_hash`);--> statement-breakpoint
CREATE TABLE `peer_nonces` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`peer_hub_id` text(26) NOT NULL,
	`nonce` text(64) NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peer_nonces_uq` ON `peer_nonces` (`peer_hub_id`,`nonce`);--> statement-breakpoint
CREATE INDEX `peer_nonces_expires_idx` ON `peer_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `peer_shares` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`agent_id` text(26) NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`description` text(280)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peer_shares_workspace_agent_uq` ON `peer_shares` (`workspace`,`agent_id`);--> statement-breakpoint
CREATE TABLE `peers` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`hub_id` text(26) NOT NULL,
	`name` text(80) NOT NULL,
	`hub_name` text(80) NOT NULL,
	`url` text(2048) NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text(64) NOT NULL,
	`version` text(40),
	`asks_per_hour` integer DEFAULT 30 NOT NULL,
	`last_seen_at` integer,
	`approved_at` integer,
	CONSTRAINT "peers_direction_check" CHECK("peers"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "peers_status_check" CHECK("peers"."status" in ('pending', 'waiting', 'linked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peers_hub_id_uq` ON `peers` (`hub_id`);