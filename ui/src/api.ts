// Thin client for the Papyrus backend.
//
// The routes are served by the gateway's route registry under /api/apps/papyrus
// (backend/routes.py), the prefix `permissions.api` grants. Every request goes
// through the host's permission-scoped client (`useAppApi()`), which the page's
// root hands to `setTransport`: it is a same-origin fetch carrying the
// dashboard's session cookie, refused client-side for any path outside the
// manifest's grant. A non-2xx surfaces from that client as an error carrying
// the status and the raw body, which is read back here into `PapyrusApiError`
// so the page sees the backend's own `{error, code, char}` exactly as before.

/** The part of the scoped client this module uses. */
export interface Transport {
  raw(path: string, init?: RequestInit): Promise<Response>
}

/** Before the root mounts (tests, or a module evaluated early): a plain fetch. */
const sameOriginFetch: Transport = {
  async raw(path, init) {
    const r = await fetch(path, { credentials: 'same-origin', ...init })
    if (!r.ok) {
      const text = await r.text().catch(() => r.statusText)
      throw Object.assign(new Error(`API ${r.status}: ${text}`), { status: r.status, body: text })
    }
    return r
  },
}

let transport: Transport = sameOriginFetch

/** Route every call through *next* (the page root passes `useAppApi()`). */
export function setTransport(next: Transport | null): void {
  transport = next ?? sameOriginFetch
}

interface ScopedFailure {
  status: number
  body: string
}

function scopedFailure(err: unknown): ScopedFailure | null {
  if (err && typeof err === 'object' && 'status' in err && typeof (err as ScopedFailure).status === 'number') {
    const body = (err as { body?: unknown }).body
    return { status: (err as ScopedFailure).status, body: typeof body === 'string' ? body : '' }
  }
  return null
}

const API = '/api/apps/papyrus'

/** Endpoint path for the compiled PDF. */
const PDF_PATH = '/pdf'

/** One row of the project list. */
export interface Project {
  name: string
  /** Main-document mtime, in epoch SECONDS (Python's st_mtime). */
  modified: number
  has_pdf: boolean
  /**
   * What to DISPLAY for this paper: the name the user set, else `name`. Never an
   * identifier — `name` stays the key for
   * every call below, for the PDF URL and for the paper's chat slot, so a
   * rename cannot break a link.
   *
   * The server always sends something displayable (it falls back to `name`), but
   * an older backend does not send the field at all — hence the `??` at the one
   * render site rather than trust here.
   */
  title: string
  /**
   * Which paper this row is: changes when a paper is deleted and created again
   * under the same name. {@link papyrusApi.setTitle} sends it back so a row
   * loaded before that replacement cannot rename the new paper.
   */
  generation: string
}

export interface ProjectDetail {
  name: string
  /**
   * What to DISPLAY for this paper, resolved exactly as {@link Project.title}
   * is — so the workspace header and the list row that opened it agree.
   *
   * Resolved server-side rather than carried over from the list: a paper opened
   * straight from a URL never went through the list, and the client holds only
   * `name`. An older backend omits the field, hence the fallback at the render
   * site.
   */
  title: string
  main_file: string
  files: string[]
  has_pdf: boolean
}

/** One parsed compiler message. `line` is null when the log gave no line. */
export interface Diagnostic {
  level: 'error' | 'warning' | 'typesetting'
  message: string
  line: number | null
  file: string | null
}

export interface CompileResult {
  ok: boolean
  log: string
  errors: Diagnostic[]
  duration_ms: number
}

export interface GitStatus {
  is_git: boolean
  branch?: string
  dirty?: boolean
  has_remote?: boolean
  ahead?: number
  behind?: number
  changes?: string[]
  recent_commits?: string[]
  /** Set when the status probe itself failed, so the toolbar can stay quiet. */
  error?: string
}

/** Live state of the managed-compiler provisioning job. */
export interface ManagedCompilerJob {
  state: 'idle' | 'downloading' | 'verifying' | 'installing' | 'done' | 'error'
  error: string
  attempt: number
  bytes_downloaded: number
  bytes_total: number
  elapsed: number
}

/**
 * The app's own digest-pinned Tectonic install — the reason a stock machine can
 * compile at all. `supported` is false where no pinned build exists (32-bit
 * Linux, BSD, Windows-on-ARM); there the UI keeps the manual-install advice.
 */
export interface ManagedCompiler {
  supported: boolean
  installed: boolean
  /** Upstream release tag the pinned digests were computed from. */
  release: string
  version: string
  job: ManagedCompilerJob
}

export interface Health {
  status: string
  /** Basename of the compiler found on the host, or '' when there is none. */
  compiler: string
  git: boolean
  managed: ManagedCompiler
}

/** Thrown by every call below, carrying the server's own message when it sent one. */
export class PapyrusApiError extends Error {
  status: number
  /** Raw git/compiler output, when the endpoint returned any. */
  output: string
  /** The backend's machine-readable `code`, or '' when it sent none. */
  code: string
  /** For `invalid_project_name`: the refused character, or '' when none was named. */
  char: string

  constructor(message: string, status: number, output = '', code = '', char = '') {
    super(message)
    this.name = 'PapyrusApiError'
    this.status = status
    this.output = output
    this.code = code
    this.char = char
  }
}

