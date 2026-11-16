import { isDatabaseConnected } from '../../../shared/database/database.js';
import { CouponModel } from '../../../shared/database/models.js';
import { store } from '../../../shared/database/store.js';
import { NotFoundError, ConflictError, BadRequestError } from '../../../shared/errors/index.js';

export class CouponRepository {
  async list({ status = 'all', page = 1, limit = 50 } = {}) {
    const numericPage = Math.max(1, parseInt(page, 10) || 1);
    const numericLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
    const skip = (numericPage - 1) * numericLimit;

    if (isDatabaseConnected()) {
      const filter = {};
      if (status && status !== 'all') {
        filter.status = status;
      }
      const [items, total] = await Promise.all([
        CouponModel.find(filter)
          .sort({ created_at: -1 })
          .skip(skip)
          .limit(numericLimit)
          .lean(),
        CouponModel.countDocuments(filter),
      ]);
      return {
        items: items.map(this._mapDoc),
        total,
        page: numericPage,
        limit: numericLimit,
        has_more: skip + items.length < total,
      };
    }

    store.coupons ||= [];
    let filtered = [...store.coupons];
    if (status && status !== 'all') {
      filtered = filtered.filter((c) => c.status?.toLowerCase() === status.toLowerCase());
    }
    const total = filtered.length;
    const items = filtered.slice(skip, skip + numericLimit);
    return {
      items: items.map(this._mapDoc),
      total,
      page: numericPage,
      limit: numericLimit,
      has_more: skip + items.length < total,
    };
  }

  async findByCode(code) {
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!cleanCode) return null;

    if (isDatabaseConnected()) {
      const doc = await CouponModel.findOne({ code: cleanCode }).lean();
      return doc ? this._mapDoc(doc) : null;
    }

    store.coupons ||= [];
    const found = store.coupons.find((c) => c.code.toUpperCase() === cleanCode);
    return found ? this._mapDoc(found) : null;
  }

  async consumeUsage(code) {
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!cleanCode) return false;
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    if (isDatabaseConnected()) {
      const updated = await CouponModel.findOneAndUpdate({
        code: cleanCode,
        status: 'Active',
        $and: [
          { $expr: { $lt: ['$uses', '$max_uses'] } },
          { $or: [{ expires_on: '' }, { expires_on: { $gte: today } }] },
        ],
      }, { $inc: { uses: 1 }, $set: { updated_at: new Date() } }, { new: true }).lean();
      return Boolean(updated);
    }

    store.coupons ||= [];
    const coupon = store.coupons.find((item) => item.code?.toUpperCase() === cleanCode);
    if (!coupon || coupon.status !== 'Active') return false;
    const maxUses = Number(coupon.max_uses);
    if (Number.isFinite(maxUses) && Number(coupon.uses || 0) >= maxUses) return false;
    if (coupon.expires_on && coupon.expires_on < today) return false;
    coupon.uses = Number(coupon.uses || 0) + 1;
    coupon.updated_at = new Date();
    return true;
  }

  async findById(id) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return null;

    if (isDatabaseConnected()) {
      const doc = await CouponModel.findOne({ id: cleanId }).lean();
      return doc ? this._mapDoc(doc) : null;
    }

    store.coupons ||= [];
    const found = store.coupons.find((c) => c.id === cleanId);
    return found ? this._mapDoc(found) : null;
  }

  async create(data) {
    const cleanCode = String(data.code || '').trim().toUpperCase();
    if (!cleanCode) {
      throw new BadRequestError('Coupon code is required.');
    }

    const existing = await this.findByCode(cleanCode);
    if (existing) {
      throw new ConflictError(`Coupon code ${cleanCode} already exists.`);
    }

    const id = data.id || `CPN-${Date.now()}`;
    const record = {
      id,
      code: cleanCode,
      discount_type: data.discount_type || data.discountType || 'percent',
      discount_value: Number(data.discount_value ?? data.discountValue ?? 0),
      applies_to: data.applies_to || data.appliesTo || 'All products',
      minimum_order: Number(data.minimum_order ?? data.minimumOrder ?? 0),
      uses: Number(data.uses || 0),
      max_uses: Number(data.max_uses ?? data.maxUses ?? 1000),
      expires_on: data.expires_on || data.expiresOn || '',
      status: data.status || 'Active',
      created_at: new Date(),
      updated_at: new Date(),
    };

    if (isDatabaseConnected()) {
      await CouponModel.create(record);
      return this._mapDoc(record);
    }

    store.coupons ||= [];
    store.coupons.unshift(record);
    return this._mapDoc(record);
  }

  async update(id, data) {
    const cleanId = String(id || '').trim();
    const existing = await this.findById(cleanId);
    if (!existing) {
      throw new NotFoundError(`Coupon with ID ${cleanId} not found.`);
    }

    const update = {
      updated_at: new Date(),
    };
    if (data.status) update.status = data.status;
    if (data.discount_value != null || data.discountValue != null) {
      update.discount_value = Number(data.discount_value ?? data.discountValue);
    }
    if (data.discount_type || data.discountType) {
      update.discount_type = data.discount_type || data.discountType;
    }
    if (data.minimum_order != null || data.minimumOrder != null) {
      update.minimum_order = Number(data.minimum_order ?? data.minimumOrder);
    }
    if (data.max_uses != null || data.maxUses != null) {
      update.max_uses = Number(data.max_uses ?? data.maxUses);
    }
    if (data.expires_on != null || data.expiresOn != null) {
      update.expires_on = data.expires_on ?? data.expiresOn;
    }

    if (isDatabaseConnected()) {
      const updated = await CouponModel.findOneAndUpdate(
        { id: cleanId },
        { $set: update },
        { new: true },
      ).lean();
      return this._mapDoc(updated);
    }

    store.coupons ||= [];
    const index = store.coupons.findIndex((c) => c.id === cleanId);
    store.coupons[index] = { ...store.coupons[index], ...update };
    return this._mapDoc(store.coupons[index]);
  }

  async delete(id) {
    const cleanId = String(id || '').trim();
    if (isDatabaseConnected()) {
      const res = await CouponModel.deleteOne({ id: cleanId });
      return res.deletedCount > 0;
    }

    store.coupons ||= [];
    const prevLen = store.coupons.length;
    store.coupons = store.coupons.filter((c) => c.id !== cleanId);
    return store.coupons.length < prevLen;
  }

  _mapDoc(doc) {
    if (!doc) return null;
    return {
      id: doc.id,
      code: doc.code,
      discount_type: doc.discount_type,
      discountType: doc.discount_type,
      discount_value: doc.discount_value,
      discountValue: doc.discount_value,
      applies_to: doc.applies_to,
      appliesTo: doc.applies_to,
      minimum_order: doc.minimum_order,
      minimumOrder: doc.minimum_order,
      uses: doc.uses || 0,
      max_uses: doc.max_uses,
      maxUses: doc.max_uses,
      expires_on: doc.expires_on,
      expiresOn: doc.expires_on,
      status: doc.status || 'Active',
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    };
  }
}

