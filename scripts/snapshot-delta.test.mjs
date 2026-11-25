import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySnapshotDelta,
  createSnapshotDelta,
  shouldWriteFullBaseline,
  snapshotHash,
} from './snapshot-delta.mjs'

test('full mode replaces the baseline, while changes mode uses deltas when available', () => {
  const incremental = { incrementalReady: true }
  const legacy = { incrementalReady: false }

  assert.equal(shouldWriteFullBaseline('full', incremental), true)
  assert.equal(shouldWriteFullBaseline('changes', incremental), false)
  assert.equal(shouldWriteFullBaseline('changes', legacy), true)
  assert.equal(shouldWriteFullBaseline('changes', null), true)
})

test('delta contains only changed records and reconstructs the complete snapshot', () => {
  const before = {
    schemaVersion: 1,
    catalog: {
      sections: [{ id: 1, sort_order: 0, name: 'Old' }, { id: 2, sort_order: 1, name: 'Removed' }],
      lessons: [{ id: 10, section_id: 1, sort_order: 0, title: 'Lesson' }],
      manual_variants: [],
      settings: { exam_seconds: 30 },
    },
    questions: [
      { id: 1, question_source: 'base', updated_at: '2026-01-01T00:00:00.000Z', text: 'Old' },
      { id: 2, question_source: 'base', updated_at: '2026-01-01T00:00:00.000Z', text: 'Removed' },
    ],
    lessonQuestionOrder: [
      { question_source: 'base', question_id: 1, lesson_id: 10, sort_order: 0 },
      { question_source: 'base', question_id: 2, lesson_id: 10, sort_order: 1 },
    ],
  }
  const after = {
    schemaVersion: 1,
    catalog: {
      sections: [{ id: 1, sort_order: 0, name: 'Updated' }],
      lessons: [{ id: 10, section_id: 1, sort_order: 0, title: 'Lesson' }],
      manual_variants: [],
      settings: { exam_seconds: 45 },
    },
    questions: [
      { id: 1, question_source: 'base', updated_at: '2026-01-02T00:00:00.000Z', text: 'Updated' },
      { id: 3, question_source: 'base', updated_at: '2026-01-03T00:00:00.000Z', text: 'Added' },
    ],
    lessonQuestionOrder: [
      { question_source: 'base', question_id: 3, lesson_id: 10, sort_order: 0 },
      { question_source: 'base', question_id: 1, lesson_id: 10, sort_order: 1 },
    ],
  }

  const delta = createSnapshotDelta(before, after, 'old', 'new')
  const rebuilt = applySnapshotDelta(before, delta)

  assert.deepEqual(rebuilt, after)
  assert.equal(delta.catalog.sections.upsert.length, 1)
  assert.deepEqual(delta.catalog.sections.remove, ['2'])
  assert.equal(delta.questions.upsert.length, 2)
  assert.deepEqual(delta.questions.remove, ['base:2'])
  assert.equal(delta.catalog.settingsChanged, true)
  assert.equal(snapshotHash(rebuilt), snapshotHash(after))
})

test('unchanged catalog settings are omitted from the delta', () => {
  const snapshot = {
    schemaVersion: 1,
    catalog: { sections: [], lessons: [], manual_variants: [], settings: { value: 1 } },
    questions: [],
    lessonQuestionOrder: [],
  }
  const delta = createSnapshotDelta(snapshot, snapshot, 'old', 'new')

  assert.equal(delta.catalog.settingsChanged, false)
  assert.equal(Object.hasOwn(delta.catalog, 'settings'), false)
  assert.deepEqual(applySnapshotDelta(snapshot, delta), snapshot)
})
