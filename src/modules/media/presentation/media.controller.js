import { BadRequestError, ConflictError } from '../../../shared/errors/index.js';
import { sendSuccess } from '../../../shared/utils/response.js';
import { R2MediaStorage } from '../infrastructure/R2MediaStorage.js';

const mediaStorage = new R2MediaStorage();

export class MediaController {
  constructor({ mediaReferenceRepository }) {
    this.mediaReferenceRepository = mediaReferenceRepository;
  }

  remove = async (req, res, next) => {
    try {
      const { public_id: publicId, resource_type: resourceType } = req.body || {};
      if (typeof publicId !== 'string' || resourceType !== 'image') {
        throw new BadRequestError('public_id and resource_type (image) are required. Video uploads are not supported.');
      }
      if (await this.mediaReferenceRepository.isReferenced(publicId)) {
        throw new ConflictError('This media is linked to a clinical or content record. Remove it from that record first.');
      }
      await mediaStorage.deleteOwnedOrphan({
        publicId: publicId.trim(),
        resourceType,
        ownerId: req.user.id,
        isAdmin: ['admin', 'super_admin'].includes(req.user?.role),
      });
      return sendSuccess(res, { message: 'Unattached media deleted from R2.' });
    } catch (error) {
      next(error);
    }
  };

  serveAsset = (req, res, next) => mediaStorage.serveAsset(req, res, next);
}
