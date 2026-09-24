-- Hand-written: a data migration, not a schema change (`drizzle-kit generate` finds nothing to
-- do — no column moved).
--
-- Providers, their keys and their models belong to the hub, not to a profile (contract
-- decision §34, ADR 0010: add a provider once, every agent and every profile inherits it).
-- They are stored under the default profile — the one profile that always exists and can never
-- be renamed or archived — and every profile reads them from there. Until this build each
-- profile had its own rows, so a profile made later had no provider, no model, and Hermes
-- refused its turns.
--
-- What this does, and the rule for every choice it makes:
--
-- 1. Every live provider of a live profile is merged into the default profile. Nothing is
--    deleted: rows keep their ids, so every session, agent pin, default and usage record
--    that points at one still points at it.
-- 2. The same provider (same slug) in more than one profile: ONE row is kept — the default
--    profile's, else the oldest profile's (`workspaces.created_at`, then id). The others are
--    archived where they are, with their key, and an audit row `provider.merged` names both
--    profiles. Their models the kept row lacks are moved onto it; the defaults and speech
--    choices that pointed at them are pointed at the kept row.
-- 3. The key of a credential family: the one stored by the highest profile in the same order
--    that HAS a live key — so a keyless provider in the default profile takes the key another
--    profile typed, rather than losing it. A key that is not chosen stays in its profile.
-- 4. Rows and keys in an archived profile are left exactly where they are.
-- 5. A removed (archived) row or a wiped key in the default profile that has the same name
--    as one moving in is renamed `<name>~<id>`, not deleted.
--
-- Ids are ULID-shaped, made here as in 0010; `owner_id` / `actor_id` is the hub owner.
CREATE TEMP TABLE `_hub` AS
  SELECT `id`, `slug` FROM `workspaces` WHERE `is_default` = 1 AND `archived_at` IS NULL LIMIT 1;
--> statement-breakpoint
CREATE TEMP TABLE `_live` AS
  SELECT
    `p`.`id` AS `id`,
    `p`.`slug` AS `slug`,
    `p`.`family` AS `family`,
    `p`.`workspace` AS `workspace`,
    `p`.`api_key_secret_id` AS `secret`,
    CASE WHEN `p`.`workspace` = (SELECT `id` FROM `_hub`) THEN 0 ELSE 1 END AS `not_hub`,
    `w`.`created_at` AS `w_created`,
    `w`.`id` AS `w_id`,
    `w`.`slug` AS `w_slug`
  FROM `providers` `p`
  JOIN `workspaces` `w` ON `w`.`id` = `p`.`workspace`
  WHERE `p`.`archived_at` IS NULL
    AND `w`.`archived_at` IS NULL
    AND EXISTS (SELECT 1 FROM `_hub`);
--> statement-breakpoint
CREATE TEMP TABLE `_winner` AS
  SELECT DISTINCT
    `l`.`slug` AS `slug`,
    (
      SELECT `l2`.`id` FROM `_live` `l2`
      WHERE `l2`.`slug` = `l`.`slug`
      ORDER BY `l2`.`not_hub`, `l2`.`w_created`, `l2`.`w_id`
      LIMIT 1
    ) AS `id`
  FROM `_live` `l`;
--> statement-breakpoint
CREATE TEMP TABLE `_loser` AS
  SELECT `l`.`id` AS `id`, `l`.`slug` AS `slug`, `l`.`w_slug` AS `w_slug`, `w`.`id` AS `winner`,
    (SELECT `k`.`w_slug` FROM `_live` `k` WHERE `k`.`id` = `w`.`id`) AS `winner_slug`
  FROM `_live` `l`
  JOIN `_winner` `w` ON `w`.`slug` = `l`.`slug`
  WHERE `l`.`id` != `w`.`id`;
--> statement-breakpoint
CREATE TEMP TABLE `_family_key` AS
  SELECT `f`.`family` AS `family`,
    (
      SELECT `s`.`id` FROM `_live` `l`
      JOIN `secrets` `s` ON `s`.`id` = `l`.`secret`
      WHERE `l`.`family` = `f`.`family`
        AND `s`.`workspace` = `l`.`workspace`
        AND `s`.`name` = 'provider:' || `l`.`family`
        AND `s`.`ciphertext` IS NOT NULL
        AND `s`.`wiped_at` IS NULL
        AND `s`.`archived_at` IS NULL
      ORDER BY `l`.`not_hub`, `l`.`w_created`, `l`.`w_id`
      LIMIT 1
    ) AS `secret`
  FROM (SELECT DISTINCT `family` FROM `_live`) `f`;
--> statement-breakpoint
-- 2. The record of every choice, before anything moves.
WITH now(ms) AS (
  SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
),
hub_owner(id) AS (
  SELECT `id` FROM `users` WHERE `role` = 'owner' LIMIT 1
)
INSERT INTO `audit_events`
  (`id`, `owner_id`, `created_at`, `updated_at`, `workspace`, `actor_kind`, `actor_id`, `action`,
   `entity_kind`, `entity_id`, `summary`, `data`)
SELECT
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 35184372088832) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 1099511627776) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 34359738368) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 1073741824) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 33554432) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 1048576) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 32768) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 1024) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 32) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', ((now.ms / 1) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1) ||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (abs(random()) % 32) + 1, 1),
  hub_owner.id,
  now.ms,
  now.ms,
  NULL,
  'system',
  hub_owner.id,
  'provider.merged',
  'provider',
  `_loser`.`id`,
  'provider ' || `_loser`.`slug` || ' of profile ' || `_loser`.`w_slug` || ' merged into the one of profile ' || `_loser`.`winner_slug`,
  json_object(
    'slug', `_loser`.`slug`,
    'archived_profile', `_loser`.`w_slug`,
    'kept_profile', `_loser`.`winner_slug`,
    'kept_provider_id', `_loser`.`winner`,
    'rule', 'default profile first, then the oldest profile'
  )
