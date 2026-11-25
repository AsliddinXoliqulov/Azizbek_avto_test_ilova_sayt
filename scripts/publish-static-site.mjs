import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import {
  applySnapshotDelta,
  createSnapshotDelta,
  jsonHash,
  shouldWriteFullBaseline,
  snapshotHash,
  snapshotText,
  stableStringify,
} from './snapshot-delta.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const publicDir = path.join(root, 'public')
const dataDir = path.join(publicDir, 'data')
const snapshotsDir = path.join(dataDir, 'snapshots')
const deltasDir = path.join(dataDir, 'deltas')
const imagesDir = path.join(dataDir, 'images')
const pageSize = 500
const bucketName = 'pdd-images'
const storagePublicMarker = `/storage/v1/object/public/${bucketName}/`
const maxImageBytes = 100_000_000
const imageExtensions = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpg', '.png', '.tif', '.webp'])
const mimeExtensions = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpg': '.jpg',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tif',
  'image/vnd.microsoft.icon': '.ico',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const supabaseUrl = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const publishMode = process.env.PUBLISH_MODE || 'changes'
if (publishMode !== 'full' && publishMode !== 'changes') {
  throw new Error('PUBLISH_MODE "full" yoki "changes" bo‘lishi kerak.')
}

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

function imageStoragePath(image) {
  if (image.status === 'missing' || image.status === 'missing_remote') return null
  const bucketPath = image.storage_path || storagePathFromUrl(image.storage_url)
  if (!bucketPath) {
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
  return normalizedPath
}

function imageExtension(contentType, sourcePath) {
  const mimeType = String(contentType || '').split(';', 1)[0].trim().toLowerCase()
  if (mimeType && !mimeType.startsWith('image/') && mimeType !== 'application/octet-stream') {
    throw new Error(`Storage fayli rasm emas (${mimeType}): ${sourcePath}`)
  }
  const sourceExtension = path.extname(sourcePath).toLowerCase()
  const extension = mimeExtensions[mimeType] ||
    (sourceExtension === '.jpeg'
      ? '.jpg'
      : imageExtensions.has(sourceExtension)
        ? sourceExtension
        : null)
  if (!extension) throw new Error(`Rasm formatini aniqlab bo‘lmadi: ${sourcePath}`)
  return extension
}

async function downloadImage(sourcePath) {
  const { data, error } = await supabase.storage.from(bucketName).download(sourcePath)
  if (error) throw new Error(`Rasmni Supabase Storage’dan olishda xatolik (${sourcePath}): ${error.message}`)
  if (!data) throw new Error(`Supabase Storage rasm qaytarmadi: ${sourcePath}`)

  const bytes = Buffer.from(await data.arrayBuffer())
  if (!bytes.length) throw new Error(`Supabase Storage’dagi rasm bo‘sh: ${sourcePath}`)
  if (bytes.length >= maxImageBytes) {
    throw new Error(`Rasm GitHub’ning 100 MB fayl cheklovidan oshdi: ${sourcePath}`)
  }

  const extension = imageExtension(data.type, sourcePath)
  const digest = sha256(bytes)
  const assetPath = `images/${digest}${extension}`
  const filePath = path.join(imagesDir, `${digest}${extension}`)
  fs.mkdirSync(imagesDir, { recursive: true })
  const alreadyValid =
    fs.existsSync(filePath) &&
    sha256(fs.readFileSync(filePath)) === digest
  if (!alreadyValid) fs.writeFileSync(filePath, bytes)
  return {
    path: assetPath,
    storagePath: `/data/${assetPath}`,
    bytes: bytes.length,
  }
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length)
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = nextIndex++
        if (index >= items.length) return
        results[index] = await callback(items[index])
      }
    })
  )
  return results
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

function readDataFile(relativePath, pattern) {
  if (typeof relativePath !== 'string' || !pattern.test(relativePath)) {
    throw new Error(`Sayt ma’lumotlari fayl yo‘li noto‘g‘ri: ${relativePath}`)
  }
  return fs.readFileSync(path.join(dataDir, ...relativePath.split('/')), 'utf8')
}

function readFullSnapshot(relativePath, version) {
  const text = readDataFile(relativePath, /^snapshots\/[a-f0-9]{64}\.json$/)
  if (sha256(text) !== version) {
    throw new Error(`To‘liq snapshot checksum mos kelmadi: ${version}`)
  }
  const snapshot = JSON.parse(text)
  if (
    snapshot?.schemaVersion !== 1 ||
    !snapshot.catalog ||
    !Array.isArray(snapshot.questions) ||
    !Array.isArray(snapshot.lessonQuestionOrder)
  ) {
    throw new Error(`To‘liq snapshot formati noto‘g‘ri: ${version}`)
  }
  return snapshot
}

