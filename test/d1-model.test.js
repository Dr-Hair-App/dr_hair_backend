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

test('D1Model treats undefined optional comparisons as missing or null without binding undefined', async () => {
  let captured;
  const database = {
    prepare(sql) {
      captured = { sql, args: [] };
      return {
        bind(...args) {
          captured.args = args;
          return { all: async () => ({ results: [] }) };
        },
      };
    },
  };

  setDatabaseBinding(database);
  try {
    await new D1Model('users').findOne({ email: undefined }).lean();
    assert.deepEqual(captured.args, []);
    assert.match(captured.sql, /json_type\(payload, '\$\.email'\) IS NULL/);
    assert.match(captured.sql, /json_type\(payload, '\$\.email'\) = 'null'/);
  } finally {
    clearDatabaseBinding();
  }
});

test('D1Model supports lean() on update and delete mutation queries', async () => {
  clearDatabaseBinding();
  const model = new D1Model('products');
  const created = await model.create({ id: 'mutation-query-test', name: 'Before', extra: 'RemoveMe' });
  try {
    const updated = await model.findOneAndUpdate(
      { id: created.id },
      { $set: { name: 'After' } },
      { new: true },
    ).select('name').populate('reviews').setOptions({}).session(null).lean();
    assert.equal(updated.name, 'After');
    assert.equal(updated.extra, undefined);

    const queryResult = await model.findOne({ id: created.id })
      .populate('reviews')
      .collation({ locale: 'en' })
      .hint({ id: 1 })
      .comment('find product')
      .batchSize(10)
      .setOptions({})
      .lean();
    assert.equal(queryResult.name, 'After');

    const estimatedCount = await model.estimatedDocumentCount({ id: created.id });
    assert.equal(estimatedCount, 1);

    const deleted = await model.findOneAndDelete({ id: created.id }).populate('reviews').lean();
    assert.equal(deleted.name, 'After');
    assert.equal(await model.findOne({ id: created.id }).lean(), null);
  } finally {
    clearDatabaseBinding();
  }
});

test('D1Model preserves Mongo $nin behavior for missing and null fields', async () => {
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
    await new D1Model('products').find({ status: { $nin: ['archived'] } }).lean();
    assert.match(statements[0].sql, /NOT IN \(\?\) OR json_type\(payload, '\$\.status'\) IS NULL OR json_type\(payload, '\$\.status'\) = 'null'/);
    assert.deepEqual(statements[0].args, ['archived']);
  } finally {
    clearDatabaseBinding();
  }
});

test('D1Model rejects unsupported comparison operators instead of matching every row', async () => {
  setDatabaseBinding({
    prepare() {
      throw new Error('Unexpected D1 query should not execute.');
    },
  });
  try {
    await assert.rejects(
      new D1Model('products').find({ status: { $where: 'true' } }).lean(),
      /Unsupported D1 query operator: \$where/,
    );
  } finally {
    clearDatabaseBinding();
  }
});

test('D1Model distinct reads only unique field values from D1 and flattens arrays', async () => {
  let captured;
  const database = {
    prepare(sql) {
      captured = { sql, args: [] };
      return {
        bind(...args) {
          captured.args = args;
          return {
            all: async () => ({ results: [
              { value: 7, value_type: 'integer' },
              { value: 1, value_type: 'true' },
              { value: 'user-a', value_type: 'text' },
              { value: 'user-b', value_type: 'text' },
              { value: null, value_type: 'null' },
            ] }),
          };
        },
      };
    },
  };
  setDatabaseBinding(database);
  try {
    const values = await new D1Model('hair_tests').distinct('userId', { status: 'active' });
    assert.deepEqual(values, [7, true, 'user-a', 'user-b', null]);
    assert.match(captured.sql, /SELECT DISTINCT value, value_type/);
    assert.match(captured.sql, /json_each\(payload, '\$\.userId'\)/);
    assert.doesNotMatch(captured.sql, /SELECT payload FROM/);
    assert.deepEqual(captured.args, ['active', 'active']);
  } finally {
    clearDatabaseBinding();
  }
});
