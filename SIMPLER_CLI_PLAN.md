# Simpler Composio CLI Plan

## Goal

Build a much smaller `composio` CLI focused only on existing Tool Router sessions.

Supported commands:

```bash
composio search
composio execute
composio proxy
```

The CLI must be easy to understand from `--help`, but it should not carry over the current CLI's login, project, organization, config, artifact, generation, local-tools management, or agent workflows.

Within the three supported commands, preserve the relevant current CLI behavior. "Simpler" means fewer commands and no user/session creation concerns, not reduced capability inside `search`, `execute`, or `proxy`.

## Non-Negotiable Session Model

The new CLI must require a Tool Router session id for every command.

```bash
composio search "send an email" --session-id trs_...
composio execute GMAIL_SEND_EMAIL --session-id trs_... -d '{ "recipient_email": "a@b.com" }'
composio proxy https://gmail.googleapis.com/gmail/v1/users/me/profile --toolkit gmail --session-id trs_...
```

Rules:

- Do not accept `user_id` in the CLI.
- Do not read `user_id` from environment variables.
- Do not create Tool Router sessions from the CLI.
- Do not provide `COMPOSIO_SESSION_ID`; require `--session-id` explicitly per call.
- Use the project API key from `COMPOSIO_API_KEY`.
- Allow `COMPOSIO_BASE_URL` as an optional override for development.

Rationale: the app or backend owns user identity and session creation. This CLI only operates against an existing session, so every API call is scoped to the same session by path.

## API Surface

The CLI should call only existing-session Tool Router endpoints:

```http
POST /api/v3.1/tool_router/session/{session_id}/search
POST /api/v3.1/tool_router/session/{session_id}/execute
POST /api/v3.1/tool_router/session/{session_id}/proxy_execute
```

It must not call:

```http
POST /api/v3.1/tool_router/session
```

Optional validation with:

```http
GET /api/v3.1/tool_router/session/{session_id}
```

should be skipped by default. Let each command fail naturally with the backend's `401`, `403`, or `404`.

## Auth

The only required environment variable is:

```bash
COMPOSIO_API_KEY=...
```

Optional:

```bash
COMPOSIO_BASE_URL=https://backend.composio.dev
```

The CLI should fail before making a network request when `COMPOSIO_API_KEY` is missing.

## Command Contract

### `composio search`

Purpose: find relevant tools by natural language.

Usage:

```bash
composio search <query...> --session-id <session_id> [--toolkits text] [--limit integer] [--human]
```

Behavior:

- Send one or more semantic search queries to the session search endpoint.
- Support `--toolkits` as a comma-separated toolkit filter.
- Support `--limit` for output truncation if the backend returns more results.
- Return JSON by default.
- Support `--human` for formatted output, matching the original CLI behavior.

### `composio execute`

Purpose: execute a known tool slug inside an existing session.

Usage:

```bash
composio execute <slug> --session-id <session_id> [-d, --data text] [--file path] [--dry-run] [--get-schema] [--parallel]
```

Behavior:

- Send `{ tool_slug, arguments }` to the session execute endpoint.
- Parse `-d` / `--data` as JSON or JS-style object syntax, matching the original CLI.
- Support `@file` and `-` for stdin, matching the original CLI.
- Support `--parallel` / `-p` for repeated `TOOL_SLUG -d <text>` groups, matching the original CLI.
- Support `--dry-run` to validate and preview the tool call without executing, matching the original CLI.
- Support `--get-schema` to fetch and print the CLI-facing input schema, matching the original CLI.
- Support `--file <path>` for single file-uploadable inputs, matching the original CLI.
- Preserve connection checks, adapted to the provided Tool Router session instead of user/project context.
- Preserve cached schema validation where the current execute command uses it.
- Preserve local tool execution for local tool slugs from the existing command implementation.
- Return the backend response as JSON.

### `composio proxy`

Purpose: call provider APIs through Composio-managed auth, scoped to the existing session.

Usage:

```bash
composio proxy <url> --toolkit <text> --session-id <session_id> [-X method] [-H header]... [-d data]
```

Behavior:

- Use the session-scoped `proxy_execute` endpoint.
- Accept full provider URLs, matching the current CLI help and UX.
- Support `--toolkit` / `-t`.
- Support `-X, --method`.
- Support repeated `-H, --header`.
- Support `-d, --data` as raw text, JSON, `@file`, or stdin, matching the original CLI.
- Return proxy status, headers, data, and binary metadata when present.

## Help Text Requirement

Help text is a core deliverable.

The new CLI must provide complete help for:

```bash
composio --help
composio search --help
composio execute --help
composio proxy --help
```

The help text should be copied and adapted from the original CLI, not rewritten from scratch.

Source files:

- `composio/ts/packages/cli/src/commands/root-help.ts`
- `composio/ts/packages/cli/src/commands/proxy.cmd.ts`
- `composio/ts/packages/cli/src/commands/tools/commands/tools.search.cmd.ts`
- `composio/ts/packages/cli/src/commands/tools/commands/tools.execute.cmd.ts`

Transformation rules:

