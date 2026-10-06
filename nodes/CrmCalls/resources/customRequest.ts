import type { IDataObject, IExecuteFunctions, IHttpRequestMethods } from 'n8n-workflow';
import { jsonParse, NodeOperationError } from 'n8n-workflow';

import { API_ORIGIN } from '../../../credentials/CrmCallsCcApi.credentials';
import type { Resource } from '../../../shared/spec';
import { apiPath, crmCallsRequest } from '../../../shared/transport';

/**
 * The escape hatch: any call to the CRMCalls API, through the same key, rate
 * limit and error messages as the modelled operations.
 *
 * It exists so that a route this node does not model — one added to the API
 * after it was written — never forces a bare HTTP Request node, which the
 * credential is deliberately kept out of.
 */
const METHODS: IHttpRequestMethods[] = ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'];

const METHODS_WITH_BODY = ['DELETE', 'PATCH', 'POST', 'PUT'];

function readMethod(ctx: IExecuteFunctions, itemIndex: number): IHttpRequestMethods {
	const method = String(ctx.getNodeParameter('method', itemIndex, 'GET')).toUpperCase();
	if (!METHODS.includes(method as IHttpRequestMethods)) {
		throw new NodeOperationError(ctx.getNode(), `"${method}" is not a method this node sends`, {
			itemIndex,
			description: `Pick one of ${METHODS.join(', ')}.`,
		});
	}
	return method as IHttpRequestMethods;
}

/**
 * The path, checked before it is sent. A full URL is refused rather than
 * stripped: the request always goes to the CRMCalls API with the key attached,
 * and one that looks like it points elsewhere is a mistake worth stopping.
 */
function readPath(ctx: IExecuteFunctions, itemIndex: number): string {
	const path = String(ctx.getNodeParameter('path', itemIndex, '') ?? '').trim();

	if (path === '') {
		throw new NodeOperationError(ctx.getNode(), 'A custom request needs a path', {
			itemIndex,
			description: 'For example /api/v1/tags or just /tags.',
		});
	}

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('//')) {
		throw new NodeOperationError(ctx.getNode(), 'The path must not be a full URL', {
			itemIndex,
			description: `Keep only the path, as in /api/v1/tags. Every request goes to ${API_ORIGIN}; this node cannot call another host.`,
		});
	}

	return apiPath(path);
}

function readQuery(ctx: IExecuteFunctions, itemIndex: number): IDataObject {
	const ui = ctx.getNodeParameter('queryParameters', itemIndex, {}) as IDataObject;
	const qs: IDataObject = {};
	for (const row of (ui.parameter ?? []) as IDataObject[]) {
		const name = String(row.name ?? '').trim();
		if (name !== '') qs[name] = row.value;
	}
	return qs;
}

function readBody(ctx: IExecuteFunctions, itemIndex: number, method: IHttpRequestMethods): unknown {
	if (!METHODS_WITH_BODY.includes(method)) return undefined;

	const raw = ctx.getNodeParameter('body', itemIndex, '') as unknown;
	if (raw === undefined || raw === null || raw === '') return undefined;
	if (typeof raw === 'object') return raw;

	const value = String(raw).trim();
	if (value === '') return undefined;

	try {
		return jsonParse<unknown>(value);
	} catch (error) {
		throw new NodeOperationError(ctx.getNode(), 'The body is not valid JSON', {
			itemIndex,
			description: `${error instanceof Error ? error.message : String(error)}. CRMCalls takes JSON only; an expression returning an object or an array works too.`,
		});
	}
}

/** One output row per list entry in Automatic mode; the body as it came otherwise. */
function toRows(body: unknown, format: string): IDataObject[] {
	if (body === undefined || body === null || body === '') return [{ success: true }];
	if (typeof body !== 'object') return [{ data: body as string }];

	if (format === 'auto') {
		const record = body as IDataObject;
		const list = Array.isArray(body) ? body : Array.isArray(record.data) ? record.data : undefined;
		if (list !== undefined) {
			return (list as unknown[]).map((row) =>
				row !== null && typeof row === 'object' && !Array.isArray(row)
					? (row as IDataObject)
					: { value: row as string },
			);
		}
		if (record.data !== null && typeof record.data === 'object')
			return [record.data as IDataObject];
	}

	return Array.isArray(body) ? [{ data: body as IDataObject[] }] : [body as IDataObject];
}

export const customRequestResource: Resource = {
	value: 'customRequest',
	name: 'Custom Request',
	description:
		'Any CRMCalls API call the other operations do not cover, with the same key and rate limit',
	operations: [
		{
			value: 'request',
			name: 'Request',
			action: 'Make a custom API call',
			description:
				'Send any request to the CRMCalls API, such as a route added after this node was written, with authentication, the rate limit and error messages handled as everywhere else',
			properties: [
				{
					displayName: 'Method',
					name: 'method',
					type: 'options',
					default: 'GET',
					options: METHODS.map((m) => ({ name: m, value: m })),
				},
				{
					displayName: 'Path',
					name: 'path',
					type: 'string',
					required: true,
					default: '',
					placeholder: '/api/v1/tags',
					description: `Path on ${API_ORIGIN}, as in the CRMCalls documentation. /api/v1 may be left out: /tags means /api/v1/tags.`,
				},
				{
					displayName: 'Query Parameters',
					name: 'queryParameters',
					type: 'fixedCollection',
					typeOptions: { multipleValues: true },
					placeholder: 'Add Query Parameter',
					default: {},
					options: [
						{
							name: 'parameter',
							displayName: 'Parameter',
							values: [
								{
									displayName: 'Name',
									name: 'name',
									type: 'string',
									default: '',
									placeholder: 'page',
								},
								{ displayName: 'Value', name: 'value', type: 'string', default: '' },
							],
						},
					],
				},
				{
					displayName: 'Body',
					name: 'body',
					type: 'json',
					default: '',
					displayOptions: { show: { method: METHODS_WITH_BODY } },
					description: 'JSON sent exactly as written. Leave empty for no body.',
				},
				{
					displayName: 'Response Format',
					name: 'responseFormat',
					type: 'options',
					default: 'auto',
					options: [
						{
							name: 'Automatic',
							value: 'auto',
							description:
								'One item per row when data holds a list, the data object otherwise, as the other operations output',
						},
						{
							name: 'Whole Response',
							value: 'whole',
							description: 'One item holding the answer as CRMCalls sent it, pagination included',
						},
					],
				},
			],
			async execute(itemIndex) {
				const method = readMethod(this, itemIndex);
				const path = readPath(this, itemIndex);
				const qs = readQuery(this, itemIndex);
				const body = readBody(this, itemIndex, method);
				const format = String(this.getNodeParameter('responseFormat', itemIndex, 'auto'));

				// Only a read is repeated after a server error: a bulk import or a contact
				// created in "ignore" mode would be made twice.
				const answer = await crmCallsRequest.call(this, method, path, {
					qs,
					body,
					itemIndex,
					retry: method === 'GET',
				});
				return toRows(answer, format);
			},
		},
	],
};
