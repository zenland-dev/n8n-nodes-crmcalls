# Changelog

## 0.1.1

The first version under the name `n8n-nodes-crmcalls`. The code is that of 0.1.0, which went out as
`@zenland-dev/n8n-nodes-crmcalls` and was withdrawn from npm the same day. n8n names a node type after
its package, so a workflow built with 0.1.0 needs its CRMCalls nodes added again; the CRMCalls API
credential carries over as it is.

- README: creating, updating and importing contacts were checked against a live account; what
  CRMCalls answered beyond its documentation (`warnings`, phone numbers stored as `7XXXXXXXXXX`,
  `completed_with_errors` for an import with an invalid row) is written down.

## 0.1.0

The first version, published as `@zenland-dev/n8n-nodes-crmcalls`: the CRMCalls node and the
CRMCalls API credential.

- **Contact**: create or update one contact; import all input items in one bulk import, optionally
  into an auto-dial project, and wait for its counts; the status of an import; get one; get many
  with filters, page by page.
- **Custom fields** in the editor by name, typed after the field; dates converted to Moscow time.
- **Call**: get many with filters by time, type, direction, status, contact, scenario, result,
  operator and phone; download the recording of a call as a file.
- **Scenario** with its call results, **Project**, **Custom Field**, **Tag**, **User**: lists.
- **Custom Request** for any route, with the same key, rate limit and errors.
