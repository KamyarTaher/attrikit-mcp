import { userInfo } from "node:os";

import { z } from "zod";

import { callApi, readConfig } from "./index";
import {
  defaultSecurityRunner,
  KEYCHAIN_SERVICE,
  type SecurityRunner,
} from "./key";

/** `attrkit-mcp login` and `logout`. All output goes to stderr; stdout is not used. */

type ApiJson = Awaited<ReturnType<typeof callApi>>["json"];

export interface LoginOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  username?: string;
  readSecret?: (prompt: string) => Promise<string | null>;
  runSecurity?: SecurityRunner;
  fetchImpl?: typeof fetch;
  write?: (text: string) => void;
}

/**
 * security's interactive parser takes double-quoted strings. Its escape rules are not specified, so
 * a key it could mis-read is refused rather than escaped: a double quote, a backslash, or any
 * control character (newline included).
 */
export function quotedForSecurity(key: string): string | null {
  if (key === "" || Array.from(key).some(isUnquotable)) return null;
  return `"${key}"`;
}

function isUnquotable(character: string): boolean {
  const code = character.charCodeAt(0);
  return character === '"' || character === "\\" || code <= 31 || code === 127;
}

/** The one stdin line that stores the key. The key appears here and nowhere in argv. */
export function addKeyCommand(username: string, quotedKey: string): string {
  return `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${Array.from(username).filter((character) => !isUnquotable(character)).join("")}" -w ${quotedKey}\n`;
}

/** The slice of process.stdin the hidden reader needs, so a test can drive it with a fake. */
export interface HiddenInput {
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  setEncoding(encoding: BufferEncoding): void;
  on(event: "data", listener: (chunk: string) => void): void;
  removeListener(event: "data", listener: (chunk: string) => void): void;
}

type ReaderMode = "text" | "escape" | "csi" | "ss3" | "drain";

/**
 * Read a line with echo off. Resolves null on Ctrl-C or Ctrl-D. Whole escape sequences (an arrow key sends
 * ESC [ A) are dropped, not just the ESC. After Enter, input that arrives in the same paste is
 * discarded until the line has been idle for `idleMs`. Chunks arriving after the terminal is
 * restored are outside this reader; slow or unbracketed pastes still require care.
 */
export function readHidden(input: HiddenInput, prompt: string, write: (text: string) => void, idleMs = 50): Promise<string | null> {
  return new Promise((resolve) => {
    // Echo off BEFORE the prompt: input that arrives between the two (a paste fired the moment
    // the prompt appears) was echoed by the terminal while it was still in cooked mode.
    input.setRawMode(true);
    write(prompt);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    let mode: ReaderMode = "text";
    let idle: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: string | null) => {
      if (idle !== undefined) clearTimeout(idle);
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      write("\n");
      resolve(result);
    };
    const armIdle = () => {
      if (idle !== undefined) clearTimeout(idle);
      idle = setTimeout(() => finish(value), idleMs);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        // Ctrl-C and Ctrl-D cancel in every mode, before escape parsing; the rest of the chunk is ignored.
        if (character === "\u0003" || character === "\u0004") return finish(null);
        if (mode === "drain") continue;
        // Enter ends the line even inside a partial escape sequence; the rest of the paste is drained.
        if (character === "\r" || character === "\n") {
          mode = "drain";
          continue;
        }
        if (mode === "escape") {
          mode = character === "[" ? "csi" : character === "O" ? "ss3" : "text";
        } else if (mode === "csi") {
          if (character >= "@" && character <= "~") mode = "text";
        } else if (mode === "ss3") {
          mode = "text";
        } else if (character === "\u001b") {
          mode = "escape";
        } else if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
      if (mode === "drain") armIdle();
    };
    input.on("data", onData);
  });
}

function readHiddenFromTty(prompt: string): Promise<string | null> {
  return readHidden(process.stdin, prompt, (text) => void process.stderr.write(text));
}

const whoamiSchema = z.object({
  data: z.object({
    plan: z.string().optional(),
    scope: z.object({
      app_id: z.string().nullish(),
      scopes: z.array(z.string()).optional(),
    }).optional(),
  }),
});

function describeWhoami(json: ApiJson): string {
  const parsed = whoamiSchema.safeParse(json);
  if (!parsed.success) return "Key accepted.";
  const { plan, scope } = parsed.data.data;
  const app = scope?.app_id ? `app ${scope.app_id}` : "all apps";
  return `Key accepted. Plan: ${plan ?? "unknown"}. Scopes: ${scope?.scopes?.join(", ") ?? "unknown"}. Restriction: ${app}.`;
}

export async function runLogin(options: LoginOptions = {}): Promise<number> {
  const write = options.write ?? ((text: string) => void process.stderr.write(text));
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    write("attrkit-mcp login stores the key in the macOS Keychain. On this system set ATTRKIT_API_KEY in the environment or in your MCP client's secret store.\n");
    return 1;
  }
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) {
    write("attrkit-mcp login needs an interactive terminal to ask for the key.\n");
    return 1;
  }
  const readSecret = options.readSecret ?? readHiddenFromTty;
  const entered = await readSecret("AttriKit management key: ");
  if (entered === null) return 130;
  const key = entered.trim();
  const quoted = quotedForSecurity(key);
  if (quoted === null) {
    write("That key was not accepted: it is empty or holds a quote, backslash or control character. Nothing was stored.\n");
    return 1;
  }
  let config;
  try {
    config = readConfig({ ...(options.env ?? process.env), ATTRKIT_API_KEY: key });
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const result = await callApi(config, "/api/v1/whoami", options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  if (result.status === 401 || result.status === 403) {
    write("AttriKit refused that key. Nothing was stored.\n");
    return 1;
  }
  if (!result.ok) {
    write(result.status === 0
      ? `Could not reach ${new URL(config.apiUrl).origin} to check the key. Nothing was stored.\n`
      : `Could not check the key (HTTP ${result.status}). Nothing was stored.\n`);
    return 1;
  }
  write(`${describeWhoami(result.json)}\n`);
  const runSecurity = options.runSecurity ?? defaultSecurityRunner;
  const stored = await runSecurity(["-i"], addKeyCommand(options.username ?? userInfo().username, quoted));
  // In interactive mode security reports a failed command on stderr, so any stderr output is failure.
  if (stored.code !== 0 || stored.stderr.trim() !== "") {
    write(`The Keychain refused the item (exit ${stored.code}). Nothing was stored.\n`);
    return 1;
  }
  write("Stored in the macOS Keychain as attrkit-mcp. Your MCP client can now start the server without ATTRKIT_API_KEY.\n");
  return 0;
}

export async function runLogout(options: Pick<LoginOptions, "platform" | "runSecurity" | "write"> = {}): Promise<number> {
  const write = options.write ?? ((text: string) => void process.stderr.write(text));
  if ((options.platform ?? process.platform) !== "darwin") {
    write("attrkit-mcp logout removes the macOS Keychain item; there is nothing to remove on this system.\n");
    return 1;
  }
  const result = await (options.runSecurity ?? defaultSecurityRunner)(["delete-generic-password", "-s", KEYCHAIN_SERVICE]);
  if (result.code === 0) {
    write("Removed the attrkit-mcp item from the macOS Keychain.\n");
    return 0;
  }
  if (result.code === 44) {
    write("No attrkit-mcp item was found in the macOS Keychain; nothing to remove.\n");
    return 0;
  }
  write(`Could not remove the attrkit-mcp item from the macOS Keychain (security exit ${result.code}). It may still be stored.\n`);
  return 1;
}
