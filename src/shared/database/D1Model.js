import { randomUUID } from 'node:crypto';
import { getDatabaseBinding } from './runtime.js';

const memoryTables = globalThis.__DR_HAIR_D1_TEST_TABLES__ || new Map();
globalThis.__DR_HAIR_D1_TEST_TABLES__ = memoryTables;

const defaultsByTable = {
  users: { authProviders: ['password'], profile_url: null, role: 'user', status: 'active', is_blocked: false },
  admin_accounts: { role: 'admin', roleTemplate: 'clinical-admin', permissions: [], permissionOverrides: {}, active: true },
  otps: { attempts: 0, type: 'login' },
  coupons: { active: true, usage_count: 0 },
  categories: { status: 'active', display_order: 0 },
  hair_tests: { status: 'pending', ai_assessment_status: 'queued', scalp_photos: [], status_history: [] },
  hair_test_drafts: { form_data: {}, files: {}, status: 'draft' },
  treatments: { status: 'active', medicines: [], care_steps: [] },
  clinic_appointments: { status: 'pending', payment_status: 'pending' },
  patient_progress_checkins: { photos: [] },
  reviews: { status: 'pending' },
  device_tokens: { active: true },
  notifications: { read: false },
  notification_campaigns: { status: 'draft' },
  videos: { status: 'draft', placement: 'reels' },
  products: { stock: 0, in_stock: false },
  carts: { items: [] },
  orders: { items: [], fulfillment: {}, payment: {} },
  inventory_operations: { quantity: 0 },
  feature_flags: { enabled: false },
  auth_sessions: { active: true },
};

const plain = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]));
  }
  return value;
};

const getPath = (value, path) => String(path).split('.').reduce((current, key) => current == null ? undefined : current[key], value);

const setPath = (target, path, value) => {
  const parts = String(path).split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = plain(value);
};

const unsetPath = (target, path) => {
  const parts = String(path).split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) current = current?.[part];
  if (current && typeof current === 'object') delete current[parts.at(-1)];
};

const equal = (left, right) => {
  if (left instanceof Date) left = left.toISOString();
  if (right instanceof Date) right = right.toISOString();
  if (Array.isArray(left) || Array.isArray(right) || (left && typeof left === 'object') || (right && typeof right === 'object')) {
    return JSON.stringify(plain(left)) === JSON.stringify(plain(right));
  }
  return String(left) === String(right);
};

const matches = (document, filter = {}) => Object.entries(filter || {}).every(([field, condition]) => {
  if (field === '$or') return Array.isArray(condition) && condition.some((part) => matches(document, part));
  if (field === '$and') return Array.isArray(condition) && condition.every((part) => matches(document, part));
  if (field === '$expr') {
    const [operator, operands] = Object.entries(condition || {})[0] || [];
    if (!Array.isArray(operands) || operands.length !== 2) return false;
    const values = operands.map((operand) => typeof operand === 'string' && operand.startsWith('$') ? getPath(document, operand.slice(1)) : operand);
    if (operator === '$lt') return values[0] < values[1];
    if (operator === '$lte') return values[0] <= values[1];
    if (operator === '$gt') return values[0] > values[1];
    if (operator === '$gte') return values[0] >= values[1];
    return false;
  }

  const actual = getPath(document, field);
  if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date) && !(condition instanceof RegExp)) {
    return Object.entries(condition).every(([operator, expected]) => {
      if (operator === '$exists') return expected ? actual !== undefined : actual === undefined;
      if (operator === '$in') return Array.isArray(expected) && expected.some((item) => Array.isArray(actual) ? actual.some((entry) => equal(entry, item)) : equal(actual, item));
      if (operator === '$nin') return Array.isArray(expected) && !expected.some((item) => equal(actual, item));
      if (operator === '$ne') return actual === undefined || !equal(actual, expected);
      if (operator === '$gt') return actual > expected;
      if (operator === '$gte') return actual >= expected;
      if (operator === '$lt') return actual < expected;
      if (operator === '$lte') return actual <= expected;
      if (operator === '$regex') {
        const pattern = expected instanceof RegExp ? expected : new RegExp(expected, condition.$options || '');
        return pattern.test(String(actual ?? ''));
      }
      if (operator === '$options') return true;
      if (operator === '$type') return expected === 'string' ? typeof actual === 'string' : typeof actual === expected;
      return false;
    });
  }
  if (condition === null) return actual == null;
  if (Array.isArray(actual)) return actual.some((entry) => equal(entry, condition));
  return equal(actual, condition);
});

