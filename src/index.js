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

// ═══ EMBEDDING ═══

async function getEmbedding(ai, text) {
  const result = await ai.run("@cf/baai/bge-base-en-v1.5", { text: [text] });
  return result.data[0];
}

// ═══ TOOL HANDLERS ═══

async function handleSearchArchive(env, params) {
  const query = params.query;
  const nResults = Math.min(Math.max(params.n_results || 5, 1), 20);

  if (!query) return "Error: query parameter required";

  try {
    // Generate query embedding
    const embedding = await getEmbedding(env.AI, query);

    // Search Vectorize
    const vectorResults = await env.VECTORS.query(embedding, {
      topK: nResults,
      returnMetadata: "all",
    });

    let results = [];

    if (vectorResults.matches && vectorResults.matches.length > 0) {
      // Fetch full content from D1 for each match
      for (const match of vectorResults.matches) {
        const chunkId = match.id.replace("chunk-", "");
        const row = await env.DB.prepare(
          "SELECT source_file, content, chunk_index FROM archive_chunks WHERE id = ?"
        )
          .bind(chunkId)
          .first();

        if (row) {
          results.push({
            source_file: row.source_file,
            text: row.content,
            relevance: match.score,
            chunk_index: row.chunk_index,
          });
        }
      }
    }

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
      output += `Source: ${r.source_file}\n\n`;
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
  const batchSize = Math.min(Math.max(params.batch_size || 50, 1), 200);

  try {
    // Get all chunk IDs from D1
    const allChunks = await env.DB.prepare(
      "SELECT id, content, source_file, chunk_index FROM archive_chunks ORDER BY id"
    ).all();

    if (!allChunks.results || allChunks.results.length === 0) {
      return "No chunks in database. Nothing to repair.";
    }

    // Check which ones have vectors by trying to fetch them
    const missing = [];
    for (const chunk of allChunks.results) {
      const vectorId = `chunk-${chunk.id}`;
      try {
        const result = await env.VECTORS.getByIds([vectorId]);
        if (!result || result.length === 0) {
          missing.push(chunk);
        }
      } catch {
        missing.push(chunk);
      }
    }

    if (missing.length === 0) {
      return `All ${allChunks.results.length} chunks have vectors. Nothing to repair.`;
    }

    // Process missing chunks in batches
    const toProcess = missing.slice(0, batchSize);
    let repaired = 0;
    const errors = [];

    for (let i = 0; i < toProcess.length; i += 10) {
      const batch = toProcess.slice(i, i + 10);
      const vectors = [];

      for (const chunk of batch) {
        try {
          const embedding = await getEmbedding(env.AI, chunk.content.slice(0, 8000));
          vectors.push({
            id: `chunk-${chunk.id}`,
            values: embedding,
            metadata: {
              source_file: chunk.source_file,
              chunk_index: chunk.chunk_index,
              preview: chunk.content.slice(0, 200),
            },
          });
        } catch (error) {
          errors.push(`${chunk.source_file}[${chunk.chunk_index}]: ${error.message}`);
        }
      }

      if (vectors.length > 0) {
        try {
          await env.VECTORS.upsert(vectors);
          repaired += vectors.length;
        } catch (error) {
          errors.push(`Upsert error: ${error.message}`);
        }
      }
    }

    let output = `Repair complete.\n`;
    output += `Total chunks in DB: ${allChunks.results.length}\n`;
    output += `Missing vectors found: ${missing.length}\n`;
    output += `Repaired this run: ${repaired}\n`;
    if (missing.length > batchSize) {
      output += `Remaining: ${missing.length - repaired} (run again to continue)\n`;
    }
    if (errors.length > 0) {
      output += `Errors: ${errors.length}\n`;
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

    for (const chunk of batch) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO archive_chunks (source_file, chunk_index, total_chunks, content, era, conversation_title)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          chunk.source_file,
          chunk.chunk_index,
          chunk.total_chunks || 1,
          chunk.content,
          chunk.era || null,
          chunk.conversation_title || null
        )
      );
    }

    try {
      const results = await env.DB.batch(stmts);
      // Get the inserted IDs
      for (let j = 0; j < results.length; j++) {
        const lastId = results[j].meta?.last_row_id;
        if (lastId) {
          inserted++;
          batch[j]._id = lastId;
        }
      }
    } catch (error) {
      errors.push(`D1 batch error at ${i}: ${error.message}`);
      continue;
    }
  }

  // Vectorize in batches of 100 (embedding + upsert)
  const toVectorize = chunks.filter((c) => c._id);
  for (let i = 0; i < toVectorize.length; i += 100) {
    const batch = toVectorize.slice(i, i + 100);
    const vectors = [];

    for (const chunk of batch) {
      try {
        const embedding = await getEmbedding(env.AI, chunk.content.slice(0, 8000));
        vectors.push({
          id: `chunk-${chunk._id}`,
          values: embedding,
          metadata: {
            source_file: chunk.source_file,
            chunk_index: chunk.chunk_index,
            preview: chunk.content.slice(0, 200),
          },
        });
      } catch (error) {
        errors.push(`Embedding error for ${chunk.source_file}[${chunk.chunk_index}]: ${error.message}`);
      }
    }

    if (vectors.length > 0) {
      try {
        await env.VECTORS.upsert(vectors);
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

    // Auth check for all other endpoints
    if (!checkAuth(request, env)) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // MCP endpoint
    if (url.pathname === "/mcp" && request.method === "POST") {
      return handleMCPRequest(request, env);
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
