# Start a workflow from ClickUp events

Core Hub can start a **workflow** whenever something happens in ClickUp: a task is created, its
status changes, someone is assigned to it, and so on. ClickUp sends each event to an address on
your hub (a *trigger*). The hub checks that the event really came from ClickUp, drops repeats
and events you did not ask for, and starts a run of the workflow with the event available to
every step as `{{trigger.…}}` (DECISIONS §123).

This works the same for every hub. You only need:

- a Core Hub that ClickUp can reach **from the internet** (a public HTTPS address, for example
  behind your reverse proxy or a tunnel). ClickUp cannot deliver to `localhost` or a private
  network address;
- a ClickUp **personal API token** (ClickUp → *Settings* → *Apps* → *API Token*), used once to
  register the webhook;
- your ClickUp **Workspace id** (`team_id` in ClickUp's API). It is the first number in the URL
  of your workspace (`https://app.clickup.com/<team_id>/…`), or `GET /api/v2/team` lists it.

## 1. Draw the workflow

In Core Hub open **Schedules → Workflows → New workflow** and draw what should happen. A typical
shape is:

1. a **Condition** step with *Several rules* switched on, to keep only the events you care about
   — for example `trigger.event == taskStatusUpdated` and
   `trigger.body.history_items.0.after.status == review` with *every rule holds*;
2. an **Agent** step whose prompt reads the event, for example
   `Task {{trigger.task_id}} moved to review. Read it and summarise what is left to do.`;
3. anything after it (a notice, an approval, another agent step).

A condition that says *no* with nothing connected after it ends the run as **filtered**: the
run succeeded, nothing else happened, and nobody is alerted.

Save the workflow.

## 2. Add a ClickUp trigger

On the canvas press **Add trigger** (the lightning button in its corner — or the big **Add a
trigger** of an empty workflow) and choose **ClickUp**. The trigger is drawn as a node before the
first steps and opens in its own dialog, which shows its **Address**, for example:

```
https://hub.example.com/api/v1/workflow-hooks/01J8QK3ZR2W7M5N4P6T8V9X0TG
```

Copy it. Tick the **events it takes** (none ticked takes every event). Events the trigger does
not take are answered `200` and logged as *Event not taken* without starting a run.

## 3. Register the webhook in ClickUp

ClickUp creates webhooks through its API. Replace `<token>`, `<team_id>` and the address:

```sh
curl -X POST "https://api.clickup.com/api/v2/team/<team_id>/webhook" \
  -H "Authorization: <token>" \
  -H "Content-Type: application/json" \
  -d '{
        "endpoint": "https://hub.example.com/api/v1/workflow-hooks/01J8QK3ZR2W7M5N4P6T8V9X0TG",
        "events": ["taskCreated", "taskStatusUpdated", "taskAssigneeUpdated"]
      }'
```

You can narrow the webhook to one place with `"space_id"`, `"folder_id"`, `"list_id"` or
`"task_id"` in the same body.

ClickUp answers with the webhook, including a **`secret`**:

```json
{ "id": "4b67ac88-…", "webhook": { "id": "4b67ac88-…", "endpoint": "https://hub.example.com/…", "secret": "O9RKFD…" } }
```

## 4. Store the secret

Paste the `secret` into the trigger's **Secret** field and **Save**. It is stored encrypted like
the hub's other secrets and never shown again — the field then says `[stored]`. Typing a new
secret replaces it. Until a secret is stored, every delivery is refused.

ClickUp signs each delivery: the `X-Signature` header is the hex HMAC-SHA256 of the request body
with that secret. The hub checks it over the body exactly as it arrived, with a constant-time
comparison, before it reads anything in it. A delivery with a missing or wrong signature is
answered `401` and logged as *Signature refused*.

## 5. Try it

- **Send test event** (in the trigger) builds a sample ClickUp task event about a made-up task,
  signs it with the stored secret and sends it through the whole receiving path. It never
  contacts ClickUp. Type an event name next to the button to test another event.
- Or change a task in ClickUp.

Each delivery appears in the trigger's **Deliveries** list (the last 7 days): *Run started*,
then *Run succeeded* or *Run failed* when the run ends (*filtered* when your condition said no),
*Repeat, ignored*, *Event not taken*, or *Signature refused*. **Open the run** shows the run on
the canvas. In the **Runs** tab, **Find a run** matches a ClickUp task id or event id.

## What a step can read

| Template | Value |
| --- | --- |
| `{{trigger.event}}` | ClickUp's event name, such as `taskStatusUpdated` |
| `{{trigger.task_id}}` | The task the event is about |
| `{{trigger.event_id}}` | The event's history item ids (sorted, comma-separated) |
| `{{trigger.body.…}}` | Any field of ClickUp's JSON, such as `trigger.body.history_items.0.after.status` |
| `{{trigger.headers.content_type}}` | A few safe headers, `-` written as `_`; never a signature or a secret |
| `{{trigger.test}}` | `true` for a test event |

## Repeats and speed

ClickUp may send the same event more than once. The hub remembers each delivery for 7 days by
its webhook id and history item ids; a repeat is answered `200`, logged as a repeat, and starts
nothing. The hub answers `202` as soon as the run is queued — the run goes on after the answer,
so ClickUp is never kept waiting by the workflow.

## Other senders

The same trigger panel offers **GitHub** (`X-Hub-Signature-256`, events from `X-GitHub-Event`),
**Signed webhook (HMAC)** for any service that signs the body with HMAC-SHA256 (choose the
header, hex or base64, and a prefix such as `sha256=`), and **Webhook with a token** for a
service that sends a shared token in a header.
