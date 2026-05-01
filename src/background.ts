import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { getLogsRoot, getWorkspaceRoot, resolveCwd } from './cli';

type BackgroundProcess = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: string;
  logFile: string;
  process: ChildProcess;
};

const processes = new Map<string, BackgroundProcess>();
const completedProcesses = new Map<string, Omit<BackgroundProcess, 'process'>>();

function safeName(name?: string) {
  const base = (name || `process-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
  return base || `process-${Date.now()}`;
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function backgroundStart(input: { command: string; cwd?: string; name?: string }) {
  const workspaceRoot = getWorkspaceRoot();
  const cwd = resolveCwd(workspaceRoot, input.cwd);
  const name = safeName(input.name);
  const id = `${Date.now()}-${name}`;
  const logsDir = path.join(getLogsRoot(), 'background');
  ensureDir(logsDir);
  const logFile = path.join(logsDir, `${id}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const child = spawn('bash', ['-lc', input.command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      CI: '1',
    },
  });

  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  const record: BackgroundProcess = {
    id,
    name,
    command: input.command,
    cwd,
    pid: child.pid ?? null,
    startedAt: new Date().toISOString(),
    logFile,
    process: child,
  };

  processes.set(id, record);

  child.on('close', (code, signal) => {
    logStream.write(`\n[process exited code=${code} signal=${signal || ''}]\n`);
    logStream.end();
    completedProcesses.set(id, {
      id: record.id,
      name: record.name,
      command: record.command,
      cwd: record.cwd,
      pid: record.pid,
      startedAt: record.startedAt,
      logFile: record.logFile,
    });
    processes.delete(id);
  });

  return {
    id,
    name,
    command: input.command,
    cwd,
    pid: record.pid,
    startedAt: record.startedAt,
    logFile,
    running: true,
  };
}

export function backgroundList() {
  return Array.from(processes.values()).map((p) => ({
    id: p.id,
    name: p.name,
    command: p.command,
    cwd: p.cwd,
    pid: p.pid,
    startedAt: p.startedAt,
    logFile: p.logFile,
    running: true,
  }));
}

export function backgroundLogs(input: { id?: string; name?: string; tailLines?: number }) {
  const process = findProcess(input) || findCompletedProcess(input);
  if (!process) return { found: false, logs: '' };

  const tailLines = Math.max(1, Math.min(Number(input.tailLines) || 100, 1000));
  let logs = '';
  try {
    logs = fs.readFileSync(process.logFile, 'utf8').split('\n').slice(-tailLines).join('\n');
  } catch {}

  return {
    found: true,
    id: process.id,
    name: process.name,
    logFile: process.logFile,
    logs,
  };
}

export function backgroundStop(input: { id?: string; name?: string }) {
  const process = findProcess(input);
  if (!process) return { stopped: false, found: Boolean(findCompletedProcess(input)), alreadyExited: Boolean(findCompletedProcess(input)) };

  if (process.pid) {
    try {
      globalThis.process.kill(-process.pid, 'SIGTERM');
    } catch {
      try {
        process.process.kill('SIGTERM');
      } catch {}
    }
  }

  setTimeout(() => {
    if (process.pid && processes.has(process.id)) {
      try {
        globalThis.process.kill(-process.pid, 'SIGKILL');
      } catch {
        try {
          process.process.kill('SIGKILL');
        } catch {}
      }
    }
  }, 1000).unref();

  return { stopped: true, found: true, id: process.id, name: process.name };
}

function findProcess(input: { id?: string; name?: string }) {
  if (input.id && processes.has(input.id)) return processes.get(input.id)!;
  if (input.name) {
    return Array.from(processes.values()).find((p) => p.name === input.name);
  }
  return undefined;
}

function findCompletedProcess(input: { id?: string; name?: string }) {
  if (input.id && completedProcesses.has(input.id)) return completedProcesses.get(input.id)!;
  if (input.name) {
    return Array.from(completedProcesses.values()).reverse().find((p) => p.name === input.name);
  }
  return undefined;
}
