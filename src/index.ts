#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { ToolFilterError } from './tool-filter.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.insecureTls) {
    console.error(
      'ntfy-mcp: NTFY_INSECURE_TLS=true — TLS certificate validation is ' +
        'disabled for the ntfy connection'
    );
  }
  if (config.readOnly) {
    console.error(
      'ntfy-mcp: NTFY_READ_ONLY=true — write tools are not registered'
    );
  }
  if (config.topics.length > 0) {
    console.error(
      `ntfy-mcp: restricted to ${config.topics.length} topic(s) by NTFY_TOPICS`
    );
  }

  let server;
  try {
    server = createServer(config);
  } catch (error) {
    // A bad tool list is operator feedback, not a crash: print the sentence on
    // its own rather than behind "fatal error:" with a stack after it.
    if (error instanceof ToolFilterError) {
      console.error(`ntfy-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(
    config.url
      ? `ntfy-mcp: connected, targeting ${config.url}`
      : 'ntfy-mcp: connected without configuration — tools are listed but ' +
          'every call will fail'
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error('ntfy-mcp: fatal error:', error);
  process.exit(1);
});
