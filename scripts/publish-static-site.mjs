import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const publicDir = path.join(root, 'public')
const imageDir = path.join(publicDir, 'basa_img')
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

function staticImagePath(image) {
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
      (part) => !part || part === '.' || !/^[A-Za-z0-9._-]+$/.test(part)
    )
  ) {
    throw new Error(`Rasm storage path qo‘llab-quvvatlanmaydi: ${normalizedPath}`)
  }
  return { bucketPath: normalizedPath, filePath: normalizedPath }
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

async function ensureImage(bucketPath, filePath) {
  const destination = path.join(imageDir, ...filePath.split('/'))
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return

  const { data, error } = await supabase.storage.from(bucketName).download(bucketPath)
  if (error || !data) {
    throw new Error(`Rasmni Supabase’dan yuklab bo‘lmadi (${bucketPath}): ${error?.message || 'javob bo‘sh'}`)
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, Buffer.from(await data.arrayBuffer()))
}

function imageDigest(filePath) {
  const image = fs.readFileSync(path.join(imageDir, ...filePath.split('/')))
  return createHash('sha256').update(image).digest('hex')
}

async function main() {
  const publishStartedAt = new Date().toISOString()
  fs.mkdirSync(imageDir, { recursive: true })
  fs.mkdirSync(snapshotsDir, { recursive: true })

  const [catalog, rows, lessonQuestionOrder] = await Promise.all([
    fetchCatalog(),
    fetchAllQuestions(),
    fetchLessonQuestionOrder(),
  ])
  const imagePaths = new Map()
  let fallbackImagePath = null

  for (const row of rows) {
    row.images = (row.images || []).map((image) => {
      const source = staticImagePath(image)
      if (!source) return { ...image, storage_path: null, storage_url: null }
      const previousPath = imagePaths.get(source.filePath)
      if (previousPath && previousPath !== source.bucketPath) {
        throw new Error(`Bir xil statik rasm yo‘li turli storage path’larda bor: ${source.filePath}`)
      }
      imagePaths.set(source.filePath, source.bucketPath)
      return {
        ...image,
        storage_path: `basa_img/${source.filePath}`,
        storage_url: null,
      }
    })
  }

  const fallbackImage = catalog.settings?.no_question_image_url
  if (typeof fallbackImage === 'string' && fallbackImage) {
    const source = staticImagePath({ storage_url: fallbackImage, status: 'available' })
    const previousPath = imagePaths.get(source.filePath)
    if (previousPath && previousPath !== source.bucketPath) {
      throw new Error(`Bir xil statik rasm yo‘li turli storage path’larda bor: ${source.filePath}`)
    }
    imagePaths.set(source.filePath, source.bucketPath)
    fallbackImagePath = source.filePath
  }

  const imageDigests = new Map()
  let completed = 0
  for (const [filePath, bucketPath] of imagePaths) {
    await ensureImage(bucketPath, filePath)
    imageDigests.set(filePath, imageDigest(filePath))
    completed++
    if (completed % 100 === 0 || completed === imagePaths.size) {
      console.log(`Rasmlar tekshirildi: ${completed}/${imagePaths.size}`)
    }
  }

  for (const row of rows) {
    row.images = (row.images || []).map((image) => {
      if (typeof image.storage_path !== 'string') return image
      const filePath = image.storage_path.slice('basa_img/'.length)
      const digest = imageDigests.get(filePath)
      if (!digest) throw new Error(`Rasm versiyasi topilmadi: ${filePath}`)
      return { ...image, storage_path: `${image.storage_path}?v=${digest}` }
    })
  }
  if (fallbackImagePath) {
    const digest = imageDigests.get(fallbackImagePath)
    if (!digest) throw new Error(`Standart rasm versiyasi topilmadi: ${fallbackImagePath}`)
    catalog.settings.no_question_image_url =
      `/basa_img/${fallbackImagePath.split('/').map(encodeURIComponent).join('/')}?v=${digest}`
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
  if (fs.existsSync(versionPath)) {
    const previousVersion = JSON.parse(fs.readFileSync(versionPath, 'utf8'))
    if (
      previousVersion.version === version &&
      typeof previousVersion.publishedAt === 'string' &&
      Number.isFinite(Date.parse(previousVersion.publishedAt))
    ) {
      publishedAt = previousVersion.publishedAt
    }
  }
  fs.writeFileSync(path.join(snapshotsDir, snapshotName), snapshotJson, 'utf8')
  fs.writeFileSync(
    versionPath,
    `${JSON.stringify({ version, snapshot: `snapshots/${snapshotName}`, publishedAt }, null, 2)}\n`,
    'utf8'
  )
  console.log(`Static snapshot tayyor: ${rows.length} savol, ${imagePaths.size} rasm, versiya ${version}`)
}

await main()
