import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execa } from 'execa';
import { resolveWorkspacePath, getCodebaseRoot, getWorkspaceRoot as getMountedWorkspaceRoot, getAgentHomeRoot, getAllowedRoots } from './workspaces';
import { maskSecrets } from './fileTools';

export type CommandResult = {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export function getWorkspaceRoot() {
  return getCodebaseRoot();
}

export function getProjectsWorkspaceRoot() {
  return getMountedWorkspaceRoot();
}

export function getAgentHome() {
  return getAgentHomeRoot();
}

export function getLogsRoot() {
  return process.env.LOGS_ROOT || '/app/logs';
}

export function resolveCwd(_workspaceRoot: string, cwd?: string) {
  return resolveWorkspacePath(cwd || '.');
}

function truncate(value: string) {
  const max = Number(process.env.MAX_OUTPUT_CHARS || 200000);
  if (value.length <= max) return value;
  return value.slice(0, max) + `\n\n[Output truncated: original length ${value.length} chars]`;
}

function getTimeoutMs(inputTimeoutMs?: number) {
  const defaultTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS || 120000);
  const maxTimeoutMs = Number(process.env.MAX_COMMAND_TIMEOUT_MS || 300000);
  const requestedTimeoutMs = inputTimeoutMs || defaultTimeoutMs;

  if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
    return defaultTimeoutMs;
  }

  return Math.min(requestedTimeoutMs, maxTimeoutMs);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function commandLogPath() {
  return path.join(getLogsRoot(), 'commands.jsonl');
}

function appendCommandLog(result: CommandResult) {
  try {
    ensureDir(getLogsRoot());
    const entry = {
      timestamp: new Date().toISOString(),
      command: result.command,
      cwd: result.cwd,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutBytes: Buffer.byteLength(result.stdout || ''),
      stderrBytes: Buffer.byteLength(result.stderr || ''),
    };
    fs.appendFileSync(commandLogPath(), JSON.stringify(entry) + '\n');
  } catch (error) {
    console.error('Failed to append command log:', error);
  }
}

export function recentCommands(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
  try {
    const file = commandLogPath();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-safeLimit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

export async function runCliTool(input: { command: string; cwd?: string; timeoutMs?: number }) {
  const workspaceRoot = getWorkspaceRoot();
  const cwd = resolveCwd(workspaceRoot, input.cwd);
  const timeoutMs = getTimeoutMs(input.timeoutMs);
  const startedAt = Date.now();

  return await new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

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

    const finish = (exitCode: number | null, signal?: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      const result: CommandResult = {
        command: input.command,
        cwd,
        exitCode,
        stdout: maskSecrets(truncate(stdout)),
        stderr: maskSecrets(truncate(stderr)),
        durationMs: Date.now() - startedAt,
        timedOut,
      };

      console.log(
        `[CLI] command="${input.command}" cwd="${cwd}" exitCode=${exitCode} signal=${signal || ''} timedOut=${timedOut} durationMs=${result.durationMs}`
      );
      appendCommandLog(result);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          try {
            child.kill('SIGTERM');
          } catch {}
        }

        setTimeout(() => {
          if (!settled && child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              try {
                child.kill('SIGKILL');
              } catch {}
            }
          }
        }, 500).unref();
      }
    }, timeoutMs);
    timeout.unref();

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      stderr += error.message;
      finish(null, null);
    });

    child.on('close', (code, signal) => {
      finish(timedOut ? null : code, signal);
    });
  });
}

async function commandExists(bin: string) {
  try {
    const { stdout } = await execa(bin, ['--version'], { reject: false, timeout: 5000 });
    return stdout.trim() || 'installed';
  } catch {
    return 'not found';
  }
}

async function detectGit(workspaceRoot: string) {
  try {
    await execa('git', ['config', '--global', '--add', 'safe.directory', workspaceRoot], { reject: false, timeout: 5000 });
    const branch = await execa('git', ['-c', `safe.directory=${workspaceRoot}`, 'branch', '--show-current'], {
      cwd: workspaceRoot,
      reject: false,
      timeout: 5000,
    });
    const status = await execa('git', ['-c', `safe.directory=${workspaceRoot}`, 'status', '--short'], {
      cwd: workspaceRoot,
      reject: false,
      timeout: 5000,
    });
    return {
      hasGit: branch.exitCode === 0 || status.exitCode === 0,
      branch: branch.stdout.trim() || null,
      isDirty: Boolean(status.stdout.trim()),
      changedFiles: status.stdout.split('\n').filter(Boolean).slice(0, 100),
    };
  } catch {
    return { hasGit: false, branch: null, isDirty: false, changedFiles: [] };
  }
}

function detectFramework(pkg: any, files: string[]) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (deps.next || files.includes('next.config.js') || files.includes('next.config.mjs')) return 'next';
  if (deps.vite || files.includes('vite.config.ts') || files.includes('vite.config.js')) return 'vite';
  if (deps.react) return 'react';
  if (deps.express) return 'express';
  if (pkg?.scripts?.start || pkg?.main) return 'node';
  return 'unknown';
}

function detectPackageManager(files: string[]) {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lockb')) return 'bun';
  if (files.includes('package-lock.json')) return 'npm';
  return 'unknown';
}

export async function getWorkspaceInfo(input?: { path?: string }) {
  const workspaceRoot = resolveWorkspacePath(input?.path || '.');
  const bins = ['node', 'npm', 'git', 'python3', 'rg', 'npx'];
  const availableBinaries: Record<string, string> = {};

  for (const bin of bins) {
    availableBinaries[bin] = await commandExists(bin);
  }

  let currentFiles: string[] = [];
  try {
    const { stdout } = await execa('ls', ['-1', workspaceRoot], { reject: false, timeout: 5000 });
    currentFiles = stdout.split('\n').filter(Boolean);
  } catch {
    currentFiles = [];
  }

  let pkg: any = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
  } catch {}

  const git = await detectGit(workspaceRoot);

  return {
    workspaceRoot,
    codebaseRoot: getCodebaseRoot(),
    workspaceRootMount: getMountedWorkspaceRoot(),
    agentHomeRoot: getAgentHomeRoot(),
    allowedRoots: getAllowedRoots(),
    currentFiles,
    packageManager: detectPackageManager(currentFiles),
    framework: detectFramework(pkg, currentFiles),
    packageName: pkg?.name || null,
    scripts: pkg?.scripts || {},
    git,
    availableBinaries,
  };
}
