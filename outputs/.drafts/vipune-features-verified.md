# Vipune Features Verified Against Documentation

**Sources:**
- README (fetched from GitHub, cloned path)
- docs/agent-integration.md (read from clone)

**Confirmed features:**

1. **Local SQLite storage**
   - `~/.vipune/memories.db` as default database
   - Configurable via `VIPUNE_DATABASE_PATH`
   - Zero cloud, no network dependencies for storage

2. **ONNX-based semantic embeddings**
   - Model: `BAAI/bge-small-en-v1.5` with pinned revision
   - Synchronous embedding generation
   - No API keys required

3. **Conflict detection**
   - Automatic warning on similar memories at `vipune add`
   - Configurable similarity threshold (default `0.85`)
   - Exit code `2` indicates conflicts detected
   - Supersede flag to replace outdated memories

4. **Single binary CLI**
   - Commands: `add`, `search`, `get`, `list`, `delete`, `update`, `validate`, `version`
   - Rust crate also available for programmatic integration
   - No daemon required

5. **MCP server subcommand**
   - `vipune mcp` exposes MCP tools: `store_memory`, `search_memories`, `list_memories`, `supersede_memory`, `get_memory`, `delete_memory`, `update_memory`
   - Configuration examples for Claude Code, Cursor, Claude Desktop
   - Environment variables supported (`VIPUNE_*`)

6. **Memory types and status**
   - Types: `fact`, `preference`, `procedure`, `guard`, `observation`
   - Status: `active` (default), `candidate`
   - Search filters by type and status

7. **Hybrid search**
   - Semantic + BM25 fusion (configurable via `VIPUNE_HYBRID`)
   - Recency weighting (default `0.3`; configurable via `VIPUNE_RECENCY_WEIGHT` or `--recency` flag)
   - Score formula: `(1 - recency_weight) * similarity + recency_weight * time_score`

8. **Project scoping**
   - Auto-detects git repository to scope memories
   - Configurable via `VIPUNE_PROJECT`
   - Memories isolated per project

9. **SKILL.md integration pattern**
   - Domain-specific skill artifact at `skills/vipune/SKILL.md`
   - Patterns for issue/PR linkage, failed-approach tracking, pre-flight gotchas, dev-loop mapping, ADR capture
   - Intended for Claude and Pi agents with skill auto-discovery

10. **Platform support**
    - macOS ARM64, Linux x86_64, Linux ARM64
    - Windows not supported (ONNX Runtime complexity)

**Not present in Vipune:**
- Hierarchical memory trees
- Graph-based storage
- Distributed synchronization
- Automatic session capture hooks (no UserPromptSubmit, PostToolUse, SessionStart, Stop hooks)
- Git-aware learning (no automatic diff ingestion)
- Benchmarks (no LongMemEval or other benchmark reports in docs)
- Automatic summarisation of older memories
- Multilingual support out-of-the-box (not mentioned; bge-small-en-v1.5 is English-centric)