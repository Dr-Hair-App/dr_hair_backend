import { BadRequestError, NotFoundError } from '../../../shared/errors/index.js';
import { sendSuccess } from '../../../shared/utils/response.js';
import { bumpCatalogCacheVersion } from '../../../shared/cache/catalog-cache-version.js';

export class VideoController {
  constructor({ videoRepository, listCategoriesUseCase }) {
    this.videoRepository = videoRepository;
    this.listCategoriesUseCase = listCategoriesUseCase;
  }

  listCategories = async (req, res, next) => {
    try {
      if (this.listCategoriesUseCase) {
        const result = await this.listCategoriesUseCase.execute({ type: 'videos' });
        return sendSuccess(res, result.videos || [], 'Video categories retrieved successfully.');
      }
      return sendSuccess(res, [], 'Video categories retrieved successfully.');
    } catch (error) {
      next(error);
    }
  };

  addYouTubeVideo = async (req, res, next) => {
    try {
      const {
        url,
        title,
        description = '',
        category = 'Hair Care',
        placement = 'reels',
        status = 'published',
        author_name = 'Dr. Hair Specialist',
        author_handle = '@drhair.clinic',
        treatment = 'Clinical Hair Care Protocol',
      } = req.body || {};
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 160) {
        throw new BadRequestError('Video title is required and must be at most 160 characters.');
      }
      if (typeof description !== 'string' || description.length > 2000) {
        throw new BadRequestError('Video description must be a string of at most 2000 characters.');
      }
      if (typeof category !== 'string' || !category.trim() || category.trim().length > 80) throw new BadRequestError('Video category is required and must be at most 80 characters.');
      if (!['home', 'reels', 'both'].includes(placement)) throw new BadRequestError('placement must be home, reels, or both.');
      const safeStatus = ['draft', 'published', 'hidden'].includes(status) ? status : 'published';
      const videoId = this.getYouTubeVideoId(url);
      const saved = await this.videoRepository.create({
        public_id: 'youtube-' + videoId,
        provider: 'youtube',
        youtube_video_id: videoId,
        title: title.trim(),
        category: category.trim(),
        tag: category.trim(),
        description: description.trim(),
        author_name: typeof author_name === 'string' && author_name.trim() ? author_name.trim() : 'Dr. Hair Specialist',
        author_handle: typeof author_handle === 'string' && author_handle.trim() ? author_handle.trim() : '@drhair.clinic',
        treatment: typeof treatment === 'string' && treatment.trim() ? treatment.trim() : 'Clinical Hair Care Protocol',
        placement,
        secure_url: 'https://www.youtube.com/watch?v=' + videoId,
        thumbnail_url: 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg',
        duration: null,
        status: safeStatus,
        created_by: Number(req.user?.id) || null,
      });
      await bumpCatalogCacheVersion();
      return sendSuccess(res, {
        message: safeStatus === 'published' ? 'YouTube video published successfully.' : 'YouTube video saved as a draft.',
        data: saved,
        statusCode: 201,
      });
    } catch (error) {
      next(error);
    }
  };

  getYouTubeVideoId = (input) => {
    if (typeof input !== 'string' || input.length > 500) {
      throw new BadRequestError('A valid YouTube video URL is required.');
    }
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new BadRequestError('A valid YouTube video URL is required.');
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let videoId = null;
    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0];
    } else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      if (url.pathname === '/watch') videoId = url.searchParams.get('v');
      else if (url.pathname.startsWith('/embed/')) videoId = url.pathname.split('/')[2];
      else if (url.pathname.startsWith('/shorts/')) videoId = url.pathname.split('/')[2];
    }
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || '')) {
      throw new BadRequestError('The URL must point to a single YouTube video.');
    }
    return videoId;
  };

  listPublished = async (req, res, next) => {
    try {
      const { placement, limit, page, category } = req.query;
      if (placement !== undefined && !['home', 'reels'].includes(placement)) {
        throw new BadRequestError('placement must be home or reels.');
      }
      const options = { limit, placement };
      if (page !== undefined) options.page = page;
      if (category !== undefined) options.category = category;
      const result = await this.videoRepository.listPublished(options);
      return sendSuccess(res, { data: result });
    } catch (error) {
      next(error);
    }
  };

  updateVideo = async (req, res, next) => {
    try {
      const publicId = req.params?.publicId || req.body?.public_id || req.body?.id;
      if (typeof publicId !== 'string' || !publicId.trim()) {
        throw new BadRequestError('public_id is required.');
      }
      const { title, category, description, placement, status, url, author_name, author_handle, treatment } = req.body || {};
      const updates = {};
      if (typeof title === 'string' && title.trim()) updates.title = title.trim();
      if (typeof category === 'string' && category.trim()) updates.category = category.trim();
      if (typeof description === 'string') updates.description = description.trim();
      if (placement && ['home', 'reels', 'both'].includes(placement)) updates.placement = placement;
      if (status && ['draft', 'published', 'hidden'].includes(status)) updates.status = status;
      if (typeof author_name === 'string') updates.author_name = author_name.trim();
      if (typeof author_handle === 'string') updates.author_handle = author_handle.trim();
      if (typeof treatment === 'string') updates.treatment = treatment.trim();
      if (url && typeof url === 'string' && url.trim()) {
        const videoId = this.getYouTubeVideoId(url.trim());
        updates.youtube_video_id = videoId;
        updates.secure_url = 'https://www.youtube.com/watch?v=' + videoId;
        updates.thumbnail_url = 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg';
      }
      const updated = await this.videoRepository.updateVideo(publicId.trim(), updates);
      if (!updated) throw new NotFoundError('Video not found.');
      await bumpCatalogCacheVersion();
      return sendSuccess(res, {
        message: 'Video updated successfully.',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteVideo = async (req, res, next) => {
    try {
      const publicId = req.params?.publicId || req.body?.public_id;
      if (typeof publicId !== 'string' || !publicId.trim()) {
        throw new BadRequestError('public_id is required.');
      }
      const deleted = await this.videoRepository.delete(publicId.trim());
      if (!deleted) throw new NotFoundError('Video not found.');
      await bumpCatalogCacheVersion();
      return sendSuccess(res, { message: 'Video deleted successfully.' });
    } catch (error) {
      next(error);
    }
  };

  listAdmin = async (req, res, next) => {
    try {
      const result = await this.videoRepository.listAdmin({
        page: req.query.page,
        limit: req.query.limit,
      });
      return sendSuccess(res, { data: result });
    } catch (error) {
      next(error);
    }
  };

  updateStatus = async (req, res, next) => {
    try {
      const { public_id, status } = req.body || {};
      if (typeof public_id !== 'string' || !public_id.trim()) {
        throw new BadRequestError('public_id is required.');
      }
      if (!['draft', 'published', 'hidden'].includes(status)) {
        throw new BadRequestError('status must be draft, published, or hidden.');
      }
      const video = await this.videoRepository.updateStatus(public_id.trim(), status);
      if (!video) throw new NotFoundError('Video not found.');
      await bumpCatalogCacheVersion();
      return sendSuccess(res, { message: 'Video status updated.', data: video });
    } catch (error) {
      next(error);
    }
  };
}
