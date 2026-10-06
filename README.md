# @zenland-dev/n8n-nodes-crmcalls

An n8n community node for [CRMCalls](https://cc.crmcalls.ru), a Russian call center with auto-dial
projects. 14 operations across 8 resources, covering every route of the CRMCalls REST API v1:
create and update contacts, bulk-load them, straight into a project if you like, read calls and
download their recordings, and read scenarios, call results, projects, custom fields, tags and
users.

Written from scratch against the API documentation in the CRMCalls account (Интеграции → API →
Документация, read on 06.10.2026). No code from any other package.

**Status: 0.1.0.** Every read ran against a live CRMCalls account on 06.10.2026; creating and
importing contacts did not yet. See [What was checked](#what-was-checked). Where the documentation is
silent, this README says what the API answered, or that nobody knows.

- [Installation](#installation)
- [Credentials](#credentials)
- [CRMCalls node](#crmcalls-node)
- [Webhooks from CRMCalls](#webhooks-from-crmcalls)
- [Rate limit](#rate-limit)
- [Not here, or not known](#not-here-or-not-known)
- [What was checked](#what-was-checked)

## Installation

In n8n: **Settings → Community Nodes → Install**, package name `@zenland-dev/n8n-nodes-crmcalls`.

For a self-hosted instance without the UI installer:

```bash
cd ~/.n8n/nodes
npm install @zenland-dev/n8n-nodes-crmcalls
```

and restart n8n.

## Credentials

**CRMCalls API** takes one API key. Create it in CRMCalls under Администрирование → Интеграции → API →
«Создать API-ключ»; only the Creator and the Administrators of the organization can. CRMCalls shows
the key once, starting with `crmc_live_`. A key pasted together with `Bearer ` in front of it works
too. An organization may hold 10 active keys, and a revoked one stops working at once (`401`).

The key opens the whole API of its organization. The credential cannot be picked in an HTTP Request
node: its *Allowed HTTP Request Domains* setting is pinned to none, so the key cannot be sent to
another server by pointing a generic node at it. The host is fixed at `https://cc.crmcalls.ru`; the
documentation names no other, so there is no address field. Use **Custom Request** for a route the
other operations lack.

**Requests per Second** is how many calls the node may make with this key; see
[Rate limit](#rate-limit).

The test calls `GET /api/v1/tags`, which reads and changes nothing.

## CRMCalls node

| Resource | Operations | Route |
|---|---|---|
| Contact | Create or Update, Import, Get Import Status, Get, Get Many | `/api/v1/contacts`, `/contacts/import` |
| Call | Get Many, Download Recording | `GET /api/v1/calls`, `GET /api/recordings/{call id}` |
| Scenario | Get Many, Get Results | `GET /api/v1/scenarios`, `/scenarios/{id}/results` |
| Project | Get Many | `GET /api/v1/projects` |
| Custom Field | Get Many | `GET /api/v1/custom-fields` |
| Tag | Get Many | `GET /api/v1/tags` |
| User | Get Many | `GET /api/v1/users` |
| Custom Request | Request | any route |

Every ID is a UUID: contacts, users and projects by the documentation, calls, scenarios, results and
tags by what the API answered. Every answer of CRMCalls wraps its payload in `data`; the node outputs
what is inside, one item per row for lists.

### Contact → Create or Update

For a single lead, such as a site form: the answer comes at once, with the whole contact and
`processing_status` (`created`, `updated` or `skipped`).

**Phones** is required: one or more numbers separated by commas, in any format, or an array from an
expression. The first is the main one. At least one has to be a valid Russian number, otherwise
CRMCalls answers `422 validation_error` and the node shows the reason it gave for `phones`.

CRMCalls looks for an existing contact by **External ID** first, then by phone. **If the Contact
Exists**:

- **Update It** (the default) fills in what is sent. Empty values do not erase anything.
- **Leave It Unchanged** changes nothing, custom fields included.
- **Create a New One** always creates a contact. The node does not repeat such a request after a
  server error or a dropped connection, since the first one may have gone through and a repeat
  would be a duplicate. In the other two modes a repeat is harmless and the node makes it.

**Additional Fields**: email, site, city, address, region, position, tags (up to 40 characters
each), the responsible user picked from the organization's list. CRMCalls matches **Region**
against its own list and sets the contact's timezone from it, which decides when the contact may be
called.

### Contact → Import

Sends **all input items as one bulk import**. CRMCalls queues it and answers `202` with an
`import_id`; the contacts are processed in the background.

- Up to 100,000 contacts per import and one import per key every 30 seconds. A larger input is
  split, and the node waits out the `retry_after` CRMCalls answers between the parts.
- A row without a single valid phone is not created and counts in `invalid_count`; the rest of the
  import goes on.
- **Wait for Completion** (on by default) checks the import every 3 to 5 seconds and outputs the final
  counts: `created_count`, `updated_count`, `skipped_count`, `invalid_count`. When **Wait Timeout**
  runs out first (120 seconds by default), the node outputs the state the import is in, `queued` or
  `processing`, instead of failing; **Get Import Status** reads it later.
- The node never repeats an import after a server error or a dropped connection: the first one may
  already be queued.
- **Import Options → Responsible User Names or IDs** are handed out to the contacts in turn;
  **Tags for All** are added to every contact on top of its own.
- **If the Contact Exists** works as above, except that Update also adds new phones and tags to the
  contact it finds.

The import-wide settings (mode, project, options, waiting) are read from the first input item.

**Project** loads the contacts straight into an auto-dial project; the list offers every project
except finished ones. What CRMCalls then does, from its documentation:

- A contact is added the moment it is processed, and **calling starts by the project's own rules**:
  the project is running, its schedule, the client's local time, attempt limits, the blacklist. A
  paused project takes contacts and calls them once resumed.
- Adding a contact to a project takes its responsible user away; the first operator to get through
  becomes the new one. Responsible users of the import are ignored with a project.
- A contact already in the project is not added twice: with Update its data changes, while its
  status, attempts and responsible user stay.
- A contact once removed from the project is added again and called from scratch, its call history
  kept.
- The final status has a `project` block: `added`, `already_in_project`, `failed`.
- An unknown or someone else's project fails the whole request with `404`, a finished one with `422`,
  and no import is created.

**Do not repeat an import in Create a New One mode.** Every run is a new import: the duplicates go
into the project and the same people are called again.

### Custom fields

**Custom Fields** lists the organization's fields by name and ID (from `GET /custom-fields`) and
shows each in the editor its type calls for:

| Field type | Editor | Sent as |
|---|---|---|
| text, textarea, url | text | as typed |
| number | number | a number |
| date | date picker | `2026-09-28` |
| datetime | date picker | `2026-09-28T15:30:00+03:00` |
| select | the field's variants | the name of the variant: CRMCalls refuses its ID |
| boolean | switch | `true` / `false` |

Fields are created only in the CRMCalls interface (contact card → «Действия» → «Настроить поля»),
never through the API. The field ID does not change when the field is renamed, so a workflow keeps
working.

For a field chosen by an expression, use **Additional Fields → Custom Fields (JSON)**:
`{"123": "Москва", "124": 150000}`. It overrides the same field set in the list.

How CRMCalls treats the values, from its documentation:

- A wrong value of one field (a bad format, an unknown variant, a deleted field ID) is skipped
  silently; the contact is still saved. Check the answer if it matters.
- **A field cannot be cleared through the API**: an empty value or `null` leaves it as it is, and so
  does a wrong one. The node does not send empty values at all.
- Numbers longer than 15 significant digits should be sent as text.

### Dates

CRMCalls answers every date in Moscow time with its offset, `+03:00`, and reads a date without a zone
as Moscow time. n8n's date picker gives a time without a zone, meant in the workflow's timezone. So
the node converts: a time picked in the editor is read in the workflow's timezone and sent as a
Moscow moment, e.g. `2026-09-28T10:00:00+03:00`. A value that carries its own zone keeps its moment.
A bare date (`2026-09-28`) is sent as a date, and CRMCalls reads it as a Moscow calendar day; in
**Updated Before** and **Started Before** that means the whole day. `28.09.2026`, the way the
documentation writes dates of custom fields, is refused by the filters (`422 validation_error`), so
the node turns it into `2026-09-28` first.

### Lists and filters

Every list answers with `pagination`, including the ones the documentation calls whole (tags,
users, scenarios, results: there `per_page` equals the total). The node reads them all page by page,
200 rows per page, the most CRMCalls gives (a larger `per_page` is cut to 200 silently), until
**Limit** or the last page. Custom fields are the exception: one object, no pages.

Filters:

- **Contacts**: phone in any format, External ID, responsible user, tags (any of them), import ID
  (contacts the import created or updated), last change after and before.
- **Calls**: start after and before, call type (outgoing, incoming, missed, all), contact ID,
  scenario, result of that scenario, operator, responsible user, phone, direction (`inbound`,
  `outbound`), status. The documentation lists no values for the last two; the ones in the dropdowns
  are those the API answered: `completed`, `no_answer`, `busy`, `failed`, `canceled`, `missed`. An
  unknown value is not an error, the list just comes back empty.
- **Projects**: status (draft, running, paused, waiting for contacts, error, finished). An unknown
  value is `400 validation_error`.

A call comes with `contact_id`, `phone`, `phone_number`, `source` (your number), `direction`,
`call_type`, `status`, `started_at`, `connected_at`, `ended_at`, `duration` and `ring_duration` in
seconds, `sip_reason`, `contact`, `user` (the operator), `scenario`, `result` with its `group`
(`successful`, `intermediate`, `no_answer`, `failure`), `comment`, and `record` / `record_url`, the
link to the recording or `null`.

### Call → Download Recording

Fetches `https://cc.crmcalls.ru/api/recordings/<call id>` into a binary field (`data` by default),
named `call-<id>.mp3`; the API serves `audio/mpeg`. A recording still being processed answers
`202 record_not_ready`, a call without one `404 record_unavailable`; both fail the item with that
code.

**The recording link opens without the API key**: on 06.10.2026 it served the file to a request with
no `Authorization` header at all. Anyone holding the link can listen to the call, so treat
`record`, `record_url` and webhook payloads that carry them as personal data. The node sends the key
anyway, since the documentation does not promise the link stays open.

### Custom Request

Any method and path under `https://cc.crmcalls.ru`; `/tags` means `/api/v1/tags`. A full URL is
refused, so the key never leaves for another host. Only `GET` is repeated after a server error.
**Response Format → Automatic** outputs the rows of `data`, **Whole Response** the answer as it came,
`pagination` included.

## Webhooks from CRMCalls

There is no trigger node, on purpose. CRMCalls offers no API to register a webhook: the address is
typed by hand in the scenario, so a trigger would add nothing to n8n's own **Webhook** node.

To set one up:

1. Add a **Webhook** node, method `POST`. Copy its production URL (CRMCalls takes `https://` only,
   up to 500 characters).
2. In CRMCalls open **Сценарии**, the scenario, the **Исходящие Webhooks** block → «Добавить Webhook».
   Paste the URL and pick the call results that send it. A result can belong to only one webhook of
   a scenario.
3. Pick the fields and their JSON keys. A key with a dot nests: `data.phone` arrives as
   `{"data": {"phone": …}}`. Available: the contact (`contact.id`, `contact.phone` as `7XXXXXXXXXX`,
   `contact.phones`, tags, every custom field), the call (`call.id`, `call.direction`,
   `call.duration`, `call.record_url`…), the scenario, the result and its group, the operator and the
   responsible user.
4. For authentication, add your own header in the webhook settings, e.g. `X-Token: <secret>`, and
   choose **Header Auth** in the Webhook node with the same name and value.

Every delivery carries `event` (`call.result_saved`, the only event), `event_id` and `occurred_at`;
the rest is what you picked. A field with no value arrives as `null`; a missing object (a call
without a contact) leaves its keys out.

CRMCalls counts any `2xx` as delivered and waits 10 seconds for it (15 on retries). Otherwise it tries
again after 5 minutes, 30 minutes, 1, 3 and 6 hours, 6 attempts in all, with the same body and the
same `Idempotency-Key` header, equal to `event_id`. **Deduplicate on `event_id`** if a repeat must
not run the workflow twice. After 50 failures in a row CRMCalls switches the webhook off; it is
turned back on in the scenario. The **Лог Webhooks** tab of Интеграции → API shows every delivery
with the HTTP code your side answered.

`call.record_url` comes at once, even while the recording is still processed: until then it answers
`202 record_not_ready`, and `404 record_unavailable` if there will be none.

## Rate limit

CRMCalls allows 10 requests per second per key and answers `429 rate_limit_exceeded` above that.
The node spaces its calls by a sliding one-second window, shared by every workflow of the n8n process
that uses the same key, 8 per second by default (**Requests per Second** in the credential). A `429`
that still happens is waited out and repeated. With several queue-mode workers or instances on one
key, divide the limit between them, or give each its own key.

Bulk imports have a limit of their own: one per key every 30 seconds (`429 import_rate_limit` with
`retry_after`). The node waits up to a minute for it and then reports the error.

## Not here, or not known

The API is a contact intake plus reads. It has no route, so neither has the node, to:

- delete a contact, or clear a custom field of one;
- create custom fields or their variants;
- start a call, manage projects, scenarios or the blacklist;
- register a webhook.

The documentation leaves out the values of the call `direction` and `status` filters, the type of most
IDs and the fields of calls, scenarios, results, tags and users. All of it was read off live answers
on 06.10.2026 and is written above; CRMCalls may add values without notice, and the node passes on
whatever fields come.

## What was checked

On a live CRMCalls account, 06.10.2026, reads only, with a probe that printed the shape of every
answer and never its data:

- every list and its paging: tags, users, custom fields, scenarios, results of a scenario,
  projects, contacts, calls, and one contact by ID;
- every call filter value above, `direction` and `status` both ways, and the date forms
  `2026-09-28T10:00:00+03:00`, `2026-09-28T07:00:00.000Z`, `2026-09-28 10:00`, `2026-09-28`
  (accepted) and `28.09.2026` (refused);
- the recording link, with and without the key;
- errors: an unknown import, contact or scenario (`404 not_found`), an unknown project status
  (`400 validation_error` with `details.status`), an unknown key (`401 unauthorized`).

Not run yet: Create or Update, Import and Get Import Status, which write to the account, and with
them the sending of custom field values. Those follow the documentation.

## License

[MIT](LICENSE.md). "CRMCalls" and its logo belong to their owner; see the trademark note in the
license.
