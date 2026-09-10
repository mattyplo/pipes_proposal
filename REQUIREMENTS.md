# Legacy File Conversion Service

## Context

A cloud platform needs to import legacy Microsoft Access exchange databases into JSON and export JSON plus media into packages existing customer software can consume.

## Workload facts

- Callers are backend services.
- An HTTP API accepts S3 references; file bytes do not travel through the API.
- Import: 10 MB–2 GB database; seconds to minutes; up to 500 MB JSON.
- Export: JSON + media from S3; outputs a zip with database/videos/images; 10–40 GB; tens of minutes.
- Normal volume is ~1,000 jobs/day, 80% import / 20% export.
- A bad onboarding burst is ~3,000 jobs at once with the same mix.
- Imports and exports currently share one queue and worker fleet.
- Import converter: TypeScript library.
- Export writer: vendor JVM subprocess; may be wrapped but not modified.
- A conversion needs ~2 GB RAM and is single-threaded.
- External job states: queued, running, succeeded, failed.
- Results are stored in S3; metadata retained 90 days.
- Optional completion webhook; callers can also poll.

## Proposed v1

- API Gateway + Lambda accept jobs.
- DynamoDB stores job metadata.
- One SQS queue + DLQ feeds ECS Fargate workers.
- Workers: 1 vCPU / 4 GB, up to 10 messages concurrently.
- Fleet scales from zero on queue depth.
- Outputs `jobs/{jobId}/result`, then marks succeeded.
- Caller-provided idempotency key.
- Same worker code handles import/export.
- Webhooks retry with backoff.

## Proposal scope

The proposal covers ranked operational risks, minimum v1 changes, import/export lifecycles, deployment and observability, burst sizing, and estimated infrastructure costs.

Authentication, multi-region support, schema design, UI, Terraform, and pipeline configuration are outside the current scope.

## Baseline implementation

The original handler below provides context for the timeout and duplicate-claim fixes in `src/worker.ts`. Remaining correctness risks and follow-up work are documented in `NOTES.md`.

```ts
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  inputKey: string;
  status: JobStatus;
  attempt: number;
  outputKey?: string;
  error?: string;
}

export interface JobStore {
  get(id: string): Promise<Job | undefined>;
  put(job: Job): Promise<void>;
}

export interface QueueMessage {
  jobId: string;
  receiveCount: number;
  ack(): Promise<void>;
  retry(): Promise<void>;
}

export interface RunningConversion {
  completion: Promise<void>;
  kill(): Promise<void>;
}

export interface Converter {
  start(inputKey: string, outputKey: string): RunningConversion;
}

export interface Clock {
  timeout(ms: number): Promise<never>;
}

export async function handle(
  message: QueueMessage,
  store: JobStore,
  converter: Converter,
  clock: Clock,
): Promise<void> {
  const job = await store.get(message.jobId);
  if (!job) {
    await message.ack();
    return;
  }

  if (job.status === "succeeded" || job.status === "failed") {
    await message.ack();
    return;
  }

  const attempt = job.attempt + 1;
  await store.put({ ...job, status: "running", attempt });

  const outputKey = `jobs/${job.id}/result.json`;
  const conversion = converter.start(job.inputKey, outputKey);

  try {
    await Promise.race([
      conversion.completion,
      clock.timeout(30_000),
    ]);

    await store.put({
      ...job,
      status: "succeeded",
      attempt,
      outputKey,
    });
    await message.ack();
  } catch (error) {
    if (message.receiveCount >= 3) {
      await store.put({
        ...job,
        status: "failed",
        attempt,
        error: String(error),
      });
      await message.ack();
      return;
    }

    await message.retry();
  }
}
```

## Production observations

- Duplicate deliveries for the same job can reach different workers <100 ms apart.
- Invalid database exits quickly with code 2 and `required table missing`.
- Converter sometimes exits 137 and succeeds later.
- Timed-out subprocess may continue unless its owner terminates/reaps it.
- A slow attempt may finish after another attempt already published a result.
