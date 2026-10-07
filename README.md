# Entartica email → WhatsApp

Email-only integration. No booking-engine changes. Reads confirmation copies from
enquiry@entartica.com over TLS IMAP, extracts the footer address, selects a branch,
and sends an Exotel template with ALL populated inclusions and ride rows.

## Run locally

Requires Node 22.13+ (Node 24 recommended) and npm.

```powershell
npm ci
npm test
npm run preview -- "C:\Users\mandi\Downloads\Booking Confirmed.eml"
Copy-Item .env.example .env
# Fill credentials locally, then:
npm start
```

Preview prints customer data to your own terminal, never sends, and requires no
credentials. Do not share its output publicly. The watcher defaults to no sending.
SQLite state is in ignored data/state.sqlite; protect and back up this directory.
Run on an always-on machine using a process supervisor. One mailbox instance is
recommended. Email parsing is deterministic; email content is never executed.

## Configuration before activation

## Stable hosting: Railway

The temporary Windows processes and Cloudflare quick tunnel are for testing only.
For production, deploy this repository to Railway with a persistent volume mounted
at `/app/data`. The Docker image starts the Gmail watcher and callback server in
one service. Generate a public Railway domain; the service automatically builds
its callback URL from `RAILWAY_PUBLIC_DOMAIN` and `CALLBACK_SECRET`.

Set these Railway variables: `SEND_ENABLED=true`, `IMAP_HOST`, `IMAP_USER`,
`IMAP_PASSWORD`, `IMAP_MAILBOX=INBOX`, `TRUSTED_AUTHSERV_ID=mx.google.com`,
`POLL_SECONDS=60`, `CALLBACK_SECRET`, and the Rajsamand values below. Leave
`PROCESS_AFTER` empty for the first deployment so it begins with new mail only.
Never set `STATUS_CALLBACK_URL` when using Railway's generated domain.

```
EXOTEL_RAJSAMAND_HOST=api.exotel.com
EXOTEL_RAJSAMAND_ACCOUNT_SID=...
EXOTEL_RAJSAMAND_API_KEY=...
EXOTEL_RAJSAMAND_API_TOKEN=...
```

Do not deploy the local `.env`, `data`, or `bin` directories. Railway variables
hold secrets; the persistent volume retains duplicate protection and delivery
reports across deploys.

## Adding a location

1. Create and approve that location's template in its own Exotel WABA.
2. Add a location object in `config/locations.json` with its address aliases,
   Exotel sender, exact template name, `credentialKey`, and `approved:true`.
3. Add `EXOTEL_<CREDENTIAL_KEY>_HOST`, `_ACCOUNT_SID`, `_API_KEY`, and
   `_API_TOKEN` as Railway variables. Credential key values use uppercase letters,
   digits, and underscores, such as `COIMBATORE`.
4. Commit and redeploy. A matching footer address selects that location, sender,
   template, and credentials. Unknown locations are held rather than sent.

Example:

```json
{"id":"coimbatore","name":"Entartica Sea World Coimbatore","aliases":["coimbatore"],"sender":"917948502808","template":"your_approved_template","language":"en","credentialKey":"COIMBATORE","approved":true}
```

Gmail has been confirmed for this project. Put a Gmail app password in the local
.env IMAP_PASSWORD field (not your regular password). App passwords require Google
2-Step Verification and may be restricted by Workspace policy. Use OAuth if the
account cannot create app passwords. Run `npm run check:mail` to verify connection
without fetching emails or sending messages. Rajsamand's submission-ready body
and sample variables are in templates/rajsamand-template.md.

1. Confirm mailbox provider and enable IMAP. Use an app password where supported,
   or an OAuth access token (external refresh currently required). No normal
   mailbox password should be shared in chat. Gmail host is only a default.
2. Fill Exotel credentials and correct regional hostname in .env. This initial
   version assumes all configured senders are authorized by that one account.
