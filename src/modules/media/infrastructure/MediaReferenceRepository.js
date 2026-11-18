import {
  ClinicalReportModel,
  HairTestModel,
  ProductModel,
  ProgressCheckInModel,
  UserModel,
  VideoModel,
} from '../../../shared/database/models.js';
import { isDatabaseConnected } from '../../../shared/database/database.js';
import { getDatabaseBinding } from '../../../shared/database/runtime.js';
import { store } from '../../../shared/database/store.js';
import { config } from '../../../config/env.js';

function productMediaUrls(publicId) {
  const path = String(publicId).split('/').map(encodeURIComponent).join('/');
  return [`${config.baseUrl.replace(/\/$/, '')}/api/v1/media/assets/${path}`];
}

export class MediaReferenceRepository {
  async isReferenced(publicId) {
    const candidateUrls = productMediaUrls(publicId);
    if (isDatabaseConnected()) {
      const database = getDatabaseBinding();
      const [imageArrayReference, ...references] = await Promise.all([
        database?.prepare(`
          SELECT 1 FROM products
          WHERE EXISTS (
            SELECT 1 FROM json_each(products.payload, '$.images') AS image
            WHERE image.value IN (${candidateUrls.map(() => '?').join(', ')})
          )
          OR EXISTS (
            SELECT 1 FROM json_tree(products.payload, '$.media') AS media_value
            WHERE media_value.value IN (${[publicId, ...candidateUrls].map(() => '?').join(', ')})
          )
          LIMIT 1
        `).bind(...candidateUrls, publicId, ...candidateUrls).first(),
        HairTestModel.exists({ 'scalp_photos.file_name': publicId }),
        ProgressCheckInModel.exists({ 'photos.public_id': publicId }),
        ClinicalReportModel.exists({ public_id: publicId }),
        VideoModel.exists({ public_id: publicId }),
        UserModel.exists({ profile_url: { $in: candidateUrls } }),
        ProductModel.exists({ 'media.public_id': publicId }),
        ProductModel.exists({ 'media.publicId': publicId }),
        ProductModel.exists({ 'media.asset_id': publicId }),
        ProductModel.exists({ 'media.name': publicId }),
        ProductModel.exists({ 'media.url': { $in: candidateUrls } }),
      ]);
      return Boolean(imageArrayReference) || references.some(Boolean);
    }
    return store.hairTests.some((item) => item.scalp_photos?.some((photo) => photo.file_name === publicId))
      || store.progressCheckIns.some((item) => item.photos?.some((photo) => photo.public_id === publicId))
      || store.clinicalReports.some((item) => item.public_id === publicId)
      || store.videos.some((item) => item.public_id === publicId)
      || (store.users || []).some((user) => candidateUrls.includes(user.profile_url))
      || store.products.some((product) => {
        const candidates = [
          ...(Array.isArray(product.media) ? product.media : []).flatMap((media) => [
            media?.public_id, media?.publicId, media?.asset_id, media?.name, media?.url,
            media?.originalPublicId, media?.originalUrl,
            ...(Array.isArray(media?.variants) ? media.variants.flatMap((variant) => [variant?.publicId, variant?.url]) : []),
          ]),
          ...(Array.isArray(product.images) ? product.images : []),
        ];
        return candidates.some((value) => value === publicId || candidateUrls.includes(value));
      });
  }
}
