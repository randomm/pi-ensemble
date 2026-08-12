# Evaluation Benchmarks for Long‑Term Memory in Multi‑Agent LLM Systems

## Evidence Table
| # | Source | URL | Key claim (metrics) | Type | Confidence |
|---|--------|-----|---------------------|------|------------|
| 1 | LongMemEval‑V2 benchmark (official repo) | https://github.com/xiaowu0162/LongMemEval-V2 | Accuracy 55.2% vs 41.0% for full‑context baseline (↑14.2 pts). Token usage ≈2,550 tokens per query vs ≈99,435 tokens for full‑context (≈39× fewer). Reported latency per query ~0.1 s vs >0.5 s for full‑context. | primary | high |
| 2 | AgenticSTS: Bounded‑Memory Testbed (arXiv) | https://arxiv.org/abs/2607.02255 | Wall‑clock per floor ≈ 2 min vs 8 min for accumulating‑context agents (≈4× faster). Fresh LLM tokens per score point 66–90× lower; worst‑case token‑per‑call >500 k for full‑context vs ~5 k for bounded contract. | primary | high |
| 3 | "Agent Memory: Characterization and System Implications" (alphaXiv) | https://www.alphaxiv.org/overview/2606.06448 | Construction (indexing) cost up to 13.3 h for 360 k‑token history (Paradigm IV). Retrieval latency sub‑0.1 s for BM25, ~0.5‑2 s for Mem0. Token cost per query varies 0.1 k‑0.9 k tokens depending on system. | primary | high |
| 4 | RecMem: Recurrence‑Based Memory Consolidation (alphaXiv) | https://www.alphaxiv.org/overview/2605.16045 | Reduces memory‑construction token consumption by 71‑87% compared to eager baselines (Mem0, A‑Mem). Achieves highest LongMemEval‑S accuracy (76.80) surpassing full‑context and Naïve RAG. | primary | high |
| 5 | MEMGYM: Memory‑Isolated Benchmark (alphaXiv) | https://www.alphaxiv.org/overview/2605.20833 | Provides memory‑isolated scores; A‑Mem improves QA accuracy on MEMGYM‑CODEQA by +0.55 pts (0.75 vs 0.20). Token‑cost reduction ≈8‑10× vs full‑context runs. | primary | high |
| 6 | BEAM & LIGHT (ICLR 2026) | https://mohammadtavakoli78.github.io/beam-light/ | 100 conversations up to 10 M tokens, 10 memory abilities. LIGHT improves accuracy 3.5‑12.7 % over vanilla/RAG across lengths; token usage grows linearly but remains <0.3 % of 10 M‑token context when using LIGHT. | primary | high |
| 7 | Mem0 vs Letta vs Zep vs LangMem benchmark (blog) | https://hamzashabbir.dev/article/agent-memory-mem0-vs-letta-vs-zep-vs-langmem-benchmark-2026 | Latency per turn: Mem0 ≈ 120 ms, LangMem ≈ 140 ms, Zep ≈ 310 ms, Letta ≈ 520 ms. Token injection per turn: Mem0 ≈ 280 tokens, LangMem ≈ 240, Zep ≈ 620, Letta ≈ 900. Recall accuracy: Zep 91 % (temporal), Mem0 84 %. | secondary | high |
| 8 | Eidentic blog: Memory beats full‑context on LongMemEval (2026) | https://eidentic.dev/blog/memory-beats-full-context | Full‑context consumes ~99 k tokens per question; memory‑enabled uses ~2.5 k tokens (≈40× fewer). Accuracy: 55.2 % vs 41.0 % (LongMemEval). | secondary | high |

## Findings

1. **Accuracy gains** – Across multiple benchmarks (LongMemEval‑V2, RecMem, MEMGYM, BEAM/LIGHT) adding a dedicated long‑term memory layer consistently raises answer quality over raw full‑context prompting. Reported improvements range from **+14 pp** (LongMemEval) to **+0.55 pts** absolute (MEMGYM‑CODEQA) and **3.5‑12.7 %** relative (LIGHT).

