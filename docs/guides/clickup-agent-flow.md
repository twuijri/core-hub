# Build a ClickUp → filter → agent → message flow

This guide puts the workflow pieces together (DECISIONS §123, §124, §127): ClickUp sends task
events to your hub, the workflow keeps only the ones that matter, an agent reads the task with
**read-only** ClickUp tools, and the result is sent to Telegram and/or a Core Hub conversation.
If a run fails, you are told. It works the same on every hub; nothing in it is specific to one
person or one ClickUp workspace.

You need:

- a Core Hub reachable from the internet over HTTPS (ClickUp must be able to post to it);
- a ClickUp personal API token (ClickUp → *Settings* → *Apps* → *API Token*) and your Workspace
  id (`team_id`, the first number in your workspace's URL);
- for Telegram: a bot linked to the profile (Agents → the Hermes agent → **Channels** →
  Telegram, admins), which puts `TELEGRAM_BOT_TOKEN` in the profile's Hermes `.env`, and the chat id of the group or person to
  write to (a group looks like `-1001234567890`; add the bot to the group first).

## 1. Give the agent read-only ClickUp tools

Add ClickUp's MCP server to the agent (Agents → the agent → **MCP**, admins), and sign it in if
the server asks you to (OAuth, from the same page). The agent should **read** ClickUp,
not change it, so give it only the reading tools: in the server's configuration, add an include
list with the tool names the server lists on that page, for example

```yaml
tools:
  include:
    - get_task
    - get_task_comments
    - get_list
```

The names differ between ClickUp MCP servers; copy them from the tool list the hub shows after
the server connects, and leave out every tool that creates, updates, moves or deletes. The hub
keeps the configuration as written and Hermes applies it to the agent's turns.

## 2. Draw the workflow

**Workflows → New workflow**, then add, in this order, and connect each one's green dot to the
next:

1. **Condition** — switch on *Several rules* and keep only the events that matter, for example
   with *every rule holds*:
   - `trigger.event` *is* `taskStatusUpdated`
   - `trigger.body.history_items.0.after.status` *is* `review`

   A *no* with nothing after it ends the run as **filtered**: it succeeded, nothing else ran,
   and nobody is alerted.
2. **Agent** — the agent from step 1, with a prompt that reads the event:

   ```
   ClickUp task {{trigger.task_id}} moved to review.
   Read it with the ClickUp tools and write a short summary: what was done, what is left,
   and anything that blocks it. Do not change the task.
   ```
3. **Approval** (optional) — a person reads the summary before it goes out.
4. **Send message** — the words, for example `Review ready — {{steps.agent_1.output}}`, sent to
   **Telegram** (the chat id) and/or **a Core Hub conversation** (pick one; if it is later
   deleted, the hub makes a new one with the same title and points the step to it). Long text
   is split into several Telegram messages on line and paragraph boundaries. **Send test
   message** sends the words now, to check the bot and the chat.

The workflow's settings (the gear by its name) have **When a run fails**: tell me in the inbox,
and/or send the workflow's name and the error to Telegram or a conversation.

**Test this step** (in each step's dialog — click the step) tries the step on its own with a sample input and a
sample event (a ClickUp-shaped event is filled in): a condition says yes or no, a prompt or a
message shows its words with the sample filled in, and an agent step runs a real turn only when
you tick *Run the agent for real*. Nothing is saved and no run is made.

Save the workflow.

## 3. Connect ClickUp

Follow [Start a workflow from ClickUp events](clickup-webhook-trigger.md): add a **ClickUp**
trigger from **Add trigger** on the canvas, register the webhook with its address through ClickUp's API
(`POST https://api.clickup.com/api/v2/team/<team_id>/webhook` with the address and the
events), paste the `secret` ClickUp answers into the trigger, and **Send test event**.

## 4. Watch it run

Each delivery appears in the trigger's **Deliveries** list with a link to its run. A run shows
where it is — *Received*, *Analyzing*, *Needs your answer*, *Approved*, *Executing*,
*Completed* or *Failed* — and, for a ClickUp event, the task it is about; **Find a run** in the
Runs tab matches a task or event id. The phones show the same phase and task.

A step that is tried again (a retry, or *Run again from this step*) does not send its message a
second time: every part that went out is remembered for the run.
