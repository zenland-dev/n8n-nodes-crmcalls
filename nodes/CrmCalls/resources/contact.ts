import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError, sleep } from 'n8n-workflow';

import { toFilterDate } from '../../../shared/dates';
import { asNodeError } from '../../../shared/errors';
import { compact, returnAllProperties, wantedRows } from '../../../shared/params';
import type { Resource } from '../../../shared/spec';
import { errorItem } from '../../../shared/spec';
import { crmCallsRequest, dataOf, readPages } from '../../../shared/transport';
import {
	buildContact,
	contactProperties,
	deduplicationProperty,
	idSegment,
	stringList,
	userProperty,
} from '../props';

/** The most contacts CRMCalls takes in one bulk import. */
export const IMPORT_LIMIT = 100_000;

/** States after which an import changes no more. */
const FINAL_STATES = new Set(['completed', 'completed_with_errors', 'failed']);

const importIdProperty: INodeProperties = {
	displayName: 'Import ID',
	name: 'importId',
	type: 'string',
	required: true,
	default: '',
	description: 'The import_id Contact → Import answered with',
};

const waitForCompletionProperty: INodeProperties = {
	displayName: 'Wait for Completion',
	name: 'waitForCompletion',
	type: 'boolean',
	default: true,
	description:
		'Whether to check the import every few seconds until CRMCalls has processed every contact, and output the final counts. Off: output the state as it is now.',
};

/** Waiting is on by default after an import, off when reading a status. */
function waitProperties(defaultWait: boolean): INodeProperties[] {
	return [
		defaultWait ? waitForCompletionProperty : { ...waitForCompletionProperty, default: false },
		{
			displayName: 'Wait Timeout (Seconds)',
			name: 'waitTimeout',
			type: 'number',
			typeOptions: { minValue: 5 },
			default: 120,
			displayOptions: { show: { waitForCompletion: [true] } },
			description:
				'When the time is up, the node outputs the state the import is in by then (queued or processing) instead of failing; Contact → Get Import Status picks it up later',
		},
	];
}

/** Polls an import until it reaches a final state or `timeoutS` runs out. */
async function waitForImport(
	this: IExecuteFunctions,
	importId: string,
	timeoutS: number,
	itemIndex: number,
	first?: IDataObject,
): Promise<IDataObject> {
	const deadline = Date.now() + Math.max(5, timeoutS) * 1000;
	let status = first;

	for (let round = 0; ; round++) {
		if (status !== undefined && FINAL_STATES.has(String(status.state))) return status;

		const pause = Math.min(2000 + round * 1000, 5000);
		if (status !== undefined && Date.now() + pause > deadline) return status;
		if (status !== undefined) await sleep(pause);

		status = dataOf(
			await crmCallsRequest.call(this, 'GET', `/contacts/import/${encodeURIComponent(importId)}`, {
				itemIndex,
			}),
		) as IDataObject;
	}
}

interface Entry {
	itemIndex: number;
	contact: IDataObject;
}

/**
 * Contact → Import: every input item becomes one contact of a single bulk
 * import. CRMCalls takes up to 100,000 contacts per import and one import per
 * key every 30 seconds, so a larger input is split and the transport waits out
 * the `retry_after` between the parts.
 *
 * The import is never repeated after a server error or a dropped connection: the
 * first one may have been queued, and a second one creates duplicates — with a
 * project, a second round of calls to the same people.
 */
