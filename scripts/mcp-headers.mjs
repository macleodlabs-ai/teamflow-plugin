#!/usr/bin/env node
// Claude Code's `headersHelper` for the `teamflow` MCP server
// (MACLEOD-637). Prints one JSON object of headers on stdout and nothing
// else; any explanation goes to stderr. Always exits 0: `{}` makes /mcp
// show the server as not connected instead of hanging, and a stack trace
// on stdout would be read as the headers. See mcp.mjs for the rules.
import { loadConfig } from './core.mjs';
import { mcpHeaders } from './mcp.mjs';

let out = {};
try {
  const answer = await mcpHeaders(loadConfig(process.cwd()), {
    announced: process.env.CLAUDE_CODE_MCP_SERVER_URL || undefined,
  });
  out = answer.headers;
  if (!answer.ok) process.stderr.write(`TeamFlow MCP: ${answer.reason}\n`);
} catch (error) {
  out = {};
  process.stderr.write(`TeamFlow MCP: ${error?.message || 'could not read this machine\'s authorization'}\n`);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exitCode = 0;
