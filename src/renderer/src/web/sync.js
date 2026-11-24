// Savol snapshot’i Vercel statik fayllaridan yuklanib IndexedDB’da saqlanadi.
import * as idb from './db'
import * as engine from './engine'

const SNAPSHOT_VERSION_KEY = 'published_snapshot_version'

const localQuestionId = (row) =>
  row.question_source === 'admin_new'
    ? -Math.abs(Number(row.id))
    : Number(row.id)
const localAnswerId = (row, answer) =>
  row.question_source === 'admin_new'
    ? -Math.abs(Number(answer.id))
    : Number(answer.id)
const isExplicitlyNew = (row) =>
  row.is_new === true ||
  (typeof row.is_new !== 'boolean' && row.question_type === 'admin_new')

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const error = new Error('Sinxronizatsiya bekor qilindi')
  error.name = 'AbortError'
  throw error
}

async function readJsonResponse(response, resourceName) {
  const contentType = response.headers.get('content-type') || ''
  const body = await response.text()
  if (
    /text\/html/i.test(contentType) ||
    /^\s*<(?:!doctype\s+html|html\b)/i.test(body)
  ) {
    throw new Error(
      `${resourceName} o‘rniga HTML sahifa qaytdi. Odatda snapshot hali GitHub’ga ` +
      'nashr qilinmagan yoki Vercel deploy tugamagan bo‘ladi. Nashr muvaffaqiyatli ' +
      'tugagach qayta urinib ko‘ring.'
    )
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(
      `${resourceName} JSON formati noto‘g‘ri (${contentType || 'Content-Type yo‘q'}). ` +
      'GitHub nashri va Vercel deploy holatini tekshiring.'
    )
  }
}

async function fetchSnapshot(signal) {
  const versionUrl = new URL('./data/version.json', window.location.href)
  // Vaqt belgisi: eski service worker yoki oraliq kesh eski versiyani qaytarib yubormasligi uchun.
  versionUrl.searchParams.set('t', String(Date.now()))
  const versionResponse = await fetch(versionUrl, {
    cache: 'no-store',
    signal,
  })
  if (!versionResponse.ok) {
    throw new Error(`Sayt ma’lumotlari versiyasini olib bo‘lmadi (${versionResponse.status}).`)
  }

  const pointer = await readJsonResponse(versionResponse, 'Sayt ma’lumotlari versiya fayli')
  if (
    typeof pointer.version !== 'string' ||
    !/^[a-f0-9]{64}$/.test(pointer.version) ||
    pointer.snapshot !== `snapshots/${pointer.version}.json`
  ) {
    throw new Error('Sayt ma’lumotlari versiya fayli noto‘g‘ri formatda.')
  }
  if (pointer.version === engine.metaGet(SNAPSHOT_VERSION_KEY)) return null

  throwIfAborted(signal)
  const snapshotUrl = new URL(pointer.snapshot, new URL('./data/', window.location.href))
  if (snapshotUrl.origin !== window.location.origin) {
    throw new Error('Snapshot manzili boshqa saytdan yuklanishiga ruxsat yo‘q.')
  }
  const snapshotResponse = await fetch(snapshotUrl, {
    cache: 'force-cache',
    signal,
  })
  if (!snapshotResponse.ok) {
    throw new Error(`Savollar snapshot’ini olib bo‘lmadi (${snapshotResponse.status}).`)
  }

  const snapshot = await readJsonResponse(snapshotResponse, 'Savollar snapshot’i')
  if (
    snapshot.schemaVersion !== 1 ||
    !snapshot.catalog ||
    !Array.isArray(snapshot.catalog.sections) ||
    !Array.isArray(snapshot.catalog.lessons) ||
    !Array.isArray(snapshot.questions) ||
    !Array.isArray(snapshot.lessonQuestionOrder)
  ) {
    throw new Error('Savollar snapshot’i noto‘g‘ri formatda.')
  }
  return { version: pointer.version, snapshot }
}

