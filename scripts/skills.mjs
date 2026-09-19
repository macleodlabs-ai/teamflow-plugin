#!/usr/bin/env node
// `teamflow skills install --for <tool>`: put the same skills in front of
// whichever agent the developer actually uses.
//
// One source of truth, plugin/skills/*/SKILL.md. A tool that discovers
// SKILL.md files gets them copied; a tool that only reads a rules file
// gets that rules file generated from the same sources at install time.
// Nothing here is hand-maintained per tool except the target paths,
// because a second copy of the instructions is a second thing to drift.
//
// Everything written is inside a marked block or a file this tool owns,
// and every write is idempotent: installing twice changes nothing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { credentialNotice, installHooks } from './hooks.mjs';
import { capability } from './tools.mjs';
import { mergeJson, writeBlock, writeFile, writeTomlTable } from './write.mjs';

const SERVICE_URL = 'https://codercat.io';
const MCP_URL = `${SERVICE_URL}/mcp`;
// Customers install from the public GitHub mirror, not from npmjs. The
// package is still named @macleodlabs/teamflow so a later npm publish
// keeps working, but nothing a customer runs depends on that registry:
// npmjs needs an interactive browser login we do not have, and GitHub
// Packages needs a token even to read a public package, so neither one
// serves `npx -y`. A public repo does.
const PACKAGE = 'github:macleodlabs-ai/teamflow-plugin';
const RUN = `npx -y ${PACKAGE}`;
const MARKETPLACE = 'macleodlabs-ai/teamflow-plugin';


export function skillsDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
}

// --- reading the one source of truth --------------------------------

// Enough YAML for the frontmatter an Agent Skill carries: flat
// `key: value` pairs. A skill that needs more than that has outgrown
// the format.
export function parseSkill(text, fallbackName) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { name: fallbackName, description: '', body: text.trim(), frontmatter: {} };
  const frontmatter = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    frontmatter[pair[1]] = pair[2].replace(/^["']|["']$/g, '').trim();
  }
  return {
    name: frontmatter.name || fallbackName,
    description: frontmatter.description || '',
    body: match[2].trim(),
    frontmatter,
  };
}

export function readSkills(dir = skillsDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, 'SKILL.md')))
    .sort()
    .map((name) => {
      const file = path.join(dir, name, 'SKILL.md');
      return { ...parseSkill(fs.readFileSync(file, 'utf8'), name), dir: name, file };
    });
}

// --- generating what a tool without skills can read -----------------