3. In config/locations.json confirm Alibaug's number; it is deliberately null.
   Coimbatore, Saraighat, Prayagraj, Rajsamand and Raipur are mapped from the
   screenshot. Generic Sea World, Partner Desk, ECHT Marine, OTP/Comp and the
   US number are not assigned to any location. Raipur's display-name rejection
   needs checking with Exotel before activation.
4. Submit templates/booking_confirmation_inclusions.txt for each branch WABA.
   Set its actual approved template name/language and approved=true per location.
   The seven positional variables must match exactly. This version holds messages
   over a conservative 1024 characters rather than truncating inclusions.
5. Confirm authenticated RECEIVED copies exist in the mailbox. The supplied .eml
   looks like a sent copy and has no Authentication-Results header. It works in
   offline preview but live processing will hold it. Configure TRUSTED_AUTHSERV_ID
   for the receiving server. Live requires its first Authentication-Results header
   with DMARC pass for entartica.com. The provider must strip forged headers using
   its identity. Do not disable authentication to accommodate a sent-mail export.
6. Ensure booking WhatsApp permission is collected through your existing process.
   The supplied email does not establish consent; this app cannot infer it.
7. Set PROCESS_AFTER to the exact ISO activation timestamp, e.g.
   2026-10-05T14:00:00+05:30. Set SEND_ENABLED=true only when ready. Start with a
   fresh controlled booking addressed to your own WhatsApp number.

For that controlled booking, set TEST_RECIPIENT to your own WhatsApp number as
digits only. While set, the sender holds every booking for another customer.
After the test is verified, clear TEST_RECIPIENT before starting normal service.
Alternatively, TEST_BOOKING_ID can limit the controlled test to one booking ID.
Messages received through the same Gmail account are verified by Gmail's first
internal HTTP REST receipt header when Authentication-Results is absent. Other
messages need a trusted DMARC result. Remove test settings for regular use.

## Routing and extraction

Only the leaf footer cell starting `Time & Address:` supplies routing evidence.
HTML comments, inclusions and other text naming cities are ignored for routing.
Hours stay with the extracted address. Unknown or multiple city matches are held.
No default sender is used. Inclusions are all nonempty cells between the
Inclusions and Attractions headings. Unsupported email layouts are held; add
sanitized examples and tests before expanding the parser. The sample's visiting
hours are opening hours, not a booked ride time.

## Operations and failure handling

`npm run status` lists held, preview, accepted and uncertain jobs. Accepted means
Exotel accepted the API request, NOT delivered to the customer. This first version
does not host delivery webhooks; verify final delivery in Exotel's dashboard.

Repeated emails are deduplicated by branch + booking ID. Preview/live reservations
are separate. A durable reservation precedes network sending. Crashes, timeouts and
API failures are held for manual reconciliation, never automatically resent.
Mailbox connection failures retry on the next polling interval. Messages remain
unread/unmodified and are fetched with IMAP PEEK behavior. The first run starts now
unless PROCESS_AFTER is explicit; old bookings are not automatically replayed.
PROCESS_AFTER is persisted per mailbox/mode; changing the environment later does
not change the existing cutoff.

Held mail and failed jobs are retained but not automatically reprocessed after a
configuration change. Inspect the row with `status`, verify no message was accepted
in Exotel, then an operator can remove the affected jobs row AND corresponding
mailbox UID settings row from SQLite to retry that specific email. Never erase the
whole state database to retry; doing so loses duplicate protection. Keep backups.

For a single controlled test, `RETRY_HELD=true` rechecks a held email after a
configuration correction. Set it back to `false` as soon as that test completes.

## API reference

https://developer.exotel.com/api/send-template-messages-api
https://developer.exotel.com/docs/whatsapp-api/api-reference/send-message

Uses the documented template envelope whatsapp.messages, Basic authentication,
and checks per-message acceptance/SID rather than treating HTTP 2xx as delivery.
Real account compatibility still needs a controlled live test.
