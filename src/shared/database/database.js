import { getDatabaseBinding } from './runtime.js';

// Shared persistence predicate for repositories. The backing database is D1.
export const isDatabaseConnected = () => Boolean(getDatabaseBinding());
export const databaseStatus = () => getDatabaseBinding() ? 'connected' : 'memory';
export const connectDatabase = async () => Boolean(getDatabaseBinding());
export const disconnectDatabase = async () => {};
