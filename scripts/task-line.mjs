// The lines the hook adds about which project a prompt's work goes in
// (MACLEOD-970). Kept apart from tasks.mjs so the hook can build them
// without loading the planner on every event.

import path from 'node:path';

/** The command Claude can run: the plugin's own path in Claude Code, `teamflow` elsewhere. */
export function taskCommand(env = process.env) {
  const root = env.CLAUDE_PLUGIN_ROOT;
  return root ? `node "${path.join(root, 'scripts', 'cli.mjs')}" task` : 'teamflow task';
}

/** True for the line `promptLine` writes, so a caller can fold it into another. */
export function isTaskLine(line) {
  return typeof line === 'string' && /^TeamFlow: (Your open projects|You have no open projects)/.test(line);
}

/** A session with no ticket: one line offers both the next ticket and new work of its own. */
export function noIssueLine(command = 'teamflow task') {
  return `TeamFlow: no ticket. Run /teamflow:next for the top one, or for other work run \`${command} new "<name>"\`.`;
}

/** The open projects and what to run, as one line. */
export function promptLine(projects = [], command = 'teamflow task') {
  const ask = `If this prompt starts different work, run \`${command} new "<name>"\` with a short name for the work.`;
  if (!projects.length) return `TeamFlow: You have no open projects. ${ask} Otherwise do nothing.`;
  const listed = projects.map((p) => `${p.id} "${p.name}"`).join(', ');
  return `TeamFlow: Your open projects: ${listed}. ${ask} If it belongs to a listed project, run \`${command} in <id>\`. Otherwise do nothing.`;
}
