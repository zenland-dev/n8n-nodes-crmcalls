import type { IDataObject, INode, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/**
 * What a catch block rethrows. Errors from the transport and from parameter reading
 * are already n8n errors carrying a message the user can act on, and pass through
 * untouched; anything else is wrapped so n8n can show it against the node.
 */
export function asNodeError(
	node: INode,
	error: unknown,
	itemIndex?: number,
): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeOperationError(node, error instanceof Error ? error : String(error), {
		itemIndex,
	});
}

/** A CRMCalls failure, read from the body and the status. */
export interface CrmCallsFailure {
	/** The error code, e.g. validation_error; '' when the body names none. */
	code: string;
	/** CRMCalls' own explanation, usually in Russian; '' when there is none. */
	message: string;
	/** Field-by-field reasons, e.g. { phones: ["Некорректный номер телефона"] }. */
	details: unknown;
	/** Seconds to wait, sent with import_rate_limit. */
	retryAfter?: number;
	status: number;
}

/**
 * Reads a failure out of a response, or returns undefined for a success.
 *
 * CRMCalls answers every error as `{ error: { code, message, details } }` with a
 * 4xx or 5xx status; `retry_after` comes with import_rate_limit, inside the error
 * or beside it. A 2xx is a success.
 */
export function readFailure(body: unknown, status: number): CrmCallsFailure | undefined {
	if (status >= 200 && status < 300) return undefined;

	const object =
		body !== null && typeof body === 'object' && !Array.isArray(body)
			? (body as IDataObject)
			: undefined;
	const error = object?.error;
	const nested =
		error !== null && typeof error === 'object' && !Array.isArray(error)
			? (error as IDataObject)
			: undefined;

	const retryAfter = Number(nested?.retry_after ?? object?.retry_after);

	return {
		code: String(nested?.code ?? (typeof error === 'string' ? error : '')),
		message: String(nested?.message ?? object?.message ?? ''),
		details: nested?.details ?? object?.details,
		retryAfter: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
		status,
	};
}

/** What to tell a person, per error code. Codes not listed fall back to the status hint. */
const HINTS: Record<string, string> = {
	unauthorized:
		'CRMCalls did not accept the API key: it is missing, mistyped or revoked. Create a new key under Интеграции → API and put it into the credential.',
	validation_error: 'CRMCalls named the fields it objected to below.',
	rate_limit_exceeded:
		'More than 10 requests in a second went out with this key. Lower Requests per Second in the credential; with several n8n workers or instances on one key, divide the limit between them or give each its own key.',
	import_rate_limit:
		'CRMCalls takes one bulk import per key every 30 seconds. Put all contacts into one import (every input item of Contact → Import goes into one request), or wait before the next one.',
	record_not_ready: 'The call recording is still being processed. Try again in a minute.',
	record_unavailable:
		'There is no recording of this call: the call was not connected, or the recording is gone.',
};

/** What to tell a person when the code is not one of the above, per HTTP status. */
const STATUS_HINTS: Record<number, string> = {
	400: 'CRMCalls could not read the request: broken JSON, an empty contact list, an unknown deduplication mode, Custom Fields that are not an object, or an unknown project status.',
	401: HINTS.unauthorized,
	404: 'Nothing with this ID exists in the organization: the contact, import, scenario or project was not found, was deleted, or belongs to another organization.',
	422: 'CRMCalls refused the data. For a contact, check the phone (a valid Russian number is required) and the deduplication mode; for an import, the project must not be finished and the import must hold at most 100,000 contacts.',
	429: HINTS.rate_limit_exceeded,
};

/** `details` of a failure, as one line a person can read, or undefined. */
function describeDetails(details: unknown): string | undefined {
	if (details === undefined || details === null) return undefined;

	if (typeof details === 'object' && !Array.isArray(details)) {
		const parts = Object.entries(details as IDataObject).map(([field, reasons]) => {
			const text = Array.isArray(reasons)
				? (reasons as unknown[]).map(String).join('; ')
				: reasons !== null && typeof reasons === 'object'
					? JSON.stringify(reasons)
					: String(reasons);
			return `${field}: ${text}`;
		});
		return parts.length > 0 ? `Details: ${parts.join(' | ')}` : undefined;
	}

	if (Array.isArray(details)) {
		return details.length > 0
			? `Details: ${details.map((d) => JSON.stringify(d)).join('; ')}`
			: undefined;
	}

	return `Details: ${String(details)}`;
}

/** Turns a CRMCalls failure into the error n8n shows, with advice where there is any. */
export function toNodeApiError(
	node: INode,
	label: string,
	failure: CrmCallsFailure,
	body: unknown,
	itemIndex?: number,
): NodeApiError {
	const code = failure.code;
	const text = failure.message !== '' ? failure.message : code || `HTTP ${failure.status}`;
	const message = code !== '' && code !== text ? `${text} [${code}]` : text;

	const hint = HINTS[code] ?? STATUS_HINTS[failure.status];
	const wait =
		failure.retryAfter !== undefined ? `CRMCalls asks to wait ${failure.retryAfter} s.` : undefined;
	const description = [hint, describeDetails(failure.details), wait]
		.filter((part) => part !== undefined)
		.join(' ');

	return new NodeApiError(
		node,
		(body !== null && typeof body === 'object' ? body : {}) as JsonObject,
		{
			message: `CRMCalls ${label}: ${message}`,
			description: description === '' ? undefined : description,
			httpCode: String(failure.status),
			itemIndex,
		},
	);
}
