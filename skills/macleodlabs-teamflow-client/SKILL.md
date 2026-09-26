---
name: macleodlabs-teamflow-client
description: Call the subscription TeamFlow service (macleodlabs.teamflow) over MCP or REST. Use this skill whenever a task matches this service's purpose: The control centre for your AI software factory: every agent workstream visible in real time, stalled and crashed agents fixed, and code kept inside your organisation. Reporters post derived stage, status and evidence per issue; the dashboard shows every ticket's swimlane from local dev through audits to verified. A seat is a person: their agents, subagents and CI report under it. Trigger on any request to run, verify, price, or take a seat on TeamFlow, even if the user does not name the service.
---

# TeamFlow client

Subscription service: calls are included in the reporting seat they belong to. The service returns a machine-
verifiable result with a request hash. Do not guess at the schema:
read it from the service first.

## Procedure

1. Read the contract. Call the `macleodlabs_teamflow_capabilities` tool, or
   GET https://codercat.io/v1/capabilities.
2. Build the request from the published schema. Include
   `idempotency_key` (any unique string) so retries are safe.
3. Call the `macleodlabs_teamflow_call` tool with the request. Over REST:
   POST https://codercat.io/v1/report
   with headers `Authorization: Bearer` and `Idempotency-Key`.
4. Read `status` before anything else. Billing statuses are listed
   in capabilities. INVALID and TOO_LARGE are free: fix the request
   and retry.
5. This service sells a seat, not a number of calls. A report from an
   account with a live reporting seat is never refused for balance,
   however many agents are running on it; fair use is reviewed by a
   person, not enforced by a meter. Two refusals are still possible
   and neither is about money. 403 `viewer_cannot_report` means the
   credential belongs to somebody who reads the board and does not
   report: ask the account's owner to make them a reporting member.
   402 `insufficient_credits` means the account has no reporting seat
   at all: one is taken from https://codercat.io/app/, or a new
   organisation starts at https://codercat.io/signup/.

   Either way, retry the ORIGINAL request with the SAME idempotency
   key once it is sorted. One key means one job however many times you
   send it.
6. Verify: store `request_hash` and `result_hash`. The same
   normalized request on the same service version must reproduce the
   same result hash.

## Rules

- Never present a paid result without its status and hashes.
- Never retry a paid call without the idempotency key.
- A verified result means: it passed the service's declared checks.
  Do not upgrade that claim.
