import { readConfig, type McpConfig } from "./index";
import { resolveApiKey } from "./key";
import { runLogin, runLogout } from "./login";

export interface CliDeps {
  runLogin: () => Promise<number>;
  runLogout: () => Promise<number>;
  resolveApiKey: () => Promise<string>;
  /** Connect the stdio server; stdout belongs to the MCP transport from here on. */
  startServer: (config: McpConfig) => Promise<void>;
  /** Write a diagnostic to stderr and exit once it is flushed. */
  fail: (message: string, code: number) => void;
  exit: (code: number) => void;
}

export function defaultDeps(
  startServer: CliDeps["startServer"],
): CliDeps {
  return {
    runLogin,
    runLogout,
    resolveApiKey,
    startServer,
    // Exit from the write callback: on a pipe (an MCP host) stderr is asynchronous and a
    // synchronous exit could drop the message.
    fail: (message, code) => void process.stderr.write(`${message}\n`, () => process.exit(code)),
    exit: (code) => process.exit(code),
  };
}

/** Dispatch on argv[2]: `login`, `logout`, or (no argument) the stdio server exactly as before. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<void> {
  const command = argv[2];
  if (command === "login") return deps.exit(await deps.runLogin());
  if (command === "logout") return deps.exit(await deps.runLogout());
  let config: McpConfig;
  try {
    // ATTRKIT_API_KEY wins when it is a real value; otherwise the macOS Keychain (see key.ts).
    const apiKey = await deps.resolveApiKey();
    config = readConfig({ ...process.env, ATTRKIT_API_KEY: apiKey });
  } catch (error) {
    deps.fail(error instanceof Error ? error.message : String(error), 1);
    return;
  }
  await deps.startServer(config);
}
