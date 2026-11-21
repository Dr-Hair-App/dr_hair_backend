import { AsyncLocalStorage } from 'node:async_hooks';

const executionContextStorage = new AsyncLocalStorage();

export const runWithExecutionContext = (executionContext, callback) =>
  executionContextStorage.run(executionContext, callback);

export const getExecutionContext = () => executionContextStorage.getStore() || null;
