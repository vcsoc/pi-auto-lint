import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCommands, failed } from '../detect.mjs';
import { projectForFile } from '../roots.mjs';
import { registerAutoLint } from '../runner.mjs';
async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'pi-lint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}
for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) test(`${manager} scripts take precedence without fix/format duplicates`, async t => {
  const root = await fixture(t, { 'package.json': { packageManager: `${manager}@1`, scripts: { lint: 'eslint .', 'lint:check': 'eslint .', 'lint:fix': 'eslint --fix .', typecheck: 'tsc --noEmit', format: 'prettier --write .' } } });
  const commands = await detectCommands(root);
  assert.deepEqual(commands.map(c => [c.command, c.args]), [[manager, ['run', 'lint:check']], [manager, ['run', 'typecheck']]]);
});
test('React TSX uses local tools without npx or forced extension flags', async t => {
  const root = await fixture(t, { 'package.json': { devDependencies: { eslint: '9', typescript: '5', prettier: '3' }, dependencies: { react: '19' } }, 'tsconfig.json': '{}', 'node_modules/.bin/eslint': '', 'node_modules/.bin/tsc': '', 'node_modules/.bin/prettier': '' });
  assert.deepEqual((await detectCommands(root)).map(c => c.args), [['.'], ['--noEmit'], ['--check', '.']]);
});
test('missing JS tools do not trigger downloads', async t => {
  const root = await fixture(t, { 'package.json': { devDependencies: { eslint: '9' } } });
  assert.deepEqual(await detectCommands(root), []);
});
for (const [dep, bin, args] of [['vue-tsc', 'vue-tsc', ['--noEmit']], ['svelte-check', 'svelte-check', []]]) test(`${dep} framework checking`, async t => {
  const root = await fixture(t, { 'package.json': { devDependencies: { [dep]: '1' } }, 'tsconfig.json': '{}', [`node_modules/.bin/${bin}`]: '' });
  assert.deepEqual((await detectCommands(root)).map(c => c.args), [args]);
});
test('Go uses vet or configured golangci, not both; gofmt output fails', async t => {
  const root = await fixture(t, { 'go.mod': 'module example.com/test' });
  assert.deepEqual((await detectCommands(root)).map(c => c.command), ['gofmt', 'go']);
  await writeFile(join(root, '.golangci.yml'), '');
  const commands = await detectCommands(root);
  assert.deepEqual(commands.map(c => c.command), ['gofmt', 'golangci-lint']);
  assert.equal(failed({ code: 0, stdout: 'bad.go\n' }, commands[0]), true);
  assert.equal(failed({ code: 1 }, {}), true);
});
test('Python Rust and .NET checks retained', async t => {
  const root = await fixture(t, { 'pyproject.toml': '[tool.mypy]\n[tool.ruff.format]', 'Cargo.toml': '', 'app.csproj': '' });
  assert.deepEqual((await detectCommands(root)).map(c => c.command), ['ruff', 'ruff', 'mypy', 'cargo', 'cargo', 'dotnet']);
});
test('Rust workspace checks all members', async t => {
  const root = await fixture(t, { 'Cargo.toml': '[workspace]\nmembers = ["a"]\n', 'a/Cargo.toml': '[package]\nname = "a"' });
  assert.deepEqual((await detectCommands(root)).map(c => c.args), [['fmt', '--all', '--check'], ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']]);
  assert.equal(await projectForFile(root, 'a/src/lib.rs'), join(root, 'a'));
  assert.equal(await projectForFile(root, 'rust-toolchain'), root);
  assert.equal(await projectForFile(root, 'target/debug/build/x/out.rs'), null);
});
test('Tauri app: frontend and src-tauri are separate roots; manual root lint includes backend', async t => {
  const root = await fixture(t, {
    'package.json': { scripts: { lint: 'eslint .' } },
    'src-tauri/Cargo.toml': '[package]\nname = "app"',
    'src-tauri/tauri.conf.json': { build: { frontendDist: '../dist' } },
    'src-tauri/src/main.rs': 'fn main() {}',
  });
  assert.equal(await projectForFile(root, 'src/App.tsx'), root);
  assert.equal(await projectForFile(root, 'src-tauri/src/main.rs'), join(root, 'src-tauri'));
  assert.equal(await projectForFile(root, 'src-tauri/tauri.conf.json'), join(root, 'src-tauri'));
  assert.equal(await projectForFile(root, 'src-tauri/capabilities/default.json'), join(root, 'src-tauri'));
  assert.equal(await projectForFile(root, 'src-tauri/gen/schemas/desktop-schema.json'), null);
  // Automatic frontend batch: no slow cargo checks.
  assert.deepEqual((await detectCommands(root, { nested: false })).map(c => c.command), ['npm']);
  const all = await detectCommands(root);
  assert.deepEqual(all.map(c => c.command), ['npm', 'cargo', 'cargo']);
  assert.deepEqual(all[2].args.slice(0, 3), ['clippy', '--manifest-path', join('src-tauri', 'Cargo.toml')]);
  assert.match(all[2].hint, /frontendDist "\.\.\/dist"/);
  await mkdir(join(root, 'dist'));
  const backend = await detectCommands(join(root, 'src-tauri'));
  assert.deepEqual(backend.map(c => c.args[0]), ['fmt', 'clippy']);
  assert.equal(backend[1].hint, undefined);
});
test('Tauri failure includes hint; manual root lint passes nested flag', async t => {
  const root = await fixture(t, {});
  const seen = [];
  const h = harness(root, async (_cwd, options) => { seen.push(options); return [{ name: 'cargo clippy', command: 'cargo', args: ['clippy'], hint: 'build the frontend' }]; });
  h.pi.exec = async () => ({ code: 101, stdout: '', stderr: 'frontendDist missing' });
  await h.commands.lint('', h.ctx);
  assert.deepEqual(seen, [{ nested: true }]);
  assert.match(h.messages[0][0].content, /Hint: build the frontend/);
  await h.events.tool_result({ toolName: 'edit', input: { path: 'a.rs' } }, h.ctx);
  await h.events.agent_before_settle({}, h.ctx);
  assert.deepEqual(seen[1], { nested: false });
});
test('nearest nested package and ignored paths', async t => {
  const root = await fixture(t, { 'package.json': {}, 'packages/ui/package.json': {} });
  assert.equal(await projectForFile(root, 'packages/ui/src/a.tsx'), join(root, 'packages/ui'));
  for (const path of ['README.md', 'vault/state.json', '../outside/a.ts', 'node_modules/a/a.js']) assert.equal(await projectForFile(root, path), null);
});
function harness(root, detect) {
  const events = {}, commands = {}, calls = [], messages = [], notices = [], statuses = [];
  const pi = { on: (name, fn) => events[name] = fn, registerCommand: (name, cmd) => commands[name] = cmd.handler,
    exec: async (...args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; }, sendMessage: (...args) => messages.push(args) };
  registerAutoLint(pi, detect);
  const ctx = { cwd: root, ui: { setStatus: (_key, value) => statuses.push(value), notify: (...args) => notices.push(args) } };
  return { events, commands, calls, messages, notices, statuses, ctx, pi };
}
test('many edits check once at batch end; readonly and manual consume no duplicate run', async t => {
  const root = await fixture(t, { 'package.json': { scripts: { lint: 'eslint .' } } });
  const h = harness(root);
  for (let i = 0; i < 5; i++) await h.events.tool_result({ toolName: 'edit', input: { path: `src/${i}.tsx` } }, h.ctx);
  assert.equal(h.calls.length, 0);
  await h.events.agent_before_settle({}, h.ctx);
  assert.equal(h.calls.length, 1);
  await h.events.agent_before_settle({}, h.ctx);
  assert.equal(h.calls.length, 1);
  assert.equal(h.messages.length, 0);
  await h.events.tool_result({ toolName: 'write', input: { path: 'src/new.js' } }, h.ctx);
  await h.commands.lint('', h.ctx);
  await h.events.agent_before_settle({}, h.ctx);
  assert.equal(h.calls.length, 2);
});
test('no commands is quiet, failed edits are ignored and lint-off suppresses checks', async t => {
  const root = await fixture(t, {}), h = harness(root);
  await h.events.tool_result({ toolName: 'edit', isError: true, input: { path: 'a.js' } }, h.ctx);
  await h.events.agent_before_settle({}, h.ctx);
  assert.equal(h.statuses.length, 0);
  await h.events.tool_result({ toolName: 'write', input: { path: 'a.js' } }, h.ctx);
  await h.events.agent_before_settle({}, h.ctx);
  assert.equal(h.statuses.at(-1), 'not configured');
  assert.equal(h.notices.length, 0); assert.equal(h.messages.length, 0);
  await h.commands['lint-off']('', h.ctx);
  await h.events.tool_result({ toolName: 'write', input: { path: 'a.js' } }, h.ctx);
  await h.events.agent_before_settle({}, h.ctx);
  assert.equal(h.statuses.at(-1), 'off');
});
test('real Pi exit code failures produce one next-turn summary', async t => {
  const root = await fixture(t, { 'package.json': { scripts: { lint: 'eslint .' } } }), h = harness(root);
  h.pi.exec = async () => ({ code: 1, stdout: '', stderr: 'bad lint' });
  await h.events.tool_result({ toolName: 'edit', input: { path: 'a.js' } }, h.ctx);
  await h.events.agent_before_settle({}, h.ctx);
  await h.events.agent_before_settle({}, h.ctx);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0][1].deliverAs, 'nextTurn');
});
