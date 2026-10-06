import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { toFilterDate } from '../../../shared/dates';
import { asNodeError } from '../../../shared/errors';
import { compact, requiredText, returnAllProperties, wantedRows } from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { errorItem } from '../../../shared/spec';
import { crmCallsDownload, readPages } from '../../../shared/transport';
import { userProperty } from '../props';

const EXTENSIONS: Record<string, string> = {
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/ogg': 'ogg',
};

/** Call → Download Recording: one file per input item, into its binary data. */
async function downloadRecordings(this: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const output: INodeExecutionData[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const callId = requiredText(this, 'callId', itemIndex, 'Call ID');
			const field = requiredText(this, 'binaryPropertyName', itemIndex, 'Put Output File in Field');
			const file = await crmCallsDownload.call(
				this,
				`/api/recordings/${encodeURIComponent(callId)}`,
				itemIndex,
			);
			const fileName = `call-${callId}.${EXTENSIONS[file.mimeType] ?? 'bin'}`;
			const binary = await this.helpers.prepareBinaryData(file.data, fileName, file.mimeType);
			output.push({
				json: {
					call_id: callId,
					file_name: fileName,
					mime_type: file.mimeType,
					size: file.data.length,
				},
				binary: { [field]: binary },
				pairedItem: { item: itemIndex },
			});
		} catch (error) {
			if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, itemIndex);
			output.push(errorItem(error, itemIndex));
		}
	}

	return output;
}

export const callResource: Resource = {
	value: 'call',
	name: 'Call',
	description: 'Calls of the organization, with the result the operator saved and a recording link',
	operations: [
		{
			value: 'downloadRecording',
			name: 'Download Recording',
			action: 'Download a call recording',
			description:
				'Download the recording of a call as a file, e.g. to transcribe it or store it elsewhere. A call that was never connected has none.',
			properties: [
				{
					displayName: 'Call ID',
					name: 'callId',
					type: 'string',
					required: true,
					default: '',
					description:
						'The CRMCalls ID of the call, a UUID, as Call → Get Many returns it or as a webhook carries it',
				},
				{
					displayName: 'Put Output File in Field',
					name: 'binaryPropertyName',
					type: 'string',
					required: true,
					default: 'data',
					hint: 'The name of the output binary field to put the file in',
				},
			],
			async executeAll() {
				return await downloadRecordings.call(this);
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many calls',
			description:
				'Get calls with their contact, scenario, result and recording link, filtered by time, type, contact, scenario, result, operator or phone',
			properties: [
				...returnAllProperties('calls'),
				{
					displayName: 'Filters',
					name: 'filters',
					type: 'collection',
					placeholder: 'Add Filter',
					default: {},
					options: [
						{
							displayName: 'Call Type',
							name: 'callType',
							type: 'options',
							default: 'all',
							options: [
								{ name: 'All', value: 'all' },
								{ name: 'Incoming', value: 'incoming' },
								{ name: 'Missed', value: 'missed' },
								{ name: 'Outgoing', value: 'outgoing' },
							],
						},
						{
							displayName: 'Contact ID',
							name: 'contactId',
							type: 'string',
							default: '',
							description: 'The CRMCalls ID of the contact, a UUID',
						},
						{
							displayName: 'Direction',
							name: 'direction',
							type: 'options',
							default: 'outbound',
							options: [
								{ name: 'Inbound', value: 'inbound' },
								{ name: 'Outbound', value: 'outbound' },
							],
						},
						userProperty('Operator Name or ID', 'userId', 'Only the calls this operator handled'),
						{
							displayName: 'Phone',
							name: 'phone',
							type: 'string',
							default: '',
							placeholder: '+7 900 123-45-67',
						},
						userProperty(
							'Responsible User Name or ID',
							'responsibleId',
							'Only the calls with contacts this user is responsible for',
						),
						{
							displayName: 'Result Name or ID',
							name: 'resultId',
							type: 'options',
							typeOptions: {
								loadOptionsMethod: 'getScenarioResults',
								loadOptionsDependsOn: ['filters.scenarioId'],
							},
							default: '',
							description:
								'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							hint: 'The list shows the results of the scenario picked under Scenario',
						},
						{
							displayName: 'Scenario Name or ID',
							name: 'scenarioId',
							type: 'options',
							typeOptions: { loadOptionsMethod: 'getScenarios' },
							default: '',
							description:
								'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
						},
						{
							displayName: 'Started After',
							name: 'startedFrom',
							type: 'dateTime',
							default: '',
							description:
								'In the workflow’s timezone unless the value carries its own. A bare date (2026-09-28) is a Moscow calendar day.',
						},
						{
							displayName: 'Started Before',
							name: 'startedTo',
							type: 'dateTime',
							default: '',
							description:
								'In the workflow’s timezone unless the value carries its own. A bare date includes the whole of that Moscow day.',
						},
						{
							displayName: 'Status',
							name: 'status',
							type: 'options',
							default: 'completed',
							description:
								'The values the API answered on 06.10.2026; its documentation does not list them. For another value, use an expression.',
							options: [
								{ name: 'Busy', value: 'busy' },
								{ name: 'Canceled', value: 'canceled' },
								{ name: 'Completed', value: 'completed' },
								{ name: 'Failed', value: 'failed' },
								{ name: 'Missed', value: 'missed' },
								{ name: 'No Answer', value: 'no_answer' },
							],
						},
					],
				},
			],
			async execute(itemIndex) {
				const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
				const timeZone = this.getTimezone();
				const qs = compact({
					started_from: toFilterDate(filters.startedFrom, timeZone),
					started_to: toFilterDate(filters.startedTo, timeZone),
					contact_id: filters.contactId as string,
					responsible_id: filters.responsibleId as string,
					scenario_id: filters.scenarioId as string,
					result_id: filters.resultId as string,
					user_id: filters.userId as string,
					phone: filters.phone as string,
					call_type: filters.callType as string,
					direction: filters.direction as string,
					status: filters.status as string,
				});
				return await readPages.call(this, '/calls', qs, wantedRows(this, itemIndex), itemIndex);
			},
		},
	],
};
