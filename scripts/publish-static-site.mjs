import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const publicDir = path.join(root, 'public')
const dataDir = path.join(publicDir, 'data')
const snapshotsDir = path.join(dataDir, 'snapshots')
const pageSize = 500
const bucketName = 'pdd-images'
const storagePublicMarker = `/storage/v1/object/public/${bucketName}/`
const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('SUPABASE_URL va SUPABASE_SERVICE_ROLE_KEY muhit o‘zgaruvchilari kerak.')
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function storagePathFromUrl(value) {
  if (typeof value !== 'string' || !value) return null
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Rasm URL manzili noto‘g‘ri: ${value}`)
  }
  const markerIndex = url.pathname.indexOf(storagePublicMarker)
  if (markerIndex < 0) {
    throw new Error(`Rasm Supabase ${bucketName} omboriga tegishli emas: ${value}`)
  }
  return decodeURIComponent(url.pathname.slice(markerIndex + storagePublicMarker.length))
}

function publicStorageUrl(image) {
  const bucketPath = image.storage_path || storagePathFromUrl(image.storage_url)
  if (!bucketPath) {
    if (image.status === 'missing' || image.status === 'missing_remote') return null
    throw new Error(`Rasm uchun storage path topilmadi: ${image.id || 'ID yo‘q'}`)
  }
  const normalizedPath = bucketPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalizedPath.split('/').some((part) => part === '..')) {
    throw new Error(`Rasm storage path xavfsiz emas: ${bucketPath}`)
  }
  const pathParts = normalizedPath.split('/')
  if (
    pathParts.some(
      (part) => !part || part === '.' || part === '..'
    )
  ) {
    throw new Error(`Rasm storage path noto‘g‘ri: ${normalizedPath}`)
  }
  const encodedPath = pathParts.map(encodeURIComponent).join('/')
  return new URL(
    `/storage/v1/object/public/${bucketName}/${encodedPath}`,
    supabaseUrl
  ).toString()
}

async function fetchCatalog() {
  const { data, error } = await supabase.rpc('sync_base_catalog', {
    p_device_id: 'static-site-publisher',
    p_since: new Date(0).toISOString(),
  })
  if (error) throw new Error(`Katalogni Supabase’dan olishda xatolik: ${error.message}`)
  if (!data || !Array.isArray(data.sections) || !Array.isArray(data.lessons)) {
    throw new Error('Supabase katalog javobi noto‘g‘ri formatda.')
  }
  const { server_time: _serverTime, ...catalog } = data
  return catalog
}

async function fetchAllQuestions() {
  const rows = []
  let cursor = { since: new Date(0).toISOString(), afterId: 0 }

  for (;;) {
    const { data, error } = await supabase.rpc('sync_base_questions', {
      p_device_id: 'static-site-publisher',
      p_since: cursor.since,
      p_after_id: cursor.afterId,
      p_limit: pageSize,
    })
    if (error) throw new Error(`Savollarni Supabase’dan olishda xatolik: ${error.message}`)
    if (!Array.isArray(data)) throw new Error('Savol sinxronlash javobi noto‘g‘ri formatda.')
    if (data.length === 0) break
    rows.push(...data)
    const last = data[data.length - 1]
    cursor = { since: last.updated_at, afterId: last.id }
    if (data.length < pageSize) break
  }

  return rows
}

async function fetchLessonQuestionOrder() {
  const { data, error } = await supabase.rpc('sync_lesson_question_order', {
    p_device_id: 'static-site-publisher',
  })
  if (error) throw new Error(`Savol tartibini Supabase’dan olishda xatolik: ${error.message}`)
  if (!Array.isArray(data)) throw new Error('Savol tartibi noto‘g‘ri formatda.')
  return data.sort((a, b) =>
    Number(a.lesson_id) - Number(b.lesson_id) ||
    Number(a.sort_order) - Number(b.sort_order) ||
    String(a.question_source).localeCompare(String(b.question_source)) ||
    Number(a.question_id) - Number(b.question_id)
  )
}

async function main() {
  const publishStartedAt = new Date().toISOString()
  fs.mkdirSync(snapshotsDir, { recursive: true })

  const [catalog, rows, lessonQuestionOrder] = await Promise.all([
    fetchCatalog(),
    fetchAllQuestions(),
    fetchLessonQuestionOrder(),
  ])
  const warnings = []

  const missingImage = (image) => ({
    ...image,
    status: 'missing',
    storage_path: null,
    storage_url: null,
  })

  for (const row of rows) {
    row.images = (row.images || []).map((image) => {
      let storageUrl
      try {
        storageUrl = publicStorageUrl(image)
      } catch (error) {
        warnings.push(`Savol ${row.id}: ${error.message}`)
        return missingImage(image)
      }
      if (!storageUrl) return { ...image, storage_path: null, storage_url: null }
      return {
        ...image,
        storage_path: null,
        storage_url: storageUrl,
      }
    })
  }

  const fallbackImage = catalog.settings?.no_question_image_url
  if (typeof fallbackImage === 'string' && fallbackImage) {
    try {
      catalog.settings.no_question_image_url = publicStorageUrl({
        storage_url: fallbackImage,
        status: 'available',
      })
    } catch (error) {
      warnings.push(`Standart rasm: ${error.message}`)
      delete catalog.settings.no_question_image_url
    }
  }

  const snapshot = {
    schemaVersion: 1,
    catalog,
    questions: rows,
    lessonQuestionOrder,
  }
  const snapshotJson = `${JSON.stringify(snapshot)}\n`
  const version = createHash('sha256').update(snapshotJson).digest('hex')
  const snapshotName = `${version}.json`
  const versionPath = path.join(dataDir, 'version.json')
  let publishedAt = publishStartedAt
  let previousSnapshotName = null
  if (fs.existsSync(versionPath)) {
    try {
      const previousVersion = JSON.parse(fs.readFileSync(versionPath, 'utf8'))
      if (typeof previousVersion.snapshot === 'string') {
        previousSnapshotName = path.basename(previousVersion.snapshot)
      }
      if (
        previousVersion.version === version &&
        typeof previousVersion.publishedAt === 'string' &&
        Number.isFinite(Date.parse(previousVersion.publishedAt))
      ) {
        publishedAt = previousVersion.publishedAt
      }
    } catch {
      // buzilgan eski version.json yangisi bilan almashtiriladi
    }
  }
  fs.writeFileSync(path.join(snapshotsDir, snapshotName), snapshotJson, 'utf8')
  fs.writeFileSync(
    versionPath,
    `${JSON.stringify({ version, snapshot: `snapshots/${snapshotName}`, publishedAt }, null, 2)}\n`,
    'utf8'
  )

  // Eskirgan snapshot'lar: faqat joriysi va oldingisi qoladi (repo hajmi o‘smasligi uchun).
  const keepSnapshots = new Set([snapshotName, previousSnapshotName].filter(Boolean))
  for (const name of fs.readdirSync(snapshotsDir)) {
    if (name.endsWith('.json') && !keepSnapshots.has(name)) {
      fs.rmSync(path.join(snapshotsDir, name))
    }
  }

  for (const warning of warnings) console.warn(`OGOHLANTIRISH: ${warning}`)
  console.log(
    `Static snapshot tayyor: ${rows.length} savol; rasm fayllari repoga olinmadi, ` +
    `${warnings.length} ogohlantirish, versiya ${version}`
  )
}

await main()
