-- Rooms (contract decision §57): what the contract's room, seat and room message need that the
-- founding schema did not carry, the agents' handoff chains, and seat presets. No room existed
-- before this (the module answered 501), so nothing is backfilled.
CREATE TABLE `room_handoff_chains` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`room_id` text(26) NOT NULL,
	`from_seat_id` text(26) NOT NULL,
	`to_seat_id` text(26) NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`stop_reason` text(32),
	`depth` integer DEFAULT 1 NOT NULL,
	`max_depth` integer,
	`continue_used` integer DEFAULT false NOT NULL,
	`error` text,
	`visited` text DEFAULT '[]' NOT NULL,
	`last_message_id` text(26),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "room_handoff_chains_status_check" CHECK("room_handoff_chains"."status" in ('active', 'stopped', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `room_handoff_chains_room_idx` ON `room_handoff_chains` (`room_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `seat_presets` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`owner_id` text(26) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace` text(26) NOT NULL,
	`name` text(80) NOT NULL,
	`agent_id` text(26) NOT NULL,
	`seat` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `seat_presets_workspace_idx` ON `seat_presets` (`workspace`,`name`);--> statement-breakpoint
ALTER TABLE `room_messages` ADD `status` text(16) DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_messages` ADD `author_name` text;--> statement-breakpoint
ALTER TABLE `room_messages` ADD `session_id` text(26);--> statement-breakpoint
ALTER TABLE `room_messages` ADD `mention_list` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_messages` ADD `handoff` text;--> statement-breakpoint
ALTER TABLE `room_messages` ADD `reasoning` text;--> statement-breakpoint
ALTER TABLE `room_messages` ADD `usage` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `working_dir` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `invite_code` text(12);--> statement-breakpoint
ALTER TABLE `rooms` ADD `can_mention_all` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `lead_seat_id` text(26);--> statement-breakpoint
ALTER TABLE `rooms` ADD `summary_every_turns` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `summary_model` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `summary_provider` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `handoff_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `handoff_max_depth` integer DEFAULT 3;--> statement-breakpoint
ALTER TABLE `rooms` ADD `total_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `memory_status` text(16) DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `memory_error` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `memory_turn_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `memory_upto_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `context_from_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_invite_code_uq` ON `rooms` (`invite_code`);--> statement-breakpoint
ALTER TABLE `seats` ADD `description` text;--> statement-breakpoint
ALTER TABLE `seats` ADD `model` text;--> statement-breakpoint
ALTER TABLE `seats` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `seats` ADD `reasoning_effort` text(16);--> statement-breakpoint
ALTER TABLE `seats` ADD `avatar` text;--> statement-breakpoint
ALTER TABLE `seats` ADD `preset_id` text(26);--> statement-breakpoint
ALTER TABLE `seats` ADD `seen_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `room_members_user_idx` ON `room_members` (`user_id`);