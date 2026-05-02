import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { getAgentHomeRoot, ensureAgentHome } from './workspaces';
import { maskSecrets } from './fileTools';

export type ScriptToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  toolset: string;
  toolName: string;
  toolsetDir: string;
  scriptPath: string;
  runtime: string;
  timeoutMs: number;
  envRequired: string[];
  envOptional: string[];
};

type ToolsetManifest = {
  name?: unknown;
  description?: unknown;
  runtime?: unknown;
  timeoutMs?: unknown;
  env?: unknown;
  tools?: unknown;
};

type EnvConfig = {
  required: string[];
  optional: string[];
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_STDOUT_CHARS = 2_000_000;
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const SAFE_ENV_RE = /^[A-Z_][A-Z0-9_]*$/;

function getToolsRoot() {
  return path.resolve(process.env.AGENT_TOOLS_DIR || path.join(getAgentHomeRoot(), 'tools'));
}

function isInside(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse ${filePath}: ${message}`);
  }
}

function normalizeEnv(env: unknown): EnvConfig {
  if (Array.isArray(env)) {
    return { required: env.filter((item): item is string => typeof item === 'string'), optional: [] };
  }
  if (!env || typeof env !== 'object') return { required: [], optional: [] };
  const value = env as any;
  return {
    required: Array.isArray(value.required) ? value.required.filter((item: unknown): item is string => typeof item === 'string') : [],
    optional: Array.isArray(value.optional) ? value.optional.filter((item: unknown): item is string => typeof item === 'string') : [],
  };
}

function assertSafeEnvNames(names: string[], context: string) {
  for (const name of names) {
    if (!SAFE_ENV_RE.test(name)) {
      throw new Error(`invalid env var name in ${context}: ${name}`);
    }
  }
}

function parseDotenv(content: string) {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (!SAFE_ENV_RE.test(key)) continue;
    let value = normalized.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function readDotenvIfExists(filePath: string) {
  if (!fs.existsSync(filePath)) return {};
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return {};
  return parseDotenv(fs.readFileSync(filePath, 'utf8'));
}

function buildEnv(tool: ScriptToolDefinition) {
  const toolsRoot = getToolsRoot();
  const sharedEnv = readDotenvIfExists(path.join(toolsRoot, '.env'));
  const localEnv = readDotenvIfExists(path.join(tool.toolsetDir, '.env'));
  const merged = { ...process.env, ...sharedEnv, ...localEnv } as Record<string, string | undefined>;
  const allowlist = Array.from(new Set([...tool.envRequired, ...tool.envOptional]));
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || getAgentHomeRoot(),
    AGENT_HOME_ROOT: getAgentHomeRoot(),
  };
  for (const key of allowlist) {
    const value = merged[key];
    if (value !== undefined) env[key] = value;
  }
  const missing = tool.envRequired.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`missing required env for ${tool.name}: ${missing.join(', ')}`);
  }
  return env;
}

function runtimeCommand(runtime: string, scriptPath: string) {
  const normalized = runtime.toLowerCase();
  if (normalized === 'node' || normalized === 'mjs' || normalized === 'js') return { command: 'node', args: [scriptPath] };
  if (normalized === 'tsx' || normalized === 'ts') return { command: 'npx', args: ['tsx', scriptPath] };
  if (normalized === 'bash' || normalized === 'sh') return { command: 'bash', args: [scriptPath] };
  if (normalized === 'python' || normalized === 'python3' || normalized === 'py') return { command: 'python3', args: [scriptPath] };
  throw new Error(`unsupported runtime for ${scriptPath}: ${runtime}`);
}

export function discoverScriptTools() {
  ensureAgentHome();
  const toolsRoot = getToolsRoot();
  fs.mkdirSync(toolsRoot, { recursive: true });

  const definitions: ScriptToolDefinition[] = [];
  const warnings: string[] = [];

  for (const entry of fs.readdirSync(toolsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (!SAFE_NAME_RE.test(entry.name)) {
      warnings.push(`skipping toolset with unsafe name: ${entry.name}`);
      continue;
    }

    const toolsetDir = path.join(toolsRoot, entry.name);
    const manifestPath = path.join(toolsetDir, 'toolset.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = readJson(manifestPath) as ToolsetManifest;
      const toolsetName = typeof manifest.name === 'string' && manifest.name ? manifest.name : entry.name;
      if (!SAFE_NAME_RE.test(toolsetName)) throw new Error(`unsafe toolset name: ${toolsetName}`);
      const runtime = typeof manifest.runtime === 'string' ? manifest.runtime : 'node';
      const timeoutMs = Math.max(1000, Math.min(Number(manifest.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
      const env = normalizeEnv(manifest.env);
      assertSafeEnvNames([...env.required, ...env.optional], manifestPath);

      if (!manifest.tools || typeof manifest.tools !== 'object' || Array.isArray(manifest.tools)) {
        throw new Error('tools must be an object');
      }

      for (const [toolName, rawTool] of Object.entries(manifest.tools as Record<string, any>)) {
        if (!SAFE_NAME_RE.test(toolName)) throw new Error(`unsafe tool name: ${toolName}`);
        if (!rawTool || typeof rawTool !== 'object') throw new Error(`invalid tool definition: ${toolName}`);
        if (typeof rawTool.script !== 'string' || !rawTool.script) throw new Error(`missing script for ${toolName}`);
        const scriptPath = path.resolve(toolsetDir, rawTool.script);
        if (!isInside(toolsetDir, scriptPath)) throw new Error(`script is outside toolset dir for ${toolName}`);
        if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) throw new Error(`script not found for ${toolName}: ${rawTool.script}`);

        const toolEnv = normalizeEnv(rawTool.env);
        const envRequired = Array.from(new Set([...env.required, ...toolEnv.required]));
        const envOptional = Array.from(new Set([...env.optional, ...toolEnv.optional]));
        assertSafeEnvNames([...envRequired, ...envOptional], `${manifestPath}:${toolName}`);

        definitions.push({
          name: `${toolsetName}_${toolName}`,
          description: typeof rawTool.description === 'string' ? rawTool.description : `${toolsetName} ${toolName}`,
          inputSchema: rawTool.inputSchema && typeof rawTool.inputSchema === 'object' ? rawTool.inputSchema : { type: 'object', properties: {} },
          toolset: toolsetName,
          toolName,
          toolsetDir,
          scriptPath,
          runtime: typeof rawTool.runtime === 'string' ? rawTool.runtime : runtime,
          timeoutMs: Math.max(1000, Math.min(Number(rawTool.timeoutMs) || timeoutMs, MAX_TIMEOUT_MS)),
          envRequired,
          envOptional,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`skipping ${entry.name}: ${message}`);
    }
  }

  if (warnings.length) {
    console.warn('[script-tools] discovery warnings:', warnings.join('; '));
  }

  return definitions;
}

export function scriptToolsForMcp(definitions: ScriptToolDefinition[]) {
  return definitions.map((tool) => ({
    name: tool.name,
    description: `${tool.description}\n\nDynamic script tool from /agent-home/tools/${tool.toolset}. Args are passed as JSON on stdin; result must be JSON on stdout. Required env: ${tool.envRequired.length ? tool.envRequired.join(', ') : 'none'}.`,
    inputSchema: tool.inputSchema,
  }));
}

export async function runScriptTool(tool: ScriptToolDefinition, args: Record<string, unknown>) {
  const env = buildEnv(tool);
  const { command, args: commandArgs } = runtimeCommand(tool.runtime, tool.scriptPath);
  const input = JSON.stringify(args || {});

  const result = await execa(command, commandArgs, {
    cwd: tool.toolsetDir,
    env,
    input,
    reject: false,
    timeout: tool.timeoutMs,
    maxBuffer: MAX_STDOUT_CHARS,
  });

  const stdout = maskSecrets(result.stdout || '');
  const stderr = maskSecrets(result.stderr || '');

  if (result.exitCode !== 0) {
    return {
      ok: false,
      tool: tool.name,
      exitCode: result.exitCode,
      stderr,
      stdout: stdout.slice(0, 20_000),
    };
  }

  if (!stdout.trim()) {
    return { ok: true, tool: tool.name, data: null, stderr };
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return {
      ok: true,
      tool: tool.name,
      stdout: stdout.slice(0, 200_000),
      stderr,
      warning: 'tool stdout was not valid JSON',
    };
  }
}