const jsonPath = (field) => {
  if (!/^[A-Za-z0-9_.]+$/.test(field)) throw new TypeError(`Unsupported D1 field path: ${field}`);
  return `$.${field}`;
};

const bindValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value && typeof value === 'object') return JSON.stringify(plain(value));
  return value;
};

const expressionSql = (field) => {
  if (typeof field === 'string' && field.startsWith('$')) return `json_extract(payload, '${jsonPath(field.slice(1))}')`;
  return '?';
};

const expressionArgs = (field) => typeof field === 'string' && field.startsWith('$') ? [] : [bindValue(field)];

const regexToLikePattern = (source) => {
  let pattern = '';
  const expression = String(source).replace(/^\^/, '').replace(/\$$/, '');
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (char === '\\') {
      const literal = expression[index + 1];
      if (!literal || /[bBdDsSwW]/.test(literal)) {
        throw new TypeError('Unsupported D1 regular expression escape.');
      }
      index += 1;
      pattern += ['%', '_', '\\'].includes(literal) ? `\\${literal}` : literal;
      continue;
    }
    if (char === '.' && expression[index + 1] === '*') {
      pattern += '%';
      index += 1;
      continue;
    }
    if (char === '.') {
      pattern += '_';
      continue;
    }
    if ('^$+?{}()|[]'.includes(char)) {
      throw new TypeError('Unsupported D1 regular expression operator.');
    }
    pattern += ['%', '_', '\\'].includes(char) ? `\\${char}` : char;
  }
  return pattern;
};

const comparisonSql = (field, condition) => {
  const parts = String(field).split('.');
  const nestedArray = parts.length > 1;
  const path = jsonPath(field);
  const rootPath = jsonPath(parts[0]);
  const tailPath = nestedArray ? jsonPath(parts.slice(1).join('.')) : null;
  const column = nestedArray ? `json_extract(nested.value, '${tailPath}')` : `json_extract(payload, '${path}')`;
  const type = nestedArray ? `json_type(nested.value, '${tailPath}')` : `json_type(payload, '${path}')`;
  const wrap = (sql) => nestedArray ? `json_type(payload, '${rootPath}') = 'array' AND EXISTS (SELECT 1 FROM json_each(payload, '${rootPath}') AS nested WHERE ${sql})` : sql;
  if (condition instanceof RegExp) condition = { $regex: condition.source, $options: condition.flags };
  if (condition && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
    const clauses = [];
    const args = [];
    for (const [operator, expected] of Object.entries(condition)) {
      if (operator === '$options') continue;
      if (operator === '$exists') clauses.push(`${type} IS ${expected ? 'NOT ' : ''}NULL`);
      else if (operator === '$in' || operator === '$nin') {
        const values = Array.isArray(expected) ? expected : [];
        if (values.length === 0) clauses.push(operator === '$in' ? '0' : '1');
        else {
          const membership = `${column} ${operator === '$nin' ? 'NOT ' : ''}IN (${values.map(() => '?').join(', ')})`;
          clauses.push(operator === '$nin'
            ? `(${membership} OR ${type} IS NULL OR ${type} = 'null')`
            : membership);
          args.push(...values.map(bindValue));
        }
      } else if (operator === '$ne') {
        if (expected === null) clauses.push(`(${type} IS NOT NULL AND ${type} <> 'null')`);
        else { clauses.push(`(${column} <> ? OR ${type} IS NULL OR ${type} = 'null')`); args.push(bindValue(expected)); }
      } else if (operator === '$gt' || operator === '$gte' || operator === '$lt' || operator === '$lte') {
        clauses.push(`${column} ${{ $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[operator]} ?`);
        args.push(bindValue(expected));
      } else if (operator === '$regex') {
        const source = expected instanceof RegExp ? expected.source : String(expected);
        const flags = condition.$options || (expected instanceof RegExp ? expected.flags : '');
        const pattern = regexToLikePattern(source);
        clauses.push(`${flags.includes('i') ? `LOWER(CAST(${column} AS TEXT))` : `CAST(${column} AS TEXT)`} LIKE ? ESCAPE '\\'`);
        args.push(flags.includes('i') ? pattern.toLowerCase() : pattern);
      } else if (operator === '$type') {
        if (expected === 'number') clauses.push(`${type} IN ('integer', 'real')`);
        else if (expected === 'boolean') clauses.push(`${type} IN ('true', 'false')`);
        else {
          const sqliteType = ({ string: 'text', object: 'object', array: 'array', null: 'null' })[expected];
          if (!sqliteType) throw new TypeError(`Unsupported D1 query type: ${String(expected)}`);
          clauses.push(`${type} = ?`);
          args.push(sqliteType);
        }
      } else {
        throw new TypeError(`Unsupported D1 query operator: ${operator}`);
      }
    }
    const clause = clauses.length ? clauses.map((item) => `(${item})`).join(' AND ') : '1';
    return { sql: wrap(clause), args };
  }
  if (condition === null) return { sql: wrap(`(${type} IS NULL OR ${type} = 'null')`), args: [] };
  return { sql: wrap(`${column} = ?`), args: [bindValue(condition)] };
};

