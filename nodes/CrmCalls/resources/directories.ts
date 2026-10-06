import { returnAllProperties, take, wantedRows } from '../../../shared/params';
import type { Operation, Resource } from '../../../shared/spec';
import { crmCallsRequest, readPages, rowsOf } from '../../../shared/transport';

/**
 * Get Many over a list the documentation calls whole. It still answers with
 * `pagination` (per_page equal to total on 06.10.2026), so it is read page by page
 * like the paged lists: a list CRMCalls starts cutting is then not truncated.
 */
function listOperation(path: string, plural: string, description: string): Operation {
	return {
		value: 'getAll',
		name: 'Get Many',
		action: `Get many ${plural}`,
		description,
		properties: returnAllProperties(plural),
		async execute(itemIndex) {
			return await readPages.call(this, path, {}, wantedRows(this, itemIndex), itemIndex);
		},
	};
}

export const customFieldResource: Resource = {
	value: 'customField',
	name: 'Custom Field',
	description: 'The custom fields of contacts: their IDs, types and list variants',
	operations: [
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many custom fields',
			description:
				'Get the custom fields of contacts, hidden ones included, with their ID, type and the variants of a list field. Fields are created in the CRMCalls interface only.',
			properties: returnAllProperties('custom fields'),
			async execute(itemIndex) {
				// { data: { custom_fields: [...] } }, no pagination
				const rows = rowsOf(
					await crmCallsRequest.call(this, 'GET', '/custom-fields', { itemIndex }),
				);
				return take(rows, wantedRows(this, itemIndex));
			},
		},
	],
};

export const tagResource: Resource = {
	value: 'tag',
	name: 'Tag',
	description: 'Tags of contacts',
	operations: [listOperation('/tags', 'tags', 'Get the tags of the organization')],
};

export const userResource: Resource = {
	value: 'user',
	name: 'User',
	description: 'Users of the organization: operators, administrators',
	operations: [
		listOperation(
			'/users',
			'users',
			'Get the users of the organization; their IDs fill Responsible User and the operator filter',
		),
	],
};
