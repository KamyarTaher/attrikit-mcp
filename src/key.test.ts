import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createSecurityRunner, KEY_REQUIRED_MESSAGE, KEY_REQUIRED_MESSAGE_OTHER_PLATFORM, resolveApiKey, type SecurityRunner } from "./key";
import { addKeyCommand, quotedForSecurity, readHidden, runLogin, runLogout } from "./login";

// No test here reaches the real /usr/bin/security or the real Keychain: every runner is a fake.
const keychainHolds = (key: string): SecurityRunner => vi.fn(async () => ({ code: 0, stdout: `${key}\n`, stderr: "" }));
const keychainEmpty = (): SecurityRunner => vi.fn(async () => ({ code: 44, stdout: "", stderr: "not found" }));

describe("resolveApiKey", () => {
  it("returns a real env key and never asks the Keychain", async () => {
    const runSecurity = keychainHolds("sk_keychain");
    await expect(resolveApiKey({ env: { ATTRKIT_API_KEY: "sk_env" }, platform: "darwin", runSecurity })).resolves.toBe("sk_env");
    expect(runSecurity).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "   ",
    "$ATTRKIT_API_KEY",
    "${ATTRKIT_API_KEY}",
    "${ATTRKIT_API_KEY:-}",
    "${env:ATTRKIT_API_KEY}",
    "${input:attrkit-key}",
  ])("treats %j as unset and reads the Keychain", async (value) => {
    const runSecurity = keychainHolds("sk_keychain");
    await expect(resolveApiKey({ env: { ATTRKIT_API_KEY: value }, platform: "darwin", runSecurity })).resolves.toBe("sk_keychain");
    expect(runSecurity).toHaveBeenCalledWith(["find-generic-password", "-s", "attrkit-mcp", "-w"]);
  });

  it("does not treat an arbitrary $-prefixed value as a placeholder", async () => {
    const runSecurity = keychainHolds("sk_keychain");
    await expect(resolveApiKey({ env: { ATTRKIT_API_KEY: "$real_looking_secret" }, platform: "darwin", runSecurity })).resolves.toBe("$real_looking_secret");
    expect(runSecurity).not.toHaveBeenCalled();
  });

  it("reads the Keychain when the env is unset, trimming the trailing newline", async () => {
    await expect(resolveApiKey({ env: {}, platform: "darwin", runSecurity: keychainHolds("sk_keychain") })).resolves.toBe("sk_keychain");
  });

  it("explains the login command when the env and the Keychain are both empty", async () => {
    await expect(resolveApiKey({ env: {}, platform: "darwin", runSecurity: keychainEmpty() })).rejects.toThrow(KEY_REQUIRED_MESSAGE);
    expect(KEY_REQUIRED_MESSAGE).toContain("npx -y @attrkit/mcp login");
  });

  it("off macOS never touches security and points at the environment", async () => {
    const runSecurity = keychainHolds("sk_keychain");
    await expect(resolveApiKey({ env: {}, platform: "linux", runSecurity })).rejects.toThrow(KEY_REQUIRED_MESSAGE_OTHER_PLATFORM);
    expect(runSecurity).not.toHaveBeenCalled();
    expect(KEY_REQUIRED_MESSAGE_OTHER_PLATFORM).not.toContain("login");
  });
});

