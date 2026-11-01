import { execFile } from "node:child_process";

/**
 * Where the management key comes from at server start. Order:
 *   1. ATTRKIT_API_KEY, when it holds a real value.
 *      (an empty value or an unexpanded client placeholder counts as unset)
 *   2. On macOS, the Keychain item `attrkit-mcp` that `attrkit-mcp login` stores.
 *   3. Otherwise an error that says how to fix it.
 * Nothing here ever logs a key.
 */

export const KEYCHAIN_SERVICE = "attrkit-mcp";
const SECURITY_BIN = "/usr/bin/security";

export const KEY_REQUIRED_MESSAGE =
  "ATTRKIT_API_KEY is required (create one in AttriKit → Settings → API keys). On macOS, run `npx -y @attrkit/mcp login` to store it in the Keychain.";
export const KEY_REQUIRED_MESSAGE_OTHER_PLATFORM =
  "ATTRKIT_API_KEY is required (create one in AttriKit → Settings → API keys). Set it in the environment or in your MCP client's secret store.";

interface SecurityResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs /usr/bin/security. `stdin`, when given, is written to the process's standard input. */
export type SecurityRunner = (args: readonly string[], stdin?: string) => Promise<SecurityResult>;

/** The placeholders MCP clients leave in place when they do not expand a reference. Exact matches only. */
const UNEXPANDED_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "$ATTRKIT_API_KEY",
  "${ATTRKIT_API_KEY}",
  "${ATTRKIT_API_KEY:-}",
  "${env:ATTRKIT_API_KEY}",
  "${input:attrkit-key}",
]);

/** The key in the environment, or undefined when it is empty or an unexpanded placeholder. */
function realEnvKey(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.ATTRKIT_API_KEY;
  if (value === undefined || value.trim() === "") return undefined;
  if (UNEXPANDED_PLACEHOLDERS.has(value.trim())) return undefined;
  return value;
}

type ExecDone = (error: { code?: number | string | null } | null, stdout: string, stderr: string) => void;
/** The slice of execFile the runner uses, so a test can supply a fake child process. */
type ExecFileImpl = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number },
  done: ExecDone,
) => { stdin: { on(event: "error", listener: () => void): void; end(data?: string): void } | null };

const realExecFile: ExecFileImpl = (file, args, options, done) => execFile(file, args, options, done);

/** Build the runner on a given execFile, so a test can supply a fake child process. */
export function createSecurityRunner(execFileImpl: ExecFileImpl = realExecFile): SecurityRunner {
  return (args, stdin) =>
    new Promise((resolve) => {
      let writeFailed = false;
      const child = execFileImpl(SECURITY_BIN, [...args], { encoding: "utf8", timeout: 15_000 }, (error, stdout, stderr) => {
        const code = error === null ? 0 : Number.isInteger(error.code) ? Number(error.code) : 1;
        // An early exit of `security -i` closes the pipe: report it as a failure, never as success.
        resolve(writeFailed ? { code: code === 0 ? 1 : code, stdout, stderr: `${stderr}could not write to security` } : { code, stdout, stderr });
      });
      child.stdin?.on("error", () => {
        writeFailed = true;
      });
      if (stdin !== undefined) child.stdin?.end(stdin);
      else child.stdin?.end();
    });
}

export const defaultSecurityRunner: SecurityRunner = createSecurityRunner();

async function keychainKey(runSecurity: SecurityRunner): Promise<string | undefined> {
  const result = await runSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  if (result.code !== 0) return undefined;
  const key = result.stdout.replace(/\r?\n$/, "");
  return key.trim() === "" ? undefined : key;
}

/** Resolve the management key, or throw the error the server prints before exiting 1. */
export async function resolveApiKey(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runSecurity?: SecurityRunner;
} = {}): Promise<string> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fromEnv = realEnvKey(env);
  if (fromEnv !== undefined) return fromEnv;
  if (platform !== "darwin") throw new Error(KEY_REQUIRED_MESSAGE_OTHER_PLATFORM);
  const fromKeychain = await keychainKey(options.runSecurity ?? defaultSecurityRunner);
  if (fromKeychain !== undefined) return fromKeychain;
  throw new Error(KEY_REQUIRED_MESSAGE);
}
