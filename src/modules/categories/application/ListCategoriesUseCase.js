import { isDatabaseConnected } from '../../../shared/database/database.js';
import { ProductModel, VideoModel } from '../../../shared/database/models.js';
import { store } from '../../../shared/database/store.js';
import { CategoryRepository } from '../infrastructure/CategoryRepository.js';

export class ListCategoriesUseCase {
  constructor({ productRepository, videoRepository, categoryRepository } = {}) {
    this.productRepository = productRepository;
    this.videoRepository = videoRepository;
    this.categoryRepository = categoryRepository || new CategoryRepository();
  }

  async execute({ type } = {}) {
    const productCategories = await this._getProductCategories();
    const videoCounts = await this._getVideoCounts();
    const videoCategories = await this._getVideoCategories(videoCounts);

    const serviceCategories = await this.categoryRepository.list({ type: 'services', status: 'active' });

    const clinicalConcerns = await this.categoryRepository.list({ type: 'concerns', status: 'active' });

    const normalizedType = typeof type === 'string' ? type.trim().toLowerCase() : '';

    if (normalizedType === 'products' || normalizedType === 'product') {
      return { products: productCategories };
    }
    if (normalizedType === 'videos' || normalizedType === 'video') {
      return { videos: videoCategories };
    }
    if (normalizedType === 'services' || normalizedType === 'service') {
      return { services: serviceCategories };
    }
    if (normalizedType === 'concerns' || normalizedType === 'concern') {
      return { concerns: clinicalConcerns };
    }

    return {
      products: productCategories,
      videos: videoCategories,
      services: serviceCategories,
      concerns: clinicalConcerns,
    };
  }

  async _getProductCategories() {
    let products = [];
    if (isDatabaseConnected()) {
      products = await ProductModel.find({ status: 'active' })
        .select('root_cause root_causes')
        .lean();
    } else {
      products = Array.isArray(store.products)
        ? store.products.filter((product) => product.status === 'active')
        : [];
    }

    const counts = new Map();
    for (const product of products) {
      const causes = Array.isArray(product.root_causes || product.rootCauses)
        ? product.root_causes || product.rootCauses
        : [product.root_cause || product.rootCause];
      for (const value of causes) {
        const name = String(value || '').trim();
        if (!name) continue;
        const key = name.toLocaleLowerCase();
        const current = counts.get(key) || { name, count: 0 };
        current.count += 1;
        counts.set(key, current);
      }
    }

    return [
      {
        id: 'all', name: 'All', slug: 'all', type: 'product', icon: 'layout-grid',
        description: '', item_count: products.length,
      },
      ...[...counts.entries()]
        .sort(([, a], [, b]) => a.name.localeCompare(b.name))
        .map(([key, item]) => ({
          id: item.name,
          name: item.name,
          slug: key.replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
          type: 'product',
          icon: 'layout-grid',
          description: '',
          item_count: item.count,
        })),
    ];
  }

  async _getVideoCounts() {
    const counts = { total: 0 };

    const countVideos = (videos) => {
      counts.total = videos.length;
      for (const video of videos) {
        const category = String(video.category || '').trim();
        if (!category) continue;
        const key = category.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
    };

    try {
      if (isDatabaseConnected()) {
        const publishedVideos = await VideoModel.find({ status: 'published' }).select('category tag author_name').lean();
        countVideos(publishedVideos);
        return counts;
      }

      // Memory store fallback
      const videos = Array.isArray(store.videos) ? store.videos.filter((v) => v.status === 'published') : [];
      countVideos(videos);
    } catch (_) {}

    return counts;
  }

  async _getVideoCategories(videoCounts = {}) {
    let storedCategories = [];
    try {
      storedCategories = await this.categoryRepository.list({ type: 'video', status: 'active' });
    } catch (_) {}

    let publishedVideos = [];
    try {
      if (isDatabaseConnected()) {
        publishedVideos = await VideoModel.find({ status: 'published' }).select('category tag author_name').lean();
      } else {
        publishedVideos = Array.isArray(store.videos) ? store.videos.filter((v) => v.status === 'published') : [];
      }
    } catch (_) {}

    const knownSlugs = new Set(storedCategories.map((c) => (c.slug || '').toLowerCase()));
    const knownNames = new Set(storedCategories.map((c) => (c.name || '').toLowerCase()));

    for (const v of publishedVideos) {
      const cat = (v.category || '').trim();
      if (cat && cat.toLowerCase() !== 'all' && !knownNames.has(cat.toLowerCase())) {
        const slug = cat.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        if (slug && !knownSlugs.has(slug)) {
          knownSlugs.add(slug);
          knownNames.add(cat.toLowerCase());
          storedCategories.push({
            id: slug.replace(/-/g, '_'),
            name: cat,
            slug,
            type: 'video',
            icon: 'film',
            status: 'active',
          });
        }
      }
    }

    const videoCategories = [
      {
        id: 'all',
        name: 'All Stories',
        slug: 'all',
        type: 'video',
        icon: 'film',
        item_count: videoCounts.total || publishedVideos.length || 0,
      },
    ];

    for (const cat of storedCategories) {
      const slugKey = (cat.slug || '').replace(/-/g, '_');
      const count =
        videoCounts[slugKey] ??
        publishedVideos.filter((v) => {
          const catStr = `${v.category || ''} ${v.tag || ''}`.toLowerCase();
          return catStr.includes(cat.name.toLowerCase()) || catStr.includes(cat.slug.toLowerCase());
        }).length;

      const formattedId =
        slugKey === 'hair_fall' || slugKey === 'doctor_advice'
          ? slugKey
          : cat.id?.startsWith('cat_')
            ? slugKey
            : cat.id || slugKey;

      videoCategories.push({
        id: formattedId,
        raw_id: cat._id || cat.id,
        name: cat.name,
        slug: cat.slug,
        type: 'video',
        icon: cat.icon || 'film',
        badge: cat.badge || null,
        description: cat.description || '',
        item_count: count,
      });
    }

    return videoCategories;
  }
}

