import { createSign } from "node:crypto";

/**
 * The Google Sheets client behind the marketing site's lead register.
 *
 * ## Why a spreadsheet, and why no database driver
 *
 * The owner decided on 23 September 2026 that the marketing site's data —
 * demo leads, funnel events, the demo-call consent record — lives in a Google
 * Sheet in the company's Drive, and nowhere else. That restores the rule in
 * the root CLAUDE.md that `apps/web` has no database client at all, which is
 * the one checkable fact behind "the marketing site cannot reach patient
 * data". A Sheet is also the thing the owner already opens on a phone; the
 * CRM view at /admin/crm is that same Sheet in a frame.
 *
 * Nothing here is patient data. A row is a clinic owner's work email, the
 * specialty they demoed, whether they ticked a box. `schema.ts` carries the
 * column list and `leads.test.ts` checks it against a patient-shaped denylist.
 *
 * ## Why no `googleapis` package
 *
 * The official client is tens of megabytes of generated code for the two
 * endpoints this module uses. A service-account token is one RS256 JWT
 * (`node:crypto`) exchanged at the OAuth endpoint; the Sheets calls are plain
 * JSON over `fetch`. Keeping the surface this small is also what makes the
 * in-memory `FakeSheets` below trustworthy: it implements exactly the five
 * operations the real client does, no more.
 *
 * ## What a Sheet cannot do, and how that is handled
 *
 * There is no atomic increment and no transaction. Every write is a whole
 * row, every read is a whole range, and the API costs 300–800 ms a call with
 * a quota of roughly sixty requests a minute per user. So: the lead store
 * reads a tab and updates one row by its 1-based row number (races are
 * tolerated and deduplicated on read, `leads.ts`), and the rate limiter uses
 * the Sheet only for the two site-wide daily spend caps, on a cached read
 * (`rate-limit.ts`). Everything else stays in process memory.
 *
 * ## Failure
 *
 * A request times out after five seconds and is retried, with jitter, on 429
 * and 5xx only; anything else is thrown to the caller, which decides whether
 * it fails open (the lead store) or falls back to memory (the limiter). Cell
 * contents are never logged: an error carries the HTTP status and Google's
 * status word (`PERMISSION_DENIED`, `NOT_FOUND`) and nothing from the body.
 *
 * ## Configuration
 *
 * Two environment variables, both required for the store to count as
 * configured (`isMarketingStoreConfigured()`):
 *
 *   - `MARKETING_SHEET_ID`: the id from the Sheet's URL. Any blank Sheet
 *     shared as Editor with the service account works; the tabs and header
 *     rows are provisioned on first use (`schema.ts`).
 *   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the service account's key file as one
 *     string. Base64 of the file is accepted too, because a multi-line JSON
 *     value is awkward to paste into some secret stores.
 */

export type Cell = string | number | boolean;

export type BatchUpdateRequest =
  | { addSheet: { properties: { title: string } } }
  | {
      deleteDimension: {
        range: { sheetId: number; dimension: "ROWS" | "COLUMNS"; startIndex: number; endIndex: number };
      };
    };

export type SheetProperties = { title: string; sheetId: number };

/**
 * The five operations the store needs. Both the Google-backed client and the
 * in-memory fake implement this and nothing else, so a test that passes
 * against the fake exercises the same calls production makes.
 */
export interface SheetsClient {
  /** Rows in the range, trailing empty cells and rows trimmed, as the API does. `[]` when empty. */
  getValues(range: string): Promise<Cell[][]>;
  /** Append after the last row with data. `firstRow` is the 1-based number of the first row written, when known. */
  appendRows(tab: string, rows: Cell[][]): Promise<{ firstRow: number | null }>;
  /** Overwrite the cells of a range with the rows given. */
  updateRange(range: string, rows: Cell[][]): Promise<void>;
  /** Structural changes: add a tab, delete rows. Applied in order. */
  batchUpdate(requests: BatchUpdateRequest[]): Promise<void>;
  getSheetTitles(): Promise<string[]>;
  /** The numeric id `deleteDimension` needs, or null if no tab has that title. */
  getSheetId(title: string): Promise<number | null>;
}

