# Design Review

## Assumptions

- S3 inputs already exist and are readable by the service; request authentication and authorization are outside the scope of this proposal.
- DynamoDB job metadata is the source of truth for externally visible job state; SQS provides at-least-once work delivery rather than authoritative job state.
- The proposed v1 worker runs one conversion at a time per 1 vCPU / 4 GB Fargate task and scales horizontally with queue demand.
- Cost estimates use representative averages within the supplied workload ranges. Customer result-download data transfer is treated as a sensitivity rather than included in the base estimate because download destination and frequency are unspecified.

## Ranked Risks

1. **Worker memory/concurrency mismatch.** A conversion requires roughly 2 GB of memory, while each 4 GB worker may process up to 10 messages concurrently. More than one or two simultaneous conversions can exhaust task memory, causing instability, process termination, retries, and reduced throughput. This is the first issue to address because failure follows directly from the stated resource requirements.
2. **Duplicate execution and conflicting/stale results.** Caller retries and at-least-once queue delivery can create races. Two requests using the same idempotency key may arrive nearly simultaneously, and duplicate deliveries for one job may reach separate workers. The current read-then-write job transition does not atomically establish ownership, so multiple workers may perform the same conversion and a slower attempt may overwrite or publish after a newer attempt. This is a correctness risk, not only wasted work.
3. **Imports and exports share one queue and worker fleet.** Imports make up roughly 80% of jobs and generally run for seconds to minutes, while exports make up roughly 20% and may run for tens of minutes. Sharing a fleet couples two materially different workloads and can allow long exports to delay imports. Separating them would allow independent scaling, concurrency, timeout, and operational policies.

## Deliberately Left Alone

1. **Scale from zero.** I would keep scale-from-zero for v1. Jobs already take seconds to minutes for imports and tens of minutes for exports, so worker startup time is currently small relative to total job latency and does not prevent work from completing. I would revisit this if measurements show worker startup becomes a meaningful portion of end-to-end latency, queue wait violates an agreed service target, or conversion times improve enough that cold-start latency is no longer trivial.
2. **Richer caller visibility during retries/backoff.** The existing polling API and optional completion webhook provide a sufficient v1 contract around the four external states. Adding attempt counts, retry/backoff detail, progress, or estimated completion time adds API and state-model complexity without a stated customer requirement. I would revisit this if customer/support feedback shows that long-running or retried jobs are creating unacceptable uncertainty. Terminal failure semantics still need to be well defined even if richer progress reporting is deferred.

## Minimum Changes Before v1

1. **One conversion per worker task; scale horizontally.** Reduce worker concurrency from 10 to 1. Keep the 1 vCPU / 4 GB task size and add Fargate tasks as queue demand grows rather than concentrating multiple ~2 GB, single-threaded conversions in one task.
2. **Atomic idempotent job creation.** When two API requests arrive with the same caller idempotency key, use a DynamoDB conditional write so only one request creates the job. The winning request enqueues the SQS message; the losing request returns the already-created job and does not enqueue duplicate work.
3. **Atomic worker claim.** Replace the worker's read-then-write ownership transition with a conditional `queued -> running` update. Only the worker that wins the claim starts conversion. A worker receiving a duplicate delivery that loses the claim returns without executing the conversion.
4. **Use realistic conversion timeouts.** Replace the hardcoded 30-second timeout with timeouts appropriate to the stated workloads: imports may legitimately take several minutes and exports tens of minutes. A real timeout should terminate/reap the owned conversion process before the job is retried. Queue visibility must also remain long enough, or be extended while work is active, so a legitimate long-running conversion is not redelivered simply because it is still processing.

Separating imports and exports into independent queues/fleets remains a useful optimization, but I would defer it for v1 after addressing the resource-exhaustion and duplicate-execution correctness risks above. I would revisit it if long-running exports measurably increase import queue age or violate an agreed import latency target.

## Job Lifecycle

### Import

1. The API receives an import request containing an S3 input reference and caller idempotency key.
2. A DynamoDB conditional write creates the job directly in `queued` state. If a concurrent request with the same idempotency key loses the race, it returns the existing job ID and current state rather than creating or enqueueing duplicate work.
3. The winning request publishes the job to SQS and returns the job ID and `queued` state to the caller.
4. A worker receives the message and atomically claims the job with a conditional `queued -> running` update. A duplicate delivery that loses the claim exits without starting conversion.
5. The worker reads and validates the import database from S3. Permanent input errors such as an invalid, corrupt, unsupported, or otherwise unusable database transition the job to `failed`; transient infrastructure or converter failures may retry according to the bounded retry policy.
6. The converter produces the JSON output. Permanent conversion failures transition to `failed`; retryable failures are retried without publishing a successful result.
7. On success, the JSON result is written to S3 first. Only after the output is durably available does the worker update DynamoDB to `succeeded` and record the output key.
8. After a terminal `succeeded` or `failed` transition, webhook delivery is attempted for subscribed callers. Webhook failure does not change job state or rerun conversion. Callers that do not use webhooks poll the job record for status and output information.

### Export