const filterSql = (filter = {}) => {
  const clauses = [];
  const args = [];
  for (const [field, condition] of Object.entries(filter || {})) {
    if (field === '$or' || field === '$and') {
      const parts = (Array.isArray(condition) ? condition : []).map(filterSql);
      if (!parts.length) { clauses.push(field === '$or' ? '0' : '1'); continue; }
      clauses.push(`(${parts.map((part) => `(${part.sql})`).join(field === '$or' ? ' OR ' : ' AND ')})`);
      args.push(...parts.flatMap((part) => part.args));
      continue;
    }
    if (field === '$expr') {
      const [operator, values] = Object.entries(condition || {})[0] || [];
      if (!Array.isArray(values) || values.length !== 2 || !['$lt', '$lte', '$gt', '$gte'].includes(operator)) {
        clauses.push('0');
        continue;
      }
      const sign = { $lt: '<', $lte: '<=', $gt: '>', $gte: '>=' }[operator];
      clauses.push(`${expressionSql(values[0])} ${sign} ${expressionSql(values[1])}`);
      args.push(...expressionArgs(values[0]), ...expressionArgs(values[1]));
      continue;
    }
    const comparison = comparisonSql(field, condition);
    clauses.push(comparison.sql);
    args.push(...comparison.args);
  }
  return { sql: clauses.length ? clauses.map((clause) => `(${clause})`).join(' AND ') : '1', args };
};

const attachDocumentMethods = (document, model = null) => {
  if (!document || typeof document !== 'object') return document;
  if (!Object.hasOwn(document, 'toObject')) {
    Object.defineProperty(document, 'toObject', { enumerable: false, value: () => ({ ...document }) });
  }
  if (model && !Object.hasOwn(document, 'save')) Object.defineProperty(document, 'save', { enumerable: false, value: async () => {
    const saved = await model.findOneAndUpdate({ _id: String(document._id) }, { $set: document }, { new: true });
    return attachDocumentMethods(saved || document, model);
  } });
  return document;
};

const project = (document, selection, excludedByDefault = []) => {
  if (!document) return document;
  const tokens = String(selection || '').split(/\s+/).filter(Boolean);
  const included = tokens.filter((token) => !token.startsWith('-') && !token.startsWith('+'));
  const excluded = new Set([...excludedByDefault, ...tokens.filter((token) => token.startsWith('-')).map((token) => token.slice(1))]);
  const forceIncluded = new Set(tokens.filter((token) => token.startsWith('+')).map((token) => token.slice(1)));
  if (included.length) {
    const output = { _id: document._id };
    for (const path of included) {
      const value = getPath(document, path);
      if (value !== undefined) setPath(output, path, value);
    }
    for (const path of forceIncluded) {
      const value = getPath(document, path);
      if (value !== undefined) setPath(output, path, value);
    }
    return attachDocumentMethods(output);
  }
  const output = { ...document };
  for (const path of excluded) unsetPath(output, path);
  return attachDocumentMethods(output);
};

