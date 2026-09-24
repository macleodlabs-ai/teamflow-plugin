#!/usr/bin/env node
// Claude Code's `headersHelper` for the `teamflow` MCP server
// (MACLEOD-637). Prints one JSON object of headers on stdout and nothing
// else; any explanation goes to stderr. Always exits 0, because a stack
// trace on stdout would be read as the headers.
//
// Two ways in, and this is the first (MACLEOD-757). When this machine
// holds a TeamFlow authorization -- the device's, or a browser sign-in --
// the helper prints its short-lived bearer and Claude Code uses it. When
// it holds none, the helper prints `{}`, and Claude Code falls through
// to its own sign-in: /mcp shows Authenticate, the person signs in to
// TeamFlow in the browser, and Claude Code keeps and refreshes that
// token itself. See mcp.mjs for the rules.
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
