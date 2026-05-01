# ChatGPT CLI Agent MCP

A self-hosted Model Context Protocol (MCP) server that lets ChatGPT-compatible clients work with local repositories through a controlled Docker container.

The connector exposes tools for shell commands, workspace discovery, file editing, background processes, logs, Playwright browser snapshots, persistent notes, and task tracking. It is designed for developers who want an AI coding agent with access to selected local directories while keeping runtime state isolated from the host.

## Features

- Run shell commands inside configured allowlisted roots.
- Keep connector source (`/codebase`), user projects (`/workspace`), agent state (`/agent-home`), and optional host access (`/host`) separate.
- Configure roots and aliases through JSON files.
- OAuth-protected public deployment with a bundled Keycloak example.
- Optional legacy Bearer token mode for private/internal deployments.
- Background process management for dev servers and long-running commands.
- Playwright browser snapshots for inspecting web apps.
- Persistent agent notes and task storage.
- Output truncation, command timeout limits, and secret-file protections.

## Security model

This project can execute shell commands and edit files inside mounted directories. Treat it as powerful infrastructure.

Recommended public deployment defaults:

- Use `AUTH_MODE=oauth`.
- Put the MCP server behind HTTPS.
- Use strong unique passwords in `.env`.
- Mount only directories the agent is allowed to access.
- Prefer narrow roots in `config/roots.local.json`; use broad `/host` access only when needed.
- Never commit `.env`, `config/roots.local.json`, `docker-compose.override.yml`, logs, screenshots, or local runtime state.
- Do not use `AUTH_MODE=noauth` outside local development.

## Requirements

- Linux host or server with Docker and Docker Compose.
- A public HTTPS domain for ChatGPT / MCP OAuth flows, for example `https://mcp.example.com`.
- A reverse proxy such as Nginx Proxy Manager, Caddy, Traefik, or nginx.
- Public routing for both:
  - `/` to the MCP server on port `9999`.
  - `/auth` to Keycloak on port `8080`.

The public origin must be a single HTTPS origin. Keycloak is expected to live under the same origin at `/auth`, for example:

```text
https://mcp.example.com      -> MCP server
https://mcp.example.com/auth -> Keycloak
```

## Recommended installation layout

Install the connector under a hidden directory in the user's home directory:

```text
/home/your-user/.gpt-connector/
  code/   # git repository for this connector
  home/   # persistent MCP/agent state, notes, tasks, and local runtime files

/home/your-user/projects/  # repositories exposed as @workspace
/home/your-user            # optional broad host mount exposed as /host
```

This layout keeps infrastructure code, agent state, and user projects separate.

## Installation

### 1. Clone the repository

```bash
mkdir -p ~/.gpt-connector
git clone https://github.com/artemiymalkin/gpt-app-connector.git ~/.gpt-connector/code
mkdir -p ~/.gpt-connector/home ~/projects
cd ~/.gpt-connector/code
```

### 2. Create `.env`

```bash
cp .env.example .env
nano .env
```

At minimum, set these values:

```env
MCP_PUBLIC_ORIGIN=https://mcp.example.com

AGENT_CODEBASE=/home/your-user/.gpt-connector/code
AGENT_HOME=/home/your-user/.gpt-connector/home
AGENT_WORKSPACE_ROOT=/home/your-user/projects
AGENT_HOST=/home/your-user

# Use your real host UID/GID so generated files are not owned by root.
# Find them with: id -u and id -g
AGENT_UID=1000
AGENT_GID=1000
AGENT_RUN_AS_HOST_USER=true

KEYCLOAK_ADMIN_PASSWORD=replace-with-strong-password
KEYCLOAK_DB_PASSWORD=replace-with-strong-password
KEYCLOAK_CONNECTOR_USER_PASSWORD=replace-with-strong-password
```

Replace `/home/your-user` with your real home directory and `https://mcp.example.com` with your real public HTTPS origin.

### 3. Optional: create local root config

The public default roots are defined in `config/roots.json`. Machine-specific roots should go into `config/roots.local.json`, which is ignored by git.

```bash
cp config/roots.local.example.json config/roots.local.json
nano config/roots.local.json
```

Example:

```json
{
  "$schema": "./roots.schema.json",
  "description": "Local/private roots for this machine.",
  "roots": [
    {
      "name": "host",
      "path": "/host",
      "aliases": ["@host"],
      "description": "Broad private host directory mounted from AGENT_HOST. Use only when a task explicitly needs access outside the normal workspace."
    },
    {
      "name": "opencode-config",
      "path": "/host/.config/opencode",
      "aliases": ["@opencode", "@opencode-config"],
      "description": "OpenCode configuration directory. Use this when editing OpenCode agents, commands, providers, or other local OpenCode settings."
    }
  ]
}
```

### 4. Optional: enable broad `/host` mount

If you want roots such as `/host/.config/opencode`, copy the override example:

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
```

The override mounts `AGENT_HOST` as `/host`:

```yaml
services:
  chatgpt-cli-agent:
    volumes:
      - ${AGENT_HOST:?Set AGENT_HOST to the broad host directory you want to expose}:/host