// The rules document every non-skill tool gets. Built from the same
// SKILL.md files, so adding a skill adds a line here and nowhere else.
export function rulesDocument(skills, { mcp = true, automation = 'rules', covers } = {}) {
  const commands = skills
    .filter((s) => s.frontmatter.command)
    .map((s) => `| \`${RUN} ${s.frontmatter.command}\` | ${s.description} |`)
    .join('\n');

  const call = mcp
    ? 'call the TeamFlow MCP tool `macleodlabs_teamflow_call`, or run the command below if the MCP server is not configured'
    : 'run the command below';

  // A tool whose hooks are installed reports on its own. Telling its
  // agent to report as well would not make the board better: it would
  // charge the team twice for the same fact, and the second report
  // would be the one written from memory.
  const automatic = {
    hooks: `## Reporting here is automatic

TeamFlow hooks are installed for this tool and cover ${covers || 'every finished tool call'}.
They report each stage as it happens, with nobody asked to remember.

**Do not report by hand.** Do not narrate tool calls for reporting, and
do not run \`report\` after a test run or a merge: the hook already did,
and a second report is a second credit for the same fact. The stage
vocabulary below is there so you can read the board, and for the rare
transition no tool call can show.

`,
    'git-hooks': `## Reporting here is on commit

This tool has no hook TeamFlow can attach to, so the repository's git
hooks report instead: a commit reports \`LOCAL_DEV\`, a merge reports
\`MERGE\`, and a push reports \`LOCAL_TEST\` when a test command is
configured. That is coarser than a report per tool call, and it happens
whether or not you remember.

Report by hand for the transitions git cannot see — a deploy, a dev
test, an audit — and not for the three above.

`,
    rules: '',
  }[automation] || '';

  return `# TeamFlow

This team tracks delivery stages in TeamFlow. Keep the board true.

${automatic}## Report at each stage transition

When you know the work has reached a new stage, ${call}:

\`\`\`bash
${RUN} report --issue <KEY> --stage <STAGE> --status <STATUS> --summary "<what happened>"
\`\`\`

Report at these moments, and only these:

- you start editing code for a ticket -> \`LOCAL_DEV\`, status \`running\`
- the local test suite or build passes -> \`LOCAL_TEST\`, status \`success\`
- a local lint, review or security audit passes -> \`LOCAL_AUDIT\`, \`success\`
- any local gate fails -> \`LOCAL_REWORK\`, status \`failed\`, and pass
  \`--rework-from\` naming the gate that failed
- a pull request is merged -> \`MERGE\`, status \`success\`
- a deploy to dev finishes -> \`DEPLOY_DEV\`, status \`success\`
- tests pass against dev -> \`DEV_TEST\`; an audit passes against dev ->
  \`DEV_AUDIT\`; both passed -> \`DEV_VERIFIED\`

The other stages are \`BACKLOG\`, \`CI_BUILD\`, \`DEV_REWORK\` and \`READY_PROD\`.
Statuses are \`running\`, \`success\`, \`waiting\`, \`blocked\`, \`failed\` and
\`idle\`. \`--issue\` takes \`DAEMON-142\`, \`ENG-42\`, \`#123\`, \`owner/repo#123\`
or an issue URL.

Keep the summary under 180 characters and describe only what happened.
Never put a prompt, a diff, source code, a shell command, a log or an
issue description in a report: they are rejected, and they are not yours
to send.

Do not report on a timer, do not report the same stage twice, and do not
report a stage you have not observed. An accepted report costs the team
one credit. On HTTP 402 stop reporting and show your human the price and
the payment link. Never let a reporting failure interrupt the work.

## The other TeamFlow commands

Run these when the user asks for them by name. They are not automatic.

| Command | What it does |
| --- | --- |
${commands}

${skills.filter((s) => s.frontmatter.command).map((s) => `### ${s.name}\n\n${s.body}`).join('\n\n')}
`;
}

// --- writers ---------------------------------------------------------

// Inside the Claude Code plugin a skill is `status`, because that is what
// makes the slash command `/teamflow:status`. Copied into a shared skills
// directory it has to say whose `status` it is, so the name is prefixed
// on the way out and the frontmatter is rewritten to match: a loader that
// checks the directory against the name would otherwise reject it.
export function externalName(name) {
  return name.startsWith('teamflow') || name.includes('teamflow') ? name : `teamflow-${name}`;
}

export function namespaced(text, name) {
  const target = externalName(name);
  return text.replace(/^(---\n(?:[\s\S]*?\n)?)name:[^\n]*/m, `$1name: ${target}`);
}

function copySkills(dir, skills, written) {
  for (const skill of skills) {
    const name = externalName(skill.name);
    writeFile(path.join(dir, name, 'SKILL.md'),
      namespaced(fs.readFileSync(skill.file, 'utf8'), skill.name), written);
  }
}

// --- the tools -------------------------------------------------------
//
// `skills` is a directory the tool scans for SKILL.md files; `rules` is
// the file it reads on every turn; `mcp` registers the server. A tool
// with no `skills` entry gets the generated rules document instead,
// which is why there is still one source of truth.

const home = () => process.env.HOME || os.homedir();

// One shared skills root for everything that reads it, which is seven of
// the ten. Each documents it independently: Codex CLI, where it is the
// ONLY location and there is no .codex/skills at all; Cursor; VS Code's
// Copilot; Gemini CLI, where it outranks .gemini/skills; Zed, where it
// is one of only two; Windsurf; and Junie.
//
// Writing the shared root rather than each tool's private directory is
// not only fewer files. Most of these tools read several of the
// directories, so a repo carrying both .cursor/skills and .agents/skills
// shows Cursor the same skill twice.
//
// The layout stays flat, one directory per skill directly under the
// root, because Zed does not recurse into nested folders.
const agentsSkills = (root, user) => (user
  ? path.join(home(), '.agents', 'skills')
  : path.join(root, '.agents', 'skills'));

// `skills` is the directory this tool scans for SKILL.md files, taken from
// that tool's own documentation. Seven of the ten read the shared
// `.agents/skills` root; Cline reads only its own; Claude Desktop takes
// skills as a ZIP through its UI and Aider has no skill loader at all,
// so those two get the generated rules file and nothing is written where
// nothing would read it.
export const TOOLS = {
  cursor: {
    label: 'Cursor',
    skills: agentsSkills,
    rules: (root) => path.join(root, '.cursor', 'rules', 'teamflow.mdc'),
    rulesFrontmatter: '---\ndescription: TeamFlow delivery reporting\nalwaysApply: true\n---\n\n',
    mcp: (root) => ({
      file: path.join(root, '.cursor', 'mcp.json'),
      json: { mcpServers: { teamflow: { url: MCP_URL } } },
    }),
    note: 'Sign in from Settings -> MCP; Cursor shows a login control next to the server.',
  },
  codex: {
    label: 'OpenAI Codex CLI',
    skills: agentsSkills,
    rules: (root) => path.join(root, 'AGENTS.md'),
    mcp: () => ({
      file: path.join(home(), '.codex', 'config.toml'),
      toml: { table: 'mcp_servers.teamflow', body: `url = "${MCP_URL}"` },
    }),
    note: 'Sign in with `codex mcp login teamflow`.',
  },
  gemini: {
    label: 'Gemini CLI',
    skills: agentsSkills,
    rules: (root) => path.join(root, 'GEMINI.md'),
    mcp: () => ({
      file: path.join(home(), '.gemini', 'settings.json'),
      // httpUrl is Streamable HTTP. `url` in this file means SSE, which
      // this endpoint does not serve.
      json: { mcpServers: { teamflow: { httpUrl: MCP_URL } } },
    }),
    note: 'Sign in with `/mcp auth teamflow`.',
  },
  copilot: {
    label: 'VS Code with GitHub Copilot',
    skills: agentsSkills,
    rules: (root) => path.join(root, '.github', 'copilot-instructions.md'),
    mcp: (root) => ({
      file: path.join(root, '.vscode', 'mcp.json'),
      // VS Code says `servers`, not `mcpServers`.
      json: { servers: { teamflow: { type: 'http', url: MCP_URL } } },
    }),
    note: 'A browser window opens on the first connection. Agent mode is the only mode that can call MCP tools.',
  },
  windsurf: {
    label: 'Windsurf / Devin Desktop',
    skills: agentsSkills,
    rules: (root) => path.join(root, '.windsurf', 'rules', 'teamflow.md'),
    mcp: () => ({
      file: path.join(home(), '.codeium', 'windsurf', 'mcp_config.json'),
      json: { mcpServers: { teamflow: { serverUrl: MCP_URL } } },
    }),
    note: 'Sign in from the MCPs panel in Cascade.',
  },
  cline: {
    label: 'Cline',
    // The one skills-capable tool here that does not read
    // `.agents/skills`, so it gets its own copy. Cline also inverts the
    // usual precedence: a global skill beats a project one of the same
    // name, where every other tool has project win.
    skills: (root, user) => (user
      ? path.join(home(), '.cline', 'skills')
      : path.join(root, '.cline', 'skills')),
    rules: (root) => path.join(root, '.clinerules', 'teamflow.md'),
    mcp: () => ({
      file: path.join(home(), '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
      json: { mcpServers: { teamflow: { type: 'streamableHttp', url: MCP_URL, disabled: false, autoApprove: [] } } },
    }),
    note: 'Cline surfaces the sign-in when the server answers 401. Needs Cline 4.1.7 or newer.',
  },
  zed: {
    label: 'Zed',
    skills: agentsSkills,
    rules: (root) => path.join(root, 'AGENTS.md'),
    mcp: () => ({
      file: path.join(home(), '.config', 'zed', 'settings.json'),
      json: { context_servers: { teamflow: { url: MCP_URL } } },
    }),
    note: 'Zed prompts for the standard MCP OAuth flow when the server has no Authorization header.',
  },
  jetbrains: {
    label: 'JetBrains AI Assistant',
    // Junie documents `.junie/skills` and `.agents/skills` both; the
    // shared one is written so a repo carries a single copy. AI
    // Assistant's own IDE-wide skill storage has no documented path, so
    // nothing is guessed for it.
    skills: agentsSkills,
    rules: (root) => path.join(root, 'AGENTS.md'),
    mcp: (root) => ({
      file: path.join(root, '.junie', 'mcp', 'mcp.json'),
      json: { mcpServers: { teamflow: { url: MCP_URL } } },
    }),
    note: `This writes Junie's config. AI Assistant registers MCP through Settings -> Tools -> AI Assistant -> Model Context Protocol; paste the same JSON there. Its OAuth support is undocumented; if the sign-in never appears, register \`npx -y mcp-remote ${MCP_URL}\` as a stdio server instead.`,
  },
  'claude-desktop': {
    label: 'Claude Desktop',
    // Nothing on disk: remote servers are added through Connectors and
    // instructions live in a Project, both of which are UI.
    manual: [
      `Settings -> Connectors -> Add -> Add custom connector -> ${MCP_URL}`,
      'Create a Project for this codebase and paste the rules document into its Project instructions.',
    ],
    rules: (root) => path.join(root, '.teamflow', 'claude-desktop-instructions.md'),
    note: 'The rules file is written for you to paste into Project instructions; Claude Desktop cannot read it from disk.',
  },
  aider: {
    label: 'Aider',
    rules: (root) => path.join(root, 'CONVENTIONS.md'),
    // Aider has no MCP client. The rules document says so and points at
    // the command instead.
    noMcp: true,
    note: 'Load it with `aider --read CONVENTIONS.md`, or put `read: CONVENTIONS.md` in .aider.conf.yml.',
  },
  'claude-code': {
    label: 'Claude Code',
    manual: [
      `/plugin marketplace add ${MARKETPLACE}`,
      '/plugin install teamflow@macleodlabs',
      '/teamflow:login',
    ],
    note: 'The plugin carries these skills and its hooks report automatically. Nothing to install here.',
  },
};