const updateDocument = (document, update, isInsert = false) => {
  const next = { ...document };
  if (!update || typeof update !== 'object') return next;
  const operators = Object.keys(update).some((key) => key.startsWith('$'));
  if (!operators) {
    for (const [key, value] of Object.entries(update)) setPath(next, key, value);
    return next;
  }
  for (const [operator, changes] of Object.entries(update)) {
    if (!changes || typeof changes !== 'object') continue;
    if (operator === '$set' || (operator === '$setOnInsert' && isInsert)) {
      for (const [path, value] of Object.entries(changes)) setPath(next, path, value);
    } else if (operator === '$unset') {
      for (const path of Object.keys(changes)) unsetPath(next, path);
    } else if (operator === '$inc') {
      for (const [path, amount] of Object.entries(changes)) setPath(next, path, (Number(getPath(next, path)) || 0) + Number(amount));
    } else if (operator === '$max') {
      for (const [path, value] of Object.entries(changes)) if (getPath(next, path) === undefined || getPath(next, path) < value) setPath(next, path, value);
    } else if (operator === '$push' || operator === '$addToSet') {
      for (const [path, raw] of Object.entries(changes)) {
        const list = Array.isArray(getPath(next, path)) ? [...getPath(next, path)] : [];
        const items = raw && typeof raw === 'object' && '$each' in raw ? raw.$each : [raw];
        for (const item of items) if (operator === '$push' || !list.some((existing) => equal(existing, item))) list.push(plain(item));
        setPath(next, path, list);
      }
    } else if (operator === '$pull') {
      for (const [path, condition] of Object.entries(changes)) {
        const list = Array.isArray(getPath(next, path)) ? getPath(next, path) : [];
        setPath(next, path, list.filter((entry) => condition && typeof condition === 'object' ? !matches(entry, condition) : !equal(entry, condition)));
      }
    }
  }
  return next;
};

const querySort = (items, sort) => {
  const entries = Object.entries(sort || {});
  if (!entries.length) return items;
  return items.sort((left, right) => {
    for (const [field, direction] of entries) {
      const a = getPath(left, field);
      const b = getPath(right, field);
      if (equal(a, b)) continue;
      if (a == null) return direction < 0 ? 1 : -1;
      if (b == null) return direction < 0 ? -1 : 1;
      const order = a < b ? -1 : 1;
      return order * (direction < 0 ? -1 : 1);
    }
    return 0;
  });
};

class D1Query {
  constructor(model, filter, mode = 'many') {
    this.model = model;
    this.filter = filter || {};
    this.mode = mode;
    this.sortSpec = null;
    this.offset = 0;
    this.max = null;
    this.selection = '';
    this.executionTimeoutMs = null;
  }

  sort(value) { this.sortSpec = typeof value === 'function' ? null : value; return this; }
  skip(value) { this.offset = Math.max(0, Number(value) || 0); return this; }
  limit(value) { this.max = Math.max(0, Number(value) || 0); return this; }
  select(value) { this.selection = value || ''; return this; }
  maxTimeMS(value) {
    const timeout = Number(value);
    this.executionTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : null;
    return this;
  }
  populate() { return this; }
  collation() { return this; }
  hint() { return this; }
  comment() { return this; }
  batchSize() { return this; }
  setOptions() { return this; }
  read() { return this; }
  lean() { return this; }
  session() { return this; }
  exec() {
    const execution = this.model._executeQuery(this);
    if (!this.executionTimeoutMs) return execution;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`D1 query exceeded ${this.executionTimeoutMs}ms.`);
        error.code = 'D1_QUERY_TIMEOUT';
        reject(error);
      }, this.executionTimeoutMs);
    });
    return Promise.race([execution, timeout]).finally(() => clearTimeout(timer));
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
  finally(callback) { return this.exec().finally(callback); }
}

class D1MutationQuery {
  constructor(operation) {
    this.operation = operation;
    this.promise = null;
    this.selectedFields = null;
  }

  select(fields) {
    this.selectedFields = fields;
    return this;
  }

  populate() {
    return this;
  }

