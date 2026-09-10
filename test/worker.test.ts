import { describe, expect, it, vi } from "vitest";
import {
  CONVERSION_TIMEOUT_MS,
  handle,
  type Clock,
  type Converter,
  type Job,
  type JobStore,
  type QueueMessage,
} from "../src/worker.js";

describe("worker", () => {
  it("kills a conversion that times out before retrying the message", async () => {
    let job: Job = {
      id: "job-1",
      inputKey: "inputs/job-1.accdb",
      status: "queued",
      attempt: 0,
    };

    const store: JobStore = {
      async get() {
        return job;
      },
      async claim() {
        if (job.status !== "queued") return undefined;
        job = { ...job, status: "running", attempt: job.attempt + 1 };
        return job;
      },
      async put(next) {
        job = next;
      },
    };

    const kill = vi.fn(async () => {});
    const converter: Converter = {
      start() {
        return {
          completion: new Promise<void>(() => {}),
          kill,
        };
      },
    };

    const timeout = vi.fn(async (_ms: number): Promise<never> => {
      throw new Error("conversion timed out");
    });
    const clock: Clock = { timeout };

    const ack = vi.fn(async () => {});
    const retry = vi.fn(async () => {});
    const message: QueueMessage = {
      jobId: job.id,
      receiveCount: 1,
      ack,
      retry,
    };

    await handle(message, store, converter, clock);

    expect(timeout).toHaveBeenCalledWith(CONVERSION_TIMEOUT_MS);
    expect(CONVERSION_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(kill).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    expect(job.status).toBe("queued");
  });

  it("allows only one worker to claim and convert a duplicate delivery", async () => {
    let job: Job = {
      id: "job-2",
      inputKey: "inputs/job-2.accdb",
      status: "queued",
      attempt: 0,
    };

    const store: JobStore = {
      async get() {
        return job;
      },
      async claim() {
        if (job.status !== "queued") return undefined;
        job = { ...job, status: "running", attempt: job.attempt + 1 };
        return job;
      },
      async put(next) {
        job = next;
      },
    };

    const start = vi.fn(() => ({
      completion: Promise.resolve(),
      kill: vi.fn(async () => {}),
    }));
    const converter: Converter = { start };

    const clock: Clock = {
      timeout: vi.fn(() => new Promise<never>(() => {})),
    };

    const ackA = vi.fn(async () => {});
    const ackB = vi.fn(async () => {});
    const retry = vi.fn(async () => {});

    const messageA: QueueMessage = {
      jobId: job.id,
      receiveCount: 1,
      ack: ackA,
      retry,
    };
    const messageB: QueueMessage = {
      jobId: job.id,
      receiveCount: 1,
      ack: ackB,
      retry,
    };

    await Promise.all([
      handle(messageA, store, converter, clock),
      handle(messageB, store, converter, clock),
    ]);

    expect(start).toHaveBeenCalledOnce();
    expect(job.status).toBe("succeeded");
    expect(job.attempt).toBe(1);
    expect(ackA).toHaveBeenCalledOnce();
    expect(ackB).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
