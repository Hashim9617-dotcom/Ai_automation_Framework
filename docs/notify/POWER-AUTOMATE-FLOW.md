# Report emails with Power Automate — set up once per project

This is the other half of `pnpm notify:setup`. The platform writes a file; this flow
reads it and sends the mail.

**You do not need to be a developer to follow this.** It is clicking, and pasting six
expressions that are written out in full below. Allow 15 minutes the first time and
about 5 for each project after that.

---

## Why it works this way

Nothing in the platform sends email. A run drops a file into a folder that OneDrive
syncs to SharePoint, and **a flow you own** picks it up and sends the mail **as you**.

That is a deliberate design, not a limitation:

- **No password lives anywhere.** Not in the repo, not in `.aitp-local/notify.json`,
  not on the machine that runs the tests. There is nothing to leak and nothing to
  rotate.
- **The mail comes from a real person**, so it lands in inboxes instead of a spam
  folder, and replies go somewhere useful.
- **You can see and change it.** The flow is yours — open it, read the run history,
  turn it off.

```
 pnpm test / pnpm run-sheet
          │
          ├─ 1. writes  <app>-<env>-<runId>.zip      (the full report)
          └─ 2. writes  <runId>.ready.json           ← LAST, and atomically
                        │
           OneDrive syncs the folder to SharePoint
                        │
          ┌─────────────┘
          │  your flow triggers on *.ready.json
          ├─ reads the file
          ├─ drops any recipient outside your domain
          └─ sends the mail, with the zip attached
```

**The order matters and the platform guarantees it.** The zip is written first and
the ready file last, so by the time your flow sees `.ready.json` the attachment is
already there. The ready file is also written under a temporary name and renamed, so
it never appears half-written.

---

## Before you start

You need three things.