  collation() { return this; }
  hint() { return this; }
  comment() { return this; }
  maxTimeMS() { return this; }
  setOptions() { return this; }
  session() { return this; }
  lean() { return this; }
  exec() {
    this.promise ||= Promise.resolve().then(this.operation).then((doc) => {
      if (this.selectedFields && doc) {
        return project(doc, this.selectedFields);
      }
      return doc;
    });
    return this.promise;
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(reject) { return this.exec().catch(reject); }
  finally(callback) { return this.exec().finally(callback); }
}

export class D1Model {
  constructor(table, { hidden = [] } = {}) {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new TypeError(`Invalid D1 table: ${table}`);
    this.table = table;
    this.hidden = hidden;
    this.defaults = defaultsByTable[table] || {};
    if (!memoryTables.has(table)) memoryTables.set(table, []);
  }

  find(filter = {}) { return new D1Query(this, filter, 'many'); }
  findOne(filter = {}) { return new D1Query(this, filter, 'one'); }
  findById(id) { return this.findOne({ $or: [{ _id: String(id) }, { _id: id }, { id }, { id: String(id) }] }); }
  findByIdAndDelete(id) { return this.findOneAndDelete({ $or: [{ _id: String(id) }, { id }, { id: String(id) }] }); }
  exists(filter = {}) { return this.findOne(filter).select('_id').lean().then((record) => record ? { _id: record._id } : null); }
  countDocuments(filter = {}) { return new D1Query(this, filter, 'count'); }
  estimatedDocumentCount(filter = {}) { return this.countDocuments(filter); }

  async _executeQuery(query) {
    const database = getDatabaseBinding();
    if (query.mode === 'count' && database) {
      const where = filterSql(query.filter);
      const count = await database.prepare(`SELECT COUNT(*) AS total FROM "${this.table}" WHERE ${where.sql}`).bind(...where.args).first();
      return Number(count?.total || 0);
    }
    if (query.mode === 'count') return (memoryTables.get(this.table) || []).filter((document) => matches(document, query.filter)).length;
    let documents;
    if (database) {
      const where = filterSql(query.filter);
      const sort = Object.entries(query.sortSpec || {}).map(([field, direction]) => `json_extract(payload, '${jsonPath(field)}') ${direction < 0 ? 'DESC' : 'ASC'}`).join(', ');
      const pagination = `${query.max != null ? ' LIMIT ?' : ''}${query.offset ? ' OFFSET ?' : ''}`;
      const args = [...where.args];
      if (query.max != null) args.push(query.max);
      else if (query.offset) args.push(-1);
      if (query.offset) args.push(query.offset);
      const result = await database.prepare(`SELECT payload FROM "${this.table}" WHERE ${where.sql}${sort ? ` ORDER BY ${sort}` : ''}${pagination}`).bind(...args).all();
      documents = (result.results || []).map((row) => JSON.parse(row.payload));
    } else {
      documents = (memoryTables.get(this.table) || []).filter((document) => matches(document, query.filter)).map((document) => ({ ...document }));
      if (query.sortSpec) querySort(documents, query.sortSpec);
      if (query.offset) documents = documents.slice(query.offset);
      if (query.max != null) documents = documents.slice(0, query.max);
    }
    const projected = documents.map((document) => attachDocumentMethods(project(document, query.selection, this.hidden), this));
    return query.mode === 'one' ? projected[0] || null : projected;
  }

  _key(document) { return String(document._id || randomUUID()); }

  async _insert(document) {
    const database = getDatabaseBinding();
    const now = new Date().toISOString();
    const row = { ...plain(this.defaults), ...plain(document), _id: String(document._id || randomUUID()) };
    if (typeof row.created_at === 'undefined') row.created_at = now;
    if (typeof row.updated_at === 'undefined') row.updated_at = now;
    const rowKey = this._key(row);
    if (database) {
      try {
        await database.prepare(`INSERT INTO "${this.table}" (row_key, payload) VALUES (?, ?)`).bind(rowKey, JSON.stringify(row)).run();
      } catch (error) {
        if (String(error?.message || '').includes('UNIQUE constraint failed')) error.code = 11000;
        throw error;
      }
    } else {
      const rows = memoryTables.get(this.table);
      if (rows.some((existing) => existing._id === row._id)) {
        const error = new Error(`Duplicate key in ${this.table}`);
        error.code = 11000;
        throw error;
      }
      rows.push(row);
    }
    return attachDocumentMethods(row, this);
  }

