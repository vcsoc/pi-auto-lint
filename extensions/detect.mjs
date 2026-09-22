import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function detectCommands(cwd) {
  const files = await readdir(cwd);
  const has = (...names) => names.some(name => files.includes(name));
  let pkg = {};
  if (has('package.json')) pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {}, deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const manager = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager || '')?.[1]
    || (has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock', 'bun.lockb') ? 'bun' : 'npm');
  const commands = [];
  const add = (command, args, extra = {}) => commands.push({ name: [command, ...args].join(' '), command, args, ...extra });
  const script = name => add(manager, ['run', name]);
  // Only use installed binaries: no npx/bunx auto-downloads. PnP projects
  // should declare scripts, which are run via their package manager.
  const local = async (bin, args) => {
    const path = join(cwd, 'node_modules', '.bin', bin + (process.platform === 'win32' ? '.cmd' : ''));
    try { await access(path); add(path, args); } catch { /* Not installed. */ }
  };
  const lint = scripts['lint:check'] ? 'lint:check' : scripts.lint ? 'lint' : null;
  if (lint) script(lint);
  else if (has('biome.json', 'biome.jsonc')) await local('biome', ['check', '.']);
  else if (deps.eslint || files.some(f => /^(eslint\.config\.|\.eslintrc)/.test(f)) || pkg.eslintConfig) await local('eslint', ['.']);

  const typecheck = scripts.typecheck ? 'typecheck' : scripts['type-check'] ? 'type-check' : null;
  if (typecheck) script(typecheck);
  else if (deps['svelte-check']) await local('svelte-check', []);
  else if (has('tsconfig.json')) await local(deps['vue-tsc'] ? 'vue-tsc' : 'tsc', ['--noEmit']);

  if (scripts['format:check']) script('format:check');
  else if (!has('biome.json', 'biome.jsonc') && (deps.prettier || files.some(f => /^(\.prettierrc|prettier\.config\.)/.test(f)))) await local('prettier', ['--check', '.']);
  if (deps.stylelint && !lint) await local('stylelint', ['**/*.{css,scss,sass,less}']);

  if (has('go.mod')) {
    add('gofmt', ['-l', '.'], { failOnOutput: true });
    // Avoid running overlapping vet and golangci-lint checks.
    if (has('.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json')) add('golangci-lint', ['run']);
    else add('go', ['vet', './...']);
  }
  if (has('pyproject.toml', 'ruff.toml', '.ruff.toml', 'setup.py', 'requirements.txt')) {
    const text = has('pyproject.toml') ? await readFile(join(cwd, 'pyproject.toml'), 'utf8') : '';
    const venv = join(cwd, '.venv', process.platform === 'win32' ? 'Scripts/ruff.exe' : 'bin/ruff');
    let ruff = 'ruff'; try { await access(venv); ruff = venv; } catch {}
    add(ruff, ['check', '.']);
    if (/\[tool\.ruff\.format\]/.test(text)) add(ruff, ['format', '--check', '.']);
    if (/\[tool\.mypy(?:\]|\.)/.test(text) || has('mypy.ini', '.mypy.ini')) add('mypy', ['.']);
  }
  if (has('Cargo.toml')) {
    add('cargo', ['fmt', '--all', '--check']);
    add('cargo', ['clippy', '--all-targets', '--', '-D', 'warnings']);
  }
  const solution = files.find(f => /\.(sln|slnx)$/.test(f));
  const projects = files.filter(f => /\.(csproj|fsproj|vbproj)$/.test(f));
  for (const target of solution ? [solution] : projects) add('dotnet', ['format', target, '--verify-no-changes', '--no-restore']);
  return commands.filter((item, index) => commands.findIndex(other => other.command === item.command && JSON.stringify(other.args) === JSON.stringify(item.args)) === index);
}

export function failed(result, command) {
  return result.killed || result.code !== 0 || Boolean(command.failOnOutput && result.stdout?.trim());
}
