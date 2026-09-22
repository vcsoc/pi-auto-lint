import { detectCommands, failed } from './detect.mjs';
import { projectForFile } from './roots.mjs';

export function registerAutoLint(pi, detect = detectCommands) {
  let enabled = true, running = false, stopped = false, abort;
  let lastSummary = 'Not run yet.';
  const pending = new Set();
  const status = (ctx, text) => ctx.ui?.setStatus?.('auto-lint', text);
  async function run(ctx, manual = false) {
    if (!enabled || stopped || running) return;
    const roots = [...pending]; pending.clear();
    if (!roots.length && manual) roots.push(ctx.cwd);
    if (!roots.length) return;
    running = true; abort = new AbortController();
    status(ctx, 'checking…');
    const results = [], failures = [];
    let count = 0;
    try {
      for (const cwd of roots) {
        try {
          const commands = await detect(cwd);
          if (!commands.length) { results.push(`Not configured: ${cwd}. Add a lint script or install/configure a supported checker.`); continue; }
          for (const item of commands) {
            if (!enabled || stopped) return;
            count++;
            const result = await pi.exec(item.command, item.args, { cwd, signal: abort.signal, timeout: 120000 });
            if (stopped || !enabled) return;
            const output = (result.stdout + result.stderr).slice(-4000);
            if (failed(result, item)) {
              failures.push(`${cwd}: ${item.name}\n${output || 'Failed or timed out.'}`);
              break;
            }
            results.push(`✓ ${cwd}: ${item.name}`);
          }
        } catch (error) {
          if (stopped || !enabled) return;
          failures.push(`${cwd}: check unavailable: ${error.message}. Install/configure the required tools.`);
        }
      }
      lastSummary = [...results, ...failures].join('\n');
      if (failures.length) {
        status(ctx, 'failed');
        pi.sendMessage({ customType: 'auto-lint', display: true, content: `Auto-lint failures:\n${failures.join('\n').slice(-6000)}` }, { deliverAs: 'nextTurn' });
      } else {
        status(ctx, count ? `passed (${count})` : 'not configured');
      }
      if (manual) ctx.ui?.notify?.(lastSummary, failures.length ? 'warning' : 'info');
    } finally {
      running = false; abort = undefined;
    }
  }
  pi.on('session_start', (_event, ctx) => { stopped = false; status(ctx, 'on · batch checks'); });
  pi.on('session_shutdown', (_event, ctx) => { stopped = true; pending.clear(); abort?.abort(); status(ctx, undefined); });
  pi.on('tool_result', async (event, ctx) => {
    if (!enabled || stopped || event.isError || !['edit', 'write'].includes(event.toolName)) return;
    const root = await projectForFile(ctx.cwd, event.input?.path);
    if (root) { pending.add(root); status(ctx, 'pending · batch end'); }
  });
  // No timers, no per-tool checks, no automatic agent continuation loop.
  pi.on('agent_before_settle', async (_event, ctx) => { await run(ctx); });
  pi.registerCommand('lint', { description: 'Run pending project checks, or current directory checks', handler: async (_args, ctx) => { await run(ctx, true); } });
  pi.registerCommand('lint-on', { description: 'Enable batch automatic lint', handler: async (_args, ctx) => { enabled = true; status(ctx, 'on · batch checks'); } });
  pi.registerCommand('lint-off', { description: 'Disable automatic lint', handler: async (_args, ctx) => { enabled = false; pending.clear(); abort?.abort(); status(ctx, 'off'); } });
  pi.registerCommand('lint-status', { description: 'Show last lint result without rerunning', handler: async (_args, ctx) => {
    ctx.ui?.notify?.(`Auto-lint ${enabled ? 'on' : 'off'}; ${pending.size} pending project(s)\n${lastSummary}`, 'info');
  } });
}
