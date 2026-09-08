// Archive Search - Cloudflare Worker
// Semantic search across conversation archives via MCP

// ═══ TOOLS DEFINITION ═══

const TOOLS = [
  {
    name: "search_archive",
    description:
      "Search conversation archive using semantic similarity. " +
      "Finds relevant passages from past conversations based on meaning, not just keywords. " +
      "Use for: identity verification, pattern recognition, relationship history, " +
      "or when human asks about past conversations.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query - describe what you're looking for conceptually",
        },
        n_results: {
          type: "integer",
          description: "Number of results to return (default 5, max 20)",
          default: 5,
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_archive_stats",
    description:
      "Get statistics about the indexed conversation archive. " +
      "Shows total chunks indexed and index status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "repair_archive",
    description:
      "Find and re-embed chunks that are in the database but missing from the vector index. " +
      "Run this after migration to patch gaps caused by rate limits. " +
      "Returns count of repaired chunks.",
    inputSchema: {
      type: "object",
      properties: {
        batch_size: {
          type: "integer",
          description: "Chunks to process per run (default 50, max 200). Use smaller values to avoid rate limits.",
          default: 50,
          minimum: 1,
          maximum: 200,
        },
      },
    },
  },
];

// ═══ RESULT SHAPING ═══
// Two things make a raw vector search read badly on this corpus:
//
//   1. The same passage exists in more than one file. The handover ritual is
//      the usual cause — a summary written at the end of one conversation and
//      pasted at the top of the next — so the identical text scores twice and
//      fills the page. Collapse by content hash and name every file it appears
//      in; the duplication is information, not noise.
//
//   2. Neighbouring chunks of one long file all match a broad query and crowd
//      everything else out. Cap how many any single file may contribute.

const MAX_PER_FILE = 2;

function collapseResults(results, limit) {
  const byHash = new Map();
  const seen = [];

  for (const r of results) {
    // Key on the text itself, not on the stored hash. Rows ingested before
    // migration 0002 have content_hash NULL, and falling back to file+index
    // would give every row a unique key — which silently disables the whole
    // point of this function. The text is already in hand; use it.
    const key = r.text ? `t:${r.text.length}:${r.text}` : `${r.source_file}#${r.chunk_index}`;
    const existing = byHash.get(key);
    if (existing) {
      if (!existing.also_in.includes(r.source_file)) existing.also_in.push(r.source_file);
      existing.relevance = Math.max(existing.relevance, r.relevance);
      continue;
    }
    const entry = { ...r, also_in: [] };
    byHash.set(key, entry);
    seen.push(entry);
  }

  const perFile = new Map();
  const kept = [];
  for (const r of seen.sort((a, b) => b.relevance - a.relevance)) {
    const n = perFile.get(r.source_file) || 0;
    if (n >= MAX_PER_FILE) continue;
    perFile.set(r.source_file, n + 1);
    kept.push(r);
    if (kept.length >= limit) break;
  }
  return kept;
}

// ═══ IDENTITY ═══
// A chunk is identified by the file it came from and its position in that file
// — never by a database row id. Row ids change on every re-ingest, which used
// to strand the old vector in the index pointing at a row that no longer
// existed. Deriving the vector id from (source_file, chunk_index) means a
// re-ingest overwrites its own vector instead of abandoning it.

// Path separators are canonically forward slashes. The archive was first
// ingested from Windows, where path.relative() yields backslashes; the same
// vault swept from Linux yields forward slashes, and the two are different
// strings. Without this, running the sweep from a second machine silently
// duplicates the entire corpus instead of updating it.
function canonicalPath(p) {
  return String(p).replace(/\\/g, "/");
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function vectorIdFor(sourceFile, chunkIndex) {
  const fileHash = (await sha256Hex(sourceFile)).slice(0, 16);
  return `chunk-${fileHash}-${chunkIndex}`;
}

// ═══ EMBEDDING ═══

// The embedding model and how much text it can actually read. bge-base has a
// 512-token window — roughly 2000 characters — so anything longer is silently
// truncated by the model itself. Keep MAX_EMBED_CHARS honest about that: it is
// better to know the tail is being dropped than to pass 8000 characters and
// assume they were used. Chunk size in the ingest scripts should stay at or
// under this number.
// A single index is the normal case: bind it as VECTORS and nothing below
// needs configuring. During an embedding-model change there are briefly two,
// because Vectorize indexes have a fixed dimension and a new model means a new
// index rather than a migration. Set WRITE_INDEX and READ_INDEX as vars in
// wrangler.toml to point ingest at the new index while search keeps serving
// from the old one; flipping over afterwards is a config change, not a deploy
// of different code.
const EMBEDDING_MODEL = "@cf/baai/bge-m3";       // 8192-token window, 1024 dims, multilingual
const MAX_EMBED_CHARS = 8000;                    // comfortably inside that window

const writeIndex = (env) => env[env.WRITE_INDEX || "VECTORS"] || env.VECTORS;
const readIndex = (env) => env[env.READ_INDEX || "VECTORS"] || env.VECTORS;

async function getEmbedding(ai, text) {
  // Sanitize input — strip characters that can produce bad embeddings
  const clean = text.replace(/[^\x20-\x7E\n\r\t]/g, ' ').slice(0, MAX_EMBED_CHARS);
  const result = await ai.run(EMBEDDING_MODEL, { text: [clean] });
  const embedding = result.data[0];
  // Sanitize output — replace NaN/Infinity with 0
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) embedding[i] = 0;
  }
  return embedding;
}

