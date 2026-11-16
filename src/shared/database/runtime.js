import { AsyncLocalStorage } from 'node:async_hooks';

let workerBindings = null;
const requestDatabaseBinding = new AsyncLocalStorage();

export const setWorkerBindings = (bindings) => {
  if (!bindings?.DB || typeof bindings.DB.prepare !== 'function') {
    throw new TypeError('A Cloudflare D1 binding is required.');
  }
  workerBindings = bindings;
};

export const setDatabaseBinding = (binding) => setWorkerBindings({ ...workerBindings, DB: binding });
export const getWorkerBindings = () => workerBindings;
export const getDatabaseBinding = () => requestDatabaseBinding.getStore() || workerBindings?.DB || null;

export const runWithDatabaseBinding = (binding, callback) =>
  requestDatabaseBinding.run(binding, callback);

export const clearDatabaseBinding = () => {
  workerBindings = null;
};
