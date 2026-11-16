import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryRepository } from '../src/modules/commerce/infrastructure/InventoryRepository.js';
import { store } from '../src/shared/database/store.js';

test('inventory stock release is idempotent per order and product', async (t) => {
  const originalProducts = store.products;
  const originalLedger = store.inventoryLedgers;
  const originalOperations = store.inventoryOperations;
  store.products = [{ id: 'product-1', name: 'Test product', stock: 4, in_stock: true }];
  store.inventoryLedgers = [];
  store.inventoryOperations = [];
  t.after(() => {
    store.products = originalProducts;
    store.inventoryLedgers = originalLedger;
    store.inventoryOperations = originalOperations;
  });
  const inventory = new InventoryRepository();
  const lines = [{ product_id: 'product-1', quantity: 1 }, { product_id: 'product-1', quantity: 2 }];

  await inventory.releaseStock(lines, 'ORD-RELEASE-1');
  await inventory.releaseStock(lines, 'ORD-RELEASE-1');
  assert.equal(store.products[0].stock, 7);
  assert.equal(store.inventoryOperations.length, 1);
  assert.equal(store.inventoryOperations[0].quantity, 3);
  assert.equal(store.inventoryLedgers.filter((movement) => movement.reference_type === 'RELEASE').length, 1);

  await inventory.releaseStock(lines, 'ORD-RELEASE-2');
  assert.equal(store.products[0].stock, 10);
  assert.equal(store.inventoryOperations.length, 2);
});
