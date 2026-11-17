import crypto from 'crypto';

export function requestIdMiddleware(req, res, next) {
  const incomingId = req.headers['x-request-id'];
  const normalizedIncomingId = typeof incomingId === 'string' ? incomingId.trim() : '';
  const requestId = (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalizedIncomingId))
    ? normalizedIncomingId
    : 'req_' + crypto.randomUUID();

  req.id = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}
