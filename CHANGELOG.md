# Changelog

## 2.0.1 (2026-11-02)

### Fixed

- An `ATTRKIT_API_URL` that is set but empty, or only whitespace, now means unset: the server uses
  `https://attrikit.io` instead of exiting with `Invalid URL`. A client config that writes the
  variable with an empty value no longer stops the server from starting. A non-empty value that is
  not a valid API URL is still refused, as before.
- Every tool argument now carries a description: what it is, its format or unit, and its default
  when the server or the API applies one. 72 arguments had none, nested ones included. Tool names,
  argument names, their types and what each tool sends are unchanged.
- `create_api_key`'s `scopes` now says `["read"]` or `["read", "write"]`: every key needs read, and
  the API refuses `["write"]` alone with `400 invalid_request`, as it did in 2.0.0. The call itself
  is unchanged.
- The `delivery_scope` argument of `create_integration` and `update_integration` describes the
  attributed scope as "a Matched install at or above the delivery floor", the wording of the
  Management API contract it mirrors. The option's values and behaviour are unchanged.

## 2.0.0 (2026-11-02)

### Changed

- **Node.js 22 or newer is required.** `engines.node` is `>=22` (it was `>=18`). A client that
  starts the server with an older Node, through `npx -y @attrkit/mcp` or a pinned path, must move
  to Node 22 or stay on `@attrkit/mcp@1`. The tools, their inputs and their outputs are unchanged.
  Decided by the owner on 2026-10-20.
- The package declares `mcpName` `io.attrikit/mcp`, the name it is to be listed under in the
  official MCP Registry. Its `repository` and `bugs` now point at the public source,
  github.com/KamyarTaher/attrikit-mcp, instead of a private repository that answered 404, and its
  description and keywords say what it manages: iOS and Android apps, campaign links, ad spend and
  campaign decisions.

## 1.4.0 (2026-10-21)

### Added

- `create_integration` accepts two optional options for a Meta or TikTok integration:
  `delivery_scope` (`all` or `attributed`) and `renewal_event` (`purchase` or `custom`). Each is
  sent only when you give it, so a create without them sends exactly what 1.3.0 sent, and the API
  applies its defaults, `all` and `purchase`. Existing integrations are unchanged.
- `update_integration` has a new action, `set_delivery_options`, which sets `delivery_scope`,
  `renewal_event` or both in any status and leaves the credential and status as they were. The
  API refuses the action when it names neither option, and refuses `attributed` or `custom` on a
  Google integration.
- `list_event_deliveries` names `attributed_only_suppressed` among the reasons it can return: the
  connection sends only the events of installs attributed to its network, and this install is
  organic or attributed to another network.

## 1.3.0 (2026-10-20)

### Added

- `list_event_deliveries` (`GET /api/v1/apps/{appId}/deliveries`, read scope): what happened to
  each event the app sent to its ad networks, one row per delivery, newest first. Each row gives
  the state (`held`, `queued`, `sending`, `retrying`, `sent`, `suppressed` or `failed`), the reason
  with a one-line explanation, the attempt count, the last attempt's time and HTTP status, and for
  a held row the time it is expected to be released. Filters: `install_id`, `event_id`,
  `connection_id`, `network`, `state`, `from`, `to`; paged with `cursor` and `limit` (50 by
  default, 200 at most). No other tool changes.

## 1.2.1 (2026-10-03)

### Fixed

- `attrkit-mcp login` printed its prompt before it turned echo off, so a key that arrived in
  between (a paste fired the moment the prompt appeared) was echoed on screen. Echo is now off
  before the prompt is printed.

## 1.2.0 (2026-10-03)

### Added

- `attrkit-mcp login` (macOS): asks for the management key with echo off, checks it against the
  API, and stores it in the Keychain item `attrkit-mcp` through `security -i` with the key on
  stdin, so it never appears in argv. `attrkit-mcp logout` removes the item.