describe("login", () => {
  const whoamiOk = () => vi.fn(async () => new Response(JSON.stringify({ data: { plan: "growth", scope: { app_id: null, scopes: ["read", "write"] } } }), { status: 200 }));
  const base = { platform: "darwin", isTTY: true, username: "tester", env: {} } as const;

  it("refuses a key holding a quote or a newline without calling anything", async () => {
    for (const bad of ['sk_"x', "sk_x\ny", "sk_\\x"]) {
      expect(quotedForSecurity(bad)).toBeNull();
      const runSecurity = keychainEmpty();
      const fetchImpl = whoamiOk();
      const output: string[] = [];
      const code = await runLogin({ ...base, readSecret: async () => bad, runSecurity, fetchImpl, write: (t) => output.push(t) });
      expect(code).toBe(1);
      expect(runSecurity).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(output.join("")).not.toContain("sk_");
    }
  });

  it("writes the key only to the security stdin, never to argv", async () => {
    const calls: Array<{ args: readonly string[]; stdin: string | undefined }> = [];
    const runSecurity: SecurityRunner = async (args, stdin) => {
      calls.push({ args, stdin });
      return { code: 0, stdout: "security> ", stderr: "" };
    };
    const output: string[] = [];
    const code = await runLogin({ ...base, readSecret: async () => "sk_secret_value", runSecurity, fetchImpl: whoamiOk(), write: (t) => output.push(t) });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["-i"]);
    expect(calls[0]?.stdin).toBe('add-generic-password -U -s attrkit-mcp -a "tester" -w "sk_secret_value"\n');
    expect(JSON.stringify(calls[0]?.args)).not.toContain("sk_secret_value");
    expect(output.join("")).not.toContain("sk_secret_value");
    expect(output.join("")).toContain("Stored in the macOS Keychain as attrkit-mcp.");
    expect(output.join("")).toContain("growth");
  });

  it("stores nothing when the API answers 401", async () => {
    const runSecurity = keychainEmpty();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    const output: string[] = [];
    const code = await runLogin({ ...base, readSecret: async () => "sk_bad", runSecurity, fetchImpl, write: (t) => output.push(t) });
    expect(code).toBe(1);
    expect(output.join("")).toContain("refused that key");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(runSecurity).not.toHaveBeenCalled();
  });

  it("reports a refused Keychain write without echoing the key", async () => {
    const output: string[] = [];
    const runSecurity: SecurityRunner = async () => ({ code: 1, stdout: "", stderr: "security: boom sk_secret_value" });
    const code = await runLogin({ ...base, readSecret: async () => "sk_secret_value", runSecurity, fetchImpl: whoamiOk(), write: (t) => output.push(t) });
    expect(code).toBe(1);
    expect(output.join("")).not.toContain("sk_secret_value");
  });

  it("needs macOS and a TTY, and Ctrl-C exits 130", async () => {
    const readSecret = vi.fn(async () => "sk_x");
    expect(await runLogin({ ...base, platform: "linux", readSecret, write: () => {} })).toBe(1);
    expect(await runLogin({ ...base, isTTY: false, readSecret, write: () => {} })).toBe(1);
    expect(readSecret).not.toHaveBeenCalled();
    expect(await runLogin({ ...base, readSecret: async () => null, write: () => {} })).toBe(130);
  });

  it("builds the stdin line with a quoted key", () => {
    expect(addKeyCommand("me", '"k"')).toBe('add-generic-password -U -s attrkit-mcp -a "me" -w "k"\n');
  });
});

describe("logout", () => {
  it("deletes the item by service name only, and exits 0 when nothing was stored", async () => {
    const runSecurity = keychainEmpty();
    expect(await runLogout({ platform: "darwin", runSecurity, write: () => {} })).toBe(0);
    expect(runSecurity).toHaveBeenCalledWith(["delete-generic-password", "-s", "attrkit-mcp"]);
  });

  it.each([
    [0, 0, "Removed"],
    [44, 0, "nothing to remove"],
    [1, 1, "Could not remove"],
    [127, 1, "Could not remove"],
  ])("security exit %i returns %i", async (securityCode, expected, message) => {
    const output: string[] = [];
    const runSecurity: SecurityRunner = async () => ({ code: securityCode, stdout: "", stderr: "" });
    expect(await runLogout({ platform: "darwin", runSecurity, write: (t) => output.push(t) })).toBe(expected);
    expect(output.join("")).toContain(message);
    if (expected === 1) expect(output.join("")).not.toContain("Nothing was stored");
  });
});

