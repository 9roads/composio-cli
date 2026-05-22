---
title: Composio CLI Usage Guide
impact: HIGH
description: Use the Composio CLI to search, execute, and proxy tools inside existing Tool Router sessions.
tags:
  - cli
  - composio
  - tool-router
  - sessions
  - search
  - execute
  - proxy
---

# Composio CLI Usage Guide

Use `composio` to operate on an existing Composio Tool Router session: search for tools, execute tool slugs, and proxy provider API requests through connected accounts in that session.

All examples use `trs_...` as a placeholder session id. Commands read `COMPOSIO_API_KEY` from the environment and include `--session-id` explicitly.

## Usage Model

Every command requires an existing Tool Router session id:

```sh
composio search "send an email" --session-id trs_...
composio execute GMAIL_SEND_EMAIL --session-id trs_... -d '{"recipient_email":"a@b.com"}'
composio proxy https://gmail.googleapis.com/gmail/v1/users/me/profile --toolkit gmail --session-id trs_...
```

Use the session id created by your app or backend. If a command reports no active connection, refresh the session with the required connected account, then retry.

## Workflow: search -> execute -> proxy

### Step 1 - Search for Tools

Use natural-language queries to find tool slugs in the provided session:

```sh
composio search "send an email" --session-id trs_...
composio search "create github issue" --session-id trs_...
composio search "post a message to a slack channel" --session-id trs_...
```

Search defaults to JSON output. The JSON includes matched tools, connected toolkit status, cached schema paths for primary tools, and a suggested next command.

Use multiple use-case queries in one request:

```sh
composio search "my emails" "my github issues" --session-id trs_...
```

Filter by toolkit and limit results:

```sh
composio search "create issue" --toolkits github --session-id trs_...
composio search "list calendar events" --toolkits google_calendar --limit 5 --session-id trs_...
```

Use human-readable output when inspecting results manually:

```sh
composio search "send an email" --human --session-id trs_...
```

Prefer `--limit` and `--toolkits` over shell truncation. Tool ranking and next-step guidance are more useful when the CLI receives and formats the full search response.

### Step 2 - Execute a Tool

Execute a tool slug inside the existing session:

```sh
composio execute GMAIL_SEND_EMAIL --session-id trs_... -d '{"recipient_email":"you@example.com","subject":"Hello","body":"Test"}'
composio execute GITHUB_CREATE_ISSUE --session-id trs_... -d '{"owner":"acme","repo":"app","title":"Bug report"}'
```

`-d` and `--data` accept JSON, JSON with comments, or JS-style object literals:

```sh
composio execute GMAIL_SEND_EMAIL --session-id trs_... -d '{ recipient_email: "a@b.com", subject: "Hi", body: "Hello" }'
```

Read arguments from a file:

```sh
composio execute GITHUB_CREATE_ISSUE --session-id trs_... -d @issue.json
```

Read arguments from stdin:

```sh
printf '{"recipient_email":"a@b.com"}' | composio execute GMAIL_SEND_EMAIL --session-id trs_... -d -
```

Print the CLI-facing schema before executing:

```sh
composio execute GMAIL_SEND_EMAIL --session-id trs_... --get-schema
```

Preview a call without executing it:

```sh
composio execute SLACK_SEND_A_MESSAGE_TO_A_SLACK_CHANNEL --session-id trs_... --dry-run -d '{"channel":"general","text":"Hello"}'
```

Execute independent calls concurrently:

```sh
composio execute --parallel --session-id trs_... \
  GMAIL_SEND_EMAIL -d '{"recipient_email":"a@b.com"}' \
  GITHUB_CREATE_AN_ISSUE -d '{"owner":"acme","repo":"app","title":"Bug"}'
```

When a tool has exactly one `file_uploadable` input, inject a local file path with `--file`:

```sh
composio execute SOME_FILE_TOOL --session-id trs_... --file ./report.pdf -d '{}'
```

If a tool has multiple uploadable fields, put the target field directly in `-d` instead of using `--file`.

### Step 3 - Proxy Provider APIs

Use `proxy` for curl-like access to toolkit APIs through Composio-managed auth in the provided session:

```sh
composio proxy https://gmail.googleapis.com/gmail/v1/users/me/profile --toolkit gmail --session-id trs_...
```

Send method, headers, and body:

```sh
composio proxy https://gmail.googleapis.com/gmail/v1/users/me/drafts --toolkit gmail --session-id trs_... \
  -X POST -H 'content-type: application/json' -d '{"message":{"raw":"..."}}'
```

Supported methods are `GET`, `POST`, `PUT`, `DELETE`, and `PATCH`.

## Local Tools

`execute` can also run bundled local tools whose slugs start with `LOCAL_`. The package includes local toolkit declarations for:

1. `PEEKABOO` - macOS screen capture and GUI automation.
2. `CHROME_DEVTOOLS` - local Chrome automation through `chrome-devtools-mcp`.
3. `BEEPER_IMESSAGE` - local iMessage read and send workflows backed by `imessage-cli`.

Local tool slug format:

