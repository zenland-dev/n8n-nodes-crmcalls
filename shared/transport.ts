import { createHash } from 'node:crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, randomInt, sleep } from 'n8n-workflow';

import {
	API_ORIGIN,
	API_VERSION_PATH,
	normalizeApiKey,
} from '../credentials/CrmCallsCcApi.credentials';
import { readFailure, toNodeApiError } from './errors';
import { acquireSlot } from './rateLimiter';

/** Every context the node makes API calls from. */
export type CrmCallsContext = IExecuteFunctions | ILoadOptionsFunctions;

export const CREDENTIAL = 'crmCallsCcApi';

/** CRMCalls' window: 10 requests in every second, per key. */
const WINDOW_MS = 1000;

/** What an empty or unreadable setting means: the credential's default. */
const DEFAULT_BUDGET = 8;

/**
 * The longest `retry_after` the node waits out on its own. CRMCalls asks for up
 * to 30 seconds between bulk imports; anything longer is reported instead.
 */
const MAX_RETRY_AFTER_S = 60;

export interface CrmCallsRequestOptions {
	qs?: IDataObject;
	body?: unknown;
	/** Item the call is made for, so an error points at it. */
	itemIndex?: number;
	/**
	 * Whether a server error or a dropped connection may be repeated. True for the
	 * reads. False for a bulk import, where a repeat is a second import and, with a
	 * project, a second round of calls to the same people; and for a single
	 * contact in `ignore` mode, where a repeat is a duplicate contact.
	 */
	retry?: boolean;
	/** Total attempts, including the first one. */
	maxAttempts?: number;
}

/**
 * A path under the API, as it is sent. `/contacts` becomes `/api/v1/contacts`; a
 * path that already starts with `/api/` is kept.
 */
export function apiPath(path: string): string {
	const trimmed = path.trim();
	const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
	return /^\/api\//.test(withSlash) ? withSlash : `${API_VERSION_PATH}${withSlash}`;
}

/** A short, stable name for a key, for caches and the rate limiter. Never the key itself. */
export function keyFingerprint(apiKey: string): string {
	return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/** The fingerprint of the key in the credential. */
export async function accountKey(this: CrmCallsContext): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIAL);
	return keyFingerprint(normalizeApiKey(credentials.apiKey));
}

function backoffDelay(attempt: number): number {
	return Math.min(2 ** (attempt - 1) * 1000, 8000) + randomInt(250);
}

function isEmpty(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * One call to the CRMCalls API, rate-limited and retried where that is safe.
 *
 * 429 is repeated on every route: CRMCalls refuses the request before doing
 * anything. A plain 429 waits out the one-second window; import_rate_limit waits
 * the `retry_after` it names, up to a minute. Server errors and network failures
 * are repeated unless `retry` is false. Anything else becomes a NodeApiError
 * carrying CRMCalls' code, its field-by-field details and, where there is one,
 * advice.
 *
 * Returns the body as CRMCalls sent it.
 */
export async function crmCallsRequest(
	this: CrmCallsContext,
	method: IHttpRequestMethods,
	path: string,
	options: CrmCallsRequestOptions = {},
): Promise<unknown> {
	const credentials = await this.getCredentials(CREDENTIAL);
	const apiKey = normalizeApiKey(credentials.apiKey);

	if (apiKey === '') {
		throw new NodeOperationError(this.getNode(), 'The CRMCalls credential has no API key', {
			description: 'Open the credential and paste the key from Интеграции → API in CRMCalls.',
			itemIndex: options.itemIndex,
		});
	}

	const setting = Math.floor(Number(credentials.requestsPerSecond));
	const budget = Number.isFinite(setting) && setting >= 1 ? setting : DEFAULT_BUDGET;
	const limiterKey = `crmcalls:${keyFingerprint(apiKey)}`;
	const route = apiPath(path);
	const label = `${method} ${route}`;

	const request: IHttpRequestOptions = {
		method,
		url: `${API_ORIGIN}${route}`,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		headers: { Accept: 'application/json' },
	};
	if (!isEmpty(options.qs)) request.qs = options.qs;
	if (options.body !== undefined) request.body = options.body as IDataObject;

	const retry = options.retry !== false;
	const maxAttempts = options.maxAttempts ?? 4;

	for (let attempt = 1; ; attempt++) {
		// The limit is the key's, so every workflow on this instance using the same
		// key draws from one window.
		await acquireSlot(limiterKey, budget, WINDOW_MS);

		let response: IN8nHttpFullResponse;
		try {
			response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				CREDENTIAL,
				request,
			)) as IN8nHttpFullResponse;
		} catch (error) {
			if (retry && attempt < maxAttempts) {
				await sleep(backoffDelay(attempt));
				continue;
			}
			throw new NodeApiError(this.getNode(), { message: 'Network error' } as JsonObject, {
				message: `CRMCalls ${label}: the API could not be reached`,
				description: error instanceof Error ? error.message : undefined,
				itemIndex: options.itemIndex,
			});
		}

		const status = Number(response.statusCode) || 0;
		const body = response.body;
		const failure = readFailure(body, status);

		if (failure === undefined) return body;

		if (status === 429 && attempt < maxAttempts) {
			const wait = failure.retryAfter;
			if (wait === undefined) {
				await sleep(WINDOW_MS + randomInt(250));
				continue;
			}
			if (wait <= MAX_RETRY_AFTER_S) {
				await sleep(wait * 1000 + randomInt(500));
				continue;
			}
		}

		if (retry && status >= 500 && attempt < maxAttempts) {
			await sleep(backoffDelay(attempt));
			continue;
		}

		throw toNodeApiError(this.getNode(), label, failure, body, options.itemIndex);
	}
}

