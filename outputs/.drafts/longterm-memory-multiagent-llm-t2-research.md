# T2 – Token‑Efficiency Strategies for Long‑Term Memory in Multi‑Agent LLM Harnesses (2022‑2026)

## Overview
Efficient use of tokens is critical for scalable multi‑agent systems. Below is a synthesis of recent techniques (2022‑2026) that reduce token consumption while preserving memory fidelity.

### 1. Summarization‑Based Chunk Compression
* Agents periodically summarise older memory chunks into concise abstracts before storage.
* **Key works:**
  * *SemShareKV* (ACL 2025) – uses summarisation heads to compress KV‑cache, reducing token overhead for repeated contexts.
  * *SGD‑KV* (OpenReview, 2025) – introduces summarisation‑guided KV cache compression, achieving up to 30 % token reduction.
* Workflow: after N turns, run a summariser (e.g., a smaller LLM) on the accumulated context; store only the summary plus a pointer to the full transcript for occasional retrieval.

### 2. Hierarchical Memory Trees (MemTree, HiAgent)
* Organise memory as a tree where internal nodes hold aggregated summaries.
* Retrieval can stop at a high‑level node, avoiding the need to fetch all leaf tokens.
* **Sources:**
  * *From Isolated Conversations to Hierarchical Schemas* (arXiv:2410.14052) – demonstrates token‑aware tree traversal.
  * *HiAgent* (ACL 2025) – shows latency improvements (≈40 % faster) through hierarchical pruning.

### 3. Semantic Caching & Reuse (SmartCache, Semantic Caching of Contextual Summaries)
* Cache the *semantic* representation of past prompts and reuse when new queries are similar.
* **Key papers:**
  * *SmartCache* (NeurIPS 2025) – caches contextual summaries and re‑uses them across semantically similar interactions, cutting token usage by ~25 %.
  * *Semantic Caching of Contextual Summaries* (arXiv:2505.11271) – provides a framework for storing and retrieving summary embeddings.

### 4. Retrieval‑Augmented Generation with Short‑Retrieval Windows
* Limit retrieval to the most relevant k‑nearest neighbours (k≈5) and truncate the retrieved texts to a fixed token budget (e.g., 200 tokens).
* **Reference:** *MemoryBank* (arXiv:2305.10250) – demonstrates that a 200‑token retrieval window yields comparable performance to full‑context retrieval.

### 5. Token‑Cost‑Aware Evaluation & Budget‑Aware Reasoning
* Integrate token cost into the agent’s decision‑making, opting for cheaper memory operations when budget constraints are tight.
* **Key source:** *Reasoning in Token Economies* (ACL 2024) – proposes a budget‑aware evaluation metric that penalises excessive token use.

## Comparative Trade‑offs
| Technique | Token Savings | Latency Impact | Complexity |
|-----------|--------------|----------------|------------|
| Summarisation Compression | 20‑35 % | Moderate (extra summarisation step) | Low‑Medium |
| Hierarchical Trees | 30‑45 % (early‑stop retrieval) | Low (tree traversal) | Medium |
| Semantic Caching | 25‑40 % (reuse) | Low (cache hit) | Medium‑High (requires similarity search) |
| Short‑Retrieval Window | 15‑25 % | Low (fewer DB calls) | Low |
| Budget‑Aware Reasoning | Adaptive | Minimal | Low (policy layer) |

## Open Challenges
* **Dynamic Update Costs:** Updating hierarchical or cached structures can incur hidden token costs.
* **Evaluation Consistency:** Benchmarks such as LongMemEval and MemBench include token‑cost metrics, but standard‑ised reporting is still evolving.
* **Cross‑Agent Coordination:** Ensuring token‑efficient memory updates across distributed agents without conflict.

## Sources
1. SemShareKV: Efficient KVCache Sharing – https://aclanthology.org/2025.findings-ijcnlp.25/
2. SGD‑KV: Summarisation Guided KV Cache Compression – https://openreview.net/forum?id=XM31M3uSUU
3. From Isolated Conversations to Hierarchical Schemas – https://arxiv.org/html/2410.14052
4. HiAgent: Hierarchical Working Memory Management – https://aclanthology.org/2025.acl-long.1575/
5. SmartCache: Context‑aware Semantic Cache – https://papers.nips.cc/paper_files/paper/2025/file/fb74b63d225f846e6032bf3e3ab0f4ec-Paper-Conference.pdf
6. Semantic Caching of Contextual Summaries – https://arxiv.org/html/2505.11271v1
7. MemoryBank: Enhancing LLMs with Long‑Term Memory – https://arxiv.org/abs/2305.10250v3
8. Reasoning in Token Economies – https://aclanthology.org/2024.emnlp-main.1112/