# openpost Gmail add-on (experimental)

This is a **sub-project**, shipped as source only and never executed by openpost's own test suite
or CI. It is disabled by default (`ADDON_ENABLED=false`). The server half it talks to
(`POST /api/addon/track`, `POST /api/addon/link`, `GET /api/addon/config`, and the reaper job) is
fully implemented and fully tested with fakes in the main openpost test suite - what is *not*
tested here, because it cannot be from this environment, is whether the Apps Script side actually
shows up where you'd want it on a phone. See docs/09_phase5_spec.md §6 for the full spec this was
built from.

## The one thing this cannot promise

**Whether the Gmail *mobile* apps (Android/iOS) show an add-on compose card at all is unverified,
and the available evidence leans toward "probably not".** Add-ons are documented and confirmed to
appear in the Gmail mobile apps for *reading* a message (the row of icons at the bottom of an
opened email). Whether that same surface exists for *composing* a message on mobile could not be
confirmed - Google's own compose-actions launch material says compose actions "work in Gmail
across mobile and web", but every current description of the mobile add-on surface describes only
the opened-message card, and the docs page itself could not be fetched from the environment this
was built in (egress to `developers.google.com` was blocked). Step 2 of the install checklist below
exists to answer this in about a minute, for your own Gmail app and OS version - please record what
you find in `docs/reports/phase5_smoke.md` (or your own operational notes) so the next reader does
not have to re-derive it. **If the compose card does not appear on your phone, that is expected,
not a bug** - the openpost dashboard's own mobile compose page (`/dashboard/compose`) is the
supported, verified way to send a tracked message from a phone; this add-on only adds value on
clients where the compose card does show up (confirmed on Gmail web).

## What this add-on can and cannot do

| | |
|---|---|
| Tracking granularity | Message-level only (`recipient_mode='single'`) - the add-on reads the draft's current To/Cc/Bcc when the card runs; addresses added afterwards are invisible to it, and there is no send hook to re-read them. |
| Click tracking | None. `CardService.UpdateDraftBodyAction` can only *insert* content into a draft body - there is no "replace" operation, so the pixel can be inserted but links cannot be rewritten. |
| Unsubscribe footer | None - this is one-to-one mail, not a campaign. |
| Self-open elimination | Only the same send-window/sender-fingerprint rules every openpost message already gets; no untracked Sent copy is possible for an add-on-tracked message. |
| Reply detection | Works, once `Linker.gs` binds the Gmail thread id. |
| Reminders | Work from the dashboard, once linked. |
| If Gmail strips the pixel on send | The message shows up in openpost as sent-and-never-opened - indistinguishable from a genuine non-open. Step 4 of the checklist below (`Show original`) is how you catch this. |

## 2026-10-19 setup update

The linker uses the Advanced Gmail service (`Gmail.Users.Messages`) with the declared
`gmail.readonly` scope. It does not use `GmailApp`, whose methods require full mailbox access.
The manifest enables Gmail v1. Search results are sorted globally oldest-first across pages;
when more than 250 candidates remain, the linker leaves the draft unlinked rather than guessing.
Only inline HTML is decoded; attachments are not fetched. Both Advanced-service byte arrays and base64 string responses are supported.

For the prepared deployment, enter `OPENPOST_BASE_URL` and `OPENPOST_TOKEN` in Script properties,
then run `configureFromScriptProperties()` once under the intended sender account. This copies
the connection to User properties and installs the five-minute linker. Review the scopes and
complete Google's consent yourself when prompted. Install the Gmail test deployment, compose a
self-test mail, invoke Track with openpost, send it, then check the linker and the dashboard.
PC Chrome live verification completed on 2026-10-19: installed and authorized the private test deployment, inserted a pixel from the compose card, sent two self-test messages with Gmail, checked received MIME and inbox delivery, and ran the actual linker successfully. The configured five-minute trigger is separate from this manual-function proof. Mobile compose remains unverified. See `docs/reports/release-0.1.1.md`.

Use **Track with openpost → optional dashboard label → 追跡画像を挿入** once, then Gmail's Send. Finalize recipients before insertion. `onComposeTrack` returns cards; `applyComposeTrack` is the draft update callback. Modern recipient metadata is in `e.gmail`. The optional label is not the Gmail subject and is not used to filter sent candidates.

Unsent/unlinked image fetches are retained but not counted. Confirmed send time also repairs historical pre-send counted events with an audit record. Gmail proxy fetches inside the configured prefetch window are not counted, even when a person opens quickly. A cached image may prevent later evidence; opening the sender's Sent copy may also add false positives. Never interpret zero or ◐ as proof of unread.

