#!/usr/bin/env node
// Archive Search - Migration Script
// Reads markdown conversation files, chunks them, and uploads to the Worker

const fs = require("fs");
const path = require("path");

// Configuration
const VAULT_PATH = process.env.VAULT_PATH;
const WORKER_URL = process.env.WORKER_URL;
const API_KEY = process.env.API_KEY;

if (!VAULT_PATH || !WORKER_URL || !API_KEY) {
  console.error("Required environment variables:");
  console.error("  VAULT_PATH  - Path to markdown conversation files");
  console.error("  WORKER_URL  - Deployed worker URL (e.g. https://archive-search.your-domain.workers.dev)");
  console.error("  API_KEY     - API key matching your wrangler.toml");
  console.error("\nExample:");
  console.error('  VAULT_PATH="./conversations" WORKER_URL="https://archive-search.example.workers.dev" API_KEY="your-key" node scripts/migrate.js');
  process.exit(1);
}
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;
const BATCH_SIZE = 10; // chunks per request (keep small for embedding limits)

// ═══ CHUNKING ═══

function chunkText(text) {
  if (text.length <= CHUNK_SIZE) return [text];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = start + CHUNK_SIZE;
    chunks.push(text.slice(start, end));
    start = end - CHUNK_OVERLAP;
    if (end >= text.length) break;
  }
  return chunks;
}

// ═══ FILE DISCOVERY ═══

function findMarkdownFiles(dir) {
  const files = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  }
  walk(dir);
  return files;
}

// ═══ ERA DETECTION ═══

function detectEra(relativePath) {
  // Extract year/month from path structure like chatgpt/2025/07/filename.md
  const parts = relativePath.split(path.sep);
  if (parts.length >= 3) {
    const year = parts.find((p) => /^20\d{2}$/.test(p));
    const month = parts.find((p) => /^(0[1-9]|1[0-2])$/.test(p));
    if (year && month) return `${year}-${month}`;
    if (year) return year;
  }
  return null;
}

// ═══ MAIN ═══

async function main() {
  console.log("Archive Search - Migration Script");
  console.log("=".repeat(50));
  console.log(`Source: ${VAULT_PATH}`);
  console.log(`Target: ${WORKER_URL}`);
  console.log();

  if (!fs.existsSync(VAULT_PATH)) {
    console.error(`Error: VAULT_PATH does not exist: ${VAULT_PATH}`);
    process.exit(1);
  }

  // Find all markdown files
  const files = findMarkdownFiles(VAULT_PATH);
  console.log(`Found ${files.length} markdown files`);

  if (files.length === 0) {
    console.log("Nothing to index.");
    return;
  }

  // Process files
  let totalChunks = 0;
  let totalFiles = 0;
  let totalErrors = 0;
  let pendingChunks = [];

  async function flushBatch() {
    if (pendingChunks.length === 0) return;

    const batch = pendingChunks.splice(0, BATCH_SIZE);

    try {
      const response = await fetch(`${WORKER_URL}/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ chunks: batch }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`  Ingest error (${response.status}): ${text}`);
        totalErrors += batch.length;
        return;
      }

      const result = await response.json();
      if (result.errors && result.errors.length > 0) {
        console.error(`  Partial errors: ${result.errors.length}`);
        totalErrors += result.errors.length;
      }
    } catch (error) {
      console.error(`  Network error: ${error.message}`);
      totalErrors += batch.length;
    }
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const relativePath = path.relative(VAULT_PATH, file);

    try {
      const content = fs.readFileSync(file, "utf-8");
      if (!content.trim()) continue;

      const chunks = chunkText(content);
      const era = detectEra(relativePath);
      const title = path.basename(file, ".md");

      for (let j = 0; j < chunks.length; j++) {
        pendingChunks.push({
          source_file: relativePath,
          chunk_index: j,
          total_chunks: chunks.length,
          content: chunks[j],
          era: era,
          conversation_title: title,
        });
      }

      totalChunks += chunks.length;
      totalFiles++;

      // Flush when we have enough
      while (pendingChunks.length >= BATCH_SIZE) {
        await flushBatch();
      }

      if ((i + 1) % 25 === 0) {
        console.log(`Processed: ${i + 1}/${files.length} files (${totalChunks} chunks)`);
      }
    } catch (error) {
      console.error(`Error reading ${relativePath}: ${error.message}`);
      totalErrors++;
    }
  }

  // Flush remaining
  while (pendingChunks.length > 0) {
    await flushBatch();
  }

  console.log();
  console.log("=".repeat(50));
  console.log(`Migration complete!`);
  console.log(`Files processed: ${totalFiles}`);
  console.log(`Total chunks: ${totalChunks}`);
  if (totalErrors > 0) console.log(`Errors: ${totalErrors}`);
}

main().catch(console.error);