- The server reads the key from that Keychain item on macOS when `ATTRKIT_API_KEY` is unset, empty,
  or an unexpanded client placeholder (`$ATTRKIT_API_KEY`, `${ATTRKIT_API_KEY}`,
  `${ATTRKIT_API_KEY:-}`, `${env:ATTRKIT_API_KEY}`, `${input:attrkit-key}`). A real
  `ATTRKIT_API_KEY` still wins and the Keychain is not consulted, so existing configurations behave
  exactly as before.
- The missing-key error now mentions `npx -y @attrkit/mcp login` on macOS.

## 1.1.0 (2026-10-01)

### Added

- `send_server_event` accepts an optional `consent.dma` object: `eea`, and optionally
  `ad_user_data` and `ad_personalization`, the user's answers to Google's EU consent questions. It
  is forwarded to the API as `consent.dma` with `source: "manual"`, and only when you give it; a
  call without it sends exactly what 1.0.0 sent. A key the object does not define (`adUserData`
  for `ad_user_data`) is refused before any request, as the API refuses it.

## 1.0.0 (2026-09-30)

Major version release with input contract formalization, bug fixes, and security hardening.

### Breaking Changes and Migration Notes

#### 1. Paired Ad Identifiers in `import_spend`
- **Change:** In `import_spend`, `adset_id` and `ad_id` (and their camelCase aliases `adsetId` and `adId`) must now be provided together or both omitted.
- **Previous behavior:** At 0.4.6 the MCP schema accepted an unpaired `adset_id`/`ad_id`, but the API already refused it (`dashboard.ts` refine: `.refine((row) => Boolean(row.adsetId) === Boolean(row.adId), "adsetId and adId must be provided together")`). The change moves the refusal client-side.
- **Migration:** Callers submitting ad-grain spend records must provide both `adset_id` and `ad_id` for ad-level rows. If reporting at campaign grain only, omit both identifiers.

#### 2. Strict UUID Format for `campaign_id` in `record_campaign_decision`
- **Change:** In `record_campaign_decision`, `campaign_id` is now validated against RFC 4122 UUID syntax via `z.string().uuid()`.
- **Previous behavior:** In version 0.4.6, `campaign_id` accepted arbitrary non-empty strings.
- **Migration:** Provide the AttrKit internal campaign UUID returned by `list_campaigns` or `get_campaign_decision`. Non-UUID external network identifiers must not be passed.

#### 3. Strict API Base URL Validation and Startup Refusals in `ATTRKIT_API_URL`
- **Overview:** At version 0.4.6, `readConfig` performed no URL validation on `ATTRKIT_API_URL` (any string was passed through, merely trimming trailing slashes). In version 1.0.0, `readConfig` and `validatedApiBaseUrl` enforce four startup-fatal refusals plus validation of unparsable URLs. Violations print the fatal error to stderr and exit with process exit code 1.

##### 3.1 Non-Loopback HTTP Protocol Refusal
- **Change:** Refuses `http:` URLs unless the host is a loopback interface (`localhost`, `127.0.0.1`, `[::1]`). Throws `protocol must be HTTPS, except HTTP is allowed for localhost development`.
- **Consumer-visible effect:** Process startup fails with exit code 1 when configured with a non-loopback HTTP endpoint (e.g. `ATTRKIT_API_URL=http://api.internal.example.com`).
- **Migration:** Switch endpoints to HTTPS (`https://`). Unencrypted HTTP is permitted only for local development on loopback interfaces (`localhost`, `127.0.0.1`, `[::1]`).

##### 3.2 URL Credentials Refusal
- **Change:** Refuses URLs containing basic authentication credentials (username or password). Throws `credentials are not allowed in ATTRKIT_API_URL`.
- **Consumer-visible effect:** Process startup fails with exit code 1 when configured with URL credentials (e.g. `ATTRKIT_API_URL=https://svc:token@api.internal.example.com`).
- **Migration:** Remove credentials from the URL. Authentication must be provided via the `ATTRKIT_API_KEY` environment variable. Internal endpoints or proxies requiring basic authentication must terminate credentials at the proxy or network layer, not inside the base URL.

