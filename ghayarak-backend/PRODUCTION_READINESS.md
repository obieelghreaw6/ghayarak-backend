# Production Readiness Checklist

This covers the parts of the security/production-readiness milestone that
are **operational, not code** — they need a real deployed environment,
real traffic, or real human review to actually verify. Everything else
from that milestone (auth, RBAC, rate limiting, session revocation,
financial immutability, ownership checks) is implemented in the backend
already — see `README.md` for what's built and why.

This document is deliberately a checklist, not a claim that any of it is
done. Nothing here should be treated as complete until someone has
actually run it against a real deployment and checked the box.

---

## 1. Attack / abuse test script

Run every one of these against a real staging deployment before launch.
Each one should fail (i.e. the attacker should be blocked) — if any
*succeeds*, that's a launch blocker, not a backlog item.

- [ ] Can a customer view or modify another customer's order by guessing/enumerating order IDs?
- [ ] Can a seller edit or delete another seller's listing?
- [ ] Can a seller change a listing's price after a buyer has already ordered it? (Confirm: the order stores its own price snapshot at creation — verify the snapshot, not the live listing price, is what's charged.)
- [ ] Can a buyer manipulate the order total by tampering with the request body? (Confirm: commission/protection/delivery are recalculated server-side from the listing, never trusted from the client — verify by sending a forged `commissionAmount` or `partPrice` in a raw request.)
- [ ] Can someone other than the seller mark an order as delivered/collected?
- [ ] Can a buyer issue themselves a refund, or approve their own refund request?
- [ ] Can an admin-only endpoint be called successfully by a `buyer` or `seller` role token? Test every route under `/admin`.
- [ ] Can two buyers simultaneously "win" the same listing? (Covered by the accept-reserves-and-cancels-siblings logic — verify under real concurrent load, not just sequential requests.)
- [ ] Can one person create unlimited accounts to bypass rate limits? (Rate limiting here is per-contact and per-IP; test with rotating fake contacts from one IP, and rotating IPs with one contact.)
- [ ] Can someone spam `POST /auth/request-otp` past the rate limit by varying casing/whitespace in the contact field?
- [ ] Can the same DPAY webhook payload be replayed to double-record a payment? (Covered by the `payments.status !== 'paid'` guard — verify with an actual replayed request, not just code review.)
- [ ] Can a double-tap on "Buy" (two near-simultaneous requests) create two orders for the same listing? (Covered by the unique index on `orders(listing_id, buyer_id)` — verify under real concurrency, e.g. two requests fired within the same event loop tick.)
- [ ] Can a `moderator` or `support` role reach `finance`-only endpoints (settlements, refunds, transactions)? Should be blocked by the `financeOnly` middleware — verify directly.
- [ ] Can a suspended or banned seller still create new listings or accept orders? (Not currently enforced — see "Known gap" below.)

### Gaps closed since the last pass
Suspending/banning now actually enforces: `GET /listings` excludes any
listing from a suspended/banned seller or shop, `GET /listings/:id`
treats it as not-found for non-staff, `POST /orders` refuses to create an
order against one, and — the deeper fix — `requireAuth` now re-checks the
user's live status on *every* authenticated request, not just at login.
Before this, banning someone didn't revoke their existing session, so a
banned user with a still-valid token could keep acting until it expired.

- [x] Suspended/banned sellers' listings hidden from search and direct URL access
- [x] Suspended/banned sellers blocked from having new orders placed against their listings
- [x] A banned/suspended user's existing (non-expired) sessions stop working immediately, not just new logins

### Still open
- [ ] `POST /orders/:id/accept` relies on the requireAuth fix above (a suspended seller can no longer authenticate at all) rather than a redundant explicit check in the route itself — verify this holds under test rather than assuming
- [ ] There's no admin route yet to suspend/ban a plain `buyer` role, only sellers/shops — the `users.status` column and the enforcement in `requireAuth` both already work generically for any role, this is just a missing UI/route, not a missing capability

---

## 2. Arabic / English QA pass

Test every screen in both languages, specifically:

- [ ] RTL layout with Arabic — check every screen for LTR content bleeding through (numbers, prices, English proper nouns like make names)
- [ ] Long Arabic product titles/descriptions — check truncation and card layout don't break
- [ ] Mixed-direction text (an Arabic sentence containing a Latin part number or make name) — check no garbled ellipsis or reversed characters (this was already found and fixed once for listing titles; check every other text field that mixes scripts: shop descriptions, dispute descriptions, chat messages)
- [ ] Dates and numbers render correctly in both locales
- [ ] Every validation/error message has both an English and Arabic string with no fallback to a raw key name
- [ ] Every notification type has both language strings
- [ ] Admin dashboard tables and forms in both languages
- [ ] Currency formatting (LYD / د.ل) consistent everywhere

