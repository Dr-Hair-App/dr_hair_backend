const formatterCache = new Map();

export const isValidTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
};

export const clinicDateTimeParts = (date, timeZone) => {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return Object.fromEntries(formatterCache.get(timeZone).formatToParts(date).map(({ type, value }) => [type, value]));
};

// Convert a clinic-local calendar date boundary to UTC without relying on the server host timezone.
export const clinicDateBoundary = (dateKey, timeZone) => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const targetUtc = Date.UTC(year, month - 1, day);
  let candidate = targetUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = clinicDateTimeParts(new Date(candidate), timeZone);
    const representedUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const correction = targetUtc - representedUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
};
