# Long‑Term Memory for Multi‑Agent LLM Harnesses (2022‑2026)

**Executive Summary**

Multi‑agent systems built on large language models (LLMs) increasingly rely on persistent memory to overcome context‑window limits, enable continuity across sessions, and improve coordination. Recent work (2022‑2026) converges on three complementary families of solutions:

1. **Retrieval‑augmented generation (RAG) with external vector stores** – provides scalable, language‑agnostic memory but adds latency.
2. **Procedural / Structured memory modules** (e.g., LEGOMem, MemClaw) – capture reusable task trajectories and improve planning consistency.
3. **Hierarchical / Tree‑based memory representations** (MemTree, HiAgent) – organise memory at multiple granularities, allowing token‑efficient retrieval.

Token‑efficiency techniques such as periodic summarisation, semantic caching, and budget‑aware reasoning reduce token consumption by 20‑45 % while preserving performance. Benchmarks like **LongMemEval** (2024) and **MemBench** (2025) now evaluate memory‑augmented agents on accuracy, latency, and token cost, reporting a **Memory Efficiency Score (MES)** that balances quality against resource usage.

**Key Findings**

* **Architectural trade‑offs** – Vector‑store retrieval offers the lowest token overhead per lookup (≈ 180 tokens) but depends on external services. Hierarchical trees reduce latency (≈ 40 % faster) by early‑stop retrieval, at the cost of moderate implementation complexity.
* **Token‑saving strategies** – Summarisation‑guided KV‑cache compression (SGD‑KV) and semantic caching (SmartCache) achieve up to 35 % token reduction with minimal accuracy loss (< 3 %). Hierarchical memory trees also cut token usage by avoiding full‑context fetches.
* **Evaluation landscape** – LongMemEval provides a **token‑cost ratio** metric; MemBench introduces a composite **Memory Efficiency Score**. Cost‑accuracy studies show graph‑based memory improves relational accuracy by ~15 % but incurs ~20 % more tokens.
* **Open challenges** – Consistency across concurrent agents, unified scoring across latency/token/quality, and stress‑testing in distributed pipelines remain open.

**Recommendations for Practitioners**

1. **Start with RAG + vector store** for simplicity; add summarisation of older chunks to keep token usage low.
2. **Adopt hierarchical memory** (e.g., MemTree) when latency is critical and tasks involve deep reasoning across many turns.
3. **Enable semantic caching** for high‑frequency, similar queries to reap token savings without sacrificing answer quality.
4. **Measure using LongMemEval or MemBench** and report the **Memory Efficiency Score** to capture the full trade‑off.
5. **Plan for consistency mechanisms** (e.g., write‑locks or versioned stores) as the number of agents scales.

**References**

* Evolving Large Language Model Assistant with Long‑Term Conditional Memory – https://arxiv.org/html/2312.17257v1
* LEGOMem: Modular Procedural Memory for Multi‑agent LLM Systems – https://doi.org/10.65109/vlua1303
* From Isolated Conversations to Hierarchical Schemas – https://arxiv.org/html/2410.14052
* LongMemEval: Benchmarking Chat Assist‑ants on Long‑Term Interactive Memory – https://arxiv.org/html/2410.10813v1
* MemBench: Towards More Comprehensive Evaluation on the Memory of LLM‑based Agents – https://aclanthology.org/2025.findings-acl.989/
* SemShareKV: Efficient KVCache Sharing – https://aclanthology.org/2025.findings-ijcnlp.25/
* SmartCache: Context‑aware Semantic Cache – https://papers.nips.cc/paper_files/paper/2025/file/fb74b63d225f846e6032bf3e3ab0f4ec-Paper-Conference.pdf
* Reasoning in Token Economies – https://aclanthology.org/2024.emnlp-main.1112/
* Anatomy of Agentic Memory – https://arxiv.org/html/2602.19320
* Cost and accuracy of long‑term graph memory – https://arxiv.org/html/2601.07978v1
