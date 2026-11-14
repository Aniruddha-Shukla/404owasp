import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import { createApp } from '../src/app.js'
import { dbFromUri, closeMongo } from '../src/mongo.js'
import {
  MAX_RESUMES_PER_WORKSPACE,
  RESUME_MAX_BYTES,
  createMemoryResumeStore,
  createMongoResumeStore,
} from '../src/resume-store.js'
import { cleanFileName, cleanVersion } from '../src/resumes.js'

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('1 0 obj<</Type/Catalog>>endobj\n%%EOF'), Buffer.alloc(300, 7)])
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 9)])

async function browser(options = {}) {
  const server = createApp({ frontendDir: '/nonexistent', ...options }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://localhost:${server.address().port}`
  const client = {
    cookie: '',
    server,
    close: () => server.close(),
    async call(method, path, { body, headers = {}, json } = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(Buffer.isBuffer(body) ? { 'Content-Type': 'application/octet-stream' } : {}),
          ...(client.cookie ? { Cookie: client.cookie } : {}),
          ...headers,
        },
        body: json !== undefined ? JSON.stringify(json) : body,
      })
      const set = res.headers.get('set-cookie')
      if (set) client.cookie = set.split(';')[0]
      const bytes = Buffer.from(await res.arrayBuffer())
      const isJson = res.headers.get('content-type')?.includes('json')
      return {
        status: res.status,
        headers: res.headers,
        bytes,
        body: isJson && bytes.length ? JSON.parse(bytes.toString()) : undefined,
      }
    },
    upload: (version, file, name = 'My CV.pdf', headers = {}) =>
      client.call('PUT', `/api/resumes/${encodeURIComponent(version)}?name=${encodeURIComponent(name)}`, { body: file, headers }),
  }
  return client
}

const ws = (n) => ({ 'X-Workspace-Id': `resume-workspace-${n}` })