function readCurrentSnapshot() {
  const versionPath = path.join(dataDir, 'version.json')
  if (!fs.existsSync(versionPath)) return null
  const pointer = JSON.parse(fs.readFileSync(versionPath, 'utf8'))

  if (pointer.schemaVersion !== 2) {
    if (
      typeof pointer.version !== 'string' ||
      pointer.snapshot !== `snapshots/${pointer.version}.json`
    ) {
      throw new Error('Joriy sayt ma’lumotlari versiyasi noto‘g‘ri formatda.')
    }
    return {
      version: pointer.version,
      snapshot: readFullSnapshot(pointer.snapshot, pointer.version),
      baseline: { version: pointer.version, snapshot: pointer.snapshot },
      deltas: [],
      imageAssets: [],
      publishedAt: pointer.publishedAt,
      incrementalReady: false,
    }
  }

  const baseline = pointer.baseline
  if (
    typeof pointer.version !== 'string' ||
    !/^[a-f0-9]{64}$/.test(pointer.version) ||
    !baseline ||
    typeof baseline.version !== 'string' ||
    baseline.snapshot !== `snapshots/${baseline.version}.json` ||
    !Array.isArray(pointer.deltas)
  ) {
    throw new Error('Incremental sayt ma’lumotlari versiyasi noto‘g‘ri formatda.')
  }

  let version = baseline.version
  let snapshot = readFullSnapshot(baseline.snapshot, baseline.version)
  for (const descriptor of pointer.deltas) {
    if (
      descriptor.fromVersion !== version ||
      typeof descriptor.version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(descriptor.version) ||
      typeof descriptor.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256)
    ) {
      throw new Error('Incremental delta ketma-ketligi noto‘g‘ri.')
    }
    const text = readDataFile(descriptor.path, /^deltas\/[a-f0-9]{64}\.json$/)
    if (sha256(text) !== descriptor.sha256) {
      throw new Error(`Incremental delta checksum mos kelmadi: ${descriptor.version}`)
    }
    const delta = JSON.parse(text)
    if (delta.fromVersion !== version || delta.toVersion !== descriptor.version) {
      throw new Error(`Incremental delta versiyalari mos kelmadi: ${descriptor.version}`)
    }
    snapshot = applySnapshotDelta(snapshot, delta)
    version = snapshotHash(snapshot)
    if (version !== descriptor.version) {
      throw new Error(`Incremental snapshot checksum mos kelmadi: ${descriptor.version}`)
    }
  }
  if (version !== pointer.version) {
    throw new Error('Joriy incremental versiya zanjir bilan mos kelmadi.')
  }
  if (pointer.imageAssets !== undefined && !Array.isArray(pointer.imageAssets)) {
    throw new Error('Joriy rasm fayllari ro‘yxati noto‘g‘ri formatda.')
  }
  const imageAssets = pointer.imageAssets || []
  for (const asset of imageAssets) {
    if (
      typeof asset.path !== 'string' ||
      !/^images\/[a-f0-9]{64}\.(?:avif|bmp|gif|ico|jpg|png|tif|webp)$/.test(asset.path) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes >= maxImageBytes
    ) {
      throw new Error('Joriy rasm fayllari ro‘yxatida noto‘g‘ri yozuv bor.')
    }
  }
  return {
    version,
    snapshot,
    baseline,
    deltas: pointer.deltas,
    imageAssets,
    publishedAt: pointer.publishedAt,
    incrementalReady: Array.isArray(pointer.imageAssets),
  }
}

function pruneDataFiles(directory, keep) {
  if (!fs.existsSync(directory)) return
  for (const name of fs.readdirSync(directory)) {
    if (name.endsWith('.json') && !keep.has(name)) {
      fs.rmSync(path.join(directory, name))
    }
  }
}

function pruneImageFiles(keep) {
  if (!fs.existsSync(imagesDir)) return
  for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^[a-f0-9]{64}\.(?:avif|bmp|gif|ico|jpg|png|tif|webp)$/.test(entry.name) &&
      !keep.has(entry.name)
    ) {
      fs.rmSync(path.join(imagesDir, entry.name))
    }
  }
}

