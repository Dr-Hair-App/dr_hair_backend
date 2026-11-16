let workerBindings = null;

export const setWorkerBindings = (bindings) => {
  if (!bindings?.DB || typeof bindings.DB.prepare !== 'function') {
    throw new TypeError('A Cloudflare D1 binding is required.');
  }
  workerBindings = bindings;
};

export const setDatabaseBinding = (binding) => setWorkerBindings({ ...workerBindings, DB: binding });
export const getWorkerBindings = () => workerBindings;
export const getDatabaseBinding = () => workerBindings?.DB || null;

export const clearDatabaseBinding = () => {
  workerBindings = null;
};