describe('uploading and downloading resumes', () => {
  test('upload, list, download: the bytes come back identical, as an attachment', async () => {
    const b = await browser()
    try {
      const put = await b.upload('v2-backend', PDF, 'Aniruddha CV.pdf', ws(1))
      assert.equal(put.status, 201)
      assert.equal(put.body.resume.version, 'v2-backend')
      assert.equal(put.body.resume.name, 'Aniruddha CV.pdf')
      assert.equal(put.body.resume.size, PDF.length)
      assert.equal(put.body.resume.contentType, 'application/pdf')
      assert.equal(put.body.resume.sha256, createHash('sha256').update(PDF).digest('hex'))
      assert.ok(!('data' in put.body.resume), 'the response never echoes the file')

      const list = await b.call('GET', '/api/resumes', { headers: ws(1) })
      assert.equal(list.body.resumes.length, 1)
      assert.ok(!JSON.stringify(list.body).includes('data'))

      const file = await b.call('GET', '/api/resumes/v2-backend', { headers: ws(1) })
      assert.equal(file.status, 200)
      assert.ok(file.bytes.equals(PDF))
      assert.match(file.headers.get('content-disposition'), /^attachment;/)
      assert.match(file.headers.get('content-disposition'), /Aniruddha CV\.pdf/)
      assert.equal(file.headers.get('content-type'), 'application/pdf')
      assert.equal(file.headers.get('x-content-type-options'), 'nosniff')
      assert.match(file.headers.get('cache-control'), /no-store/)
    } finally {
      b.close()
    }
  })

  test('uploading the same version again replaces the file (200), and docx is accepted', async () => {
    const b = await browser()
    try {
      assert.equal((await b.upload('v1', PDF, 'a.pdf', ws(2))).status, 201)
      assert.equal((await b.upload('v1', DOCX, 'b.docx', ws(2))).status, 200)
      const list = (await b.call('GET', '/api/resumes', { headers: ws(2) })).body.resumes
      assert.equal(list.length, 1)
      assert.equal(list[0].name, 'b.docx')
      assert.equal(list[0].contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      assert.ok((await b.call('GET', '/api/resumes/v1', { headers: ws(2) })).bytes.equals(DOCX))
    } finally {
      b.close()
    }
  })

  test('delete removes it; a second delete and a download are 404', async () => {
    const b = await browser()
    try {
      await b.upload('v1', PDF, 'a.pdf', ws(3))
      assert.equal((await b.call('DELETE', '/api/resumes/v1', { headers: ws(3) })).status, 204)
      assert.equal((await b.call('DELETE', '/api/resumes/v1', { headers: ws(3) })).status, 404)
      assert.equal((await b.call('GET', '/api/resumes/v1', { headers: ws(3) })).status, 404)
    } finally {
      b.close()
    }
  })
})

describe('the server checks every upload itself', () => {
  test('wrong extension, wrong signature, empty and oversize files are refused', async () => {
    const b = await browser()
    try {
      const h = ws(4)
      assert.equal((await b.upload('v1', Buffer.from('hello'), 'notes.txt', h)).body.error, 'Use a PDF, DOC or DOCX file')
      assert.match((await b.upload('v1', Buffer.from('not really a pdf'), 'fake.pdf', h)).body.error, /real \.pdf/)
      assert.match((await b.upload('v1', DOCX, 'sneaky.pdf', h)).body.error, /real \.pdf/) // a zip pretending to be a pdf
      assert.match((await b.upload('v1', PDF, 'sneaky.docx', h)).body.error, /real \.docx/)
      assert.equal((await b.upload('v1', Buffer.alloc(0), 'empty.pdf', h)).body.error, 'That file is empty')
      const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(RESUME_MAX_BYTES + 5000, 1)])
      assert.equal((await b.upload('v1', big, 'big.pdf', h)).status, 413)
      assert.equal((await b.call('GET', '/api/resumes', { headers: h })).body.resumes.length, 0, 'nothing was stored')
    } finally {
      b.close()
    }
  })

  test('version labels must be 1 to 30 characters; a bad URL escape is a 400, not a crash', async () => {
    const b = await browser()
    try {
      const h = ws(5)
      assert.equal((await b.upload('   ', PDF, 'a.pdf', h)).status, 400)
      assert.equal((await b.upload('x'.repeat(31), PDF, 'a.pdf', h)).status, 400)
      assert.equal((await b.upload('x'.repeat(30), PDF, 'a.pdf', h)).status, 201)
      assert.equal((await b.call('GET', '/api/resumes/%E0%A4%A', { headers: h })).status, 400)
    } finally {
      b.close()
    }
  })

  test('file names are cleaned: no path characters, no header injection', async () => {
    assert.equal(cleanFileName('..\\..\\evil<script>.pdf'), '....evilscript.pdf')
    assert.equal(cleanFileName(''), 'resume')
    assert.equal(cleanFileName('a'.repeat(200)).length, 80)
    assert.equal(cleanVersion('  v2   backend '), 'v2 backend')
    assert.equal(cleanVersion(''), null)

    const b = await browser()
    try {
      const h = ws(6)
      await b.upload('v1', PDF, 'a\r\nSet-Cookie: pwned=1.pdf', h)
      const file = await b.call('GET', '/api/resumes/v1', { headers: h })
      assert.equal(file.status, 200)
      assert.equal(file.headers.get('set-cookie'), null)
      assert.ok(!/[\r\n]/.test(file.headers.get('content-disposition')))
    } finally {
      b.close()
    }
  })

  test('at most 20 resumes per owner; replacing one at the limit still works', async () => {
    const b = await browser()
    try {
      const h = ws(7)
      for (let i = 0; i < MAX_RESUMES_PER_WORKSPACE; i++) assert.equal((await b.upload(`v${i}`, PDF, 'a.pdf', h)).status, 201)
      const over = await b.upload('one-too-many', PDF, 'a.pdf', h)
      assert.equal(over.status, 409)
      assert.match(over.body.error, /limit of 20/)
      assert.equal((await b.upload('v0', PDF, 'new.pdf', h)).status, 200)
    } finally {
      b.close()
    }
  })

  test('uploads are rate limited, and a request from another website is refused', async () => {
    const b = await browser({ resumeUploadsPerMinute: 3 })
    try {
      const codes = []
      for (let i = 0; i < 5; i++) codes.push((await b.upload(`v${i}`, PDF, 'a.pdf', ws(8))).status)
      assert.deepEqual(codes, [201, 201, 201, 429, 429])
      assert.equal((await b.upload('x', PDF, 'a.pdf', { ...ws(9), Origin: 'https://evil.example' })).status, 403)
    } finally {
      b.close()
    }
  })
})