FROM `_loser`
CROSS JOIN hub_owner
CROSS JOIN now;
--> statement-breakpoint
-- A model the kept row does not have moves onto it (one per name when several profiles had it).
UPDATE `models`
SET
  `provider_id` = (SELECT `winner` FROM `_loser` WHERE `_loser`.`id` = `models`.`provider_id`),
  `workspace` = (SELECT `id` FROM `_hub`)
WHERE `provider_id` IN (SELECT `id` FROM `_loser`)
  AND NOT EXISTS (
    SELECT 1 FROM `models` `kept`
    WHERE `kept`.`provider_id` = (SELECT `winner` FROM `_loser` WHERE `_loser`.`id` = `models`.`provider_id`)
      AND `kept`.`model_key` = `models`.`model_key`
  )
  AND `id` = (
    SELECT min(`m3`.`id`) FROM `models` `m3`
    JOIN `_loser` `l3` ON `l3`.`id` = `m3`.`provider_id`
    WHERE `l3`.`winner` = (SELECT `winner` FROM `_loser` WHERE `_loser`.`id` = `models`.`provider_id`)
      AND `m3`.`model_key` = `models`.`model_key`
  );
--> statement-breakpoint
-- A default that named a model of an archived duplicate names the kept row's model of that name.
UPDATE `model_defaults`
SET `model_id` = (
  SELECT `kept`.`id` FROM `models` `old`
  JOIN `_loser` `l` ON `l`.`id` = `old`.`provider_id`
  JOIN `models` `kept` ON `kept`.`provider_id` = `l`.`winner` AND `kept`.`model_key` = `old`.`model_key`
  WHERE `old`.`id` = `model_defaults`.`model_id`
)
WHERE `model_id` IN (
  SELECT `old`.`id` FROM `models` `old`
  JOIN `_loser` `l` ON `l`.`id` = `old`.`provider_id`
  JOIN `models` `kept` ON `kept`.`provider_id` = `l`.`winner` AND `kept`.`model_key` = `old`.`model_key`
);
--> statement-breakpoint
UPDATE `speech_settings`
SET `stt_provider_id` = (SELECT `winner` FROM `_loser` WHERE `_loser`.`id` = `speech_settings`.`stt_provider_id`)
WHERE `stt_provider_id` IN (SELECT `id` FROM `_loser`);
--> statement-breakpoint
UPDATE `speech_settings`
SET `tts_provider_id` = (SELECT `winner` FROM `_loser` WHERE `_loser`.`id` = `speech_settings`.`tts_provider_id`)
WHERE `tts_provider_id` IN (SELECT `id` FROM `_loser`);
--> statement-breakpoint
UPDATE `providers`
SET
  `archived_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  `updated_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
  `enabled` = 0
WHERE `id` IN (SELECT `id` FROM `_loser`);
--> statement-breakpoint
-- 5. A removed row in the default profile steps aside for the live one moving in.
UPDATE `providers`
SET `slug` = substr(`slug`, 1, 37) || '~' || `id`
WHERE `workspace` = (SELECT `id` FROM `_hub`)
  AND `archived_at` IS NOT NULL
  AND `slug` IN (
    SELECT `w`.`slug` FROM `_winner` `w` JOIN `_live` `l` ON `l`.`id` = `w`.`id` WHERE `l`.`not_hub` = 1
  );
--> statement-breakpoint
UPDATE `secrets`
SET `name` = `name` || '~' || `id`
WHERE `workspace` = (SELECT `id` FROM `_hub`)
  AND `id` NOT IN (SELECT `secret` FROM `_family_key` WHERE `secret` IS NOT NULL)
  AND `name` IN (
    SELECT 'provider:' || `fk`.`family` FROM `_family_key` `fk`
    JOIN `secrets` `s` ON `s`.`id` = `fk`.`secret`
    WHERE `s`.`workspace` != (SELECT `id` FROM `_hub`)
  );
--> statement-breakpoint
-- 3. The chosen keys, the kept rows and their models move to the default profile.
UPDATE `secrets`
SET `workspace` = (SELECT `id` FROM `_hub`)
WHERE `id` IN (SELECT `secret` FROM `_family_key` WHERE `secret` IS NOT NULL)
  AND `workspace` != (SELECT `id` FROM `_hub`);
--> statement-breakpoint
UPDATE `providers`
SET `workspace` = (SELECT `id` FROM `_hub`)
WHERE `id` IN (SELECT `id` FROM `_winner`)
  AND `workspace` != (SELECT `id` FROM `_hub`);
--> statement-breakpoint
UPDATE `models`
SET `workspace` = (SELECT `id` FROM `_hub`)
WHERE `provider_id` IN (SELECT `id` FROM `_winner`);
--> statement-breakpoint
UPDATE `providers`
SET `api_key_secret_id` = (SELECT `secret` FROM `_family_key` WHERE `_family_key`.`family` = `providers`.`family`)
WHERE `id` IN (SELECT `id` FROM `_winner`);
--> statement-breakpoint
DROP TABLE `_family_key`;
--> statement-breakpoint
DROP TABLE `_loser`;
--> statement-breakpoint
DROP TABLE `_winner`;
--> statement-breakpoint
DROP TABLE `_live`;
--> statement-breakpoint
DROP TABLE `_hub`;
