# Archive Search

A Cloudflare Worker that provides **semantic search** across conversation archives via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Give your AI companion searchable memory of past conversations — accessible from anywhere.

## What it does

- Stores conversation chunks in Cloudflare D1
- Generates embeddings with Workers AI (BGE model, 768 dimensions)
- Indexes embeddings in Cloudflare Vectorize for semantic search
- Exposes search via MCP so any compatible AI client can query it
- Falls back to text search when vector results are empty

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
wrangler vectorize create archive-search-vectors --dimensions=768 --metric=cosine
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

1. **Chunking**: Conversations are split into 2000-character chunks with 200-character overlap to preserve context at boundaries
2. **Embedding**: Each chunk is embedded using `@cf/baai/bge-base-en-v1.5` (768-dimensional vectors)
3. **Indexing**: Embeddings are stored in Cloudflare Vectorize with metadata linking back to the D1 record
4. **Searching**: Query text is embedded with the same model, then matched against the index using cosine similarity
5. **Fallback**: If no vector matches are found, a text-based `LIKE` search runs against D1

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

### Ongoing usage (searching)

Runs entirely on Cloudflare's free tier:
- Workers: 100,000 requests/day
- D1: 5M rows read/day, 5GB storage
- Vectorize: 30M queries/month
- Workers AI: Free tier for embeddings

Even heavy daily use (hundreds of searches) won't come close to these limits.

### Initial ingestion (embedding your conversations)

This is where cost matters. Every chunk needs an embedding generated via Workers AI, which costs [neurons](https://developers.cloudflare.com/workers-ai/platform/pricing/) — Cloudflare's unit for GPU compute.

**The math:**
- `bge-base-en-v1.5` costs **6,058 neurons per 1M input tokens**
- English text averages ~4 characters per token
- A 2000-character chunk is ~500 tokens
- Free tier: **10,000 neurons/day**
- Paid overage: **$0.011 per 1,000 neurons**

**Example — 10,000 chunks (~20M characters of conversation):**

| Approach | Cost | Timeline |
|----------|------|----------|
| Free tier only | **$0** | ~3 days of batched migration |
| Paid plan, all at once | **~$0.33** | A few hours |

**Example — 50,000 chunks (~100M characters of conversation):**

| Approach | Cost | Timeline |
|----------|------|----------|
| Free tier only | **$0** | ~15 days of batched migration |
| Paid plan, all at once | **~$1.65** | A few hours |

**Using the free tier:** The migration script will hit rate limits partway through. This is expected. The `repair_archive` MCP tool exists for exactly this — run it across multiple days, and it picks up where it left off, re-embedding only the chunks that were missed. Patience costs nothing.

**On the paid plan ($5/month Workers Paid):** You get the same 10,000 free neurons/day, and overages are billed at $0.011/1,000 neurons. Even a large archive (50k+ chunks) costs under $2 to fully embed.

## License

MIT
