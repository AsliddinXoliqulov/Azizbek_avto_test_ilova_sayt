import { createHash } from 'node:crypto'

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

export function snapshotText(snapshot) {
  return `${stableStringify(snapshot)}\n`
}

export function snapshotHash(snapshot) {
  return createHash('sha256').update(snapshotText(snapshot)).digest('hex')
}

export function jsonHash(value) {
  return createHash('sha256').update(`${stableStringify(value)}\n`).digest('hex')
}

export function shouldWriteFullBaseline(publishMode, current) {
  return publishMode === 'full' || !current?.incrementalReady
}

function recordDelta(before, after, keyOf) {
  const previous = new Map((before || []).map((record) => [keyOf(record), record]))
  const current = new Map((after || []).map((record) => [keyOf(record), record]))
  const upsert = []
  const remove = []

  for (const [key, record] of current) {
    if (stableStringify(previous.get(key)) !== stableStringify(record)) {
      upsert.push(record)
    }
  }
  for (const key of previous.keys()) {
    if (!current.has(key)) remove.push(key)
  }
  return { upsert, remove }
}

export function createSnapshotDelta(before, after, fromVersion, toVersion) {
  const settingsChanged =
    stableStringify(before.catalog.settings || {}) !==
    stableStringify(after.catalog.settings || {})
  return {
    schemaVersion: 1,
    fromVersion,
    toVersion,
    catalog: {
      sections: recordDelta(before.catalog.sections, after.catalog.sections, (row) => String(row.id)),
      lessons: recordDelta(before.catalog.lessons, after.catalog.lessons, (row) => String(row.id)),
      manual_variants: recordDelta(
        before.catalog.manual_variants,
        after.catalog.manual_variants,
        (row) => String(row.id)
      ),
      settingsChanged,
      ...(settingsChanged ? { settings: after.catalog.settings || {} } : {}),
    },
    questions: recordDelta(
      before.questions,
      after.questions,
      (row) => `${row.question_source || 'base'}:${row.id}`
    ),
    lessonQuestionOrder: recordDelta(
      before.lessonQuestionOrder,
      after.lessonQuestionOrder,
      (row) => `${row.question_source}:${row.question_id}`
    ),
  }
}

function numberCompare(left, right) {
  return Number(left) - Number(right)
}

function textCompare(left, right) {
  const a = String(left)
  const b = String(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function timestampCompare(left, right) {
  const millisecondDifference = Date.parse(left) - Date.parse(right)
  if (millisecondDifference) return millisecondDifference
  const fraction = (value) => {
    const digits = String(value).match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] || ''
    return digits.slice(0, 6).padEnd(6, '0')
  }
  return textCompare(fraction(left), fraction(right))
}

function sortRecords(records, compare) {
  return [...records].sort(compare)
}

function mergeRecords(previous, patch, keyOf, compare) {
  if (
    !patch ||
    !Array.isArray(patch.upsert) ||
    !Array.isArray(patch.remove)
  ) {
    throw new Error('Delta yozuvlari noto‘g‘ri formatda.')
  }
  const records = new Map((previous || []).map((record) => [keyOf(record), record]))
  for (const key of patch.remove) records.delete(String(key))
  for (const record of patch.upsert) records.set(keyOf(record), record)
  return sortRecords(records.values(), compare)
}

export function applySnapshotDelta(snapshot, delta) {
  if (
    !snapshot ||
    delta?.schemaVersion !== 1 ||
    typeof delta.fromVersion !== 'string' ||
    typeof delta.toVersion !== 'string' ||
    !delta.catalog ||
    !delta.questions ||
    !delta.lessonQuestionOrder
  ) {
    throw new Error('Snapshot delta formati noto‘g‘ri.')
  }

  const catalog = snapshot.catalog
  return {
    schemaVersion: snapshot.schemaVersion,
    catalog: {
      ...catalog,
      sections: mergeRecords(
        catalog.sections,
        delta.catalog.sections,
        (row) => String(row.id),
        (a, b) => numberCompare(a.sort_order, b.sort_order) || numberCompare(a.id, b.id)
      ),
      lessons: mergeRecords(
        catalog.lessons,
        delta.catalog.lessons,
        (row) => String(row.id),
        (a, b) =>
          numberCompare(a.section_id, b.section_id) ||
          numberCompare(a.sort_order, b.sort_order) ||
          numberCompare(a.id, b.id)
      ),
      manual_variants: mergeRecords(
        catalog.manual_variants,
        delta.catalog.manual_variants,
        (row) => String(row.id),
        (a, b) => numberCompare(a.sort_order, b.sort_order) || numberCompare(a.id, b.id)
      ),
      settings: delta.catalog.settingsChanged
        ? delta.catalog.settings
        : catalog.settings,
    },
    questions: mergeRecords(
      snapshot.questions,
      delta.questions,
      (row) => `${row.question_source || 'base'}:${row.id}`,
      (a, b) =>
        timestampCompare(a.updated_at, b.updated_at) ||
        numberCompare(a.id, b.id)
    ),
    lessonQuestionOrder: mergeRecords(
      snapshot.lessonQuestionOrder,
      delta.lessonQuestionOrder,
      (row) => `${row.question_source}:${row.question_id}`,
      (a, b) =>
        numberCompare(a.lesson_id, b.lesson_id) ||
        numberCompare(a.sort_order, b.sort_order) ||
        textCompare(a.question_source, b.question_source) ||
        numberCompare(a.question_id, b.question_id)
    ),
  }
}
