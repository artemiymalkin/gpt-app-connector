import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { runCliTool, getWorkspaceInfo, recentCommands, getWorkspaceRoot } from './cli';
import { addToolSecurityMetadata, getAuthMode, verifyAccessToken, getOAuthProtectedResourceMetadata, getWWWAuthenticateHeader } from './auth';
import { backgroundStart, backgroundList, backgroundLogs, backgroundStop } from './background';
import { artifactInfo, getContentType, listLogs, readLog, resolveInsideLogsRoot } from './logs';
import { browserSnapshot } from './browserSnapshot';
import { workspaceList, workspaceSelect, agentHomeInfo, noteWrite, noteRead, noteList, getAllowedRoots, ensureAgentHome } from './workspaces';
import { readFileTool, writeFileTool, editFileTool, listFilesTool, searchFilesTool, gitStatusTool, gitDiffTool } from './fileTools';
import { taskCreate, taskRead, taskList, taskUpdate, taskFinish } from './tasks';
import { getAgentGuide } from './agentGuide';
import { discoverScriptTools, scriptToolsForMcp, runScriptTool } from './scriptTools';

function getServer() {
  const server = new Server(
    { name: 'chatgpt-cli-agent', version: '1.1.0' },
    { capabilities: { tools: { listChanged: true } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const scriptTools = discoverScriptTools();
    return {
      tools: [
      {
        name: 'agent_guide',
        description: 'Onboarding guide for this MCP connector: roots, aliases, recommended workflow, examples, and important notes. Call this first in a new chat.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'cli',
        description: 'Execute a shell command inside an allowed root. cwd may be relative to /codebase, an absolute path under a configured root, or an alias like @codebase, @workspace/project, @home/notes, @opencode.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            cwd: { type: 'string', description: 'Working directory. Supports relative paths, absolute allowed paths, and configured aliases such as @workspace/..., @home/..., @opencode/...' },
            timeoutMs: { type: 'number', description: 'Command timeout in milliseconds' },
          },
          required: ['command'],
        },
      },
      {
        name: 'task_create',
        description: 'Create a persistent coding task under agent home tasks storage.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' }, goal: { type: 'string' }, project: { type: 'string' }, plan: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } } }, required: ['title', 'goal'] },
      },
      {
        name: 'task_read',
        description: 'Read a persistent coding task by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      {
        name: 'task_list',
        description: 'List persistent coding tasks, optionally filtered by status.',
        inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['planned', 'in_progress', 'blocked', 'done', 'cancelled'] }, limit: { type: 'number' } } },
      },
      {
        name: 'task_update',
        description: 'Update a persistent coding task: status, plan, notes, changed files, commands, tests, risks, and result.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, goal: { type: 'string' }, project: { type: 'string' }, status: { type: 'string', enum: ['planned', 'in_progress', 'blocked', 'done', 'cancelled'] }, plan: { type: 'array', items: { type: 'string' } }, appendPlan: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } }, appendNotes: { type: 'array', items: { type: 'string' } }, changedFiles: { type: 'array', items: { type: 'string' } }, appendChangedFiles: { type: 'array', items: { type: 'string' } }, appendCommandsRun: { type: 'array', items: { type: 'object' } }, appendTestsRun: { type: 'array', items: { type: 'object' } }, risks: { type: 'array', items: { type: 'string' } }, appendRisks: { type: 'array', items: { type: 'string' } }, result: { type: 'string' } }, required: ['id'] },
      },
      {
        name: 'task_finish',
        description: 'Mark a persistent coding task as done and record result, risks, and changed files.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, result: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } }, changedFiles: { type: 'array', items: { type: 'string' } } }, required: ['id'] },
      },
      {
        name: 'read_file',
        description: 'Read a text file inside allowed roots with secret-file protection and secret masking.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, maxChars: { type: 'number' }, allowSecrets: { type: 'boolean' } }, required: ['path'] },
      },
      {
        name: 'write_file',
        description: 'Write a text file inside allowed roots. Refuses to overwrite unless overwrite=true.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean' }, allowSecrets: { type: 'boolean' } }, required: ['path', 'content'] },
      },
      {
        name: 'edit_file',
        description: 'Replace exact text in a file inside allowed roots and create a timestamped backup.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' }, expectedReplacements: { type: 'number' }, allowSecrets: { type: 'boolean' } }, required: ['path', 'search', 'replace'] },
      },
      {
        name: 'list_files',
        description: 'List files under an allowed root with depth and count limits.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, depth: { type: 'number' }, limit: { type: 'number' } } },
      },
      {
        name: 'search_files',
        description: 'Search files with ripgrep inside an allowed root, excluding common build directories.',
        inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, query: { type: 'string' }, glob: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      },
      {
        name: 'git_status',
        description: 'Return git status --short --branch inside an allowed root.',
        inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
      },
      {
        name: 'git_diff',
        description: 'Return git diff inside an allowed root with secret masking and truncation.',
        inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, staged: { type: 'boolean' }, maxChars: { type: 'number' } } },
      },
      {
        name: 'workspace_info',
        description: 'Get information about a configured root path: project type, package scripts, git status, and available binaries. Defaults to /workspace.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional workspace path or alias to inspect' },
          },
        },
      },
      {
        name: 'workspace_list',
        description: 'List allowed roots and candidate project directories under built-in and JSON-configured roots.',
        inputSchema: {
          type: 'object',
          properties: {
            depth: { type: 'number', description: 'Directory search depth, default 2, max 5' },
          },
        },
      },
      {
        name: 'workspace_select',
        description: 'Resolve and summarize a workspace path for this chat. Use selectedPath as cwd in later cli calls.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path or alias, e.g. @workspace/project, @codebase, @home/notes, @opencode, or an absolute allowed path' },
          },
        },
      },
      {
        name: 'agent_home',
        description: 'Return the agent home directory used for notes and persistent assistant files.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'note_write',
        description: 'Write or append a note inside agent home notes directory.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Note path relative to notes/' },
            content: { type: 'string', description: 'Note content' },
            append: { type: 'boolean', description: 'Append instead of overwrite' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'note_read',
        description: 'Read a note from agent home notes directory.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Note path relative to notes/' },
            maxChars: { type: 'number', description: 'Maximum characters to return' },
          },
          required: ['path'],
        },
      },
      {
        name: 'note_list',
        description: 'List notes inside agent home notes directory.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional notes subdirectory' },
          },
        },
      },
      {
        name: 'recent_commands',
        description: 'Return recent CLI command history from the agent log.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of recent commands to return. Default 20, max 200.' },
          },
        },
      },
      {
        name: 'background_start',
        description: 'Start a long-running shell command in the background inside an allowed workspace, such as npm run dev.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run in the background' },
            cwd: { type: 'string', description: 'Working directory. Supports allowed absolute paths and aliases.' },
            name: { type: 'string', description: 'Optional friendly process name' },
          },
          required: ['command'],
        },
      },
      {
        name: 'background_list',
        description: 'List currently running background processes started by this MCP server instance.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'background_logs',
        description: 'Read recent logs from a running background process by id or name.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Background process id' },
            name: { type: 'string', description: 'Background process name' },
            tailLines: { type: 'number', description: 'Number of tail lines to return. Default 100, max 1000.' },
          },
        },
      },
      {
        name: 'background_stop',
        description: 'Stop a background process by id or name.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Background process id' },
            name: { type: 'string', description: 'Background process name' },
          },
        },
      },
      {
        name: 'list_logs',
        description: 'List files inside the MCP agent logs directory.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to logs root. Defaults to .' },
          },
        },
      },
      {
        name: 'read_log',
        description: 'Read a log file inside the MCP agent logs directory, optionally tailing lines.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to logs root' },
            tailLines: { type: 'number', description: 'Return only the last N lines' },
            maxChars: { type: 'number', description: 'Maximum characters to return' },
          },
          required: ['path'],
        },
      },

      {
        name: 'get_artifact',
        description: 'Create a public URL for a file inside the MCP agent logs directory, such as a Playwright screenshot.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Artifact path relative to logs root, e.g. screenshots/page.jpg' },
          },
          required: ['path'],
        },
      },
      {
        name: 'browser_snapshot',
        description: 'Open a URL with Playwright and return title, visible text, interactive elements, console/page/network errors, and screenshot path.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to open' },
            fullPage: { type: 'boolean', description: 'Whether to take a full-page screenshot' },
            timeoutMs: { type: 'number', description: 'Navigation timeout in milliseconds' },
          },
          required: ['url'],
        },
      },
      {
        name: 'reload_mcp',
        description: 'Restart the MCP server process after code/config changes. Requires Docker restart policy outside the container.',
        inputSchema: {
          type: 'object',
          properties: {
            delayMs: { type: 'number', description: 'Delay before process exit. Default 500ms.' },
          },
        },
      },
      {
        name: 'script_tool_list',
        description: 'List dynamic tools from /agent-home/tools',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'script_tool_call',
        description: 'Call dynamic tool by name',
        inputSchema: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            args: { type: 'object' },
          },
          required: ['tool'],
        },
      },
      ...scriptToolsForMcp(scriptTools)
      ].map(addToolSecurityMetadata),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const scriptTools = discoverScriptTools();
    const scriptToolMap = new Map(scriptTools.map(t => [t.name, t]));
    const args = request.params.arguments || {};

    if (name === 'agent_guide') {
      return { content: [{ type: 'text', text: JSON.stringify(getAgentGuide(), null, 2) }] };
    }

    if (name === 'cli') {
      const { command, cwd, timeoutMs } = args as any;
      const result = await runCliTool({ command, cwd, timeoutMs });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'task_create') {
      return { content: [{ type: 'text', text: JSON.stringify(taskCreate(args as any), null, 2) }] };
    }
    if (name === 'task_read') {
      return { content: [{ type: 'text', text: JSON.stringify(taskRead(args as any), null, 2) }] };
    }
    if (name === 'task_list') {
      return { content: [{ type: 'text', text: JSON.stringify(taskList(args as any), null, 2) }] };
    }
    if (name === 'task_update') {
      return { content: [{ type: 'text', text: JSON.stringify(taskUpdate(args as any), null, 2) }] };
    }
    if (name === 'task_finish') {
      return { content: [{ type: 'text', text: JSON.stringify(taskFinish(args as any), null, 2) }] };
    }

    if (name === 'read_file') {
      return { content: [{ type: 'text', text: JSON.stringify(readFileTool(args as any), null, 2) }] };
    }
    if (name === 'write_file') {
      return { content: [{ type: 'text', text: JSON.stringify(writeFileTool(args as any), null, 2) }] };
    }
    if (name === 'edit_file') {
      return { content: [{ type: 'text', text: JSON.stringify(editFileTool(args as any), null, 2) }] };
    }
    if (name === 'list_files') {
      return { content: [{ type: 'text', text: JSON.stringify(listFilesTool(args as any), null, 2) }] };
    }
    if (name === 'search_files') {
      return { content: [{ type: 'text', text: JSON.stringify(await searchFilesTool(args as any), null, 2) }] };
    }
    if (name === 'git_status') {
      return { content: [{ type: 'text', text: JSON.stringify(await gitStatusTool(args as any), null, 2) }] };
    }
    if (name === 'git_diff') {
      return { content: [{ type: 'text', text: JSON.stringify(await gitDiffTool(args as any), null, 2) }] };
    }

    if (name === 'workspace_info') {
      const { path } = args as any;
      const info = await getWorkspaceInfo({ path });
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }

    if (name === 'workspace_list') {
      const { depth } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(workspaceList({ depth }), null, 2) }] };
    }

    if (name === 'workspace_select') {
      const { path } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(workspaceSelect({ path }), null, 2) }] };
    }

    if (name === 'agent_home') {
      return { content: [{ type: 'text', text: JSON.stringify(agentHomeInfo(), null, 2) }] };
    }

    if (name === 'note_write') {
      const { path, content, append } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(noteWrite({ path, content, append }), null, 2) }] };
    }

    if (name === 'note_read') {
      const { path, maxChars } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(noteRead({ path, maxChars }), null, 2) }] };
    }

    if (name === 'note_list') {
      const { path } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(noteList({ path }), null, 2) }] };
    }

    if (name === 'recent_commands') {
      const { limit } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(recentCommands(limit), null, 2) }] };
    }

    if (name === 'background_start') {
      const { command, cwd, name: processName } = args as any;
      const result = backgroundStart({ command, cwd, name: processName });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'background_list') {
      return { content: [{ type: 'text', text: JSON.stringify(backgroundList(), null, 2) }] };
    }

    if (name === 'background_logs') {
      const { id, name: processName, tailLines } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(backgroundLogs({ id, name: processName, tailLines }), null, 2) }] };
    }

    if (name === 'background_stop') {
      const { id, name: processName } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(backgroundStop({ id, name: processName }), null, 2) }] };
    }

    if (name === 'list_logs') {
      const { path } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(listLogs({ path }), null, 2) }] };
    }

    if (name === 'read_log') {
      const { path, tailLines, maxChars } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(readLog({ path, tailLines, maxChars }), null, 2) }] };
    }


    if (name === 'get_artifact') {
      const { path } = args as any;
      return { content: [{ type: 'text', text: JSON.stringify(artifactInfo({ path }), null, 2) }] };
    }

    if (name === 'browser_snapshot') {
      const { url, fullPage, timeoutMs } = args as any;
      const result = await browserSnapshot({ url, fullPage, timeoutMs });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'reload_mcp') {
      const { delayMs } = args as any;
      const delay = Math.max(100, Math.min(Number(delayMs) || 500, 5000));
      setTimeout(() => {
        console.log(`[MCP] reload requested, exiting process after ${delay}ms`);
        process.exit(0);
      }, delay).unref();
      return {
        content: [{ type: 'text', text: JSON.stringify({ reloading: true, delayMs: delay, note: 'Process will exit; Docker restart policy should start it again.' }, null, 2) }],
      };
    }

    if (name === 'script_tool_list') {
      const tools = discoverScriptTools();
      return { content: [{ type: 'text', text: JSON.stringify(tools.map((tool) => tool.name), null, 2) }] };
    }

    if (name === 'script_tool_call') {
      const { tool, args } = request.params.arguments || {};
      const tools = discoverScriptTools();
      const scriptTool = tools.find((item) => item.name === tool);
      if (!scriptTool) throw new Error(`Tool not found: ${tool}`);
      const result = await runScriptTool(scriptTool, (args || {}) as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (scriptToolMap.has(name)) {
      const tool = scriptToolMap.get(name)!;
      const result = await runScriptTool(tool, args as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    throw new Error(`Tool ${name} not found`);
  });

  return server;
}

const app = createMcpExpressApp({ host: '0.0.0.0' });

const keycloakInternalOrigin = process.env.KEYCLOAK_INTERNAL_ORIGIN;
if (keycloakInternalOrigin) {
  app.use(
    '/auth',
    createProxyMiddleware({
      target: keycloakInternalOrigin,
      changeOrigin: true,
      xfwd: true,
      ws: true,
      logLevel: 'warn',
    } as any)
  );
}


app.get(/^\/artifacts\/(.+)$/, (req: Request, res: Response) => {
  try {
    const relativePath = decodeURIComponent(String(req.params[0] || ''));
    const file = resolveInsideLogsRoot(relativePath);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }

    const fileName = path.basename(file).replace(/"/g, '');
    res.setHeader('Content-Type', getContentType(file));
    res.setHeader('Content-Disposition', 'inline; filename="' + fileName + '"');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(file).pipe(res);
  } catch (error: any) {
    res.status(400).json({ error: error.message || 'Invalid artifact path' });
  }
});

app.get('/health', (_req, res) => {
  ensureAgentHome();
  res.json({
    ok: true,
    service: 'chatgpt-cli-agent',
    authMode: getAuthMode(),
    workspaceRoot: getWorkspaceRoot(),
    allowedRoots: getAllowedRoots(),
    uptimeSec: Math.round(process.uptime()),
  });
});

app.get('/ready', (_req, res) => {
  ensureAgentHome();
  const workspaceRoot = getWorkspaceRoot();
  const exists = fs.existsSync(workspaceRoot);
  let writable = false;
  try {
    fs.accessSync(workspaceRoot, fs.constants.W_OK);
    writable = true;
  } catch {}
  res.status(exists && writable ? 200 : 503).json({
    ok: exists && writable,
    service: 'chatgpt-cli-agent',
    workspaceRoot,
    workspaceExists: exists,
    workspaceWritable: writable,
    allowedRoots: getAllowedRoots(),
    authMode: getAuthMode(),
  });
});

app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  const meta = getOAuthProtectedResourceMetadata();
  if (!meta) {
    res.status(503).json({ error: 'OAuth not configured' });
    return;
  }
  res.json(meta);
});

app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  const meta = getOAuthProtectedResourceMetadata();
  if (!meta) {
    res.status(503).json({ error: 'OAuth not configured' });
    return;
  }
  res.json(meta);
});

const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const mode = getAuthMode();

  if (mode === 'noauth') {
    return next();
  }

  if (mode === 'legacy_bearer') {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.AGENT_AUTH_TOKEN}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    return next();
  }

  if (mode === 'oauth') {
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401)
        .set('WWW-Authenticate', getWWWAuthenticateHeader())
        .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Authentication required' }, id: null });
      return;
    }

    verifyAccessToken(match[1])
      .then(() => next())
      .catch((err) => {
        console.error('OAuth verification failed:', err.message);
        res.status(401)
          .set('WWW-Authenticate', getWWWAuthenticateHeader())
          .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or expired token' }, id: null });
      });
    return;
  }

  next();
};

app.use('/mcp', authMiddleware);

app.post('/mcp', async (req: Request, res: Response) => {
  const server = getServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: null });
});

app.delete('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: null });
});

const PORT = Number(process.env.PORT || 9999);
app.listen(PORT, () => {
  console.log(`MCP server listening on port ${PORT}`);
});
