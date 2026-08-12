# Harness Memory Research: Agentic Software Development Tools (2024–2026)

**Search queries used:**
1. "AI coding assistant long-term memory retrieval-augmented generation 2024 2025" (recency: year)

**Sources retrieved:**
1. agentmemory (Rust, MCP, hybrid search, multi-tool support)  
2. Alaz (Rust, auto-learning from transcripts, git-aware, dual LLM backend)  
3. agent-knowledge (git-synced markdown vault, TF-IDF session search, LongMemEval benchmark)  
4. MAG (Rust, cross-tool unified memory via MCP, hybrid retrieval)  
5. devmemory-mcp (ChromaDB + Sentence Transformers, file-level binding)  
6. PlugMem (ICML 2026, memory graphs, agent plugins for coding assistants)  
7. Claude-Mem (Claude Code plugin, automatic session capture and injection)  
8. PMB (SQLite + LanceDB, hooks for auto-recall/writing, multilingual)  
9. recall-echo (Rust, three-layer memory, confidence scoring)  
10. Memory for Autonomous LLM Agents survey (arXiV 2026)

**Common patterns in agentic development harnesses:**

1. **Local-first persistence**
   - SQLite is the dominant storage engine (MAG, PMB, Alaz, agentmemory).
   - Emphasis on zero cloud, no API keys, data stays on device.
   - Rebuildable vector indexes (LanceDB, ChromaDB) alongside durable stores.

2. **MCP (Model Context Protocol) as standard interface**
   - Almost all tools expose an MCP server: agentmemory, MAG, devmemory-mcp, PMB, recall-echo.
   - Auto-wiring via `mag setup`, `pmb connect`, `agentmemory connect` for Claude Code, Cursor, Codex, etc.
   - Bridges multiple tools with one memory store.

3. **Hybrid retrieval (semantic + lexical + graph)**
   - Semantic embeddings (ONNX or SentenceTransformers) paired with BM25/TF-IDF.
   - Fusion via Reciprocal Rank Fusion or learned weights.
   - Optional cross-encoder reranking.

4. **Automatic capture and extraction**
   - Hooks at tool-use or session boundaries to capture actions without explicit agent calls.
   - Post-session automatic learning: parse transcripts, extract patterns/episodes/procedures.
   - Git-aware ingestion of diffs (Alaz, agent-knowledge).

5. **Conflict detection and deduplication**
   - similarity-based dedup (cosine 0.92 auto-merge, 0.80-0.92 LLM verify).
   - Superseding outdated knowledge with grace periods.
   - Confidence scoring that decays with contradictions.

6. **Latency budgets**
   - Tools aim for sub-100ms recall (PMB: 35-110 ms warm; MAG: single-digit ms for most operations).
   - Fire-and-forget writes to avoid blocking the agent.
   - Warmup strategies to cold-start embedding models.

7. **Benchmarks and metrics**
   - agent-knowledge reports LongMemEval results (R@5 = 97.2% sparse / 98.8% hybrid).
   - PlugMem reports SOTA on LongMemEval and HotpotQA (90.2 Acc, 79.1 F1).
   - PMB reports LoCoMo recall@10 = 94.5%.

8. **Multi-tool, cross-session, multilingual support**
   - Single memory store across Claude Code, Cursor, Codex, etc.
   - Multilingual embeddings support out-of-the-box.
   - Session restore and narrative arcs.

9. **Structured memory types**
   - Patterns, episodes, procedures, core memories, reflections (Alaz).
   - Project context, lessons, recent activity, open goals, active arcs (PMB).
   - Knowledge graphs and memory trees (PlugMem).

10. **Privacy and security**
    - Secrets scrubbing on ingestion.
    - Zero third-party routing by default.
    - SQLite as durable source of truth owned by user.