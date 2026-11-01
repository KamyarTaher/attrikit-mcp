#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./index";
import { defaultDeps, runCli } from "./main";

/**
 * stdio entrypoint. STDIO ONLY — no HTTP listener, no port bind (the MCP
 * transport owns stdout, so all diagnostics go to stderr).
 */
runCli(
  process.argv,
  defaultDeps(async (config) => {
    const server = createServer(config);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`attrkit-mcp connected (api=${config.apiUrl})\n`);
  }),
).catch((error) => {
  process.stderr.write(`attrkit-mcp failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`, () => process.exit(1));
});
