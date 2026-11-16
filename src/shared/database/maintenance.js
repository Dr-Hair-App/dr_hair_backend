/** Remove short-lived OTP, session, and rate-limit records on the D1 schedule. */
export async function processExpiredData(database) {
  if (!database?.prepare) throw new TypeError('A D1 database binding is required.');
  const now = new Date().toISOString();
  await database.batch([
    database.prepare("DELETE FROM otps WHERE json_extract(payload, '$.expiresAt') <= ?").bind(now),
    database.prepare("DELETE FROM auth_sessions WHERE json_extract(payload, '$.expiresAt') <= ?").bind(now),
    database.prepare("DELETE FROM rate_limit_counters WHERE json_extract(payload, '$.resetTime') <= ?").bind(now),
  ]);
}
