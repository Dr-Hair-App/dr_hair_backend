import { BadRequestError } from '../../../shared/errors/index.js';
import { isManagedProductR2Key } from '../domain/productMedia.js';

const MAX_PRODUCT_MEDIA = 10;
const PRODUCT_MEDIA_PREFIX = 'drhair/images/admin/product/';

function referencesFor(item) {
  if (typeof item === 'string') return [item.trim()].filter(Boolean);
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
  return [
    item.public_id,
    item.publicId,
    item.asset_id,
    item.assetId,
    item.storage_url,
    item.storageUrl,
    item.originalPublicId,
    item.url,
    item.secure_url,
    item.name,
  ].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
}

function primaryReference(item) {
  return referencesFor(item)[0] || null;
}

function existingMediaItems(existing) {
  const items = [
    ...(Array.isArray(existing?.media) ? existing.media : []),
    ...(Array.isArray(existing?.images) ? existing.images : []),
  ];
  const seen = new Set();
  return items.filter((item) => {
    const reference = primaryReference(item);
    if (!reference || seen.has(reference)) return false;
    seen.add(reference);
    return true;
  });
}

function normalizeAltText(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length > 160) {
    throw new BadRequestError('Image alt text must be a text value of at most 160 characters.');
  }
  return value.trim();
}

function withEditableImageMetadata(saved, request) {
  if (typeof saved === 'string') {
    if (request && typeof request === 'object' && !Array.isArray(request)) {
      return { name: saved, url: saved, kind: 'image', ...(normalizeAltText(request.altText ?? request.alt_text) !== undefined ? { altText: normalizeAltText(request.altText ?? request.alt_text) } : {}), ...(typeof request.isPrimary === 'boolean' ? { isPrimary: request.isPrimary } : {}) };
    }
    return saved;
  }
  const next = { ...saved };
  const altText = normalizeAltText(request?.altText ?? request?.alt_text);
  if (altText !== undefined) next.altText = altText;
  else if (request && ('altText' in request || 'alt_text' in request)) next.altText = '';
  if (request && Object.hasOwn(request, 'isPrimary')) {
    if (typeof request.isPrimary !== 'boolean') throw new BadRequestError('Image isPrimary must be a boolean.');
    next.isPrimary = request.isPrimary;
  }
  return next;
}

function normalizeUploadedImage(file, request) {
  if (!file || !isManagedProductR2Key(file.key) || file.publicId !== file.key || !file.secureUrl) {
    throw new BadRequestError('The uploaded product image could not be verified.');
  }
  const altText = normalizeAltText(request.altText ?? request.alt_text);
  return {
    name: file.originalName || file.originalname || 'Product image',
    url: file.secureUrl,
    public_id: file.key,
    asset_id: file.key,
    storage_url: file.key,
    kind: 'image',
    format: file.format,
    mime_type: file.mimetype,
    bytes: file.bytes,
    ...(altText !== undefined ? { altText } : {}),
    ...(typeof request.isPrimary === 'boolean' ? { isPrimary: request.isPrimary } : {}),
  };
}

function imageUrl(item) {
  if (typeof item === 'string') return item;
  return item?.url || item?.secure_url || item?.name || null;
}

/**
 * Reconcile requested media with server-owned product media. `media` is the
 * desired final order; saved items must already belong to this product and
 * pending upload slots must map one-to-one to the streamed `files` parts.
 */
export function resolveProductMediaInput(payload, uploadedFiles = [], existing = null, { replaceMedia = false } = {}) {
  const files = Array.isArray(uploadedFiles) ? uploadedFiles : [];
  if (files.length > MAX_PRODUCT_MEDIA) throw new BadRequestError(`A product can have at most ${MAX_PRODUCT_MEDIA} images.`);
  if (!replaceMedia) return payload;

  if (!Object.hasOwn(payload, 'media')) {
    if (files.length) throw new BadRequestError('Include an ordered media list with one upload slot for every image file.');
    if (existing) throw new BadRequestError('Include the desired ordered product media list in the multipart "product" field.');
    if (Array.isArray(payload.images) && payload.images.length) {
      throw new BadRequestError('New product images must be uploaded as multipart files.');
    }
    return { ...payload, media: [], images: [] };
  }
  if (!Array.isArray(payload.media)) throw new BadRequestError('Product media must be an ordered array.');
  if (payload.media.length > MAX_PRODUCT_MEDIA) throw new BadRequestError(`A product can have at most ${MAX_PRODUCT_MEDIA} images.`);

  const savedItems = existingMediaItems(existing);
  const usedSavedItems = new Set();
  const usedUploadIndexes = new Set();
  const finalMedia = payload.media.map((requested) => {
    if (requested && typeof requested === 'object' && !Array.isArray(requested) && requested.pending_upload === true) {
      const index = requested.upload_index;
      if (!Number.isInteger(index) || index < 0 || index >= files.length || usedUploadIndexes.has(index)) {
        throw new BadRequestError('Every pending image must have a unique upload_index matching one uploaded file.');
      }
      usedUploadIndexes.add(index);
      return normalizeUploadedImage(files[index], requested);
    }

    const requestedRefs = referencesFor(requested);
    const saved = savedItems.find((candidate) => {
      const candidateRefs = referencesFor(candidate);
      return requestedRefs.some((ref) => candidateRefs.includes(ref));
    });
    if (!saved) throw new BadRequestError('Retained product images must belong to this product; upload new images as files.');
    const savedReference = primaryReference(saved);
    if (usedSavedItems.has(savedReference)) throw new BadRequestError('A product image cannot be included more than once.');
    usedSavedItems.add(savedReference);
    return withEditableImageMetadata(saved, requested);
  });

  if (usedUploadIndexes.size !== files.length) {
    throw new BadRequestError('Every uploaded image file must be referenced by exactly one pending media item.');
  }
  if (finalMedia.filter((item) => item && typeof item === 'object' && item.isPrimary === true).length > 1) {
    throw new BadRequestError('Only one product image can be marked as primary.');
  }

  const images = finalMedia.map(imageUrl).filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
  return { ...payload, media: finalMedia, images };
}

export async function cleanupUploadedProductFiles(files, imageStorage) {
  const keys = [...new Set((Array.isArray(files) ? files : [])
    .map((file) => file?.key)
    .filter((key) => isManagedProductR2Key(key)))];
  if (!imageStorage || !keys.length) return;
  const results = await Promise.allSettled(keys.map((key) => imageStorage.deleteImage(key)));
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[product-media-cleanup] Uploaded image cleanup failed.', {
        message: result.reason instanceof Error ? result.reason.message : 'unknown error',
      });
    }
  }
}

export function isProductMediaUploadKey(key) {
  return typeof key === 'string' && key.startsWith(PRODUCT_MEDIA_PREFIX);
}