##### 3.3 Query String Refusal
- **Change:** Refuses URLs containing a query string delimiter (`?`). Throws `query strings are not allowed in ATTRKIT_API_URL`.
- **Consumer-visible effect:** Process startup fails with exit code 1 when configured with query parameters (e.g. `ATTRKIT_API_URL=https://api.example.com?env=staging`).
- **Migration:** Remove query strings from `ATTRKIT_API_URL`. The base URL must be a clean origin/path root; query parameters for specific API routes are attached by the individual tool callers.

##### 3.4 URL Fragment Refusal
- **Change:** Refuses URLs containing a fragment delimiter (`#`). Throws `fragments are not allowed in ATTRKIT_API_URL`.
- **Consumer-visible effect:** Process startup fails with exit code 1 when configured with a fragment (e.g. `ATTRKIT_API_URL=https://api.example.com#section`).
- **Migration:** Remove fragments (`#...`) from `ATTRKIT_API_URL`.

##### 3.5 Unparsable URL Syntax Refusal
- **Change:** Refuses malformed URL strings that cannot be parsed by standard URL parsing (`new URL()`), throwing `Invalid URL` (`TypeError`).
- **Consumer-visible effect:** Process startup fails with exit code 1 on non-URL or malformed strings (e.g. `ATTRKIT_API_URL=not a valid url`).
- **Migration:** Provide a valid, well-formed absolute URL string (e.g. `https://api.example.com`).

### Additional Measured Dispositions

#### 4. CSV Header Response Validation in `export_events`
- **Disposition:** Intentional verification restriction.
- **Detail:** Validates that `/api/v1/export` responses begin with expected AttrKit column identifiers (`type` or `kind` followed by `id`). This prevents non-CSV responses (such as plain text errors or gateway pages) from being accepted as valid exports.

#### 5. App Identifier URL Encoding Consistency and Route Protection (`get_app`, `update_app`, `archive_app`, `get_publishable_key`, `rotate_publishable_key`, `get_revenuecat`, `configure_revenuecat`)
- **Disposition:** Security hardening and consistency fix.
- **Detail:** Dot-segment ids escaped the app route under 0.4.6-style encoding; 1.0.0 keeps them inside the route across all seven app tools. Under 0.4.6-style encoding (`encodeURIComponent`), dot segments were left unescaped, causing standard URL resolution to normalize `..` to `/api/v1/` (the API index) or sibling paths outside `/api/v1/apps/` and `.` to `/api/v1/apps/` (the collection root), escaping the intended app item route. Version 1.0.0 applies opaque-path encoding (`encodeOpaquePathSegment`, encoding `.` as `%252E`) across all seven app-scoped tools (`get_app`, `update_app`, `archive_app`, `get_publishable_key`, `rotate_publishable_key`, `get_revenuecat`, and `configure_revenuecat`), keeping requests strictly within `/api/v1/apps/`. In AttrKit, servable app ids are UUIDs or `"demo-app"` (enforced server-side via `appIdInput`); because no servable id contains a dot, valid UUID and demo-app calls remain byte-identical under both encodings, with no 404 behaviour changes for existing callers.

#### 6. Diagnostic Format Filtering for `Retry-After`
- **Disposition:** Intentional diagnostic hygiene restriction.
- **Detail:** Validates upstream `Retry-After` headers against RFC 9110 specifications (integer seconds or IMF-fixdate format) before inclusion in tool error messages, preventing header injection into model context.

