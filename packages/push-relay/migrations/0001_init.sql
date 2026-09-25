-- Core Hub push relay (ADR 0024). Nothing here is a secret, a device token or a message:
-- a hub's secret is derived from HUB_SECRET_KEY and the salt, a token is kept only as its
-- SHA-256, and payloads are never written anywhere.

-- One row per registered hub. `blocked` is the owner's switch (admin endpoint).
CREATE TABLE hubs (
  id TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  limit_minute INTEGER,
  limit_day INTEGER,
  last_seen_at INTEGER
);

-- Which hub may push to a device token: first come wins; see ADR 0024 §Binding.
-- token_hash = SHA-256 of "<platform>:<token>". device_key = SHA-256 of the app's proof key.
CREATE TABLE bindings (
  token_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  hub_id TEXT NOT NULL,
  device_key TEXT,
  proof_at INTEGER,
  bound_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE INDEX bindings_hub ON bindings (hub_id);

-- Rate-limit windows: `m:<hub>:<minute>`, `d:<hub>:<day>`, `b:<hub>:<minute>`,
-- `r:<ip hash>:<hour>`, `R:<day>`. Purged by the cron once expired.
CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX counters_expiry ON counters (expires_at);

-- Request nonces seen in the last few minutes: a replayed request is refused.
CREATE TABLE nonces (
  hub_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (hub_id, nonce)
);
CREATE INDEX nonces_expiry ON nonces (expires_at);