1. The API receives an export request containing S3 references for the JSON and associated media plus a caller idempotency key.
2. A DynamoDB conditional write creates the job directly in `queued` state. A concurrent duplicate using the same idempotency key returns the existing job ID/state and does not enqueue another message.
3. The winning request publishes the job to SQS and returns the job ID and `queued` state.
4. A worker receives the message and atomically claims the job with a conditional `queued -> running` update. A duplicate worker that loses the claim exits without executing the export.
5. The worker reads the JSON and referenced media from S3 and validates that the inputs are usable together. Permanent problems such as corrupt data, invalid references, or inconsistent JSON/media relationships transition the job to `failed`; transient failures may retry according to policy.
6. The vendor JVM export writer creates the database/package and ZIP output. Permanent conversion failures transition to `failed`; retryable failures are retried with the longer export timeout appropriate to a tens-of-minutes workload.
7. On success, the completed export package is written to S3 before the job state changes. DynamoDB is then updated to `succeeded` with the result key.
8. After the terminal transition, subscribed callers receive a webhook attempt. Webhook delivery is retried independently of conversion; callers may alternatively poll the job record for `queued`, `running`, `succeeded`, or `failed` state.

## Operations, Deployment, and Observability

| Signal | Emitter | Rough threshold | Action |
|---|---|---|---|
| Job success/failure by job type and failure stage | Worker custom metrics and structured logs | Terminal job failure rate >5% over a rolling 15-30 minute window; tune after production baseline is established | Alert on-call; inspect whether failures are concentrated in input read/validation, conversion, S3 write, timeout, or retry exhaustion; mitigate or roll back when correlated with a release |
| DLQ arrivals/depth | SQS / CloudWatch | Any new message entering the DLQ | Alert on-call; inspect the terminal error and replay only when the failure is understood and safe to retry rather than automatically looping DLQ jobs |
| API latency and HTTP error rate | API Gateway / Lambda metrics | p95 submission/status latency >200 ms for a sustained period, or anomalous 4xx/5xx increase over ~30 minutes | Triage Lambda/API dependencies and recent releases; investigate caller misuse or abusive traffic for 4xx anomalies and service health for 5xx anomalies |

### Deployment

Changes are developed on GitHub branches targeting `main`. Pull requests require successful code review and green GitHub Actions CI before merge; requested changes or failed CI return the work to the developer. A merge to `main` is tagged for release and produces an immutable release artifact. That artifact passes an automated release test pipeline covering unit, integration, performance, and security checks. Failures stop promotion and are surfaced for human triage. A green artifact enters the deployment queue, where a human reviews release readiness and approves production deployment through Jenkins. Production deploys promote the same tested artifact rather than rebuilding it. Post-deploy monitoring of API health, job failure rate, DLQ activity, queue behavior, and worker health determines whether rollout continues; a bad release is stopped and the previous known-good artifact is redeployed.

## Burst Sizing and Cost

### Assumptions

These are order-of-magnitude estimates because the workload requirements provide ranges rather than averages.

- Normal volume: 1,000 jobs/day, 80% imports and 20% exports.
- Burst volume: 3,000 jobs at the same 80/20 mix.
- Average import runtime: 2 minutes; average import result: 250 MB JSON.
- Average export runtime: 30 minutes; average export result: 25 GB package.
- Worker size: 1 vCPU / 4 GB, one conversion per Fargate task.
- Burst drain target: approximately 4 hours.
- Result artifacts remain immediately downloadable in S3 Standard for 7 days, then are deleted.
- DynamoDB job metadata is retained for 90 days.
- If longer artifact retention becomes a business requirement, an S3 Lifecycle policy could transition older results to a Glacier storage class instead of deleting them.

### Burst arithmetic

A 3,000-job burst contains approximately 2,400 imports and 600 exports.

- Imports: 2,400 × 2 minutes = 4,800 worker-minutes.
- Exports: 600 × 30 minutes = 18,000 worker-minutes.
- Total: 22,800 worker-minutes = 380 worker-hours.
- To drain in 4 hours: 380 / 4 ≈ 95 concurrently running worker tasks.
- Allowing roughly 20% operational headroom gives a scaling ceiling of about 115 concurrent tasks.

The burst therefore requires substantial horizontal concurrency, but only about 380 total Fargate worker-hours regardless of whether those hours are consumed quickly or slowly.

### Monthly cost estimate

Using a rough Linux/x86 Fargate rate of about $0.058/hour for 1 vCPU and 4 GB memory:

- Normal compute: (800 × 2 min + 200 × 30 min) = 7,600 worker-min/day = 126.7 worker-hours/day.
- Monthly compute: 126.7 × 30 ≈ 3,800 worker-hours/month.
- Fargate: 3,800 × $0.058 ≈ **$220/month**.

Approximate result volume written each day:

- Imports: 800 × 0.25 GB = 200 GB/day.
- Exports: 200 × 25 GB = 5,000 GB/day.
- Total: approximately 5.2 TB/day.

With seven days of immediately available results, steady-state S3 Standard storage is approximately 36.4 TB. At roughly $0.023/GB-month, this is about **$837/month** before tiering effects and excluding data transfer. API Gateway, Lambda, DynamoDB, SQS, and S3 request charges should be comparatively small at this request volume; the larger unknown cost is data transfer if customers regularly download 10-40 GB export packages outside AWS.

### Biggest line item / best cost reduction

Under these assumptions, **S3 result storage is the largest predictable line item**, driven primarily by the size of export packages rather than S3 read-request charges. The highest-leverage cost control is a short result-retention policy: keep artifacts in S3 Standard for seven days, retain only lightweight DynamoDB metadata for 90 days, and then delete the result. If the product requires longer recoverability, transition older artifacts to Glacier instead. S3 GET request charges themselves are unlikely to materially affect cost; data-transfer charges should be measured separately because large customer downloads could become significant.
