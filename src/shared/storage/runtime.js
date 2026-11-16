let storageBindings = null;

export const setStorageBindings = (bindings) => {
  if (!bindings?.MEDIA_BUCKET || typeof bindings.MEDIA_BUCKET.put !== 'function') {
    throw new TypeError('A Cloudflare R2 MEDIA_BUCKET binding is required.');
  }
  storageBindings = bindings;
};

export const getMediaBucket = () => storageBindings?.MEDIA_BUCKET || null;
export const clearStorageBindings = () => { storageBindings = null; };
