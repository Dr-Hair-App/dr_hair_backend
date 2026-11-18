import { IInventoryRepository } from '../domain/IInventoryRepository.js';
import { randomUUID } from 'node:crypto';
import { isDatabaseConnected } from '../../../shared/database/database.js';
import { getDatabaseBinding } from '../../../shared/database/runtime.js';
import { InventoryLedgerModel, InventoryOperationModel, ProductModel } from '../../../shared/database/models.js';
import { store } from '../../../shared/database/store.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';

export class InventoryRepository extends IInventoryRepository {
  async recordMovement({
    productId,
    quantity,
    balanceAfter,
    balance_after,
    referenceType,
    reference_type,
    referenceId = '',
    reference_id = '',
    notes = '',
    createdBy = 'system',
    created_by = 'system',
  }) {
    const cleanProductId = String(productId).trim();
    const type = referenceType || reference_type || 'ADJUSTMENT';
    const refId = referenceId || reference_id || '';
    const creator = createdBy || created_by || 'system';
    const balance = balanceAfter !== undefined ? balanceAfter : (balance_after !== undefined ? balance_after : 0);

    const record = {
      id: `inv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      product_id: cleanProductId,
      quantity: Number(quantity),
      balance_after: Number(balance),
      reference_type: type,
      reference_id: String(refId),
      notes: String(notes),
      created_by: String(creator),
      created_at: new Date(),
    };

    if (isDatabaseConnected()) {
      await InventoryLedgerModel.create(record);
      return record;
    }

    if (!Array.isArray(store.inventoryLedgers)) store.inventoryLedgers = [];
    store.inventoryLedgers.push(record);
    return record;
  }

  async reserveStock(items, orderId) {
    if (!Array.isArray(items) || items.length === 0) return true;

    if (isDatabaseConnected()) {
      const reservedItems = [];
      try {
        for (const item of items) {
          const pId = item.productId || item.product_id;
          const qty = item.quantity || 1;

          const updated = await ProductModel.findOneAndUpdate(
            { id: pId, stock: { $gte: qty } },
            { $inc: { stock: -qty } },
            { new: true },
          );

          if (!updated) {
            throw new ConflictError(`Insufficient stock for product ${pId}`);
          }

          reservedItems.push({ productId: pId, quantity: qty, balanceAfter: updated.stock });
          if (updated.stock <= 0) {
            await ProductModel.updateOne({ id: pId }, { $set: { in_stock: false } });
          }
        }

        // Record ledger movements after all items reserved
        for (const res of reservedItems) {
          await this.recordMovement({
            productId: res.productId,
            quantity: -res.quantity,
            balanceAfter: res.balanceAfter,
            referenceType: 'RESERVATION',
            referenceId: orderId,
            notes: `Stock reserved for order ${orderId}`,
          });
        }

        return true;
      } catch (err) {
        // Roll back previously reserved items
        for (const res of reservedItems) {
          await ProductModel.updateOne(
            { id: res.productId },
            { $inc: { stock: res.quantity }, $set: { in_stock: true } },
          );
        }
        throw err;
      }
    }

    // In-memory store handling
    if (!Array.isArray(store.products)) store.products = [];

    // Step 1: Pre-validation of all items
    for (const item of items) {
      const pId = item.productId || item.product_id;
      const qty = item.quantity || 1;
      const product = store.products.find((p) => p.id === pId);

      if (!product) {
        throw new NotFoundError(`Product not found: ${pId}`);
      }
      const currentStock = product.stock !== undefined ? product.stock : (product.in_stock ? 100 : 0);
      if (currentStock < qty) {
        throw new ConflictError(`Insufficient stock for product ${product.name || pId} (requested ${qty}, available ${currentStock})`);
      }
    }

    // Step 2: Atomic decrement
    for (const item of items) {
      const pId = item.productId || item.product_id;
      const qty = item.quantity || 1;
      const product = store.products.find((p) => p.id === pId);
      product.stock = (product.stock || 100) - qty;
      product.in_stock = product.stock > 0;
      product.inStock = product.stock > 0;

      await this.recordMovement({
        productId: pId,
        quantity: -qty,
        balanceAfter: product.stock,
        referenceType: 'RESERVATION',
        referenceId: orderId,
        notes: `Stock reserved for order ${orderId}`,
      });
    }

    return true;
  }

  async releaseStock(items, orderId) {
    if (!Array.isArray(items) || items.length === 0) return true;

    const quantitiesByProduct = new Map();
    for (const item of items) {
      const pId = String(item.productId || item.product_id || '').trim();
      if (!pId) continue;
      quantitiesByProduct.set(pId, (quantitiesByProduct.get(pId) || 0) + (Number(item.quantity) || 1));
    }
    for (const [pId, qty] of quantitiesByProduct) {

      if (isDatabaseConnected()) {
        const db = getDatabaseBinding();
        const existing = await InventoryOperationModel.findOne({
          operation_type: 'RELEASE', reference_id: String(orderId), product_id: String(pId),
        }).lean();
        if (existing) continue;
        const product = await ProductModel.findOne({ id: pId }).select('_id').lean();
        if (!product) throw new NotFoundError(`Product not found: ${pId}`);

        const now = new Date().toISOString();
        const operationId = randomUUID();
        const ledgerId = randomUUID();
        const operation = JSON.stringify({ _id: operationId, operation_type: 'RELEASE', reference_id: String(orderId), product_id: String(pId), quantity: Number(qty), created_at: now });
        const ledger = JSON.stringify({ _id: ledgerId, id: `inv_${ledgerId}`, product_id: String(pId), quantity: Number(qty), reference_type: 'RELEASE', reference_id: String(orderId), notes: `Stock released from cancelled order ${orderId}`, created_by: 'system', created_at: now });
        await db.batch([
          db.prepare(`INSERT INTO inventory_operations (row_key, payload) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM products WHERE json_extract(payload, '$.id') = ?) ON CONFLICT DO NOTHING`).bind(operationId, operation, pId),
          db.prepare(`UPDATE products SET payload = json_set(payload, '$.stock', COALESCE(CAST(json_extract(payload, '$.stock') AS INTEGER), 0) + ?, '$.in_stock', json('true'), '$.inStock', json('true'), '$.updated_at', ?) WHERE json_extract(payload, '$.id') = ? AND changes() > 0`).bind(Number(qty), now, pId),
          db.prepare(`INSERT INTO inventory_ledgers (row_key, payload) SELECT ?, json_set(?, '$.balance_after', json_extract(payload, '$.stock')) FROM products WHERE json_extract(payload, '$.id') = ? AND changes() > 0`).bind(ledgerId, ledger, pId),
        ]);
      } else {
        if (!Array.isArray(store.products)) store.products = [];
        if (!Array.isArray(store.inventoryOperations)) store.inventoryOperations = [];
        const operationExists = store.inventoryOperations.some((operation) =>
          operation.operation_type === 'RELEASE' && operation.reference_id === String(orderId) && operation.product_id === String(pId));
        if (operationExists) continue;
        const product = store.products.find((p) => p.id === pId);
        if (product) {
          product.stock = (product.stock || 0) + qty;
          product.in_stock = true;
          product.inStock = true;
          store.inventoryOperations.push({ operation_type: 'RELEASE', reference_id: String(orderId), product_id: String(pId), quantity: Number(qty), created_at: new Date().toISOString() });
          await this.recordMovement({
            productId: pId,
            quantity: qty,
            balanceAfter: product.stock,
            referenceType: 'RELEASE',
            referenceId: orderId,
            notes: `Stock released from cancelled order ${orderId}`,
          });
        }
      }
    }
    return true;
  }

  async restock(productId, quantity, notes = '', createdBy = 'admin') {
    const qty = Number(quantity);
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new TypeError('Restock quantity must be a positive integer.');
    return this.adjustStock(productId, qty, notes, createdBy, 'RESTOCK', randomUUID());
  }

  async adjustStock(productId, delta, notes = '', createdBy = 'admin', referenceType = 'ADJUSTMENT', idempotencyKey = randomUUID()) {
    const cleanProductId = String(productId ?? '').trim();
    const change = Number(delta);
    const operationKey = String(idempotencyKey ?? '').trim();
    if (!cleanProductId || !Number.isSafeInteger(change) || change === 0) {
      throw new TypeError('Stock adjustment must be a non-zero integer.');
    }
    if (!operationKey || operationKey.length > 128) throw new TypeError('A valid inventory idempotency key is required.');

    if (isDatabaseConnected()) {
      const db = getDatabaseBinding();
      const operationType = 'ADMIN_ADJUSTMENT';
      const now = new Date().toISOString();
      const operationId = randomUUID();
      const ledgerId = randomUUID();
      const operation = JSON.stringify({
        _id: operationId,
        operation_type: operationType,
        reference_id: operationKey,
        product_id: cleanProductId,
        quantity: change,
        reference_type: referenceType,
        created_by: String(createdBy),
        created_at: now,
      });
      const ledger = JSON.stringify({
        _id: ledgerId,
        id: `inv_${ledgerId}`,
        product_id: cleanProductId,
        quantity: change,
        reference_type: referenceType,
        reference_id: operationKey,
        notes: String(notes),
        created_by: String(createdBy),
        created_at: now,
      });

      const results = await db.batch([
        db.prepare(`UPDATE products
          SET payload = json_set(payload,
            '$.stock', COALESCE(CAST(json_extract(payload, '$.stock') AS INTEGER), 0) + ?,
            '$.in_stock', json(CASE WHEN COALESCE(CAST(json_extract(payload, '$.stock') AS INTEGER), 0) + ? > 0 THEN 'true' ELSE 'false' END),
            '$.inStock', json(CASE WHEN COALESCE(CAST(json_extract(payload, '$.stock') AS INTEGER), 0) + ? > 0 THEN 'true' ELSE 'false' END),
            '$.updated_at', ?)
          WHERE json_extract(payload, '$.id') = ?
            AND COALESCE(CAST(json_extract(payload, '$.stock') AS INTEGER), 0) + ? >= 0
            AND NOT EXISTS (
              SELECT 1 FROM inventory_operations
              WHERE json_extract(payload, '$.operation_type') = ?
                AND json_extract(payload, '$.reference_id') = ?
                AND json_extract(payload, '$.product_id') = ?
            )`)
          .bind(change, change, change, now, cleanProductId, change, operationType, operationKey, cleanProductId),
        db.prepare(`INSERT INTO inventory_operations (row_key, payload)
          SELECT ?, json_set(?, '$.balance_after', json_extract(products.payload, '$.stock'))
          FROM products WHERE json_extract(products.payload, '$.id') = ? AND changes() > 0`)
          .bind(operationId, operation, cleanProductId),
        db.prepare(`INSERT INTO inventory_ledgers (row_key, payload)
          SELECT ?, json_set(?, '$.balance_after', json_extract(products.payload, '$.stock'))
          FROM products WHERE json_extract(products.payload, '$.id') = ? AND changes() > 0`)
          .bind(ledgerId, ledger, cleanProductId),
      ]);

      if (results[0]?.meta?.changes > 0) {
        const updated = await ProductModel.findOne({ id: cleanProductId }).select('stock').lean();
        return Number(updated?.stock ?? 0);
      }

      const previousOperation = await InventoryOperationModel.findOne({
        operation_type: operationType,
        reference_id: operationKey,
        product_id: cleanProductId,
      }).lean();
      if (previousOperation) {
        if (Number(previousOperation.quantity) !== change) {
          throw new ConflictError('This idempotency key was already used for a different stock adjustment.');
        }
        return Number(previousOperation.balance_after ?? 0);
      }
      const existing = await ProductModel.findOne({ id: cleanProductId }).select('stock').lean();
      if (!existing) throw new NotFoundError('Product not found');
      throw new ConflictError('Stock adjustment cannot reduce inventory below zero.');
    }

    let product;
    if (!Array.isArray(store.products)) store.products = [];
    if (!Array.isArray(store.inventoryOperations)) store.inventoryOperations = [];
    const previousOperation = store.inventoryOperations.find((entry) =>
      entry.operation_type === 'ADMIN_ADJUSTMENT' && entry.reference_id === operationKey && entry.product_id === cleanProductId);
    if (previousOperation) {
      if (Number(previousOperation.quantity) !== change) throw new ConflictError('This idempotency key was already used for a different stock adjustment.');
      return Number(previousOperation.balance_after ?? 0);
    }
    product = store.products.find((item) => item.id === cleanProductId);
    if (!product) throw new NotFoundError('Product not found');
    const currentStock = Number.isSafeInteger(Number(product.stock)) ? Number(product.stock) : 0;
    const nextStock = currentStock + change;
    if (nextStock < 0) throw new ConflictError('Stock adjustment cannot reduce inventory below zero.');
    product.stock = nextStock;
    product.in_stock = nextStock > 0;
    product.inStock = nextStock > 0;
    store.inventoryOperations.push({
      operation_type: 'ADMIN_ADJUSTMENT',
      reference_id: operationKey,
      product_id: cleanProductId,
      quantity: change,
      balance_after: nextStock,
      created_at: new Date().toISOString(),
    });

    try {
      await this.recordMovement({
        productId: cleanProductId,
        quantity: change,
        balanceAfter: product.stock,
        referenceType,
        referenceId: operationKey,
        notes,
        createdBy,
      });
    } catch (error) {
      product.stock = currentStock;
      product.in_stock = currentStock > 0;
      product.inStock = currentStock > 0;
      store.inventoryOperations = store.inventoryOperations.filter((entry) => !(
        entry.operation_type === 'ADMIN_ADJUSTMENT' && entry.reference_id === operationKey && entry.product_id === cleanProductId
      ));
      store.inventoryLedgers = (store.inventoryLedgers || []).filter((entry) => entry.reference_id !== operationKey || entry.product_id !== cleanProductId);
      throw error;
    }
    return Number(product.stock);
  }

  async getStock(productId) {
    const cleanProductId = String(productId).trim();
    if (isDatabaseConnected()) {
      const product = await ProductModel.findOne({ id: cleanProductId }).select('stock in_stock').lean();
      if (!product) return 0;
      return product.stock || 0;
    }
    if (!Array.isArray(store.products)) store.products = [];
    const product = store.products.find((p) => p.id === cleanProductId);
    return product ? (product.stock || 0) : 0;
  }

  async listLedger({ productId, page = 1, limit = 50 } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (safePage - 1) * safeLimit;

    if (isDatabaseConnected()) {
      const query = productId ? { product_id: String(productId).trim() } : {};
      const [items, total] = await Promise.all([
        InventoryLedgerModel.find(query).sort({ created_at: -1 }).skip(skip).limit(safeLimit).lean(),
        InventoryLedgerModel.countDocuments(query),
      ]);
      return { items, total, page: safePage, limit: safeLimit };
    }

    if (!Array.isArray(store.inventoryLedgers)) store.inventoryLedgers = [];
    let list = store.inventoryLedgers;
    if (productId) {
      list = list.filter((l) => l.product_id === String(productId).trim());
    }
    list = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const total = list.length;
    const items = list.slice(skip, skip + safeLimit);
    return { items, total, page: safePage, limit: safeLimit };
  }
}
