# Long‑Term Memory in Multi‑Agent LLM Systems (2022‑2026)

**Scope:** Survey of architectures, mechanisms, notable papers, and APIs for integrating long‑term memory into multi‑agent LLM systems. Covers works from 2022‑2026.

---

## Evidence Table

| # | Source | URL | Key claim | Type | Confidence |
|---|--------|-----|-----------|------|------------|
| 1 | LEGOMem: Modular Procedural Memory for Multi‑agent LLM Systems | https://www.microsoft.com/en-us/research/publication/legomem-modular-procedural-memory-for-multi-agent-llm-systems-for-workflow-automation/ | Introduces procedural memory units for orchestrators and agents; orchestrator memory improves task decomposition, agent memory improves execution accuracy. | primary | high |
| 2 | G‑Memory: Tracing Hierarchical Memory for Multi‑Agent Systems (NeurIPS 2025) | https://papers.neurips.cc/paper_files/paper/2025/hash/136a45cd9b841bf785625709a19c6508-Abstract-Conference.html | Proposes a three‑tier graph hierarchy (insight, query, interaction) for hierarchical memory; yields up to +20.89% success rate and +10.12% QA accuracy. | primary | high |
| 3 | Multi‑Agent Memory from a Computer‑Architecture Perspective (arXiv 2026) | https://arxiv.org/abs/2603.10062 | Defines shared vs. distributed memory paradigms, a three‑layer hierarchy (I/O, cache, memory), and highlights missing cache‑sharing and access‑control protocols. | primary | high |
| 4 | MemMA: Coordinating the Memory Cycle (Microsoft Research) | https://www.microsoft.com/en-us/research/publication/memma-coordinating-the-memory-cycle-through-multi-agent-reasoning-and-in-situ-self-evolution/ | Plug‑and‑play framework with Meta‑Thinker, Memory Manager, Query Reasoner; improves LoCoMo benchmark across LLM backbones. | primary | high |
| 5 | BMAM: Brain‑Inspired Multi‑Agent Memory Framework (alphaXiv 2026) | https://www.alphaxiv.org/abs/2601.20465 | Splits memory into episodic, semantic, salience‑aware, and control components; achieves 78.45% accuracy on LoCoMo. | primary | high |
| 6 | $\Sigma$‑Mem: Online Reliability Memory (arXiv 2026) | https://arxiv.org/abs/2607.27958 | Records competence evidence and peer‑relationship evidence for reliable routing in MAS; improves peer selection and OOD performance. | primary | high |
| 7 | MemMachine (open‑source) | https://github.com/MemMachine/MemMachine | Provides episodic, profile, and working memory types; integrations for LangChain, LangGraph, CrewAI, etc.; REST/MCP APIs for persistence. | primary | high |
| 8 | PlugMem (GitHub) | https://github.com/TIMAN-group/PlugMem | Plug‑and‑play memory with semantic, procedural, episodic stores; SOTA on LongMemEval (90.2% acc) and HotpotQA; integrates via plugins for OpenClaw/Claude Code. | primary | high |
| 9 | OpenMemory (GitHub) | https://github.com/caviraOSS/OpenMemory | Cognitive memory engine with multi‑sector stores (episodic, semantic, procedural, emotional, reflective), temporal KG, and MCP/SDK APIs. | primary | high |
|10| agent‑memory (GitHub) | https://github.com/reaatech/agent-memory | Managed long‑term memory layer with extraction, decay, forgetting, and contradiction resolution; TypeScript SDK for multi‑agent pipelines. | primary | high |
|11| LangChain + MemClaw integration | https://memclaw.net/docs/integrations/langchain | Defines `memclaw_write` / `memclaw_recall` tools; MCP‑native and REST endpoints (`POST /api/v1/memories`, `POST /api/v1/recall`). | secondary | high |
|12| pgmnemo LangChain adapter | https://raw.githubusercontent.com/pgmnemo/pgmnemo/main/integrations/langchain/README.md | PostgreSQL‑native memory substrate with `PgmnemoRetriever`; supports custom embedding functions. | secondary | high |
|13| RetainDB LangChain adapter | https://www.retaindb.com/docs/sdk/langchain-adapter | Provides `createLangChainMemoryAdapter`; stores memories with extraction pipelines; token‑efficient recall. | secondary | high |

---

## Findings

### 1️⃣ Architectural Paradigms

