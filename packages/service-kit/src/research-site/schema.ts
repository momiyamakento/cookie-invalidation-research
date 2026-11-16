export const RESEARCH_SITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (
      (status = 'ACTIVE' AND revoked_at IS NULL)
      OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_sessions_user_status
    ON sessions(user_id, status);

  CREATE TABLE IF NOT EXISTS decoy_sessions (
    id TEXT PRIMARY KEY,
    decoy_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('ISSUED', 'USED')),
    issued_at TEXT NOT NULL,
    used_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (
      (status = 'ISSUED' AND used_at IS NULL)
      OR (status = 'USED' AND used_at IS NOT NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_decoy_sessions_user_status
    ON decoy_sessions(user_id, status);

  CREATE TABLE IF NOT EXISTS local_detection_events (
    event_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    decoy_id TEXT NOT NULL UNIQUE,
    detected_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (decoy_id) REFERENCES decoy_sessions(decoy_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS invalidation_requests (
    request_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason = 'DECOY_COOKIE_DETECTED'),
    detected_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    revoked_count INTEGER NOT NULL CHECK (revoked_count >= 0),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
  ) STRICT;
`;
