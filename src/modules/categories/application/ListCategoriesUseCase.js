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

    const serviceCategories = [
      {
        id: 'srv_assessment',
        name: 'AI Hair & Scalp Assessment',
        slug: 'assessment',
        type: 'service',
        icon: 'camera',
        price: 'Free',
        description: 'Evaluation of hair loss pattern and scalp health',
      },
      {
        id: 'srv_consultation',
        name: 'Trichologist Consultation',
        slug: 'consultation',
        type: 'service',
        icon: 'user-check',
        price: '₹500',
        description: 'One-on-one video or clinic consultation with certified specialists',
      },
      {
        id: 'srv_prp',
        name: 'PRP Hair Therapy',
        slug: 'prp',
        type: 'service',
        icon: 'syringe',
        price: '₹4,500',
        description: 'Platelet-Rich Plasma therapy designed to stimulate active and dormant follicles',
      },
      {
        id: 'srv_laser',
        name: 'Low-Level Light Therapy (LLLT)',
        slug: 'laser',
        type: 'service',
        icon: 'zap',
        price: '₹2,500',
        description: 'Clinical-grade light stimulation therapy for cellular repair',
      },
    ];

    const clinicalConcerns = [
      {
        id: 'thinning',
        name: 'Crown & Overall Thinning',
        slug: 'thinning',
        type: 'concern',
        icon: 'user',
        description: 'Progressive thinning with increased scalp visibility',
      },
      {
        id: 'receding',
        name: 'Receding Hairline & Temples',
        slug: 'receding',
        type: 'concern',
        icon: 'arrow-up-right',
        description: 'M-shaped hairline shift and temporal recession',
      },
      {
        id: 'dandruff_flakes',
        name: 'Flakes, Dandruff & Scalp Itch',
        slug: 'dandruff-flakes',
        type: 'concern',
        icon: 'shield-alert',
        description: 'Stubborn flakes, redness, or oily scalp build-up',
      },
      {
        id: 'patchy',
        name: 'Patchy Hair Loss',
        slug: 'patchy',
        type: 'concern',
        icon: 'circle-dot',
        description: 'Coin-shaped smooth patches (Alopecia Areata)',
      },
    ];

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
    const counts = {
      total: 0,
      hair_fall: 0,
      regrowth: 0,
      dandruff: 0,
      doctor_advice: 0,
    };

    try {
      if (isDatabaseConnected()) {
        const publishedVideos = await VideoModel.find({ status: 'published' }).select('category tag author_name').lean();
        counts.total = publishedVideos.length;

        for (const v of publishedVideos) {
          const cat = `${v.category || ''} ${v.tag || ''}`.toLowerCase();
          const author = (v.author_name || '').toLowerCase();

          if (cat.includes('hair fall')) counts.hair_fall++;
          if (cat.includes('regrowth')) counts.regrowth++;
          if (cat.includes('dandruff')) counts.dandruff++;
          if (cat.includes('doctor') || author.includes('dr.')) counts.doctor_advice++;
        }
        return counts;
      }

      // Memory store fallback
      const videos = Array.isArray(store.videos) ? store.videos.filter((v) => v.status === 'published') : [];
      counts.total = videos.length;

      for (const v of videos) {
        const cat = `${v.category || ''} ${v.tag || ''}`.toLowerCase();
        const author = (v.author_name || '').toLowerCase();

        if (cat.includes('hair fall')) counts.hair_fall++;
        if (cat.includes('regrowth')) counts.regrowth++;
        if (cat.includes('dandruff')) counts.dandruff++;
        if (cat.includes('doctor') || author.includes('dr.')) counts.doctor_advice++;
      }
    } catch (_) {}

    return counts;
  }

  async _getVideoCategories(videoCounts = {}) {
    let storedCategories = [];
    try {
      storedCategories = await this.categoryRepository.list({ type: 'video', status: 'active' });
    } catch (_) {}

    if (!storedCategories || storedCategories.length === 0) {
      const defaults = [
        { name: 'Hair Fall', slug: 'hair-fall', icon: 'sparkles' },
        { name: 'Regrowth', slug: 'regrowth', icon: 'trending-up' },
        { name: 'Dandruff', slug: 'dandruff', icon: 'shield-check' },
        { name: 'Doctor Advice', slug: 'doctor-advice', icon: 'stethoscope' },
        { name: 'Scalp Care', slug: 'scalp-care', icon: 'sparkles' },
      ];
      for (const def of defaults) {
        try {
          const created = await this.categoryRepository.create({ ...def, type: 'video' });
          if (created) storedCategories.push(created);
        } catch (_) {}
      }
    }

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

