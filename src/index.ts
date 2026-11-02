import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z, type RefinementCtx } from "zod";
import { revenueCatProviderAppIdSchema } from "@attrkit/shared";

/**
 * @attrkit/mcp — a thin stdio MCP server that exposes AttriKit's public
 * management API (/api/v1) as agent tools. It holds NO database access and no
 * tenant logic: every tool is one authenticated HTTPS call to the REST API, and
 * the tenant scope is resolved server-side from the secret key. Keep it thin.
 */

export interface McpConfig {
  apiKey: string;
  apiUrl: string;
}

function validatedApiBaseUrl(value: string): URL {
  const url = new URL(value);
  const isLoopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("protocol must be HTTPS, except HTTP is allowed for localhost development");
  }
  if (url.username || url.password) {
    throw new Error("credentials are not allowed in ATTRKIT_API_URL");
  }
  if (value.includes("?")) {
    throw new Error("query strings are not allowed in ATTRKIT_API_URL");
  }
  if (value.includes("#")) {
    throw new Error("fragments are not allowed in ATTRKIT_API_URL");
  }
  return url;
}

/** Read + validate the runtime config. Throws (caller exits 1) if the key is absent. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiKey = env.ATTRKIT_API_KEY;
  if (!apiKey) {
    throw new Error("ATTRKIT_API_KEY is required (create one in AttriKit → Settings → API keys). On macOS, run `npx -y @attrkit/mcp login` to store it in the Keychain.");
  }
  // A client config that writes the variable with an empty value means "not set", not a URL to parse.
  const configuredUrl = env.ATTRKIT_API_URL?.trim() ? env.ATTRKIT_API_URL : undefined;
  const apiUrl = (configuredUrl ?? "https://attrikit.io").replace(/\/+$/, "");
  validatedApiBaseUrl(apiUrl);
  return { apiKey, apiUrl };
}

type JsonPrimitive = boolean | null | number | string;
// The object halves are INTERFACES, not aliases. A `type` alias that references itself through a
// Record is circular and TypeScript refuses it (TS2456); an interface is resolved lazily, so the
// same shape compiles. Four of these were written as aliases by a lane that could not run
// typecheck, and this is the whole of what was wrong with its output.
type JsonValue = JsonObject | JsonPrimitive | JsonValue[];
interface JsonObject { [key: string]: JsonValue }
type JsonRequestValue = JsonPrimitive | JsonRequestObject | JsonRequestValue[] | undefined;
type JsonRequestCandidate = JsonPrimitive | JsonRequestObject | readonly JsonRequestValue[] | undefined;
interface JsonRequestObject { [key: string]: JsonRequestValue }
type QueryParameters = Record<string, string | undefined>;
interface RequestHeaders {
  [name: string]: string;
  authorization: string;
  "content-type": string;
}
type JsonRequestBody = JsonRequestObject;
type ApiErrorEnvelope = JsonObject & { error?: JsonObject };
type JsonCandidate = JsonValue | undefined;

const STRING_TAG = "[object String]";
const NUMBER_TAG = "[object Number]";
const BOOLEAN_TAG = "[object Boolean]";
const OBJECT_TAG = "[object Object]";

function hasRuntimeTag(value: JsonCandidate, tag: string): boolean {
  return Object.prototype.toString.call(value) === tag;
}

function isString(value: JsonCandidate): value is string {
  return hasRuntimeTag(value, STRING_TAG);
}

function isNumber(value: JsonCandidate): value is number {
  return hasRuntimeTag(value, NUMBER_TAG);
}

function isBoolean(value: JsonCandidate): value is boolean {
  return hasRuntimeTag(value, BOOLEAN_TAG);
}

function isObject(value: JsonCandidate): value is JsonObject {
  return hasRuntimeTag(value, OBJECT_TAG);
}

function isRequestObject(value: JsonRequestCandidate): value is JsonRequestObject {
  return Object.prototype.toString.call(value) === OBJECT_TAG;
}

function isJsonObject(value: JsonCandidate): value is JsonObject {
  return isObject(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: JsonCandidate): value is JsonValue {
  return value === null
    || isString(value)
    || isNumber(value)
    || isBoolean(value)
    || (Array.isArray(value) && value.every(isJsonValue))
    || isJsonObject(value);
}

function isApiErrorEnvelope(value: JsonValue): value is ApiErrorEnvelope {
  return isJsonObject(value) && (value.error === undefined || isJsonObject(value.error));
}

type ExpectedResponse = "json" | "text" | "ndjson";

type ApiResult = {
  ok: boolean;
  status: number;
  json: JsonValue;
  rawBody?: string;
  contentType?: string;
  retryAfter?: string;
  /** The AttriKit-Next-Cursor header of a paged export: present only when another page follows. */
  nextCursor?: string;
  expectedResponse?: ExpectedResponse;
};

type ToolContent = {
  content: { type: "text"; text: string }[];
  structuredContent?: JsonObject;
  isError?: boolean;
};

const REQUEST_TIMEOUT_MS = 15_000;
const LONG_REQUEST_TIMEOUT_MS = 120_000;

function requestTimeoutMs(path: string, body: JsonRequestCandidate): number {
  if (path === "/api/v1/export") return LONG_REQUEST_TIMEOUT_MS;
  if (path !== "/api/v1/spend" || !isRequestObject(body)) return REQUEST_TIMEOUT_MS;
  return body.kind === "network_pull" || Array.isArray(body.rows)
    ? LONG_REQUEST_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS;
}

function hasUnsafePathCharacter(path: string): boolean {
  return Array.from(path).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}

function invalidResult(code: string, message: string): ApiResult {
  return {
    ok: false,
    status: 0,
    json: { error: { code, message } },
  };
}

