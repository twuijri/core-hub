-- Hand-written: a data migration, not a schema change (`drizzle-kit generate` finds
-- nothing to do — no column moved).
--
-- Providers are no longer seeded from the bundled catalogue (contract decision §26): a
-- row in `providers` exists because somebody added it, and the Models screen lists what
-- the person configured. A hub that ran an earlier build has one row per catalogue entry
-- sitting there unconfigured; those rows would show up on the new screen as providers
-- nobody added.
--
-- Deleted here: built-in rows with no stored key and no discovered model — precisely the
-- untouched leftovers of the old seeding. Anything a person actually used has a key or a
-- model list and is kept, exactly as it was. `speech_settings` references providers with
-- ON DELETE SET NULL, so a choice pointing at a deleted row becomes "not chosen", which
-- is what `models.getSpeech` already reports with a reason.
DELETE FROM `providers`
WHERE `builtin` = 1
  AND `api_key_secret_id` IS NULL
  AND `id` NOT IN (SELECT `provider_id` FROM `models`);
