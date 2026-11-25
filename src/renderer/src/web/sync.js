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

async function readJsonResponseWithText(response, resourceName) {
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
    return { value: JSON.parse(body), text: body }
  } catch {
    throw new Error(
      `${resourceName} JSON formati noto‘g‘ri (${contentType || 'Content-Type yo‘q'}). ` +
      'GitHub nashri va Vercel deploy holatini tekshiring.'
    )
  }
}

async function readJsonResponse(response, resourceName) {
  return (await readJsonResponseWithText(response, resourceName)).value
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Delta fayllarini tekshirish uchun Web Crypto mavjud emas.')
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function isValidSnapshot(snapshot) {
  return Boolean(
    snapshot &&
      snapshot.schemaVersion === 1 &&
      snapshot.catalog &&
      Array.isArray(snapshot.catalog.sections) &&
      Array.isArray(snapshot.catalog.lessons) &&
      Array.isArray(snapshot.questions) &&
      Array.isArray(snapshot.lessonQuestionOrder)
  )
}

async function fetchDataJson(filePath, resourceName, signal) {
  if (!/^(snapshots|deltas)\/[a-f0-9]{64}\.json$/.test(filePath)) {
    throw new Error(`${resourceName} manzili noto‘g‘ri.`)
  }
  const url = new URL(filePath, new URL('./data/', window.location.href))
  if (url.origin !== window.location.origin) {
    throw new Error(`${resourceName} boshqa saytdan yuklanishiga ruxsat yo‘q.`)
  }
  const response = await fetch(url, { cache: 'force-cache', signal })
  if (!response.ok) {
    throw new Error(`${resourceName} olib bo‘lmadi (${response.status}).`)
  }
  return readJsonResponseWithText(response, resourceName)
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
  if (typeof pointer.version !== 'string' || !/^[a-f0-9]{64}$/.test(pointer.version)) {
    throw new Error('Sayt ma’lumotlari versiya fayli noto‘g‘ri formatda.')
  }
  if (pointer.version === engine.metaGet(SNAPSHOT_VERSION_KEY)) return null

  if (pointer.schemaVersion !== 2) {
    if (pointer.snapshot !== `snapshots/${pointer.version}.json`) {
      throw new Error('Sayt ma’lumotlari snapshot manzili noto‘g‘ri.')
    }
    throwIfAborted(signal)
    const full = await fetchDataJson(pointer.snapshot, 'Savollar snapshot’i', signal)
    if (!isValidSnapshot(full.value) || await sha256(full.text) !== pointer.version) {
      throw new Error('Savollar snapshot formati yoki checksum noto‘g‘ri.')
    }
    return { full: { version: pointer.version, snapshot: full.value }, deltas: [] }
  }

  const baseline = pointer.baseline
  if (
    !baseline ||
    typeof baseline.version !== 'string' ||
    !/^[a-f0-9]{64}$/.test(baseline.version) ||
    baseline.snapshot !== `snapshots/${baseline.version}.json` ||
    !Array.isArray(pointer.deltas)
  ) {
    throw new Error('Incremental sayt ma’lumotlari versiya fayli noto‘g‘ri formatda.')
  }

  let chainVersion = baseline.version
  for (const descriptor of pointer.deltas) {
    if (
      descriptor.fromVersion !== chainVersion ||
      typeof descriptor.version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(descriptor.version) ||
      typeof descriptor.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      typeof descriptor.path !== 'string' ||
      !/^deltas\/[a-f0-9]{64}\.json$/.test(descriptor.path)
    ) {
      throw new Error('Incremental delta zanjiri noto‘g‘ri formatda.')
    }
    chainVersion = descriptor.version
  }
  if (chainVersion !== pointer.version) {
    throw new Error('Incremental delta zanjiri joriy versiyaga yetib bormadi.')
  }

  const localVersion = engine.metaGet(SNAPSHOT_VERSION_KEY)
  if (localVersion === pointer.version) return null
  let full = null
  let startIndex = 0
  if (localVersion === baseline.version) {
    startIndex = 0
  } else {
    const localDeltaIndex = pointer.deltas.findIndex(
      (descriptor) => descriptor.version === localVersion
    )
    if (localDeltaIndex >= 0) {
      startIndex = localDeltaIndex + 1
    } else {
      throwIfAborted(signal)
      const baselineFile = await fetchDataJson(
        baseline.snapshot,
        'Boshlang‘ich snapshot',
        signal
      )
      if (
        !isValidSnapshot(baselineFile.value) ||
        await sha256(baselineFile.text) !== baseline.version
      ) {
        throw new Error('Boshlang‘ich snapshot formati yoki checksum noto‘g‘ri.')
      }
      full = { version: baseline.version, snapshot: baselineFile.value }
    }
  }

  const deltas = []
  let expectedFrom = full ? baseline.version : localVersion
  for (const descriptor of pointer.deltas.slice(startIndex)) {
    throwIfAborted(signal)
    if (descriptor.fromVersion !== expectedFrom) {
      throw new Error('Delta oldingi qurilma versiyasiga ulanmagan.')
    }
    const file = await fetchDataJson(descriptor.path, 'Savollar delta fayli', signal)
    if (await sha256(file.text) !== descriptor.sha256) {
      throw new Error('Savollar delta checksum bilan mos kelmadi.')
    }
    const delta = file.value
    if (
      delta?.schemaVersion !== 1 ||
      delta.fromVersion !== descriptor.fromVersion ||
      delta.toVersion !== descriptor.version
    ) {
      throw new Error('Savollar delta tarkibi versiya fayliga mos kelmadi.')
    }
    deltas.push({
      version: descriptor.version,
      delta,
      estimatedBytes: new Blob([file.text]).size,
    })
    expectedFrom = descriptor.version
  }
  if (expectedFrom !== pointer.version) {
    throw new Error('Yuklangan delta’lar joriy versiyaga yetib bormadi.')
  }
  return { full, deltas }
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

  let fetched = 0
  let changedQuestions = 0
  let newQuestions = 0
  let estimatedBytes = 0
  if (published.full) {
    const result = await installFullSnapshot(
      published.full.snapshot,
      published.full.version,
      onProgress,
      signal
    )
    fetched += result.fetched
    changedQuestions += result.changedQuestions
    newQuestions += result.newQuestions
    estimatedBytes += result.estimatedBytes
  }
  for (const item of published.deltas) {
    throwIfAborted(signal)
    const result = await installDelta(item.delta, item.version, item.estimatedBytes, onProgress)
    fetched += result.fetched
    changedQuestions += result.changedQuestions
    newQuestions += result.newQuestions
    estimatedBytes += result.estimatedBytes
  }
  return { fetched, changedQuestions, newQuestions, estimatedBytes }
}

async function installFullSnapshot(snapshot, version, onProgress, signal) {
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

function localQuestionIdFromKey(key) {
  const separator = key.indexOf(':')
  if (separator <= 0) throw new Error('Delta savol ID kaliti noto‘g‘ri.')
  const source = key.slice(0, separator)
  const id = Number(key.slice(separator + 1))
  if (!Number.isSafeInteger(id) || !['base', 'admin_new'].includes(source)) {
    throw new Error('Delta savol ID kaliti noto‘g‘ri.')
  }
  return source === 'admin_new' ? -Math.abs(id) : id
}

function deltaQuestionKey(row) {
  return `${row.question_source || 'base'}:${Math.abs(Number(row.id))}`
}

async function installDelta(delta, version, estimatedBytes, onProgress) {
  onProgress({ stage: 'apply', fetched: delta.questions.upsert.length })
  const { state } = engine
  const sectionRows = delta.catalog.sections.upsert.map((section) => ({
    id: section.id,
    sort_order: section.sort_order,
    name: section.name,
    created_at: section.created_at,
    is_deleted: Boolean(section.is_deleted),
  }))
  const lessonRows = delta.catalog.lessons.upsert.map((lesson) => ({
    id: lesson.id,
    section_id: lesson.section_id,
    sort_order: lesson.sort_order,
    title: lesson.title,
    created_at: lesson.created_at,
    is_deleted: Boolean(lesson.is_deleted),
  }))
  const variantRows = delta.catalog.manual_variants.upsert.map((variant) => ({
    id: variant.id,
    title: variant.title,
    sort_order: variant.sort_order ?? 0,
    is_deleted: Boolean(variant.is_deleted),
    updated_at: variant.updated_at ?? null,
  }))
  const removedSectionIds = delta.catalog.sections.remove.map(Number)
  const removedLessonIds = delta.catalog.lessons.remove.map(Number)
  const removedVariantIds = delta.catalog.manual_variants.remove.map(Number)

  for (const id of removedSectionIds) state.sections.delete(id)
  for (const id of removedLessonIds) state.lessons.delete(id)
  for (const id of removedVariantIds) state.variants.delete(id)
  sectionRows.forEach((section) => state.sections.set(section.id, section))
  lessonRows.forEach((lesson) => state.lessons.set(lesson.id, lesson))
  variantRows.forEach((variant) => state.variants.set(variant.id, variant))
  await idb.putMany('sections', sectionRows)
  await idb.putMany('lessons', lessonRows)
  await idb.putMany('variants', variantRows)
  await idb.removeMany('sections', removedSectionIds)
  await idb.removeMany('lessons', removedLessonIds)
  await idb.removeMany('variants', removedVariantIds)
  if (delta.catalog.settingsChanged) {
    await engine.saveSettings(delta.catalog.settings)
  }

  const questionOrders = new Map(
    delta.lessonQuestionOrder.upsert.map((row) => [
      `${row.question_source}:${Math.abs(Number(row.question_id))}`,
      row,
    ])
  )
  const changedQuestionKeys = new Set()
  const toPut = new Map()
  const toRemove = new Set()
  let newQuestions = 0
  let changedQuestions = 0
  for (const key of delta.questions.remove) {
    const id = localQuestionIdFromKey(key)
    state.questions.delete(id)
    toRemove.add(id)
    changedQuestionKeys.add(key)
    changedQuestions++
  }
  for (const row of delta.questions.upsert) {
    const id = localQuestionId(row)
    const key = deltaQuestionKey(row)
    changedQuestionKeys.add(key)
    const previous = state.questions.get(id)
    if (row.is_deleted) {
      state.questions.delete(id)
      toRemove.add(id)
      if (previous) changedQuestions++
      continue
    }

    const order = questionOrders.get(key)
    const normalizedRow = order
      ? { ...row, lesson_id: order.lesson_id, sort_order: order.sort_order }
      : previous && previous.lesson_id === row.lesson_id
        ? { ...row, sort_order: previous.sort_order }
        : row
    const question = buildQuestion(normalizedRow, previous)
    state.questions.set(id, question)
    toPut.set(id, question)
    if (previous) changedQuestions++
    else newQuestions++
  }

  for (const order of delta.lessonQuestionOrder.upsert) {
    const key = `${order.question_source}:${Math.abs(Number(order.question_id))}`
    if (changedQuestionKeys.has(key)) continue
    const id = localQuestionId({
      id: order.question_id,
      question_source: order.question_source,
    })
    const previous = state.questions.get(id)
    if (!previous) continue
    const question = {
      ...previous,
      lesson_id: order.lesson_id,
      sort_order: order.sort_order,
    }
    state.questions.set(id, question)
    toPut.set(id, question)
    changedQuestions++
  }

  const removedLessonIdSet = new Set(removedLessonIds)
  for (const [id, question] of state.questions) {
    if (!removedLessonIdSet.has(question.lesson_id)) continue
    const detachedQuestion = { ...question, lesson_id: -1 }
    state.questions.set(id, detachedQuestion)
    toPut.set(id, detachedQuestion)
  }

  await idb.putMany('questions', [...toPut.values()])
  await idb.removeMany('questions', [...toRemove])
  engine.invalidate()
  const latestUpdatedAt = [
    ...delta.catalog.sections.upsert,
    ...delta.catalog.lessons.upsert,
    ...delta.catalog.manual_variants.upsert,
    ...delta.questions.upsert,
  ].reduce((latest, row) => {
    if (!row.updated_at || (latest && row.updated_at <= latest)) return latest
    return row.updated_at
  }, engine.metaGet('base_last_updated_at'))
  if (latestUpdatedAt) await engine.metaSet('base_last_updated_at', latestUpdatedAt)
  await engine.metaSet('admin_sync_schema_v1', '1')
  await engine.metaSet(SNAPSHOT_VERSION_KEY, version)
  await engine.metaSet('last_synced_at', new Date().toISOString())
  return {
    fetched: delta.questions.upsert.length + delta.questions.remove.length,
    newQuestions,
    changedQuestions,
    estimatedBytes,
  }
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
