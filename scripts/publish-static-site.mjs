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
  // Supabase ombori yo‘li: basa_img/<sha256>.png. Repoda esa fayl public/basa_img/<sha256>.png
  // bo‘lishi kerak (sayt URL: /basa_img/<sha256>.png), shuning uchun bosh "basa_img/" olib tashlanadi.
  const filePath = pathParts[0] === 'basa_img' && pathParts.length > 1
    ? pathParts.slice(1).join('/')
    : normalizedPath
  return { bucketPath: normalizedPath, filePath }
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

class MissingRemoteImageError extends Error {}

function isNotFound(error) {
  const text = `${error?.message || ''} ${error?.statusCode || ''} ${error?.status || ''}`
  return /not.?found|404|does not exist/i.test(text)
}

async function ensureImage(bucketPath, filePath) {
  const destination = path.join(imageDir, ...filePath.split('/'))
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return

  let lastError = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { data, error } = await supabase.storage.from(bucketName).download(bucketPath)
    if (!error && data) {
      const bytes = Buffer.from(await data.arrayBuffer())
      if (bytes.length === 0) {
        lastError = new Error('fayl bo‘sh')
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.writeFileSync(destination, bytes)
        return
      }
    } else {
      lastError = error || new Error('javob bo‘sh')
      if (isNotFound(lastError)) {
        throw new MissingRemoteImageError(`Rasm Supabase omborida yo‘q: ${bucketPath}`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
  }
  throw new Error(`Rasmni Supabase’dan yuklab bo‘lmadi (${bucketPath}): ${lastError?.message || 'noma’lum xato'}`)
}

async function runPool(items, limit, worker) {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

function listFiles(directory, base = directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    return entry.isDirectory()
      ? listFiles(full, base)
      : [path.relative(base, full).replaceAll('\\', '/')]
  })
}

function removeEmptyDirectories(directory, keepRoot = true) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name), false)
  }
  if (!keepRoot && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
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
  const warnings = []
  const imagePaths = new Map()
  let fallbackImagePath = null

  const missingImage = (image) => ({
    ...image,
    status: 'missing',
    storage_path: null,
    storage_url: null,
  })

  for (const row of rows) {
    row.images = (row.images || []).map((image) => {
      let source
      try {
        source = staticImagePath(image)
      } catch (error) {
        warnings.push(`Savol ${row.id}: ${error.message}`)
        return missingImage(image)
      }
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
    try {
      const source = staticImagePath({ storage_url: fallbackImage, status: 'available' })
      const previousPath = imagePaths.get(source.filePath)
      if (previousPath && previousPath !== source.bucketPath) {
        throw new Error(`Bir xil statik rasm yo‘li turli storage path’larda bor: ${source.filePath}`)
      }
      imagePaths.set(source.filePath, source.bucketPath)
      fallbackImagePath = source.filePath
    } catch (error) {
      warnings.push(`Standart rasm: ${error.message}`)
      delete catalog.settings.no_question_image_url
    }
  }

  const imageDigests = new Map()
  const missingFiles = new Set()
  const entries = [...imagePaths]
  let completed = 0
  await runPool(entries, 6, async ([filePath, bucketPath]) => {
    try {
      await ensureImage(bucketPath, filePath)
      imageDigests.set(filePath, imageDigest(filePath))
    } catch (error) {
      if (!(error instanceof MissingRemoteImageError)) throw error
      warnings.push(error.message)
      missingFiles.add(filePath)
    }
    completed++
    if (completed % 100 === 0 || completed === entries.length) {
      console.log(`Rasmlar tekshirildi: ${completed}/${entries.length}`)
    }
  })

  for (const row of rows) {
    row.images = (row.images || []).map((image) => {
      if (typeof image.storage_path !== 'string') return image
      const filePath = image.storage_path.slice('basa_img/'.length)
      if (missingFiles.has(filePath)) return missingImage(image)
      const digest = imageDigests.get(filePath)
      if (!digest) throw new Error(`Rasm versiyasi topilmadi: ${filePath}`)
      return { ...image, storage_path: `${image.storage_path}?v=${digest}` }
    })
  }
  if (fallbackImagePath) {
    const digest = imageDigests.get(fallbackImagePath)
    if (!digest) {
      delete catalog.settings.no_question_image_url
    } else {
      catalog.settings.no_question_image_url =
        `/basa_img/${fallbackImagePath.split('/').map(encodeURIComponent).join('/')}?v=${digest}`
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

  // Endi hech bir savolga bog‘lanmagan rasmlar repodan olib tashlanadi.
  // Himoya: ma’lumot bo‘sh kelsa hech narsa o‘chirilmaydi.
  let pruned = 0
  if (rows.length > 0 && imagePaths.size > 0) {
    const keep = new Set(
      [...imagePaths.keys()].filter((filePath) => !missingFiles.has(filePath))
    )
    for (const filePath of listFiles(imageDir)) {
      if (!keep.has(filePath)) {
        fs.rmSync(path.join(imageDir, ...filePath.split('/')))
        pruned++
      }
    }
    removeEmptyDirectories(imageDir)
  }

  for (const warning of warnings) console.warn(`OGOHLANTIRISH: ${warning}`)
  console.log(
    `Static snapshot tayyor: ${rows.length} savol, ${imagePaths.size - missingFiles.size} rasm, ` +
    `${pruned} eski rasm tozalandi, ${warnings.length} ogohlantirish, versiya ${version}`
  )
}

await main()