#### 7. `tracking_url` Documented in `create_campaign_link` and `list_links`
- **Disposition:** Documentation fix, no contract change.
- **Detail:** Every version from 0.4.6 passes the API response through unchanged, so `tracking_url` has reached clients since the API began returning it. The tool descriptions now say that `tracking_url` is the campaign link to put in the ad and that `url` is only the App Store destination; 0.4.6 said "Returns the link id and url", which led agents to hand users the store URL as the campaign link.

### Other Changes in 1.0.0

#### 8. `record_campaign_decision` Takes the Reviewed Period, Not Client-Supplied Numbers
- **Change:** The inputs `actor`, `p05`, `p50`, `p95`, `spend_minor_units`, `currency`, `band_width_pct`, `threshold`, `model_version`, `cost_model_version`, `revenue_per_install_minor_units` and `revenue_per_install_quality` are removed; `period` is added. AttriKit freezes the campaign range, spend, costs, revenue basis and model version server-side.
- **Consumer-visible effect:** A 0.4.6-style call that still sends the removed fields succeeds; the fields are stripped and the API never used them.
- **Migration:** Pass `period` equal to the window you reviewed. Omitted, this tool and `get_campaign_decision` use `all`, while `list_campaigns` defaults to `30d`, so a receipt recorded after `list_campaigns` without a period freezes a different window.

#### 9. `get_campaign_decision` Accepts `period`, `cursor` and `limit`
- **Change:** New optional inputs, forwarded to `/api/v1/decisions`.

#### 10. Every Write Carries an Idempotency Key
- **Change:** A POST, PATCH or PUT sent without `idempotency_key` now carries a generated one, so a retried write cannot apply twice. Supply your own key to make retries across restarts idempotent too.

#### 11. `import_spend` Refuses Disagreeing Alias Pairs
- **Change:** A row that sends both spellings of a field (`campaign_id` and `campaignId`, `metric_date` and `metricDate`, and the other pairs) with different values is refused with `<field> and <alias> must match when both are supplied`. 0.4.6 silently used the first.

#### 12. Empty `app_id` Is Refused Where an App Is Required
- **Change:** Tools whose `app_id` is required reject an empty string before any request is sent.

#### 13. `set_usage_cap` and `configure_revenuecat` Are Marked Destructive
- **Change:** Both now carry `destructiveHint: true`, so clients that confirm destructive tools will ask before running them.

#### 14. `create_campaign_link` Separates the Network's Campaign Id
- **Change:** New optional `network_campaign_id` (the ad network's own campaign id, stored as the campaign's external id that `pull_network_spend` matches on). `campaign_id` is documented as an existing AttriKit campaign uuid. The API answers 400 naming `network_campaign_id` when `campaign_id` is not a uuid (it answered 500 before), and 400 when both are sent. `pull_network_spend`, `create_integration` and `import_spend` descriptions are rewritten to match.

#### 15. Integration Ids Are Opaque-Path Encoded
- **Change:** `update_integration` and `delete_integration` encode `connection_id` the way the app tools encode `app_id` (item 5), so `..` or `.` stays inside `/api/v1/integrations/` instead of resolving to `/api/v1/` or the collection.

#### 16. `set_cost_model.assumptions` Keeps a Flat Tool Schema
- **Change:** `assumptions` is advertised as an object of unconstrained values, as in 0.4.6, not as a recursive JSON schema with `$ref`, which some clients' function-calling formats refuse. Values are forwarded unchanged and the API validates them.

#### 17. `update_link_status` Attaches a Network Campaign Id
- **Change:** `status` is now optional and a new optional `network_campaign_id` is accepted; send either or both. It attaches the ad network's own campaign id to a link created without one (`PATCH /api/v1/links/{id}`), so `pull_network_spend` can match that link's spend without recreating it. A campaign that already carries a different network id is refused with 409 `network_campaign_conflict`.
- **Consumer-visible effect:** A 0.4.6-style call sending only `link_id` and `status` behaves as before.
- **Related:** `pull_network_spend` now says AttriKit pulls every enabled connection every 6 hours (today and the 3 days before); call it for an immediate pull or a longer window.

