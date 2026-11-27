import { IProductRepository } from '../domain/IProductRepository.js';
import { isDatabaseConnected } from '../../../shared/database/database.js';
import { ProductModel } from '../../../shared/database/models.js';
import { getDatabaseBinding } from '../../../shared/database/runtime.js';
import { store } from '../../../shared/database/store.js';

function escapeLike(str) {
  return String(str).replace(/[\\%_]/g, '\\$&');
}

function buildD1ListWhere({ status, category, rootCause, inStock, search }) {
  const clauses = [];
  const args = [];

  if (status && status !== 'all') {
    // Product writes normalize status to lowercase. Equality keeps this
    // predicate indexable by idx_products_status_created_at_2 and composite indexes.
    clauses.push("json_extract(payload, '$.status') = ?");
    args.push(String(status).trim().toLowerCase());
  }

  if (category && category !== 'All' && category !== 'all') {
    const cleanCategory = String(category).trim().toLowerCase();
    clauses.push("LOWER(json_extract(payload, '$.category')) = ?");
    args.push(cleanCategory);
  }

  if (rootCause && rootCause !== 'All' && rootCause !== 'all') {
    const cleanRootCause = String(rootCause).trim().toLowerCase();
    clauses.push(
      "(" +
        "LOWER(json_extract(payload, '$.root_cause')) = ? OR " +
        "LOWER(json_extract(payload, '$.root_causes')) = ? OR " +
        "(json_type(payload, '$.root_causes') = 'array' AND EXISTS (" +
          "SELECT 1 FROM json_each(payload, '$.root_causes') AS rc " +
          "WHERE LOWER(CAST(rc.value AS TEXT)) = ?" +
        "))" +
      ")",
    );
    args.push(cleanRootCause, cleanRootCause, cleanRootCause);
  }

  if (inStock !== undefined) {
    clauses.push("json_extract(payload, '$.in_stock') = ?");
    args.push(Boolean(inStock) ? 1 : 0);
    if (inStock === true) {
      clauses.push("json_extract(payload, '$.stock') > ?");
      args.push(0);
    }
  }

  if (search && search.trim()) {
    const likePattern = `%${escapeLike(search.trim().toLowerCase())}%`;
    clauses.push(
      "(" +
        "LOWER(CAST(json_extract(payload, '$.name') AS TEXT)) LIKE ? ESCAPE '\\' OR " +
        "LOWER(CAST(json_extract(payload, '$.subtitle') AS TEXT)) LIKE ? ESCAPE '\\' OR " +
        "LOWER(CAST(json_extract(payload, '$.category') AS TEXT)) LIKE ? ESCAPE '\\' OR " +
        "LOWER(CAST(json_extract(payload, '$.sku') AS TEXT)) LIKE ? ESCAPE '\\' OR " +
        "(json_type(payload, '$.ingredients') = 'array' AND EXISTS (" +
          "SELECT 1 FROM json_each(payload, '$.ingredients') AS nested " +
          "WHERE LOWER(CAST(json_extract(nested.value, '$.name') AS TEXT)) LIKE ? ESCAPE '\\'" +
        "))" +
      ")",
    );
    args.push(likePattern, likePattern, likePattern, likePattern, likePattern);
  }

  return {
    sql: clauses.length > 0 ? clauses.join(' AND ') : '1',
    args,
  };
}

