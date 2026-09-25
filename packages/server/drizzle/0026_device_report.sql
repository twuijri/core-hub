-- A device says what it is and why it has no push, and a person's name for it sticks
-- (docs/changes/2026-09-26-twuijri-device-cards.md). Existing rows keep NULL: nothing reported yet,
-- never renamed, and no sign-in counted as the device (a paired phone still counts through its pairing token).
ALTER TABLE `devices` ADD `push_blocker` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `seen_session_id` text(26);--> statement-breakpoint
ALTER TABLE `devices` ADD `renamed_at` integer;