CREATE TABLE IF NOT EXISTS prompt_logs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  model TEXT,
  system_prompt TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  client_ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompt_logs_created_at ON prompt_logs(created_at);

