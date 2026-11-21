let storageBindings = null;
let imageOptimizationBinding = null;

export const setStorageBindings = (bindings) => {
  const hasLegacy = typeof bindings?.MEDIA_BUCKET?.put === 'function';
  const hasAdmin = typeof bindings?.ADMIN_MEDIA_BUCKET?.put === 'function';
  const hasUser = typeof bindings?.USER_MEDIA_BUCKET?.put === 'function';
  if (!hasLegacy && !(hasAdmin && hasUser)) {
    throw new TypeError('Cloudflare R2 ADMIN_MEDIA_BUCKET and USER_MEDIA_BUCKET bindings are required.');
  }
  storageBindings = bindings;
  imageOptimizationBinding = bindings?.IMAGES && typeof bindings.IMAGES.input === 'function'
    ? bindings.IMAGES
    : null;
};

export const getImageOptimizationBinding = () => imageOptimizationBinding;

// MEDIA_BUCKET is the original all-purpose binding. Keep it as a fallback for
// old deployments and tests while new environments bind the two media classes
// explicitly.
export const getMediaBucket = () => storageBindings?.USER_MEDIA_BUCKET || storageBindings?.MEDIA_BUCKET || null;
export const getAdminMediaBucket = () => storageBindings?.ADMIN_MEDIA_BUCKET || storageBindings?.MEDIA_BUCKET || null;

// Admin-managed catalog/content media uses a dedicated R2 bucket. During
// cutover, reads and cleanup also check MEDIA_BUCKET so older saved references
// keep working until they are replaced or migrated. Patient reports remain in
// the user bucket even when an Admin initiates the upload.
export const getBucketsForKey = (key) => {
  const normalizedKey = String(key || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (normalizedKey.startsWith('drhair/images/admin/')) {
    return [...new Set([getAdminMediaBucket(), storageBindings?.MEDIA_BUCKET].filter(Boolean))];
  }
  return [...new Set([getMediaBucket(), storageBindings?.MEDIA_BUCKET].filter(Boolean))];
};

export const getUploadBucket = ({ isAdmin = false } = {}) => {
  return isAdmin ? getAdminMediaBucket() : getMediaBucket();
};
export const clearStorageBindings = () => { storageBindings = null; imageOptimizationBinding = null; };