function localQuestionKey(row) {
  return `${row.question_source === 'admin_new' ? 'admin_new' : 'base'}:${Math.abs(Number(row.id))}`
}

function countChanged(rows) {
  return rows.reduce((count, row) => {
    const local = engine.state.questions.get(localQuestionId(row))?.updated_at
    const changed = row.is_deleted
      ? Boolean(local)
      : !local || local !== row.updated_at
    return count + Number(changed)
  }, 0)
}

export async function refreshBase(onProgress = () => {}, signal) {
  throwIfAborted(signal)
  onProgress({ stage: 'catalog' })
  const published = await fetchSnapshot(signal)
  if (!published) return { skipped: true, fetched: 0, changedQuestions: 0, newQuestions: 0 }

  const { snapshot, version } = published
  const questionOrder = new Map(
    snapshot.lessonQuestionOrder.map((row) => [
      `${row.question_source}:${Math.abs(Number(row.question_id))}`,
      Number(row.sort_order),
    ])
  )
  const rows = snapshot.questions.map((row) => {
    if (row.lesson_id == null || row.lesson_id < 0) return row
    const order = questionOrder.get(localQuestionKey(row))
    return order === undefined ? row : { ...row, sort_order: order }
  })
  const newQuestions = rows.reduce(
    (count, row) =>
      count +
      Number(
        !row.is_deleted &&
          !engine.state.questions.has(localQuestionId(row))
      ),
    0
  )
  const maxSeen = [
    ...snapshot.catalog.sections,
    ...snapshot.catalog.lessons,
    ...(snapshot.catalog.manual_variants || []),
    ...rows,
  ].reduce((latest, row) => {
    if (!row.updated_at || (latest && row.updated_at <= latest)) return latest
    return row.updated_at
  }, null)
  const estimatedBytes = new Blob([JSON.stringify(snapshot)]).size
  onProgress({ stage: 'questions', fetched: rows.length, estimatedBytes })
  throwIfAborted(signal)

  return installSnapshot(
    {
      catalog: snapshot.catalog,
      rows,
      version,
      maxSeen,
      fetched: rows.length,
      newQuestions,
      changedQuestions: countChanged(rows),
      estimatedBytes,
    },
    onProgress
  )
}

function buildQuestion(row, previous) {
  const id = localQuestionId(row)
  const explicit = [row.is_new, row.is_numeric, row.is_similar].every(
    (value) => typeof value === 'boolean'
  )
  const answers = (row.answers || [])
    .map((answer, index) => ({
      id: localAnswerId(row, answer),
      sort_order: answer.sort_order ?? index,
      text: answer.text,
      is_correct: Boolean(answer.is_correct),
    }))
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
  const images = (row.images || []).map((image) => ({
    id: image.id,
    role: image.role,
    path: image.path ?? null,
    status: image.status,
    storage_path: image.storage_path ?? null,
    storage_url: null,
  }))
  const memberships = Array.isArray(row.manual_variant_memberships)
    ? row.manual_variant_memberships.map((membership) => ({
        variant_id: membership.variant_id,
        sort_order: membership.sort_order,
      }))
    : previous?.memberships || []
  return {
    id,
    question_type: row.question_type,
    lesson_id: row.lesson_id ?? -1,
    sort_order: row.sort_order ?? null,
    text: row.text,
    explanation: row.explanation == null ? null : row.explanation,
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_new: isExplicitlyNew(row),
    is_numeric: row.is_numeric === true,
    is_similar: row.is_similar === true,
    explicit,
    answers,
    images,
    memberships,
  }
}

