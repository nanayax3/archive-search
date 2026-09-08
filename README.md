# Archive Search

A Cloudflare Worker that provides **semantic search** across conversation archives via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Give your AI companion searchable memory of past conversations — accessible from anywhere.

## What it does

- Stores conversation chunks in Cloudflare D1
- Generates embeddings with Workers AI (`@cf/baai/bge-m3` — 8192-token window, 1024 dimensions, 100+ languages)
- Indexes embeddings in Cloudflare Vectorize for semantic search
- Exposes search via MCP so any compatible AI client can query it
- Falls back to text search when vector results are empty
- **Keeps itself up to date**: `scripts/sweep.js` ingests only files that are new or changed, so it can be scheduled nightly and left alone
- **Collapses duplicate passages**: the same text in two files returns once, listing every file it appears in, instead of filling the page with copies

## Architecture

```
AI Client (Claude, etc.)
    ↓ MCP over HTTP
Cloudflare Worker (archive-search)
    ├── D1 (chunk storage)
    ├── Vectorize (semantic index)
    └── Workers AI (embeddings)
```

Everything runs on Cloudflare's free tier. No external dependencies, no local servers to keep running.

## Setup

### 1. Prerequisites

- [Cloudflare account](https://dash.cloudflare.com)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and authenticated
- Node.js 18+

### 2. Clone and configure

```bash
git clone https://github.com/your-username/archive-search.git
cd archive-search
cp wrangler.toml.example wrangler.toml
```

### 3. Create Cloudflare resources

```bash
# Create D1 database
wrangler d1 create archive-search
# Copy the database_id into your wrangler.toml

# Create Vectorize index
wrangler vectorize create archive-search-vectors --dimensions=1024 --metric=cosine
```

### 4. Set your API key

Generate a key and store it as a Cloudflare secret (never commit it to your repo):

```bash
# Generate a random key
openssl rand -hex 16

# Deploy first (so the Worker exists)
wrangler deploy

# Then set the secret
echo "your-generated-key" | wrangler secret put API_KEY
```

### 5. Apply migrations and deploy

Migrations are applied in order. `0002` adds the unique index that makes re-ingestion replace rather than duplicate, plus a content hash column; `0003` normalises path separators on any rows ingested before that was enforced. If you are starting fresh, applying all three in order is all that is needed.


```bash
# Apply database migrations
wrangler d1 migrations apply archive-search --remote

# Deploy the worker
wrangler deploy
```

### 6. Ingest your conversations

The migration script reads markdown files, chunks them (2000 chars with 200 char overlap), and uploads them to the worker for embedding and indexing.

```bash
VAULT_PATH="/path/to/your/conversations" \
WORKER_URL="https://archive-search.your-subdomain.workers.dev" \
API_KEY="your-api-key" \
node scripts/migrate.js
```

Your conversations should be `.md` files in any directory structure. The script discovers them recursively.

### 7. Keep it up to date automatically

`migrate.js` ingests everything, every time. `sweep.js` ingests only what has changed since the last run, using a manifest of content hashes stored next to the script:

```bash
VAULT_PATH="/path/to/your/conversations" \
WORKER_URL="https://archive-search.your-subdomain.workers.dev" \
API_KEY="your-api-key" \
node scripts/sweep.js
```

Unchanged files cost nothing — they are skipped without being read into chunks or embedded. Run it from cron, a systemd timer, Task Scheduler, or as the last step of a backup you already run nightly.

| Flag | Effect |
|---|---|
| *(none)* | ingest new and changed files only |
| `--full` | ignore the manifest and re-ingest everything (use after changing the embedding model or chunk size, which invalidates every existing vector) |
| `--dry-run` | report what would be ingested without sending anything |

Optional environment variables: `CHUNK_SIZE` (default 2000), `CHUNK_OVERLAP` (default 200), `PAUSE_MS` between batches, `MANIFEST_PATH`, `LOG_PATH`.

**Why a sweep rather than detecting when a conversation is finished:** nothing marks a thread as done, and some are never done. "Which files changed since I last looked" is a much easier question, and it gives the same result a day later. A conversation that grew today is searchable tomorrow; one that ended today is searchable tomorrow too.

A file is only recorded in the manifest once **every one of its chunks has been accepted**. If a batch fails — a rate limit, a dropped connection — that file is left unrecorded and picked up again on the next run. The failure mode to avoid is a file marked as ingested whose chunks never arrived: a permanent gap that looks exactly like a healthy night.

Failures are written to `sweep.log`, one line each, and every run stamps a summary line. An empty log is provably healthy rather than merely quiet, and a stale final timestamp is the alarm for the sweeper itself having died.

## Upgrading an existing deployment

If you already have this running, you do not have to take all of it. The correctness fixes and the model change are independent, and the first group is cheap.

### Step 1 — the fixes (no re-embedding)

**Check for duplicate rows first.** Migration `0002` adds a unique index on `(source_file, chunk_index)`, which will fail outright if duplicates already exist — and if you have ever re-ingested a file, they do:

```sql
SELECT source_file, chunk_index, COUNT(*) AS copies
FROM archive_chunks GROUP BY 1, 2 HAVING copies > 1;
```

If that returns rows, keep one of each before migrating:

```sql
DELETE FROM archive_chunks WHERE id NOT IN (
  SELECT MIN(id) FROM archive_chunks GROUP BY source_file, chunk_index
);
```

Then apply the migrations and deploy:

```bash
wrangler d1 migrations apply archive-search --remote
wrangler deploy
```

You now get: re-ingestion that replaces instead of duplicating, duplicate passages collapsed in results, per-file caps, and vector ids that stop stranding their predecessors. Existing vectors keep working — search falls back to the old row-id scheme for anything written before the change, so nothing breaks while the index is mixed.

Any file you re-ingest from here on picks up the new ids. Re-ingesting everything (`node scripts/sweep.js --full`) converts the whole index and lets you drop the old vectors, but it is optional at this stage.

### Step 2 — the embedding model (re-embeds everything)

`bge-m3` produces 1024-dimensional vectors and the old model produced 768. Vectorize indexes have a fixed dimension, so this is a **new index**, not a migration.

Build it alongside the live one rather than replacing it:

```bash
wrangler vectorize create archive-search-vectors-m3 --dimensions=1024 --metric=cosine
```

Add it as a second binding in `wrangler.toml` while keeping the old one, then set the two vars so ingest writes to the new index while search keeps reading the old:

```toml
[vars]
WRITE_INDEX = "VECTORS_M3"
READ_INDEX  = "VECTORS"
```

Deploy, and run a full re-ingest:

```bash
VAULT_PATH=... WORKER_URL=... API_KEY=... node scripts/sweep.js --full
```

Searches keep working off the old index throughout. When the new one is populated, set `READ_INDEX` to the new binding and deploy — a config change rather than a code change, and reversible the same way. Keep the old index until you have lived with the new one for a while; delete it when you stop reaching for it.

Expect the re-ingest to take a while and to bump against Workers AI daily limits on a large archive. It is safe to stop and restart: the manifest means the next run resumes where it left off.

## MCP Tools

### `search_archive`

Semantic search across your conversation archive.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | What you're looking for, conceptually |
| `n_results` | integer | no | Results to return (default 5, max 20) |

**Example:** Searching for `"moments of vulnerability"` will find passages about opening up, being honest about feelings, showing weakness — even if those exact words aren't used.

### `get_archive_stats`

Returns total chunks indexed and source file count.

### `repair_archive`

Scans the database page by page, checks which chunks are missing vector embeddings, and re-embeds only those. Run this after migration to patch gaps caused by rate limits during ingestion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `batch_size` | integer | no | Chunks to scan per run (default 200, max 200) |

The tool tracks its scan position — run it multiple times and it picks up where it left off. Once it reaches the end, it reports completion and resets. Only chunks with missing vectors get re-embedded, so repeated runs are fast when everything is healthy.

## Connecting to your AI client

This is a **cloud MCP server** — once deployed, it's accessible from any client that supports remote MCP connections. No local servers to run.

### Claude Desktop (Remote MCP)

1. Open Claude Desktop settings
2. Add a new remote MCP server (connector)
3. Use the URL with your API key in the path:

```
https://archive-search.your-subdomain.workers.dev/mcp/your-api-key
```

That's it — no headers needed, no local config files. The server is available from any device where you use Claude.

### Claude Code

Add to your `.claude.json` or MCP settings:

```json
{
  "mcpServers": {
    "archive-search": {
      "type": "http",
      "url": "https://archive-search.your-subdomain.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

### Other MCP clients

Any MCP-compatible client can connect via:
- **Path auth:** `POST https://archive-search.your-subdomain.workers.dev/mcp/your-api-key`
- **Header auth:** `POST https://archive-search.your-subdomain.workers.dev/mcp` with `Authorization: Bearer your-api-key`

## HTTP Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/mcp` | POST | Bearer | MCP protocol handler |
| `/mcp/TOKEN` | POST | Path | MCP protocol handler (token in URL) |
| `/ingest` | POST | Bearer | Bulk upload chunks |
| `/health` | GET | No | Health check |
| `/stats` | GET | Bearer | Archive statistics |

## Ingest format

`POST /ingest` accepts:

```json
{
  "chunks": [
    {
      "source_file": "2025/07/conversation-title.md",
      "chunk_index": 0,
      "total_chunks": 5,
      "content": "The actual text content...",
      "era": "2025-07",
      "conversation_title": "conversation-title"
    }
  ]
}
```

## How it works

1. **Chunking**: Conversations are split into overlapping chunks (2000 characters with 200 of overlap by default) so context is preserved across boundaries
2. **Embedding**: Each chunk is embedded with `@cf/baai/bge-m3` — 1024 dimensions, an 8192-token window, and 100+ languages
3. **Indexing**: Embeddings go into Vectorize under an id derived from `(source_file, chunk_index)`, with the same pair in the metadata
4. **Searching**: The query is embedded with the same model, matched by cosine similarity, then the results are collapsed and capped before being returned
5. **Fallback**: If no vector matches are found, a text `LIKE` search runs against D1

### A chunk is identified by where it came from, not by a row id

Vector ids are derived from `(source_file, chunk_index)`. This matters more than it sounds:

- Re-ingesting a file **overwrites its own vectors** instead of writing new ones and abandoning the old. Deriving the id from a database row id means every re-ingest strands the previous vector in the index, pointing at a row that no longer exists — the index grows without bound and searches start hitting ghosts whose lookup comes back empty.
- `source_file` is stored with **forward slashes on every platform**. Ingesting the same vault from Windows and from Linux otherwise produces two different strings for the same file, the unique index does not collide, and the entire corpus is silently inserted a second time.
- Re-chunking can produce **fewer** chunks than before. `INSERT OR REPLACE` updates `0..n-1` and leaves everything past `n` behind, so the ingest deletes chunks at or beyond the new count for that file.

### Duplicate passages are collapsed, and long files are capped

Two things make raw vector search read badly on a conversation corpus:

- **The same passage lives in more than one file.** A summary written at the end of one conversation and pasted into the start of the next is byte-identical in both, so it scores twice and pushes everything else off the page. Identical passages are returned once, with an `Also appears in:` line naming every file they occur in — the duplication is information about where two conversations join, not noise to discard.
- **One long file can fill the results.** Neighbouring chunks of the same document all match a broad query, so any single file contributes at most two results. The search over-fetches to compensate.

## Security and privacy

If you're using this to store personal conversations, you should understand exactly where your data lives and who can access it.

### What gets stored and where

Your data lives in three Cloudflare services:

| Service | What it holds | Encryption at rest |
|---------|--------------|-------------------|
| **D1** (database) | Full text of every conversation chunk, file paths, timestamps | AES-256-GCM |
| **Vectorize** (vector index) | Embedding vectors + metadata (file paths, 200-char text previews) | AES-256-GCM (stored on R2) |
| **Workers AI** | Nothing — text is processed for embeddings and not retained | N/A |

All data is encrypted in transit (TLS) and at rest (AES-256-GCM). Encryption and decryption are automatic.

### Cloudflare is not zero-knowledge

**This is the most important thing to understand.** Cloudflare manages the encryption keys. Your data is encrypted at rest, but Cloudflare holds the keys — meaning a sufficiently privileged employee or a legal compulsion could theoretically result in data access.

Access is restricted by organizational controls:
- Employees require unique credentials with hardware-token MFA
- Least-privilege and zero-trust authorization
- All personnel with data access are under contractual confidentiality obligations
- Cloudflare's [DPA](https://www.cloudflare.com/cloudflare-customer-dpa/) commits to never providing encryption keys or customer data feeds to law enforcement

This is strong protection through **policy and contract**, but it is not the same as technical impossibility. If you need zero-knowledge encryption for your data, this architecture is not the right fit — consider a local deployment instead (see [vault-archive-product](https://github.com/nanayax3/vault-archive-product) for a fully local alternative using ChromaDB).

### Workers AI and your text

When your text is sent to Workers AI for embedding generation:
- It is **not stored or logged** by Cloudflare
- It is **not used for training** any models — [Cloudflare explicitly commits to this](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
- Processing runs on **Cloudflare's own GPU network**, not sent to third parties
- The embedding model (`bge-base-en-v1.5`) is an open-source model hosted on Cloudflare hardware

### Data location

D1 automatically places your database near where you created it. You can set a jurisdiction at creation time for data residency:

```bash
# Keep data in the EU
wrangler d1 create archive-search --location=eu

# FedRAMP-compliant locations
wrangler d1 create archive-search --location=fedramp
```

Jurisdictions are **immutable after creation**. If you need EU data residency, set it when you create the database — you can't add it later.

### Authentication

The Worker uses a single API key for all authenticated endpoints. The key is stored as a [Cloudflare secret](https://developers.cloudflare.com/workers/configuration/secrets/) (encrypted, never visible in your code or dashboard). Two auth methods are supported:

- **Bearer token**: `Authorization: Bearer your-key` header
- **Path token**: `/mcp/your-key` in the URL

**Important**: Never commit your API key to version control. The included `.gitignore` excludes `wrangler.toml` (which may contain your database ID), but your API key should always be set via `wrangler secret put API_KEY`.

### What this project does NOT include

- **No rate limiting per caller** — anyone with your API key can make unlimited requests (within Cloudflare's free tier limits of 100k requests/day)
- **No audit logging** — searches are not logged (which is good for privacy, but means you can't detect unauthorized access)
- **No key rotation mechanism** — to rotate, generate a new key and run `wrangler secret put API_KEY` again
- **CORS is permissive** (`Access-Control-Allow-Origin: *`) — appropriate for MCP clients, but means the API is callable from any origin with the key

### Cloudflare's certifications

Cloudflare maintains SOC 2 Type II, ISO 27001, ISO 27018 (cloud privacy), ISO 27701 (privacy information management), and PCI DSS certifications. Full details at [Cloudflare Trust Hub](https://www.cloudflare.com/trust-hub/compliance-resources/).

### The honest summary

Your conversation data is encrypted at rest and in transit, processed on Cloudflare's infrastructure (not sent to third parties), and not used for training. Cloudflare is contractually and organizationally restricted from accessing it. But they hold the encryption keys, so "can't access" is a policy guarantee, not a cryptographic one. For most personal use cases this is solid protection — comparable to storing data in any major cloud provider. If your threat model requires zero-knowledge encryption, host locally instead.

## Cost

Check the pricing pages for each service to calculate your own costs:
- **[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)** — embedding generation (this is where ingestion cost lives)
- **[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)** — database storage and reads
- **[Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)** — vector index queries
- **[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)** — request handling

### How much does it actually cost?

Cloudflare measures AI compute in [neurons](https://developers.cloudflare.com/workers-ai/platform/pricing/). The free tier gives you **10,000 neurons per day** (resets at 00:00 UTC). Embedding models are extremely cheap because they're small, fast operations — much cheaper than text generation.

**The math for embeddings (`bge-base-en-v1.5`):**
- Cost: **6,058 neurons per 1,000,000 input tokens**
- A 2000-character chunk is ~500 tokens
- One chunk costs: 500 ÷ 1,000,000 × 6,058 = **~0.003 neurons**

That's three thousandths of a neuron per chunk. Which means:

| Archive size | Neurons used | % of free daily limit |
|-------------|-------------|----------------------|
| 10,000 chunks | ~30 neurons | 0.3% |
| 20,000 chunks | ~63 neurons | 0.6% |
| 50,000 chunks | ~152 neurons | 1.5% |
| 100,000 chunks | ~303 neurons | 3% |

**You can embed your entire archive in a single session on the free tier.** Even 100,000 chunks uses only 3% of the daily free allocation. We tested this ourselves — 20,755 chunks embedded in one hour, on the free plan, using under 1% of the daily limit.

The other services are similarly generous for this use case:
- **Workers:** 100,000 requests/day (ingestion + searches)
- **D1:** 5M rows read/day, 5GB storage
- **Vectorize:** 30M queries/month

**In practice, this project runs entirely for free** — both initial ingestion and ongoing searches. The `repair_archive` tool exists as a safety net in case any embeddings fail during ingestion (e.g., due to network errors or temporary rate limits), but you should not need to run it across multiple days.

On the free plan, if you somehow exceed 10,000 neurons/day, requests fail with an error — **you will never be surprised with a bill.** On the Workers Paid plan ($5/month), overages are billed at $0.011 per 1,000 neurons, but you'd need to embed millions of chunks in a single day to even notice.

## License

MIT
