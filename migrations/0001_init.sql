-- Archive Search - Initial Schema
CREATE TABLE IF NOT EXISTS archive_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  total_chunks INTEGER DEFAULT 1,
  content TEXT NOT NULL,
  era TEXT,
  conversation_title TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_chunks_source ON archive_chunks(source_file);
CREATE INDEX idx_chunks_era ON archive_chunks(era);
