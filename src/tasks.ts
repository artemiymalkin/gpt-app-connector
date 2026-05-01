import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAgentHomeRoot, resolveWorkspacePath } from './workspaces';
import { maskSecrets } from './fileTools';

export type TaskStatus = 'planned' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

export type AgentTask = {
  id: string;
  title: string;
  goal: string;
  project?: string;
  status: TaskStatus;
  plan: string[];
  notes: string[];
  changedFiles: string[];
  commandsRun: Array<{ command: string; cwd?: string; exitCode?: number | null; ok?: boolean; timestamp: string }>;
  testsRun: Array<{ command: string; cwd?: string; ok?: boolean; summary?: string; timestamp: string }>;
  risks: string[];
  result?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

function tasksRoot() {
  const dir = path.join(getAgentHomeRoot(), 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeId(id: string) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error('invalid task id');
  return id;
}

function taskPath(id: string) {
  return path.join(tasksRoot(), `${safeId(id)}.json`);
}

function now() {
  return new Date().toISOString();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function readTaskFile(id: string): AgentTask {
  const file = taskPath(id);
  if (!fs.existsSync(file)) throw new Error(`task not found: ${id}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as AgentTask;
}

function writeTaskFile(task: AgentTask) {
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2) + '\n', 'utf8');
  return task;
}

function resolveProject(project?: string) {
  if (!project) return undefined;
  return resolveWorkspacePath(project);
}

export function taskCreate(input: { title: string; goal: string; project?: string; plan?: string[]; notes?: string[] }) {
  const timestamp = now();
  const id = `task_${timestamp.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
  const task: AgentTask = {
    id,
    title: maskSecrets(input.title || 'Untitled task'),
    goal: maskSecrets(input.goal || ''),
    project: resolveProject(input.project),
    status: 'planned',
    plan: normalizeStringArray(input.plan).map(maskSecrets),
    notes: normalizeStringArray(input.notes).map(maskSecrets),
    changedFiles: [],
    commandsRun: [],
    testsRun: [],
    risks: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return writeTaskFile(task);
}

export function taskRead(input: { id: string }) {
  return readTaskFile(input.id);
}

export function taskList(input: { status?: TaskStatus; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(Number(input.limit) || 50, 500));
  const files = fs.readdirSync(tasksRoot()).filter((name) => name.endsWith('.json'));
  const tasks = files
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(tasksRoot(), name), 'utf8')) as AgentTask;
      } catch {
        return null;
      }
    })
    .filter((task): task is AgentTask => Boolean(task))
    .filter((task) => (input.status ? task.status === input.status : true))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      project: task.project,
      updatedAt: task.updatedAt,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
    }));
  return { count: tasks.length, tasks };
}

export function taskUpdate(input: {
  id: string;
  title?: string;
  goal?: string;
  project?: string;
  status?: TaskStatus;
  plan?: string[];
  appendPlan?: string[];
  notes?: string[];
  appendNotes?: string[];
  changedFiles?: string[];
  appendChangedFiles?: string[];
  commandsRun?: AgentTask['commandsRun'];
  appendCommandsRun?: Array<{ command: string; cwd?: string; exitCode?: number | null; ok?: boolean }>;
  testsRun?: AgentTask['testsRun'];
  appendTestsRun?: Array<{ command: string; cwd?: string; ok?: boolean; summary?: string }>;
  risks?: string[];
  appendRisks?: string[];
  result?: string;
}) {
  const task = readTaskFile(input.id);
  if (input.title !== undefined) task.title = maskSecrets(input.title);
  if (input.goal !== undefined) task.goal = maskSecrets(input.goal);
  if (input.project !== undefined) task.project = resolveProject(input.project);
  if (input.status !== undefined) task.status = input.status;
  if (input.plan !== undefined) task.plan = normalizeStringArray(input.plan).map(maskSecrets);
  if (input.appendPlan !== undefined) task.plan.push(...normalizeStringArray(input.appendPlan).map(maskSecrets));
  if (input.notes !== undefined) task.notes = normalizeStringArray(input.notes).map(maskSecrets);
  if (input.appendNotes !== undefined) task.notes.push(...normalizeStringArray(input.appendNotes).map(maskSecrets));
  if (input.changedFiles !== undefined) task.changedFiles = normalizeStringArray(input.changedFiles);
  if (input.appendChangedFiles !== undefined) task.changedFiles = Array.from(new Set([...task.changedFiles, ...normalizeStringArray(input.appendChangedFiles)]));
  if (input.commandsRun !== undefined) task.commandsRun = input.commandsRun.map((item) => ({ ...item, command: maskSecrets(item.command), timestamp: item.timestamp || now() }));
  if (input.appendCommandsRun !== undefined) task.commandsRun.push(...input.appendCommandsRun.map((item) => ({ ...item, command: maskSecrets(item.command), timestamp: now() })));
  if (input.testsRun !== undefined) task.testsRun = input.testsRun.map((item) => ({ ...item, command: maskSecrets(item.command), summary: item.summary ? maskSecrets(item.summary) : item.summary, timestamp: item.timestamp || now() }));
  if (input.appendTestsRun !== undefined) task.testsRun.push(...input.appendTestsRun.map((item) => ({ ...item, command: maskSecrets(item.command), summary: item.summary ? maskSecrets(item.summary) : item.summary, timestamp: now() })));
  if (input.risks !== undefined) task.risks = normalizeStringArray(input.risks).map(maskSecrets);
  if (input.appendRisks !== undefined) task.risks.push(...normalizeStringArray(input.appendRisks).map(maskSecrets));
  if (input.result !== undefined) task.result = maskSecrets(input.result);
  task.updatedAt = now();
  return writeTaskFile(task);
}

export function taskFinish(input: { id: string; result?: string; risks?: string[]; changedFiles?: string[] }) {
  const task = taskUpdate({
    id: input.id,
    status: 'done',
    result: input.result,
    appendRisks: input.risks,
    appendChangedFiles: input.changedFiles,
  });
  task.finishedAt = now();
  task.updatedAt = task.finishedAt;
  return writeTaskFile(task);
}
