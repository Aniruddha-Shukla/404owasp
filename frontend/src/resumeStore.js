// Resume vault, backed by the API. Files are saved in the database (MongoDB) under the signed-in account, or under
// this browser's workspace when signed out. The server re-checks every file; the checks here only give quick feedback.
// One file per resume version label.

import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

export const RESUME_MAX_BYTES = 2 * 1024 * 1024
export const RESUME_ACCEPT = '.pdf,.doc,.docx'

const CHANGED = 'nextup:resumes'

/** Ask every list on screen to reload (after an upload, a delete, or signing in or out). */
export const refreshResumes = () => window.dispatchEvent(new Event(CHANGED))

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b)

/** Returns an error message, or null when the file is an acceptable resume. */
export async function validateResume(file) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!['pdf', 'doc', 'docx'].includes(ext)) return 'Use a PDF, DOC or DOCX file'
  if (file.size === 0) return 'That file is empty'
  if (file.size > RESUME_MAX_BYTES) return 'Keep resumes under 2 MB'
  // Check the real file signature, not just the name.
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const ok =
    (ext === 'pdf' && startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) || // %PDF-
    (ext === 'docx' && startsWith(head, [0x50, 0x4b, 0x03, 0x04])) || // zip container
    (ext === 'doc' && startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) // legacy OLE
  return ok ? null : `That doesn't look like a real .${ext} file`
}

export async function putResume(version, file) {
  const problem = await validateResume(file)
  if (problem) throw new Error(problem)
  await api.putResume(version, file)
  refreshResumes()
}

export async function deleteResume(version) {
  await api.deleteResume(version)
  refreshResumes()
}

export const downloadResume = (file) => api.downloadResume(file.version, file.name)

export const formatSize = (bytes) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** All stored resumes (details only, not the files), kept in sync across the form and the Resume Lab. */
export function useResumes() {
  const [files, setFiles] = useState([])
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    api.listResumes().then(
      (all) => {
        setFiles(all.map((r) => ({ ...r, addedAt: Date.parse(r.uploadedAt) })))
        setError('')
      },
      (e) => setError(e instanceof Error ? e.message : 'Could not load your resumes'),
    )
  }, [])

  useEffect(() => {
    refresh()
    window.addEventListener(CHANGED, refresh)
    return () => window.removeEventListener(CHANGED, refresh)
  }, [refresh])

  return { files, error }
}