```

Concrete aliases should still be defined in `config/roots.local.json`.

### 5. Configure reverse proxy

Expose both services under the same public HTTPS origin:

```text
/      -> http://<server-ip-or-host>:9999
/auth  -> http://<server-ip-or-host>:8080
```

For example, if your public origin is `https://mcp.example.com`:

```text
https://mcp.example.com/.well-known/oauth-protected-resource -> port 9999
https://mcp.example.com/mcp                                  -> port 9999
https://mcp.example.com/auth                                 -> port 8080
```

Keycloak must be reachable at:

```text
${MCP_PUBLIC_ORIGIN}/auth
```

The MCP server validates OAuth tokens against:

```text
${MCP_PUBLIC_ORIGIN}/auth/realms/gpt-connector/protocol/openid-connect/certs
```

### 6. Start the stack

```bash
docker compose up -d --build
```

Check the containers:

```bash
docker compose ps
docker compose logs -f chatgpt-cli-agent
```

### 7. Verify public endpoints

```bash
curl https://mcp.example.com/health
curl https://mcp.example.com/.well-known/oauth-protected-resource
curl https://mcp.example.com/.well-known/oauth-protected-resource/mcp
```

Replace `https://mcp.example.com` with your `MCP_PUBLIC_ORIGIN`.

### 8. Add the MCP connector to ChatGPT

Use this MCP endpoint:

```text
https://mcp.example.com/mcp
```

Choose OAuth authorization. The bundled Keycloak setup provides the OAuth issuer under `/auth/realms/gpt-connector`.

## Container directory model

Inside the container:

```text
/app         Runtime copy of this connector baked into the Docker image
/codebase    Source code of this connector, mounted from AGENT_CODEBASE
/workspace   Projects/repositories the agent may work with, mounted from AGENT_WORKSPACE_ROOT
/agent-home  Persistent notes, plans, tasks, screenshots, and agent state, mounted from AGENT_HOME
/host        Optional broad host mount, mounted from AGENT_HOST by docker-compose.override.yml
```

## File ownership on host mounts

By default, the container starts as root only long enough to prepare runtime directories, then runs the MCP process as the host UID/GID configured in `.env`:

```env
AGENT_UID=1000
AGENT_GID=1000
AGENT_RUN_AS_HOST_USER=true
```

Set these values to your host user IDs:

```bash
id -u
id -g
```

This prevents files created by the agent under `/codebase`, `/workspace`, `/agent-home`, or `/host` from being owned by root on the host.

If you need to disable this behavior for debugging, set:

```env
AGENT_RUN_AS_HOST_USER=false
```

## Roots configuration

The connector reads roots from a colon-separated list of JSON files:

```env
AGENT_ROOTS_CONFIG=/app/config/roots.json:/app/config/roots.local.json
```

The default public config is committed as `config/roots.json`. Local machine-specific config should be stored in `config/roots.local.json` and should not be committed.

Each root has:

```json
{
  "name": "workspace",
  "path": "/workspace",
  "aliases": ["@workspace"],
  "description": "Main workspace containing user projects and repositories."
}
```

The `description` is important: it tells the AI what the directory is for and when it should use it.

Default roots:

| Alias | Path | Purpose |
| --- | --- | --- |
| `@codebase`, `@code` | `/codebase` | Connector source code and Docker/auth/tool implementation. |
| `@workspace` | `/workspace` | User projects and repositories. |
| `@home`, `@agent-home`, `~` | `/agent-home` | Persistent agent notes, task state, and local runtime files. |

Optional local roots from `config/roots.local.example.json`:

| Alias | Path | Purpose |
| --- | --- | --- |
| `@host` | `/host` | Broad private host directory. Use carefully. |
| `@opencode`, `@opencode-config` | `/host/.config/opencode` | OpenCode configuration directory. |

## Environment variables

See `.env.example` for the full list of supported variables.

Important variables:

| Variable | Description |
| --- | --- |
| `MCP_PUBLIC_ORIGIN` | Public HTTPS origin of this MCP server, without trailing slash. |
| `AUTH_MODE` | `oauth`, `legacy_bearer`, or `noauth`. Use `oauth` for public deployments. |
| `AGENT_CODEBASE` | Host path to this connector source code. |
| `AGENT_WORKSPACE_ROOT` | Host path to projects/repositories the agent may access. |
| `AGENT_HOME` | Host path for persistent agent notes/state. |
| `AGENT_HOST` | Optional broad host path mounted as `/host` by `docker-compose.override.yml`. |
| `AGENT_ROOTS_CONFIG` | Colon-separated list of root config JSON files inside the container. |
| `AGENT_UID` / `AGENT_GID` | Host user and group IDs used to run the MCP process, preventing root-owned files on bind mounts. |
| `AGENT_RUN_AS_HOST_USER` | Set to `true` by default. Set to `false` only if you intentionally want the container to run as root. |
| `OAUTH_ISSUER` | OAuth issuer URL. For bundled Keycloak: `${MCP_PUBLIC_ORIGIN}/auth/realms/gpt-connector`. |
| `OAUTH_JWKS_URI` | JWKS endpoint used to validate access tokens. |
| `OAUTH_AUDIENCE` | Expected JWT audience. Defaults to the public resource origin. |
| `OAUTH_REQUIRED_SCOPE` | Required OAuth scope. Defaults to `cli:run`. |

