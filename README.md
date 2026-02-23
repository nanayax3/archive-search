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

Generate a key and add it to `wrangler.toml`:

```bash
openssl rand -hex 16
```

### 5. Deploy

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

## Cost

Runs entirely on Cloudflare's free tier:
- Workers: 100,000 requests/day
- D1: 5M rows read/day, 5GB storage
- Vectorize: 30M queries/month
- Workers AI: Free tier for embeddings

## License

MIT
