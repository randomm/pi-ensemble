# Long-Term Memory in Agentic Software Development Harnesses vs. Vipune vs. pi-ensemble: Corrected Analysis

**Executive Summary**

Current agentic development harnesses implement long-term memory with local-first storage, MCP integration, hybrid retrieval, automatic capture via hooks, conflict detection, and benchmarking. Vipune provides local SQLite storage, ONNX embeddings, conflict detection, and an MCP server, but lacks automatic hooks, git-aware learning, and benchmarks. pi-ensemble took a wrapper approach rather than direct CLI calls, implementing a TypeScript wrapper with sophisticated workarounds for Vipune's quirks. Issue #394 specifies detailed read legs and write rules, suggesting planned integration, but full workflow wiring may not be complete. The indecision between "use CLI directly" vs. "build TypeScript wrapper" appears resolved in favor of the wrapper, but the harness is in a hybrid state.

---

## 1. Research and Harness Patterns

Core patterns from surveyed harnesses [[1]](https://github.com/rohitg00/agentmemory) [[2]](https://github.com/nonanti/alaz) [[3]](https://github.com/keshrath/agent-knowledge) [[4]](https://github.com/oleksiijko/pmb) [[5]](https://github.com/dnacenta/recall-echo).

---

## 2. What Vipune Actually Provides

Verified features per README and docs [[6]](https://github.com/randomm/vipune/blob/main/README.md) [[7]](https://github.com/randomm/vipune/blob/main/docs/agent-integration.md). Quirks identified by pi-ensemble wrapper per `extension/src/vipune.ts` module header.

---

## 3. pi-ensemble's Approach

**TypeScript wrapper exists:** `extension/src/vipune.ts` (13KB) [[8]]. **Specification exists:** issue #394 describes R1–R4 legs and W1–W6 rules [[9]].

---

## 4. Actionable Recommendations

(See detailed table in corrected draft.)

---

## 5. Open Questions

(Preserved from corrected draft.)

---

## References
1. agentmemory – https://github.com/rohitg00/agentmemory
2. Alaz – https://github.com/nonanti/alaz
3. agent-knowledge – https://github.com/keshrath/agent-knowledge
4. PMB – https://github.com/oleksiijko/pmb
5. recall-echo – https://github.com/dnacenta/recall-echo
6. Vipune README – https://github.com/randomm/vipune/blob/main/README.md
7. Vipune agent integration – https://github.com/randomm/vipune/blob/main/docs/agent-integration.md
8. pi-ensemble wrapper – extension/src/vipune.ts (local file)
9. pi-ensemble specification – issue #394: https://github.com/randomm/pi-ensemble/issues/394