describe('resumes belong to their owner', () => {
  test('another browser cannot list, download or delete them', async () => {
    const b = await browser()
    try {
      await b.upload('private', PDF, 'secret.pdf', ws(10))
      const other = ws(11)
      assert.equal((await b.call('GET', '/api/resumes', { headers: other })).body.resumes.length, 0)
      assert.equal((await b.call('GET', '/api/resumes/private', { headers: other })).status, 404)
      assert.equal((await b.call('DELETE', '/api/resumes/private', { headers: other })).status, 404)
      assert.equal((await b.call('GET', '/api/resumes/private', { headers: ws(10) })).status, 200) // still there for the owner
    } finally {
      b.close()
    }
  })

  test('a signed-in account has its own resumes, which follow it across browsers; /api/me/data lists them', async () => {
    const b = await browser()
    try {
      await b.call('POST', '/api/auth/register', {
        json: { email: 'cv@example.com', password: 'correct horse 42', name: 'CV Owner' },
      })
      await b.upload('v1', PDF, 'mine.pdf', ws(12))
      // the browser's workspace header is ignored while signed in: a different header sees the same resumes
      assert.equal((await b.call('GET', '/api/resumes', { headers: ws(13) })).body.resumes[0].name, 'mine.pdf')
      const data = (await b.call('GET', '/api/me/data')).body
      assert.equal(data.resumes.length, 1)
      assert.ok(!JSON.stringify(data).includes('%PDF'))
      // signed out, the anonymous workspace has none
      await b.call('POST', '/api/auth/logout')
      b.cookie = ''
      assert.equal((await b.call('GET', '/api/resumes', { headers: ws(12) })).body.resumes.length, 0)
    } finally {
      b.close()
    }
  })

  test('separate server copies sharing one resume store see the same files', async () => {
    const resumeStore = createMemoryResumeStore()
    const a = await browser({ resumeStore })
    const b = await browser({ resumeStore })
    try {
      await a.upload('v1', PDF, 'shared.pdf', ws(14))
      assert.ok((await b.call('GET', '/api/resumes/v1', { headers: ws(14) })).bytes.equals(PDF))
    } finally {
      a.close()
      b.close()
    }
  })
})

/** The few collection methods the Mongo resume store uses, backed by a Map. Returns BSON-Binary-like values like the driver. */
function fakeDb() {
  const docs = new Map()
  const asBinary = (buf) => ({ buffer: new Uint8Array(Buffer.concat([buf, Buffer.alloc(16)])), length: () => buf.length }) // padded, like a real Binary
  const collection = {
    docs,
    async createIndex() {},
    async findOne({ _id, workspace }, options) {
      const doc = docs.get(_id)
      if (!doc || (workspace && doc.workspace !== workspace)) return null
      return options?.projection?._id ? { _id } : { ...doc, data: asBinary(doc.data) }
    },
    async countDocuments({ workspace }) {
      return [...docs.values()].filter((d) => d.workspace === workspace).length
    },
    async replaceOne({ _id }, doc) {
      docs.set(_id, { _id, ...doc })
    },
    find({ workspace }) {
      return {
        toArray: async () => [...docs.values()].filter((d) => d.workspace === workspace).map(({ data: _d, ...rest }) => rest),
      }
    },
    async deleteOne({ _id, workspace }) {
      const doc = docs.get(_id)
      if (!doc || doc.workspace !== workspace) return { deletedCount: 0 }
      docs.delete(_id)
      return { deletedCount: 1 }
    },
  }
  return { collection: () => collection, docs }
}