describe("resolver edge cases", () => {
  it("treats a padded placeholder as unset", async () => {
    const runSecurity = keychainHolds("sk_keychain");
    await expect(resolveApiKey({ env: { ATTRKIT_API_KEY: "  ${ATTRKIT_API_KEY}  " }, platform: "darwin", runSecurity })).resolves.toBe("sk_keychain");
  });

  it("treats a Keychain read that exits 0 with empty output as missing", async () => {
    const runSecurity: SecurityRunner = async () => ({ code: 0, stdout: "\n", stderr: "" });
    await expect(resolveApiKey({ env: {}, platform: "darwin", runSecurity })).rejects.toThrow(KEY_REQUIRED_MESSAGE);
  });
});

describe("login edge cases", () => {
  const base = { platform: "darwin", isTTY: true, username: "tester", env: {} } as const;
  const whoamiOk = () => vi.fn(async () => new Response(JSON.stringify({ data: { plan: "growth" } }), { status: 200 }));

  it("fails when security exits 0 but wrote to stderr", async () => {
    const output: string[] = [];
    const runSecurity: SecurityRunner = async () => ({ code: 0, stdout: "", stderr: "security: SecKeychainItemCreateFromContent failed" });
    const code = await runLogin({ ...base, readSecret: async () => "sk_ok", runSecurity, fetchImpl: whoamiOk(), write: (t) => output.push(t) });
    expect(code).toBe(1);
    expect(output.join("")).toContain("Nothing was stored");
  });

  it("names the origin, not HTTP 0, when the API cannot be reached", async () => {
    const output: string[] = [];
    const runSecurity = keychainEmpty();
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const code = await runLogin({ ...base, readSecret: async () => "sk_ok", runSecurity, fetchImpl, write: (t) => output.push(t) });
    expect(code).toBe(1);
    expect(output.join("")).toContain("Could not reach https://attrikit.io to check the key. Nothing was stored.");
    expect(output.join("")).not.toContain("HTTP 0");
    expect(output.join("")).not.toContain("sk_ok");
    expect(runSecurity).not.toHaveBeenCalled();
  });
});

class FakeStdin {
  private listener: ((chunk: string) => void) | undefined;
  raw: boolean[] = [];
  paused = false;
  setRawMode(mode: boolean) { this.raw.push(mode); }
  resume() { this.paused = false; }
  pause() { this.paused = true; }
  setEncoding() {}
  on(_event: "data", listener: (chunk: string) => void) { this.listener = listener; }
  removeListener() { this.listener = undefined; }
  send(chunk: string) { this.listener?.(chunk); }
  get listening() { return this.listener !== undefined; }
}

