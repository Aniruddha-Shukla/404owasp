// Where uploaded resume files are kept.
//
//   resumes  { _id: "<owner>|<version>", workspace, version, name, size, contentType, sha256, uploadedAt, data }
//
// `workspace` is the owner: the signed-in account's workspace (u_<user id>) or the browser's workspace id.
// One file per owner and resume version label (uploading the same version again replaces it). A resume is at
// most 2 MB, so it fits in an ordinary MongoDB document (no GridFS needed). Files are removed 14 days after
// upload by a TTL index, like the rest of the demo data.
//
// In memory by default (lost on restart); in MongoDB when MONGODB_URI is set.

import { dbFromUri } from './mongo.js'

export const RESUME_MAX_BYTES = 2 * 1024 * 1024
export const MAX_RESUMES_PER_WORKSPACE = 20
const TTL_SECONDS = 14 * 24 * 60 * 60
const MAX_MEMORY_BYTES = 64 * 1024 * 1024 // memory mode only: stop accepting files past this total

const toMeta = ({ version, name, size, contentType, sha256, uploadedAt }) => ({
  version,
  name,
  size,
  contentType,
  sha256,
  uploadedAt,
})
const newestFirst = (a, b) => b.uploadedAt - a.uploadedAt

export function createMemoryResumeStore() {
  const owners = new Map() // workspace -> Map(version -> resume)
  let totalBytes = 0

  return {
    kind: 'memory',
    async put(workspace, resume) {
      const mine = owners.get(workspace) ?? new Map()
      const previous = mine.get(resume.version)
      if (!previous && mine.size >= MAX_RESUMES_PER_WORKSPACE) return 'full'
      if (totalBytes - (previous?.size ?? 0) + resume.size > MAX_MEMORY_BYTES) return 'full'
      totalBytes += resume.size - (previous?.size ?? 0)
      mine.set(resume.version, { ...resume })
      owners.set(workspace, mine)
      return previous ? 'replaced' : 'created'
    },
    async list(workspace) {
      return [...(owners.get(workspace)?.values() ?? [])].map(toMeta).sort(newestFirst)
    },
    async get(workspace, version) {
      return owners.get(workspace)?.get(version) ?? null
    },
    async remove(workspace, version) {
      const mine = owners.get(workspace)
      const previous = mine?.get(version)
      if (!previous) return false
      mine.delete(version)
      totalBytes -= previous.size
      return true
    },
  }
}

/** The driver hands back a BSON Binary; tests may hand back a Buffer. Return a Buffer either way. */
const asBuffer = (raw) =>
  Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer.subarray(0, typeof raw.length === 'function' ? raw.length() : raw.length))

/** Resume store over a MongoDB database handle (or a fake with the same methods, in tests). */
export function createMongoResumeStore(getDb) {
  let ready
  async function collection() {
    const c = (await getDb()).collection('resumes')
    ready ??= Promise.all([
      c.createIndex({ workspace: 1 }),
      c.createIndex({ uploadedAt: 1 }, { expireAfterSeconds: TTL_SECONDS }),
    ]).catch(() => {})
    await ready
    return c
  }
  const idOf = (workspace, version) => `${workspace}|${version}`

  return {
    kind: 'mongodb',
    async put(workspace, resume) {
      const c = await collection()
      const existing = await c.findOne({ _id: idOf(workspace, resume.version) }, { projection: { _id: 1 } })
      if (!existing && (await c.countDocuments({ workspace })) >= MAX_RESUMES_PER_WORKSPACE) return 'full'
      await c.replaceOne(
        { _id: idOf(workspace, resume.version) },
        { workspace, ...toMeta(resume), data: resume.data },
        { upsert: true },
      )
      return existing ? 'replaced' : 'created'
    },
    async list(workspace) {
      const docs = await (await collection()).find({ workspace }, { projection: { data: 0 } }).toArray()
      return docs.map(toMeta).sort(newestFirst)
    },
    async get(workspace, version) {
      const doc = await (await collection()).findOne({ _id: idOf(workspace, version), workspace })
      return doc ? { ...toMeta(doc), data: asBuffer(doc.data) } : null
    },
    async remove(workspace, version) {
      const result = await (await collection()).deleteOne({ _id: idOf(workspace, version), workspace })
      return result.deletedCount > 0
    },
  }
}

/** MongoDB resume storage when MONGODB_URI is set, otherwise in-memory. */
export function resumeStoreFromEnv(env = process.env) {
  if (!env.MONGODB_URI) return createMemoryResumeStore()
  const dbName = env.MONGODB_DB || 'nextup'
  return createMongoResumeStore(() => dbFromUri(env.MONGODB_URI, dbName))
}
