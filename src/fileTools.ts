import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { resolveWorkspacePath } from './workspaces';

const SECRET_FILE_PATTERNS = [/^\.env(\..*)?$/i, /secret/i, /private[-_]?key/i];
const SECRET_VALUE_PATTERNS = [
  /(OPENAI_API_KEY|ANTHROPIC_API_KEY|DATABASE_URL|JWT_SECRET|PRIVATE_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|[^\s=]*TOKEN|[^\s=]*SECRET|[^\s=]*PASSWORD)\s*=\s*[^\n\r]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function isInside(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function assertSafeFile(filePath: string, allowSecrets = false) {
  const base = path.basename(filePath);
  if (!allowSecrets && SECRET_FILE_PATTERNS.some((pattern) => pattern.test(base) || pattern.test(filePath))) {
    throw new Error(`refusing to access likely secret file: ${filePath}`);
  }
}

export function maskSecrets(value: string) {
  let output = value || '';
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, (match) => {
      const key = match.split('=')[0]?.trim();
      return key && match.includes('=') ? `${key}=[REDACTED]` : '[REDACTED_SECRET]';
    });
  }
  return output;
}

function truncate(value: string, maxChars = Number(process.env.FILE_TOOL_MAX_CHARS || 200000)) {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + `\n\n[File output truncated: original length ${value.length} chars]`;
}

export function readFileTool(input: { path: string; maxChars?: number; allowSecrets?: boolean }) {
  const target = resolveWorkspacePath(input.path);
  assertSafeFile(target, Boolean(input.allowSecrets));
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`not a file: ${target}`);
  const content = fs.readFileSync(target, 'utf8');
  return { path: target, sizeBytes: stat.size, content: maskSecrets(truncate(content, input.maxChars)) };
}

export function writeFileTool(input: { path: string; content: string; overwrite?: boolean; allowSecrets?: boolean }) {
  const target = resolveWorkspacePath(input.path);
  assertSafeFile(target, Boolean(input.allowSecrets));
  if (fs.existsSync(target) && !input.overwrite) throw new Error(`file exists; pass overwrite=true to replace: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, input.content, 'utf8');
  return { path: target, bytesWritten: Buffer.byteLength(input.content), overwritten: fs.existsSync(target) };
}

export function editFileTool(input: { path: string; search: string; replace: string; expectedReplacements?: number; allowSecrets?: boolean }) {
  const target = resolveWorkspacePath(input.path);
  assertSafeFile(target, Boolean(input.allowSecrets));
  const before = fs.readFileSync(target, 'utf8');
  const parts = before.split(input.search);
  const replacements = parts.length - 1;
  if (replacements === 0) throw new Error('search text not found');
  if (input.expectedReplacements !== undefined && replacements !== input.expectedReplacements) {
    throw new Error(`expected ${input.expectedReplacements} replacements, found ${replacements}`);
  }
  const backupPath = `${target}.bak-${Date.now()}`;
  fs.writeFileSync(backupPath, before, 'utf8');
  const after = parts.join(input.replace);
  fs.writeFileSync(target, after, 'utf8');
  return { path: target, backupPath, replacements };
}

export function listFilesTool(input: { path?: string; depth?: number; limit?: number }) {
  const root = resolveWorkspacePath(input.path || '.');
  const maxDepth = Math.max(1, Math.min(Number(input.depth) || 2, 8));
  const limit = Math.max(1, Math.min(Number(input.limit) || 200, 2000));
  const results: any[] = [];
  function walk(dir: string, depth: number) {
    if (depth < 0 || results.length >= limit) return;
    for (const name of fs.readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', 'build', '.next'].includes(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      results.push({ path: full, relativePath: path.relative(root, full), type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', sizeBytes: stat.size });
      if (stat.isDirectory()) walk(full, depth - 1);
      if (results.length >= limit) break;
    }
  }
  walk(root, maxDepth);
  return { root, count: results.length, files: results };
}

export async function searchFilesTool(input: { cwd?: string; query: string; glob?: string; limit?: number }) {
  const cwd = resolveWorkspacePath(input.cwd || '.');
  const args = ['--line-number', '--hidden', '--glob', '!node_modules', '--glob', '!dist', '--glob', '!build', '--glob', '!.git'];
  if (input.glob) args.push('--glob', input.glob);
  args.push(input.query, '.');
  const result = await execa('rg', args, { cwd, reject: false, timeout: 30000 });
  const lines = maskSecrets(result.stdout).split('\n').filter(Boolean).slice(0, Math.max(1, Math.min(Number(input.limit) || 100, 1000)));
  return { cwd, query: input.query, count: lines.length, matches: lines };
}

export async function gitStatusTool(input: { cwd?: string }) {
  const cwd = resolveWorkspacePath(input.cwd || '.');
  const result = await execa('git', ['status', '--short', '--branch'], { cwd, reject: false, timeout: 10000 });
  return { cwd, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

export async function gitDiffTool(input: { cwd?: string; staged?: boolean; maxChars?: number }) {
  const cwd = resolveWorkspacePath(input.cwd || '.');
  const args = ['diff'];
  if (input.staged) args.push('--staged');
  const result = await execa('git', args, { cwd, reject: false, timeout: 30000 });
  return { cwd, exitCode: result.exitCode, diff: maskSecrets(truncate(result.stdout, input.maxChars || 200000)), stderr: result.stderr };
}