export interface DownloadedFile {
	data: Buffer;
	mimeType: string;
}

/**
 * Downloads a file under the API host, e.g. a call recording at
 * `/api/recordings/<call id>`.
 *
 * The recording link answered without the key on 06.10.2026; the key is sent
 * anyway, since the host is the same and the documentation does not promise the
 * link stays open. A JSON answer with a 2xx other than the file (202
 * record_not_ready) and every 4xx become errors; 429 and server errors are
 * repeated as for any read.
 */
export async function crmCallsDownload(
	this: IExecuteFunctions,
	path: string,
	itemIndex: number,
): Promise<DownloadedFile> {
	const credentials = await this.getCredentials(CREDENTIAL);
	const apiKey = normalizeApiKey(credentials.apiKey);
	const setting = Math.floor(Number(credentials.requestsPerSecond));
	const budget = Number.isFinite(setting) && setting >= 1 ? setting : DEFAULT_BUDGET;
	const limiterKey = `crmcalls:${keyFingerprint(apiKey)}`;
	const route = path.startsWith('/') ? path : `/${path}`;
	const label = `GET ${route}`;
	const maxAttempts = 4;

	for (let attempt = 1; ; attempt++) {
		await acquireSlot(limiterKey, budget, WINDOW_MS);

		let response: IN8nHttpFullResponse;
		try {
			response = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, {
				method: 'GET',
				url: `${API_ORIGIN}${route}`,
				encoding: 'arraybuffer',
				json: false,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			})) as IN8nHttpFullResponse;
		} catch (error) {
			if (attempt < maxAttempts) {
				await sleep(backoffDelay(attempt));
				continue;
			}
			throw new NodeApiError(this.getNode(), { message: 'Network error' } as JsonObject, {
				message: `CRMCalls ${label}: the file could not be downloaded`,
				description: error instanceof Error ? error.message : undefined,
				itemIndex,
			});
		}

		const status = Number(response.statusCode) || 0;
		const headers = (response.headers ?? {}) as IDataObject;
		const mimeType = String(headers['content-type'] ?? 'application/octet-stream')
			.split(';')[0]
			.trim();
		const data = Buffer.from(response.body as ArrayBuffer);

		if ((status === 200 || status === 206) && mimeType !== 'application/json') {
			return { data, mimeType };
		}

		let body: unknown = {};
		try {
			body = JSON.parse(data.toString('utf8'));
		} catch {
			body = {};
		}
		// 202 record_not_ready is a success status carrying an error.
		const failure = readFailure(body, status >= 200 && status < 300 ? 409 : status) ?? {
			code: '',
			message: '',
			details: undefined,
			status,
		};
		failure.status = status;

		if (status === 429 && attempt < maxAttempts) {
			await sleep(WINDOW_MS + randomInt(250));
			continue;
		}
		if (status >= 500 && attempt < maxAttempts) {
			await sleep(backoffDelay(attempt));
			continue;
		}

		throw toNodeApiError(this.getNode(), label, failure, body, itemIndex);
	}
}

/** `data` of an answer: every documented route wraps its payload in it. */
export function dataOf(body: unknown): unknown {
	if (body !== null && typeof body === 'object' && !Array.isArray(body) && 'data' in body) {
		return (body as IDataObject).data;
	}
	return body;
}

/**
 * The rows of a list answer.
 *
 * Most lists answer `{ data: [...] }`. The custom field directory nests its list
 * one level deeper, `{ data: { custom_fields: [...] } }`, so an object holding a
 * single array is read as that array. Anything else is one row.
 */
export function rowsOf(body: unknown): IDataObject[] {
	const data = dataOf(body);
	if (Array.isArray(data)) return data as IDataObject[];
	if (data === null || data === undefined || typeof data !== 'object') return [];

	const record = data as IDataObject;
	const arrays = Object.values(record).filter(Array.isArray);
	if (arrays.length === 1 && Object.keys(record).length === 1) return arrays[0] as IDataObject[];

	return Object.keys(record).length === 0 ? [] : [record];
}

/** The most rows CRMCalls hands out per page. */
export const MAX_PAGE_SIZE = 200;

/**
 * Reads a paged list — `GET /contacts`, `/calls`, `/projects` — page by page.
 *
 * These take `page` (from 1) and `per_page` (up to 200) and answer
 * `{ data, pagination: { page, per_page, total, total_pages } }`. The page size
 * stays the same for the whole read: CRMCalls works the offset out of both, so a
 * smaller last page would skip rows. `limit` stops early.
 */
export async function readPages(
	this: IExecuteFunctions,
	path: string,
	qs: IDataObject,
	limit: number | undefined,
	itemIndex: number,
): Promise<IDataObject[]> {
	const perPage = limit === undefined ? MAX_PAGE_SIZE : Math.min(limit, MAX_PAGE_SIZE);
	const rows: IDataObject[] = [];

	for (let page = 1; ; page++) {
		const body = await crmCallsRequest.call(this, 'GET', path, {
			qs: { ...qs, page, per_page: perPage },
			itemIndex,
		});
		const batch = rowsOf(body);
		rows.push(...batch);

		if (limit !== undefined && rows.length >= limit) return rows.slice(0, limit);
		if (batch.length < perPage) return rows;

		const pagination = (body as IDataObject | undefined)?.pagination as IDataObject | undefined;
		const totalPages = Number(pagination?.total_pages);
		if (Number.isFinite(totalPages) && page >= totalPages) return rows;
	}
}