The Cloud Run profile does not run reminders/reply polling or provide dashboard Compose. Its PWA is a tracking dashboard. Mobile clients and native installation were not verified.

## Scopes this add-on requests, and why

- `gmail.addons.execute`, `gmail.addons.current.action.compose` - required by every Gmail add-on
  with a compose action.
- `gmail.addons.current.message.metadata` - current compose recipient metadata.
- `script.external_request` - `UrlFetchApp.fetch()` to your own openpost instance.
- `gmail.readonly` + `script.scriptapp` - **only used by `Linker.gs`**, to search Sent mail for the
  token and to install the polling trigger. `gmail.readonly` is a broad grant. **`Linker.gs` is
  optional**: skip `installLinker()` in `Setup.gs` if you do not want to grant it. Without it,
  add-on-tracked messages are simply never linked to a real Gmail message - no reply detection, no
  thread id - and are reaped to `status='abandoned'` after `ADDON_LINK_TIMEOUT_HOURS` (default 48).
  This is deliberate: polling happens inside *your own* Apps Script project, under *your own*
  Google account's authorization, rather than by widening openpost's own Gmail OAuth scopes (which
  stay metadata-only, exactly as documented in docs/03_roadmap.md).

## Quota notes

`UrlFetchApp`: roughly 20,000 calls/day on a consumer `gmail.com` account, 100,000/day on
Workspace. A 5-minute `linkSentMessages` trigger costs about 2 seconds of runtime per run
(~10 minutes/day of the 90-minute/day consumer time-driven-trigger budget) and at most one
`UrlFetchApp` call per still-pending draft per run (a few hundred calls/day in ordinary use) -
comfortable within either budget. These are 2026-era approximate figures reconstructed from search
summaries (network access to Google's own quota pages was blocked when this was written) - verify
against your own account's actual quota page if you send a very high volume through the add-on.

## Files

| File | Contents |
|---|---|
| `appsscript.json` | Manifest: scopes, compose trigger, homepage trigger |
| `Setup.gs` | `setup(baseUrl, token)`, `installLinker()`, `teardown()` |
| `Code.gs` | `onComposeTrack(e)` - the compose card; `onHomepage(e)` - a status card |
| `Linker.gs` | `linkSentMessages()` - the optional 5-minute sent-mail poller |

## Install checklist (operator-run)

0. Set `ADDON_ENABLED=true` and `API_TOKEN=<a real token>` in openpost's `.env`, and make sure your
   instance is reachable over HTTPS from Google's servers - `UrlFetchApp` calls come from Google's
   infrastructure, not from your phone, so a loopback-only instance cannot work here (this is
   different from the Chrome extension, which talks to `127.0.0.1` directly from your own browser).
1. Go to script.google.com, create a new project, paste in the four files above (as `.gs` files
   plus the manifest - enable "Show appsscript.json" under Project Settings to edit the manifest
   directly). In the Apps Script editor, run `setup('https://your-openpost-host', 'your-api-token')`
   once (you'll be asked to authorize the scopes). Optionally run `installLinker()`. Then
   `Deploy -> Test deployments -> Install` and confirm the add-on for your own account.
2. **Open the Gmail app on your phone, start composing a message, and look for the openpost icon.**
   If there is none, stop here: the compose surface is not available on your client, and openpost's
   own mobile compose page (`/dashboard/compose`) is the supported path instead. Record the result
   (client, OS version, present/absent) in `docs/reports/phase5_smoke.md`.
3. On Gmail **web**, compose a message, open the add-on, tap "Track with openpost", and confirm a
   new row appears in `/dashboard/messages` within a couple of seconds.
4. Send the message to yourself. In the received copy, use Gmail's "Show original" and search the
   raw text for your tracking host. If it is not there, Gmail stripped the pixel on send - report
   this and stop; the message will show up as sent-and-never-opened, which is honestly wrong.
5. If you installed `Linker.gs`, wait for one 5-minute cycle and confirm the dashboard row flips
   from `draft` to `sent` with a real Gmail thread id attached.
6. Open the received mail from a *different* device (not the sending account) and inspect the recorded event and classification. Early proxy fetches may stay uncounted; sender-copy suppression is not guaranteed for this add-on path.
7. When you're done testing, revoke the script's authorization
   (myaccount.google.com -> Security -> Third-party access) and confirm no further tracking rows
   appear from it.