// ═══ TOOL HANDLERS ═══

async function handleSearchArchive(env, params) {
  const query = params.query;
  const nResults = Math.min(Math.max(params.n_results || 5, 1), 20);

  if (!query) return "Error: query parameter required";

  try {
    // Generate query embedding
    const embedding = await getEmbedding(env.AI, query);

    // Over-fetch: identical passages and long runs from one file get collapsed
    // below, so ask for more than we intend to show.
    const vectorResults = await readIndex(env).query(embedding, {
      topK: Math.min(nResults * 4, 60),
      returnMetadata: "all",
    });

    let results = [];

    if (vectorResults.matches && vectorResults.matches.length > 0) {
      for (const match of vectorResults.matches) {
        // Look the chunk up by what actually identifies it. Falls back to the
        // old row-id-in-the-vector-id scheme so vectors written before the
        // deterministic-id change still resolve.
        let row = null;
        const meta = match.metadata;
        if (meta?.source_file != null && meta?.chunk_index != null) {
          row = await env.DB.prepare(
            "SELECT source_file, content, chunk_index, content_hash FROM archive_chunks WHERE source_file = ? AND chunk_index = ?"
          )
            .bind(meta.source_file, meta.chunk_index)
            .first();
        }
        if (!row) {
          const legacyId = match.id.replace("chunk-", "");
          if (/^\d+$/.test(legacyId)) {
            row = await env.DB.prepare(
              "SELECT source_file, content, chunk_index, content_hash FROM archive_chunks WHERE id = ?"
            )
              .bind(legacyId)
              .first();
          }
        }

        if (row) {
          results.push({
            source_file: row.source_file,
            text: row.content,
            relevance: match.score,
            chunk_index: row.chunk_index,
            content_hash: row.content_hash,
          });
        }
      }
    }

    results = collapseResults(results, nResults);

    // Fallback to text search if no vector results
    if (results.length === 0) {
      const textResults = await env.DB.prepare(
        `SELECT source_file, content, chunk_index
         FROM archive_chunks
         WHERE content LIKE ?
         LIMIT ?`
      )
        .bind(`%${query}%`, nResults)
        .all();

      if (textResults.results) {
        results = textResults.results.map((row) => ({
          source_file: row.source_file,
          text: row.content,
          relevance: 0.5,
          chunk_index: row.chunk_index,
        }));
      }
    }

    // Format output
    let output = `Search: '${query}'\nFound ${results.length} results:\n\n`;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      output += `${"=".repeat(80)}\n`;
      output += `Result ${i + 1} | Relevance: ${r.relevance.toFixed(3)}\n`;
      output += `Source: ${r.source_file}\n`;
      if (r.also_in && r.also_in.length) {
        // The same passage in more than one conversation — usually the seam
        // where a handover summary was carried from one thread into the next.
        output += `Also appears in: ${r.also_in.join(", ")}\n`;
      }
      output += `\n`;
      output += `${r.text}\n\n`;
    }

    output += `${"=".repeat(80)}\n`;
    return output;
  } catch (error) {
    return `Error searching archive: ${error.message}`;
  }
}

async function handleGetStats(env) {
  try {
    const stats = await env.DB.prepare(
      `SELECT
        COUNT(*) as total_chunks,
        COUNT(DISTINCT source_file) as source_files
       FROM archive_chunks`
    ).first();

    let output = `Archive Statistics:\n`;
    output += `Total chunks indexed: ${(stats.total_chunks || 0).toLocaleString()}\n`;
    output += `Source files: ${(stats.source_files || 0).toLocaleString()}\n`;
    output += `Status: ${stats.total_chunks > 0 ? "indexed" : "empty"}\n`;

    return output;
  } catch (error) {
    return `Error getting stats: ${error.message}`;
  }
}

// ═══ REPAIR HANDLER ═══

