// Resume files: upload, list, download, delete. Everything is checked here on the server, because the browser's
// own checks can be bypassed. Files are never rendered, only offered as downloads.
//
//   GET    /api/resumes                 -> { resumes: [ { version, name, size, contentType, uploadedAt } ] }
//   PUT    /api/resumes/:version?name=  raw file bytes in the body -> 201 | 200 { resume }
//   GET    /api/resumes/:version        -> the file, as an attachment
//   DELETE /api/resumes/:version        -> 204
//
// Owner = the signed-in account's workspace, or the browser's workspace id (same rule as the rest of the API).

import { createHash } from 'node:crypto'
import express from 'express'

import { MAX_RESUMES_PER_WORKSPACE, RESUME_MAX_BYTES } from './resume-store.js'
import { rateLimit, workspaceFrom } from './security.js'

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g
const SIGNATURES = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  docx: [0x50, 0x4b, 0x03, 0x04], // zip container
  doc: [0xd0, 0xcf, 0x11, 0xe0], // legacy OLE
}
const TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/** A file name that is safe to store and show: no control characters or path characters, at most 80 characters. */
export function cleanFileName(name) {
  const text = String(name ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 80) || 'resume'
}

/** The resume version label (e.g. "v2-backend"): 1 to 30 characters, no control characters. Returns null if unusable. */
export function cleanVersion(value) {
  const text = String(value ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length >= 1 && text.length <= 30 ? text : null
}

/** Check name, size and the real file signature. Returns { ok: true, ext, contentType } or { ok: false, error }. */
export function validateResumeFile(name, bytes) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (!SIGNATURES[ext]) return { ok: false, error: 'Use a PDF, DOC or DOCX file' }
  if (bytes.length === 0) return { ok: false, error: 'That file is empty' }
  if (bytes.length > RESUME_MAX_BYTES) return { ok: false, error: 'Keep resumes under 2 MB' }
  if (!SIGNATURES[ext].every((b, i) => bytes[i] === b)) return { ok: false, error: `That doesn't look like a real .${ext} file` }
  return { ok: true, ext, contentType: TYPES[ext] }
}

export function resumeRouter({ resumeStore, uploadsPerMinute = 30 }) {
  const router = express.Router()
  const limitUploads = rateLimit({ windowMs: 60_000, max: uploadsPerMinute })
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store')
    next()
  })

  const owner = (req, res) => {
    const workspace = workspaceFrom(req)
    if (!workspace) res.status(400).json({ error: 'Invalid X-Workspace-Id header' })
    return workspace
  }
  const versionOf = (req, res) => {
    const version = cleanVersion(req.params.version)
    if (!version) res.status(400).json({ errors: { version: 'Use 1 to 30 characters for the resume version' } })
    return version
  }

  router.get('/', async (req, res, next) => {
    try {
      const workspace = owner(req, res)
      if (workspace) res.json({ resumes: await resumeStore.list(workspace) })
    } catch (err) {
      next(err)
    }
  })

  router.put(
    '/:version',
    limitUploads,
    express.raw({ type: () => true, limit: RESUME_MAX_BYTES + 1024 }),
    async (req, res, next) => {
      try {
        const workspace = owner(req, res)
        const version = workspace && versionOf(req, res)
        if (!workspace || !version) return
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        const name = cleanFileName(req.query.name)
        const checked = validateResumeFile(name, bytes)
        if (!checked.ok) return res.status(400).json({ error: checked.error })

        const resume = {
          version,
          name,
          size: bytes.length,
          contentType: checked.contentType,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          uploadedAt: new Date(),
          data: bytes,
        }
        const result = await resumeStore.put(workspace, resume)
        if (result === 'full')
          return res.status(409).json({ error: `You have reached the limit of ${MAX_RESUMES_PER_WORKSPACE} resumes` })
        const { data: _data, ...meta } = resume
        res.status(result === 'created' ? 201 : 200).json({ resume: meta })
      } catch (err) {
        next(err)
      }
    },
  )

  router.get('/:version', async (req, res, next) => {
    try {
      const workspace = owner(req, res)
      const version = workspace && versionOf(req, res)
      if (!workspace || !version) return
      const resume = await resumeStore.get(workspace, version)
      if (!resume) return res.status(404).json({ error: 'Resume not found' })
      // An attachment is saved, never displayed by the browser; nosniff is already set on every response.
      res.attachment(resume.name)
      res.type(resume.contentType)
      res.send(resume.data)
    } catch (err) {
      next(err)
    }
  })

  router.delete('/:version', async (req, res, next) => {
    try {
      const workspace = owner(req, res)
      const version = workspace && versionOf(req, res)
      if (!workspace || !version) return
      if (!(await resumeStore.remove(workspace, version))) return res.status(404).json({ error: 'Resume not found' })
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })

  return router
}
