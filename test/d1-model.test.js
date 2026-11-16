import test from 'node:test';
import assert from 'node:assert/strict';
import { D1Model } from '../src/shared/database/D1Model.js';
import { clearDatabaseBinding, setDatabaseBinding } from '../src/shared/database/runtime.js';

test('D1Model builds filters for plain and nested field paths', async () => {
  const statements = [];
  const database = {
    prepare(sql) {
      const statement = { sql, args: [] };
      statements.push(statement);
      return {
        bind(...args) {
          statement.args = args;
          return { all: async () => ({ results: [] }) };
        },
      };
    },
  };

  setDatabaseBinding(database);
  try {
    await new D1Model('products').find({ status: 'active' }).lean();
    await new D1Model('products').find({ 'metadata.slug': 'hair-care' }).lean();

    assert.equal(statements.length, 2);
    assert.match(statements[0].sql, /json_extract\(payload, '\$\.status'\) = \?/);
    assert.deepEqual(statements[0].args, ['active']);
    assert.match(statements[1].sql, /json_each\(payload, '\$\.metadata'\)/);
    assert.match(statements[1].sql, /json_extract\(nested\.value, '\$\.slug'\)/);
    assert.deepEqual(statements[1].args, ['hair-care']);
  } finally {
    clearDatabaseBinding();
  }
});

test('D1Model supports lean() on update and delete mutation queries', async () => {
  clearDatabaseBinding();
  const model = new D1Model('products');
  const created = await model.create({ id: 'mutation-query-test', name: 'Before' });
  try {
    const updated = await model.findOneAndUpdate(
      { id: created.id },
      { $set: { name: 'After' } },
      { new: true },
    ).lean();
    assert.equal(updated.name, 'After');

    const deleted = await model.findOneAndDelete({ id: created.id }).lean();
    assert.equal(deleted.name, 'After');
    assert.equal(await model.findOne({ id: created.id }).lean(), null);
  } finally {
    clearDatabaseBinding();
  }
});
