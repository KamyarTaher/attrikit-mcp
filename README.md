# @attrkit/mcp

A stdio [MCP](https://modelcontextprotocol.io) server for [AttriKit](https://attrikit.io),
web-to-app attribution for iOS and Android apps that buy ads. Use it from Claude Code,
Claude Desktop, Codex, Cursor, Gemini CLI, VS Code or Windsurf to create campaign links,
import spend, read each campaign's scale, cut or hold call, and export installs and events.
It is a thin client over AttriKit's public API. It holds no database access; your tenant
scope is resolved from your secret management key.

Source: [KamyarTaher/attrikit-mcp](https://github.com/KamyarTaher/attrikit-mcp). Report an
issue there or at contact@clashware.com. MIT licensed.

## What it exposes

The server provides 39 tools.

| Area | Tools |
|---|---|
| Key scope | `whoami` |
| Workspace usage | `get_usage_cap`, `set_usage_cap` |
| Apps | `list_apps`, `create_app`, `get_app`, `update_app`, `archive_app` |
| SDK keys | `get_publishable_key`, `rotate_publishable_key` |
| Management keys | `list_api_keys`, `create_api_key`, `revoke_api_key` |
| Campaign links | `list_links`, `create_campaign_link`, `update_link_status` |
| Decisions and reporting | `list_campaigns`, `list_ads`, `list_recent_events`, `list_event_deliveries`, `get_campaign_decision`, `record_campaign_decision`, `get_attribution_rollup`, `lookup_customer_attribution` |
| Spend and costs | `get_spend`, `import_spend`, `set_cost_model`, `pull_network_spend` |
| Ad integrations | `list_integrations`, `create_integration`, `update_integration`, `delete_integration` |
| RevenueCat | `get_revenuecat`, `configure_revenuecat` |
| Outbound webhooks | `list_webhooks`, `create_webhook`, `delete_webhook` |
| Data export | `export_events` |
| Server events | `send_server_event` |

`get_campaign_decision` returns the engine's call verbatim. The model reports it;
it does not recompute it.

A Meta or TikTok integration has two delivery options. `delivery_scope` is `all`
(the default: every install with measurement consent, organic ones included) or
`attributed` (only installs AttriKit attributes to that network: a click ID, a link
token, or a Matched install at or above the delivery floor). `renewal_event`
is `purchase` (the default: a renewal is sent as Purchase) or `custom` (it is
sent as the custom event `subscription_renewed`, with its value). Set them on
`create_integration`, or later with `update_integration` and the action
`set_delivery_options`, which leaves the credential and status as they are. A
Google integration refuses `attributed` and `custom`.

## Before you connect

Install Node.js 22 or newer. The `npx -y @attrkit/mcp` command downloads and
starts the server automatically, so no global install is required.

> **Node.js 22 is required from 2.0.0.** `engines.node` is `>=22`; 1.x accepted Node.js 18.
> If a client still starts the server with an older Node, upgrade Node, or pin
> `@attrkit/mcp@1`. The tools, their inputs and their outputs did not change.

Create the first workspace management key under
[Dashboard → Settings → API keys & MCP](https://attrikit.io/en/dashboard/settings/api-keys).
This one-time bootstrap requires the dashboard.

After that first key exists, a workspace-scoped read/write key can manage every
customer operation available through the Management API. This includes apps,
delegated keys, usage caps, integrations, and exports.

Use a read-only or app-scoped key when the client needs less access. App-scoped
keys cannot read or change the workspace usage cap, create sibling apps, or
manage workspace-wide integrations.

### Give the server the key

On macOS, store the key once in the Keychain:

```bash
npx -y @attrkit/mcp login
```

It asks for the key with echo off, checks it against AttriKit (and prints the plan and scopes),
then stores it in the Keychain item `attrkit-mcp`. The key never appears in a process listing.
`npx -y @attrkit/mcp logout` removes the item.

On any system you can instead set `ATTRKIT_API_KEY` in the environment of the process that starts
your MCP client, or in the client's own secret store.

At start the server resolves the key in this order:

1. `ATTRKIT_API_KEY`, when it holds a real value.
2. On macOS, the Keychain item `attrkit-mcp`. An empty `ATTRKIT_API_KEY`, or one a client left
   unexpanded (`$ATTRKIT_API_KEY`, `${ATTRKIT_API_KEY}`, `${ATTRKIT_API_KEY:-}`,
   `${env:ATTRKIT_API_KEY}`, `${input:attrkit-key}`), counts as unset.
3. Otherwise it exits with an error that names the fix.

## Codex

Add this server to `~/.codex/config.toml`:

```toml
[mcp_servers.attrkit]
command = "npx"
args = ["-y", "@attrkit/mcp"]
env = { ATTRKIT_API_URL = "https://attrikit.io" }
env_vars = ["ATTRKIT_API_KEY"]
```

```bash
codex mcp get attrkit
```

See the [Codex setup guide](https://attrikit.io/en/docs/mcp#codex).

## Cursor

Add the server to `.cursor/mcp.json` for one project or `~/.cursor/mcp.json` for
every project:

```json
{
  "mcpServers": {
    "attrkit": {
      "command": "npx",
      "args": ["-y", "@attrkit/mcp"],
      "env": {
        "ATTRKIT_API_KEY": "${env:ATTRKIT_API_KEY}",
        "ATTRKIT_API_URL": "https://attrikit.io"
      }
    }
  }
}
```

Then enable it and inspect the available tools:

```bash
cursor-agent mcp list
cursor-agent mcp list-tools attrkit
```

See the [Cursor setup guide](https://attrikit.io/en/docs/mcp#cursor).

## Gemini CLI

Add this server to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "attrkit": {
      "command": "npx",
      "args": ["-y", "@attrkit/mcp"],
      "env": {
        "ATTRKIT_API_KEY": "$ATTRKIT_API_KEY",
        "ATTRKIT_API_URL": "https://attrikit.io"
      }
    }
  }
}
```

```bash
gemini mcp list
```

See the [Gemini setup guide](https://attrikit.io/en/docs/mcp#gemini).

## Other MCP clients

Configure a stdio server with command `npx`, arguments
`["-y", "@attrkit/mcp"]`, and the `ATTRKIT_API_KEY` environment variable.
Environment-variable interpolation differs between clients, so follow the
client's secret-handling documentation. `ATTRKIT_API_URL` is optional and
defaults to `https://attrikit.io`.

## Field naming

Tool input schemas are snake_case (`bundle_id`, `store_url`, `campaign_id`) and
double as REST documentation: the Management API accepts the same snake_case
field names in query strings and JSON request bodies (camelCase also works),
and responses are always snake_case. Field-level detail is returned under
`error.fields` when a validation failure can be attributed to specific fields.
Malformed JSON has no field to name. Self-identifying rejections such as
`invalid_cursor`, `invalid_url`, and `ssrf_blocked` return the code alone.

## Test it locally

```bash
ATTRKIT_API_KEY=sk_... npx @modelcontextprotocol/inspector npx -y @attrkit/mcp
```

The Inspector lists the tools and lets you invoke them against your live
workspace.

## Access boundaries

| Control | Management API and MCP |
|---|---|
| Customer operations after the first key | Available with a workspace-scoped read/write key |
| First workspace management key | Dashboard bootstrap only |
| Billing and subscription | Not available |
| Sign-in and organization membership | Not available |
| Workspace deletion | Not available |
| Internal administration | Not available |

See the [Management API guide](https://attrikit.io/en/docs/management-api) and
[OpenAPI contract](https://attrikit.io/openapi.json) for the complete HTTP
surface.

## Notes

- stdio only. The package does not open a network port.
- Key scopes gate reads vs writes. A read-only key gets `403 forbidden_scope` on
  every mutation.
- App-scoped keys cannot create other apps, reach sibling apps, or manage
  workspace-wide integrations.
- App creation, management-key creation, and webhook creation return secret
  values once. Capture them from the tool result; list tools only return masked
  metadata.
- Non-removal mutation tools accept an optional `idempotency_key`. Reuse the
  same value only for an exact retry. One-time secret responses are encrypted at
  rest and safely replayed. Removal tools do not accept this parameter because
  their DELETE operations cannot apply the removal more than once.
- Management keys are protected by distributed per-key global, mutation, and
  expensive-operation limits. A `429` response includes `Retry-After`; wait at
  least that many seconds before retrying.
- All diagnostics go to stderr. stdout is reserved for the MCP transport.
- MCP clients store environment values in local configuration. Never commit a
  configuration containing a key. Restrict access to the file and revoke any
  key that is exposed.

## Migration to 1.0.0

Version 1.0.0 formalizes tool input schemas, refines runtime configuration validation, and introduces three breaking restrictions from version 0.4.6:

1. **Paired ad identifiers in `import_spend`**: `adset_id` and `ad_id` (and their camelCase aliases `adsetId` and `adId`) must now be provided together or both omitted. At version 0.4.6 the schema accepted either field independently, but the underlying API rejected unpaired calls; version 1.0.0 moves this validation client-side.
2. **Strict UUID format for `campaign_id` in `record_campaign_decision`**: `campaign_id` must now be a valid RFC 4122 UUID. Version 0.4.6 accepted arbitrary non-empty strings.
3. **Strict API base URL validation in `readConfig` (`ATTRKIT_API_URL`)**: `readConfig` enforces four startup-fatal refusals (violations print to stderr and exit with code 1):
   - **Protocol refusal**: Non-loopback HTTP endpoints are rejected (`protocol must be HTTPS, except HTTP is allowed for localhost development`). HTTP is permitted only for loopback interfaces (`localhost`, `127.0.0.1`, `[::1]`); remote hosts must use `https:`.
   - **Credentials refusal**: Embedded URL basic-auth credentials are rejected (`credentials are not allowed in ATTRKIT_API_URL`). Pass API authentication via `ATTRKIT_API_KEY`.
   - **Query string refusal**: Query parameters in the base URL are rejected (`query strings are not allowed in ATTRKIT_API_URL`).
   - **Fragment refusal**: Fragment identifiers in the base URL are rejected (`fragments are not allowed in ATTRKIT_API_URL`).
   (In addition, malformed strings that fail URL parsing throw `Invalid URL` and exit 1).

Additionally, dot-segment ids escaped the app route under 0.4.6-style encoding; 1.0.0 keeps them inside the route across all seven app tools (`get_app`, `update_app`, `archive_app`, `get_publishable_key`, `rotate_publishable_key`, `get_revenuecat`, and `configure_revenuecat`).

See [CHANGELOG.md](./CHANGELOG.md) for full release details.

## License

MIT. See [LICENSE](./LICENSE).

