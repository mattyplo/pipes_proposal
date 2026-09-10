export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  inputKey: string;
  status: JobStatus;
  attempt: number;
  outputKey?: string;
  error?: string;
  // TODO: add job type ("import" | "export") so timeout and output behavior
  // can be tuned to the materially different workloads.
}

export interface JobStore {
  get(id: string): Promise<Job | undefined>;
  // Atomically transition queued -> running and increment attempt.
  // Return the claimed job, or undefined if this worker did not acquire it.
  claim(id: string): Promise<Job | undefined>;
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

// Conservative v1 timeout that covers the stated tens-of-minutes export workload.
// TODO: once Job exposes import/export type, use a shorter import timeout and a
// longer export timeout instead of one shared value.
export const CONVERSION_TIMEOUT_MS = 60 * 60 * 1000;

export async function handle(
  message: QueueMessage,
  store: JobStore,
  converter: Converter,
  clock: Clock,
): Promise<void> {
  const existing = await store.get(message.jobId);
  if (!existing) {
    await message.ack();
    return;
  }

  if (existing.status === "succeeded" || existing.status === "failed") {
    await message.ack();
    return;
  }

  const job = await store.claim(message.jobId);
  if (!job) {
    // Another worker already owns this job. Acknowledge this duplicate delivery
    // without starting a second conversion.
    await message.ack();
    return;
  }

  const attempt = job.attempt;
  const outputKey = `jobs/${job.id}/result.json`;
  const conversion = converter.start(job.inputKey, outputKey);
  let conversionSettled = false;
  const completion = conversion.completion.finally(() => {
    conversionSettled = true;
  });

  try {
    await Promise.race([
      completion,
      clock.timeout(CONVERSION_TIMEOUT_MS),
    ]);

    await store.put({
      ...job,
      status: "succeeded",
      attempt,
      outputKey,
    });
    await message.ack();
  } catch (error) {
    if (!conversionSettled) {
      await conversion.kill();
    }

    // TODO: classify known permanent converter failures (for example exit code 2,
    // "required table missing") and fail immediately instead of retrying work
    // that cannot recover without different input.
    // TODO: classify known transient failures such as exit code 137 as retryable;
    // it commonly indicates SIGKILL/resource pressure and production evidence says
    // a later attempt may succeed.

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

    // Release ownership before making the message eligible for another attempt.
    await store.put({ ...job, status: "queued", attempt });
    await message.retry();
  }
}