#### 18. `get_attribution_rollup` Returns the Period It Is Given
- **Change:** No change in the package. The tool has always forwarded `period` to `/api/v1/reports/overview`, and until 2026-09-30 the API ignored it and always answered with the last 30 days. The API now honors it.
- **Consumer-visible effect:** Every version of this package, 0.4.6 included, now gets the window it asks for. A call with `period: "90d"` or `"all"` returns different numbers than it did before. A call without `period` still returns the last 30 days.

#### 19. `export_events` Reads the Version 2 Export, With Paging
- **Change:** New optional `version` (1 or 2), and, for version 2, `format` (`csv` or `ndjson`), `limit` (1 to 10,000) and `cursor`, forwarded to `GET /api/v1/export`. Version 2 is the wide record export (campaign, ad, evidence and revenue columns), oldest first, paged. When another page follows, the tool result carries the `AttriKit-Next-Cursor` response header as a second text block (`next_cursor: ...`) and as `structuredContent.next_cursor`; send it back as `cursor`. A result with no `next_cursor` is the last page.
- **Consumer-visible effect:** A 0.4.6-style call without `version` sends the same request and returns the same result as before, byte for byte: the version 1 CSV. `format`, `limit` or `cursor` without `version: 2` is refused with `invalid_request` before any request, because the API ignores them on version 1 and a paging agent would be handed the same capped file again.
- **Related:** The API now applies version 1's 100,000-event cap inside the requested range, so a range older than the app's newest 100,000 events returns its events.

#### 20. New Tool: `send_server_event`
- **Change:** `POST /api/v1/apps/{appId}/events`. Reports an event for one of your users from your own backend by the `customer_user_id` your app passed to `AttriKit.setUserID`, with `event_id`, `event_name`, `event_version`, `occurred_at`, `consent`, optional `properties` and `idempotency_key`. Write scope. Annotated not read-only and not destructive; replaying an `event_id` answers `duplicate`.
- **Consumer-visible effect:** Additive: the tool count is 38 (see 21).

#### 21. New Tool: `lookup_customer_attribution`
- **Change:** `POST /api/v1/apps/{appId}/attribution/lookup`. Returns the campaign, ad set, ad, network, confidence and `attribution_status` of one user's newest install, looked up by `customer_user_id`. Read scope; annotated read-only (POST on the wire only so the id stays out of URLs).
- **Consumer-visible effect:** Additive. With 20, the tool count goes from 36 to 38.

#### 22. Explicit Windows and Paging on the Read Tools
- **Change:** Optional `from` and `to` (UTC `YYYY-MM-DD`) on `list_campaigns`, `list_ads` and `get_attribution_rollup`, replacing `period` for an explicit window (sending both is a 400 at the API). `list_recent_events` gains `from`, `to` and `cursor`; `get_spend` gains `from`, `to`, `cursor` and `limit`; `list_ads` gains `cursor`. Any of `from`, `to` or `cursor` puts events and spend into paged mode, which adds `next_cursor` to the response body.
- **Consumer-visible effect:** Additive. A call that sends none of the new inputs sends the same request as before and gets the same unpaged answer.

#### 23. `configure_revenuecat` Accepts `signing_secret`; a Read Over POST Is Not Retried as a Write
- **Change:** New optional `signing_secret` (16 to 1,024 characters), RevenueCat's HMAC secret for the `X-RevenueCat-Webhook-Signature` header, forwarded to `PUT /api/v1/apps/{appId}/revenuecat`. It is redacted in error output like `authorization_secret`.
- **Consumer-visible effect:** Additive. A call without it sends the same body as before and the API keeps the stored signing secret.
- **Also:** `lookup_customer_attribution` (item 21) is a read carried by POST. It sends no generated idempotency key, and a timeout or network error says the request was read-only instead of telling the agent to retry with an `idempotency_key`.
