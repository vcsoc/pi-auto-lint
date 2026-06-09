import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

type LintCommand = {
  name: string;
  command: string;
  args: string[];
};

const DEBOUNCE_MS = 2500;
const MAX_OUTPUT_CHARS = 12000;

let enabled = true;
let timer: NodeJS.Timeout | undefined;
let running = false;
let queued = false;
let lastSummary = "not run yet";

function setAutoLintStatus(ctx: any, text?: string) {
  // Use setStatus only. It appends this extension's keyed status entry to pi's
  // built-in footer/status area instead of replacing the entire footer.
  ctx.ui?.setStatus?.("auto-lint", text);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function hasFileWithExtension(dir: string, extension: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith(extension));
  } catch {
    return false;
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(-MAX_OUTPUT_CHARS) + "\n\n[auto-lint: output truncated]";
}

async function detectCommands(cwd: string): Promise<LintCommand[]> {
  const commands: LintCommand[] = [];

  const packageJsonPath = join(cwd, "package.json");
  const packageJson = await readJson(packageJsonPath);

  if (packageJson?.scripts) {
    const scripts = packageJson.scripts;

    if (scripts.lint) {
      commands.push({ name: "npm lint", command: "npm", args: ["run", "lint"] });
    }

    if (scripts["lint:fix"]) {
      commands.unshift({ name: "npm lint:fix", command: "npm", args: ["run", "lint:fix"] });
    }

    if (scripts.typecheck) {
      commands.push({ name: "npm typecheck", command: "npm", args: ["run", "typecheck"] });
    }

    if (scripts.format) {
      commands.push({ name: "npm format", command: "npm", args: ["run", "format"] });
    }
  }

  if (await exists(join(cwd, "pyproject.toml"))) {
    commands.push({ name: "ruff check", command: "ruff", args: ["check", "."] });
  }

  if (await exists(join(cwd, "Cargo.toml"))) {
    commands.push({ name: "cargo fmt check", command: "cargo", args: ["fmt", "--check"] });
    commands.push({ name: "cargo clippy", command: "cargo", args: ["clippy", "--", "-D", "warnings"] });
  }

  if (
    await exists(join(cwd, "global.json")) ||
    await hasFileWithExtension(cwd, ".sln") ||
    await hasFileWithExtension(cwd, ".csproj")
  ) {
    commands.push({ name: "dotnet format check", command: "dotnet", args: ["format", "--verify-no-changes"] });
  }

  return commands;
}

async function runLint(pi: ExtensionAPI, ctx: any, reason: string) {
  if (!enabled) return;

  if (running) {
    queued = true;
    return;
  }

  running = true;
  queued = false;

  try {
    setAutoLintStatus(ctx, "linting…");

    const commands = await detectCommands(ctx.cwd);

    if (commands.length === 0) {
      lastSummary = "No known lint command found.";
      ctx.ui?.notify?.("auto-lint: no lint command found", "warn");
      return;
    }

    const results: string[] = [];

    for (const item of commands) {
      const result = await pi.exec(item.command, item.args, {
        cwd: ctx.cwd,
        signal: ctx.signal,
      });

      const output = truncate(String(result?.stdout ?? result?.output ?? "") + String(result?.stderr ?? ""));

      if (result?.exitCode && result.exitCode !== 0) {
        lastSummary = `FAILED: ${item.name}\n\n${output}`;
        ctx.ui?.notify?.(`auto-lint failed: ${item.name}`, "error");

        pi.sendMessage({
          customType: "auto-lint",
          display: true,
          content: `## auto-lint failed\n\nReason: ${reason}\n\nCommand: \`${item.command} ${item.args.join(" ")}\`\n\n\`\`\`\n${output}\n\`\`\``,
          details: { command: item, output },
        });

        return;
      }

      results.push(`✓ ${item.name}`);
    }

    lastSummary = results.join("\n");
    ctx.ui?.notify?.("auto-lint passed", "info");

    pi.sendMessage({
      customType: "auto-lint",
      display: true,
      content: `## auto-lint passed\n\nReason: ${reason}\n\n${lastSummary}`,
      details: { results },
    });
  } catch (err: any) {
    lastSummary = `auto-lint error: ${err?.message ?? String(err)}`;
    ctx.ui?.notify?.(lastSummary, "error");
  } finally {
    running = false;
    setAutoLintStatus(ctx, enabled ? "on" : "off");

    if (queued) {
      queued = false;
      await runLint(pi, ctx, "queued changes");
    }
  }
}

function scheduleLint(pi: ExtensionAPI, ctx: any, reason: string) {
  if (!enabled) return;

  if (timer) clearTimeout(timer);

  timer = setTimeout(() => {
    void runLint(pi, ctx, reason);
  }, DEBOUNCE_MS);
}

export default function autoLint(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    setAutoLintStatus(ctx, enabled ? "on" : "off");
    ctx.ui?.notify?.("auto-lint loaded", "info");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    setAutoLintStatus(ctx, undefined);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!enabled) return;

    const changedFile =
      event.toolName === "write" ||
      event.toolName === "edit";

    if (!changedFile) return;

    scheduleLint(pi, ctx, `${event.toolName} completed`);
  });

  pi.registerCommand("lint", {
    description: "Run detected project lint/typecheck/format checks now",
    handler: async (_args, ctx) => {
      await runLint(pi, ctx, "manual /lint");
    },
  });

  pi.registerCommand("lint-on", {
    description: "Enable auto-lint",
    handler: async (_args, ctx) => {
      enabled = true;
      setAutoLintStatus(ctx, "on");
      ctx.ui?.notify?.("auto-lint enabled", "info");
    },
  });

  pi.registerCommand("lint-off", {
    description: "Disable auto-lint",
    handler: async (_args, ctx) => {
      enabled = false;
      setAutoLintStatus(ctx, "off");
      ctx.ui?.notify?.("auto-lint disabled", "warn");
    },
  });

  pi.registerCommand("lint-status", {
    description: "Show last auto-lint result",
    handler: async (_args, ctx) => {
      ctx.ui?.notify?.(`auto-lint is ${enabled ? "on" : "off"}`, "info");
      pi.sendMessage({
        customType: "auto-lint",
        display: true,
        content: `## auto-lint status\n\nEnabled: ${enabled}\n\nLast result:\n\n\`\`\`\n${lastSummary}\n\`\`\``,
        details: { enabled, lastSummary },
      });
    },
  });
}
