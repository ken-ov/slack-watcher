// Log timestamps in Vietnam local time (UTC+7), e.g. [2026-06-12T11:23:02.341+07:00]
const UTC_OFFSET_HOURS = 7;

export const stamp = () =>
  new Date(Date.now() + UTC_OFFSET_HOURS * 3_600_000).toISOString().replace("Z", "+07:00");

export const log = (msg) => console.log(`[${stamp()}] ${msg}`);
