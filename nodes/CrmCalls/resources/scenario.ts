import { returnAllProperties, wantedRows } from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { readPages } from '../../../shared/transport';
import { idSegment } from '../props';

export const scenarioResource: Resource = {
	value: 'scenario',
	name: 'Scenario',
	description: 'Call scripts of the organization and the results an operator can save in them',
	operations: [
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many scenarios',
			description: 'Get the scenarios of the organization, with whether each is active',
			properties: returnAllProperties('scenarios'),
			async execute(itemIndex) {
				return await readPages.call(this, '/scenarios', {}, wantedRows(this, itemIndex), itemIndex);
			},
		},
		{
			value: 'getResults',
			name: 'Get Results',
			action: 'Get the call results of a scenario',
			description:
				'Get the call results an operator can save in a scenario, with their group: successful, intermediate, no_answer or failure. Their IDs filter Call → Get Many.',
			properties: [
				{
					displayName: 'Scenario Name or ID',
					name: 'scenarioId',
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getScenarios' },
					required: true,
					default: '',
					description:
						'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				},
				...returnAllProperties('results'),
			],
			async execute(itemIndex) {
				const id = idSegment(this, 'scenarioId', itemIndex, 'Scenario');
				return await readPages.call(
					this,
					`/scenarios/${id}/results`,
					{},
					wantedRows(this, itemIndex),
					itemIndex,
				);
			},
		},
	],
};