export class SheetsError extends Error {
  constructor(
    public readonly status: number,
    /** Google's status word from the error body, e.g. PERMISSION_DENIED. Never the message. */
    public readonly reason: string,
  ) {
    super(`Google Sheets API ${status} ${reason}`);
    this.name = "SheetsError";
  }
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export type ServiceAccount = {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Google spreadsheet ids are URL-safe base64-ish. Anything else is a paste error, not an id. */
const SHEET_ID = /^[A-Za-z0-9_-]{20,}$/;

let parsedAccount: { raw: string; account: ServiceAccount | null } | null = null;

/**
 * Parse the key file out of the environment value: the JSON itself, or base64
 * of it. Null for anything that is not a usable service-account key, so a
 * half-pasted value counts as "not configured" rather than as a runtime crash
 * on the first lead.
 */
export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let text = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      text = Buffer.from(trimmed, "base64").toString("utf8");
    } catch {
      return null;
    }
    if (!text.trimStart().startsWith("{")) return null;
  }
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const email = json.client_email;
    const key = json.private_key;
    if (typeof email !== "string" || !email.includes("@")) return null;
    if (typeof key !== "string" || !key.includes("PRIVATE KEY")) return null;
    const tokenUri =
      typeof json.token_uri === "string" && json.token_uri.startsWith("https://")
        ? json.token_uri
        : DEFAULT_TOKEN_URI;
    return { clientEmail: email, privateKey: key, tokenUri };
  } catch {
    return null;
  }
}

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "";
  if (!parsedAccount || parsedAccount.raw !== raw) {
    parsedAccount = { raw, account: parseServiceAccount(raw) };
  }
  return parsedAccount.account;
}

/** The spreadsheet id, or null when unset or malformed. Read by the CRM page as well as the client. */
export function marketingSheetId(): string | null {
  const id = process.env.MARKETING_SHEET_ID?.trim();
  return id && SHEET_ID.test(id) ? id : null;
}

let testOverride: SheetsClient | null = null;

/**
 * Replaces the old `isMarketingDbConfigured()`. True when both variables are
 * present and the key parses, or when a test has installed a fake.
 */
export function isMarketingStoreConfigured(): boolean {
  if (testOverride) return true;
  return marketingSheetId() !== null && serviceAccount() !== null;
}

let cached: { id: string; email: string; client: SheetsClient } | null = null;

/**
 * The client for the configured Sheet. Throws when unconfigured; callers
 * check `isMarketingStoreConfigured()` first and decide what "unconfigured"
 * means for them. One instance per process, so the access token is minted
 * once an hour rather than once a request.
 */
export function sheetsClient(): SheetsClient {
  if (testOverride) return testOverride;
  const id = marketingSheetId();
  const account = serviceAccount();
  if (!id || !account) {
    throw new Error(
      "The marketing Sheet is not configured: MARKETING_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON are both required. See .env.example.",
    );
  }
  if (!cached || cached.id !== id || cached.email !== account.clientEmail) {
    cached = { id, email: account.clientEmail, client: new GoogleSheetsClient(id, account) };
  }
  return cached.client;
}

/** Tests install a `FakeSheets`; `null` removes it. */
export function __setSheetsClientForTests(client: SheetsClient | null): void {
  testOverride = client;
}

// -----------------------------------------------------------------------------
// A1 notation helpers, shared by the real client, the fake and the schema
// -----------------------------------------------------------------------------

