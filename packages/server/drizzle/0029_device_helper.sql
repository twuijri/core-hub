-- A computer says what its local helper offers agents, and a person narrows the profiles that may ask
-- a device (docs/changes/2026-09-27-twuijri-device-programs.md, DECISIONS §89). NULL: nothing reported;
-- every profile of the person.
ALTER TABLE `devices` ADD `profiles` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `helper` text;