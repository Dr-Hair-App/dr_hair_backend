import crypto from 'crypto';

export const isServerRequestId = (value) =>
  typeof value === 'string' && /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function requestIdMiddleware(req, res, next) {
  // Keep a server-owned ID for logs and persisted telemetry. A caller may
  // provide a safe correlation header for compatibility, but must not be able
  // to choose an ID that appears server-generated in Admin traffic records.
  const serverRequestId = 'req_' + crypto.randomUUID();
  const incomingId = req.headers['x-request-id'];
  const normalizedIncomingId = typeof incomingId === 'string' ? incomingId.trim() : '';
  const requestId = (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalizedIncomingId))
    ? normalizedIncomingId
    : serverRequestId;

  req.id = requestId;
  req.serverRequestId = serverRequestId;
  res.setHeader('x-request-id', requestId);
  // Keep the compatibility header above caller-controllable while exposing a
  // separate server-owned ID that matches persisted Admin API traffic.
  res.setHeader('x-server-request-id', serverRequestId);
  next();
}
