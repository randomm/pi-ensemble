# Research Direct Notes: Vipune vs Long‑Term Memory Research

## Search Terms Used
1. "vipune github repository description"
2. "vipune semantic search memory features"
3. "vipune long term memory support"

## Findings
- **Core Functionality**: Vipune provides a minimal local semantic memory store with ONNX embeddings (bge‑small‑en‑v1.5) and conflict detection. It offers a CLI (`vipune add`, `vipune search`) and optional MCP server subcommand.
- **Alignment with Research**:
  * **Retrieval‑augmented generation (RAG)** – Vipune’s semantic search mirrors RAG’s external vector store retrieval, but is confined to a local SQLite store.
  * **Procedural Memory** – Vipune does not provide structured procedural memory modules (e.g., LEGOMem), focusing instead on flat memory entries.
  * **Hierarchical / Tree Memory** – No hierarchy; memories are stored as independent entries.
  * **Token‑Efficiency** – By handling embeddings locally, Vipune avoids external API token costs, aligning with token‑saving strategies (local embeddings, no remote calls).
- **Missing Features**:
  * No built‑in hierarchical summarisation or tree‑based aggregation.
  * No built‑in benchmarking suite or evaluation metrics (e.g., LongMemEval, MemBench).
  * No explicit support for distributed or graph‑based memory stores.
  * No automatic conflict resolution beyond duplicate warnings.
- **Integration**: Designed to be invoked by any agent via shell; requires configuration snippets for agents like Pi.

## Sources
1. GitHub repo home – https://github.com/randomm/vipune
2. README – https://github.com/randomm/vipune/blob/main/README.md
3. Cargo.toml – https://github.com/randomm/vipune/blob/main/Cargo.toml
4. Docs – agent integration – https://github.com/randomm/vipune/blob/main/docs/agent-integration.md
5. Rust docs – https://docs.rs/vipune/latest/vipune/
