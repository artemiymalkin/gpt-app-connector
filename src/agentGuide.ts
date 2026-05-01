import { getAllowedRoots, getGuideRoots, getRootsConfigPaths } from './workspaces';

export function getAgentGuide() {
  return {
    name: 'ChatGPT CLI Agent MCP',
    purpose: 'Work with code repositories through shell commands, background processes, logs, Playwright browser snapshots, and persistent agent notes.',
    roots: getGuideRoots(),
    rootsConfigPaths: getRootsConfigPaths(),
    allowedRoots: getAllowedRoots(),
    recommendedFirstSteps: [
      'Call workspace_list to discover available projects.',
      'Call workspace_select with @workspace/<project> to choose the project for this chat.',
      'Use cli with cwd set to the selected path for code edits, tests, builds, git commands, and package managers.',
      'Use background_start/background_logs/background_stop for dev servers and long-running processes.',
      'Use browser_snapshot to inspect a running web app with Playwright.',
      'Use note_write/note_read/note_list under @home to store persistent notes and project plans.',
    ],
    commonExamples: [
      {
        task: 'Inspect connector source',
        tool: 'cli',
        arguments: { cwd: '@codebase', command: 'git status && ls -la' },
      },
      {
        task: 'Inspect a project',
        tool: 'workspace_select',
        arguments: { path: '@workspace/my-project' },
      },
      {
        task: 'Run tests in selected project',
        tool: 'cli',
        arguments: { cwd: '@workspace/my-project', command: 'npm test', timeoutMs: 120000 },
      },
      {
        task: 'Start a dev server',
        tool: 'background_start',
        arguments: { cwd: '@workspace/my-project', name: 'dev-server', command: 'npm run dev -- --host 0.0.0.0' },
      },
      {
        task: 'Write project notes',
        tool: 'note_write',
        arguments: { path: 'projects/my-project.md', content: '# Notes\n...' },
      },
    ],
    importantNotes: [
      'There is no global mutable current workspace on the server, so multiple chats do not conflict. Each chat should keep its selected cwd in conversation context.',
      'Relative cwd defaults to @codebase. For user projects, prefer explicit @workspace/<project> or another configured alias.',
      'Additional roots and aliases can be configured in rootsConfigPaths JSON files. The target paths must already be mounted into the container.',
      'reload_mcp restarts the Node process. If Dockerfile, package dependencies, or mounts changed, rebuild on the host with docker compose up -d --build.',
    ],
  };
}
