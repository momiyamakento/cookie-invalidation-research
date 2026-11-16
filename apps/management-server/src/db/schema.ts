export const MANAGEMENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS user_service_mappings (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    local_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE RESTRICT,
    UNIQUE(service_id, local_user_id),
    UNIQUE(principal_id, service_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_mappings_principal
    ON user_service_mappings(principal_id);

  CREATE TABLE IF NOT EXISTS detection_events (
    event_id TEXT PRIMARY KEY,
    source_service_id TEXT NOT NULL,
    source_local_user_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    decoy_id TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    completed_at TEXT,
    total_duration_ms INTEGER CHECK (
      total_duration_ms IS NULL OR total_duration_ms >= 0
    ),
    status TEXT NOT NULL CHECK (
      status IN ('RESOLVED', 'PROCESSING', 'SUCCESS', 'PARTIAL_FAILURE', 'FAILED')
    ),
    FOREIGN KEY (source_service_id) REFERENCES services(id) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_detection_events_principal
    ON detection_events(principal_id);

  CREATE TABLE IF NOT EXISTS invalidation_jobs (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    target_service_id TEXT NOT NULL,
    target_local_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
    http_status INTEGER,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    revoked_count INTEGER CHECK (revoked_count IS NULL OR revoked_count >= 0),
    error_message TEXT,
    FOREIGN KEY (event_id) REFERENCES detection_events(event_id) ON DELETE CASCADE,
    FOREIGN KEY (target_service_id) REFERENCES services(id) ON DELETE RESTRICT,
    UNIQUE(event_id, target_service_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_invalidation_jobs_event
    ON invalidation_jobs(event_id, target_service_id);

  CREATE TABLE IF NOT EXISTS security_audit_events (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (
      'MAPPING_REGISTER', 'MAPPING_RESOLVE', 'MAPPING_READ',
      'DETECTION_CREATE', 'DETECTION_READ'
    )),
    authenticated_service_id TEXT,
    claimed_service_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('ALLOWED', 'DENIED')),
    http_status INTEGER NOT NULL CHECK (http_status >= 100 AND http_status <= 599)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_security_audit_time
    ON security_audit_events(occurred_at);

  CREATE INDEX IF NOT EXISTS idx_security_audit_outcome
    ON security_audit_events(outcome, action);
`;