async function executeImport(this: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const output: INodeExecutionData[] = [];
	const entries: Entry[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			entries.push({ itemIndex, contact: await buildContact.call(this, itemIndex, false) });
		} catch (error) {
			if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, itemIndex);
			output.push(errorItem(error, itemIndex));
		}
	}

	if (entries.length === 0) return output;

	const mode = this.getNodeParameter('deduplication', 0, 'update') as string;
	const projectId = String(this.getNodeParameter('projectId', 0, '') ?? '').trim();
	const options = this.getNodeParameter('importOptions', 0, {}) as IDataObject;
	const responsibleIds = stringList(options.responsibleIds);
	const tags = stringList(options.tags);
	const wait = this.getNodeParameter('waitForCompletion', 0, true) as boolean;
	const timeoutS = Number(this.getNodeParameter('waitTimeout', 0, 120)) || 120;

	for (let start = 0; start < entries.length; start += IMPORT_LIMIT) {
		const chunk = entries.slice(start, start + IMPORT_LIMIT);
		const pairedItem = chunk.map((entry) => ({ item: entry.itemIndex }));

		const body: IDataObject = {
			data: chunk.map((entry) => entry.contact),
			deduplication: { mode },
		};
		if (projectId !== '') body.project_id = projectId;
		else if (responsibleIds.length > 0) body.responsible_ids = responsibleIds;
		if (tags.length > 0) body.tags = tags;

		try {
			const queued = dataOf(
				await crmCallsRequest.call(this, 'POST', '/contacts/import', {
					body,
					itemIndex: chunk[0].itemIndex,
					retry: false,
				}),
			) as IDataObject;

			const importId = String(queued?.import_id ?? '');
			let result: IDataObject = queued;
			if (wait && importId !== '') {
				try {
					result = await waitForImport.call(this, importId, timeoutS, chunk[0].itemIndex);
				} catch (error) {
					// The import is queued by now. Failing the node here would invite a
					// rerun, and a rerun is a second import: report the import instead.
					result = {
						...queued,
						status_error: `The import is queued, but its status could not be read: ${
							error instanceof Error ? error.message : String(error)
						}. Check it with Contact → Get Import Status; do not import again.`,
					};
				}
			}

			output.push({ json: { import_id: importId, ...result }, pairedItem });
		} catch (error) {
			if (!this.continueOnFail()) throw asNodeError(this.getNode(), error, chunk[0].itemIndex);
			output.push({ ...errorItem(error, chunk[0].itemIndex), pairedItem });
		}
	}

	return output;
}