describe('MongoDB resume store (fake database)', () => {
  test('stores one document per owner and version, keeps the bytes intact, and enforces ownership', async () => {
    const db = fakeDb()
    const b = await browser({ resumeStore: createMongoResumeStore(() => db) })
    try {
      assert.equal((await b.upload('v2-backend', PDF, 'CV.pdf', ws(20))).status, 201)
      const doc = db.docs.get('resume-workspace-20|v2-backend')
      assert.deepEqual(Object.keys(doc).sort(), [
        '_id',
        'contentType',
        'data',
        'name',
        'sha256',
        'size',
        'uploadedAt',
        'version',
        'workspace',
      ])
      assert.equal(doc.workspace, 'resume-workspace-20')
      assert.ok(doc.uploadedAt instanceof Date)
      assert.ok((await b.call('GET', '/api/resumes/v2-backend', { headers: ws(20) })).bytes.equals(PDF)) // padding stripped
      assert.equal((await b.call('GET', '/api/resumes/v2-backend', { headers: ws(21) })).status, 404)
      assert.equal((await b.upload('v2-backend', DOCX, 'CV.docx', ws(20))).status, 200)
      assert.equal(db.docs.size, 1)
      assert.equal((await b.call('DELETE', '/api/resumes/v2-backend', { headers: ws(20) })).status, 204)
      assert.equal(db.docs.size, 0)
    } finally {
      b.close()
    }
  })

  test('enforces the 20-resume limit', async () => {
    const db = fakeDb()
    const b = await browser({ resumeStore: createMongoResumeStore(() => db) })
    try {
      for (let i = 0; i < 20; i++) await b.upload(`v${i}`, PDF, 'a.pdf', ws(22))
      assert.equal((await b.upload('extra', PDF, 'a.pdf', ws(22))).status, 409)
    } finally {
      b.close()
    }
  })
})

// Runs against a real MongoDB only when you point it at one, e.g.
//   MONGODB_TEST_URI=mongodb://localhost:27017 npm test
describe('resumes in a real MongoDB', { skip: !process.env.MONGODB_TEST_URI && 'set MONGODB_TEST_URI to run' }, () => {
  test('files are stored as binary documents with indexes, and download byte for byte', async () => {
    const db = await dbFromUri(process.env.MONGODB_TEST_URI, `nextup_resume_test_${Date.now()}`)
    const resumeStore = createMongoResumeStore(() => db)
    const a = await browser({ resumeStore })
    const b = await browser({ resumeStore })
    try {
      assert.equal((await a.upload('v2-backend', PDF, 'Real CV.pdf', ws(30))).status, 201)
      const doc = await db.collection('resumes').findOne({ _id: 'resume-workspace-30|v2-backend' })
      assert.equal(doc.workspace, 'resume-workspace-30')
      assert.equal(doc.name, 'Real CV.pdf')
      assert.equal(doc.size, PDF.length)
      assert.equal(doc.sha256, createHash('sha256').update(PDF).digest('hex'))
      assert.ok(doc.uploadedAt instanceof Date)
      assert.equal(doc.data.constructor.name, 'Binary')

      const indexes = await db.collection('resumes').indexes()
      assert.ok(indexes.some((i) => i.key.workspace === 1))
      assert.ok(
        indexes.some((i) => i.key.uploadedAt === 1 && i.expireAfterSeconds === 14 * 24 * 60 * 60),
        'TTL index',
      )

      assert.ok(
        (await b.call('GET', '/api/resumes/v2-backend', { headers: ws(30) })).bytes.equals(PDF),
        'other server copy, same bytes',
      )
      assert.equal((await b.call('GET', '/api/resumes/v2-backend', { headers: ws(31) })).status, 404)
    } finally {
      a.close()
      b.close()
      await db.dropDatabase().catch(() => {})
      await closeMongo()
    }
  })
})
