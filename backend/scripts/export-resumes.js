// For a database manager: list every uploaded resume with its owner, and save the files to a folder.
// Atlas can show a resume's details but cannot open a PDF, so this does it.
//
//   MONGODB_URI="mongodb+srv://..." node scripts/export-resumes.js            list, then save to ./exported-resumes
//   MONGODB_URI="mongodb+srv://..." node scripts/export-resumes.js ./out      save to ./out
//   MONGODB_URI="mongodb+srv://..." node scripts/export-resumes.js --list     only list, save nothing
//
// Files are written to <folder>/<owner>/<version> - <file name>. Owner is the account's email when the resume
// belongs to a signed-in user, otherwise the anonymous browser's workspace id. MONGODB_DB picks the database
// (default "nextup").

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MongoClient } from 'mongodb'

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('Set MONGODB_URI first, e.g.  MONGODB_URI="mongodb+srv://..." node scripts/export-resumes.js')
  process.exit(1)
}

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const outDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'exported-resumes')

/** One safe path segment: letters, digits and a few punctuation marks; never empty, never "." or "..". */
const segment = (text) =>
  String(text)
    .replace(/[^A-Za-z0-9._@+ -]/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 100) || '_'

const client = new MongoClient(uri, { appName: 'nextup-export', serverSelectionTimeoutMS: 8000 })
try {
  await client.connect()
  const db = client.db(process.env.MONGODB_DB || 'nextup')

  const resumes = await db.collection('resumes').find({}).sort({ uploadedAt: -1 }).toArray()
  if (resumes.length === 0) {
    console.log('No resumes stored yet.')
  } else {
    const userIds = [
      ...new Set(
        resumes
          .map((r) => r.workspace)
          .filter((w) => w.startsWith('u_'))
          .map((w) => w.slice(2)),
      ),
    ]
    const users = await db
      .collection('users')
      .find({ _id: { $in: userIds } }, { projection: { email: 1, name: 1 } })
      .toArray()
    const emailOf = new Map(users.map((u) => [u._id, u.email]))
    const ownerOf = (r) =>
      r.workspace.startsWith('u_') ? (emailOf.get(r.workspace.slice(2)) ?? r.workspace) : `anonymous ${r.workspace}`

    console.table(
      resumes.map((r) => ({
        owner: ownerOf(r),
        version: r.version,
        file: r.name,
        size: `${Math.max(1, Math.round(r.size / 1024))} KB`,
        uploaded: r.uploadedAt.toISOString().slice(0, 16).replace('T', ' '),
      })),
    )

    if (!listOnly) {
      for (const r of resumes) {
        const folder = path.join(outDir, segment(ownerOf(r)))
        const file = path.join(folder, `${segment(r.version)} - ${segment(r.name)}`)
        if (!path.resolve(file).startsWith(outDir + path.sep)) throw new Error(`Refusing to write outside ${outDir}`) // belt and braces
        await mkdir(folder, { recursive: true })
        await writeFile(file, r.data.buffer.subarray(0, r.data.length()))
      }
      console.log(`Saved ${resumes.length} file(s) under ${outDir}`)
    }
  }
} finally {
  await client.close()
}
