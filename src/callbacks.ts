import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { CollectionTask } from './contracts.js';

export interface CallbackCandidate {
  id: string;
  text: string;
  at: string;
}

export type CallbackValidity = 'valid' | 'past' | 'after_deadline' | 'invalid';

export function validateCallbackAt(
  task: CollectionTask,
  at: string,
  now: Date,
): CallbackValidity {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(at)) return 'invalid';
  const time = DateTime.fromISO(at, { setZone: true });
  const localNow = DateTime.fromJSDate(now, { zone: task.timezone });
  if (!time.isValid || !localNow.isValid) return 'invalid';
  if (time.toMillis() <= now.getTime()) return 'past';
  const deadline = DateTime.fromISO(task.deadline, {
    zone: task.timezone,
  }).endOf('day');
  if (localNow <= deadline && time > deadline) return 'after_deadline';
  return 'valid';
}

export function callbackCandidates(
  text: string,
  task: CollectionTask,
  now: Date,
): CallbackCandidate[] {
  const local = DateTime.fromJSDate(now, { zone: task.timezone });
  const parsed = chrono.parse(
    text,
    { instant: now, timezone: local.offset },
    { forwardDate: true },
  );
  const candidates: CallbackCandidate[] = [];
  for (const item of parsed) {
    if (item.end || !item.start.isCertain('hour')) continue;
    const relative =
      /\b(?:in|after)\s+(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|sixty|half)\s+(?:seconds?|minutes?|hours?)\b/i.test(
        item.text,
      );
    if (!relative && !hasExplicitClock(item)) continue;
    const instant = relative
      ? DateTime.fromJSDate(item.start.date())
      : localInstant(item, task.timezone);
    if (!instant?.isValid) continue;
    const at = instant.toUTC().toISO();
    if (at)
      candidates.push({
        id: `callback_${candidates.length}`,
        text: item.text,
        at,
      });
    if (candidates.length === 24) break;
  }
  return candidates;
}

function hasExplicitClock(item: chrono.ParsedResult): boolean {
  return (
    item.start.isCertain('meridiem') ||
    /\b(?:[01]\d|2[0-3]):[0-5]\d\b|\b(?:noon|midnight)\b/i.test(item.text)
  );
}

function localInstant(
  item: chrono.ParsedResult,
  timezone: string,
): DateTime | null {
  const year = item.start.get('year');
  const month = item.start.get('month');
  const day = item.start.get('day');
  const hour = item.start.get('hour');
  const minute = item.start.get('minute');
  const second = item.start.get('second') ?? 0;
  if (
    year === null ||
    month === null ||
    day === null ||
    hour === null ||
    minute === null
  )
    return null;
  const zone = item.start.isCertain('timezoneOffset')
    ? `UTC${offsetString(item.start.get('timezoneOffset') ?? 0)}`
    : timezone;
  const result = DateTime.fromObject(
    { year, month, day, hour, minute, second },
    { zone },
  );
  if (
    !result.isValid ||
    result.year !== year ||
    result.month !== month ||
    result.day !== day ||
    result.hour !== hour ||
    result.minute !== minute
  )
    return null;
  if (result.getPossibleOffsets().length !== 1) return null;
  return result;
}

function offsetString(minutes: number): string {
  const magnitude = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(magnitude / 60)).padStart(2, '0')}:${String(magnitude % 60).padStart(2, '0')}`;
}
