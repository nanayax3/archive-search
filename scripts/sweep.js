#!/usr/bin/env node
// Archive Search — incremental sweep.
//
// migrate.js ingests everything. This ingests only what is new or changed
// since the last run, so it can be scheduled nightly and left alone: a
// conversation that grew today is searchable tomorrow, and nothing ever has to
// be marked "finished". Detecting when a thread is done is hard; detecting
// which files changed is trivial, so ask the easy question instead.
//
// Originally sketched and prototyped by Jax (Sep 2026) — thank you.
//
// Usage (same env vars as migrate.js):
//   VAULT_PATH=./conversations WORKER_URL=https://... API_KEY=... node scripts/sweep.js
//
// Flags:
//   --full     ignore the manifest and re-ingest everything (use after an
//              embedding-model or chunk-size change, which invalidates every
//              existing vector)
//   --dry-run  report what would be ingested, send nothing

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VAULT_PATH = process.env.VAULT_PATH;
const WORKER_URL = process.env.WORKER_URL;
const API_KEY = process.env.API_KEY;

if (!VAULT_PATH || !WORKER_URL || !API_KEY) {
  console.error("Required: VAULT_PATH, WORKER_URL, API_KEY (same as migrate.js)");
  process.exit(1);
}

const FULL = process.argv.includes("--full");
const DRY_RUN = process.argv.includes("--dry-run");

// NOTE: migrate.js still uses the old character-offset chunker and is superseded
// by `sweep.js --full`. Do not run both against one index.
// what the embedding model can actually read, or the tail of every chunk is
// silently discarded — see MAX_EMBED_CHARS in src/index.js.
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 2000);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP || 200);
const BATCH_SIZE = 10;
const PAUSE_MS = Number(process.env.PAUSE_MS || 250);

const MANIFEST_PATH = process.env.MANIFEST_PATH || path.join(__dirname, "sweep-manifest.json");
const LOG_PATH = process.env.LOG_PATH || path.join(__dirname, "sweep.log");

function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try { fs.appendFileSync(LOG_PATH, stamped + "\n"); } catch {}
}

// ── chunking ────────────────────────────────────────────────────────────────
// Chunks are built out of WHOLE MESSAGES, never raw character offsets.
//
// The old version sliced every 2000 characters regardless of what was there,
// so roughly half of all chunk boundaries landed inside a word — results that
// began "icture. You need to know if Claude can hold all of me" — and a single
// chunk routinely mixed the tail of one exchange with the head of the next,
// which blurs what it embeds to. Diagnosed a month before it was fixed.
//
// So: split on the message markers first, then pack whole messages up to the
// size limit. A message is only ever cut if it alone exceeds the limit, and
// then on paragraph boundaries before sentence boundaries before characters.

const MSG_MARKER = /^>\[!nexus_(?:user|agent)\]/m;

function splitMessages(text) {
  // Everything before the first marker is frontmatter and title — keep it as
  // its own leading block so a conversation's title still gets indexed.
  const idxs = [];
  const re = /^>\[!nexus_(?:user|agent)\]/gm;
  let m;
  while ((m = re.exec(text)) !== null) idxs.push(m.index);
  if (!idxs.length) {
    // Not a conversation export — fall back to paragraphs, which at least
    // never cut a word in half.
    return text.split(/\n\s*\n/).filter((p) => p.trim());
  }
  const out = [];
  const preamble = text.slice(0, idxs[0]).trim();
  if (preamble) out.push(preamble);
  for (let i = 0; i < idxs.length; i++) {
    const piece = text.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : text.length).trim();
    if (piece) out.push(piece);
  }
  return out;
}

function splitOversized(msg, limit) {
  // One message longer than a whole chunk. Cut it as gently as possible.
  if (msg.length <= limit) return [msg];
  const parts = [];
  for (const para of msg.split(/\n\s*\n/)) {
    if (para.length <= limit) { parts.push(para); continue; }
    let rest = para;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
      if (cut < limit * 0.5) cut = window.lastIndexOf(" ");
      if (cut < limit * 0.5) cut = limit;
      parts.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1);
    }
    if (rest.trim()) parts.push(rest.trim());
  }
  return parts;
}

