import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryRepository } from '../src/modules/commerce/infrastructure/InventoryRepository.js';
import { store } from '../src/shared/database/store.js';
import { ConflictError } from '../src/shared/errors/index.js';

test('admin product stock adjustments update product balance and durable movement ledger', async (t) => {
  const originalProducts = store.products;
  const originalLedgers = store.inventoryLedgers;
  const originalOperations = store.inventoryOperations;
  store.products = [{ id: 'inventory-test-product', stock: 5, in_stock: true }];
  store.inventoryLedgers = [];
  store.inventoryOperations = [];
  t.after(() => {
    store.products = originalProducts;
    store.inventoryLedgers = originalLedgers;
    store.inventoryOperations = originalOperations;
  });

  const inventory = new InventoryRepository();
  const decreased = await inventory.adjustStock('inventory-test-product', -2, 'Damaged stock', 'admin-1', 'ADJUSTMENT', 'adjust-test-1');
  assert.equal(decreased, 3);
  assert.equal(store.products[0].in_stock, true);
  assert.equal(store.inventoryLedgers[0].quantity, -2);
  assert.equal(store.inventoryLedgers[0].balance_after, 3);
  assert.equal(store.inventoryLedgers[0].reference_type, 'ADJUSTMENT');
  assert.equal(store.inventoryLedgers[0].reference_id, 'adjust-test-1');
  assert.equal(await inventory.adjustStock('inventory-test-product', -2, 'Damaged stock', 'admin-1', 'ADJUSTMENT', 'adjust-test-1'), 3);
  assert.equal(store.inventoryLedgers.length, 1);
  await assert.rejects(
    inventory.adjustStock('inventory-test-product', -1, 'Changed retry', 'admin-1', 'ADJUSTMENT', 'adjust-test-1'),
    ConflictError,
  );

  await assert.rejects(
    inventory.adjustStock('inventory-test-product', -4, 'Over-removal', 'admin-1'),
    ConflictError,
  );
  assert.equal(await inventory.getStock('inventory-test-product'), 3);
  assert.equal(store.inventoryLedgers.length, 1);

  const restocked = await inventory.restock('inventory-test-product', 5, 'New delivery', 'admin-2');
  assert.equal(restocked, 8);
  assert.equal(store.inventoryLedgers[1].quantity, 5);
  assert.equal(store.inventoryLedgers[1].reference_type, 'RESTOCK');
  await assert.rejects(inventory.restock('inventory-test-product', 0), TypeError);
});
