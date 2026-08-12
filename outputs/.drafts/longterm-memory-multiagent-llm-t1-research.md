# T1 – Architectures & Mechanisms for Long‑Term Memory in Multi‑Agent LLM Systems (2022‑2026)

## Overview
This note summarizes the main architectural approaches for integrating persistent memory into multi‑agent LLM harnesses, based on recent literature (2022‑2026) and technical reports.

### 1. Retrieval‑Augmented Generation (RAG) & Vector Stores
* Agents store episodic interactions in a external vector database (e.g., FAISS, Milvus) and retrieve relevant chunks at inference time.
* **Key papers:**
  * *Evolving Large Language Model Assistant with Long‑Term Conditional Memory* (arXiv:2312.17257) – describes a conditional memory module that indexes dialogue turns and retrieves them via semantic similarity.
  * *LongMemEval* (arXiv:2410.10813) – benchmark for RAG‑based agents.
* Strengths: scalable, language‑agnostic, low token overhead (retrieved chunks are short).
* Weaknesses: latency of external DB calls; requires careful chunking to avoid token overflow.

### 2. Structured Procedural Memory (LEGOMem, MemClaw)
* Procedural memory units capture reusable task trajectories, allowing agents to replay or adapt past plans.
* **Key sources:**
  * *LEGOMem: Modular Procedural Memory for Multi‑agent LLM Systems for Workflow Automation* (Microsoft Research, 2026) – introduces modular memory units linked to orchestrator steps.
  * *MemClaw* integration page (https://memclaw.net/docs/integrations/langchain) – provides a LangChain‑compatible API for storing procedural memory.
* Benefits: supports planning across long horizons, improves consistency.
* Limits: higher complexity; memory units must be explicitly defined.

### 3. Self‑Controlled Memory (SCM) & Memory Streams
* Agents maintain an internal “memory stream” where each turn appends a compact representation (e.g., dense embedding) that can be sampled later.
* **Key papers:**
  * *Enhancing Large Language Model with Self‑Controlled Memory Framework* (arXiv:2304.13343) – introduces a memory stream that can be queried with attention‑like mechanisms.
  * *RecallM* (arXiv:2307.02738) – adaptive memory that balances long‑term retention vs. recent context.
* Advantages: tightly integrated, no external DB latency.
* Drawbacks: memory grows linearly with token count; requires summarisation to stay within context window.

### 4. Hierarchical Memory Trees (MemTree, HiAgent)
* Memory is organised as a tree of aggregated nodes, enabling multi‑level retrieval (coarse‑to‑fine).
* **Key sources:**
  * *From Isolated Conversations to Hierarchical Schemas: Dynamic Tree Memory Representation for LLMs* (arXiv:2410.14052).
  * *HiAgent: Hierarchical Working Memory Management for Solving Long‑Horizon Agent Tasks* (ACL 2025) – demonstrates hierarchical working memory for complex tasks.
* Provides efficient token usage by retrieving only high‑level summaries unless deeper detail is needed.

### 5. Graph‑Based Knowledge Stores (Graphiti, Mem0)
* Store facts as nodes/edges; agents traverse the graph to retrieve relational information.
* **Key source:** *Cost and accuracy of long‑term graph memory in distributed LLM‑based multi‑agent systems* (arXiv:2601.07978).
* Enables structured queries, but graph traversal can be expensive if not cached.

## Open Issues (2022‑2026)
* **Consistency vs. Freshness:** How to keep memory consistent when agents concurrently update shared stores.
* **Token‑Cost Trade‑off:** Determining optimal chunk size/summarisation frequency to minimise token usage while preserving information.
* **Evaluation Standardisation:** Benchmarks such as LongMemEval and MemBench are emerging, but lack unified scoring across latency, cost, and quality.

## Sources
1. Evolving Large Language Model Assistant with Long‑Term Conditional Memory – https://arxiv.org/html/2312.17257v1
2. Enhancing Large Language Model with Self‑Controlled Memory Framework – https://arxiv.org/html/2304.13343
3. Augmenting Language Models with Long‑Term Memory – https://arxiv.org/html/2306.07174
4. LEGOMem: Modular Procedural Memory for Multi‑agent LLM Systems – https://doi.org/10.65109/vlua1303
5. MemClaw LangChain Integration – https://memclaw.net/docs/integrations/langchain
6. From Isolated Conversations to Hierarchical Schemas – https://arxiv.org/html/2410.14052
7. HiAgent: Hierarchical Working Memory Management – https://aclanthology.org/2025.acl-long.1575/
8. Cost and accuracy of long‑term graph memory – https://arxiv.org/html/2601.07978v1