async function main() {
  const publishStartedAt = new Date().toISOString()
  fs.mkdirSync(snapshotsDir, { recursive: true })
  const current = readCurrentSnapshot()

  const [catalog, rows, lessonQuestionOrder] = await Promise.all([
    fetchCatalog(),
    fetchAllQuestions(),
    fetchLessonQuestionOrder(),
  ])
  const imageSourcePaths = new Set()
  const imagePathFor = (image) => imageStoragePath(image)
  for (const row of rows) {
    for (const image of row.images || []) {
      const sourcePath = imagePathFor(image)
      if (sourcePath) imageSourcePaths.add(sourcePath)
    }
  }
  const fallbackImage = catalog.settings?.no_question_image_url
  const fallbackImageSourcePath =
    typeof fallbackImage === 'string' && fallbackImage
      ? imagePathFor({
        storage_url: fallbackImage,
        status: 'available',
      })
      : null
  if (fallbackImageSourcePath) imageSourcePaths.add(fallbackImageSourcePath)

  const imagePaths = [...imageSourcePaths]
  const downloadedImages = new Map(
    (await mapWithConcurrency(imagePaths, 6, async (sourcePath) => [
      sourcePath,
      await downloadImage(sourcePath),
    ])).map(([sourcePath, asset]) => [sourcePath, asset])
  )

  for (const row of rows) {
    row.images = (row.images || []).map((image) => {
      const sourcePath = imagePathFor(image)
      if (!sourcePath) return { ...image, storage_path: null, storage_url: null }
      const asset = downloadedImages.get(sourcePath)
      return {
        ...image,
        status: 'available',
        storage_path: asset.storagePath,
        storage_url: null,
      }
    })
  }
  if (fallbackImageSourcePath) {
    catalog.settings.no_question_image_url =
      downloadedImages.get(fallbackImageSourcePath).storagePath
  }

  const previousImagePaths = new Set(
    current?.incrementalReady ? current.imageAssets.map((asset) => asset.path) : []
  )
  let newImageBytes = 0
  const imageAssetMap = new Map()
  for (const asset of new Map(
    [...downloadedImages.values()].map((item) => [item.path, item])
  ).values()) {
    imageAssetMap.set(asset.path, { path: asset.path, bytes: asset.bytes })
    if (!previousImagePaths.has(asset.path)) newImageBytes += asset.bytes
  }
  const imageAssets = [...imageAssetMap.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )

  const snapshot = {
    schemaVersion: 1,
    catalog,
    questions: rows,
    lessonQuestionOrder,
  }
  const version = snapshotHash(snapshot)
  const expectedVersion = process.env.EXPECTED_SNAPSHOT_VERSION
  if (expectedVersion && expectedVersion !== version) {
    throw new Error(
      'Taqqoslashdan keyin Supabase ma’lumotlari o‘zgargan. Avval qayta solishtiring.'
    )
  }
  const versionPath = path.join(dataDir, 'version.json')
  const writeFullBaseline = shouldWriteFullBaseline(publishMode, current)
  if (
    !writeFullBaseline &&
    current?.incrementalReady &&
    stableStringify(current.snapshot) === stableStringify(snapshot)
  ) {
    pruneImageFiles(new Set(imageAssets.map((asset) => path.basename(asset.path))))
    console.log(`Static snapshot allaqachon yangilangan: ${current.version}`)
    return
  }

  let payloadBytes
  if (writeFullBaseline) {
    const snapshotName = `${version}.json`
    const snapshotJson = snapshotText(snapshot)
    fs.writeFileSync(path.join(snapshotsDir, snapshotName), snapshotJson, 'utf8')
    fs.writeFileSync(
      versionPath,
      `${JSON.stringify({
        schemaVersion: 2,
        version,
        baseline: {
          version,
          snapshot: `snapshots/${snapshotName}`,
        },
        deltas: [],
        imageAssets,
        publishedAt: publishStartedAt,
      }, null, 2)}\n`,
      'utf8'
    )
    pruneDataFiles(snapshotsDir, new Set([snapshotName]))
    pruneDataFiles(deltasDir, new Set())
    payloadBytes = Buffer.byteLength(snapshotJson, 'utf8') + newImageBytes
  } else {
    const delta = createSnapshotDelta(current.snapshot, snapshot, current.version, version)
    const deltaText = `${stableStringify(delta)}\n`
    const deltaDigest = jsonHash(delta)
    const deltaPath = `deltas/${deltaDigest}.json`
    fs.mkdirSync(deltasDir, { recursive: true })
    fs.writeFileSync(path.join(deltasDir, `${deltaDigest}.json`), deltaText, 'utf8')

    const baseline = current.baseline
    const deltas = [
      ...current.deltas,
      {
        fromVersion: current.version,
        version,
        path: deltaPath,
        sha256: sha256(deltaText),
      },
    ]
    fs.writeFileSync(
      versionPath,
      `${JSON.stringify({
        schemaVersion: 2,
        version,
        baseline,
        deltas,
        imageAssets,
        publishedAt: publishStartedAt,
      }, null, 2)}\n`,
      'utf8'
    )

    const keepSnapshots = new Set([path.basename(baseline.snapshot)])
    const keepDeltas = new Set(deltas.map((item) => path.basename(item.path)))
    pruneDataFiles(snapshotsDir, keepSnapshots)
    pruneDataFiles(deltasDir, keepDeltas)
    payloadBytes = Buffer.byteLength(deltaText, 'utf8') + newImageBytes
  }

  pruneImageFiles(new Set(imageAssets.map((asset) => path.basename(asset.path))))
  console.log(
    `Static ${writeFullBaseline ? 'to‘liq bazaviy snapshot' : 'delta'} tayyor: ${rows.length} savol; ` +
    `${payloadBytes} bayt jami (${newImageBytes} bayt yangi rasm), ` +
    `versiya ${version}`
  )
}

await main()
