import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * The one host the CRMCalls call center serves its API on.
 *
 * Every organization is reached at this address and told apart by the key
 * alone, so the credential has no address field: there is nothing to type, and
 * nothing that could point the key at another server. The documentation names
 * no second host.
 */
export const API_ORIGIN = 'https://cc.crmcalls.ru';

/** The API version every documented route lives under. */
export const API_VERSION_PATH = '/api/v1';

/**
 * The key as it is sent, as an n8n expression. Whitespace from a careless copy
 * and a pasted "Bearer " prefix are dropped, so a key copied together with the
 * header name from the CRMCalls documentation still works.
 */
const KEY_EXPRESSION = 'String($credentials.apiKey || "").trim().replace(/^Bearer\\s+/i, "")';

/** The same normalisation in plain TypeScript, for the transport. */
export function normalizeApiKey(raw: unknown): string {
	return String(raw ?? '')
		.trim()
		.replace(/^Bearer\s+/i, '');
}

/**
 * Named after the call center (cc.crmcalls.ru) rather than plain `crmCallsApi`:
 * credential names share one namespace across every package installed in an
 * n8n instance, and the shortest name is the one most likely to be taken.
 */
export class CrmCallsCcApi implements ICredentialType {
	name = 'crmCallsCcApi';

	displayName = 'CRMCalls API';

	documentationUrl =
		'https://github.com/zenland-dev/n8n-nodes-crmcalls?tab=readme-ov-file#credentials';

	icon: Icon = { light: 'file:../icons/crmcalls.svg', dark: 'file:../icons/crmcalls.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName:
				'Create the key in CRMCalls under Администрирование → Интеграции → API → «Создать API-ключ». Only the Creator and the Administrators of the organization can. The key opens the whole API of the organization; a revoked key stops working at once.',
			name: 'keyNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'crmc_live_…',
			description:
				'The API key of the organization, starting with crmc_live_. CRMCalls shows it once, when it is created.',
		},
		{
			displayName: 'Requests per Second',
			name: 'requestsPerSecond',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 8,
			description:
				'How many calls these nodes may make with this key in any one second. CRMCalls allows 10 per key and answers 429 above that. The count is kept inside one n8n process: with several queue-mode workers or instances on the same key, divide the limit between them, or give each its own key (an organization may hold 10).',
		},
		{
			// n8n injects this field into every credential with an `authenticate` block,
			// defaulting to "all" — enough for anyone who can edit a workflow to pick
			// this credential in an HTTP Request node, type any URL and have n8n attach
			// the key to it. Declaring it here skips the injection, so there is no
			// switch to flip. The node's own calls go through
			// httpRequestWithAuthentication, which never reads it.
			displayName: 'Allowed HTTP Request Domains',
			name: 'allowedHttpRequestDomains',
			type: 'hidden',
			default: 'none',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: `=Bearer {{ ${KEY_EXPRESSION} }}`,
			},
		},
	};

	/** `GET /tags` reads the organization's tag list and changes nothing. */
	test: ICredentialTestRequest = {
		request: {
			baseURL: `${API_ORIGIN}${API_VERSION_PATH}`,
			url: '/tags',
			method: 'GET',
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						'CRMCalls did not accept the key. It may be mistyped, revoked, or copied without its crmc_live_ prefix. Create a new one under Integrations → API.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 429,
					message:
						'CRMCalls refused the test for the rate limit (10 requests per second per key). Wait a second and test again.',
				},
			},
		],
	};
}