/** 1 → "A", 26 → "Z", 27 → "AA". */
export function columnLetter(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "A" → 1, "AA" → 27. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export type A1Range = {
  tab: string;
  startRow: number;
  /** null: open-ended (to the last row). */
  endRow: number | null;
  startCol: number;
  /** null: open-ended (to the last column). */
  endCol: number | null;
};

/**
 * Parse `tab!A2:D`, `tab!A1`, `tab!1:1`, `tab!A:D` or a bare `tab`. Enough
 * for what this module writes; not a general A1 parser.
 */
export function parseA1(range: string): A1Range {
  const bang = range.lastIndexOf("!");
  const rawTab = bang === -1 ? range : range.slice(0, bang);
  const tab = rawTab.replace(/^'(.*)'$/, "$1");
  const ref = bang === -1 ? "" : range.slice(bang + 1);
  if (!ref) return { tab, startRow: 1, endRow: null, startCol: 1, endCol: null };

  const [a, b] = ref.split(":");
  const parse = (part: string | undefined): { col: number | null; row: number | null } => {
    const m = /^([A-Za-z]*)(\d*)$/.exec(part ?? "");
    if (!m) throw new SheetsError(400, "INVALID_ARGUMENT");
    return { col: m[1] ? columnIndex(m[1]) : null, row: m[2] ? Number(m[2]) : null };
  };
  const start = parse(a);
  if (b === undefined) {
    // A single reference: a cell, or a whole column / whole row.
    return {
      tab,
      startRow: start.row ?? 1,
      endRow: start.row,
      startCol: start.col ?? 1,
      endCol: start.col,
    };
  }
  const end = parse(b);
  return {
    tab,
    startRow: start.row ?? 1,
    endRow: end.row,
    startCol: start.col ?? 1,
    endCol: end.col,
  };
}

/** The 1-based row of the first cell in an `updatedRange` like `leads!A5:AG5`. */
function firstRowOf(updatedRange: unknown): number | null {
  if (typeof updatedRange !== "string") return null;
  try {
    return parseA1(updatedRange).startRow;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// The Google-backed client
// -----------------------------------------------------------------------------

const TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
/** Refresh the access token this long before Google says it expires. */
const TOKEN_SLACK_MS = 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** The signed assertion Google exchanges for an access token. Exported for the test. */
export function mintServiceAccountJwt(account: ServiceAccount, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: account.clientEmail, scope: SCOPE, aud: account.tokenUri, iat, exp: iat + 3600 }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .end()
    .sign(account.privateKey, "base64url");
  return `${header}.${claims}.${signature}`;
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function reasonOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { status?: unknown } };
    const status = body?.error?.status;
    return typeof status === "string" ? status : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GoogleSheetsClient implements SheetsClient {
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;
  private sheets: SheetProperties[] | null = null;

  constructor(
    private readonly spreadsheetId: string,
    private readonly account: ServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt - TOKEN_SLACK_MS) return this.token.value;
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.exchange().finally(() => {
        this.tokenInFlight = null;
      });
    }
    return this.tokenInFlight;
  }

  private async exchange(): Promise<string> {
    const assertion = mintServiceAccountJwt(this.account);
    const response = await this.fetchImpl(this.account.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new SheetsError(response.status, "TOKEN_EXCHANGE_FAILED");
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") throw new SheetsError(502, "TOKEN_MALFORMED");
    const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.token = { value: body.access_token, expiresAt: Date.now() + ttl * 1000 };
    return this.token.value;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`${API}/${encodeURIComponent(this.spreadsheetId)}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1) + Math.random() * 250);
      try {
        const token = await this.accessToken(attempt > 0 && lastError instanceof SheetsError && lastError.status === 401);
        const response = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.ok) return (await response.json()) as T;
        const error = new SheetsError(response.status, await reasonOf(response));
        // 401 once: the token may have been revoked under us. Otherwise only quota and server trouble are worth a retry.
        if (!retryable(response.status) && !(response.status === 401 && attempt === 0)) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof SheetsError && !retryable(error.status) && error.status !== 401) throw error;
        // Network failure or timeout: retry.
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new SheetsError(0, "UNREACHABLE");
  }

  async getValues(range: string): Promise<Cell[][]> {
    const body = await this.request<{ values?: Cell[][] }>(
      "GET",
      `/values/${encodeURIComponent(range)}`,
      // Typed cells back (numbers and booleans as such), and a date someone
      // typed by hand in the UI as its serial number, which schema.ts converts.
      { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" },
    );
    return body.values ?? [];
  }

  async appendRows(tab: string, rows: Cell[][]): Promise<{ firstRow: number | null }> {
    const body = await this.request<{ updates?: { updatedRange?: unknown } }>(
      "POST",
      `/values/${encodeURIComponent(tab)}:append`,
      // RAW: an ISO timestamp is stored as the string it is, never parsed into a date cell.
      { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", includeValuesInResponse: "false" },
      { majorDimension: "ROWS", values: rows },
    );
    return { firstRow: firstRowOf(body.updates?.updatedRange) };
  }

  async updateRange(range: string, rows: Cell[][]): Promise<void> {
    await this.request(
      "PUT",
      `/values/${encodeURIComponent(range)}`,
      { valueInputOption: "RAW" },
      { range, majorDimension: "ROWS", values: rows },
    );
  }

  async batchUpdate(requests: BatchUpdateRequest[]): Promise<void> {
    if (requests.length === 0) return;
    await this.request("POST", ":batchUpdate", {}, { requests });
    if (requests.some((r) => "addSheet" in r)) this.sheets = null;
  }

  private async properties(): Promise<SheetProperties[]> {
    if (this.sheets) return this.sheets;
    const body = await this.request<{ sheets?: { properties?: { sheetId?: number; title?: string } }[] }>(
      "GET",
      "",
      { fields: "sheets.properties(sheetId,title)" },
    );
    this.sheets = (body.sheets ?? [])
      .map((s) => s.properties)
      .filter((p): p is { sheetId: number; title: string } => typeof p?.sheetId === "number" && typeof p?.title === "string")
      .map((p) => ({ sheetId: p.sheetId, title: p.title }));
    return this.sheets;
  }

  async getSheetTitles(): Promise<string[]> {
    return (await this.properties()).map((p) => p.title);
  }

  async getSheetId(title: string): Promise<number | null> {
    return (await this.properties()).find((p) => p.title === title)?.sheetId ?? null;
  }
}

// -----------------------------------------------------------------------------
// The in-memory fake, for tests
// -----------------------------------------------------------------------------

function isEmpty(cell: Cell | undefined): boolean {
  return cell === undefined || cell === "";
}

/**
 * A spreadsheet in memory with the same five operations and the same edges
 * the real API has: a range on a missing tab is an error, appends go after
 * the last row with data, reads trim trailing empties, `deleteDimension`
 * needs a numeric sheet id. `calls` records every operation so a test can
 * assert that something did NOT touch the Sheet.
 */
export class FakeSheets implements SheetsClient {
  readonly tabs = new Map<string, Cell[][]>();
  readonly calls: string[] = [];
  private readonly ids = new Map<string, number>();
  private nextId = 0;

  constructor(initialTabs: readonly string[] = ["Sheet1"]) {
    for (const title of initialTabs) this.create(title);
  }

  private create(title: string): void {
    this.tabs.set(title, []);
    this.ids.set(title, this.nextId);
    this.nextId += 1;
  }

  private grid(tab: string): Cell[][] {
    const rows = this.tabs.get(tab);
    if (!rows) throw new SheetsError(400, "INVALID_ARGUMENT");
    return rows;
  }

  async getValues(range: string): Promise<Cell[][]> {
    this.calls.push(`getValues ${range}`);
    const a1 = parseA1(range);
    const grid = this.grid(a1.tab);
    const lastRow = Math.min(a1.endRow ?? grid.length, grid.length);
    const out: Cell[][] = [];
    for (let r = a1.startRow; r <= lastRow; r += 1) {
      const row = grid[r - 1] ?? [];
      const lastCol = a1.endCol ?? row.length;
      const cells: Cell[] = [];
      for (let c = a1.startCol; c <= lastCol; c += 1) cells.push(row[c - 1] ?? "");
      while (cells.length && isEmpty(cells[cells.length - 1])) cells.pop();
      out.push(cells);
    }
    while (out.length && out[out.length - 1]!.length === 0) out.pop();
    return out;
  }

  async appendRows(tab: string, rows: Cell[][]): Promise<{ firstRow: number | null }> {
    this.calls.push(`appendRows ${tab}`);
    const grid = this.grid(tab);
    let last = grid.length;
    while (last > 0 && (grid[last - 1] ?? []).every(isEmpty)) last -= 1;
    grid.length = last;
    for (const row of rows) grid.push([...row]);
    return { firstRow: last + 1 };
  }

  async updateRange(range: string, rows: Cell[][]): Promise<void> {
    this.calls.push(`updateRange ${range}`);
    const a1 = parseA1(range);
    const grid = this.grid(a1.tab);
    rows.forEach((cells, i) => {
      const r = a1.startRow - 1 + i;
      while (grid.length <= r) grid.push([]);
      const row = grid[r]!;
      cells.forEach((cell, j) => {
        const c = a1.startCol - 1 + j;
        while (row.length < c) row.push("");
        row[c] = cell;
      });
    });
  }

  async batchUpdate(requests: BatchUpdateRequest[]): Promise<void> {
    this.calls.push(`batchUpdate ${requests.length}`);
    for (const request of requests) {
      if ("addSheet" in request) {
        const { title } = request.addSheet.properties;
        if (this.tabs.has(title)) throw new SheetsError(400, "INVALID_ARGUMENT");
        this.create(title);
      } else {
        const { sheetId, dimension, startIndex, endIndex } = request.deleteDimension.range;
        const title = [...this.ids.entries()].find(([, id]) => id === sheetId)?.[0];
        if (title === undefined || dimension !== "ROWS") throw new SheetsError(400, "INVALID_ARGUMENT");
        this.grid(title).splice(startIndex, endIndex - startIndex);
      }
    }
  }

  async getSheetTitles(): Promise<string[]> {
    this.calls.push("getSheetTitles");
    return [...this.tabs.keys()];
  }

  async getSheetId(title: string): Promise<number | null> {
    this.calls.push(`getSheetId ${title}`);
    return this.ids.get(title) ?? null;
  }

  // --- Test conveniences; not part of the interface. ---

  /** Data rows of a tab as header → cell maps, in sheet order. */
  records(tab: string): Record<string, Cell>[] {
    const [header = [], ...rows] = this.grid(tab);
    return rows
      .filter((row) => row.some((cell) => !isEmpty(cell)))
      .map((row) => Object.fromEntries(header.map((h, i) => [String(h), row[i] ?? ""])));
  }

  /** Overwrite one cell by its header name; `row` is the 1-based sheet row. */
  setCell(tab: string, row: number, header: string, value: Cell): void {
    const grid = this.grid(tab);
    const col = (grid[0] ?? []).indexOf(header);
    if (col === -1) throw new Error(`no column ${header} on ${tab}`);
    const cells = grid[row - 1];
    if (!cells) throw new Error(`no row ${row} on ${tab}`);
    while (cells.length <= col) cells.push("");
    cells[col] = value;
  }
}
