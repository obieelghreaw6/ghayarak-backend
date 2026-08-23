# Ghayarak API

Backend for the Ghayarak marketplace: Postgres for storage, DPAY for
payments, JWT for sessions.

## Setup

```bash
npm install
cp .env.example .env    # then fill in DATABASE_URL, JWT_SECRET, DPAY keys
npm run migrate         # creates all tables
npm run dev
```

Needs a Postgres database (Railway, Supabase, Neon, or your own VPS all
work) and a DPAY merchant account (dpay.ly) for the API token and
webhook secret.

## Auth flow

1. `POST /auth/request-otp { contact }` — sends a 6-digit code. **Currently
   only logs to the console** — wire a real SMS/email sender before
   launch (Libyana/Al-Madar SMS gateway, or an email provider if using
   email sign-in).
2. `POST /auth/verify-otp { name, contact, code }` — returns a JWT.
3. `POST /auth/owner-login { name, contact, passcode }` — bypasses OTP
   for the platform owner, gated by `OWNER_PASSCODE`.

Send the JWT as `Authorization: Bearer <token>` on subsequent requests.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/listings?category=&city=&q=&page=` | — | Browse/search |
| GET | `/listings/:id` | — | Listing detail |
| POST | `/listings` | ✓ | Create a listing |
| PATCH | `/listings/:id` | ✓ (owner) | Mark sold / remove |
| POST | `/listings/:id/boost` | ✓ | Start boost payment, returns DPAY checkout URL |
| POST | `/shops` | ✓ | Create shop + start subscription payment |
| GET | `/shops/:id` | — | Shop page + its listings |
| POST | `/shops/:id/subscribe` | ✓ (owner) | Renew/change tier |
| POST | `/orders` | ✓ | Buyer places an order (any payment method, seller collects directly) |
| GET | `/orders?role=buyer\|seller` | ✓ | My orders / my sales |
| GET | `/orders/:id` | ✓ | Order detail + its disputes |
| POST | `/orders/:id/accept` | ✓ (seller) | Accept a pending order — reserves the listing, auto-declines sibling pending orders |
| POST | `/orders/:id/cancel` | ✓ (buyer/seller) | Buyer cancels a pending order, or seller declines/cancels through 'preparing' |
| POST | `/orders/:id/prepare` | ✓ (seller) | accepted → preparing |
| POST | `/orders/:id/dispatch` | ✓ (seller) | preparing → ready_for_pickup (pickup) or out_for_delivery (delivery) |
| POST | `/orders/:id/fulfil` | ✓ (seller) | → collected (pickup) or delivered (delivery) |
| POST | `/orders/:id/confirm` | ✓ (buyer) | Confirm receipt from delivered/collected — snapshots commission, invoices seller |
| GET/POST | `/orders/:id/messages` | ✓ | Order-scoped chat thread |
| GET/POST | `/listings/:id/messages` | ✓ | Pre-purchase question thread on a listing |
| GET | `/notifications` | ✓ | In-app notification feed |
| GET | `/notifications/unread-count` | ✓ | Badge count |
| POST | `/notifications/:id/read`, `/notifications/read-all` | ✓ | Mark read |
| POST | `/orders/:id/dispute` | ✓ (buyer) | Report a problem (wrong part, damaged, etc.) |
| POST | `/deals` | ✓ | (Legacy/future) Start a true-escrow Protected Deal — see caution below |
| POST | `/deals/:id/confirm-pickup` | ✓ (buyer) | Release escrow to seller |
| POST | `/deals/:id/dispute` | ✓ (buyer) | Flag for admin review |
| GET | `/admin/overview` | ✓ (admin) | Stats + revenue totals (boost/subscription/protection/commission) |
| GET | `/admin/money` | ✓ (admin) | Today's sales, commission, outstanding vs settled, refunds |
| GET | `/admin/sellers` | ✓ (admin) | Unified shop + individual seller list |
| GET | `/admin/sellers/:type/:id` | ✓ (admin) | Drill-down: a seller's listings, orders, disputes, settlements |
| POST | `/admin/sellers/:type/:id/status` | ✓ (admin) | Approve / suspend / ban a seller |
| POST | `/admin/sellers/individual/:id/level` | ✓ (admin) | Set individual seller level (individual/verified) |
| GET | `/admin/listings/pending` | ✓ (admin) | Moderation queue |
| POST | `/admin/listings/:id/moderate` | ✓ (admin) | Approve / reject / flag a listing |
| GET | `/admin/shops/pending` | ✓ (admin) | Unverified shops |
| POST | `/admin/shops/:id/verify` | ✓ (admin) | Verify a shop |
| POST | `/admin/listings/:id/remove` | ✓ (admin) | Moderate a listing |
| GET | `/admin/settlements?status=owed` | ✓ (admin) | Sellers who owe commission |
| POST | `/admin/settlements/:id/mark-paid` | ✓ (admin) | Manually record a commission payment |
| GET | `/admin/disputes?status=open` | ✓ (admin) | Open disputes needing review |
| GET | `/admin/disputes/:id` | ✓ (admin) | Full dispute drill-down (order, both parties, protection status) |
| POST | `/admin/disputes/:id/resolve` | ✓ (admin) | Resolve with refund_buyer / release_seller / partial / rejected |
| GET | `/admin/demand?maxResults=3&days=30` | ✓ (admin) | Unfulfilled search demand report |
| POST | `/orders/:id/reviews` | ✓ | Leave a review — only on completed orders, one per direction |
| GET | `/users/:id/reviews` | — | A seller's (or buyer's) review history + averages |
| POST | `/webhooks/dpay` | signed | DPAY payment callbacks |

## The transaction model — orders, not escrow

This is the important design decision, and it's deliberate: **Ghayarak never
holds a buyer's payment.** The buyer pays the seller directly, in whatever
form they've agreed (cash, LYPAY/OnePay, card, bank transfer). What
Ghayarak tracks is the order itself and the commission the seller owes on
completion.

1. Buyer calls `POST /orders` — this does **not** charge anyone. It just
   records the order (payment method, delivery method, price breakdown).
2. Seller calls `/orders/:id/accept`, then `/orders/:id/deliver`.
3. Buyer calls `/orders/:id/confirm` once they've received the part and
   paid the seller directly. This is the trigger point: the server creates
   a `settlements` row for the commission owed, and sends a DPAY invoice
   **to the seller** (not the buyer) asking them to pay their commission.
4. When that invoice is paid, the `/webhooks/dpay` handler marks the
   settlement `paid` and logs the revenue.
5. If the seller never pays, the settlement sits at `invoiced` —
   `GET /admin/settlements?status=owed` (or `invoiced`) is the manual
   collections queue. At meaningful volume this needs either automated
   dunning or blocking further listings for sellers with unpaid
   settlements — neither is built yet.

**Why not hold the money instead (true escrow)?** Doing so generally
requires payment-institution / e-money licensing in most jurisdictions,
Libya's CBL included. The `deals` table and `/deals` routes still exist in
this codebase for that future — once there's a licensed Libyan payment
partner — but they should stay dormant until legal counsel confirms the
structure. Confirm this with a Libyan lawyer before enabling it; this
isn't legal advice.

## Disputes

A buyer can report a problem on a `delivered` order (`wrong_part`,
`not_as_described`, `damaged`, `missing_items`, `wrong_item_sent`,
`counterfeit`, `other`). That flips the order to `disputed` and creates a
row in `disputes` for admin review via `GET /admin/disputes`. There's no
automated resolution — every dispute needs a human decision right now
(refund, replacement, reject the claim), which `POST /admin/disputes/:id/resolve`
just records after the fact.

## Money flow, end to end

1. Client calls `/listings/:id/boost` (or `/shops` or `/deals`).
2. Server creates a `payments` row (`status: 'pending'`) and a DPAY
   invoice, returns `paymentUrl`.
3. Client redirects the user to `paymentUrl` — DPAY handles the actual
   card/wallet entry, it never touches this server.
4. DPAY calls `POST /webhooks/dpay` when the payment settles. That
   handler verifies the HMAC signature, marks the payment `paid`, and
   applies the effect (features the listing, extends the subscription,
   or moves a deal's escrow to `held`), and logs a `revenue_events` row.
5. For Protected Deals specifically: escrow sits at `held` until the
   buyer calls `/deals/:id/confirm-pickup`, which is where a real
   payout to the seller needs to be triggered — that's the one TODO
   left deliberately open in `routes/deals.js`, since it depends on
   which DPAY payout method (or manual bank transfer) you set up.

## Not done yet, on purpose

- Real SMS/email delivery for OTP codes.
- The seller payout call inside `confirm-pickup`.
- Rate limiting / abuse protection on `request-otp` (needed before
  launch — right now nothing stops someone spamming codes).
- Image upload/storage (listings currently have no photo field —
  add an `images text[]` column plus S3-compatible storage, e.g.
  Cloudflare R2, when ready).

## Audit safety

Every financial question — "what did the buyer pay, what did the seller
owe, what happened to this order, has it been settled" — needs to be
answerable from records that can't have been quietly edited after the
fact. Four tables enforce this at the database level, not just by
convention: `order_status_history`, `seller_commissions`,
`dispute_events`, and `audit_logs` all reject `UPDATE` and `DELETE` via a
trigger (see the bottom of `migrations/schema.sql`) — application code can
only `INSERT` into them.

- `seller_commissions` is written once, at order completion, and is the
  permanent record of what was owed and how it was calculated
  (`gross_sale_amount`, `commission_pct`, `commission_amount`).
- `settlements` is the *mutable* companion — it tracks whether that
  commission has actually been collected (`owed → invoiced → paid`), and
  is allowed to change because collection status genuinely changes over
  time. If `settlements.commission_amount` ever disagrees with its linked
  `seller_commissions` row, that's a bug to fix, not a discrepancy to
  reconcile — they should never diverge.
- `order_status_history` logs every transition an order goes through,
  who caused it, and why — written by the same request that changes
  `orders.status`, inside the same transaction.
- `audit_logs` is the general ledger for admin actions that affect money
  or trust (shop verification, manually marking a settlement paid,
  resolving a dispute) — every `admin.js` mutation writes a before/after
  snapshot here.

This is enough to answer your example directly:

```sql
select o.*, sc.commission_amount, s.status as settlement_status
from orders o
join seller_commissions sc on sc.order_id = o.id
join settlements s on s.order_id = o.id
where o.id = 'ORD-26-00482';
```

## Payment method integrity

`payment_method` keeps `'other'` as a value (it's a real UI fallback), but
the schema won't let it become a silent data black hole:

- `payment_category` (`cash` / `electronic`) is **always** required and
  always accurate, even when the specific rail is `other` — so revenue
  and payment-mix analytics never degrade to "unknown" just because a
  buyer picked something outside the five listed methods.
- A check constraint (`payment_other_requires_detail`) makes the database
  itself reject an order where `payment_method = 'other'` but
  `payment_method_detail` is empty — the API validates this too, but the
  constraint means a future code path can't accidentally skip it.

## Order edge cases handled

- **Duplicate orders**: a buyer can't have two open orders (`pending`
  through `delivered`) on the same listing — `POST /orders` returns 409
  with the existing order's id instead of creating a second one.
- **Multiple interested buyers**: several buyers can each place a
  `pending` order on the same listing. Whichever one the seller accepts
  reserves the listing (`listings.status = 'reserved'`) and every other
  pending order on it is auto-cancelled with
  `cancel_reason = 'listing_reserved_elsewhere'`.
- **Cancellation**: buyers can only cancel while `pending` — once a
  seller has accepted, real-world money may already be arranged, so the
  buyer's recourse shifts to the dispute flow after delivery instead.
  Sellers can decline a `pending` order or cancel an `accepted` one (e.g.
  discovered they're out of stock); either releases the listing
  reservation back to `active`.

## Listing moderation

Every new listing lands with `moderation_status = 'pending'` and is
**invisible to public search** until an admin approves it via
`POST /admin/listings/:id/moderate`. This was a real bug I caught while
building this: the public `GET /listings` query didn't originally filter
on `moderation_status`, which would have made the entire moderation queue
theater — a listing could sit in "pending" while already being fully
visible to buyers. Fixed before it shipped.

## Unfulfilled demand

Every search (via `GET /listings?q=...`) is logged to `search_queries`
with how many results it returned. `GET /admin/demand` aggregates queries
that returned few or no results, grouped by normalized text — this is
the direct, unfiltered signal for "what inventory should we go recruit
sellers for," not a guess.

## Reviews

Reviews only attach to a `completed` order, enforced both by the API
(`POST /orders/:id/reviews` checks `order.status` before accepting) and
by a unique index on `(order_id, direction)` preventing a second review
in the same direction. This matches the requirement that reviews only
come from legitimate completed transactions — open reviews are much
easier to manipulate.

## Seller management

Shops and individual sellers are managed through the same conceptual
list (`GET /admin/sellers`) but different underlying rows: a shop's
`status` (pending/approved/suspended/banned) lives on the `shops` table
itself, while an individual's status and `seller_level`
(individual/verified) live on `users`. Suspending or banning a seller
does not currently cascade to hide their listings automatically — that's
a deliberate scope cut; wire it into the listings query's WHERE clause
(joining sellers/shops and checking status) before relying on it for
enforcement.

## Fulfilment flow

Pickup and delivery are genuinely different state machines, not the same
one with different labels:

```
pickup:   pending → accepted → preparing → ready_for_pickup → collected → completed
delivery: pending → accepted → preparing → out_for_delivery → delivered → completed
```

`POST /orders/:id/dispatch` is the one endpoint that branches — it looks
at `delivery_method` on the order itself and resolves to the correct next
status, so the frontend doesn't need to know which flow it's driving.
Either path can still go to `disputed`, `cancelled`, or `refunded` at the
appropriate point.

Delivery orders carry `delivery_address`, `delivery_notes`, and a rough
`estimated_delivery_at` (currently a flat +2 days — replace with a real
estimate once a courier integration exists; see "Delivery management" below).

## Messaging

Every message is scoped to either an order or a listing — never a free
DM — enforced by a check constraint (`messages_scope_check`). This keeps
every conversation attached to a real transaction or a specific part, so
if a dispute happens later, the message history is already sitting right
next to the order that needs it, instead of being an unrelated inbox
someone has to go dig through.

**On keeping conversations on-platform**: the schema doesn't attempt to
detect or block phone numbers in message text — that's a moderation/policy
decision, not a database one. If you want to discourage off-platform
contact-info sharing before a sale, that's a content filter to add at the
message-creation endpoint, and it needs to coexist with legitimately
showing seller contact info elsewhere (shop pages already show WhatsApp).
Don't conflate the two.

## Notifications

`notifications` is an in-app feed only — `channel` records what was
*attempted* ('in_app', 'push', 'sms', 'whatsapp') so a real push/SMS
integration can be added later without a schema change, but no actual
push delivery is wired up here. Browser push requires VAPID keys and a
service worker push subscription flow; SMS/WhatsApp requires a provider
contract — both are real integrations to add when you're ready, not
something this pass fakes.

## Delivery management

There's no courier/fleet system here — deliberately. The `delivery_*`
fields on `orders` are enough to show a seller "deliver to this address"
and give a buyer a status, which is the actual near-term need. Wiring an
"Active deliveries" admin view is mostly a read-only query over
`orders where delivery_method = 'delivery' and status in
('preparing','out_for_delivery')` — worth building once there's real order
volume, not before. Connecting a licensed courier company is a separate,
later integration exactly like the payment gateway was.

## Seller response time

Not a new table — computed on the fly from existing timestamps:
`part_offers.created_at - part_requests.created_at`, averaged per seller.
Cheap to query, and it's the kind of number that goes stale the moment
you try to cache it, so don't.

## Security & production readiness

This pass added: password auth (scrypt, no external dependency) as an
alternative to OTP; 2FA via a hand-rolled, functionally-tested RFC 6238
TOTP implementation (also no external dependency); session/device
tracking with real revocation (a valid JWT signature is no longer
sufficient — `middleware/auth.js` checks a live `sessions` row); DB-backed
rate limiting on every abuse-prone endpoint (OTP, login, listing/shop
creation, messaging, reviews); role-based access control extended to
`moderator`/`support`/`finance`/`owner` with per-route-group enforcement
in `admin.js`; and a fix for a critical pre-existing bug where Express 4
silently failed to forward async route errors to the error handler (see
`lib/patchAsyncRoutes.js`).

**Real bugs found and fixed during this audit, not just designed around:**
- `POST /listings/:id/boost` had no ownership check at all — anyone signed
  in could pay to boost someone else's listing.
- The new `owner`/`moderator`/`support`/`finance` roles would have been
  silently locked out of `/admin` and `GET /orders/:id` by leftover
  `role !== "admin"` checks — found and fixed in four separate places.
- A real race condition in order creation: the app-level duplicate-order
  check wasn't atomic with the insert, so two near-simultaneous requests
  (a double-tap, or a network retry) could both pass the check before
  either committed. Fixed with a unique partial index at the database
  level — the check that actually matters, not just the one at the
  application layer.
- Two `select *` public endpoints (`GET /shops/:id`, `GET /listings/:id`)
  were leaking internal fields — `status_reason` (moderation notes) and
  `moderation_note` — to anyone who requested them. Fixed with explicit
  column lists and, for the listing endpoint, an `optionalAuth` middleware
  so a pending listing stays visible to its own seller while staying
  hidden from the public.

**What this pass did not attempt**, because it can't be meaningfully done
as code — see `PRODUCTION_READINESS.md` for the actionable checklist:
real backups and disaster recovery, live monitoring/alerting, load
testing, and the actual pre-launch attack/abuse test run against a real
deployment.

**Follow-up pass**: closed the suspension-enforcement gap flagged above.
`GET /listings`, `GET /listings/:id`, and `POST /orders` now all check
seller/shop status, and — the deeper fix — `requireAuth` re-checks the
user's live status on every request, not just at login. Previously,
banning someone didn't revoke their existing session, so a banned user
with a still-valid token could keep acting until it expired.

## Refunds — a real state machine, not a status flip

`requested → approved → processing → refunded`, or `→ rejected` at either
of the first two steps. The order's own `status` only becomes `'refunded'`
at the final step (`POST /admin/refunds/:id/complete`), and that's also
the only point where a `ledger_adjustments` row and a `revenue_events`
row get written — intermediate states don't touch the books.

**What "refunded" honestly means here**: per Model A, Ghayarak never held
the buyer's money, so this table cannot claim to have moved it. `refunded`
records that a human (admin, on the seller's behalf) has confirmed the
money was actually returned — it's an attestation, not a transfer. Don't
build UI copy that implies otherwise.

A refund can originate two ways: automatically, when a dispute resolves
with `resolutionType: 'refund_buyer'` (goes straight to `refunded` since
the admin's decision is final), or directly via `POST /orders/:id/refund-request`
for cases with no dispute at all (e.g. a seller who already collected an
electronic payment cancels the order).

## Bank transfer confirmation

Manual and explicitly temporary. The buyer submits free-text reference
info (`POST /orders/:id/bank-transfer-confirmation`), an admin checks it
against the real bank statement outside this system, then approves or
rejects (`POST /admin/bank-transfers/:id/verify`). A partial unique index
blocks a second *pending* submission per order so admins aren't stuck
de-duplicating retries. Replace this with a real provider webhook the
moment bank-transfer processing is available through DPAY or a bank
integration directly — this was never meant to be permanent.

## Seller financials (`GET /me/financials`)

The statement view a seller sees for themselves — total sales, commission
outstanding vs. settled, refunds, recent orders, settlement history. It
auto-detects whether the caller owns a shop and scopes to shop-wide
figures if so, otherwise scopes to their individual sales. This is
deliberately separate from `/admin/money`, which is the owner's
platform-wide view — same underlying tables, different vantage point.

## Payment provider abstraction

`payments/dpay.js` is intentionally the only file that knows about DPAY
specifically. Every route that charges or invoices someone
(`listings.js` boosts, `shops.js` subscriptions, `orders.js` commission
invoicing) calls `createInvoice()` and nothing DPAY-specific — so adding
a second provider later means adding a second file with the same
function signature and choosing between them per-transaction, not
rewriting checkout.

