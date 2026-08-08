# kakeibo eval report

Run 2026-08-08T21:35:06.075Z → 2026-08-08T21:35:26.079Z

| metric | value |
| --- | --- |
| pass rate | **1 / 1** (100%) |
| agent model | `gemini-3.6-flash` |
| judge model | `gemini-3.1-pro-preview` |
| median latency | 19.9 s |
| p95 latency | 19.9 s |
| median cost / task | $0.0177 |
| total cost | $0.0177 |
| median turns | 4 |
| context-cache savings | 72.8% of prompt tokens |

All costs are list-price estimates (see `packages/core/src/pricing.ts`).

## By class

| class | passed | total | rate |
| --- | --- | --- | --- |
| multi_tool | 1 | 1 | 100% |

## Tasks

| task | class | result | judge | latency | cost | tools |
| --- | --- | --- | --- | --- | --- | --- |
| `multitool-spend-in-usd` | multi_tool | pass | 5.0/5 | 19.9s | $0.0177 | 3 |