  async create(value) {
    if (Array.isArray(value)) return Promise.all(value.map((document) => this._insert(document)));
    return this._insert(value || {});
  }

  async insertMany(values = []) { return Promise.all(values.map((document) => this._insert(document))); }

  findOneAndUpdate(filter, update, options = {}) {
    return new D1MutationQuery(() => this._findOneAndUpdate(filter, update, options));
  }

  async _findOneAndUpdate(filter, update, options = {}) {
    const database = getDatabaseBinding();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await this.findOne(filter).select(this.hidden.map((field) => `+${field}`).join(' ')).lean();
      if (!current) {
        if (!options.upsert) return null;
        const seed = Object.fromEntries(Object.entries(filter || {}).filter(([key, value]) => !key.startsWith('$') && (!value || typeof value !== 'object' || value instanceof Date)));
        const inserted = updateDocument(seed, update, true);
        if (!inserted._id) inserted._id = String(seed._id || randomUUID());
        try {
          const created = await this._insert(inserted);
          return options.new || options.returnDocument === 'after' ? project(created, options.projection, this.hidden) : null;
        } catch (error) {
          if (error?.code === 11000 && attempt < 5) continue;
          throw error;
        }
      }
      const next = updateDocument(current, update, false);
      const rowKey = String(current._id);
      if (database) {
        const result = await database.prepare(`UPDATE "${this.table}" SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE row_key = ? AND payload = ?`).bind(JSON.stringify(next), rowKey, JSON.stringify(current)).run();
        if (!result.meta?.changes) continue;
      } else {
        const rows = memoryTables.get(this.table);
        const index = rows.findIndex((item) => item._id === current._id && JSON.stringify(item) === JSON.stringify(current));
        if (index < 0) continue;
        rows[index] = next;
      }
      return project(options.new || options.returnDocument === 'after' ? next : current, options.projection, this.hidden);
    }
    throw new Error(`Concurrent D1 update could not complete for ${this.table}.`);
  }

  findByIdAndUpdate(id, update, options = {}) {
    return this.findOneAndUpdate({ $or: [{ _id: String(id) }, { id }, { id: String(id) }] }, update, options);
  }

  async updateOne(filter, update, options = {}) {
    const record = await this.findOneAndUpdate(filter, update, { ...options, new: true });
    return { acknowledged: true, matchedCount: record ? 1 : 0, modifiedCount: record ? 1 : 0, upsertedCount: record && options.upsert ? 1 : 0 };
  }

  async updateMany(filter, update) {
    const records = await this.find(filter).select(this.hidden.map((field) => `+${field}`).join(' ')).lean();
    for (const record of records) await this.findOneAndUpdate({ _id: record._id }, update, { new: true });
    return { acknowledged: true, matchedCount: records.length, modifiedCount: records.length };
  }

  findOneAndDelete(filter) {
    return new D1MutationQuery(() => this._findOneAndDelete(filter));
  }

  async _findOneAndDelete(filter) {
    const record = await this.findOne(filter).select(this.hidden.map((field) => `+${field}`).join(' ')).lean();
    if (!record) return null;
    const database = getDatabaseBinding();
    if (database) {
      const where = filterSql({ $and: [{ _id: String(record._id) }, filter] });
      await database.prepare(`DELETE FROM "${this.table}" WHERE row_key = ? AND ${where.sql}`).bind(String(record._id), ...where.args).run();
    }
    else memoryTables.set(this.table, memoryTables.get(this.table).filter((entry) => entry._id !== record._id));
    return attachDocumentMethods(record, this);
  }

  async deleteOne(filter) {
    const record = await this.findOneAndDelete(filter);
    return { acknowledged: true, deletedCount: record ? 1 : 0 };
  }

  async deleteMany(filter = {}) {
    const database = getDatabaseBinding();
    if (database) {
      const where = filterSql(filter);
      const result = await database.prepare(`DELETE FROM "${this.table}" WHERE ${where.sql}`).bind(...where.args).run();
      return { acknowledged: true, deletedCount: Number(result.meta?.changes || 0) };
    }
    const rows = memoryTables.get(this.table);
    const kept = rows.filter((document) => !matches(document, filter));
    memoryTables.set(this.table, kept);
    return { acknowledged: true, deletedCount: rows.length - kept.length };
  }