## Auth modes

### `oauth`

Recommended for public deployments. Access tokens are verified using JWKS, issuer, audience, expiration, and required scope.

```env
AUTH_MODE=oauth
MCP_PUBLIC_ORIGIN=https://mcp.example.com
OAUTH_RESOURCE=${MCP_PUBLIC_ORIGIN}
OAUTH_AUDIENCE=${MCP_PUBLIC_ORIGIN}
OAUTH_ISSUER=${MCP_PUBLIC_ORIGIN}/auth/realms/gpt-connector
OAUTH_JWKS_URI=${MCP_PUBLIC_ORIGIN}/auth/realms/gpt-connector/protocol/openid-connect/certs
OAUTH_REQUIRED_SCOPE=cli:run
```

### `legacy_bearer`

Useful for private deployments where a static token is acceptable.

```env
AUTH_MODE=legacy_bearer
AGENT_AUTH_TOKEN=replace-with-random-token
```

Generate a token:

```bash
openssl rand -base64 48
```

### `noauth`

Local development only.

```env
AUTH_MODE=noauth
```

## MCP endpoint

```text
POST /mcp
Authorization: Bearer <token>
```

With OAuth enabled, unauthenticated requests return `401 Unauthorized` with a `WWW-Authenticate` header pointing to protected-resource metadata.

## Available tools

### `agent_guide`

Returns onboarding guidance, roots, aliases, recommended workflow, and examples. Call this first in a new chat.

### `workspace_list`

Lists allowed roots and candidate project directories.

### `workspace_select`

Resolves and summarizes a workspace path for the current chat.

### `workspace_info`

Returns project type, package scripts, git status, and available binaries.

### `cli`

Executes a shell command inside an allowed root.

Example input:

```json
{
  "command": "npm test",
  "cwd": "@workspace/my-project",
  "timeoutMs": 120000
}
```

### `read_file`, `write_file`, `edit_file`, `list_files`, `search_files`

Read, write, edit, list, and search files inside allowed roots with secret-file protections.

### `git_status`, `git_diff`

Inspect Git status and diffs inside allowed roots.

### `background_start`, `background_logs`, `background_list`, `background_stop`

Manage long-running commands such as dev servers.

### `browser_snapshot`

Uses Playwright to open a URL and return visible text, interactive elements, errors, and a screenshot path.

### `note_write`, `note_read`, `note_list`

Store and retrieve persistent notes under the agent home directory.

### `task_create`, `task_read`, `task_list`, `task_update`, `task_finish`

Track persistent coding tasks under the agent home directory.

### `list_logs`, `read_log`, `recent_commands`

Inspect connector logs and recent command history.

## Keycloak realm audience

The bundled Keycloak import file contains an example OAuth audience:

```text
keycloak/import/gpt-connector-realm.json
```

By default, the audience mapper uses:

```text
https://mcp.example.com
```

Before deploying with the bundled Keycloak setup, replace it with your real `MCP_PUBLIC_ORIGIN` value. For example, if your `.env` contains:

```env
MCP_PUBLIC_ORIGIN=https://agent.your-domain.com
```

then update `keycloak/import/gpt-connector-realm.json`:

```json
"included.custom.audience": "https://agent.your-domain.com"
```

The value must match the audience expected by the MCP server:

```env
OAUTH_AUDIENCE=${MCP_PUBLIC_ORIGIN}
```

If these values do not match, OAuth login may succeed but MCP requests will fail with an invalid-token error because the connector rejects tokens issued for a different audience.

Keycloak imports realm files only when the realm is first created. After changing the realm import, recreate the Keycloak data volume or update the mapper manually in the Keycloak admin UI.

For a fresh local setup, you can reset the bundled Keycloak database with:

```bash
docker compose down
docker volume rm gpt-connector_keycloak-db-data 2>/dev/null || true
docker compose up -d --build
```

## Updating

```bash
cd ~/.gpt-connector/code
git pull
docker compose up -d --build
```

If only `.env`, root config, or runtime configuration changed, a restart may be enough:

```bash
docker compose restart chatgpt-cli-agent
```

If Dockerfile, dependencies, mounts, or Keycloak setup changed, rebuild:

```bash
docker compose up -d --build
```

## Local development

```bash
npm install
npm run build
npm run smoke
npm run dev
```

## Public GitHub checklist

Before publishing:

- Ensure `.env` is not tracked.
- Ensure `config/roots.local.json` and `docker-compose.override.yml` are not tracked.
- Replace example domains, paths, users, and emails only in private local files.
- Run `npm run build` and `npm run smoke`.
- Review `docker-compose.yml`, `.env.example`, `README.md`, and `config/*.json` before exposing the service to the internet.
- If secrets or personal data were ever committed, rewrite Git history and rotate the affected secrets.

## License

MIT License. See [LICENSE](LICENSE).