function buildRequestUrl(
  baseUrl: URL,
  path: string,
  query: QueryParameters | undefined,
): URL {
  if (!path.startsWith("/") || hasUnsafePathCharacter(path)) {
    throw new Error("path must be an absolute URL path without whitespace or control characters");
  }
  const url = new URL(`${baseUrl.href.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

function parseJsonBody(text: string): JsonValue {
  if (!text) return null;
  try {
    const parsed: JsonCandidate = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : text;
  } catch {
    return text;
  }
}

function requestHeaders(config: McpConfig, idempotencyKey: string | undefined): RequestHeaders {
  const headers: RequestHeaders = {
    authorization: `AttriKit-Management ${config.apiKey}`,
    "content-type": "application/json",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return headers;
}

function timeoutError(timeoutMs: number, method: string, idempotencyKey: string | undefined) {
  const readOrRemoveOnly = method === "GET" || method === "DELETE";
  return {
    code: "timeout",
    message: readOrRemoveOnly
      ? `no response within ${timeoutMs / 1_000}s. This request was read-only or removal-only; no generated idempotency_key was used.`
      : `no response within ${timeoutMs / 1_000}s. The request may still have been applied on the server; retry with idempotency_key ${idempotencyKey}.`,
  };
}

function networkError(cause: unknown, method: string, idempotencyKey: string | undefined) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "network_error",
    message: method === "GET" || method === "DELETE"
      ? message
      : `${message}. The request may still have been applied on the server; retry with idempotency_key ${idempotencyKey}.`,
  };
}

function resolveIdempotencyKey(
  idempotencyKey: string | undefined,
  method: string,
): string | undefined {
  const mutating = method === "POST" || method === "PATCH" || method === "PUT";
  return idempotencyKey === undefined && mutating ? randomUUID() : idempotencyKey;
}

function apiResultFromResponse(
  response: Response,
  text: string,
  expectedResponse: ExpectedResponse | undefined,
): ApiResult {
  const contentType = response.headers.get("content-type") ?? undefined;
  const retryAfter = response.headers.get("retry-after") ?? undefined;
  const nextCursor = response.headers.get("attrikit-next-cursor") ?? undefined;
  const apiResult: ApiResult = {
    ok: response.ok,
    status: response.status,
    json: parseJsonBody(text),
    rawBody: text,
    expectedResponse: expectedResponse ?? "json",
  };
  if (contentType) apiResult.contentType = contentType;
  if (retryAfter) apiResult.retryAfter = retryAfter;
  if (nextCursor) apiResult.nextCursor = nextCursor;
  return apiResult;
}

/** One authenticated call to the management API. Never throws on non-2xx — the
 *  caller maps the {error:{code}} envelope to an MCP tool error. */
export async function callApi(
  config: McpConfig,
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    query?: QueryParameters;
    body?: JsonRequestValue;
    idempotencyKey?: string;
    expectedResponse?: ExpectedResponse;
    /** A read carried by POST (the user id must stay out of the URL): no generated idempotency key, and timeouts read as a safe retry. */
    readsOnly?: boolean;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ApiResult> {
  const doFetch = options.fetchImpl ?? fetch;
  let baseUrl: URL;
  try {
    baseUrl = validatedApiBaseUrl(config.apiUrl);
  } catch (error) {
    return invalidResult("invalid_api_url", `ATTRKIT_API_URL is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  let url: URL;
  try {
    url = buildRequestUrl(baseUrl, path, options.query);
  } catch (error) {
    return invalidResult("invalid_path", `AttriKit API path is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const controller = new AbortController();
  const timeoutMs = requestTimeoutMs(path, options.body);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = options.method ?? "GET";
  // What the call MEANS, not the verb it travels on: a read over POST has nothing to apply twice.
  const semanticMethod = options.readsOnly ? "GET" : method;
  const idempotencyKey = resolveIdempotencyKey(options.idempotencyKey, semanticMethod);
  try {
    const request: RequestInit = {
      method,
      headers: requestHeaders(config, idempotencyKey),
      signal: controller.signal,
    };
    if (options.body !== undefined) request.body = JSON.stringify(options.body);
    const response = await doFetch(url.toString(), request);
    const text = await response.text();
    return apiResultFromResponse(response, text, options.expectedResponse);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      // A timeout reported as "network_error: The operation was aborted" is indistinguishable from
      // DNS failure, and it leaves the agent unable to tell whether a WRITE landed. The tools most
      // likely to exceed the cap are the slow ones — pull_network_spend round-trips to the ad
      // network, import_spend takes up to 5000 rows, export_events up to 100k events — so the
      // distinction matters most exactly where it was missing.
      json: {
        error: (error instanceof Error && error.name === "AbortError")
          ? timeoutError(timeoutMs, semanticMethod, idempotencyKey)
          : networkError(error, semanticMethod, idempotencyKey),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Anything that came back from the network is redacted before an agent sees it.
 *
 *  Module scope, not a local, because a third-family review found it applied to exactly ONE of the
 *  three branches that print externally-sourced text. The other two — the envelope's own
 *  `error.message`, and the whole raw body on the invalid_response path — printed verbatim. A proxy
 *  or WAF that echoes the request puts the management key in both, so the narrower branch was
 *  redacted while the widest one printed the same secret unbounded. */
const redact = (text: string) => text
  .replace(/(["'](?:credential|authorization_secret|signing_secret|access_token|refresh_token|client_secret)["']\s*:\s*["'])[^"']+(["'])/gi, "$1[redacted]$2")
  .replace(/(?<![A-Za-z0-9])(?:mk|pk|sk|rk)_[A-Za-z0-9_-]{8,}/g, "[redacted-key]")
  .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]")
  .replace(/\bAttriKit-(Management|Publishable)\s+\S+/g, "AttriKit-$1 [redacted]")
  .replace(/\bEAA[A-Za-z0-9_-]{8,}/g, "[redacted-meta-token]")
  .replace(/\b1\/\/[A-Za-z0-9._-]{8,}/g, "[redacted-google-token]")
  .replace(/([?&](?:token|secret|key|password|code|signature)=)[^&\s]+/gi, "$1[redacted]");

/** A cursor is opaque base64url; anything else in the header is not one, and is not handed to an agent. */
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_\-=.]{1,4096}$/;

/**
 * Surfaces the AttriKit-Next-Cursor header of a paged export. The header is the ONLY place the API
 * puts the next cursor (the body is the export itself), so a tool result that dropped it left an
 * agent unable to read past the first page. Absent header: the result is returned untouched, so
 * every other tool, and export version 1, answers byte for byte as before.
 */
function withNextCursor(tool: ToolContent, nextCursor: string | undefined): ToolContent {
  if (nextCursor === undefined || !OPAQUE_CURSOR_PATTERN.test(nextCursor)) return tool;
  return {
    ...tool,
    content: [...tool.content, { type: "text", text: `next_cursor: ${nextCursor}` }],
    structuredContent: { ...tool.structuredContent, next_cursor: nextCursor },
  };
}

/**
 * A version 2 NDJSON export is one JSON object per line, so it is neither the JSON envelope nor the
 * CSV header the other two shapes are validated against. Validated the same way: the first line must
 * be an export record (an install or an event with an id), and an HTML page or a plain-text block
 * answered with a 200 is refused. An empty page is a valid export of a range with no records.
 */
function ndjsonToolResult(result: ApiResult): ToolContent {
  const body = result.rawBody ?? "";
  const contentType = (result.contentType ?? "").toLowerCase();
  const firstLine = body.split("\n", 1)[0]?.trim() ?? "";
  const looksLikeRecord = (() => {
    try {
      const parsed: JsonCandidate = JSON.parse(firstLine);
      return isJsonObject(parsed)
        && (parsed.type === "install" || parsed.type === "event")
        && isString(parsed.id);
    } catch {
      return false;
    }
  })();
  const isEmptyPage = body.trim() === "" && contentType.includes("ndjson");
  if (!isEmptyPage && (contentType.includes("text/html") || !looksLikeRecord)) {
    return {
      content: [{
        type: "text",
        text: `AttriKit API error (${result.status}): invalid_response: expected an NDJSON export but received ${body === "" ? "an empty body" : "a body that is not export records"} with Content-Type ${result.contentType ?? "unknown content type"}. Body:\n${redact(body).slice(0, 600)}`,
      }],
      isError: true,
    };
  }
  return withNextCursor({ content: [{ type: "text", text: body }], structuredContent: { value: body } }, result.nextCursor);
}

export function toToolResult(result: ApiResult): ToolContent {
  if (!result.ok) {
    const envelope = isApiErrorEnvelope(result.json)
      ? result.json
      : null;
    const rawCode = envelope?.error?.code;
    const code = isString(rawCode) && rawCode !== ""
      ? redact(rawCode).slice(0, 120)
      : `http_${result.status}`;
    // `as` is a cast, not a validation: this JSON came from whatever answered. A third-family
    // review pointed out that a truthy non-string message — `{"error":{"message":{"a":1}}}`, or a
    // number — reached redact() and threw on `.replace`, turning a handled API error into a crash
    // inside the tool call. Bounded too, since the length is equally unchecked.
    const rawMessage = envelope?.error?.message;
    const hasMessage = isString(rawMessage) && rawMessage.trim() !== "";
    const message = hasMessage
      ? `: ${redact(rawMessage).slice(0, 400)}`
      : "";
    const retryAfterValue = result.retryAfter === undefined
      ? ""
      : redact(result.retryAfter).trim().slice(0, 120);
    const validRetryAfter = /^\d{1,10}$/.test(retryAfterValue)
      || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfterValue);
    const retryAfter = result.status === 429 && validRetryAfter
      ? ` (Retry-After: ${retryAfterValue})`
      : "";
    // rawBody was captured on every response and used on NO error path, so a non-2xx reduced to a
    // bare code: a WAF block, a proxy interstitial and a 404 from a mistyped ATTRKIT_API_URL were
    // indistinguishable. Included when the envelope carried no message, bounded so a full HTML
    // page cannot flood the agent's context.
    // Redacted before it is shown. The body comes from whatever answered — a WAF, a proxy, an
    // OAuth error page — and those routinely echo the request, including the Authorization header.
    // Putting that verbatim into an agent's context, and into whatever logs it, would leak the
    // management key this server authenticates with.
    const excerpt = !hasMessage && result.rawBody
      ? ` — body: ${redact(result.rawBody.replace(/\s+/g, " ").trim()).slice(0, 300)}`
      : "";
    // 401 is the same code for an absent header, a wrong key, a revoked key and an expired one, so
    // it is worth naming the variable the user can actually check.
    const hint = result.status === 401
      ? " Check ATTRKIT_API_KEY: this is the same error for a missing, wrong, revoked or expired key."
      : "";
    return {
      content: [{
        type: "text",
        text: `AttriKit API error (${result.status || "network"}): ${code}${message}${retryAfter}${excerpt}${hint}`,
      }],
      isError: true,
    };
  }

  const expectedResponse = result.expectedResponse ?? "json";
  if (expectedResponse === "ndjson") return ndjsonToolResult(result);
  const isEmptySuccess = result.status === 204
    && (result.rawBody === undefined || result.rawBody === "");
  const isJsonEnvelope = isJsonObject(result.json) && Object.hasOwn(result.json, "data");
  // A string is not a success. `export_events` is the only tool declaring expectedResponse "text",
  // which is exactly why the 0.4.0 envelope fix — the one that stopped an HTML login page reading
  // as a completed mutation — did not cover it: it was structurally exempted, and no test ever
  // invokes this tool. An agent asked to "export last week's installs" got the sign-in page back as
  // the tool result with no error flag, and wrote it to a .csv.
  //
  // The API answers text/csv (apps/web/app/api/v1/export/route.ts:52). contentType was already
  // captured and never consulted; it is the check.
  const contentType = (result.contentType ?? "").toLowerCase();
  // Reject what the defect actually was — an HTML page standing in for the export — rather than
  // whitelisting one MIME type. A fresh review pointed out the first version required text/csv, so
  // a perfectly good CSV served as application/octet-stream, text/plain, or with no content type at
  // all (S3, a CDN, a static file server) would have been reported as an error. The failure mode is
  // narrow and recognisable: a sign-in page announces itself as HTML, and its body starts with a
  // tag. Both are checked, because a proxy can send HTML with the wrong content type too.
  // Any leading `<`, not an enumeration of four tag names. The enumeration was itself the defect a
  // third-family review found: a sign-in page served as text/plain and beginning `<form>` — or
  // `<!--`, `<script>`, `<?xml`, a `<div>` wrapper — passed straight through as a completed export.
  // Safe to widen this far because every field of a real export is quoted
  // (`dashboardCsv` escapes unconditionally), so a legitimate body always starts with `"`.
  // Validated POSITIVELY, which is what the invariant supports. Rejecting a leading `<` still let
  // `Access denied` through as a completed export — a third-family review's point, and the comment
  // above already named the property that settles it: `dashboardCsv` quotes every field
  // unconditionally, including the header row it always emits, so a real export begins with `"`.
  // One tool declares expectedResponse "text" (`export_events`), so this is not a general text rule.
  const looksLikeCsv = (() => {
    if (!isString(result.json)) return false;
    const firstLine = result.json.split("\n", 1)[0]?.trim() ?? "";
    if (!firstLine || firstLine.startsWith("<")) return false;
    const columns = firstLine.split(",").map((field) => field.trim().replace(/^"(.*)"$/s, "$1"));
    // A header row, not merely "text that is not markup". Two or more fields, each a column token.
    // `Access denied` has no comma; `Access denied, please log in` has one but its fields carry
    // spaces, so neither passes — while both the quoted rows production emits and an unquoted CSV
    // from a cache or a static host do.
    // No spaces: the real columns are snake_case identifiers (`type,id,app_id,name_or_grade,...`).
    // Allowing them, as the first version of this check did, let `Access denied, please log in`
    // back through — a comma is not evidence of a table.
    return columns.length >= 2
      && (columns[0] === "type" || columns[0] === "kind")
      && columns[1] === "id"
      && columns.every((field) => /^[A-Za-z][A-Za-z0-9_]*$/.test(field));
  })();
  const isExpectedText = expectedResponse === "text"
    && isString(result.json)
    && !contentType.includes("text/html")
    && looksLikeCsv;
  if (!isEmptySuccess && !isJsonEnvelope && !isExpectedText) {
    const reportedContentType = result.contentType ?? "unknown content type";
    const received = result.json === null
      ? "an empty body"
      : Array.isArray(result.json)
        ? "a JSON array"
        : isJsonObject(result.json)
          ? "a JSON object without a data field"
          : `a ${isString(result.json) ? "string" : isNumber(result.json) ? "number" : "boolean"} body`;
    // Redacted and bounded like the error excerpt above. This branch prints whatever answered
    // instead of the expected envelope — a login page, a WAF block, an OAuth error — which is
    // exactly the class of response that echoes the Authorization header back.
    const body = redact(
      result.rawBody
        ?? (isString(result.json)
          ? result.json
          : JSON.stringify(result.json, null, 2)),
    ).slice(0, 600);
    // Worded off the DECLARED expectation, not off the JSON branch. `export_events` declares
    // expectedResponse "text" and is special-cased three lines above, so a body that failed
    // looksLikeCsv - an HTML sign-in page or a plain-text WAF block answered with 200 - told the
    // agent a JSON envelope had been expected and sent it to debug the wrong half of a text export.
    const expectation = expectedResponse === "text"
      ? "expected a CSV export"
      : "expected a JSON data envelope";
    return {
      content: [{
        type: "text",
        text: `AttriKit API error (${result.status}): invalid_response: ${expectation} but received ${received} with Content-Type ${reportedContentType}. Body:\n${body}`,
      }],
      isError: true,
    };
  }
  const structured = isJsonObject(result.json)
    ? result.json
    : { value: result.json };
  return withNextCursor({
    content: [{ type: "text", text: JSON.stringify(result.json, null, 2) }],
    structuredContent: structured,
  }, result.nextCursor);
}

export const TOOL_NAMES = [
  "whoami",
  "get_usage_cap",
  "set_usage_cap",
  "list_apps",
  "create_app",
  "get_app",
  "update_app",
  "archive_app",
  "get_publishable_key",
  "rotate_publishable_key",
  "list_api_keys",
  "create_api_key",
  "revoke_api_key",
  "list_links",
  "create_campaign_link",
  "update_link_status",
  "list_campaigns",
  "list_ads",
  "list_recent_events",
  "list_event_deliveries",
  "get_campaign_decision",
  "record_campaign_decision",
  "get_attribution_rollup",
  "get_spend",
  "import_spend",
  "set_cost_model",
  "pull_network_spend",
  "list_integrations",
  "create_integration",
  "update_integration",
  "delete_integration",
  "get_revenuecat",
  "configure_revenuecat",
  "list_webhooks",
  "create_webhook",
  "delete_webhook",
  "export_events",
  "send_server_event",
  "lookup_customer_attribution",
] as const;

export const SERVER_VERSION = "2.0.1";

const periodSchema = z
  .enum(["7d", "30d", "90d", "all"])
  .describe("Reporting window. Omit to use the endpoint's documented default.")
  .optional();
const appIdSchema = z.string().describe("Optional app id to scope the result to one app.").optional();
const requiredAppIdSchema = z.string().min(1).describe("The AttriKit app id.");
// Dot-segment path protection: WHATWG URL parsing (used by new URL(path, base) in call()) normalizes
// dot segments according to RFC 3986 / WHATWG URL standard. Under WHATWG URL, %2e is considered an encoded dot
// segment (single-dot: "." or "%2e"; double-dot: "..", ".%2e", "%2e.", "%2e%2e"). Therefore, single-encoding
// (e.g. encodeURIComponent, which leaves "." unescaped, or encoding "." as "%2E") still normalizes,
// causing path segments like ".." or "." to escape the /api/v1/apps/ route prefix (e.g. /api/v1/apps/..
// collapses to /api/v1/ and /api/v1/apps/../revenuecat collapses to /api/v1/revenuecat).
// Double-encoding "." as "%252E" ensures the dots are preserved as literal "%2E" in the URL pathname,
// preventing WHATWG URL path normalization while keeping the request strictly within /api/v1/apps/.
//
// Coupling & servable IDs: In AttriKit, servable app identifiers are UUIDs or "demo-app" (enforced
// server-side in apps/web/app/api/v1/apps/[appId]/route.ts by scopedAppId via appIdInput: z.uuid().or(z.literal("demo-app"))).
// Neither UUIDs nor "demo-app" contain dots, so valid IDs are completely unaffected and byte-identical
// under both encodeURIComponent and encodeOpaquePathSegment. If appIdInput is ever widened to support
// bundle-style IDs with dots (e.g. "com.example.app"), note that double-encoded "%252E" will reach the backend.
const encodeOpaquePathSegment = (value: string): string =>
  encodeURIComponent(value).replaceAll(".", "%252E");
const idempotencyKeySchema = z.string().max(255)
  .describe("Stable retry key for this exact mutation.")
  .optional();
const ownersSchema = z.record(
  z.string(),
  z.enum(["attrkit", "revenuecat", "customer"]),
);
// No default on either: an absent option keeps the API's own ('all', 'purchase' on create; unchanged
// on update), and a default here would put the field into every request body.
const deliveryScopeSchema = z.enum(["all", "attributed"]).optional()
  .describe("Which events a Meta or TikTok integration sends. all (the API's default): the events of every install with measurement consent, organic ones included. attributed: send only events of installs AttriKit attributes to this connection's network (click ID, link token, or a Matched install at or above the delivery floor); others are suppressed with attributed_only_suppressed. Meta and TikTok only: a Google integration refuses attributed.");
const renewalEventSchema = z.enum(["purchase", "custom"]).optional()
  .describe("How a renewal reaches Meta website and TikTok web events. purchase (the API's default): as Purchase with its price and currency. custom: as the custom event subscription_renewed with its price and currency, so Purchase counts one-time purchases only. App events are unchanged. A Google integration refuses custom.");
// The list endpoints return a next_cursor the agent can SEE, while three of these tools had no way
// to send one back — so an agent that noticed the cursor re-issued the identical call and looped,
// and a workspace past the default page reported on the first page and said nothing. list_links
// already had both, which is what made the omission an oversight rather than a design.
const cursorSchema = z.string().optional()
  .describe("Pass the next_cursor from the previous response to fetch the following page. Omit for the first page.");
const listLimitSchema = z.number().int().min(1).max(200).optional()
  .describe("Rows per page, 1-200. The API defaults to 50, so a workspace with more than that needs paging.");

// An explicit UTC calendar-day window, the API's from/to pair (1970-01-01 to 9998-12-31, inclusive).
// The report tools take both together or neither and refuse them beside `period`; the events and
// spend feeds take either bound alone. The API validates all of it, so the tool only shapes the day.
const calendarDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a UTC calendar day, YYYY-MM-DD.");
const rangeFromSchema = calendarDaySchema.optional()
  .describe("First UTC day of an explicit window, YYYY-MM-DD, inclusive. Use instead of period; sending both is a 400.");
const rangeToSchema = calendarDaySchema.optional()
  .describe("Last UTC day of an explicit window, YYYY-MM-DD, inclusive. Use instead of period; sending both is a 400.");

type SpendAliasValue = string | number | null | undefined;
type SpendAliasPair = readonly [string, string, SpendAliasValue, SpendAliasValue];

function validateMatchingSpendAliases(
  pairs: readonly SpendAliasPair[],
  context: RefinementCtx,
): void {
  for (const [preferred, alias, preferredValue, aliasValue] of pairs) {
    if (preferredValue !== undefined && aliasValue !== undefined && preferredValue !== aliasValue) {
      context.addIssue({
        code: "custom",
        path: [alias],
        message: `${preferred} and ${alias} must match when both are supplied`,
      });
    }
  }
}

function validateRequiredSpendValues(
  values: readonly (readonly [string, SpendAliasValue])[],
  context: RefinementCtx,
): void {
  for (const [path, value] of values) {
    if (value === undefined) {
      context.addIssue({
        code: "custom",
        path: [path],
        message: `${path} is required`,
      });
    }
  }
}

function validatePairedAdIds(
  adsetId: string | null | undefined,
  adId: string | null | undefined,
  context: RefinementCtx,
): void {
  if ((adsetId == null) !== (adId == null)) {
    context.addIssue({
      code: "custom",
      path: adsetId == null ? ["adset_id"] : ["ad_id"],
      message: "adset_id and ad_id must be supplied together",
    });
  }
}

const spendRowSchema = z.object({
  campaign_id: z.string().optional()
    .describe("The AttriKit campaign UUID, NOT the ad network's own campaign id (that is create_campaign_link.network_campaign_id). It is the most common mistake here: read it from list_campaigns. The API rejects a network id by name. Preferred snake_case spelling."),
  campaignId: z.string().optional()
    .describe("Accepted camelCase alias for campaign_id."),
  // adset_id and ad_id must be supplied TOGETHER; either alone is a 400 at the API.
  adset_id: z.string().optional().nullable().describe("Ad set id. Must be sent together with ad_id; either one alone is rejected."),
  adsetId: z.string().optional().nullable().describe("Accepted camelCase alias for adset_id."),
  ad_id: z.string().optional().nullable().describe("Ad id. Must be sent together with adset_id; either one alone is rejected."),
  adId: z.string().optional().nullable().describe("Accepted camelCase alias for ad_id."),
  adset_name: z.string().optional().nullable().describe("Optional ad set name, as the network reports it."),
  adsetName: z.string().optional().nullable().describe("Accepted camelCase alias for adset_name."),
  ad_name: z.string().optional().nullable().describe("Optional ad name, as the network reports it."),
  adName: z.string().optional().nullable().describe("Accepted camelCase alias for ad_name."),
  metric_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe("Required metric date. Preferred snake_case spelling."),
  metricDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe("Accepted camelCase alias for metric_date."),
  clicks: z.number().int().nonnegative().optional()
    .describe("Clicks the network reported for this row. The API stores 0 when omitted."),
  impressions: z.number().int().nonnegative().optional()
    .describe("Impressions the network reported for this row. The API stores 0 when omitted."),
  spend_minor_units: z.number().int().nonnegative().optional()
    .describe("Required spend amount. Preferred snake_case spelling."),
  spendMinorUnits: z.number().int().nonnegative().optional()
    .describe("Accepted camelCase alias for spend_minor_units."),
}).superRefine((row, context) => {
  validateMatchingSpendAliases([
    ["campaign_id", "campaignId", row.campaign_id, row.campaignId],
    ["adset_id", "adsetId", row.adset_id, row.adsetId],
    ["ad_id", "adId", row.ad_id, row.adId],
    ["adset_name", "adsetName", row.adset_name, row.adsetName],
    ["ad_name", "adName", row.ad_name, row.adName],
    ["metric_date", "metricDate", row.metric_date, row.metricDate],
    ["spend_minor_units", "spendMinorUnits", row.spend_minor_units, row.spendMinorUnits],
  ], context);
  validateRequiredSpendValues([
    ["campaign_id", row.campaign_id ?? row.campaignId],
    ["metric_date", row.metric_date ?? row.metricDate],
    ["spend_minor_units", row.spend_minor_units ?? row.spendMinorUnits],
  ], context);
  validatePairedAdIds(
    row.adset_id ?? row.adsetId,
    row.ad_id ?? row.adId,
    context,
  );
});

type SpendRowInput = z.infer<typeof spendRowSchema>;

function normalizeSpendRow(row: SpendRowInput) {
  return {
    campaignId: row.campaign_id ?? row.campaignId,
    adsetId: row.adset_id ?? row.adsetId,
    adId: row.ad_id ?? row.adId,
    adsetName: row.adset_name ?? row.adsetName,
    adName: row.ad_name ?? row.adName,
    metricDate: row.metric_date ?? row.metricDate,
    clicks: row.clicks,
    impressions: row.impressions,
    spendMinorUnits: row.spend_minor_units ?? row.spendMinorUnits,
  };
}

/** Build the MCP server with the AttriKit tools bound to `config`. */
export function createServer(config: McpConfig, fetchImpl?: typeof fetch): McpServer {
  const server = new McpServer({ name: "attrkit", version: SERVER_VERSION });
  const call = (path: string, options?: Parameters<typeof callApi>[2]) =>
    callApi(config, path, { fetchImpl, ...options });

  server.registerTool(
    "whoami",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Inspect management-key scope",
      description: "Return the authenticated workspace, plan, app restriction and read/write scopes.",
      inputSchema: {},
    },
    async () => toToolResult(await call("/api/v1/whoami")),
  );

  server.registerTool(
    "get_usage_cap",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Get the workspace usage cap",
      description: "Return the workspace's monthly qualified-install cap, alert email, current billing period and usage. Requires a workspace-scoped read key.",
      inputSchema: {},
    },
    async () => toToolResult(await call("/api/v1/workspace/usage-cap")),
  );

  server.registerTool(
    "set_usage_cap",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Set the workspace usage cap",
      description: "Set a monthly qualified-install cap of at least 10,000 and its alert email. Pass null for both values to clear the cap. Requires a workspace-scoped write key.",
      inputSchema: {
        monthly_qualified_install_cap: z.number()
          .int()
          .min(10_000)
          .max(Number.MAX_SAFE_INTEGER)
          .nullable()
          .describe("Monthly qualified-install cap, a whole number of at least 10,000, or null to clear the cap (alert_email must then be null too). Once the cap is exceeded, additional install charges stop for the rest of the billing period."),
        alert_email: z.string().trim().email().max(320).nullable()
          .describe("Email address for the cap's alerts, at most 320 characters, or null to clear the cap (monthly_qualified_install_cap must then be null too)."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({
      monthly_qualified_install_cap,
      alert_email,
      idempotency_key,
    }) => {
      if (
        (monthly_qualified_install_cap === null)
        !== (alert_email === null)
      ) {
        return {
          content: [{
            type: "text",
            text: "AttriKit usage-cap validation error: set both cap and alert email, or pass null for both to clear them.",
          }],
          isError: true,
        };
      }
      return toToolResult(await call("/api/v1/workspace/usage-cap", {
        method: "PATCH",
        idempotencyKey: idempotency_key,
        body: {
          monthly_qualified_install_cap,
          alert_email,
        },
      }));
    },
  );

  server.registerTool(
    "list_apps",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List apps",
      description: "List the iOS and Android apps in your AttriKit workspace (id, name, platform, bundle id, store id, status).",
      inputSchema: { cursor: cursorSchema, limit: listLimitSchema },
    },
    async ({ cursor, limit }) => {
      const query: QueryParameters = {};
      if (cursor) query.cursor = cursor;
      if (limit !== undefined) query.limit = String(limit);
      return toToolResult(await call("/api/v1/apps", { query }));
    },
  );

  server.registerTool(
    "create_app",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Create an app",
      description: "Create an iOS or Android app without the web UI. Returns the publishable key and a one-time app-scoped management key.",
      inputSchema: {
        name: z.string().min(1).max(80).describe("App name, 1 to 80 characters."),
        bundle_id: z.string().min(3).max(255)
          .describe("The iOS bundle id or Android package name, for example com.example.app, 3 to 255 characters."),
        platform: z.enum(["iOS", "Android"]).describe("The app's platform: iOS or Android."),
        store_url: z.string().url().describe("The app's App Store or Google Play page URL."),
        timezone: z.string().max(64).optional()
          .describe("The app's timezone, at most 64 characters. The API uses UTC when omitted."),
        device_matching_mode: z.enum(["on", "strict"]).optional()
          .describe("Coverage mode. on (the API's default): maximum coverage, events of all eligible matches are sent. strict: events of verified matches only."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({
      name,
      bundle_id,
      platform,
      store_url,
      timezone,
      device_matching_mode,
      idempotency_key,
    }) => {
      const body: JsonRequestBody = { name, bundleId: bundle_id, platform, storeUrl: store_url };
      if (timezone) body.timezone = timezone;
      if (device_matching_mode) body.deviceMatchingMode = device_matching_mode;
      return toToolResult(await call("/api/v1/apps", {
        method: "POST",
        idempotencyKey: idempotency_key,
        body,
      }));
    },
  );

  server.registerTool(
    "get_app",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Get an app",
      description: "Return one app's configuration.",
      inputSchema: { app_id: requiredAppIdSchema },
    },
    async ({ app_id }) => toToolResult(await call(`/api/v1/apps/${encodeOpaquePathSegment(app_id)}`)),
  );

  server.registerTool(
    "update_app",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Update an app",
      description: "Update app metadata, store destination, timezone or coverage mode.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        name: z.string().min(1).max(80).optional().describe("New app name, 1 to 80 characters. Omit to keep the current one."),
        bundle_id: z.string().min(3).max(255).optional()
          .describe("New iOS bundle id or Android package name, 3 to 255 characters. Omit to keep the current one."),
        platform: z.enum(["iOS", "Android"]).optional().describe("New platform, iOS or Android. Omit to keep the current one."),
        store_url: z.string().url().optional()
          .describe("New App Store or Google Play page URL. Omit to keep the current one."),
        timezone: z.string().max(64).optional()
          .describe("New app timezone, at most 64 characters. Omit to keep the current one."),
        device_matching_mode: z.enum(["on", "strict"]).optional()
          .describe("New coverage mode. on: maximum coverage, events of all eligible matches are sent. strict: events of verified matches only. Omit to keep the current one."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({
      app_id,
      name,
      bundle_id,
      platform,
      store_url,
      timezone,
      device_matching_mode,
      idempotency_key,
    }) => {
      const body: JsonRequestBody = {};
      if (name) body.name = name;
      if (bundle_id) body.bundleId = bundle_id;
      if (platform) body.platform = platform;
      if (store_url) body.storeUrl = store_url;
      if (timezone) body.timezone = timezone;
      if (device_matching_mode) body.deviceMatchingMode = device_matching_mode;
      return toToolResult(await call(`/api/v1/apps/${encodeOpaquePathSegment(app_id)}`, {
        method: "PATCH",
        idempotencyKey: idempotency_key,
        body,
      }));
    },
  );

  server.registerTool(
    "archive_app",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Archive an app",
      description: "Archive an app and remove it from active customer operations.",
      inputSchema: { app_id: requiredAppIdSchema },
    },
    async ({ app_id }) => toToolResult(await call(`/api/v1/apps/${encodeOpaquePathSegment(app_id)}`, {
      method: "DELETE",
    })),
  );

  server.registerTool(
    "get_publishable_key",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Get an app publishable key",
      description: "Reveal the recoverable SDK publishable key for an app.",
      inputSchema: { app_id: requiredAppIdSchema },
    },
    async ({ app_id }) => toToolResult(await call(
      `/api/v1/apps/${encodeOpaquePathSegment(app_id)}/publishable-key`,
    )),
  );

  server.registerTool(
    "rotate_publishable_key",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Rotate an app publishable key",
      description: "Issue a new SDK publishable key and return the old-key grace deadline.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ app_id, idempotency_key }) => toToolResult(await call(
      `/api/v1/apps/${encodeOpaquePathSegment(app_id)}/publishable-key`,
      { method: "POST", idempotencyKey: idempotency_key },
    )),
  );

  server.registerTool(
    "list_api_keys",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List management keys",
      description: "List masked workspace and app management keys. Secret plaintext is never returned.",
      inputSchema: {},
    },
    async () => toToolResult(await call("/api/v1/api-keys")),
  );

  server.registerTool(
    "create_api_key",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Create a management key",
      description: "Create a read-only or read/write workspace or app key. The secret is returned once.",
      inputSchema: {
        label: z.string().min(1).max(80).describe("A name for the key, 1 to 80 characters, shown by list_api_keys."),
        scopes: z.array(z.enum(["read", "write"])).min(1).max(2)
          .describe("[\"read\"] or [\"read\", \"write\"]; every key needs read, so the API refuses [\"write\"] alone. Read permits every read, including the POST attribution lookup; write is also required to create, update, rotate, archive and revoke, and to record server events and decisions."),
        app_id: z.string().uuid().optional().nullable()
          .describe("App UUID to clamp the key to one app. Omit or pass null for a workspace key. An app-scoped caller can only create keys for its own app."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ label, scopes, app_id, idempotency_key }) =>
      toToolResult(await call("/api/v1/api-keys", {
        method: "POST",
        idempotencyKey: idempotency_key,
        body: { label, scopes, app_id: app_id ?? null },
      })),
  );

  server.registerTool(
    "revoke_api_key",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Revoke a management key",
      description: "Immediately revoke a management key by id.",
      inputSchema: { key_id: z.string().uuid().describe("The key's id (UUID), as returned by list_api_keys.") },
    },
    async ({ key_id }) => toToolResult(await call(`/api/v1/api-keys/${encodeURIComponent(key_id)}`, {
      method: "DELETE",
    })),
  );

  server.registerTool(
    "list_links",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List campaign links",
      description:
        "List tracking links, optionally for one app. Each link's tracking_url is the campaign link to use in the ad (null if unavailable); url is the store destination.",
      inputSchema: {
        app_id: appIdSchema,
        cursor: cursorSchema,
        limit: listLimitSchema,
      },
    },
    async ({ app_id, cursor, limit }) => toToolResult(await call("/api/v1/links", {
      query: {
        appId: app_id,
        cursor,
        limit: limit === undefined ? undefined : String(limit),
      },
    })),
  );

  server.registerTool(
    "list_campaigns",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List campaigns",
      description:
        "List ad campaigns with their honest profit surface. `call` preserves the original v1 fail-closed automation behavior for multi-component rows; `recommended_call` is the additive SCALE/CUT/HOLD recommendation the current engine made. It is backed by `envelope_lower`/`envelope_central`/`envelope_upper`. Read `aggregation_basis` before quoting the low end: single_component_quantiles means it is a calibrated 5th percentile; marginal_endpoint_sum_no_joint_coverage means it is the sum of each component period's own low end, which is pessimistic against independence but is NOT a floor or a guarantee, so describe it as a scenario. The quantile-named `profit_p05`/`profit_p50`/`profit_p95` are null unless one component supplied calibrated ones. Also includes spend, retention, and payback.",
      inputSchema: { app_id: appIdSchema, period: periodSchema, from: rangeFromSchema, to: rangeToSchema, cursor: cursorSchema, limit: listLimitSchema },
    },
    async ({ app_id, period, from, to, cursor, limit }) => {
      const query = {
        appId: app_id,
        period,
        from,
        to,
        cursor: cursor || undefined,
        limit: limit === undefined ? undefined : String(limit),
      };
      return toToolResult(await call("/api/v1/reports/campaigns", { query }));
    },
  );

  server.registerTool(
    "list_ads",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List creative-level ad performance",
      description: "Return ad and ad-set performance, evidence tiers, ROAS, CPA, CPC and modeled remainders.",
      inputSchema: {
        app_id: appIdSchema,
        period: periodSchema,
        from: rangeFromSchema,
        to: rangeToSchema,
        cursor: cursorSchema,
        limit: listLimitSchema,
      },
    },
    async ({ app_id, period, from, to, cursor, limit }) => toToolResult(await call("/api/v1/reports/ads", {
      query: {
        appId: app_id,
        period,
        from,
        to,
        cursor,
        limit: limit === undefined ? undefined : String(limit),
      },
    })),
  );

  server.registerTool(
    "list_recent_events",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List recent events and installs",
      description: "Return the same recent attribution events and installs visible on the Live dashboard.",
      inputSchema: {
        app_id: appIdSchema,
        limit: z.number().int().min(1).max(50).optional()
          .describe("Rows to return, 1-50. The API returns 50 when omitted."),
        from: calendarDaySchema.optional().describe("First UTC day to include, YYYY-MM-DD. May be sent without to. Sending from, to or cursor switches the response to paged mode, which adds next_cursor."),
        to: calendarDaySchema.optional().describe("Last UTC day to include, YYYY-MM-DD. May be sent without from."),
        cursor: cursorSchema,
      },
    },
    async ({ app_id, limit, from, to, cursor }) => toToolResult(await call("/api/v1/events", {
      query: {
        appId: app_id,
        from,
        to,
        cursor,
        limit: limit === undefined ? undefined : String(limit),
      },
    })),
  );

  server.registerTool(
    "list_event_deliveries",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List what happened to each event sent to ad networks",
      description: "Return one row per delivery of an event to a network connection, newest first: its state (held, queued, sending, retrying, sent, suppressed or failed), the reason with a one-line explanation (for example consent_suppressed, attributed_only_suppressed or destination_event_too_old), attempts, the last HTTP status, and for a held row when it is expected to be released. Use it to answer why an event did not reach Meta, TikTok or Google. Read scope is enough.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        install_id: z.string().optional().describe("Only this install: the install epoch id the events feed and the export call the install id."),
        event_id: z.string().optional().describe("Only this event's deliveries, one per connection that receives it."),
        connection_id: z.string().optional().describe("Only this network connection, as returned by list_integrations."),
        network: z.string().optional().describe("Only connections to this network, for example meta."),
        state: z.enum(["held", "queued", "sending", "retrying", "sent", "suppressed", "failed"]).optional().describe("Only deliveries in this state."),
        from: calendarDaySchema.optional().describe("First UTC day the event was received, YYYY-MM-DD. May be sent without to."),
        to: calendarDaySchema.optional().describe("Last UTC day the event was received, YYYY-MM-DD, inclusive. May be sent without from."),
        cursor: cursorSchema,
        limit: listLimitSchema,
      },
    },
    async ({ app_id, install_id, event_id, connection_id, network, state, from, to, cursor, limit }) => toToolResult(await call(
      `/api/v1/apps/${encodeOpaquePathSegment(app_id)}/deliveries`,
      {
        query: {
          installId: install_id,
          eventId: event_id,
          connectionId: connection_id,
          network,
          state,
          from,
          to,
          cursor,
          limit: limit === undefined ? undefined : String(limit),
        },
      },
    )),
  );

  server.registerTool(
    "get_campaign_decision",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Get campaign decisions (scale / cut / hold)",
      description:
        "Return AttriKit's profit DECISIONS for your campaigns: the scale/cut/hold call and confidence, computed by the attribution engine. Report the `call` VERBATIM — do not recompute or override it; when it says not_enough_data, say so. This is the tool to drive budget automation.",
      inputSchema: {
        app_id: appIdSchema,
        period: periodSchema,
        cursor: cursorSchema,
        limit: listLimitSchema,
      },
    },
    async ({ app_id, period, cursor, limit }) => toToolResult(await call("/api/v1/decisions", {
      query: {
        appId: app_id,
        period,
        cursor,
        limit: limit === undefined ? undefined : String(limit),
      },
    })),
  );

  server.registerTool(
    "record_campaign_decision",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Record a campaign decision",
      description: "Record a scale/cut/hold decision for the reporting period the caller reviewed. AttriKit freezes that period's current campaign range, spend, costs, revenue basis, and model version server-side; callers cannot author receipt provenance.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        campaign_id: z.string().uuid().describe("The AttriKit campaign uuid, as returned by list_campaigns or get_campaign_decision. Not the ad network's own campaign id."),
        call: z.enum(["scale", "cut", "hold"]).describe("The decision being frozen. Report get_campaign_decision's own call verbatim rather than forming your own."),
        period: periodSchema.describe("The reporting window you reviewed; the receipt freezes that window. Pass the same period you read. Omitted, this tool and get_campaign_decision use all, while list_campaigns defaults to 30d."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({
      app_id,
      campaign_id,
      call: decisionCall,
      period,
      idempotency_key,
    }) => toToolResult(await call("/api/v1/decisions", {
      method: "POST",
      idempotencyKey: idempotency_key,
      body: {
        appId: app_id,
        campaignId: campaign_id,
        call: decisionCall,
        period,
      },
    })),
  );

  server.registerTool(
    "get_attribution_rollup",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Get attribution rollup",
      description:
        "Return the account-level attribution overview: installs accounted-for by evidence class (verified / matched / modeled / organic), MER, revenue and data freshness.",
      inputSchema: { app_id: appIdSchema, period: periodSchema, from: rangeFromSchema, to: rangeToSchema },
    },
    async ({ app_id, period, from, to }) =>
      toToolResult(await call("/api/v1/reports/overview", { query: { appId: app_id, period, from, to } })),
  );

  server.registerTool(
    "create_campaign_link",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Create a campaign tracking link",
      description:
        "Create a web-to-app tracking link for an ad campaign. Requires a write-scoped API key. Returns the link: tracking_url is the campaign link to use in the ad (for meta the ad's Website URL, for tiktok the ad's destination, for google the tracking template with the App Store URL kept as the final URL); url is only the App Store destination you passed, never the link to put in an ad. tracking_url is null when the server has no link origin configured or the network is unrecognized; then create the link in AttriKit, Links.",
      inputSchema: {
        app_id: requiredAppIdSchema.describe("The app id the link belongs to."),
        network: z.enum(["meta", "google", "tiktok"]).describe("The ad network delivering the campaign."),
        destination_url: z.string().url().describe("The App Store URL to send users to."),
        campaign_name: z.string().max(120).optional().describe("Optional human-readable campaign name."),
        network_campaign_id: z.string().optional().describe("The AD NETWORK's own campaign id (for Meta, the campaign ID in Ads Manager, which exists as soon as the campaign is saved, even as a draft). pull_network_spend matches report rows on it, so set it on every link whose spend you will pull: a link created without it can never match. Create the network campaign first, then the link, then paste the link into the ad."),
        campaign_id: z.string().optional().describe("Optional EXISTING AttriKit campaign uuid (from list_campaigns) to attach this link to. Not the ad network's id: use network_campaign_id for that. Pass one or the other, not both."),
        serve_landing: z.boolean().optional().describe("Serve the landing bridge on this link. Defaults to true at the API."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ app_id, network, destination_url, campaign_name, campaign_id, network_campaign_id, serve_landing, idempotency_key }) => {
      const body: JsonRequestBody = { appId: app_id, network, destinationUrl: destination_url };
      if (campaign_name) body.campaignName = campaign_name;
      if (campaign_id) body.campaignId = campaign_id;
      if (network_campaign_id) body.networkCampaignId = network_campaign_id;
      // Sent through rather than dropped. The API accepts serve_landing (links/route.ts
      // aliases it to serveLanding, default true), the OpenAPI publishes it, and zod strips
      // unknown keys — so an agent passing serve_landing:false got a link WITH the landing
      // bridge, no error and no warning. That is the general hazard with a stripping schema:
      // every argument the schema does not name disappears silently.
      if (serve_landing !== undefined) body.serveLanding = serve_landing;
      return toToolResult(
        await call("/api/v1/links", {
          method: "POST",
          idempotencyKey: idempotency_key,
          body,
        }),
      );
    },
  );

  server.registerTool(
    "update_link_status",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Enable or disable a campaign link, or attach its network campaign id",
      description: "Change a tracking link between active and disabled, and/or attach the ad network's own campaign id to a link created without one (then pull_network_spend can match its spend). Send status, network_campaign_id, or both. A campaign that already has a different network id is refused with 409 network_campaign_conflict.",
      inputSchema: {
        link_id: z.string().uuid().describe("The link's id (UUID), as returned by list_links or create_campaign_link."),
        status: z.enum(["active", "disabled"]).optional()
          .describe("active: the link sends people to your store page. disabled: it stops. Omit to leave the status as it is."),
        network_campaign_id: z.string().optional().describe("The ad network's own campaign id (for Meta, the campaign ID in Ads Manager)."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ link_id, status, network_campaign_id, idempotency_key }) => {
      const body: JsonRequestBody = {};
      if (status !== undefined) body.status = status;
      if (network_campaign_id !== undefined) body.network_campaign_id = network_campaign_id;
      return toToolResult(await call(
        `/api/v1/links/${encodeURIComponent(link_id)}`,
        { method: "PATCH", idempotencyKey: idempotency_key, body },
      ));
    },
  );

  server.registerTool(
    "get_spend",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Get spend and cost models",
      description: "Return imported ad spend, cost models, completeness and spend freshness. Without from, to or cursor every row comes back at once; with any of them the rows are paged, ordered by network, campaign, ad set, ad and day, and next_cursor is null on the last page.",
      inputSchema: {
        app_id: appIdSchema,
        from: calendarDaySchema.optional().describe("First metric day to include (UTC, YYYY-MM-DD). May be sent without to."),
        to: calendarDaySchema.optional().describe("Last metric day to include (UTC, YYYY-MM-DD). May be sent without from."),
        cursor: cursorSchema,
        limit: z.number().int().min(1).max(5000).optional()
          .describe("Rows per page, 1-5000 (1000 when omitted). Read only in paged mode; alone it changes nothing."),
      },
    },
    async ({ app_id, from, to, cursor, limit }) => toToolResult(await call("/api/v1/spend", {
      query: { appId: app_id, from, to, cursor, limit: limit === undefined ? undefined : String(limit) },
    })),
  );

  server.registerTool(
    "import_spend",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Import ad spend",
      description: "Import campaign or creative-level spend rows.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        network: z.enum(["meta", "google", "tiktok", "apple_ads"]).describe("The ad network the spend was paid to."),
        source: z.enum(["network_api", "csv", "manual"]).optional()
          .describe("Where the rows came from: network_api, csv or manual. The API uses manual when omitted."),
        account_ref: z.string().optional().describe("Optional reference of the ad account the spend belongs to."),
        currency: z.string().length(3).describe("Three-letter ISO 4217 code of every amount in rows, for example USD."),
        report_timezone: z.string().optional()
          .describe("Timezone of the network report the rows come from. The API uses UTC when omitted."),
        covers_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("First day the batch covers, YYYY-MM-DD, inclusive. Every row's metric_date must fall between covers_from and covers_to."),
        covers_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Last day the batch covers, YYYY-MM-DD, inclusive, on or after covers_from."),
        completeness: z.enum(["partial", "final"]).optional()
          .describe("final when the network has settled these days; partial when it is still updating them. Either way, a newer import of a row with the same campaign, ad set, ad and day replaces the earlier one in reports; a campaign-level row and an ad-level row for one campaign and day are both kept and reported as spend_grain_conflict. The API uses partial when omitted."),
        notes: z.string().optional().describe("Optional free-text note stored with the batch."),
        rows: z.array(spendRowSchema).min(1).max(5000)
          .describe("The spend rows, 1 to 5,000: one per campaign and day, or per campaign, ad set, ad and day."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({
      app_id,
      network,
      source,
      account_ref,
      currency,
      report_timezone,
      covers_from,
      covers_to,
      completeness,
      notes,
      rows,
      idempotency_key,
    }) => {
      const body: JsonRequestBody = {
        kind: "spend", appId: app_id, network, currency, coversFrom: covers_from, coversTo: covers_to,
        rows: rows.map(normalizeSpendRow),
      };
      if (source) body.source = source;
      if (account_ref) body.accountRef = account_ref;
      if (report_timezone) body.reportTimezone = report_timezone;
      if (completeness) body.completeness = completeness;
      if (notes) body.notes = notes;
      return toToolResult(await call("/api/v1/spend", {
      method: "POST",
      idempotencyKey: idempotency_key,
      body,
      }));
    },
  );

  server.registerTool(
    "set_cost_model",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Set an app cost model",
      description: "Version commission, payment fees and variable COGS used in profit decisions.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        effective_at: z.string()
          .describe("When this cost version takes effect: a date (YYYY-MM-DD) or an ISO 8601 date-time."),
        store_commission_bps: z.number().int().min(0).max(10_000)
          .describe("Store commission in basis points, 0-10,000: 1,500 is 15% (Apple's Small Business Program), 3,000 is 30%."),
        payment_fee_bps: z.number().int().min(0).max(10_000)
          .describe("Payment fees outside the store commission, in basis points, 0-10,000. Usually 0 for App Store revenue."),
        variable_cogs_kind: z.enum(["bps", "per_unit_minor"])
          .describe("How variable_cogs_value is read: bps is a percent of revenue in basis points; per_unit_minor is a fixed amount per install in the currency's minor units."),
        variable_cogs_value: z.number().nonnegative()
          .describe("The other variable cost, a whole number: basis points of revenue, at most 10,000, for bps; minor units per install for per_unit_minor."),
        // Flat on purpose: z.json() is recursive, so it advertised a $ref/definitions tool schema that some
        // clients' function-calling formats refuse. 0.4.6 sent this shape; the API validates each value with z.json().
        assumptions: z.record(z.string(), z.unknown()).optional()
          .describe("Optional JSON object stored with this cost version. Its profit_threshold, a number, is the break-even bar: AttriKit suggests scale only when the low return per 1 unit of spend exceeds it (1.00 is true break-even). The API stores {} when omitted."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({
      app_id,
      effective_at,
      store_commission_bps,
      payment_fee_bps,
      variable_cogs_kind,
      variable_cogs_value,
      assumptions,
      idempotency_key,
    }) => {
      const body: JsonRequestBody = {
        kind: "cost_model",
        appId: app_id,
        effectiveAt: effective_at,
        storeCommissionBps: store_commission_bps,
        paymentFeeBps: payment_fee_bps,
        variableCogs: { kind: variable_cogs_kind, value: variable_cogs_value },
      };
      if (assumptions) {
        // SAFETY: tool arguments arrive as parsed JSON-RPC, so every value in `assumptions` is already a JSON value.
        body.assumptions = assumptions as JsonRequestObject;
      }
      return toToolResult(await call("/api/v1/spend", {
      method: "POST",
      idempotencyKey: idempotency_key,
      body,
      }));
    },
  );

  server.registerTool(
    "pull_network_spend",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Pull spend from an ad network",
      description: "Fetch and import creative-level spend from a configured Meta, Google or TikTok connection. AttriKit already pulls every enabled connection every 6 hours, covering today and the 3 days before; call this for an immediate pull or a longer window. Report rows are kept only for campaigns whose network id AttriKit knows (create_campaign_link.network_campaign_id); if none match, the call fails and imports nothing. A network reports rows only for ads that have delivered, so the first useful pull is after the ads start spending.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        network: z.enum(["meta", "google", "tiktok"]).describe("The network to pull from: meta, google or tiktok. It needs an active integration."),
        connection_id: z.string().optional()
          .describe("The integration id, as returned by list_integrations. Needed only when several integrations of this network are active (otherwise 409 ambiguous_connection); omitted, the one active integration is used."),
        covers_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("First day of the report window to pull, YYYY-MM-DD, inclusive."),
        covers_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Last day of the report window to pull, YYYY-MM-DD, inclusive, on or after covers_from."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ app_id, network, connection_id, covers_from, covers_to, idempotency_key }) => {
      const body: JsonRequestBody = {
        kind: "network_pull", appId: app_id, network, coversFrom: covers_from, coversTo: covers_to,
      };
      if (connection_id) body.connectionId = connection_id;
      return toToolResult(await call("/api/v1/spend", {
        method: "POST",
        idempotencyKey: idempotency_key,
        body,
      }));
    },
  );

  server.registerTool(
    "list_integrations",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List ad-network integrations",
      description: "List redacted ad-network connections and their readiness.",
      inputSchema: {},
    },
    async () => toToolResult(await call("/api/v1/integrations")),
  );

  server.registerTool(
    "create_integration",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Create an ad-network integration",
      description: "Store encrypted network credentials and choose, for each of the eight event families (install, session, trial, subscription, purchase, refund, paywall, business), which source's copy AttriKit forwards to the network. AttriKit always does the sending; the owner only picks the copy. attrkit = the events your app reports through the AttriKit SDK (the RevenueCat copy of that family is dropped). revenuecat = the events AttriKit received from your RevenueCat webhook (the SDK copy is dropped); RevenueCat itself sends nothing to the network. customer = events your own servers post to AttriKit. If your app reports subscriptions only through RevenueCat, set trial, subscription, purchase and refund to revenuecat, or none of them reach the network. For Meta and TikTok, delivery_scope and renewal_event are optional; left out, the integration sends every install's events and renewals as Purchase.",
      inputSchema: {
        network: z.enum(["meta", "google", "tiktok"]).describe("The ad network: meta, google or tiktok."),
        account_ref: z.string().min(1)
          .describe("The ad account: for Meta the ad account ID starting with act_, for Google the Ads customer ID (123-456-7890), for TikTok the advertiser ID."),
        credential: z.string().min(1)
          .describe("The network credential, a JSON object written as a string. Meta: pixelId and accessToken. Google: linkId (conversions), accessToken and developerToken (spend). TikTok: eventSourceId (your Pixel code) and accessToken. Stored encrypted and never returned."),
        owners: ownersSchema.describe("For each event family, whose copy is forwarded: attrkit, revenuecat or customer (see the tool description). Enabling a destination requires ALL eight families to be present, or the API rejects the call."),
        enable: z.boolean().optional()
          .describe("true starts delivery at once, which needs all eight families in owners. false (the default) saves a draft that sends nothing."),
        delivery_scope: deliveryScopeSchema,
        renewal_event: renewalEventSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ network, account_ref, credential, owners, enable, delivery_scope, renewal_event, idempotency_key }) => {
      const body: JsonRequestBody = { network, account_ref, credential, owners, enable: enable ?? false };
      // Sent only when supplied, so a create without them is byte for byte what 1.3.0 sent and keeps
      // the API's idempotency fingerprint for the same body.
      if (delivery_scope !== undefined) body.delivery_scope = delivery_scope;
      if (renewal_event !== undefined) body.renewal_event = renewal_event;
      return toToolResult(await call("/api/v1/integrations", {
        method: "POST",
        idempotencyKey: idempotency_key,
        body,
      }));
    },
  );

  server.registerTool(
    "update_integration",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Update an ad-network integration",
      description: "Rotate credentials or enable/disable an integration. set_delivery_options changes delivery_scope, renewal_event or both on a Meta or TikTok integration, in any status, without touching its credential or status; give at least one of the two.",
      inputSchema: {
        connection_id: z.string().describe("The integration id, as returned by list_integrations."),
        action: z.enum(["rotate", "disable", "enable", "set_delivery_options"])
          .describe("rotate replaces the credential (send credential). disable stops delivery. enable starts it, once every one of the eight event families has a sender. set_delivery_options changes delivery_scope, renewal_event or both."),
        credential: z.string().optional()
          .describe("The new credential for rotate, in create_integration's format: a JSON object written as a string. Stored encrypted and never returned."),
        owners: ownersSchema.optional()
          .describe("Read by enable: the sender (attrkit, revenuecat or customer) of some or all event families, merged over the saved ones. Every family must end up with a sender, or the API rejects the call."),
        delivery_scope: deliveryScopeSchema,
        renewal_event: renewalEventSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ connection_id, action, credential, owners, delivery_scope, renewal_event, idempotency_key }) => {
      const body: JsonRequestBody = { action };
      if (delivery_scope !== undefined) body.delivery_scope = delivery_scope;
      if (renewal_event !== undefined) body.renewal_event = renewal_event;
      // Presence, not truthiness: `credential` is `z.string().optional()`, so an empty string is a
      // value the caller supplied and the schema accepted. Dropping it turned an attributable
      // "credential is invalid" answer into a silent "no credential was sent".
      if (credential !== undefined) body.credential = credential;
      if (owners) body.owners = owners;
      return toToolResult(await call(
        `/api/v1/integrations/${encodeOpaquePathSegment(connection_id)}`,
        {
        method: "PATCH",
        idempotencyKey: idempotency_key,
        body,
        },
      ));
    },
  );

  server.registerTool(
    "delete_integration",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Delete an ad-network integration",
      description: "Delete a disabled integration. Enabled integrations must be disabled first.",
      inputSchema: { connection_id: z.string().describe("The integration id, as returned by list_integrations.") },
    },
    async ({ connection_id }) => toToolResult(await call(
      `/api/v1/integrations/${encodeOpaquePathSegment(connection_id)}`,
      { method: "DELETE" },
    )),
  );

  server.registerTool(
    "get_revenuecat",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Get RevenueCat configuration",
      description: "Return redacted RevenueCat status and the AttriKit webhook URL.",
      inputSchema: { app_id: requiredAppIdSchema },
    },
    async ({ app_id }) => toToolResult(await call(
      `/api/v1/apps/${encodeOpaquePathSegment(app_id)}/revenuecat`,
    )),
  );

  server.registerTool(
    "configure_revenuecat",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Configure RevenueCat",
      description: "Store the RevenueCat provider app id and encrypted authorization secret for an app, and optionally the webhook signing secret (omitted, the stored one is kept).",
      inputSchema: {
        app_id: requiredAppIdSchema,
        // The schema exists to reject the SDK key people paste instead; it never said what the
        // right value is, so the rejection was correct and unactionable.
        provider_app_id: revenueCatProviderAppIdSchema.describe("RevenueCat's PROJECT app id from their dashboard app settings, not the SDK key."),
        authorization_secret: z.string().min(16).max(1024)
          .describe("The Authorization header value set on the AttriKit webhook in RevenueCat's dashboard, 16 to 1,024 characters. Stored encrypted."),
        signing_secret: z.string().trim().min(16).max(1024).optional()
          .describe("RevenueCat's HMAC signing secret, for the X-RevenueCat-Webhook-Signature header. Optional: omitted, the stored one is kept."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ app_id, provider_app_id, authorization_secret, signing_secret, idempotency_key }) => {
      const body: JsonRequestBody = { provider_app_id, authorization_secret };
      if (signing_secret !== undefined) body.signing_secret = signing_secret;
      return toToolResult(await call(`/api/v1/apps/${encodeOpaquePathSegment(app_id)}/revenuecat`, {
        method: "PUT",
        idempotencyKey: idempotency_key,
        body,
      }));
    },
  );

  server.registerTool(
    "list_webhooks",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "List outbound webhooks",
      description: "List redacted outbound webhook subscriptions.",
      inputSchema: {},
    },
    async () => toToolResult(await call("/api/v1/webhooks")),
  );

  server.registerTool(
    "create_webhook",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      title: "Create an outbound webhook",
      description: "Create an SSRF-checked webhook subscription. Returns the signing secret once.",
      inputSchema: {
        url: z.string().url()
          .describe("Your public HTTPS endpoint, on the default port 443. HTTP, other ports, credentials in the URL, and local, private or other non-public targets (checked after DNS resolution) are rejected."),
        event_types: z.array(z.enum(["install", "event", "decision", "fraud"])).min(1).max(4)
          .describe("The notifications to receive, 1 to 4 of install, event, decision and fraud."),
        description: z.string().max(500).optional().describe("Optional label for the subscription, at most 500 characters."),
        app_id: z.string().uuid().optional()
          .describe("Optional app UUID to receive one app's notifications only. Omitted, a workspace key subscribes to all apps; an app-scoped key always subscribes to its own app."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ url, event_types, description, app_id, idempotency_key }) => {
      const body: JsonRequestBody = { url, event_types };
      if (description) body.description = description;
      if (app_id) body.app_id = app_id;
      return toToolResult(await call("/api/v1/webhooks", {
        method: "POST",
        idempotencyKey: idempotency_key,
        body,
      }));
    },
  );

  server.registerTool(
    "delete_webhook",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      title: "Delete an outbound webhook",
      description: "Delete a webhook subscription.",
      inputSchema: { subscription_id: z.string().uuid().describe("The subscription id (UUID), as returned by list_webhooks or create_webhook.") },
    },
    async ({ subscription_id }) => toToolResult(await call(
      `/api/v1/webhooks/${encodeURIComponent(subscription_id)}`,
      { method: "DELETE" },
    )),
  );

  server.registerTool(
    "export_events",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Export events and installs",
      description: "Export one app's events and installs for an inclusive date range. By default (version 1) the answer is the seven-column CSV, event rows capped at the 100,000 most recent INSIDE the range; narrow the range until it is safely below that cap when a complete snapshot is required. Pass version 2 for the wide record export (campaign, ad, evidence and revenue columns), oldest first, as csv or ndjson and paged: each page holds up to `limit` records (10,000 by default), and when another page follows the result carries next_cursor, which you send back as `cursor` with the same app_id, from and to. No next_cursor means the last page.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        from: z.string().describe("ISO date or timestamp"),
        to: z.string().describe("ISO date or timestamp"),
        version: z.number().int().min(1).max(2).optional()
          .describe("Export version, 1 or 2. Omit for version 1, the original CSV, unchanged. format, limit and cursor need version 2."),
        format: z.enum(["csv", "ndjson"]).optional()
          .describe("Version 2 only: csv (the default) or ndjson, one JSON record per line."),
        limit: z.number().int().min(1).max(10_000).optional()
          .describe("Version 2 only: records per page, 1-10,000 (10,000 when omitted)."),
        cursor: z.string().optional()
          .describe("Version 2 only: the next_cursor of the previous page. Omit for the first page."),
      },
    },
    async ({ app_id, from, to, version, format, limit, cursor }) => {
      if (version !== 2 && (format !== undefined || limit !== undefined || cursor !== undefined)) {
        // Refused here rather than forwarded: the API ignores them on version 1, so a paging agent
        // that forgot `version: 2` would be handed the whole capped file again and loop on it.
        return toToolResult(invalidResult("invalid_request", "format, limit and cursor apply to version 2 only; pass version: 2."));
      }
      return toToolResult(await call("/api/v1/export", {
        query: {
          appId: app_id,
          from,
          to,
          version: version === undefined ? undefined : String(version),
          format,
          limit: limit === undefined ? undefined : String(limit),
          cursor,
        },
        expectedResponse: format === "ndjson" ? "ndjson" : "text",
      }));
    },
  );

  server.registerTool(
    "send_server_event",
    {
      // Not read-only: it stores an event and queues its network postbacks. Not destructive: nothing
      // is overwritten or removed. Replaying an event_id is safe (the API answers status duplicate).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Report an event from your backend",
      description: "Report an event for one of your users from your own backend, by the customer_user_id your app passed to AttriKit.setUserID; no device installation id is needed. The event is attached to the install that id resolves to and reaches the destinations whose sender for its family is Your servers. Requires a write-scoped API key. Answers status accepted, duplicate (this event_id was already stored) or suppressed (consent.measurement is not granted, so nothing was collected), with the install_epoch_id it resolved to. 404 customer_user_not_found means no install identified with this id.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        customer_user_id: z.string().min(1).max(256).describe("The opaque id your app passed to AttriKit.setUserID. Refused when it looks like an email address or phone number. Hashed on arrival, never stored."),
        event_id: z.string().uuid().describe("Your id for this event. A second event with the same id is a duplicate and is not written again."),
        event_name: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_.-]*$/).describe("Canonical event name, for example purchase or subscription_started."),
        event_version: z.number().int().positive()
          .describe("The version of this event's definition, a positive integer. The SDKs send 1 by default."),
        occurred_at: z.string().datetime({ offset: true }).describe("When the event happened, ISO 8601 with a UTC offset."),
        consent: z.object({
          measurement: z.enum(["granted", "denied", "unknown"])
            .describe("The user's measurement consent: granted, denied or unknown. Only a granted event is collected."),
          tracking: z.enum(["granted", "denied", "unknown"])
            .describe("The user's tracking consent: granted, denied or unknown."),
          policy_version: z.number().int().positive()
            .describe("The version of the consent policy the user answered, a positive integer."),
          dma: z.object({
            eea: z.boolean().describe("Whether EEA, UK or Swiss rules apply to this user."),
            ad_user_data: z.boolean().optional().describe("The user's ad_user_data consent."),
            ad_personalization: z.boolean().optional().describe("The user's ad_personalization consent."),
          }).strict().optional().describe("Optional. The user's answers to Google's EU consent questions, sent to Google with this event. A value left out is derived from tracking; an unknown key is refused, as the API refuses it."),
        }).describe("The per-event consent SDK events carry. An event whose measurement is not granted is not collected."),
        properties: z.record(z.string(), z.union([z.string().max(1_024), z.number(), z.boolean(), z.null()])).optional()
          .describe("Scalar values only, at most 64 keys. Revenue is value (major units) or price_minor_units with currency, an ISO 4217 code."),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async ({ app_id, customer_user_id, event_id, event_name, event_version, occurred_at, consent, properties, idempotency_key }) => {
      const forwardedConsent: JsonRequestObject = {
        measurement: consent.measurement,
        tracking: consent.tracking,
        policy_version: consent.policy_version,
      };
      // Forwarded only when the caller gave it. A backend sets these values itself, so they go as
      // source manual, which is also what the API documents for a backend's own answers.
      if (consent.dma !== undefined) {
        const dma: JsonRequestObject = { eea: consent.dma.eea, source: "manual" };
        if (consent.dma.ad_user_data !== undefined) dma.ad_user_data = consent.dma.ad_user_data;
        if (consent.dma.ad_personalization !== undefined) dma.ad_personalization = consent.dma.ad_personalization;
        forwardedConsent.dma = dma;
      }
      const body: JsonRequestBody = { customer_user_id, event_id, event_name, event_version, occurred_at, consent: forwardedConsent };
      if (properties !== undefined) body.properties = properties;
      return toToolResult(await call(`/api/v1/apps/${encodeOpaquePathSegment(app_id)}/events`, {
        method: "POST",
        idempotencyKey: idempotency_key,
        body,
      }));
    },
  );

  server.registerTool(
    "lookup_customer_attribution",
    {
      // POST on the wire so the user id stays out of URLs and access logs, but it only reads.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      title: "Look up a user's attribution",
      description: "Look up the attribution of one of your users by the customer_user_id your app passed to AttriKit.setUserID: the campaign, ad set, ad, network, match confidence and attribution_status (attributed, device_matched, organic, pending or consent_required) of the user's newest install. 404 customer_user_not_found means no install identified with this id. Read scope is enough.",
      inputSchema: {
        app_id: requiredAppIdSchema,
        customer_user_id: z.string().min(1).max(256).describe("The opaque id your app passed to AttriKit.setUserID. Refused when it looks like an email address or phone number."),
      },
    },
    async ({ app_id, customer_user_id }) => toToolResult(await call(
      `/api/v1/apps/${encodeOpaquePathSegment(app_id)}/attribution/lookup`,
      { method: "POST", body: { customer_user_id }, readsOnly: true },
    )),
  );

  return server;
}