  async distinct(field, filter = {}) {
    const database = getDatabaseBinding();
    if (database) {
      const path = jsonPath(field);
      const where = filterSql(filter);
      const type = `json_type(payload, '${path}')`;
      const scalar = `SELECT json_extract(payload, '${path}') AS value, ${type} AS value_type FROM "${this.table}" WHERE (${where.sql}) AND ${type} IS NOT NULL AND ${type} <> 'array'`;
      const array = `SELECT item.value AS value, item.type AS value_type FROM "${this.table}" CROSS JOIN json_each(payload, '${path}') AS item WHERE (${where.sql}) AND ${type} = 'array'`;
      const result = await database.prepare(`SELECT DISTINCT value, value_type FROM (${scalar} UNION ALL ${array})`).bind(...where.args, ...where.args).all();
      const values = [];
      const seen = new Set();
      for (const row of result.results || []) {
        let value = row.value;
        if (row.value_type === 'true') value = true;
        else if (row.value_type === 'false') value = false;
        else if (row.value_type === 'object' || row.value_type === 'array') {
          try { value = typeof value === 'string' ? JSON.parse(value) : value; } catch { /* retain driver value */ }
        }
        const key = JSON.stringify(value);
        if (!seen.has(key)) {
          seen.add(key);
          values.push(value);
        }
      }
      return values;
    }
    const rows = await this.find(filter).lean();
    const values = rows.flatMap((row) => {
      const value = getPath(row, field);
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    });
    return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
  }

  async bulkWrite(operations = []) {
    const result = { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, deletedCount: 0 };
    for (const operation of operations) {
      if (operation.updateOne) {
        const outcome = await this.updateOne(operation.updateOne.filter, operation.updateOne.update, operation.updateOne);
        result.matchedCount += outcome.matchedCount;
        result.modifiedCount += outcome.modifiedCount;
        result.upsertedCount += outcome.upsertedCount;
      } else if (operation.deleteOne) {
        const outcome = await this.deleteOne(operation.deleteOne.filter);
        result.deletedCount += outcome.deletedCount;
      } else if (operation.insertOne) await this.create(operation.insertOne.document);
    }
    return result;
  }

  async aggregate(pipeline = []) {
    let rows = await this.find({}).lean();
    for (const stage of pipeline) {
      if (stage.$match) rows = rows.filter((row) => matches(row, stage.$match));
      else if (stage.$group) {
        const { _id: idExpression, ...aggregates } = stage.$group;
        const buckets = new Map();
        for (const row of rows) {
          let key = idExpression;
          if (idExpression?.$dateToString) {
            const dateField = idExpression.$dateToString.date?.$convert?.input?.slice(1) || idExpression.$dateToString.date?.slice(1);
            const date = new Date(getPath(row, dateField));
            key = Number.isNaN(date.getTime()) ? null : idExpression.$dateToString.format === '%Y-%m' ? date.toISOString().slice(0, 7) : date.toISOString().slice(0, 10);
          } else if (typeof idExpression === 'string' && idExpression.startsWith('$')) key = getPath(row, idExpression.slice(1));
          if (key == null) continue;
          const id = JSON.stringify(key);
          const bucket = buckets.get(id) || { _id: key };
          for (const [name, accumulator] of Object.entries(aggregates)) {
            if ('$sum' in accumulator) {
              const expression = accumulator.$sum;
              const value = expression === 1 ? 1 : typeof expression === 'string' && expression.startsWith('$') ? Number(getPath(row, expression.slice(1))) || 0 : Number(expression?.$ifNull ? getPath(row, expression.$ifNull[0].slice(1)) ?? expression.$ifNull[1] : expression) || 0;
              bucket[name] = (bucket[name] || 0) + value;
            }
          }
          buckets.set(id, bucket);
        }
        rows = [...buckets.values()];
      } else if (stage.$sort) rows = querySort(rows, stage.$sort);
      else if (stage.$limit) rows = rows.slice(0, stage.$limit);
    }
    return rows;
  }
}

export const isDuplicateKeyError = (error) => error?.code === 11000 || String(error?.message || '').includes('UNIQUE constraint failed');
