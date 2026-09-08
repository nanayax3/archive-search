-- Archive Search - migration 0003
--
-- source_file is canonically forward-slash separated.
--
-- The archive was first ingested from Windows, where path.relative() produces
-- backslashes. Sweeping the same vault from Linux produces forward slashes,
-- and SQLite sees two different strings — so the unique index on
-- (source_file, chunk_index) does not collide and every file is inserted a
-- second time. Ingesting the same vault from a different machine would have
-- silently doubled the corpus.
--
-- The worker now canonicalises on the way in; this brings existing rows into
-- line so they match.

UPDATE archive_chunks
SET source_file = replace(source_file, char(92), '/')
WHERE instr(source_file, char(92)) > 0;