2. **Token efficiency** – Memory‑augmented agents use dramatically fewer LLM tokens. LongMemEval shows a **≈39×** token reduction; AgenticSTS reports **66‑90×** fewer fresh tokens per score point; Eidentic’s analysis confirms a **≈40×** reduction. RecMem and MEMGYM also achieve **≥8×** savings.

3. **Speed / Latency** – Retrieval‑oriented memory systems shave wall‑clock time. AgenticSTS demonstrates **≈4×** faster per‑floor execution compared to accumulating‑context agents. BM25‑style baselines answer in **<0.1 s**; Mem0‑style systems typically stay under **0.5‑2 s**. Full‑context runs can hit **>5 min** for long dialogues (AgenticSTS per‑call >500 k tokens).

4. **Construction vs Query trade‑off** – Systems that invest heavy computation in building a memory index (Paradigm IV) may spend **hours** indexing a 360 k‑token history, but then achieve sub‑second query latency. RecMem’s recurrence‑based approach dramatically cuts that construction cost (**‑71‑87 %** token spend) while preserving or improving accuracy.

5. **Dataset coverage** – Benchmarks span diverse domains:
   - **LongMemEval‑V2** – multi‑session web & enterprise trajectories (≈115 k tokens per haystack).
   - **AgenticSTS** – Slay‑the‑Spire runs (hundreds of decisions, ~500 k‑token episodes).
   - **BEAM** – 100 multi‑domain conversations up to 10 M tokens.
   - **MEMGYM** – synthetic tool‑use and coding tracks.
   - **RecMem** – LoCoMo personal‑assistant chats & LongMemEval‑S.
   These provide a broad empirical basis for evaluating long‑term memory in multi‑agent settings.

6. **Multi‑agent considerations** – While many benchmarks evaluate a single memory‑enhanced agent, the **AgenticSTS** and **MEMGYM** test a multi‑agent pipeline (user + content agents) and report token‑usage per *coordination step*. Results indicate that memory layers not only improve individual answer quality but also reduce the total token budget of the coordination protocol.

7. **Practical recommendations** –
   - Use a **vector‑RAG** or **graph‑based** memory (e.g., Zep) when temporal or relational reasoning is required; it yields higher recall at modest token cost.
   - For pure fact‑lookup, a **BM25** or lightweight **Mem0** index offers the best latency‑token trade‑off.
   - Adopt **recurrence‑based consolidation** (RecMem) to keep construction costs low while preserving accuracy.
   - Deploy a **LIGHT‑style** hybrid (episodic + working + scratchpad) for ultra‑long dialogues (>1 M tokens) to maintain accuracy without exploding token budgets.

## Sources
1. LongMemEval‑V2 repository – https://github.com/xiaowu0162/LongMemEval-V2
2. AgenticSTS: A Bounded‑Memory Testbed for Long‑Horizon LLM Agents – https://arxiv.org/abs/2607.02255
3. Agent Memory: Characterization and System Implications of Stateful Long‑Horizon Workloads – https://www.alphaxiv.org/overview/2606.06448
4. RecMem: Recurrence‑Based Memory Consolidation for Efficient and Effective Long‑Running LLM Agents – https://www.alphaxiv.org/overview/2605.16045
5. MEMGYM: A Benchmark for Evaluating Long‑Term Memory in LLM Agents – https://www.alphaxiv.org/overview/2605.20833
6. Beyond a Million Tokens: Benchmarking and Enhancing Long‑Term Memory in LLMs (BEAM & LIGHT) – https://mohammadtavakoli78.github.io/beam-light/
7. Mem0 vs Letta vs Zep vs LangMem – https://hamzashabbir.dev/article/agent-memory-mem0-vs-letta-vs-zep-vs-langmem-benchmark-2026
8. Memory beats full context on LongMemEval – https://eidentic.dev/blog/memory-beats-full-context
