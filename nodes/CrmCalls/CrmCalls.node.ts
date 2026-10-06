import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import type { Resource } from '../../shared/spec';
import { buildProperties, executeResources } from '../../shared/spec';
import { CREDENTIAL } from '../../shared/transport';
import { loadOptions, resourceMapping } from './methods';
import { callResource } from './resources/call';
import { contactResource } from './resources/contact';
import { customRequestResource } from './resources/customRequest';
import { customFieldResource, tagResource, userResource } from './resources/directories';
import { projectResource } from './resources/project';
import { scenarioResource } from './resources/scenario';

const resources: Resource[] = [
	contactResource,
	callResource,
	scenarioResource,
	projectResource,
	customFieldResource,
	tagResource,
	userResource,
	customRequestResource,
];

export class CrmCalls implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CRMCalls',
		name: 'crmCalls',
		icon: { light: 'file:../../icons/crmcalls.svg', dark: 'file:../../icons/crmcalls.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description:
			'Send leads to the CRMCalls call center, load contacts into auto-dial projects, and read calls with their results and recordings',
		defaults: { name: 'CRMCalls' },
		usableAsTool: true,
		builderHint: {
			searchHint:
				'CRMCalls (cc.crmcalls.ru) is a Russian call center with auto-dial projects. Contact → Create or Update sends one lead and answers at once; Contact → Import sends all input items as one background import, optionally into a project, whose contacts are then called automatically. Duplicates are matched by External ID, then by phone; mode update, skip or ignore. Phones must include a valid Russian number. Custom fields are keyed by field ID; a list field takes the variant name. IDs of contacts, users and projects are UUIDs. Calls → Get Many filters by time, type, scenario, result and operator; each call has a record link. Outgoing webhooks are set up in a CRMCalls scenario and arrive at a plain Webhook node. 10 requests per second, one import per 30 seconds per key.',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: buildProperties(resources, 'contact'),
	};

	methods = { loadOptions, resourceMapping };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await executeResources.call(this, resources);
	}
}
