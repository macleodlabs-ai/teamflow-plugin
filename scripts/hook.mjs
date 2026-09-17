#!/usr/bin/env node
import {
  applyTransition,
  chooseBinding,
  classifyTool,
  detectCandidates,
  enrichFromAtlassian,
  loadConfig,
  publishState,
  readJson,
  saveSession,
  sessionPath,
  tenantId,
} from './core.mjs';

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text ? JSON.parse(text) : {};
}

function hookOutput(event, state, justBound) {
  if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return;
  if (!state.binding?.key) return;
  const tracker = state.binding.tracker || 'jira';
  const context = [
    `TeamFlow: working on ${tracker} issue ${state.binding.key}.`,
    'Treat the issue as the work definition; continue normal development.',
    'TeamFlow reporting is automatic. Do not manually narrate tool calls for reporting.',
  ];
  if (justBound) context.push(`Binding source: ${state.binding.source}.`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context.join(' '),
    }
  }));
}

try {
  const input = await readStdin();
  const event = input.hook_event_name || 'Unknown';
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || 'unknown-session';
  const config = loadConfig(cwd);
  const previous = readJson(sessionPath(sessionId), {
    sessionId,
    cwd,
    stage: 'JIRA',
    status: 'running',
    summary: 'Issue work detected',
    loopCount: 0,
    subagentCount: 0,
    updatedAt: new Date().toISOString(),
  });
  let state = { ...previous, sessionId, cwd, ended: false, tenantId: tenantId(config) };

  // SessionEnd has a 1.5s default lifecycle budget. Keep it local and fast:
  // no git inspection, issue detection or S3 calls during shutdown.
  if (event === 'SessionEnd') {
    state.ended = true;
    if (state.status === 'running') state.status = 'idle';
    state.updatedAt = new Date().toISOString();
    saveSession(state);
    process.exit(0);
  }

  const beforeKey = state.binding?.key;
  const { candidates, info } = detectCandidates(input, cwd, state, config);
  state.binding = chooseBinding(state, candidates);
  const justBound = Boolean(state.binding?.key && state.binding.key !== beforeKey);
  state = enrichFromAtlassian(state, input, config);

  if (event === 'SubagentStart') state.subagentCount = (state.subagentCount || 0) + 1;
  if (event === 'SubagentStop') state.subagentCount = Math.max(0, (state.subagentCount || 0) - 1);

  const transition = classifyTool(input, state, config);
  state = applyTransition(state, transition);

  if (event === 'SessionStart' && state.binding?.key) {
    state.summary = state.summary || 'Session started';
    state.status = state.status === 'idle' ? 'running' : state.status;
    state.updatedAt = new Date().toISOString();
  }
  if (event === 'Stop' && state.binding?.key && state.status === 'running') {
    state.status = 'idle';
    state.summary = state.summary || 'Claude session idle';
    state.updatedAt = new Date().toISOString();
  }
  saveSession(state);

  // Synchronous SessionStart/UserPromptSubmit must stay fast so they never hold up Claude.
  // Async tool/task/stop hooks publish to the service (or legacy S3).
  if (!['SessionStart', 'UserPromptSubmit'].includes(event) && state.binding?.key) {
    await publishState(state, config, info, { force: event === 'Stop' });
    saveSession(state);
  }

  hookOutput(event, state, justBound);
  process.exit(0);
} catch (error) {
  // Reporting must never break Claude Code or the developer workflow.
  try {
    process.stderr.write(`TeamFlow reporter ignored error: ${error instanceof Error ? error.message : String(error)}\n`);
  } catch {}
  process.exit(0);
}
