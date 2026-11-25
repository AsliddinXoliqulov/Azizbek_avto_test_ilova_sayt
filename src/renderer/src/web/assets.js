const STORAGE_PUBLIC_MARKER = '/storage/v1/object/public/pdd-images/'
const REPOSITORY_IMAGE_PATH =
  /^\/data\/images\/[a-f0-9]{64}\.(?:avif|bmp|gif|ico|jpg|png|tif|webp)$/

export function publicImageUrl(value) {
  if (typeof value !== 'string' || !value) return null

  let url
  try {
    url = new URL(value, window.location.origin)
  } catch {
    return null
  }
  const pathname = url.pathname

  if (url.origin === window.location.origin && REPOSITORY_IMAGE_PATH.test(pathname)) {
    return url.toString()
  }

  const markerIndex = pathname.indexOf(STORAGE_PUBLIC_MARKER)
  if (markerIndex >= 0) {
    return url.toString()
  }
  return null
}