```text
LOCAL_<TOOLKIT>_<TOOL>
```

Examples:

```sh
composio execute LOCAL_PEEKABOO_VERSION --session-id trs_... --get-schema
composio execute LOCAL_CHROME_DEVTOOLS_LIST_PAGES --session-id trs_... -d '{}'
composio execute LOCAL_BEEPER_IMESSAGE_LIST_THREADS --session-id trs_... -d '{}'
```

Local tools still use the same `execute` command and still require `COMPOSIO_API_KEY` and `--session-id` at the CLI layer. Supported platforms vary by toolkit. For example, Peekaboo and Beeper iMessage are macOS-focused, while Chrome DevTools supports common macOS, Linux, and Windows architectures.

Treat local tools as live local actions. Peekaboo can control the GUI, Chrome DevTools can inspect or modify browser pages, and Beeper iMessage can mutate Messages state.

## Command Reference

### `composio search`

```sh
composio search <query...> --session-id <session_id> [--toolkits text] [--limit integer] [--human]
```

Options:

```text
--session-id <session_id>  Existing Tool Router session id.
--toolkits <text>          Filter by toolkit slugs, comma-separated.
--limit <integer>          Maximum number of results, clamped to 1-1000.
--human                    Show formatted human-readable search output.
--json                     Force JSON output.
```

Behavior:

1. Calls the session search endpoint.
2. Searches one or more semantic use cases.
3. Filters output by toolkit when `--toolkits` is provided.
4. Writes JSON by default.
5. Caches tool schemas returned by search under `~/.composio/tool_definitions/` unless `COMPOSIO_CACHE_DIR` overrides the cache root.

### `composio execute`

```sh
composio execute <slug> --session-id <session_id> [-d, --data text] [--file path] [--dry-run] [--get-schema]
composio execute --parallel --session-id <session_id> <slug> -d <text> <slug> -d <text> ...
```

Options and flags:

```text
--session-id <session_id> Existing Tool Router session id.
-d, --data <text>         JSON or JS-style object arguments, @file, or - for stdin.
-p, --parallel            Execute repeated TOOL_SLUG -d <text> groups concurrently.
--file <path>             Inject a local file path into the single file_uploadable input.
--get-schema              Print the CLI-facing input schema without executing.
--dry-run                 Validate and preview the tool call without executing.
--account <text>          Connected account selector inside the provided session.
--skip-connection-check   Skip the connected-account check.
--skip-tool-params-check  Skip input validation against cached schema.
--skip-checks             Skip both checks above.
```

Behavior:

1. Calls the session execute endpoint for normal tool slugs.
2. Calls the session meta execute endpoint for supported `COMPOSIO_*` meta tools.
3. Executes `LOCAL_*` tools locally through the bundled local tools provider when available.
4. Validates inputs against cached schemas unless skipped.
5. Performs a session toolkit connection check unless skipped or executing a local tool.
6. Uploads file inputs when the tool schema marks fields as `file_uploadable`.
7. Stores very large successful outputs in an artifact file and prints a JSON summary with `storedInFile`.

Normal `execute` uses a cached schema when available and only fetches a schema when the cache is missing. When `/tools` does not list the requested slug, schema lookup falls back to `COMPOSIO_GET_TOOL_SCHEMAS` and caches the result. If schema lookup is still unavailable for a normal execution, the CLI sends the execute request and lets the backend validate the payload. Schema-dependent modes such as `--get-schema`, `--dry-run`, and `--file` require a schema.

### `composio proxy`

```sh
composio proxy <url> --toolkit <text> --session-id <session_id> [-X method] [-H header]... [-d data]
```

Options:

```text
--session-id <session_id> Existing Tool Router session id.
-t, --toolkit <text>      Toolkit slug whose connected account should be used.
-X, --method <method>     HTTP method: GET, POST, PUT, DELETE, PATCH.
-H, --header <header>     Header in "Name: value" format. Repeat for multiple.
-d, --data <data>         Request body as raw text, JSON, @file, or - for stdin.
--skip-connection-check   Skip the connected-account check.
```

Behavior:

1. Checks the toolkit connection in the provided session unless skipped.
2. Sends the request through the session proxy endpoint.
3. Parses JSON-ish request bodies when possible.
4. Prints string response data directly, JSON response data pretty-printed, or binary response metadata when present.

## Tips for Agents

1. Use `composio search` first unless the exact tool slug is already known.
2. Do not invent tool slugs. Use slugs returned by `search`, then use `--get-schema` to inspect inputs.
3. Keep `--session-id` explicit on every command.
4. Use `jq` for JSON output inspection.
5. Use `--get-schema` before complex `execute` payloads.
6. Use `--dry-run` before mutating calls when the payload is uncertain.
7. Use `--parallel` only for independent tool calls.
8. Skip checks only when you already know the session connection and schema state are valid.
9. For no-active-connection errors, ask the app/backend to refresh the session with the needed account.

## Command Help

Every supported command exposes help:

```sh
composio --help
composio search --help
composio execute --help
composio proxy --help
```
