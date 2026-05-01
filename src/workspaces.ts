import fs from 'node:fs';
import path from 'node:path';

export function getCodebaseRoot() {
  return process.env.CODEBASE_ROOT || process.env.LEGACY_CODEBASE_ROOT || process.env.WORKSPACE_ROOT || '/codebase';
}

export function getWorkspaceRoot() {
  if (process.env.CODEBASE_ROOT) {
    return process.env.WORKSPACE_ROOT || '/workspace';
  }
  return process.env.WORKSPACES_ROOT || process.env.WORKSPACE_ROOT || '/workspace';
}

export function getAgentHomeRoot() {
  return process.env.AGENT_HOME_ROOT || '/agent-home';
}

export type WorkspaceRoot = {
  name: string;
  path: string;
  exists: boolean;
  writable: boolean;
};

export function ensureAgentHome() {
  const home = getAgentHomeRoot();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
  return home;
}

function uniquePaths(paths: Array<{ name: string; path: string }>) {
  const seen = new Set<string>();
  const result: Array<{ name: string; path: string }> = [];
  for (const item of paths) {
    const resolved = path.resolve(item.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push({ name: item.name, path: resolved });
  }
  return result;
}

function isWritable(dir: string) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function getAllowedRoots(): WorkspaceRoot[] {
  return uniquePaths([
    { name: 'codebase', path: getCodebaseRoot() },
    { name: 'workspace', path: getWorkspaceRoot() },
    { name: 'agent-home', path: getAgentHomeRoot() },
  ]).map((item) => ({
    ...item,
    exists: fs.existsSync(item.path),
    writable: fs.existsSync(item.path) ? isWritable(item.path) : false,
  }));
}

function isInside(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function stripAlias(value: string, aliases: string[]) {
  for (const alias of aliases) {
    if (value === alias) return '';
    if (value.startsWith(alias + '/')) return value.slice(alias.length + 1);
  }
  return null;
}

export function resolveWorkspacePath(inputPath?: string) {
  const value = (inputPath || '.').trim() || '.';
  const codebaseRoot = getCodebaseRoot();
  const workspaceRoot = getWorkspaceRoot();
  const agentHomeRoot = getAgentHomeRoot();

  let candidate: string;

  const homeRemainder = stripAlias(value, ['@home', '@agent-home', '~']);
  const codebaseRemainder = stripAlias(value, ['@codebase', '@code']);
  const workspaceRemainder = stripAlias(value, ['@workspace']);

  if (homeRemainder !== null) {
    candidate = path.resolve(agentHomeRoot, homeRemainder);
  } else if (codebaseRemainder !== null) {
    candidate = path.resolve(codebaseRoot, codebaseRemainder);
  } else if (workspaceRemainder !== null) {
    candidate = path.resolve(workspaceRoot, workspaceRemainder);
  } else if (path.isAbsolute(value)) {
    candidate = path.resolve(value);
  } else {
    candidate = path.resolve(codebaseRoot, value);
  }

  const allowedRoots = getAllowedRoots().map((root) => root.path);
  if (!allowedRoots.some((root) => isInside(root, candidate))) {
    throw new Error(`path is outside allowed roots: ${candidate}`);
  }

  return candidate;
}

function summarizePath(dir: string) {
  const exists = fs.existsSync(dir);
  const stat = exists ? fs.statSync(dir) : null;
  const files = exists && stat?.isDirectory()
    ? fs.readdirSync(dir).filter((name) => !['node_modules', '.git', 'dist', 'build', '.next'].includes(name)).slice(0, 200)
    : [];

  return {
    path: dir,
    exists,
    type: stat?.isDirectory() ? 'directory' : stat?.isFile() ? 'file' : exists ? 'other' : 'missing',
    writable: exists && stat?.isDirectory() ? isWritable(dir) : false,
    files,
  };
}

export function workspaceSelect(input: { path?: string }) {
  const resolved = resolveWorkspacePath(input.path || '.');
  return {
    selectedPath: resolved,
    cwdForCli: resolved,
    aliases: {
      '@codebase/': getCodebaseRoot(),
      '@workspace/': getWorkspaceRoot(),
      '@home/': getAgentHomeRoot(),
    },
    summary: summarizePath(resolved),
    usage: 'Use this selectedPath as cwd in subsequent cli/background/browser-related tool calls for this chat.',
  };
}

export function workspaceList(input: { depth?: number } = {}) {
  const depth = Math.max(1, Math.min(Number(input.depth) || 2, 5));
  const roots = getAllowedRoots();

  const candidates = roots.map((root) => {
    const entries: any[] = [];
    if (root.exists) {
      collectDirs(root.path, depth, entries, root.path);
    }
    return { ...root, entries };
  });

  return { roots, candidates };
}

function collectDirs(current: string, depth: number, entries: any[], base: string) {
  if (depth <= 0) return;
  let names: string[] = [];
  try {
    names = fs.readdirSync(current);
  } catch {
    return;
  }

  for (const name of names) {
    if (['node_modules', '.git', 'dist', 'build', '.next', 'logs'].includes(name)) continue;
    if (name.startsWith('.') && name !== '.ai-agent') continue;

    const fullPath = path.join(current, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const hasGit = fs.existsSync(path.join(fullPath, '.git'));
    const hasPackageJson = fs.existsSync(path.join(fullPath, 'package.json'));
    entries.push({
      name,
      path: fullPath,
      relativePath: path.relative(base, fullPath),
      hasGit,
      hasPackageJson,
    });

    if (!hasGit && depth > 1) {
      collectDirs(fullPath, depth - 1, entries, base);
    }
  }
}

export function agentHomeInfo() {
  const home = ensureAgentHome();
  return {
    path: home,
    notesPath: path.join(home, 'notes'),
    exists: fs.existsSync(home),
    writable: isWritable(home),
    files: fs.readdirSync(home).slice(0, 200),
  };
}

function resolveAgentHomeRelative(inputPath: string) {
  const home = getAgentHomeRoot();
  const target = path.resolve(home, inputPath || '.');
  if (!isInside(home, target)) {
    throw new Error('path is outside agent home');
  }
  return target;
}

export function noteWrite(input: { path: string; content: string; append?: boolean }) {
  const relative = input.path.startsWith('notes/') ? input.path : path.join('notes', input.path);
  const target = resolveAgentHomeRelative(relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (input.append) {
    fs.appendFileSync(target, input.content);
  } else {
    fs.writeFileSync(target, input.content);
  }
  return { written: true, path: target, bytes: Buffer.byteLength(input.content) };
}

export function noteRead(input: { path: string; maxChars?: number }) {
  const relative = input.path.startsWith('notes/') ? input.path : path.join('notes', input.path);
  const target = resolveAgentHomeRelative(relative);
  const maxChars = Math.max(1000, Math.min(Number(input.maxChars) || 100000, 500000));
  if (!fs.existsSync(target)) return { found: false, path: target, content: '' };
  let content = fs.readFileSync(target, 'utf8');
  const originalLength = content.length;
  if (content.length > maxChars) content = content.slice(-maxChars);
  return { found: true, path: target, truncated: content.length < originalLength, content };
}

export function noteList(input: { path?: string } = {}) {
  const relative = input.path ? (input.path.startsWith('notes/') ? input.path : path.join('notes', input.path)) : 'notes';
  const target = resolveAgentHomeRelative(relative);
  if (!fs.existsSync(target)) return { path: target, exists: false, entries: [] };
  const entries = fs.readdirSync(target).map((name) => {
    const fullPath = path.join(target, name);
    const stat = fs.statSync(fullPath);
    return {
      name,
      path: fullPath,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  });
  return { path: target, exists: true, entries };
}
