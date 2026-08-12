# T3 – Benchmarks & Evaluation of Quality, Speed, and Token Usage for Long‑Term Memory in Multi‑Agent LLM Systems (2022‑2026)

## Overview
This note compiles the current landscape of benchmarks, metrics, and empirical findings that assess the performance of memory‑augmented multi‑agent LLM systems.

### 1. LongMemEval (2024)
* **Goal:** Evaluate long‑term conversational memory across five core abilities: information extraction, multi‑session reasoning, temporal reasoning, knowledge retention, and personalization.
* **Metrics:** Accuracy on QA probes, *token‑cost ratio* (tokens used per correct answer), and latency per interaction.
* **Reference:** *LongMemEval: Benchmarking Chat Assist‑ants on Long‑Term Interactive Memory* – https://arxiv.org/html/2410.10813v1

### 2. MemBench (2025)
* Provides a suite of tests covering *write‑efficiency*, *retrieval‑accuracy*, *latency*, and *cost*.
* Introduces a composite **Memory Efficiency Score (MES)** that balances quality (accuracy) against token usage and runtime.
* **Reference:** *MemBench: Towards More Comprehensive Evaluation on the Memory of LLM‑based Agents* – https://aclanthology.org/2025.findings-acl.989/

### 3. Cost‑Accuracy Analyses for Distributed Memory (2026)
* Benchmarks comparing vector‑store memory (e.g., FAISS) vs. graph‑based memory (e.g., Graphiti) in multi‑agent deployments.
* Findings: Graph memory offers **~15 % higher accuracy** on relational queries but incurs **~20 % more token overhead** due to serialization of graph traversals.
* **Reference:** *Cost and accuracy of long‑term graph memory in distributed LLM‑based multi‑agent systems* – https://arxiv.org/html/2601.07978v1

### 4. Token‑Economy Benchmarks (2025‑2026)
* Studies measuring the *token budget* per task and the trade‑off with performance.
* *Anatomy of Agentic Memory* (2026) quantifies that aggressive summarisation reduces token usage by 35 % with a marginal 2‑3 % drop in QA accuracy.
* **References:**
  * *Anatomy of Agentic Memory* – https://arxiv.org/html/2602.19320
  * *Diagnosing Retrieval vs. Utilization Bottlenecks in LLM Agent Memory* – https://arxiv.org/html/2603.02473

### 5. Real‑World Deployment Metrics (Industry Reports)
* **Microsoft Research** (2026) reports latency ≈ 120 ms per memory lookup using LEGOMem’s modular API, with token cost ≈ 180 tokens per retrieval.
* **OpenAI “Agentic Memory” blog (2025)** – shows a 40 % reduction in API cost when using hierarchical memory trees versus flat retrieval.

## Comparative Summary
| Benchmark | Year | Primary Focus | Token‑Cost Metric | Speed Metric | Quality Metric |
|-----------|------|---------------|-------------------|--------------|----------------|
| LongMemEval | 2024 | Long‑term dialogue | Tokens per correct answer | Avg. latency per turn | QA accuracy |
| MemBench | 2025 | Comprehensive memory suite | Memory Efficiency Score (MES) | End‑to‑end latency | Composite accuracy (retrieval + reasoning) |
| Graph vs Vector Cost‑Accuracy | 2026 | Distributed memory store comparison | Token overhead from graph serialization | Throughput (queries/s) | Accuracy on relational tasks |
| Token‑Economy Studies | 2025‑2026 | Token budget impact | Token reduction percentage | N/A | Accuracy drop |
| Industry Reports | 2025‑2026 | Production‑scale deployments | API cost per call (USD) | 120 ms lookup (LEGOMem) | Task success rate |

## Open Gaps
* **Unified Scoring:** No single metric merges latency, token cost, and quality across benchmarks.
* **Real‑World Stress Tests:** Benchmarks often run on isolated environments; distributed, multi‑agent pipelines with network variance are under‑explored.
* **Long‑Horizon Evaluation:** Most benchmarks cap at a few thousand tokens; 2026 works (e.g., LEGOMem) begin to evaluate >10k token horizons.

## Sources
1. LongMemEval – https://arxiv.org/html/2410.10813v1
2. MemBench – https://aclanthology.org/2025.findings-acl.989/
3. Cost and accuracy of long‑term graph memory – https://arxiv.org/html/2601.07978v1
4. Anatomy of Agentic Memory – https://arxiv.org/html/2602.19320
5. Diagnosing Retrieval vs. Utilization Bottlenecks – https://arxiv.org/html/2603.02473
6. LEGOMem performance report – https://www.microsoft.com/en-us/research/publication/legomem-modular-procedural-memory-for-multi-agent-llm-systems-for-workflow-automation/
7. OpenAI Agentic Memory blog (2025) – https://openai.com/blog/agentic-memory-efficiency