export const contactResource: Resource = {
	value: 'contact',
	name: 'Contact',
	description: 'The people the call center calls: phones, name, tags, custom fields',
	operations: [
		{
			value: 'upsert',
			name: 'Create or Update',
			action: 'Create or update a contact',
			description: 'Create a new record, or update the current one if it already exists (upsert)',
			properties: [...contactProperties(true), deduplicationProperty],
			async execute(itemIndex) {
				const contact = await buildContact.call(this, itemIndex, true);
				if ((contact.phones as string[]).length === 0) {
					throw new NodeOperationError(this.getNode(), 'A contact needs at least one phone', {
						itemIndex,
						description: 'Fill in Phones, e.g. +7 900 123-45-67.',
					});
				}
				const mode = this.getNodeParameter('deduplication', itemIndex, 'update') as string;
				const body = await crmCallsRequest.call(this, 'POST', '/contacts', {
					body: { ...contact, deduplication: { mode } },
					itemIndex,
					// In "create a new one" mode a repeat after a lost answer is a duplicate.
					retry: mode !== 'ignore',
				});
				return dataOf(body) as IDataObject;
			},
		},
		{
			value: 'import',
			name: 'Import',
			action: 'Import contacts in bulk',
			description:
				'Load all input items as contacts in one bulk import, optionally straight into an auto-dial project; CRMCalls processes it in the background',
			properties: [
				{
					displayName:
						'All input items go out as one import. Contacts added to a running project are called right away. Do not repeat an import in Create a New One mode: every run is a new import, and the duplicates are called again.',
					name: 'importNotice',
					type: 'notice',
					default: '',
				},
				...contactProperties(false),
				deduplicationProperty,
				{
					displayName: 'Project Name or ID',
					name: 'projectId',
					type: 'options',
					typeOptions: { loadOptionsMethod: 'getProjects' },
					default: '',
					description:
						'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					hint: 'Optional. An auto-dial project to add the contacts to; the list leaves out finished ones. Contacts added to a project lose their responsible user.',
				},
				{
					displayName: 'Import Options',
					name: 'importOptions',
					type: 'collection',
					placeholder: 'Add Option',
					default: {},
					options: [
						{
							displayName: 'Responsible User Names or IDs',
							name: 'responsibleIds',
							type: 'multiOptions',
							typeOptions: { loadOptionsMethod: 'getUsers' },
							default: [],
							description:
								'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							hint: 'Handed out to the contacts in turn. Ignored when a project is set.',
						},
						{
							displayName: 'Tags for All',
							name: 'tags',
							type: 'string',
							default: '',
							placeholder: 'Новые, API',
							description:
								'Added to every contact of the import, on top of its own tags. Separated by commas.',
						},
					],
				},
				...waitProperties(true),
			],
			async executeAll() {
				return await executeImport.call(this);
			},
		},
		{
			value: 'getImport',
			name: 'Get Import Status',
			action: 'Get the status of a contact import',
			description:
				'Get the state of a bulk import and its counts: created, updated, skipped, invalid, and how many went into the project',
			properties: [importIdProperty, ...waitProperties(false)],
			async execute(itemIndex) {
				const id = idSegment(this, 'importId', itemIndex, 'Import ID');
				const status = dataOf(
					await crmCallsRequest.call(this, 'GET', `/contacts/import/${id}`, { itemIndex }),
				) as IDataObject;
				if (!(this.getNodeParameter('waitForCompletion', itemIndex, false) as boolean)) {
					return status;
				}
				const timeoutS = Number(this.getNodeParameter('waitTimeout', itemIndex, 120)) || 120;
				return await waitForImport.call(this, decodeURIComponent(id), timeoutS, itemIndex, status);
			},
		},
		{
			value: 'get',
			name: 'Get',
			action: 'Get a contact',
			description: 'Get one contact by its CRMCalls ID',
			properties: [
				{
					displayName: 'Contact ID',
					name: 'contactId',
					type: 'string',
					required: true,
					default: '',
					placeholder: 'e.g. 3f1c2a9e-…',
					description: 'The CRMCalls ID of the contact, a UUID',
				},
			],
			async execute(itemIndex) {
				const id = idSegment(this, 'contactId', itemIndex, 'Contact ID');
				return dataOf(
					await crmCallsRequest.call(this, 'GET', `/contacts/${id}`, { itemIndex }),
				) as IDataObject;
			},
		},
		{
			value: 'getAll',
			name: 'Get Many',
			action: 'Get many contacts',
			description:
				'Get contacts, filtered by phone, External ID, responsible user, tags, import or the time of the last change',
			properties: [
				...returnAllProperties('contacts'),
				{
					displayName: 'Filters',
					name: 'filters',
					type: 'collection',
					placeholder: 'Add Filter',
					default: {},
					options: [
						{
							displayName: 'External ID',
							name: 'externalId',
							type: 'string',
							default: '',
						},
						{
							displayName: 'Import ID',
							name: 'importId',
							type: 'string',
							default: '',
							description: 'Only the contacts this bulk import created or updated',
						},
						{
							displayName: 'Phone',
							name: 'phone',
							type: 'string',
							default: '',
							placeholder: '+7 900 123-45-67',
							description: 'In any format',
						},
						userProperty(
							'Responsible User Name or ID',
							'responsibleId',
							'Only the contacts this user is responsible for',
						),
						{
							displayName: 'Tags',
							name: 'tags',
							type: 'string',
							default: '',
							placeholder: 'сайт, VIP',
							description: 'Contacts with any of these tags. Separated by commas.',
						},
						{
							displayName: 'Updated After',
							name: 'updatedFrom',
							type: 'dateTime',
							default: '',
							description:
								'In the workflow’s timezone unless the value carries its own. A bare date (2026-09-28) is a Moscow calendar day.',
						},
						{
							displayName: 'Updated Before',
							name: 'updatedTo',
							type: 'dateTime',
							default: '',
							description:
								'In the workflow’s timezone unless the value carries its own. A bare date includes the whole of that Moscow day.',
						},
					],
				},
			],
			async execute(itemIndex) {
				const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
				const timeZone = this.getTimezone();
				const qs = compact({
					phone: filters.phone as string,
					external_id: filters.externalId as string,
					responsible_id: filters.responsibleId as string,
					tags: stringList(filters.tags).join(','),
					import_id: filters.importId as string,
					updated_from: toFilterDate(filters.updatedFrom, timeZone),
					updated_to: toFilterDate(filters.updatedTo, timeZone),
				});
				return await readPages.call(this, '/contacts', qs, wantedRows(this, itemIndex), itemIndex);
			},
		},
	],
};
