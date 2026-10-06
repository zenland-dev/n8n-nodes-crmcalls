import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	ResourceMapperFields,
} from 'n8n-workflow';

import { cached, CONFIG_TTL_MS } from '../../shared/cache';
import { accountKey, crmCallsRequest, rowsOf } from '../../shared/transport';
import { listCustomFields, toMapperFields } from './customFields';

function byName(a: INodePropertyOptions, b: INodePropertyOptions): number {
	return a.name.localeCompare(b.name);
}

/** A parameter of the node being edited, or '' when it is empty or an expression. */
function currentValue(ctx: ILoadOptionsFunctions, name: string): string {
	const value = String(ctx.getCurrentNodeParameter(name) ?? '').trim();
	return value.startsWith('=') ? '' : value;
}

/** The first non-empty text among `keys` of a row. */
function firstText(row: IDataObject, keys: string[]): string {
	for (const key of keys) {
		const value = row[key];
		if (value !== undefined && value !== null && String(value).trim() !== '') {
			return String(value).trim();
		}
	}
	return '';
}

/**
 * Every page of a list route, for a dropdown, shared for two minutes per key.
 * Every list answers with `pagination`, even the ones the documentation calls
 * whole, so all of them are read to the last page; 50 pages of 200 is the stop.
 */
async function readAllPages(
	ctx: ILoadOptionsFunctions,
	path: string,
	qs: IDataObject = {},
): Promise<IDataObject[]> {
	const key = await accountKey.call(ctx);
	return await cached(
		`${path}?${JSON.stringify(qs)}:${key}`,
		async () => {
			const rows: IDataObject[] = [];
			for (let page = 1; page <= 50; page++) {
				const body = await crmCallsRequest.call(ctx, 'GET', path, {
					qs: { ...qs, page, per_page: 200 },
				});
				const batch = rowsOf(body);
				rows.push(...batch);
				const pagination = (body as IDataObject | undefined)?.pagination as IDataObject | undefined;
				const totalPages = Number(pagination?.total_pages);
				if (batch.length < 200) break;
				if (Number.isFinite(totalPages) && page >= totalPages) break;
			}
			return rows;
		},
		CONFIG_TTL_MS,
	);
}

const PROJECT_STATUS: Record<string, string> = {
	draft: 'draft',
	active: 'running',
	paused: 'paused',
	waiting_contacts: 'waiting for contacts',
	error: 'error',
	finished: 'finished',
};

export const loadOptions = {
	async getUsers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		return (await readAllPages(this, '/users'))
			.map((user) => {
				const name = firstText(user, ['full_name', 'name', 'email']) || String(user.id);
				const email = firstText(user, ['email']);
				return {
					name: email !== '' && email !== name ? `${name} (${email})` : name,
					value: String(user.id),
				};
			})
			.sort(byName);
	},

	/** Projects that still take contacts: every one except the finished. */
	async getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		return (await readAllPages(this, '/projects'))
			.filter((project) => String(project.status) !== 'finished')
			.map((project) => {
				const status = String(project.status ?? '');
				const name = firstText(project, ['name']) || String(project.id);
				return {
					name:
						status !== '' && status !== 'active'
							? `${name} (${PROJECT_STATUS[status] ?? status})`
							: name,
					value: String(project.id),
				};
			})
			.sort(byName);
	},

	async getScenarios(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		return (await readAllPages(this, '/scenarios'))
			.map((scenario) => ({
				name: firstText(scenario, ['name', 'title']) || String(scenario.id),
				value: String(scenario.id),
			}))
			.sort(byName);
	},

	/** Results of the scenario picked beside this dropdown, in Filters or at the top level. */
	async getScenarioResults(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		const filters = (this.getCurrentNodeParameter('filters') ?? {}) as IDataObject;
		const fromFilters = String(filters.scenarioId ?? '').trim();
		const scenarioId =
			fromFilters !== '' && !fromFilters.startsWith('=')
				? fromFilters
				: currentValue(this, 'scenarioId');

		if (scenarioId === '') return [];

		const results = await readAllPages(
			this,
			`/scenarios/${encodeURIComponent(scenarioId)}/results`,
		);
		return results
			.map((result) => {
				const name = firstText(result, ['name', 'title']) || String(result.id);
				const group = firstText(result, ['group', 'category']);
				return { name: group !== '' ? `${name} (${group})` : name, value: String(result.id) };
			})
			.sort(byName);
	},
};

export const resourceMapping = {
	async getCustomFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
		const fields = await listCustomFields.call(this);
		if (fields.length === 0) {
			return {
				fields: [],
				emptyFieldsNotice:
					'The organization has no custom fields. An administrator adds them in CRMCalls: contact card → «Действия» → «Настроить поля».',
			};
		}
		return { fields: toMapperFields(fields) };
	},
};
