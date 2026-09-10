# Legacy File Conversion Service Proposal

A proposal and reference implementation for a cloud-based file conversion service with asynchronous processing, retries, large-object handling, and production observability.

## Contents

- `REQUIREMENTS.md` — workload, requirements, and baseline implementation
- `DESIGN.md` — design review
- `NOTES.md` — assumptions, deferred risks, implementation status, and tool usage
- `src/worker.ts` — worker implementation
- `test/worker.test.ts` — focused tests

## Setup

```bash
npm install
```

## Run tests

```bash
npm test
```

## Typecheck

```bash
npx tsc --noEmit
```
