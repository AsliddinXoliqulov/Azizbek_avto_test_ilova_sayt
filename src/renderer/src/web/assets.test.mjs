import assert from 'node:assert/strict'
import test from 'node:test'
import { publicImageUrl } from './assets.js'

globalThis.window = { location: { origin: 'https://site.example' } }

test('repository image paths resolve to same-origin URLs', () => {
  const imagePath = `/data/images/${'a'.repeat(64)}.webp`

  assert.equal(
    publicImageUrl(imagePath),
    `https://site.example${imagePath}`
  )
})

test('only known repository image paths are accepted', () => {
  assert.equal(publicImageUrl('/data/images/not-a-hash.webp'), null)
  assert.equal(
    publicImageUrl(`https://other.example/data/images/${'a'.repeat(64)}.webp`),
    null
  )
})

test('existing Supabase image URLs remain accepted', () => {
  const imageUrl =
    'https://supabase.example/storage/v1/object/public/pdd-images/question.webp'

  assert.equal(publicImageUrl(imageUrl), imageUrl)
})
