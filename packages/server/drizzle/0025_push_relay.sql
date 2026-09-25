-- The Core Hub push relay as this hub knows it (ADR 0024, DECISIONS §81): its registration (the
-- secret sealed like every other), the admin switch, private push, and what the last call said.
CREATE TABLE `push_relay` (
	`id` text(26) PRIMARY KEY NOT NULL,
	`url` text(500),
	`hub_id` text(64),
	`ciphertext` text,
	`nonce` text(32),
	`key_id` text(32),
	`enabled` integer DEFAULT true NOT NULL,
	`private_push` integer DEFAULT false NOT NULL,
	`state` text,
	`last_error` text,
	`checked_at` integer,
	`synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "push_relay_state_check" CHECK("push_relay"."state" in ('ready', 'not_registered', 'unreachable', 'blocked', 'rate_limited'))
);
