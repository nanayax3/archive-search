-- Archive Search - migration 0002
--
-- Two problems this fixes:
--
-- 1. Re-ingesting a file created duplicate rows. `INSERT OR REPLACE` only
--    replaces when a UNIQUE constraint exists to collide with; there wasn't
--    one, so nothing was ever replaced.
--
-- 2. The same passage often lives in more than one file (e.g. a summary
--    written at the end of one conversation and pasted at the start of the
--    next). Search returned it once per copy. A content hash lets the search
--    collapse identical passages into a single result that names every file
--    it appears in.

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_unique
  ON archive_chunks(source_file, chunk_index);

ALTER TABLE archive_chunks ADD COLUMN content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_chunks_content_hash
  ON archive_chunks(content_hash);
