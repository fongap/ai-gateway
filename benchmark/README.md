# Benchmark

`benchmark/` measures ai-gateway's own added hot-path overhead. It is separate from correctness tests because its purpose is regression evidence, not pass/fail product behavior.

## What it measures

`benchmark.mjs` runs the same zero-latency mocked upstream in two paths:

```text
direct request → mocked upstream

gateway request → ai-gateway → same mocked upstream
```

It reports:

- requests per second (RPS);
- p50 latency;
- p95 latency;
- p99 latency;
- added non-stream latency versus the direct baseline.

The full run varies node count and streaming event count so routing and stream-processing overhead remain visible as the pool grows.

## Commands

```bash
npm run bench       # short local run
npm run bench:full  # longer run with more scenarios
```

## Interpretation

Benchmark values are only meaningful as relative measurements under a comparable environment. Use the same machine, Node.js version, workload, and repository state when comparing before/after results.

Do not present these numbers as:

- an external SLA;
- production throughput;
- a cross-machine score;
- an absolute comparison with another gateway;
- real-provider latency.

The benchmark performs no real provider/network probing. Its mocked upstream intentionally removes external latency so changes in gateway processing are easier to see.

For hot-path changes, compare `npm run bench` before and after the change and investigate material regressions rather than optimizing for a single absolute number.
