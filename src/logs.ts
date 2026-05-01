import fs from 'node:fs';
import path from 'node:path';
import { getLogsRoot } from './cli';

export function resolveInsideLogsRoot(inputPath: string) {
  const root = path.resolve(getLogsRoot());
  const cleanInput = String(inputPath || '.').replace(/^\/+/, '');
  const resolved = path.resolve(root, cleanInput);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('log path is outside logs root');
  }
  return resolved;
}

function relativeLogPath(file: string) {
  return path.relative(path.resolve(getLogsRoot()), file).split(path.sep).join('/');
}

export function listLogs(input: { path?: string } = {}) {
  const logsRoot = getLogsRoot();
  const target = resolveInsideLogsRoot(input.path || '.');

  if (!fs.existsSync(target)) {
    return { logsRoot, path: input.path || '.', exists: false, entries: [] };
  }

  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    return {
      logsRoot,
      path: input.path || '.',
      exists: true,
      entries: [
        {
          name: path.basename(target),
          path: relativeLogPath(target) || '.',
          type: 'file',
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        },
      ],
    };
  }

  const entries = fs.readdirSync(target).map((name) => {
    const fullPath = path.join(target, name);
    const entryStat = fs.statSync(fullPath);
    return {
      name,
      path: relativeLogPath(fullPath) || '.',
      type: entryStat.isDirectory() ? 'directory' : 'file',
      size: entryStat.size,
      modifiedAt: entryStat.mtime.toISOString(),
    };
  });

  return { logsRoot, path: input.path || '.', exists: true, entries };
}

export function readLog(input: { path: string; tailLines?: number; maxChars?: number }) {
  const file = resolveInsideLogsRoot(input.path);
  if (!fs.existsSync(file)) return { found: false, path: input.path, content: '' };
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('log path is not a file');

  const tailLines = input.tailLines ? Math.max(1, Math.min(Number(input.tailLines), 5000)) : null;
  const maxChars = Math.max(1000, Math.min(Number(input.maxChars) || 100000, 500000));
  let content = fs.readFileSync(file, 'utf8');

  if (tailLines) {
    content = content.split('\n').slice(-tailLines).join('\n');
  }

  const originalLength = content.length;
  if (content.length > maxChars) {
    content = content.slice(-maxChars);
  }

  return {
    found: true,
    path: input.path,
    absolutePath: file,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    truncated: originalLength > content.length,
    content,
  };
}

export function getContentType(file: string) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.txt' || ext === '.log') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export function artifactInfo(input: { path: string }) {
  const file = resolveInsideLogsRoot(input.path);
  if (!fs.existsSync(file)) return { found: false, path: input.path };
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('artifact path is not a file');

  const relativePath = relativeLogPath(file);
  const publicOrigin = process.env.MCP_PUBLIC_ORIGIN || '';
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
  const publicUrl = publicOrigin ? `${publicOrigin}/artifacts/${encodedPath}` : `/artifacts/${encodedPath}`;

  return {
    found: true,
    path: relativePath,
    absolutePath: file,
    publicUrl,
    contentType: getContentType(file),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}