---

## 3. Resilience testing

- [ ] Kill network connectivity mid-checkout — reopen the app, confirm no duplicate order and a clear "you have an unfinished order" state
- [ ] Double-tap every primary action button (Buy, Accept, Confirm Receipt, Submit Dispute, Send Message) — confirm exactly one record is created, not two
- [ ] Simulate a slow/flaky connection (network throttling) through the full buy → deliver → confirm flow
- [ ] Force-close the app mid-checkout, reopen, confirm state is recoverable
- [ ] Send a payment webhook twice in immediate succession — confirm no double-crediting (see attack test list above)

---

## 4. Monitoring & alerting

Nothing here exists yet — it requires a real deployed instance and a
monitoring service (e.g. Sentry for errors, a hosted Postgres provider's
built-in metrics, or a dedicated APM). Recommended minimum before launch:

- [ ] Error tracking wired to the centralized error handler in `index.js` (it already generates a correlation ID per error — pipe that + the stack trace to a real error-tracking service instead of just `console.error`)
- [ ] Alert on: elevated 5xx rate, elevated failed-login rate, elevated OTP-request rate (possible abuse), DPAY webhook failures, database connection failures
- [ ] A simple `/health` endpoint already exists — extend it to check real DB connectivity, not just that the process is up
- [ ] Basic uptime monitoring (even a free external ping service is better than nothing at launch)

---

## 5. Backup & disaster recovery

Also entirely infrastructure, not code — depends on where Postgres ends
up hosted (Railway, Supabase, Neon, self-managed, etc.):

- [ ] Automated daily backups enabled (most managed Postgres providers offer this as a checkbox — verify it's actually on, don't assume the default)
- [ ] Backup retention policy decided and documented (e.g. 30 daily + 12 monthly)
- [ ] Encrypted at rest (again, usually a provider setting — verify)
- [ ] **Actually run a restore test before launch.** An untested backup is a hypothesis, not a backup. Restore to a separate instance and verify the data is intact and the app can run against it.
- [ ] Document the actual restore procedure somewhere the team can find it during an incident, not just "we have backups"

---

## 6. Load testing

- [ ] Basic load test against the search/browse endpoints (highest-traffic path)
- [ ] Load test the order-creation path specifically, given the concurrency-sensitive unique constraint added in this pass — confirm it holds up correctly (rejects duplicates cleanly) under concurrent load, not just that it doesn't crash
- [ ] Identify the actual bottleneck (usually the database) before scaling infrastructure blindly

---

## 7. Final visual/UX consistency pass

A dedicated pass across the built app, checking:

- [ ] Button styles, spacing, and typography are consistent across every screen (some screens were built in earlier sessions before the design system settled — spot-check for drift)
- [ ] Loading states exist for every async action (some newer screens may be missing them)
- [ ] Empty states exist and are helpful, not just blank (search results with zero matches, empty inventory, no notifications, etc.)
- [ ] Error states are user-friendly everywhere, matching the backend's "حدث خطأ غير متوقع" pattern — not a raw error string leaking through in the frontend
- [ ] Confirmation dialogs exist for destructive actions (remove listing, cancel order, delete account)
- [ ] Icons are all confirmed to actually exist in the pinned lucide-react version (this broke the build once already this project — see the `House` icon incident)

---

## 8. Launch checklist

Organize a real pre-launch sign-off around this three-column list —
each item should be manually walked through end-to-end by a real person
on a real device before calling it done, not just "the code exists":

**Customer**: Register/login · Search · Browse · Request a part · Save a
vehicle · Buy · Pay · Track an order · Message a seller · Open a dispute
· Leave a review · Manage account/security settings

**Seller**: Register · Get verified · Set up a shop · Upload a listing ·
Manage inventory · Respond to part requests · Manage orders · Fulfil
(pickup/delivery) · Message a buyer · View sales · View commission owed
· View settlement history

**Owner/Admin**: Dashboard overview · Manage users · Manage sellers ·
Manage shops · Moderate listings · Manage orders · View payments ·
Track commissions · Manage settlements · Resolve disputes · Review fraud
reports · Verify sellers · Generate reports · View analytics · Review
audit logs · Check system health

---

## What's already real, for context

Everything else from the security milestone — password auth (scrypt
hashing), OTP with rate limiting, 2FA (RFC 6238 TOTP, functionally
tested), session/device tracking with real revocation, role-based access
control across every route file (buyer/seller/shop/moderator/support/
finance/admin/owner), ownership checks on every mutation, financial
immutability via append-only audit tables, the double-order race
condition fix, and the listing/shop privacy-leak fixes — is implemented
in the actual backend code, not this document. This checklist is
specifically the remainder: the things that only exist once there's a
real server running somewhere with real traffic hitting it.
