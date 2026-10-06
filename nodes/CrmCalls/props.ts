import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { jsonParse } from 'n8n-workflow';

import { requiredText } from '../../shared/params';
import { customFieldValues } from './customFields';

/**
 * A user of the organization picked from the list, or given as a UUID by expression.
 * The description of a dropdown filled from the API is fixed wording n8n's linter
 * checks literally, so it is written out at every such dropdown and the rest goes
 * into `hint`.
 */
export function userProperty(
	displayName: string,
	name: string,
	hint: string,
	required = false,
): INodeProperties {
	return {
		displayName,
		name,
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getUsers' },
		required,
		default: '',
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		hint,
	};
}

/** A path segment made of an ID the user typed; the ID must not be empty. */
export function idSegment(
	ctx: IExecuteFunctions,
	name: string,
	itemIndex: number,
	label: string,
): string {
	return encodeURIComponent(requiredText(ctx, name, itemIndex, label));
}

/**
 * A list of strings from a comma-, semicolon- or newline-separated text, a JSON
 * array typed as text, or an array produced by an expression. Empty entries are
 * dropped, duplicates kept once.
 */
export function stringList(raw: unknown): string[] {
	let values: unknown[];

	if (Array.isArray(raw)) {
		values = raw;
	} else if (raw === undefined || raw === null) {
		values = [];
	} else {
		const text = String(raw).trim();
		if (text.startsWith('[')) {
			try {
				const parsed = jsonParse<unknown>(text);
				values = Array.isArray(parsed) ? parsed : [parsed];
			} catch {
				values = text.split(/[,;\n]/);
			}
		} else {
			values = text.split(/[,;\n]/);
		}
	}

	return [...new Set(values.map((v) => String(v ?? '').trim()).filter((v) => v !== ''))];
}

// ── Contact fields ─────────────────────────────────────────────────────────

export const deduplicationProperty: INodeProperties = {
	displayName: 'If the Contact Exists',
	name: 'deduplication',
	type: 'options',
	default: 'update',
	description:
		'CRMCalls looks for the contact by External ID first, then by phone. Repeating a request in Create a New One mode makes duplicates.',
	options: [
		{
			name: 'Create a New One',
			value: 'ignore',
			description: 'Always create a contact, even with the same phone',
		},
		{
			name: 'Leave It Unchanged',
			value: 'skip',
			description: 'Change nothing, custom fields included',
		},
		{
			name: 'Update It',
			value: 'update',
			description:
				'Fill in what is sent; empty values do not erase what the contact has. In an import, new phones and tags are added too.',
		},
	],
};

const phonesProperty: INodeProperties = {
	displayName: 'Phones',
	name: 'phones',
	type: 'string',
	required: true,
	default: '',
	placeholder: '+7 900 123-45-67, 79001234568',
	description:
		'One or more phone numbers, separated by commas, or an array from an expression. Any format; the first is the main one. At least one has to be a valid Russian number.',
};

const fullNameProperty: INodeProperties = {
	displayName: 'Full Name',
	name: 'fullName',
	type: 'string',
	default: '',
	placeholder: 'Иван Петров',
};

const externalIdProperty: INodeProperties = {
	displayName: 'External ID',
	name: 'externalId',
	type: 'string',
	default: '',
	placeholder: 'crm-1001',
	description:
		'Your own ID of the contact, e.g. from your CRM or the site form. CRMCalls looks for an existing contact by it first, then by phone.',
};

/**
 * The standard fields every contact may carry. `withResponsible` adds the
 * responsible user, which only the single-contact route takes per contact.
 */
function additionalFieldsProperty(withResponsible: boolean): INodeProperties {
	const options: INodeProperties[] = [
		{
			displayName: 'Address',
			name: 'address',
			type: 'string',
			default: '',
		},
		{
			displayName: 'City',
			name: 'city',
			type: 'string',
			default: '',
		},
		{
			displayName: 'Custom Fields (JSON)',
			name: 'customFieldsJson',
			type: 'json',
			default: '{}',
			description:
				'Custom field values keyed by field ID, for fields picked by expression: {"123": "Москва", "124": 150000}. A list field takes the name of the variant, not its ID. Overrides the same field set under Custom Fields.',
		},
		{
			displayName: 'Email',
			name: 'email',
			type: 'string',
			placeholder: 'name@email.com',
			default: '',
		},
		{
			displayName: 'Position',
			name: 'position',
			type: 'string',
			default: '',
		},
		{
			displayName: 'Region',
			name: 'region',
			type: 'string',
			default: '',
			description:
				'CRMCalls matches it against its list of regions and sets the contact’s timezone from it, which decides when the contact may be called',
		},
	];

	if (withResponsible) {
		options.push(
			userProperty(
				'Responsible User Name or ID',
				'responsibleId',
				'The user of the organization who owns the contact',
			),
		);
	}

	options.push(
		{
			displayName: 'Site',
			name: 'site',
			type: 'string',
			default: '',
		},
		{
			displayName: 'Tags',
			name: 'tags',
			type: 'string',
			default: '',
			placeholder: 'сайт, VIP',
			description:
				'Separated by commas, or an array from an expression. Up to 40 characters each; a tag CRMCalls does not know yet is created.',
		},
	);

	return {
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		options,
	};
}

const customFieldsProperty: INodeProperties = {
	displayName: 'Custom Fields',
	name: 'customFields',
	type: 'resourceMapper',
	noDataExpression: true,
	default: { mappingMode: 'defineBelow', value: null },
	typeOptions: {
		resourceMapper: {
			resourceMapperMethod: 'getCustomFields',
			mode: 'add',
			fieldWords: { singular: 'custom field', plural: 'custom fields' },
			addAllFields: false,
			multiKeyMatch: false,
			supportAutoMap: false,
		},
	},
};

/** Every parameter of one contact, for Create or Update (`single`) and for Import. */
export function contactProperties(single: boolean): INodeProperties[] {
	return [
		phonesProperty,
		fullNameProperty,
		externalIdProperty,
		additionalFieldsProperty(single),
		customFieldsProperty,
	];
}

/** One contact as CRMCalls takes it, from the parameters of one input item. */
export async function buildContact(
	this: IExecuteFunctions,
	itemIndex: number,
	single: boolean,
): Promise<IDataObject> {
	const contact: IDataObject = {
		phones: stringList(this.getNodeParameter('phones', itemIndex, '')),
	};

	const fullName = String(this.getNodeParameter('fullName', itemIndex, '') ?? '').trim();
	if (fullName !== '') contact.full_name = fullName;

	const externalId = String(this.getNodeParameter('externalId', itemIndex, '') ?? '').trim();
	if (externalId !== '') contact.external_id = externalId;

	const extra = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
	for (const key of ['email', 'site', 'city', 'address', 'region', 'position']) {
		const value = String(extra[key] ?? '').trim();
		if (value !== '') contact[key] = value;
	}

	const tags = stringList(extra.tags);
	if (tags.length > 0) contact.tags = tags;

	if (single) {
		const responsible = String(extra.responsibleId ?? '').trim();
		if (responsible !== '') contact.responsible_id = responsible;
	}

	// The JSON option lives inside Additional Fields, so it is read from there.
	const customFields = await customFieldValues.call(
		this,
		'customFields',
		'additionalFields.customFieldsJson',
		itemIndex,
	);
	if (customFields !== undefined) contact.custom_fields = customFields;

	return contact;
}