async function installSnapshot(update, onProgress = () => {}) {
  onProgress({ stage: 'apply', fetched: update.fetched })
  const { state } = engine
  const sections = update.catalog.sections.map((section) => ({
    id: section.id,
    sort_order: section.sort_order,
    name: section.name,
    created_at: section.created_at,
    is_deleted: Boolean(section.is_deleted),
  }))
  const lessons = update.catalog.lessons.map((lesson) => ({
    id: lesson.id,
    section_id: lesson.section_id,
    sort_order: lesson.sort_order,
    title: lesson.title,
    created_at: lesson.created_at,
    is_deleted: Boolean(lesson.is_deleted),
  }))
  const variants = (update.catalog.manual_variants || []).map((variant) => ({
    id: variant.id,
    title: variant.title,
    sort_order: variant.sort_order ?? 0,
    is_deleted: Boolean(variant.is_deleted),
    updated_at: variant.updated_at ?? null,
  }))

  const incomingSectionIds = new Set(sections.map((section) => section.id))
  const incomingLessonIds = new Set(lessons.map((lesson) => lesson.id))
  const incomingVariantIds = new Set(variants.map((variant) => variant.id))
  const removedSectionIds = [...state.sections.keys()].filter(
    (id) => id !== -1 && !incomingSectionIds.has(id)
  )
  const removedLessonIds = [...state.lessons.keys()].filter(
    (id) => id !== -1 && !incomingLessonIds.has(id)
  )
  const removedVariantIds = [...state.variants.keys()].filter(
    (id) => !incomingVariantIds.has(id)
  )
  for (const id of state.sections.keys()) {
    if (id !== -1 && !incomingSectionIds.has(id)) state.sections.delete(id)
  }
  for (const id of state.lessons.keys()) {
    if (id !== -1 && !incomingLessonIds.has(id)) state.lessons.delete(id)
  }
  for (const id of state.variants.keys()) {
    if (!incomingVariantIds.has(id)) state.variants.delete(id)
  }
  sections.forEach((section) => state.sections.set(section.id, section))
  lessons.forEach((lesson) => state.lessons.set(lesson.id, lesson))
  variants.forEach((variant) => state.variants.set(variant.id, variant))
  await idb.putMany('sections', sections)
  await idb.putMany('lessons', lessons)
  await idb.putMany('variants', variants)
  await idb.removeMany('sections', removedSectionIds)
  await idb.removeMany('lessons', removedLessonIds)
  await idb.removeMany('variants', removedVariantIds)
  if (update.catalog.settings) await engine.saveSettings(update.catalog.settings)

  const incomingQuestionIds = new Set(
    update.rows.filter((row) => !row.is_deleted).map(localQuestionId)
  )
  const toPut = []
  const toRemove = new Set()
  for (const id of state.questions.keys()) {
    if (!incomingQuestionIds.has(id)) {
      state.questions.delete(id)
      toRemove.add(id)
    }
  }
  for (const row of update.rows) {
    const id = localQuestionId(row)
    if (row.is_deleted) {
      state.questions.delete(id)
      toRemove.add(id)
      continue
    }
    const question = buildQuestion(row, state.questions.get(id))
    state.questions.set(id, question)
    toPut.push(question)
  }

  const removedLessonIdSet = new Set(removedLessonIds)
  for (const [id, question] of state.questions) {
    if (!removedLessonIdSet.has(question.lesson_id)) continue
    const detachedQuestion = { ...question, lesson_id: -1 }
    state.questions.set(id, detachedQuestion)
    toPut.push(detachedQuestion)
  }

  await idb.putMany('questions', toPut)
  await idb.removeMany('questions', [...toRemove])
  engine.invalidate()
  if (update.maxSeen) await engine.metaSet('base_last_updated_at', update.maxSeen)
  if (Array.isArray(update.catalog.manual_variants)) {
    await engine.metaSet('admin_sync_schema_v1', '1')
  }
  await engine.metaSet(SNAPSHOT_VERSION_KEY, update.version)
  await engine.metaSet('last_synced_at', new Date().toISOString())
  return {
    fetched: update.fetched,
    newQuestions: update.newQuestions,
    changedQuestions: update.changedQuestions,
    estimatedBytes: update.estimatedBytes,
  }
}