describe("readHidden", () => {
  it("turns echo off before it prints the prompt, so a paste fired at the prompt is never echoed", async () => {
    const events: string[] = [];
    const input = new FakeStdin();
    const setRawMode = input.setRawMode.bind(input);
    input.setRawMode = (mode: boolean) => { events.push(`raw:${mode}`); setRawMode(mode); };
    const pending = readHidden(input, "p: ", (text) => events.push(`write:${text}`), 5);
    input.send("sk_key\r");
    await expect(pending).resolves.toBe("sk_key");
    expect(events.slice(0, 2)).toEqual(["raw:true", "write:p: "]);
  });

  it("drops whole escape sequences, not only the ESC", async () => {
    const input = new FakeStdin();
    const pending = readHidden(input, "p: ", () => {}, 5);
    input.send("ab\u001b[Ac\u001bOBd\u001b[1;5Ce\r");
    await expect(pending).resolves.toBe("abcde");
  });

  it("handles a sequence split across chunks and backspace", async () => {
    const input = new FakeStdin();
    const pending = readHidden(input, "p: ", () => {}, 5);
    input.send("ab\u001b");
    input.send("[");
    input.send("Axy\u007f\n");
    await expect(pending).resolves.toBe("abx");
  });

  it("keeps discarding a multi-line paste until the line is idle, then restores the terminal", async () => {
    const input = new FakeStdin();
    const pending = readHidden(input, "p: ", () => {}, 30);
    input.send("key\nrm -rf /\n");
    await new Promise((r) => setTimeout(r, 15));
    input.send("echo later\n");
    await new Promise((r) => setTimeout(r, 15));
    // 30ms of idle has not elapsed since the last chunk: the terminal is still raw and still reading.
    expect(input.listening).toBe(true);
    expect(input.raw).toEqual([true]);
    await expect(pending).resolves.toBe("key");
    expect(input.raw).toEqual([true, false]);
    expect(input.listening).toBe(false);
  });

  it("Ctrl-C resolves null at once", async () => {
    const input = new FakeStdin();
    const pending = readHidden(input, "p: ", () => {}, 5);
    input.send("ab\u0003");
    await expect(pending).resolves.toBeNull();
  });

  it.each([
    ["text", "ab\u0003"],
    ["ESC", "ab\u001b\u0003"],
    ["ESC [", "ab\u001b[\u0003"],
    ["ESC O", "ab\u001bO\u0003"],
    ["drain", "ab\r\u0003"],
  ])("Ctrl-C cancels in %s mode and cleans up once", async (_mode, chunk) => {
    const input = new FakeStdin();
    const pending = readHidden(input, "p: ", () => {}, 5);
    input.send(chunk + "more");
    await expect(pending).resolves.toBeNull();
    expect(input.raw).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(input.listening).toBe(false);
  });

  it.each([
    ["text", "ab\u0004"],
    ["ESC", "ab\u001b\u0004"],
    ["ESC [", "ab\u001b[\u0004"],
    ["ESC O", "ab\u001bO\u0004"],
    ["drain", "ab\r\u0004"],
  ])("Ctrl-D cancels in %s mode and cleans up once", async (_mode, chunk) => {
    const input = new FakeStdin();
    const pending = readHidden(input, "p: ", () => {}, 5);
    input.send(chunk + "more");
    await expect(pending).resolves.toBeNull();
    expect(input.raw).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(input.listening).toBe(false);
  });

  it("Ctrl-C arriving in a later chunk cancels mid-escape", async () => {
    const input = new FakeStdin();
    const pending = readHidden(input, "p: ", () => {}, 5);
    input.send("a\u001b[");
    input.send("\u0003");
    await expect(pending).resolves.toBeNull();
    expect(input.raw).toEqual([true, false]);
  });
  it.each([
    ["ESC+CR", "\u001b", "\r"],
    ["ESC+LF", "\u001b", "\n"],
    ["CSI+CR", "\u001b[", "\r"],
    ["CSI+LF", "\u001b[", "\n"],
    ["SS3+CR", "\u001bO", "\r"],
    ["SS3+LF", "\u001bO", "\n"],
  ])("Enter completes after %s without losing the key", async (_mode, prefix, enter) => {
    const input = new FakeStdin();
    const pending = readHidden(input, "p: ", () => {}, 5);
    input.send("ab" + prefix + enter + "trailing");
    await expect(pending).resolves.toBe("ab");
    expect(input.raw).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(input.listening).toBe(false);
  });

});

describe("createSecurityRunner", () => {
  type Done = (error: { code?: number } | null, stdout: string, stderr: string) => void;
  function fakeExec(behaviour: (done: Done, stdin: EventEmitter) => void) {
    return (_file: string, _args: string[], _options: { encoding: "utf8"; timeout: number }, done: Done) => {
      const stdin = Object.assign(new EventEmitter(), { end: () => { setImmediate(() => behaviour(done, stdin)); } });
      return { stdin };
    };
  }

  it("turns an EPIPE on stdin into a reported failure instead of an uncaught exception", async () => {
    const runner = createSecurityRunner(fakeExec((cb, stdin) => {
      stdin.emit("error", new Error("write EPIPE"));
      cb(null, "", "");
    }));
    const result = await runner(["-i"], "add-generic-password ...\n");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("could not write to security");
  });

  it("passes a clean run through unchanged", async () => {
    const runner = createSecurityRunner(fakeExec((cb) => cb(null, "out", "")));
    expect(await runner(["-i"], "x\n")).toEqual({ code: 0, stdout: "out", stderr: "" });
  });
});