* **Shared vs. Distributed Memory** – The arXiv **Multi‑Agent Memory** paper (2026) formalises two paradigms. Shared memory (e.g., a central vector store) simplifies knowledge reuse but requires coherence protocols; distributed memory (local per‑agent stores) improves isolation but needs explicit synchronization. [3]
* **Memory Hierarchies** – The same paper proposes a three‑layer hierarchy (I/O, cache, long‑term memory). This mirrors classic computer‑architecture concepts and guides the design of cache‑sharing mechanisms that many recent systems lack. [3]
* **Procedural / Hierarchical Memory** – **LEGOMem** (2025) introduces *procedural memory units* that encode reusable task trajectories. Experiments show that placing memory at the orchestrator level is crucial for effective task decomposition. [1]
* **Hierarchical Graph Memory** – **G‑Memory** (NeurIPS 2025) builds a three‑tier graph (insight → query → interaction) enabling bi‑directional traversal for high‑level insights and fine‑grained interaction traces. Reported gains up to **+20.89 %** success rate on embodied tasks. [2]
* **Brain‑Inspired Subsystems** – **BMAM** (2026) decomposes memory into *episodic, semantic, salience‑aware, and control* subsystems, each operating at different timescales. Timeline‑indexed episodic store yields **78.45 %** accuracy on the LoCoMo benchmark. [5]
* **Reliability‑Oriented Memory** – **$\Sigma$‑Mem** (2026) records competence evidence per peer and relational evidence across peers, enabling adaptive routing and voting in multi‑agent ensembles. Demonstrated improvements across Qwen‑family models. [6]

### 2️⃣ Mechanisms & Techniques

| Mechanism | Representative Work | Core Idea |
|---|---|---|
| **Procedural Memory Units** | LEGOMem [1] | Store reusable task trajectories; allocate across orchestrators/agents. |
| **Graph‑Based Hierarchical Memory** | G‑Memory [2] | Insight/Query/Interaction graphs; bi‑directional traversal. |
| **Cache‑Sharing Protocols** | Multi‑Agent Memory (arXiv 2026) [3] | Explicit cache layer for fast, limited‑capacity retrieval across agents. |
| **Meta‑Thinker Guided Cycle** | MemMA [4] | Strategic guidance for memory construction and iterative retrieval. |
| **Multi‑Sector / Temporal KG** | OpenMemory [9] | Episodic, semantic, procedural, emotional, reflective sectors; temporal validity windows. |
| **Reliability Memory** | $\Sigma$‑Mem [6] | Stores competence matrices and peer‑relationship matrices; spectral‑bounded updates. |
| **Compression & Evolution** | PlugMem [8] | Compact knowledge units, graph‑based memory evolution, automatic compression. |

### 3️⃣ Open‑Source Implementations & APIs (2022‑2026)

| Library | Memory Model | Primary API | Integration Highlights |
|---|---|---|---|
| **MemMachine** | Episodic / Profile / Working | Python SDK (`MemMachineClient`), REST, MCP | Direct LangChain, LangGraph, CrewAI adapters; graph DB (Neo4j) + SQL backend. [7]
| **PlugMem** | Semantic / Procedural / Episodic (graph) | Python SDK, REST plugin, OpenClaw/Claude Code plugins | 6‑line init; SOTA on LongMemEval; visual Memory Inspector UI. [8]
| **OpenMemory** | Multi‑sector (episodic, semantic, procedural, emotional, reflective) + Temporal KG | Python & Node SDKs, HTTP API, MCP server | Full‑stack (SDK, server, dashboard) with explainable traces. [9]
| **agent‑memory** | Managed long‑term store with decay/forgetting | TypeScript SDK (`AgentMemory`) | Extraction via LLM, decay policies, contradiction resolution; pgvector storage. [10]
| **MemClaw** | Centralised key‑value memory (governed) | MCP tools (`memclaw_write`, `memclaw_recall`) and REST (`POST /api/v1/memories`, `POST /api/v1/recall`) | LangChain/MCP adapters; per‑agent scoping & audit logs. [11]
| **pgmnemo** | PostgreSQL‑native vector store | `PgmnemoRetriever` (LangChain) | Leverages `pgvector`; custom embedding function; suitable for multi‑agent setups. [12]
| **RetainDB** | Persistent memory with extraction pipeline | `createLangChainMemoryAdapter` (JS/TS) | Automatic fact extraction, session scoping, token‑frugal retrieval. [13]

### 4️⃣ Token‑Efficiency Strategies (2022‑2026)

