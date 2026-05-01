import assert from 'node:assert/strict';
import { runCliTool, resolveCwd } from '../dist/cli.js';

const codebaseRoot = process.env.CODEBASE_ROOT || process.env.LEGACY_CODEBASE_ROOT || process.env.WORKSPACE_ROOT || process.cwd();
const workspaceRoot = process.env.CODEBASE_ROOT ? (process.env.WORKSPACE_ROOT || '/workspace') : (process.env.WORKSPACE_ROOT || process.cwd());
const agentHomeRoot = process.env.AGENT_HOME_ROOT || '/agent-home';

assert.equal(resolveCwd(codebaseRoot, '.'), codebaseRoot);
assert.equal(resolveCwd(codebaseRoot, '@codebase'), codebaseRoot);
const resolvedWorkspace = resolveCwd(codebaseRoot, '@workspace');
assert.ok(resolvedWorkspace === workspaceRoot || resolvedWorkspace === (process.env.WORKSPACES_ROOT || '/workspaces'));

assert.equal(resolveCwd(codebaseRoot, '@home/notes'), `${agentHomeRoot}/notes`);
assert.throws(() => resolveCwd(codebaseRoot, '/etc'), /outside allowed roots|outside allowed workspace roots|outside workspace/);

const ok = await runCliTool({ command: 'echo smoke-ok', cwd: '@codebase', timeoutMs: 5000 });
assert.equal(ok.exitCode, 0);
assert.match(ok.stdout, /smoke-ok/);
assert.equal(ok.timedOut, false);

const timeout = await runCliTool({ command: 'sleep 2; echo should-not-finish', cwd: '@codebase', timeoutMs: 300 });
assert.equal(timeout.timedOut, true);
assert.equal(timeout.stdout, '');

console.log('smoke tests passed');
