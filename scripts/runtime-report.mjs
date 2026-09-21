#!/usr/bin/env node
import * as auth from './auth.mjs';
import {
  apiKeyUsable, loadConfig, putReport, reportScope, sendReport, tenantId, tenantPath, transportOf,
} from './core.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cwd = process.cwd();
const config = loadConfig(cwd);
const tenantOverride = arg('tenant', process.env.TEAMFLOW_TENANT_ID);
if (tenantOverride) config.tenantId = tenantOverride;
const tenant = tenantId(config);
const jiraKey = (arg('jira', process.env.TEAMFLOW_JIRA_KEY) || '').toUpperCase();
const slot = arg('slot', process.env.TEAMFLOW_RUNTIME_SLOT || 'ci');
const kind = arg('kind', process.env.TEAMFLOW_RUNTIME_KIND || slot);
const label = arg('label', process.env.TEAMFLOW_RUNTIME_LABEL || slot);
const stage = arg('stage', process.env.TEAMFLOW_STAGE || 'CI_BUILD');
const status = arg('status', process.env.TEAMFLOW_STATUS || 'running');
const summary = arg('summary', process.env.TEAMFLOW_SUMMARY || label);
const id = arg('id', process.env.TEAMFLOW_RUNTIME_ID || `${slot}-${process.env.GITHUB_RUN_ID || Date.now()}`);

if (!/^[A-Z][A-Z0-9]{1,11}-\d+$/.test(jiraKey)) {
  process.stderr.write('runtime-report requires --jira PROJECT-123 or TEAMFLOW_JIRA_KEY\n');
  process.exit(2);
}

const allowedSlots = new Set(['ci', 'audit-local', 'deploy', 'dev-test', 'audit-dev', 'security']);
if (!allowedSlots.has(slot)) {
  process.stderr.write(`runtime-report slot must be one of: ${[...allowedSlots].join(', ')}\n`);
  process.exit(2);
}

const payload = {
  tenantId: tenant,
  jiraKey,
  slot,
  id: String(id).slice(0, 120),
  kind: ['ci','deploy','test','audit','security','environment'].includes(kind) ? kind : 'ci',
  label: String(label).slice(0, 120),
  stage,
  status,
  summary: String(summary).slice(0, 180),
  updatedAt: new Date().toISOString(),
};

// CI signs in per job. A workflow with `permissions: id-token: write`
// trades its GitHub Actions OIDC token, which names the repository,
// workflow and ref, for a one-hour access token. That is why the
// example workflow carries no secret. TEAMFLOW_API_KEY is the fallback
// for CI that cannot mint an OIDC token at all.
const ci = await auth.githubOidcAccessToken(config);
if (ci.ok) {
  config.accessToken = ci.token;
  // And which service minted it, so it may be sent back there whatever
  // named that address: a token returning to its own issuer leaks
  // nothing, and without this a self-hosted Actions run is refused
  // (MACLEOD-616). In process only — never a config key anything else
  // can set.
  config.accessTokenOrigin = ci.origin;
  // The exchange already said which organisation the repository is
  // registered to. Carried so a report queued offline knows whose it is
  // without a second call, and so a token replaced an hour later still
  // matches it (MACLEOD-583).
  if (ci.account) config.account = ci.account;
} else if (ci.attempted) {
  process.stderr.write(`TeamFlow: OIDC sign-in failed (${ci.reason}); ${apiKeyUsable(config) ? 'falling back to TEAMFLOW_API_KEY' : 'no fallback credential is configured'}\n`);
}

// The service derives the object path from the envelope's slot and the
// account's tenant, so only the legacy S3 path spells the key out.
const result = transportOf(config) === 'service'
  // Through the organisation check (MACLEOD-586, MACLEOD-601 audit
  // finding 3). A background reporter carries an issue key just as a
  // hook does, and a CI job that fell back to the wrong credential
  // would put one customer's build on another's board.
  ? await sendReport('runtime', slot, payload, config, { account: reportScope(config) })
  : await putReport(tenantPath(config, `runtime/${jiraKey}/${slot}.json`), payload, config);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
// Background reporting is observability only and must not break CI.
process.exit(0);
