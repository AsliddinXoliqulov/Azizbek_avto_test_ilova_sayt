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
  let filePath
  let search = ''
  if (markerIndex >= 0) {
    filePath = pathname.slice(markerIndex + STORAGE_PUBLIC_MARKER.length)
    // Ombor yo'li "basa_img/<hash>.png"; saytda fayl /basa_img/<hash>.png da turadi.
    if (filePath.startsWith('basa_img/')) filePath = filePath.slice('basa_img/'.length)
  } else if (pathname.startsWith('/basa_img/')) {
    filePath = pathname.slice('/basa_img/'.length)
    if (value.startsWith('/basa_img/') || value.startsWith('basa_img/')) {
      search = url.search
    }
  } else {
    return null
  }

  let pathParts
  try {
    pathParts = filePath.split('/').map(decodeURIComponent)
  } catch {
    return null
  }
  if (
    pathParts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        !/^[A-Za-z0-9._-]+$/.test(part)
    )
  ) {
    return null
  }
  const publicUrl = new URL(
    `/basa_img/${pathParts.map(encodeURIComponent).join('/')}`,
    window.location.origin
  )
  publicUrl.search = search
  return publicUrl.toString()
}
