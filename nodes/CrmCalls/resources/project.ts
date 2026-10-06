import type { IDataObject } from 'n8n-workflow';

import { compact, returnAllProperties, wantedRows } from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { readPages } from '../../../shared/transport';

export const projectResource: Resource = {
	value: 'project',
	name: 'Project',
	description:
		'Auto-dial projects; their IDs load contacts straight into one with Contact → Import',
	operations: [
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many projects',
			description:
				'Get the auto-dial projects of the organization, finished ones included, deleted ones not',
			properties: [
				...returnAllProperties('projects'),
				{
					displayName: 'Filters',
					name: 'filters',
					type: 'collection',
					placeholder: 'Add Filter',
					default: {},
					options: [
						{
							displayName: 'Status',
							name: 'status',
							type: 'options',
							default: 'active',
							description: 'Every project except a finished one takes new contacts',
							options: [
								{ name: 'Draft', value: 'draft' },
								{ name: 'Error', value: 'error' },
								{ name: 'Finished', value: 'finished' },
								{ name: 'Paused', value: 'paused' },
								{ name: 'Running', value: 'active' },
								{ name: 'Waiting for Contacts', value: 'waiting_contacts' },
							],
						},
					],
				},
			],
			async execute(itemIndex) {
				const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
				const qs = compact({ status: filters.status as string });
				return await readPages.call(this, '/projects', qs, wantedRows(this, itemIndex), itemIndex);
			},
		},
	],
};
