import { readdir } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

export async function projectForFile(cwd, file) {
  if (typeof file !== 'string') return null;
  cwd = resolve(cwd);
  const target = resolve(cwd, file);
  const rel = relative(cwd, target);
  if (rel.startsWith('..') || isAbsolute(rel) || /(^|[/\\])(node_modules|\.git|vault)([/\\]|$)/.test(rel)) return null;
  if (!/\.(?:[cm]?[jt]sx?|vue|svelte|go|py|pyi|rs|cs|fs|vb|csproj|fsproj|vbproj|sln|slnx|css|scss|sass|less|json|jsonc|toml|ya?ml)$/.test(target) && !/(?:go\.(mod|sum)|Cargo\.lock)$/.test(target)) return null;
  let dir = dirname(target);
  while (true) {
    let files = []; try { files = await readdir(dir); } catch {}
    if (files.some(f => ['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'ruff.toml', '.ruff.toml', 'setup.py', 'requirements.txt'].includes(f) || /\.(slnx?|csproj|fsproj|vbproj)$/.test(f))) return dir;
    if (dir === cwd) return cwd;
    dir = dirname(dir);
  }
}