1. **A Microsoft 365 group for the project**, with a SharePoint site. One group per
   project — see [Adding a new project](#adding-a-new-project-in-5-minutes).
2. **The group's document library synced to your PC**, so there is a real folder on
   disk. Open the library in the browser and click **Sync**. Wait for the folder to
   appear under something like
   `C:\Users\<you>\<Tenant> - <Project Name>\Test Reports`.
3. **`pnpm notify:setup` run for the application**, pointing at that folder:

   ```bash
   pnpm notify:setup --app ecom --folder "C:\Users\you\Contoso - Ecom QA\Test Reports" --to qa-team@contoso.com --cc cto@contoso.com
   ```

   It prints what it saved. If it refuses, the message says exactly why — a recipient
   outside your own email domain, a folder that does not exist yet, or an application
   with no `config/apps/<slug>/` directory.

> **Check the folder is really synced before going on.** Run the test suite once and
> look: a `.ready.json` and a `.zip` should appear in the folder on your PC, and then
> in the SharePoint library in the browser. If they appear on the PC and never in the
> browser, OneDrive is not syncing that folder and no flow will ever see them.

---

## Build the flow

Go to **make.powerautomate.com**, check the environment picker in the top right says
your organisation, and click **Create → Automated cloud flow**.

Name it `Send AITP test report — <Project Name>`. Pick the trigger
**"When a file is created in a folder" (SharePoint)** and click **Create**.

### Step 1 — the trigger

| Field            | What to put                                           |
| ---------------- | ----------------------------------------------------- |
| **Site Address** | the project group's site, from the dropdown           |
| **Folder Id**    | click the folder icon and browse to the synced folder |

Then **restrict it to ready files**, which matters: without this the flow fires for
the `.zip` as well and sends every report twice.

Click **…** on the trigger card → **Settings** → **Trigger Conditions** → **Add**,
and paste exactly:

```
@endswith(triggerOutputs()?['body/{FilenameWithExtension}'], '.ready.json')
```

> **Why a trigger condition and not a "Condition" action.** A trigger condition stops
> the flow before it starts, so your run history stays readable and you do not burn
> actions on every zip. A Condition action would work and would leave half your runs
> showing as pointless successes.

### Step 2 — Get file content

**New step → SharePoint → Get file content.**

| Field               | What to put                                        |
| ------------------- | -------------------------------------------------- |
| **Site Address**    | the same site                                      |
| **File Identifier** | dynamic content: **Identifier** (from the trigger) |

> If the dropdown offers both _Identifier_ and _File Identifier_, use **Identifier**.
> Picking the wrong one gives a "file not found" that reads like a permissions problem.

### Step 3 — Compose the parsed file

**New step → Data Operation → Compose.**

| Field      | What to put          |
| ---------- | -------------------- |
| **Inputs** | the expression below |

```
@{json(body('Get_file_content'))}
```

**Leave the action named `Compose`.** Every expression below reads
`outputs('Compose')`, so renaming it means editing all of them.

> **Why Compose and not Parse JSON.** Parse JSON is the action most guides reach
> for, and it works — but it holds a copy of the schema pasted into the flow, so a
> field the platform adds later makes the action fail until somebody re-pastes it.
> Compose parses the same JSON and the field names are identical; it simply does not
> keep a second copy of the shape. [`ready-schema.json`](ready-schema.json) is still
> the published contract, and a unit test checks it against what the platform
> actually writes — so the shape is pinned somewhere that fails loudly, rather than
> inside a flow nobody opens.
>
> The cost is that **Compose gives no friendly dynamic-content names.** Every field
> is read as an expression, which is why each one below is written out in full
> instead of being described as "pick it from the list".

### Step 4 — Keep only recipients in your own domain

This is the safety step. Reports can describe a customer's system, so a mistyped
address must not be able to send one outside the organisation.

**New step → Data Operation → Filter array.**

| Field    | What to put          |
| -------- | -------------------- |
| **From** | the expression below |

```
@{outputs('Compose')?['to']}
```

Switch the condition row to **edit in advanced mode** and paste exactly — replacing
`contoso.com` with your own domain:

```
@endswith(toLower(item()), '@contoso.com')
```

Rename this action **Filter To**. Then **add a second Filter array** exactly the same
way for `cc` — its **From** is `@{outputs('Compose')?['cc']}` — and rename it
**Filter CC**.

> A `cc` is delivered exactly like a `to`, so it gets the same filter. Skipping it is
> the mistake that makes the whole step pointless.

### Step 5 — Warn yourself if anything was dropped

**New step → Control → Condition.** In advanced mode, paste:

```
@not(equals(length(body('Filter_To')), length(outputs('Compose')?['to'])))
```

> Action names in an expression use underscores for spaces. If you renamed the
> actions differently, match your own names.

**In the "If yes" branch**, add **Office 365 Outlook → Send an email (V2)**:

| Field       | What to put                 |
| ----------- | --------------------------- |
| **To**      | your own address            |
| **Subject** | the first expression below  |
| **Body**    | the second expression below |

**Subject:**

```
@{concat('[NOT SENT] recipients outside the domain — ', outputs('Compose')?['subject'])}
```

**Body:**

```
@{concat('This report was NOT sent to its intended recipients because some are outside the allowed domain.<br><br>Requested to: ', join(outputs('Compose')?['to'], ', '), '<br>Allowed to: ', join(body('Filter_To'), ', '), '<br>Requested cc: ', join(outputs('Compose')?['cc'], ', '), '<br>Allowed cc: ', join(body('Filter_CC'), ', '), '<br><br>Fix the recipient list with: pnpm notify:setup --app ', outputs('Compose')?['app'])}
```

**Leave the "If no" branch empty for now** — step 6 goes in it.

> **Why it goes to you and not to the filtered list.** If a recipient list is wrong,
> the person who can fix it is the one who configured it. Sending the report to
> whoever happened to survive the filter, while quietly dropping the rest, is how
> somebody comes to believe a report is going out when half of it is not.

### Step 6 — Send the mail

Inside the **"If no"** branch of step 5, add **Office 365 Outlook → Send an email
(V2)**.

| Field       | What to put                                              |
| ----------- | -------------------------------------------------------- |
| **To**      | the expression below                                     |
| **CC**      | the expression below                                     |
| **Subject** | the expression below                                     |
| **Body**    | the **expression** below — never the Dynamic content tab |

> **To see what the body looks like before building any of this**, run
> `pnpm notify:preview --app <slug> --run <dir-with-run.json>`. It writes
> `preview.html` and `preview.txt` beside the run and sends nothing — no ready file,
> no zip, no recipients. Open the HTML in **Outlook**, not a browser: a browser is a
> different renderer and will flatter it.

**Body** — paste this into the **Expression** tab, not the **Dynamic content** tab:

```
@{outputs('Compose')?['bodyHtml']}
```

> **Why an expression and not dynamic content.** Pasting the same value into the
> dynamic-content tab makes Power Automate treat the field as a block of text and
> wrap it in its own `<p>` element before sending. The body is a complete
> `<!doctype html>` document, so the result is a document nested inside a paragraph
> inside another document — and Outlook's renderer responds to that by dropping the
> outer margins, which shows up as a report with no white space down either side.
> Setting the same value as an expression hands the string over untouched.
>
> The two look identical in the designer. The difference only appears in a received
> mail, which is why this is written down rather than left to be noticed.

**Subject:**

```
@{outputs('Compose')?['subject']}
```

**To:**

```
@{join(body('Filter_To'), ';')}
```

**CC:**

```
@{join(body('Filter_CC'), ';')}
```

> **To and CC come from the filters, not from `Compose`.** That is the whole point of
> step 4: the filtered list is the one that was checked against your domain, and
> reading `outputs('Compose')?['to']` here instead would send to the unfiltered list
> while the `[NOT SENT]` warning still fired. Both would happen, and the warning
> would read like the mail had been stopped.

Now open **Advanced options** on the same card:

| Field          | What to put                                                |
| -------------- | ---------------------------------------------------------- |
| **Is HTML**    | **Yes** — without this the mail arrives as raw HTML source |
| **Importance** | the expression below                                       |

**Importance** — read it from the file, and fall back to `Normal`:

```
@{coalesce(outputs('Compose')?['importance'], 'Normal')}
```

> **Why read it rather than compute it.** The ready file now carries `importance`
> directly, decided by the platform from `failed > 0`. Computing it again in the flow
> is a second place the rule lives, and the two would eventually disagree — the
> platform would change what counts as urgent and the mail would not.
>
> **Why `coalesce` and not the field alone.** `importance` is additive: every ready
> file written before the field existed has no `importance`, and an archived drop
> replayed through this flow would hand the Outlook card a null. `coalesce` makes
> that a `Normal` mail instead of a failed action, which is the right outcome for a
> field that only ever changes an icon.
>
> If you built the flow with a **Parse JSON** action instead of the **Compose** of
> step 3, every expression on this page is the same with `outputs('Compose')`
> replaced by `body('Parse_JSON')`. The field names do not change; only the action
> you read them from does.

> **A plain-text fallback is also available.** `bodyText` carries the same report as
> text, for a reader on a watch or a screen reader, or a gateway that strips HTML.
> The Outlook V2 card sends one body, so this guide uses the HTML one; if you later
> move to a connector that sends multipart mail, `bodyText` is the other half. It is
> additive and optional in exactly the way `importance` is, so coalesce it too.

#### Attach the report

Still in **Advanced options**, set **Attachments** — but only when there is an
archive and it is not too large.

Add **SharePoint → Get file content using path** _above_ the send step, inside the
same branch:

| Field            | What to put          |
| ---------------- | -------------------- |
| **Site Address** | the same site        |
| **File Path**    | the expression below |

```
@{concat(triggerOutputs()?['body/{Path}'], outputs('Compose')?['reportZipName'])}
```

Then on the send step:

| Field                       | What to put                                         |
| --------------------------- | --------------------------------------------------- |
| **Attachments Name - 1**    | `@{outputs('Compose')?['reportZipName']}`           |
| **Attachments Content - 1** | **File Content** from _Get file content using path_ |

Finally, wrap _Get file content using path_ and set the attachment fields only when
there is something to attach. Put both inside a **Condition** whose advanced-mode
expression is:

```
@and(not(equals(outputs('Compose')?['reportZipName'], null)), equals(outputs('Compose')?['reportZipTooLarge'], false))
```

> **Why both halves.** `reportZipName` is `null` when no archive was written at all.
> `reportZipTooLarge` is true when one exists but is over 10 MB — attaching it gets
> the whole mail silently dropped by a mail gateway, and the body already says the
> report is in the project folder instead. The two are different states and the
> condition has to test both.

### Step 7 — Move the file so it is not reprocessed

**At the very end of the flow**, outside both branches, add **SharePoint → Move file**.

| Field                                | What to put                                                       |
| ------------------------------------ | ----------------------------------------------------------------- |
| **Current Site Address**             | the same site                                                     |
| **File to Move**                     | dynamic content: **Identifier** (from the trigger)                |
| **Destination Site Address**         | the same site                                                     |
| **Destination Folder**               | browse to a `processed` subfolder — create it in SharePoint first |
| **If another file is already there** | **Replace**                                                       |

> **Create `processed/` before you save the flow.** If the destination does not exist
> the move fails, the ready file stays put, and nothing re-sends — so you get one mail
> and a red flow run, which is confusing rather than harmful. Making the folder first
> avoids the confusion.

Click **Save**, then **Test → Manually**, and run the test suite. You should get the
mail within a minute or two.

---

## When something does not work

| What you see                                                      | What it means                                                                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flow never triggers                                               | The folder is not syncing, or the trigger's folder is the wrong one. Check the file appears in the SharePoint library **in the browser**, not just on your PC. |
| Flow triggers twice per run                                       | The trigger condition is missing or misspelt. It fired for the `.zip` too.                                                                                     |
| Mail arrives as HTML source                                       | **Is HTML** is not set to Yes on the send step.                                                                                                                |
| Mail has an empty subject or no recipients                        | `Compose` is not reading the file. Check its **Inputs** is `@{json(body('Get_file_content'))}` and that the action is still named `Compose`.                   |
| Mail has no attachment                                            | Either there was no archive (`reportZipName` is null), or it was over 10 MB — the body says which.                                                             |
| You get a `[NOT SENT]` mail                                       | A recipient is outside your domain. Re-run `pnpm notify:setup` with the right list.                                                                            |
| `pnpm test` prints `notify: not configured`                       | Expected before setup. The line tells you the command to run.                                                                                                  |
| `pnpm test` prints `notify: skipped — this is a fixture-only run` | Expected and correct. `pnpm verify`, `pnpm test:unit` and `pnpm test:demo` are the platform testing **itself**, and never send mail.                           |

---

## Adding a new project in 5 minutes

Once you have built the flow once, each new project is a copy.

### 1. A private group, with mail in the inbox

In **Outlook on the web → People → New group**. Name it for the project, set
**Privacy: Private**, and add the project's members.

Then — and this is the step people miss — open the group's **Settings** and tick
**"Send copies of group conversations and events to group members' inboxes"**.
Without it, mail sent to the group lands only in the group's own mailbox, which
nobody opens.

### 2. A folder, synced

Open the group's **SharePoint site → Documents**, create a folder called
**Test Reports** and another inside it called **processed**, then click **Sync** and
wait for the folder to appear on your PC.

### 3. Tell the platform

```bash
pnpm notify:setup --app <slug> --folder "C:\Users\you\<Tenant> - <Project>\Test Reports" --to <group>@yourdomain.com
```

`--to` can be the group's own address — that is the point of the group. Everyone in
it gets the report, and adding a person later needs no change here.

### 4. Copy the flow

Open the flow you already built → **Save As** → name it for the new project. Then in
the copy, change **four things only**:

1. the trigger's **Site Address** and **Folder Id**
2. _Get file content_'s **Site Address**
3. _Get file content using path_'s **Site Address**
4. _Move file_'s two **Site Address** fields and its **Destination Folder**

Everything else — the `Compose`, the filters, the expressions — is identical, because
the ready file has the same shape for every application.

Turn the copy **On**. Run the suite once and check the mail arrives.

---

## What is not here yet

Said rather than left to be discovered:

- **The interactive setup wizard** is deferred to kit v0.4.2. `pnpm notify:setup`
  takes flags today, which is what makes it testable as a real process.
- **`artifacts/reports/` is not per-application.** Two applications' Playwright HTML
  reports share one directory, so the zip attached to a report is the newest one. For
  one application at a time — the normal case — this is invisible.
- **This page was written from the connector documentation, then corrected against a
  flow that exists.** The first build on a real tenant used a **Compose** action
  rather than the **Parse JSON** this page originally described, so every expression
  here now reads `outputs('Compose')`. Expect to correct a field name or two on the
  next tenant, and correct this page at the same time — a guide nobody has followed
  is a guide nobody has tested.
- **What is checked here and what is not.** A unit test asserts that every field this
  page tells you to read is a field the platform publishes, and that the ready file
  matches [`ready-schema.json`](ready-schema.json). Nothing here can execute a Power
  Automate expression, so a typo inside one is still found by building the flow —
  which is the half of §AG this repo cannot close.
