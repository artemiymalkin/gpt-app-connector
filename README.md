# ChatGPT CLI Agent MCP

A self-hosted Model Context Protocol (MCP) server that lets ChatGPT-compatible MCP clients work with your local repositories through a controlled Docker container.

The connector exposes tools for shell commands, workspace discovery, background processes, logs, Playwright browser snapshots, and persistent agent notes. It is designed for developers who want an AI coding agent with access to a mounted workspace while keeping runtime state isolated from the host.

## Features

- Run shell commands inside an allowlisted Docker workspace.
- Separate connector source (`/codebase`) from user projects (`/workspace`).
- OAuth-protected public deployment with bundled Keycloak example.
- Optional legacy Bearer token mode for private/internal deployments.
- Background process management for dev servers and long-running commands.
- Playwright browser snapshots for inspecting web apps.
- Persistent agent notes under `/agent-home`.
- Output truncation and command timeout limits.

## Security model

This project can execute shell commands in mounted directories. Treat it as powerful infrastructure, not a toy service.

Recommended public deployment defaults:

- Use `AUTH_MODE=oauth`.
- Put the service behind HTTPS.
- Use strong unique passwords in `.env`.
- Mount only the directories the agent is allowed to access.
- Never commit `.env`, logs, generated screenshots, or local runtime state.
- Do not use `AUTH_MODE=noauth` outside local development.

## Directory model

Inside the container:

```text
/app         Runtime copy of this connector baked into the Docker image
/codebase    Source code of this connector, mounted from AGENT_CODEBASE
/workspace   Projects/repositories the agent may work with
/agent-home  Persistent notes, plans, screenshots, and agent state
```

When changing connector source code in `/codebase`, rebuild the image:

```bash
docker compose up -d --build
```

A simple restart is enough only for runtime/config changes:

```bash
docker compose restart chatgpt-cli-agent
```

## Quick start

```bash
cp .env.example .env
nano .env
docker compose up -d --build
curl http://localhost:9999/health
```

At minimum, update these values in `.env`:

```env
MCP_PUBLIC_ORIGIN=https://mcp.example.com
AGENT_CODEBASE=/path/to/chatgpt-cli-agent
AGENT_WORKSPACE_ROOT=/path/to/projects
AGENT_HOME=~/.ai-agent
KEYCLOAK_ADMIN_PASSWORD=replace-with-strong-admin-password
KEYCLOAK_DB_PASSWORD=replace-with-strong-db-password
KEYCLOAK_CONNECTOR_USER_PASSWORD=replace-with-strong-login-password
```

## Environment

See `.env.example` for the full list of supported variables.

Important variables:

| Variable | Description |
| --- | --- |
| `MCP_PUBLIC_ORIGIN` | Public HTTPS origin of this MCP server, without trailing slash. |
| `AUTH_MODE` | `oauth`, `legacy_bearer`, or `noauth`. Use `oauth` for public deployments. |
| `AGENT_CODEBASE` | Host path to this connector source code. |
| `AGENT_WORKSPACE_ROOT` | Host path to projects/repositories the agent may access. |
| `AGENT_HOME` | Host path for persistent agent notes/state. |
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

OAuth protected-resource metadata:

```bash
curl https://mcp.example.com/.well-known/oauth-protected-resource
curl https://mcp.example.com/.well-known/oauth-protected-resource/mcp
```

### `legacy_bearer`

Useful for private deployments where a static token is acceptable.

```env
AUTH_MODE=legacy_bearer
AGENT_AUTH_TOKEN=replace-with-long-random-token
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

Returns onboarding guidance, roots, aliases, recommended workflow, and examples.

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

### `background_start`, `background_logs`, `background_list`, `background_stop`

Manage long-running commands such as dev servers.

### `browser_snapshot`

Uses Playwright to open a URL and return visible text, interactive elements, errors, and a screenshot path.

### `note_write`, `note_read`, `note_list`

Store and retrieve persistent notes under the agent home directory.

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

This is only a safe placeholder for the public repository. Before deploying with the bundled Keycloak setup, replace it with your real `MCP_PUBLIC_ORIGIN` value. For example, if your `.env` contains:

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

After changing the realm import, recreate the Keycloak data volume or update the mapper manually in the Keycloak admin UI. Keycloak imports realm files only when the realm is first created. For a fresh local setup, you can reset the bundled Keycloak database with:

```bash
docker compose down
docker volume rm chatgpt-cli-agent_keycloak-db-data 2>/dev/null || true
docker compose up -d --build
```

If your Docker Compose project name is different, list volumes first:

```bash
docker volume ls | grep keycloak
```

Verify the final configuration by checking that the token audience matches `MCP_PUBLIC_ORIGIN` and that `/mcp` accepts authenticated requests.

## ChatGPT MCP setup

1. Deploy the connector on an HTTPS domain.
2. Configure `.env` with the same public origin.
3. Run `docker compose up -d --build`.
4. Verify metadata:

```bash
curl https://mcp.example.com/.well-known/oauth-protected-resource
```

5. Add the MCP endpoint in the client:

```text
https://mcp.example.com/mcp
```

6. Use OAuth authorization.

## Local development

```bash
npm install
npm run build
npm run smoke
npm run dev
```

## Docker

```bash
docker compose up -d --build
docker compose logs -f chatgpt-cli-agent
```

## Reverse proxy notes

Expose both the MCP server and Keycloak under the same public origin:

```text
/      -> http://<host>:9999
/auth  -> http://<host>:8080
```

The public Keycloak hostname must match:

```text
${MCP_PUBLIC_ORIGIN}/auth
```

## Public GitHub checklist

Before publishing:

- Ensure `.env` is not tracked.
- Replace example domains, paths, users, and emails with your own only in private `.env`.
- Run `git grep` for accidental secrets or personal data.
- Run `npm run build` and `npm run smoke`.
- Review `docker-compose.yml` before exposing the service to the internet.

## License

Add a license before publishing if you want others to use, modify, or redistribute the project.
