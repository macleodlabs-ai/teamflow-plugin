---
name: macleodlabs-teamflow-client
description: Call the paid TeamFlow service (macleodlabs.teamflow) over MCP or REST. Use this skill whenever a task matches this service's purpose: Near-live delivery map for Jira, Linear and GitHub work done with Claude Code. Reporters post derived stage, status and evidence per issue; the dashboard shows every ticket's swimlane from local dev through audits to verified. One credit per report. Trigger on any request to run, verify, price, or buy credits for TeamFlow, even if the user does not name the service.
---

# TeamFlow client

One call costs USD 0.01. The service returns a machine-
verifiable result with a request hash. Do not guess at the schema:
read it from the service first.

## Procedure

1. Read the contract. Call the `macleodlabs_teamflow_capabilities` tool, or
   GET https://teamflow.macleodlabs.com/v1/capabilities.
2. Build the request from the published schema. Include
   `idempotency_key` (any unique string) so retries are safe.
3. Call the `macleodlabs_teamflow_call` tool with the request. Over REST:
   POST https://teamflow.macleodlabs.com/v1/report
   with headers `X-Api-Key` and `Idempotency-Key`.
4. Read `status` before anything else. Billing statuses are listed
   in capabilities. INVALID and TOO_LARGE are free: fix the request
   and retry.
5. On HTTP 402 / PAYMENT_REQUIRED: the `payment` object lists credit
   packs and a checkout endpoint. Call `macleodlabs_teamflow_buy_credits` with the
   pack size and the account id, give the returned URL to the human
   to pay, wait for the webhook to land, then retry with the SAME
   idempotency key.
6. Verify: store `request_hash` and `result_hash`. The same
   normalized request on the same service version must reproduce the
   same result hash.

## Rules

- Never present a paid result without its status and hashes.
- Never retry a paid call without the idempotency key.
- A verified result means: it passed the service's declared checks.
  Do not upgrade that claim.