async function handleRepairArchive(env, params) {
  const batchSize = Math.min(Math.max(params.batch_size || 200, 1), 200);

  try {
    // Get total count
    const countResult = await env.DB.prepare(
      "SELECT COUNT(*) as total FROM archive_chunks"
    ).first();
    const total = countResult.total;

    if (total === 0) return "No chunks in database. Nothing to repair.";

    // Track scan progress
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS repair_progress (id INTEGER PRIMARY KEY, last_offset INTEGER DEFAULT 0)"
    ).run();
    const progress = await env.DB.prepare(
      "SELECT last_offset FROM repair_progress WHERE id = 1"
    ).first();
    const offset = progress ? progress.last_offset : 0;

    // Get a page of chunks
    const pageChunks = await env.DB.prepare(
      "SELECT id, content, source_file, chunk_index FROM archive_chunks ORDER BY id LIMIT ? OFFSET ?"
    ).bind(batchSize, offset).all();

    if (!pageChunks.results || pageChunks.results.length === 0) {
      // Full scan complete — reset for next run
      await env.DB.prepare(
        "INSERT OR REPLACE INTO repair_progress (id, last_offset) VALUES (1, 0)"
      ).run();
      return `Scan complete! All ${total} chunks checked.\nProgress reset for next run.`;
    }

    // Check which chunks are missing vectors (batches of 20, Vectorize limit)
    const missing = [];
    for (let i = 0; i < pageChunks.results.length; i += 20) {
      const batch = pageChunks.results.slice(i, i + 20);
      const wanted = await Promise.all(
        batch.map(async (c) => ({ chunk: c, vid: await vectorIdFor(c.source_file, c.chunk_index) }))
      );
      const found = await writeIndex(env).getByIds(wanted.map((w) => w.vid));
      const foundSet = new Set(found.map((v) => v.id));
      for (const w of wanted) {
        if (!foundSet.has(w.vid)) missing.push(w.chunk);
      }
    }

    // Re-embed only the missing ones
    let repaired = 0;
    const errors = [];
    for (const chunk of missing) {
      try {
        const embedding = await getEmbedding(env.AI, chunk.content);
        await writeIndex(env).upsert([{
          id: await vectorIdFor(chunk.source_file, chunk.chunk_index),
          values: embedding,
          metadata: {
            source_file: chunk.source_file,
            chunk_index: chunk.chunk_index,
            preview: chunk.content.replace(/[^\x20-\x7E\n\r\t]/g, ' ').slice(0, 200),
          },
        }]);
        repaired++;
      } catch (error) {
        errors.push(`${chunk.source_file}#${chunk.chunk_index}: ${error.message}`);
      }
    }

    // Save progress
    const nextOffset = offset + pageChunks.results.length;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO repair_progress (id, last_offset) VALUES (1, ?)"
    ).bind(nextOffset).run();

    let output = `Repair scan:\n`;
    output += `Checked: ${pageChunks.results.length} chunks (offset ${offset}-${nextOffset})\n`;
    output += `Missing vectors found: ${missing.length}\n`;
    output += `Repaired: ${repaired}\n`;
    output += `Progress: ${nextOffset}/${total} (${Math.round((nextOffset / total) * 100)}%)\n`;
    if (nextOffset < total) {
      output += `Run again to continue scanning.\n`;
    } else {
      output += `Scan complete! All chunks checked.\n`;
    }
    if (errors.length > 0) {
      output += `Errors: ${errors.length}\n`;
      errors.forEach(e => output += `  - ${e}\n`);
    }

    return output;
  } catch (error) {
    return `Error during repair: ${error.message}`;
  }
}

// ═══ INGEST HANDLER ═══