// --- install ---------------------------------------------------------

export function install(tool, { root = process.cwd(), scope = 'project', dryRun = false, dir = skillsDir() } = {}) {
  const spec = TOOLS[tool];
  if (!spec) {
    throw new Error(`Unknown tool "${tool}". Known: ${Object.keys(TOOLS).sort().join(', ')}`);
  }
  const skills = readSkills(dir);
  if (!skills.length) throw new Error(`No SKILL.md files under ${dir}`);

  const written = [];
  const plan = (file) => written.push({ file, action: 'would write' });

  // A tool with a hook system gets its hooks in the same breath as its
  // skills, because a developer who installs TeamFlow into Cursor means
  // "report my work", not "install a skill I will have to remember to
  // use". This happens first because the rules document has to say
  // whether reporting is already automatic here, and the files it
  // wrote are still listed last, where a reader expects them.
  const hooks = installHooks(tool, { root, dryRun });
  const automation = capability(tool)?.automation || 'rules';

  if (spec.skills) {
    const target = spec.skills(root, scope === 'user');
    if (dryRun) for (const skill of skills) plan(path.join(target, externalName(skill.name), 'SKILL.md'));
    else copySkills(target, skills, written);
  }

  if (spec.rules) {
    const file = spec.rules(root);
    if (dryRun) plan(file);
    else {
      const doc = (spec.rulesFrontmatter || '')
        + rulesDocument(skills, { mcp: !spec.noMcp, automation, covers: hooks.covers });
      // A file TeamFlow owns outright is written whole; a file the user
      // also writes in gets a marked block instead, so their own
      // instructions above and below it survive a reinstall.
      if (ownedByTeamflow(file)) writeFile(file, doc, written);
      else writeBlock(file, doc, written);
    }
  }

  if (spec.mcp) {
    const target = spec.mcp(root);
    if (dryRun) plan(target.file);
    else if (target.json) mergeJson(target.file, target.json, written);
    else if (target.toml) writeTomlTable(target.file, target.toml.table, target.toml.body, written);
  }

  written.push(...hooks.written);

  return {
    tool,
    label: spec.label,
    scope,
    skills: skills.map((s) => (spec.skills ? externalName(s.name) : s.name)),
    written,
    automation,
    hooks: hooks.hooks
      ? hooks.covers
      : `no hook system; run \`${RUN} hooks install --git\` to report on commit, merge and push`,
    manual: spec.manual || [],
    note: spec.note,
  };
}

