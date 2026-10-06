/**
 * Dates as CRMCalls takes them.
 *
 * CRMCalls answers every date in Moscow time with its offset, `+03:00`, and reads
 * a date it is sent the same way: with a zone it is an exact moment, without one
 * it is Moscow wall time. n8n's date picker hands over wall time with no zone,
 * meant in the workflow's timezone. Sent as it is, a workflow in Yekaterinburg
 * would filter calls two hours off. So every moment goes out as Moscow time with
 * the offset written in, `2026-09-28T10:00:00+03:00`, the form the documentation
 * itself uses.
 *
 * Moscow has kept UTC+3 all year round since 2014, so the offset is a constant.
 *
 * A bare date is left alone: CRMCalls reads it as a Moscow calendar day, and in
 * a `*_to` filter as the whole of that day, which a moment cannot express.
 *
 * Unparseable text is passed through unchanged, so that CRMCalls names the
 * problem in its answer instead of the filter silently going missing.
 */

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WITH_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;
const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;

/**
 * `28.09.2026` and `28.09.2026 15:30` — the way CRMCalls' own interface and its
 * documentation write a date. Day first; slashes are not accepted, because
 * `03/01/2026` is ambiguous.
 */
const DOTTED = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

const pad = (n: number | string): string => String(n).padStart(2, '0');

interface Wall {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

/** How `date` reads on a clock in `timeZone`. */
function wallParts(date: Date, timeZone: string): Wall {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-GB', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		})
			.formatToParts(date)
			.map((p) => [p.type, p.value]),
	);
	return {
		year: +parts.year,
		month: +parts.month,
		day: +parts.day,
		hour: +parts.hour,
		minute: +parts.minute,
		second: +parts.second,
	};
}

/** The moment a wall time in `timeZone` stands for. */
function instantOfWall(wall: Wall, timeZone: string): Date {
	const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
	let seen: Wall;
	try {
		seen = wallParts(new Date(guess), timeZone);
	} catch {
		// A zone name Node.js does not know: read the wall time as UTC rather than fail.
		return new Date(guess);
	}
	const offset =
		Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) - guess;
	return new Date(guess - offset);
}

/** `2026-09-28T10:00:00+03:00` for a moment. */
export function moscowTime(date: Date): string {
	return `${new Date(date.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 19)}+03:00`;
}

/** A value as a moment, or undefined when it is not a date at all. */
function instantOf(value: string, timeZone: string): Date | undefined {
	if (WITH_ZONE.test(value)) {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}

	const iso = WALL.exec(value);
	if (iso !== null) {
		const [, y, mo, d, h, mi, s] = iso;
		return instantOfWall(
			{ year: +y, month: +mo, day: +d, hour: +(h ?? 0), minute: +(mi ?? 0), second: +(s ?? 0) },
			timeZone,
		);
	}

	const dotted = DOTTED.exec(value);
	if (dotted !== null) {
		const [, d, mo, y, h, mi, s] = dotted;
		return instantOfWall(
			{ year: +y, month: +mo, day: +d, hour: +(h ?? 0), minute: +(mi ?? 0), second: +(s ?? 0) },
			timeZone,
		);
	}

	return undefined;
}

function textOf(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = String(value).trim();
	return text === '' ? undefined : text;
}

/**
 * A date filter (`updated_from`, `started_to`…) as CRMCalls takes it.
 *
 * A bare date stays a bare date, `28.09.2026` becomes `2026-09-28`; anything
 * with a time becomes a Moscow moment, read in `timeZone` when it has no zone.
 */
export function toFilterDate(value: unknown, timeZone: string): string | undefined {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? undefined : moscowTime(value);
	}

	const text = textOf(value);
	if (text === undefined) return undefined;
	if (DATE_ONLY.test(text)) return text;

	const dottedDay = DOTTED.exec(text);
	if (dottedDay !== null && dottedDay[4] === undefined) {
		return `${dottedDay[3]}-${pad(dottedDay[2])}-${pad(dottedDay[1])}`;
	}

	const instant = instantOf(text, timeZone);
	return instant === undefined ? text : moscowTime(instant);
}

/**
 * A value for a custom field of type `date`: `YYYY-MM-DD`.
 *
 * A wall time keeps its own calendar day; a moment with a zone is read on the
 * workflow's clock, so `2026-09-28T23:30:00Z` is the 29th for a workflow in
 * Moscow. That matches what the person picking the date saw.
 */
export function toFieldDate(value: unknown, timeZone: string): string | undefined {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return undefined;
		const wall = wallParts(value, timeZone);
		return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
	}

	const text = textOf(value);
	if (text === undefined) return undefined;

	if (WITH_ZONE.test(text)) {
		const date = new Date(text);
		if (Number.isNaN(date.getTime())) return text;
		try {
			const wall = wallParts(date, timeZone);
			return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
		} catch {
			return date.toISOString().slice(0, 10);
		}
	}

	const iso = WALL.exec(text);
	if (iso !== null) return `${iso[1]}-${iso[2]}-${iso[3]}`;

	const dotted = DOTTED.exec(text);
	if (dotted !== null) return `${dotted[3]}-${pad(dotted[2])}-${pad(dotted[1])}`;

	return text;
}

/** A value for a custom field of type `datetime`: a Moscow moment. */
export function toFieldDateTime(value: unknown, timeZone: string): string | undefined {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? undefined : moscowTime(value);
	}

	const text = textOf(value);
	if (text === undefined) return undefined;

	const instant = instantOf(text, timeZone);
	return instant === undefined ? text : moscowTime(instant);
}
