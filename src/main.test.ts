import { describe, expect, it, vi } from "vitest";

import { runCli, type CliDeps } from "./main";

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    runLogin: vi.fn(async () => 7),
    runLogout: vi.fn(async () => 8),
    resolveApiKey: vi.fn(async () => "sk_test"),
    startServer: vi.fn(async () => {}),
    fail: vi.fn(),
    exit: vi.fn(),
    ...overrides,
  };
}

describe("runCli dispatch", () => {
  it("login runs login and exits with its code, without starting the server", async () => {
    const d = deps();
    await runCli(["node", "cli", "login"], d);
    expect(d.runLogin).toHaveBeenCalledOnce();
    expect(d.exit).toHaveBeenCalledWith(7);
    expect(d.startServer).not.toHaveBeenCalled();
    expect(d.resolveApiKey).not.toHaveBeenCalled();
  });

  it("logout runs logout and exits with its code", async () => {
    const d = deps();
    await runCli(["node", "cli", "logout"], d);
    expect(d.runLogout).toHaveBeenCalledOnce();
    expect(d.exit).toHaveBeenCalledWith(8);
    expect(d.runLogin).not.toHaveBeenCalled();
    expect(d.startServer).not.toHaveBeenCalled();
  });

  it("with no argument resolves the key and starts the server with it", async () => {
    const d = deps();
    await runCli(["node", "cli"], d);
    expect(d.startServer).toHaveBeenCalledWith({ apiKey: "sk_test", apiUrl: (process.env.ATTRKIT_API_URL?.trim() ? process.env.ATTRKIT_API_URL : "https://attrikit.io").replace(/\/+$/, "") });
    expect(d.runLogin).not.toHaveBeenCalled();
    expect(d.exit).not.toHaveBeenCalled();
  });

  it("an unresolved key fails with exit 1 and never starts the server", async () => {
    const d = deps({ resolveApiKey: vi.fn(async () => { throw new Error("ATTRKIT_API_KEY is required"); }) });
    await runCli(["node", "cli"], d);
    expect(d.fail).toHaveBeenCalledWith("ATTRKIT_API_KEY is required", 1);
    expect(d.startServer).not.toHaveBeenCalled();
  });

  it("writes nothing to stdout before the transport connects", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    try {
      const d = deps({ startServer: vi.fn(async () => { expect(stdout).not.toHaveBeenCalled(); }) });
      await runCli(["node", "cli"], d);
      expect(d.startServer).toHaveBeenCalledOnce();
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
    }
  });
});