* **Cache‑Layer Retrieval** – The cache layer described in the arXiv memory hierarchy reduces full‑vector searches by first consulting a small, recent cache before falling back to the larger store. [3]
* **Memory Compression** – PlugMem automatically merges redundant nodes, reducing the number of retrieved chunks per turn and cutting token usage. [8]
* **Selective Extraction** – MemMA’s *Meta‑Thinker* guides what should be stored, avoiding noisy embeddings. [4]
* **Sector‑Specific Decay** – OpenMemory’s decay engine prunes low‑salience episodic entries while preserving high‑value semantic facts, keeping the retrieval set compact. [9]
* **Hybrid Retrieval (semantic + temporal)** – BMAM fuses lexical, dense, knowledge‑graph, and temporal signals, allowing a focused shortlist of relevant memories. [5]

### 5️⃣ Benchmarks & Evaluation (2022‑2026)

* **LoCoMo** – Multi‑agent coordination benchmark used by MemMA (2026) and BMAM (2026) to report accuracy gains. [4, 5]
* **LongMemEval** – Long‑horizon memory evaluation where **PlugMem** achieved **90.2 %** accuracy (2026). [8]
* **HotpotQA (multi‑hop)** – PlugMem reported **79.1 F1 / 91.1 %** LLM‑Judge accuracy (2026). [8]
* **Embodied Action Benchmarks** – G‑Memory reported up to **+20.89 %** success rate across five benchmarks (2025). [2]

---

## Coverage Status

- **Directly inspected** : LEGOMem, G‑Memory, Multi‑Agent Memory (arXiv), MemMA, BMAM, $\Sigma$‑Mem, MemMachine README, PlugMem README, OpenMemory README, agent‑memory README, MemClaw integration page, pgmnemo LangChain adapter, RetainDB LangChain adapter.
- **Remaining uncertainties** : Full evaluation details for some papers (e.g., exact dataset splits for BMAM) are not present in the abstract; deeper code‑level APIs for MemMA need repository cloning for verification.
- **Tasks completed** : Collected ≥13 sources, extracted key claims, produced evidence table, synthesized findings, listed APIs, and wrote the artifact to the required output path.

---

## Sources

1. **LEGOMem: Modular Procedural Memory for Multi‑agent LLM Systems for Workflow Automation** – Microsoft Research. https://www.microsoft.com/en-us/research/publication/legomem-modular-procedural-memory-for-multi-agent-llm-systems-for-workflow-automation/
2. **G‑Memory: Tracing Hierarchical Memory for Multi‑Agent Systems** – NeurIPS 2025. https://papers.neurips.cc/paper_files/paper/2025/hash/136a45cd9b841bf785625709a19c6508-Abstract-Conference.html
3. **Multi‑Agent Memory from a Computer‑Architecture Perspective** – arXiv 2026. https://arxiv.org/abs/2603.10062
4. **MemMA: Coordinating the Memory Cycle through Multi‑Agent Reasoning and In‑Situ Self‑Evolution** – Microsoft Research. https://www.microsoft.com/en-us/research/publication/memma-coordinating-the-memory-cycle-through-multi-agent-reasoning-and-in-situ-self-evolution/
5. **BMAM: Brain‑Inspired Multi‑Agent Memory Framework** – alphaXiv 2026. https://www.alphaxiv.org/abs/2601.20465
6. **$\Sigma$‑Mem: An Online Reliability Memory for LLM‑based Multi‑Agent Systems** – arXiv 2026. https://arxiv.org/abs/2607.27958
7. **MemMachine – Open‑source long‑term memory layer** – GitHub. https://github.com/MemMachine/MemMachine
8. **PlugMem – Task‑agnostic plugin memory module** – GitHub. https://github.com/TIMAN-group/PlugMem
9. **OpenMemory – Cognitive memory engine** – GitHub. https://github.com/caviraOSS/OpenMemory
10. **agent‑memory – Managed long‑term memory for AI agents** – GitHub. https://github.com/reaatech/agent-memory
11. **MemClaw LangChain integration** – MemClaw docs. https://memclaw.net/docs/integrations/langchain
12. **pgmnemo LangChain adapter** – GitHub RAW. https://raw.githubusercontent.com/pgmnemo/pgmnemo/main/integrations/langchain/README.md
13. **RetainDB LangChain adapter** – RetainDB docs. https://www.retaindb.com/docs/sdk/langchain-adapter

---

*Prepared by the evidence‑gathering subagent for task T1.*