async function handleIngest(request, env) {
  const body = await request.json();
  const chunks = body.chunks;

  if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
    return new Response(JSON.stringify({ error: "No chunks provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let inserted = 0;
  let vectorized = 0;
  const errors = [];

  // Process in batches of 50 for D1
  for (let i = 0; i < chunks.length; i += 50) {
    const batch = chunks.slice(i, i + 50);
    const stmts = [];

    // Hash the content up front. The hash is what lets search collapse a
    // passage that exists in more than one file into one result.
    for (const chunk of batch) {
      chunk.source_file = canonicalPath(chunk.source_file);
      chunk._hash = await sha256Hex(chunk.content);
    }

    for (const chunk of batch) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO archive_chunks
             (source_file, chunk_index, total_chunks, content, era, conversation_title, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          chunk.source_file,
          chunk.chunk_index,
          chunk.total_chunks || 1,
          chunk.content,
          chunk.era || null,
          chunk.conversation_title || null,
          chunk._hash
        )
      );
    }

    // Re-chunking a file can produce FEWER chunks than last time (a larger
    // chunk size, or the file was edited down). INSERT OR REPLACE updates
    // 0..n-1 and leaves everything past n behind: rows belonging to a chunking
    // scheme that no longer exists, still matching searches. Drop them.
    for (const chunk of batch) {
      if (chunk.chunk_index === 0 && chunk.total_chunks) {
        stmts.push(
          env.DB.prepare(
            "DELETE FROM archive_chunks WHERE source_file = ? AND chunk_index >= ?"
          ).bind(chunk.source_file, chunk.total_chunks)
        );
      }
    }

    try {
      const results = await env.DB.batch(stmts);
      // stmts holds this batch's inserts PLUS, per file, one DELETE that trims
      // chunks left over from a previous chunking scheme — so it is longer than
      // batch. Iterating results and writing batch[j] ran off the end of the
      // array and threw on every single batch. Nothing downstream needs the row
      // ids any more; vector ids come from (source_file, chunk_index).
      for (let j = 0; j < batch.length && j < results.length; j++) {
        if (results[j]?.meta?.last_row_id) inserted++;
      }
    } catch (error) {
      errors.push(`D1 batch error at ${i}: ${error.message}`);
      continue;
    }
  }

  // Vectorize in batches of 100 (embedding + upsert)
  // Everything gets a vector, keyed by (source_file, chunk_index) — not by row id,
  // so a re-ingest overwrites the old vector rather than orphaning it.
  const toVectorize = chunks;
  for (let i = 0; i < toVectorize.length; i += 100) {
    const batch = toVectorize.slice(i, i + 100);
    const vectors = [];

    for (const chunk of batch) {
      try {
        const embedding = await getEmbedding(env.AI, chunk.content);
        vectors.push({
          id: await vectorIdFor(chunk.source_file, chunk.chunk_index),
          values: embedding,
          metadata: {
            source_file: chunk.source_file,
            chunk_index: chunk.chunk_index,
            preview: chunk.content.replace(/[^\x20-\x7E\n\r\t]/g, ' ').slice(0, 200),
          },
        });
      } catch (error) {
        errors.push(`Embedding error for ${chunk.source_file}[${chunk.chunk_index}]: ${error.message}`);
      }
    }

    if (vectors.length > 0) {
      try {
        await writeIndex(env).upsert(vectors);
        vectorized += vectors.length;
      } catch (error) {
        errors.push(`Vectorize upsert error at ${i}: ${error.message}`);
      }
    }
  }

  return new Response(
    JSON.stringify({
      inserted,
      vectorized,
      errors: errors.length > 0 ? errors : undefined,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// ═══ AUTH ═══

function checkAuth(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth) return false;
  const token = auth.replace("Bearer ", "");
  return token === env.API_KEY;
}

function checkPathAuth(url, env) {
  if (!url.pathname.startsWith("/mcp/")) return false;
  const pathToken = url.pathname.slice(5);
  return pathToken.length > 0 && pathToken === env.API_KEY;
}

// ═══ MCP HANDLER ═══

async function handleMCPRequest(request, env) {
  const body = await request.json();
  const { method, params = {}, id } = body;
  let result;

  try {
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "archive-search", version: "1.0.0" },
        };
        break;

      case "tools/list":
        result = { tools: TOOLS };
        break;

      case "tools/call": {
        const toolName = params.name;
        const toolParams = params.arguments || {};

        switch (toolName) {
          case "search_archive":
            result = {
              content: [{ type: "text", text: await handleSearchArchive(env, toolParams) }],
            };
            break;
          case "get_archive_stats":
            result = {
              content: [{ type: "text", text: await handleGetStats(env) }],
            };
            break;
          case "repair_archive":
            result = {
              content: [{ type: "text", text: await handleRepairArchive(env, toolParams) }],
            };
            break;
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: String(error) },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
}

// ═══ MAIN FETCH HANDLER ═══

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "healthy" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // MCP endpoint — supports both /mcp with Bearer auth and /mcp/TOKEN path auth
    const hasPathAuth = checkPathAuth(url, env);
    if ((url.pathname === "/mcp" || hasPathAuth || url.pathname.startsWith("/mcp/")) && request.method === "POST") {
      if (!checkAuth(request, env) && !hasPathAuth) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32600, message: "Unauthorized" } }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return handleMCPRequest(request, env);
    }

    // Auth check for all other endpoints
    if (!checkAuth(request, env)) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Ingest endpoint
    if (url.pathname === "/ingest" && request.method === "POST") {
      return handleIngest(request, env);
    }

    // Stats (HTTP, not MCP)
    if (url.pathname === "/stats" && request.method === "GET") {
      const stats = await handleGetStats(env);
      return new Response(JSON.stringify({ text: stats }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Archive Search v1.0", {
      headers: { "Content-Type": "text/plain", ...corsHeaders },
    });
  },
};