export class ProductRepository extends IProductRepository {
  async list({
    category,
    rootCause,
    search,
    inStock,
    status = 'active',
    page = 1,
    limit = 20,
  } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (safePage - 1) * safeLimit;

    if (isDatabaseConnected()) {
      const database = getDatabaseBinding();
      const where = buildD1ListWhere({ status, category, rootCause, inStock, search });
      const pagination = skip > 0 ? ' LIMIT ? OFFSET ?' : ' LIMIT ?';
      const selectArgs = skip > 0 ? [...where.args, safeLimit, skip] : [...where.args, safeLimit];
      const selectSql = `SELECT payload FROM "products" WHERE ${where.sql} ORDER BY json_extract(payload, '$.created_at') DESC${pagination}`;
      const countSql = `SELECT COUNT(*) AS total FROM "products" WHERE ${where.sql}`;

      const [rowsResult, countRow] = await Promise.all([
        database.prepare(selectSql).bind(...selectArgs).all(),
        database.prepare(countSql).bind(...where.args).first(),
      ]);

      const items = (rowsResult?.results || []).map((row) =>
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      );
      const total = Number(countRow?.total || 0);
      const has_more = skip + items.length < total;

      return { items, total, page: safePage, limit: safeLimit, has_more };
    }

    if (!Array.isArray(store.products)) {
      store.products = [];
    }

    const filtered = store.products.filter((product) => {
      if (status && status !== 'all' && product.status?.toLowerCase() !== status.toLowerCase()) {
        return false;
      }
      if (category && category !== 'All' && category !== 'all') {
        const cat = (product.category || '').toLowerCase();
        if (!cat.includes(category.toLowerCase())) return false;
      }
      if (rootCause && rootCause !== 'All' && rootCause !== 'all') {
        const target = rootCause.toLowerCase();
        const primary = (product.root_cause || product.rootCause || '').toLowerCase();
        const list = (product.root_causes || product.rootCauses || []).map((c) => String(c).toLowerCase());
        if (primary !== target && !list.includes(target)) {
          return false;
        }
      }
      if (inStock !== undefined) {
        const stockStatus = product.in_stock ?? product.inStock ?? true;
        if (Boolean(stockStatus) !== Boolean(inStock)) return false;
        if (inStock === true && !(Number(product.stock) > 0)) return false;
      }
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        const name = (product.name || '').toLowerCase();
        const subtitle = (product.subtitle || product.description || '').toLowerCase();
        const sku = (product.sku || '').toLowerCase();
        const categoryMatch = (product.category || '').toLowerCase().includes(q);
        const ingredientMatch = Array.isArray(product.ingredients) &&
          product.ingredients.some((ing) => (ing.name || '').toLowerCase().includes(q));

        if (!name.includes(q) && !subtitle.includes(q) && !sku.includes(q) && !categoryMatch && !ingredientMatch) {
          return false;
        }
      }
      return true;
    });

    const total = filtered.length;
    const items = filtered.slice(skip, skip + safeLimit);
    const has_more = skip + items.length < total;

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      has_more,
    };
  }

  async findById(id) {
    if (!id) return null;
    const cleanId = String(id).trim();

    if (isDatabaseConnected()) {
      return ProductModel.findOne({
        $or: [{ id: cleanId }, { sku: cleanId }, { _id: cleanId.match(/^[0-9a-fA-F]{24}$/) ? cleanId : null }],
      }).lean();
    }

    if (!Array.isArray(store.products)) store.products = [];
    return store.products.find((p) => String(p.id) === cleanId || String(p.sku) === cleanId) || null;
  }

  async getById(id) {
    return this.findById(id);
  }

  async create(productData) {
    if (isDatabaseConnected()) {
      try {
        return await ProductModel.create(productData);
      } catch (err) {
        if (err?.code === 11000) {
          const uniqueSuffix = '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
          const uniqueData = {
            ...productData,
            id: (productData.id || `prd-${Date.now()}`) + uniqueSuffix.toLowerCase(),
            sku: (productData.sku && productData.sku !== 'DRH-NEW' ? productData.sku : 'DRH') + uniqueSuffix,
          };
          return await ProductModel.create(uniqueData);
        }
        throw err;
      }
    }

    if (!Array.isArray(store.products)) store.products = [];
    const record = {
      ...productData,
      created_at: productData.created_at || new Date().toISOString(),
      updated_at: productData.updated_at || new Date().toISOString(),
    };
    store.products.unshift(record);
    return record;
  }

  async update(id, productData) {
    const cleanId = String(id).trim();
    if (isDatabaseConnected()) {
      return ProductModel.findOneAndUpdate(
        { id: cleanId },
        { ...productData, updated_at: new Date() },
        { new: true, runValidators: true },
      ).lean();
    }

    if (!Array.isArray(store.products)) store.products = [];
    const index = store.products.findIndex((p) => String(p.id) === cleanId);
    if (index === -1) return null;

    const updated = {
      ...store.products[index],
      ...productData,
      updated_at: new Date().toISOString(),
    };
    store.products[index] = updated;
    return updated;
  }

  async delete(id) {
    const cleanId = String(id).trim();
    if (isDatabaseConnected()) {
      const result = await ProductModel.deleteOne({ id: cleanId });
      return result.deletedCount > 0;
    }

    if (!Array.isArray(store.products)) store.products = [];
    const index = store.products.findIndex((p) => String(p.id) === cleanId);
    if (index === -1) return false;

    store.products.splice(index, 1);
    return true;
  }
}
