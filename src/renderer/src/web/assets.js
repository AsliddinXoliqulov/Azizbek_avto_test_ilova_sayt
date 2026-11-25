const STORAGE_PUBLIC_MARKER = '/storage/v1/object/public/pdd-images/'

export function publicImageUrl(value) {
  if (typeof value !== 'string' || !value) return null

  let url
  try {
    url = new URL(value, window.location.origin)
  } catch {
    return null
  }
  const pathname = url.pathname

  const markerIndex = pathname.indexOf(STORAGE_PUBLIC_MARKER)
  if (markerIndex >= 0) {
    return url.toString()
  }
  return null
}
