# Notes

## Assumptions

- `JobStore.claim(id)` represents a real atomic conditional update in production (for example, a DynamoDB conditional write), not a `get` followed by an unconditional `put`. It transitions only `queued -> running` and increments the attempt, so concurrent duplicate SQS deliveries have a single winner.
- The current `Job` model does not expose whether a job is an import or export. The shared 60-minute timeout is therefore a conservative v1 value rather than the desired final behavior.
- `message.receiveCount` represents queue delivery count and is used only as the current retry ceiling; application-level attempt count remains stored on the job.

## Remaining Risks / Deferred Work

- Add `type: "import" | "export"` to the job model and use type-specific timeouts (shorter for imports, longer for exports).
- Classify known permanent converter failures such as exit code 2 / `required table missing` and fail immediately rather than retrying them.
- Classify known transient failures such as exit code 137 as retryable. Production evidence indicates these may succeed on a later attempt.
- Add a lease/heartbeat or recovery mechanism for a worker that crashes after claiming a job. The current atomic claim prevents concurrent duplicate execution, but a crashed owner could leave a job in `running` indefinitely.
- Fence terminal writes by attempt/ownership (and ideally publish attempt-specific immutable output keys) before adding reclaim/lease behavior, so a slow or stale attempt cannot overwrite a newer successful result.

## Implementation Status

- I implemented two correctness fixes: (1) terminate a conversion that exceeds its timeout before retrying, and (2) atomically claim queued jobs so duplicate SQS deliveries cannot start concurrent conversions for the same job.
- I left the remaining production observations above as explicit follow-up work rather than expanding the repair into a broader worker redesign.
- Local verification with Codex: `npm install` succeeded, both existing tests passed, and `tsc --noEmit` passed. No source, test, or architecture changes were needed after verification.
- `npm install` reported two moderate dependency vulnerabilities; I did not address them because they were unrelated to the selected correctness fixes and outside the scope of these worker changes.

## AI Usage

### What I asked AI to do

I used ChatGPT as a review and implementation partner throughout development. Representative prompts included:

- "Let me go through and see if I can rank the risks myself and possible changes, then run that by you." I used AI primarily to critique and pressure-test my own prioritization rather than generate the initial ranking for me.
- "Any glaring design issues I missed?" I asked for targeted design review after forming my own risk list and proposed changes.
- "Let's talk about the smallest changes I'd make..." I used AI to challenge whether the changes I selected were minimal, safe, and aligned with the stated workload and production observations.
- "Before you give me the answer let me take a look..." During the code review, I first read and explained the handler myself, then asked AI to validate or correct my interpretation of timeouts, retries, duplicate deliveries, converter failures, and subprocess cleanup.
- "For now let's add comments on the type import | export and time required issue... then let's make our next fix which is make claiming a queued job atomic so duplicate SQS deliveries cannot start two conversions concurrently." I used AI to implement the specific fixes and TODOs I selected after review.
- For local verification, I asked Codex: "Review the current repository implementation for the Legacy File Conversion Service. Run `npm install` and `npm test`. Fix only compilation or test failures necessary to make the existing implementation and tests pass. Do not introduce new architectural changes or expand scope. Report what you ran, any failures encountered, and exactly what you changed."

I also used AI to scaffold the repository, maintain the design/notes documents, sanity-check the sizing arithmetic, and help turn my written design reasoning into concise documentation.

### What I accepted

- I accepted help implementing the correctness fixes I selected during review, including terminating timed-out conversions and preventing concurrent duplicate deliveries from starting the same job twice.
- I accepted AI assistance with focused regression tests, local test/debug execution, documentation edits, and arithmetic checks.

### What I rejected or corrected

- I kept architectural prioritization and scope decisions explicit rather than accepting broad AI-generated redesigns. Several observations are intentionally documented as deferred work instead of being implemented in the current version.
- I rejected expanding the repair to solve every production observation. I deliberately stopped after two urgent fixes and documented type-specific timeouts, permanent/transient error classification, crash recovery, and stale-attempt fencing as follow-up work.
- The local Codex verification found no code changes were necessary, so I did not accept any additional implementation changes from that pass.
