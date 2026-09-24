-- Hand-written: a data migration, not a schema change (`drizzle-kit generate` finds
-- nothing to do — no column moved).
--
-- A member's workspace list is now the whole answer (owner, 2026-09-24: «المفروض ما يضيفه له
-- بدون ما ادخل انا واضيفه له»). Until this build an EMPTY list meant "every workspace", so a
-- member with no `workspace_members` row silently entered every workspace — including every
-- one created later. From this build an empty list means none.
--
-- To keep today's access and nothing more, each member with no row is enrolled here,
-- explicitly, in every workspace that exists and is not archived at the moment this runs.
-- A workspace created after this migration is not added to anyone: an admin grants it.
-- Members who already had rows, owners and admins are untouched.
--
-- Ids are ULID-shaped (48-bit milliseconds + 16 random Crockford characters), made here
-- because a backfill has no application to make them; `owner_id` is the hub owner, as for
-- every row the hub writes on its own (src/db/columns.ts).
WITH now(ms) AS (
  SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
),
hub_owner(id) AS (
  SELECT `id` FROM `users` WHERE `role` = 'owner' LIMIT 1
),
unlisted(id) AS (
  SELECT `u`.`id` FROM `users` `u`
  WHERE `u`.`role` = 'member'
    AND NOT EXISTS (SELECT 1 FROM `workspace_members` `m` WHERE `m`.`user_id` = `u`.`id`)
)
INSERT INTO `workspace_members` (`id`, `owner_id`, `created_at`, `updated_at`, `workspace`, `user_id`)
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
  `w`.`id`,
  unlisted.id
FROM unlisted
CROSS JOIN `workspaces` `w`
CROSS JOIN hub_owner
CROSS JOIN now
WHERE `w`.`archived_at` IS NULL;
