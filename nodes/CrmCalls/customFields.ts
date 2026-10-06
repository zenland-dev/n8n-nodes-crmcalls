import type {
	FieldType,
	IDataObject,
	IExecuteFunctions,
	INodePropertyOptions,
	ResourceMapperField,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { cached, CONFIG_TTL_MS } from '../../shared/cache';
import { toFieldDate, toFieldDateTime } from '../../shared/dates';
import { jsonValue } from '../../shared/params';
import type { CrmCallsContext } from '../../shared/transport';
import { accountKey, crmCallsRequest, rowsOf } from '../../shared/transport';

/** One entry of `GET /custom-fields`. */
export interface CustomField {
	id: string;
	name: string;
	type: string;
	order?: number;
	options?: Array<{ id: string; name: string }>;
}

/** The organization's custom fields, in their own order, shared for two minutes per key. */
export async function listCustomFields(this: CrmCallsContext): Promise<CustomField[]> {
	const key = await accountKey.call(this);
	return await cached(
		`custom-fields:${key}`,
		async () =>
			rowsOf(await crmCallsRequest.call(this, 'GET', '/custom-fields')).map((row) => ({
				id: String(row.id),
				name: String(row.name ?? row.id),
				type: String(row.type ?? 'text'),
				order: Number(row.order) || undefined,
				options: Array.isArray(row.options)
					? (row.options as IDataObject[]).map((o) => ({ id: String(o.id), name: String(o.name) }))
					: undefined,
			})),
		CONFIG_TTL_MS,
	);
}

/**
 * How each CRMCalls field type is edited in the mapper. `date` and `datetime` both
 * get the date picker and are told apart again when the value is sent; `url`,
 * `text` and `textarea` are text boxes.
 */
const MAPPER_TYPES: Record<string, FieldType> = {
	number: 'number',
	date: 'dateTime',
	datetime: 'dateTime',
	select: 'options',
	boolean: 'boolean',
};

/**
 * The fields of the mapper. A list field offers its variants by name, since
 * CRMCalls takes the name of a variant and refuses its ID.
 */
export function toMapperFields(fields: CustomField[]): ResourceMapperField[] {
	return [...fields]
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
		.map((field) => {
			const mapperField: ResourceMapperField = {
				id: field.id,
				displayName: `${field.name} (${field.id})`,
				required: false,
				defaultMatch: false,
				canBeUsedToMatch: false,
				display: true,
				type: MAPPER_TYPES[field.type] ?? 'string',
			};
			if (field.type === 'select') {
				const options: INodePropertyOptions[] = (field.options ?? []).map((o) => ({
					name: o.name,
					value: o.name,
				}));
				if (options.length > 0) mapperField.options = options;
				else mapperField.type = 'string';
			}
			return mapperField;
		});
}

function isBlank(value: unknown): boolean {
	return (
		value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
	);
}

/**
 * The `custom_fields` object of a contact, from the mapper and from the JSON
 * option, the JSON taking precedence for a field set in both.
 *
 * Blank values are left out rather than sent: CRMCalls ignores `null` and `""`
 * on update anyway, and there is no way to clear a field through the API.
 * Dates are converted only when the directory says which kind of date the field
 * holds, so the directory is read only when a date value is present.
 */
export async function customFieldValues(
	this: IExecuteFunctions,
	mapperName: string,
	jsonName: string | undefined,
	itemIndex: number,
): Promise<IDataObject | undefined> {
	const raw = this.getNodeParameter(`${mapperName}.value`, itemIndex, {}) as IDataObject | null;
	const schema = (this.getNodeParameter(`${mapperName}.schema`, itemIndex, []) ??
		[]) as ResourceMapperField[];
	const mapperTypes = new Map(schema.map((f) => [f.id, f.type]));
	const out: IDataObject = {};

	let directory: Map<string, string> | undefined;
	const crmCallsType = async (id: string): Promise<string | undefined> => {
		if (directory === undefined) {
			const fields = await listCustomFields.call(this);
			directory = new Map(fields.map((f) => [f.id, f.type]));
		}
		return directory.get(id);
	};

	const timeZone = this.getTimezone();

	for (const [id, value] of Object.entries(raw ?? {})) {
		if (isBlank(value)) continue;

		if (mapperTypes.get(id) === 'dateTime') {
			const type = await crmCallsType(id);
			out[id] = type === 'date' ? toFieldDate(value, timeZone) : toFieldDateTime(value, timeZone);
			continue;
		}
		if (mapperTypes.get(id) === 'boolean' && typeof value === 'string') {
			out[id] = value.trim().toLowerCase() === 'true';
			continue;
		}
		out[id] = value as IDataObject[keyof IDataObject];
	}

	if (jsonName !== undefined) {
		const extra = jsonValue<unknown>(
			this,
			this.getNodeParameter(jsonName, itemIndex, '') as unknown,
			'Custom Fields (JSON)',
			itemIndex,
			{},
		);
		if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
			throw new NodeOperationError(this.getNode(), 'Custom Fields (JSON) must be an object', {
				itemIndex,
				description:
					'Give field IDs as keys and values as values, e.g. {"123": "Москва", "124": 150000}. Field IDs are in Custom Field → Get Many.',
			});
		}
		Object.assign(out, extra as IDataObject);
	}

	return Object.keys(out).length > 0 ? out : undefined;
}
