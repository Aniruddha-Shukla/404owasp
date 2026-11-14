// Typed client for the NextUp backend. Every call sends:
//  - X-Workspace-Id: a random id kept in localStorage, so each browser has its own data
//  - ?today=YYYY-MM-DD: the browser's local date, so deadline maths matches the user's day

export class ApiError extends Error {
  constructor(status, message, errors) {
    super(message)
    this.status = status
    this.errors = errors
  }
}

const WORKSPACE_KEY = 'nextup:workspace'
let memoryWorkspace = ''

function randomId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

function workspaceId() {
  try {
    let id = localStorage.getItem(WORKSPACE_KEY)
    if (!id) {
      id = randomId()
      localStorage.setItem(WORKSPACE_KEY, id)
    }
    return id
  } catch {
    // Storage blocked (private mode etc.): keep one id for this tab.
    memoryWorkspace ||= randomId()
    return memoryWorkspace
  }
}

function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function send(method, path, body) {
  const res = await fetch(`/api${path}?today=${localToday()}`, {
    method,
    headers: {
      'X-Workspace-Id': workspaceId(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const fallback =
      res.status === 400
        ? 'Validation failed'
        : res.status === 429
          ? 'Too many requests. Slow down a little.'
          : `The server had a problem (${res.status}). Try again.`
    throw new ApiError(res.status, data.error ?? fallback, data.errors)
  }
  return res
}

async function json(method, path, body) {
  const res = await send(method, path, body)
  return res.status === 204 ? undefined : await res.json()
}

/** Like send(), but for file bytes: no JSON headers, no ?today=. */
async function sendRaw(method, url, { body, headers } = {}) {
  const res = await fetch(url, { method, headers: { 'X-Workspace-Id': workspaceId(), ...headers }, body })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(
      res.status,
      data.error ?? data.errors?.version ?? `The server had a problem (${res.status}). Try again.`,
      data.errors,
    )
  }
  return res
}

const resumeUrl = (version) => `/api/resumes/${encodeURIComponent(version)}`

const item = (id) => `/applications/${encodeURIComponent(id)}`

export const api = {
  dashboard: () => json('GET', '/dashboard'),
  create: (draft) => json('POST', '/applications', draft),
  update: (id, draft) => json('PUT', item(id), draft),
  setStatus: (id, status) => json('PATCH', `${item(id)}/status`, { status }),
  /** Inline edit of the next-action memo. Pass '' to clear it. */
  setMemo: (id, nextActionMemo) => json('PATCH', `${item(id)}/memo`, { nextActionMemo }),
  remove: (id) => json('DELETE', item(id)),
  restore: (id) => json('POST', `${item(id)}/restore`),
  resetDemo: () => json('POST', '/demo/reset'),
  wipeAll: () => json('DELETE', '/applications'),

  // ----- optional accounts (the session lives in an HttpOnly cookie the browser sends by itself) -----
  me: () => json('GET', '/auth/me'),
  register: (fields) => json('POST', '/auth/register', fields),
  login: (fields) => json('POST', '/auth/login', fields),
  logout: () => json('POST', '/auth/logout'),

  // ----- resume files, stored in the database under your account (or this browser's workspace) -----
  listResumes: async () => (await (await sendRaw('GET', '/api/resumes')).json()).resumes,
  putResume: (version, file) =>
    sendRaw('PUT', `${resumeUrl(version)}?name=${encodeURIComponent(file.name)}`, {
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  deleteResume: (version) => sendRaw('DELETE', resumeUrl(version)),
  /** Saves the file through the browser's normal download flow. It is never opened or rendered. */
  async downloadResume(version, name) {
    const blob = await (await sendRaw('GET', resumeUrl(version))).blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  },

  /** Downloads everything stored about the signed-in user, as a JSON file. */
  async downloadMyData() {
    const blob = await (await send('GET', '/me/data')).blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nextup-my-data.json'
    a.click()
    URL.revokeObjectURL(url)
  },

  /** Downloads upcoming deadlines as an .ics file for any calendar app. */
  async downloadCalendar() {
    const blob = await (await send('GET', '/export.ics')).blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'internship-deadlines.ics'
    a.click()
    URL.revokeObjectURL(url)
  },
}
