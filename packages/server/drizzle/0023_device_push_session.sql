-- A push registration belongs to the sign-in that made it (docs/changes/2026-09-26-twuijri-push-cleanup-mobile-logs.md):
-- `push_session_id` names that auth.app_tokens row; when it ends, the token is forgotten. Existing rows keep
-- NULL (a paired phone falls back to its pairing token).
ALTER TABLE `devices` ADD `push_session_id` text(26);