- Keep original wording, examples, option descriptions, flags, and structure for the supported commands wherever they can be made session-scoped.
- Add `--session-id <session_id>` to every usage string.
- Add `--session-id <session_id>` to every command's options list.
- Add `--session-id trs_...` to every example.
- Remove references to unsupported commands such as `login`, `logout`, `link`, `run`, `artifacts`, `tools info`, `dev`, `generate`, `connections`, and `triggers`.
- Do not remove existing `search`, `execute`, or `proxy` flags merely to simplify implementation. If a flag depends on user/project context, adapt it to the required `--session-id` model.
- Replace connection/setup language with: sessions are created by your app/backend; this CLI only operates on an existing Tool Router session.
- Keep the current CLI's practical, copy-pasteable example style.

### Root Help Content

Root help should include:

- One-line purpose.
- Required environment variable: `COMPOSIO_API_KEY`.
- Required option: `--session-id <session_id>` on every command.
- Statement that the CLI does not create sessions.
- Commands table for only `search`, `execute`, and `proxy`.
- Short examples for the three commands.

### Search Help Content

Adapt the current search help from `root-help.ts`.

Keep relevant text:

- "Find tools by use case across all toolkits/apps."
- "One or more semantic use-case queries."
- `--toolkits`
- `--limit`
- `--human`
- Cross-app workflow discovery examples.
- Narrow-to-toolkit examples.

Every example must include `--session-id trs_...`.

Remove `see also` entries that refer to unsupported commands. Keep only `execute` if useful.

### Execute Help Content

Adapt the current execute help from `root-help.ts` and `tools.execute.cmd.ts`.

Keep relevant text:

- "Execute a tool by slug."
- `-d, --data <text>` description.
- `-p, --parallel`
- `--file <path>`
- `--get-schema`
- `--dry-run`
- `--skip-connection-check`
- `--skip-tool-params-check`
- `--skip-checks`
- Examples for sending email and creating a GitHub issue, if the tool slugs are still valid examples.
- `@file` and stdin examples.

Remove or rewrite only command references that are not part of this smaller CLI:

- artifacts references
- `tools info`
- `link`

Every example must include `--session-id trs_...`.

### Proxy Help Content

Adapt the current proxy help from `root-help.ts` and `proxy.cmd.ts`.

Keep relevant text:

- "curl-like access to any toolkit API through Composio using your connected account."
- "Composio handles authentication."
- `--toolkit`
- `-X, --method`
- `-H, --header`
- `-d, --data`
- Gmail profile and draft examples.

Rewrite "Connect an account first" references to explain that the provided session must already have the relevant connected account.

Every example must include `--session-id trs_...`.

## Proposed Implementation Structure

Use plain TypeScript and a lightweight CLI parser.

Possible structure:

```text
src/
  cli.ts
  config.ts
  http.ts
  json-input.ts
  schema-cache.ts
  file-input.ts
  local-tools.ts
  connection-checks.ts
  commands/
    search.ts
    execute.ts
    proxy.ts
  help/
    root.ts
    search.ts
    execute.ts
    proxy.ts
test/
  help.test.ts
  config.test.ts
  search.test.ts
  execute.test.ts
  proxy.test.ts
```

Keep dependencies small:

- `commander` or `cac` for CLI parsing.
- Reuse or extract the current JSON/JS-style input parser.
- Reuse or extract the command-level schema cache, file input handling, connection checks, and local-tool execution needed by `execute`.
- Native `fetch`.

Do not use:

- Effect
- login/session config files
- analytics
- generated type stubs
- local-tools management commands
- project/org resolution

## Implementation Steps

1. Scaffold a minimal TypeScript package for the new CLI.
2. Add `config.ts` to read `COMPOSIO_API_KEY` and optional `COMPOSIO_BASE_URL`.
3. Add shared `--session-id <session_id>` validation.
4. Add `http.ts` for authenticated JSON requests and normalized errors.
5. Implement `search`.
6. Implement `execute`, including original relevant flags and validations.
7. Implement `proxy`.
8. Port and adapt help text from the original CLI.
9. Add help snapshot tests.
10. Add command tests with mocked `fetch`.
11. Add README or usage docs only if needed; primary usage documentation should live in `--help`.

## Tests

Required tests:

- Missing `COMPOSIO_API_KEY` fails before network calls.
- Missing `--session-id` fails before network calls for every command.
- `search` calls `/session/{session_id}/search`.
- `execute` calls `/session/{session_id}/execute`.
- `proxy` calls `/session/{session_id}/proxy_execute`.
- Each command passes `x-api-key`.
- `execute --parallel` preserves repeated grouped execution behavior.
- `execute --dry-run` validates and previews without executing the tool.
- `execute --get-schema` prints the CLI-facing schema.
- `execute --file` injects a local file path into the single file-uploadable input.
- `execute` preserves connection-check and schema-validation behavior without accepting `user_id`.
- Local tool slugs execute locally when supported by the existing implementation.
- Help snapshots for:
  - `composio --help`
  - `composio search --help`
  - `composio execute --help`
  - `composio proxy --help`

Help snapshot tests should protect the requirement that the new help stays close to the original CLI text while staying honest about supported functionality.

## Acceptance Criteria

- The CLI has exactly three user-facing commands: `search`, `execute`, and `proxy`.
- Every command requires `--session-id`.
- The CLI never accepts or sends `user_id`.
- The CLI never creates a session.
- The CLI reads the project API key from `COMPOSIO_API_KEY`.
- The help output is complete, copy-pasteable, and adapted from the original CLI help.
- Unsupported commands are absent from help and command parsing.
- Supported-command flags from the original `search`, `execute`, and `proxy` flows are preserved unless they are impossible without reintroducing `user_id`.
- Tests verify request paths, auth headers, required session id behavior, and help output.