// A path whose name is TeamFlow's own; anything else belongs to the
// user and only gets a marked block.
function ownedByTeamflow(file) {
  return /^teamflow[.-]|^claude-desktop-instructions\.md$/.test(path.basename(file));
}

// --- cli -------------------------------------------------------------

export const USAGE = `teamflow skills — put the TeamFlow skills in front of your agent

  teamflow skills list
  teamflow skills install --for <tool> [--scope project|user] [--dir <path>] [--dry-run]

Tools: ${Object.keys(TOOLS).sort().join(', ')}

--scope project (the default) writes into the current repository, so the
whole team gets it from a checkout. --scope user writes into your home
directory where the tool supports it. --dry-run lists the files without
touching any of them.
`;

export async function main(argv = [], io = {}) {
  const out = io.stdout || ((text) => process.stdout.write(text));
  const err = io.stderr || ((text) => process.stderr.write(text));
  const cwd = io.cwd || process.cwd();

  const [action = 'list', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) { err(`unexpected argument: ${token}\n`); return 2; }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    if (name === 'dry-run' || name === 'help') { options[name] = true; continue; }
    const value = eq >= 0 ? body.slice(eq + 1) : rest[++i];
    if (value === undefined) { err(`--${name} needs a value\n`); return 2; }
    options[name] = value;
  }

  if (options.help || action === 'help') { out(USAGE); return 0; }

  if (action === 'list') {
    const skills = readSkills(options.dir ? path.resolve(cwd, options.dir) : skillsDir());
    out(`${JSON.stringify({
      skills: skills.map((s) => ({ name: s.name, description: s.description, command: s.frontmatter.command })),
      tools: Object.fromEntries(Object.entries(TOOLS).map(([k, v]) => [k, v.label])),
    }, null, 2)}\n`);
    return 0;
  }

  if (action !== 'install') { err(`Unknown skills action "${action}".\n\n${USAGE}`); return 2; }
  if (!options.for) { err(`skills install needs --for <tool>.\n\n${USAGE}`); return 2; }
  if (options.scope && !['project', 'user'].includes(options.scope)) {
    err('--scope must be project or user\n');
    return 2;
  }

  try {
    const root = options.root ? path.resolve(cwd, options.root) : cwd;
    const dryRun = Boolean(options['dry-run']);
    const result = install(options.for, {
      root,
      scope: options.scope || 'project',
      dryRun,
      dir: options.dir ? path.resolve(cwd, options.dir) : skillsDir(),
    });
    // This is the documented one-liner, so it ends the way `hooks
    // install` does: with whether this machine can report at all
    // (MACLEOD-569). A dry run writes nothing and asks nobody anything.
    const notice = dryRun ? undefined : await credentialNotice({ root });
    out(`${JSON.stringify(notice ? { ...result, signIn: notice.signIn } : result, null, 2)}\n`);
    // Exit 0: the skills and the hooks are installed. See hooks.mjs.
    if (notice) err(notice.block);
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