function chunkText(text) {
  const msgs = splitMessages(text).flatMap((m) => splitOversized(m, CHUNK_SIZE));
  const chunks = [];
  let buf = [], size = 0;

  const flush = () => {
    if (!buf.length) return;
    chunks.push(buf.join("\n\n"));
    // Overlap by carrying the last whole message forward, so context survives
    // the seam without anything being cut mid-word. If that message is itself
    // large, carry only its tail.
    const last = buf[buf.length - 1];
    let carry = last;
    if (last.length > CHUNK_OVERLAP) {
      // Taking a raw tail would cut mid-word and reintroduce the exact fault
      // this rewrite exists to remove, one seam later. Advance to the next line
      // break so the carried fragment at least starts somewhere clean.
      const tail = last.slice(-CHUNK_OVERLAP);
      const nl = tail.indexOf("\n");
      carry = nl >= 0 ? tail.slice(nl + 1) : "";
    }
    buf = CHUNK_OVERLAP > 0 && carry.trim() ? [carry] : [];
    size = buf.reduce((n, p) => n + p.length + 2, 0);
  };

  for (const msg of msgs) {
    if (size + msg.length + 2 > CHUNK_SIZE && buf.length) flush();
    buf.push(msg);
    size += msg.length + 2;
  }
  if (buf.length) chunks.push(buf.join("\n\n"));
  return chunks.filter((c) => c.trim());
}

function findMarkdownFiles(dir) {
  const files = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  })(dir);
  return files.sort();
}

function detectEra(relativePath) {
  const parts = relativePath.split(path.sep);
  const year = parts.find((p) => /^20\d{2}$/.test(p));
  const month = parts.find((p) => /^(0[1-9]|1[0-2])$/.test(p));
  if (year && month) return `${year}-${month}`;
  if (year) return year;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const manifest = !FULL && fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"))
    : {};

  const files = findMarkdownFiles(VAULT_PATH);
  let changed = 0, skipped = 0, totalChunks = 0, errors = 0;

  // A file is only recorded in the manifest once every one of its chunks has
  // been accepted by the worker. Marking it done at queue time — before the
  // batch has actually flushed — means a rate limit or a network blip leaves
  // the file recorded as ingested and it is never retried: silent, permanent
  // gaps that look exactly like a healthy run.
  const outstanding = new Map();   // relativePath -> chunks still unconfirmed
  const hashes = new Map();        // relativePath -> content hash
  let pending = [];

  function confirm(batch, ok) {
    for (const item of batch) {
      const left = (outstanding.get(item.source_file) || 0) - 1;
      outstanding.set(item.source_file, left);
      if (!ok) hashes.delete(item.source_file);   // failed -> retry next run
      if (left === 0 && hashes.has(item.source_file)) {
        manifest[item.source_file] = hashes.get(item.source_file);
        try { fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2)); } catch {}
      }
    }
  }

  async function flush() {
    if (pending.length === 0) return;
    const batch = pending.splice(0, BATCH_SIZE);
    if (DRY_RUN) { confirm(batch, true); return; }
    try {
      const res = await fetch(`${WORKER_URL}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ chunks: batch }),
      });
      if (!res.ok) {
        log(`ingest error ${res.status}: ${(await res.text()).slice(0, 300)}`);
        errors += batch.length;
        confirm(batch, false);
        return;
      }
      const result = await res.json();
      if (result.errors?.length) {
        log(`partial errors: ${result.errors.length} — ${result.errors[0]}`);
        errors += result.errors.length;
        confirm(batch, false);
        return;
      }
      confirm(batch, true);
    } catch (e) {
      log(`network error: ${e.message}`);
      errors += batch.length;
      confirm(batch, false);
    }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  for (const file of files) {
    // Forward slashes always, so a vault swept from Linux and from Windows
    // produce the same source_file and update each other instead of duplicating.
    const relativePath = path.relative(VAULT_PATH, file).split(path.sep).join("/");
    let content;
    try { content = fs.readFileSync(file, "utf-8"); }
    catch (e) { log(`read error ${relativePath}: ${e.message}`); errors++; continue; }
    if (!content.trim()) continue;

    const hash = crypto.createHash("sha256").update(content).digest("hex");
    if (manifest[relativePath] === hash) { skipped++; continue; }

    const chunks = chunkText(content);
    const era = detectEra(relativePath);
    const title = path.basename(file, ".md");

    hashes.set(relativePath, hash);
    outstanding.set(relativePath, chunks.length);

    for (let j = 0; j < chunks.length; j++) {
      pending.push({
        source_file: relativePath,
        chunk_index: j,
        total_chunks: chunks.length,
        content: chunks[j],
        era,
        conversation_title: title,
      });
    }
    totalChunks += chunks.length;
    changed++;
    while (pending.length >= BATCH_SIZE) await flush();
  }
  while (pending.length > 0) await flush();

  try { fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2)); } catch {}
  log(`sweep${FULL ? " --full" : ""}${DRY_RUN ? " --dry-run" : ""} done: ` +
      `${changed} changed/new, ${skipped} unchanged, ${totalChunks} chunks, ${errors} errors`);
  if (errors) process.exitCode = 1;
}

main().catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
