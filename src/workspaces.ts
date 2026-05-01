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

export function getRootsConfigPaths() {
  return (process.env.AGENT_ROOTS_CONFIG || '/app/config/roots.json:/app/config/roots.local.json')
    .split(':')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getRootsConfigPath() {
  return getRootsConfigPaths()[0];
}

export type WorkspaceRoot = {
  name: string;
  path: string;
  exists: boolean;
  writable: boolean;
  aliases?: string[];
  description?: string;
  source?: 'built-in' | 'config';
};

type RootDefinition = {
  name: string;
  path: string;
  aliases: string[];
  description?: string;
  source: 'built-in' | 'config';
};

type RootsConfig = {
  roots?: Array<{
    name?: unknown;
    path?: unknown;
    aliases?: unknown;
    description?: unknown;
  }>;
};

export function ensureAgentHome() {
  const home = getAgentHomeRoot();
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
  return home;
}

function normalizeAlias(alias: string) {
  const trimmed = alias.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('@') || trimmed === '~' ? trimmed : `@${trimmed}`;
}

function defaultRootDefinitions(): RootDefinition[] {
  return [];
}

function readRootsConfigs(): Array<{ path: string; config: RootsConfig }> {
  return getRootsConfigPaths().flatMap((configPath) => {
    if (!fs.existsSync(configPath)) return [];

    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return [{ path: configPath, config: parsed && typeof parsed === 'object' ? parsed : {} }];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse roots config ${configPath}: ${message}`);
    }
  });
}

function configRootDefinitions(): RootDefinition[] {
  return readRootsConfigs().flatMap(({ path: configPath, config }) => {
    if (!Array.isArray(config.roots)) return [];

    return config.roots.flatMap((root, index) => {
    if (!root || typeof root.name !== 'string' || typeof root.path !== 'string') {
        throw new Error(`invalid root at roots[${index}] in ${configPath}: name and path must be strings`);
    }

      const aliases = Array.isArray(root.aliases)
        ? root.aliases.filter((alias): alias is string => typeof alias === 'string').map(normalizeAlias).filter(Boolean)
        : [`@${root.name}`];

      return [{
        name: root.name,
        path: root.path,
        aliases,
        description: typeof root.description === 'string' ? root.description : undefined,
        source: 'config' as const,
      }];
    });
  });
}

export function getRootDefinitions(): RootDefinition[] {
  const definitions = [...defaultRootDefinitions(), ...configRootDefinitions()];
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  const seenAliases = new Set<string>();
  const result: RootDefinition[] = [];

  for (const definition of definitions) {
    const resolvedPath = path.resolve(definition.path);
    if (seenNames.has(definition.name)) {
      throw new Error(`duplicate root name in roots config: ${definition.name}`);
    }
    if (seenPaths.has(resolvedPath)) continue;

    const aliases = definition.aliases.map(normalizeAlias).filter(Boolean);
    for (const alias of aliases) {
      if (seenAliases.has(alias)) {
        throw new Error(`duplicate root alias in roots config: ${alias}`);
      }
    }

    seenNames.add(definition.name);
    seenPaths.add(resolvedPath);
    aliases.forEach((alias) => seenAliases.add(alias));
    result.push({ ...definition, path: resolvedPath, aliases });
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
  return getRootDefinitions().map((item) => ({
    name: item.name,
    path: item.path,
    aliases: item.aliases,
    description: item.description,
    source: item.source,
    exists: fs.existsSync(item.path),
    writable: fs.existsSync(item.path) ? isWritable(item.path) : false,
  }));
}

export function getRootAliases() {
  return Object.fromEntries(
    getRootDefinitions().flatMap((root) => root.aliases.map((alias) => [`${alias}/`, root.path])),
  );
}

export function getGuideRoots() {
  return Object.fromEntries(
    getRootDefinitions().map((root) => [root.aliases[0] || `@${root.name}`, {
      path: root.path,
      description: root.description || `Configured root: ${root.name}`,
      aliases: root.aliases,
      source: root.source,
    }]),
  );
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
  const rootDefinitions = getRootDefinitions();

  let candidate: string | null = null;

  for (const root of rootDefinitions) {
    const remainder = stripAlias(value, root.aliases);
    if (remainder !== null) {
      candidate = path.resolve(root.path, remainder);
      break;
    }
  }

  if (candidate === null) {
    candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(getCodebaseRoot(), value);
  }

  const allowedRoots = rootDefinitions.map((root) => root.path);
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
    aliases: getRootAliases(),
    rootsConfigPaths: getRootsConfigPaths(),
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

  return { rootsConfigPaths: getRootsConfigPaths(), roots, candidates };
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
    rootsConfigPaths: getRootsConfigPaths(),
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