interface ErrorBody {
  error?: string
  output?: string
  code?: string
  char?: string
}

function parseBody(text: string): ErrorBody | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as ErrorBody) : null
  } catch {
    return null
  }
}

/** Prefer the backend's own `{error}`/`reason` over a bare "HTTP 500". */
function toError(failure: ScopedFailure): PapyrusApiError {
  const body = parseBody(failure.body)
  // aiohttp's own refusals (a 400 raised with `reason=`) carry a plain-text body,
  // `"400: missing 'name'"`; anything else that is not JSON (an HTML error page
  // from a proxy) is not a message worth showing, so the bare status is used.
  const reason = !body ? (/^\d{3}: (.+)$/s.exec(failure.body.trim())?.[1] ?? '').trim() : ''
  return new PapyrusApiError(
    body?.error || reason || `HTTP ${failure.status}`,
    failure.status,
    body?.output || '',
    typeof body?.code === 'string' ? body.code : '',
    typeof body?.char === 'string' ? body.char : '',
  )
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response
  try {
    r = await transport.raw(`${API}${path}`, init)
  } catch (err) {
    const failure = scopedFailure(err)
    if (failure) throw toError(failure)
    throw err
  }
  return r.json() as Promise<T>
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const q = new URLSearchParams(params)
  const suffix = q.toString() ? `?${q.toString()}` : ''
  return call<T>(`${path}${suffix}`)
}

async function send<T>(method: string, path: string, body: unknown): Promise<T> {
  return call<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function del<T>(path: string, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams(params)
  return call<T>(`${path}?${q.toString()}`, { method: 'DELETE' })
}

/**
 * Compile is the one call that legitimately takes tens of seconds (a paper with a
 * bibliography needs four compiler passes), so it does NOT go through the shared
 * `send` error path: a non-ok response here is a FAILED COMPILE with a parseable
 * log, not a transport error, and throwing would discard exactly the output the
 * user needs to fix their document.
 */
async function compile(name: string): Promise<CompileResult> {
  let text: string
  let status: number
  try {
    const r = await transport.raw(`${API}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    status = r.status
    text = await r.text()
  } catch (err) {
    const failure = scopedFailure(err)
    if (!failure) throw err
    status = failure.status
    text = failure.body
  }
  const data = parseBody(text) as CompileResult | ErrorBody | null
  if (data && 'ok' in data) return data as CompileResult
  // A transport/authorization failure with no compile payload — surface it as a
  // failed compile whose "log" is the error, so one code path renders both.
  const message = (data as ErrorBody | null)?.error || `HTTP ${status}`
  return { ok: false, log: message, errors: [], duration_ms: 0 }
}

/** URL of the compiled PDF, cache-busted so a recompile is never served stale. */
export function pdfUrl(name: string, version: number): string {
  const q = new URLSearchParams({ name, v: String(version) })
  return `${API}${PDF_PATH}?${q.toString()}`
}

export const papyrusApi = {
  health: () => get<Health>('/health'),

  /**
   * Start the managed-compiler install. Answers 202 the moment the background job
   * starts, so the caller polls `/health` for `managed.job` rather than awaiting
   * the ~10-22MB transfer on this request.
   */
  provisionCompiler: () => send<{ ok: boolean; state: string }>('POST', '/compiler/provision', {}),

  listProjects: () => get<{ projects: Project[] }>('/projects'),
  createProject: (name: string) => send<{ name: string; main_file: string }>('POST', '/projects', { name }),
  cloneProject: (url: string, name?: string) =>
    send<{ name: string; main_file: string }>('POST', '/projects/clone', { url, name: name || '' }),
  getProject: (name: string) => get<ProjectDetail>('/project', { name }),
  deleteProject: (name: string) => del<{ ok: boolean }>('/project', { name }),

  listFiles: (name: string) => get<{ files: string[] }>('/files', { name }),
  readFile: (name: string, path: string) => get<{ path: string; content: string }>('/file', { name, path }),
  saveFile: (name: string, path: string, content: string) =>
    send<{ ok: boolean; path: string }>('PUT', '/file', { name, path, content }),
  createFile: (name: string, path: string) =>
    send<{ ok: boolean; path: string }>('POST', '/file', { name, path, content: '' }),
  deleteFile: (name: string, path: string) => del<{ ok: boolean }>('/file', { name, path }),
  setMainFile: (name: string, path: string) =>
    send<{ ok: boolean; main_file: string }>('PUT', '/main', { name, path }),
  /**
   * Rename what the list shows for a paper. `name` (the directory) is untouched.
   *
   * An empty `title` CLEARS the override, and the response carries whatever wins
   * next — `name` — so the caller renders the answer instead of re-deriving it.
   */
  setTitle: (name: string, title: string, generation: string) =>
    send<{ ok: boolean; title: string }>('PUT', '/title', { name, title, generation }),

  compile,

  gitStatus: (name: string) => get<GitStatus>('/git', { name }),
  gitCommit: (name: string, message: string) =>
    send<{ ok: boolean; output: string }>('POST', '/git/commit', { name, message }),
  gitPush: (name: string) => send<{ ok: boolean; output: string }>('POST', '/git/push', { name }),
  gitPull: (name: string) =>
    send<{ ok: boolean; output: string; stashed: boolean }>('POST', '/git/pull', { name }),
}
