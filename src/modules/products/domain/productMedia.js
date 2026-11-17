const PRODUCT_MEDIA_PREFIX = 'drhair/images/admin/product/';

function normalizeKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim();
  if (candidate.startsWith(PRODUCT_MEDIA_PREFIX)) return candidate;

  try {
    const pathname = new URL(candidate).pathname;
    const marker = '/api/v1/media/assets/';
    const markerIndex = pathname.indexOf(marker);
    if (markerIndex < 0) return null;
    const key = pathname.slice(markerIndex + marker.length)
      .split('/')
      .map((part) => decodeURIComponent(part))
      .join('/');
    return key.startsWith(PRODUCT_MEDIA_PREFIX) ? key : null;
  } catch {
    return null;
  }
}

export function getProductR2MediaKeys(product) {
  const media = Array.isArray(product?.media) ? product.media : [];
  const images = Array.isArray(product?.images) ? product.images : [];
  const keys = new Set();

  for (const item of [...media, ...images]) {
    const candidates = typeof item === 'string'
      ? [item]
      : [item?.public_id, item?.publicId, item?.asset_id, item?.name, item?.url, item?.secure_url];
    for (const candidate of candidates) {
      const key = normalizeKey(candidate);
      if (key) keys.add(key);
    }
  }

  return [...keys];
}

export function isManagedProductR2Key(key) {
  return typeof key === 'string'
    && key.startsWith(PRODUCT_MEDIA_PREFIX)
    && key.length <= 400
    && !key.includes('..');
}
