-- Ghayarak database schema (PostgreSQL)
-- Run with: psql "$DATABASE_URL" -f migrations/schema.sql
--
-- Design principle for this pass: every financially-relevant fact must be
-- answerable from an immutable record, not reconstructed from the current
-- state of a mutable row. Tables marked APPEND-ONLY below have UPDATE and
-- DELETE blocked at the database level (see the triggers at the bottom) —
-- application code can only INSERT into them, never rewrite history.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------
-- Core identity
-- ---------------------------------------------------------------------
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  contact text not null unique,          -- phone or email
  contact_type text not null check (contact_type in ('phone', 'email')),
  role text not null default 'buyer' check (role in (
    'buyer', 'seller', 'shop', 'moderator', 'support', 'finance', 'admin', 'owner'
  )),
  -- Password auth is an alternative to OTP (email + password), never a
  -- replacement for it — phone OTP stays the primary path per the Libya
  -- context. Hashed with scrypt (Node's built-in crypto, no external
  -- dependency, no plaintext ever stored or logged).
  password_hash text,
  password_salt text,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  -- Soft delete: never hard-delete a user row once they have any order,
  -- listing, or financial history attached — that would break every
  -- foreign key and audit trail pointing at them. Deactivation is a status
  -- flip; the row stays for the historical record it's part of.
  deleted_at timestamptz,
  -- Privacy: what this user allows other parties to see. A seller should
  -- see what's needed to fulfil an order, not a buyer's full profile.
  phone_visible_to_sellers boolean not null default true,
  email_visible_to_sellers boolean not null default false,
  marketing_opt_in boolean not null default false,
  -- Admin/owner 2FA (TOTP, RFC 6238) — required for privileged roles,
  -- optional for everyone else. Secret is never sent back to the client
  -- after initial setup.
  totp_secret text,
  totp_enabled boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_users_role on users(role);

create table if not exists password_reset_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,             -- the raw token is emailed; only its hash is stored
  expires_at timestamptz not null,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_password_reset_user on password_reset_tokens(user_id);

create table if not exists email_verification_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);

-- One row per active login (per device/browser), not per JWT. This is
-- what makes "log out all other devices" and real session revocation
-- possible — a bare JWT with no server-side record can't be revoked
-- before it expires, only trusted or not.
create table if not exists sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  token_jti uuid not null unique,       -- matches the JWT's "jti" claim
  device_label text,                    -- "iPhone", "Chrome on Windows", set from User-Agent at login
  ip_address text,
  revoked_at timestamptz,
  last_active_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_sessions_user on sessions(user_id, revoked_at);
create index if not exists idx_sessions_jti on sessions(token_jti);

create table if not exists otp_codes (
  id uuid primary key default uuid_generate_v4(),
  contact text not null,
  code text not null,
  expires_at timestamptz not null,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_otp_contact on otp_codes(contact);

create table if not exists shops (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null,
  city text not null,
  description text,
  business_type text not null default 'shop' check (business_type in ('shop', 'distributor', 'dismantler')),
  tier text not null default 'basic' check (tier in ('basic', 'pro', 'elite')),
  verified boolean not null default false,
  -- Distinct from `verified` (a trust badge) — this is whether the shop is
  -- allowed to operate on the platform at all. A shop can be verified AND
  -- suspended (e.g. pending a dispute investigation).
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended', 'banned')),
  status_reason text,
  whatsapp text,
  address text,
  opening_hours text,
  delivery_available boolean not null default false,
  subscription_expiry timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_shops_owner on shops(owner_id);
create index if not exists idx_shops_status on shops(status);

-- Seller level for individuals (non-shop sellers). Shops have their own
-- verified/tier system above; this is specifically for the "Individual"
-- vs "Verified Seller" distinction on a person who hasn't set up a shop.
alter table users add column if not exists seller_level text not null default 'individual' check (seller_level in ('individual', 'verified'));
alter table users add column if not exists status text not null default 'approved' check (status in ('approved', 'suspended', 'banned'));

-- ---------------------------------------------------------------------
-- Listings
-- ---------------------------------------------------------------------
create sequence if not exists listing_seq start 1;

create table if not exists listings (
  id text primary key default ('GH-' || to_char(now(), 'YY') || '-' || lpad(nextval('listing_seq')::text, 4, '0')),
  seller_id uuid not null references users(id) on delete cascade,
  shop_id uuid references shops(id) on delete set null,
  title text not null,
  category text not null,
  make text not null,
  model text not null,
  year_from int,
  year_to int,
  price numeric(12,2) not null check (price >= 0),
  currency text not null default 'LYD',
  condition text not null,
  authenticity text check (authenticity in ('oem', 'aftermarket', 'refurbished', 'salvage')),
  part_number text,
  city text not null,
  description text,
  protected_deal boolean not null default false,
  featured boolean not null default false,
  featured_until timestamptz,
  -- 'reserved': an order on this listing has been accepted by the seller;
  -- it's held for that buyer and hidden from browse until the order
  -- completes (-> sold) or is cancelled (-> back to active).
  status text not null default 'active' check (status in ('active', 'reserved', 'sold', 'removed')),
  -- Separate from `status`: whether an admin has cleared this listing to
  -- actually appear in browse/search. A listing can be 'active' and still
  -- 'pending' moderation — it simply doesn't show publicly until approved.
  moderation_status text not null default 'pending' check (moderation_status in ('pending', 'approved', 'rejected', 'flagged')),
  moderation_note text,
  reserved_order_id text,              -- fk added after orders table exists
  views int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_listings_category on listings(category);
create index if not exists idx_listings_city on listings(city);
create index if not exists idx_listings_status on listings(status);
create index if not exists idx_listings_moderation on listings(moderation_status);
create index if not exists idx_listings_seller on listings(seller_id);

-- ---------------------------------------------------------------------
-- Part requests ("I need this part")
-- ---------------------------------------------------------------------
create table if not exists part_requests (
  id uuid primary key default uuid_generate_v4(),
  requester_id uuid not null references users(id) on delete cascade,
  make text not null,
  model text not null,
  year int,
  part_description text not null,
  condition_preference text,
  city text not null,
  urgency text not null default 'flexible' check (urgency in ('asap', 'week', 'flexible')),
  status text not null default 'open' check (status in ('open', 'matched', 'closed')),
  accepted_offer_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists part_offers (
  id uuid primary key default uuid_generate_v4(),
  request_id uuid not null references part_requests(id) on delete cascade,
  seller_id uuid not null references users(id) on delete cascade,
  shop_id uuid references shops(id) on delete set null,
  price numeric(12,2) not null,
  condition text not null,
  notes text,
  delivery_available boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_part_offers_request on part_offers(request_id);

-- ---------------------------------------------------------------------
-- Escrow (Phase 2 — dormant). True platform custody of buyer funds.
-- Do NOT activate until a licensed Libyan payment partner / e-money
-- structure is confirmed with legal counsel. The `orders` flow below is
-- what's actually live: seller collects payment directly, no custody.
-- ---------------------------------------------------------------------
create table if not exists deals (
  id uuid primary key default uuid_generate_v4(),
  listing_id text not null references listings(id) on delete cascade,
  buyer_id uuid not null references users(id) on delete cascade,
  seller_id uuid not null references users(id) on delete cascade,
  amount numeric(12,2) not null,
  protection_fee numeric(12,2) not null,
  escrow_status text not null default 'pending' check (escrow_status in ('pending', 'held', 'released', 'refunded')),
  dpay_invoice_id text,
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create index if not exists idx_deals_listing on deals(listing_id);

-- ---------------------------------------------------------------------
-- Orders — the live transaction model (Model A)
--
-- Buyer picks a payment method and pays the SELLER directly. Ghayarak
-- never touches that money. What Ghayarak tracks is the order itself
-- and the commission the seller owes afterward.
-- ---------------------------------------------------------------------
create sequence if not exists order_seq start 1;

create table if not exists orders (
  id text primary key default ('ORD-' || to_char(now(), 'YY') || '-' || lpad(nextval('order_seq')::text, 5, '0')),
  -- restrict, not cascade: a listing must never be hard-deletable once it
  -- has order history, or that history disappears with it. The app only
  -- ever soft-deletes listings (status = 'removed'), so this should never
  -- actually block anything in normal operation.
  listing_id text not null references listings(id) on delete restrict,
  buyer_id uuid not null references users(id) on delete cascade,
  seller_id uuid not null references users(id) on delete cascade,
  shop_id uuid references shops(id) on delete set null,

  -- Money, snapshotted at order creation. Never recompute these from the
  -- listing later — the listing's price can change after the order exists.
  part_price numeric(12,2) not null check (part_price >= 0),
  delivery_fee numeric(12,2) not null default 0 check (delivery_fee >= 0),
  protection_fee numeric(12,2) not null default 0 check (protection_fee >= 0),
  commission_pct numeric(5,2) not null default 5.00,
  commission_amount numeric(12,2) not null check (commission_amount >= 0),
  total_amount numeric(12,2) generated always as (part_price + delivery_fee + protection_fee) stored,

  -- Payment method: 'other' is a UI fallback, never a permanent analytics
  -- bucket. payment_category is ALWAYS cash or electronic regardless of
  -- which specific method was picked, so aggregate reporting never
  -- degrades to "unknown" just because the exact rail wasn't in our list.
  payment_method text not null check (payment_method in ('cash', 'lypay', 'card', 'bank', 'other')),
  payment_category text not null check (payment_category in ('cash', 'electronic')),
  payment_method_detail text,        -- required by app logic when payment_method = 'other'
  constraint payment_other_requires_detail check (
    payment_method <> 'other' or payment_method_detail is not null
  ),

  delivery_method text not null check (delivery_method in ('pickup', 'delivery')),

  -- Two fulfilment paths share one column, distinguished by delivery_method:
  -- pickup:  pending -> accepted -> preparing -> ready_for_pickup -> collected -> completed
  -- delivery: pending -> accepted -> preparing -> out_for_delivery -> delivered -> completed
  -- Either path can branch to disputed/cancelled/refunded at the appropriate point.
  status text not null default 'pending' check (status in (
    'pending', 'accepted', 'preparing', 'ready_for_pickup', 'out_for_delivery',
    'collected', 'delivered', 'completed', 'disputed', 'cancelled', 'refunded'
  )),
  -- Delivery-specific detail, only populated when delivery_method = 'delivery'.
  delivery_address text,
  delivery_notes text,
  estimated_delivery_at timestamptz,
  cancelled_by text check (cancelled_by in ('buyer', 'seller', 'admin')),
  cancel_reason text,

  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz
);
create index if not exists idx_orders_buyer on orders(buyer_id);
create index if not exists idx_orders_seller on orders(seller_id);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_listing on orders(listing_id);
-- The application-level "does an open order already exist" check in
-- orders.js is not atomic with the insert that follows it — two
-- near-simultaneous requests (a double-tap on "Buy", or a network retry
-- firing before the first response returns) can both pass that check
-- before either has committed. This index is what actually prevents the
-- duplicate: the second insert fails with a unique-violation at the
-- database level regardless of what the application already checked.
create unique index if not exists idx_orders_one_open_per_listing_buyer
  on orders(listing_id, buyer_id)
  where status in ('pending', 'accepted', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'collected', 'delivered');

alter table listings drop constraint if exists fk_listings_reserved_order;
alter table listings add constraint fk_listings_reserved_order
  foreign key (reserved_order_id) references orders(id) on delete set null;

-- Line items within an order. One row per listing purchased — today that's
-- always exactly one, since Buy is single-listing. Structured this way now
-- so multi-item carts don't require a breaking migration later; the order's
-- part_price/commission_amount stay as the authoritative totals until carts
-- exist, at which point they become sums over order_items instead.
create table if not exists order_items (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  listing_id text not null references listings(id) on delete restrict,
  quantity int not null default 1 check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  line_commission numeric(12,2) not null check (line_commission >= 0),
  created_at timestamptz not null default now()
);
create index if not exists idx_order_items_order on order_items(order_id);

-- APPEND-ONLY. Every status transition an order goes through, who caused
-- it, and when. This is the answer to "what happened to this order" —
-- never update the orders row's status without also inserting here.
create table if not exists order_status_history (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references users(id),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_order_status_history_order on order_status_history(order_id);

-- APPEND-ONLY. The immutable calculation of what a seller owes on a given
-- order, written once when the order completes. This is deliberately
-- separate from `settlements` below: this table answers "what was owed
-- and how was it calculated", settlements answers "has it been collected
-- yet" — the collection status can change; the calculation never should.
create table if not exists seller_commissions (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  seller_id uuid not null references users(id) on delete cascade,
  gross_sale_amount numeric(12,2) not null,
  commission_pct numeric(5,2) not null,
  commission_amount numeric(12,2) not null,
  calculated_at timestamptz not null default now()
);
create unique index if not exists idx_seller_commissions_order on seller_commissions(order_id);
create index if not exists idx_seller_commissions_seller on seller_commissions(seller_id);

-- Mutable collection status for a seller_commissions row. `commission_amount`
-- here is denormalized from seller_commissions at creation time for fast
-- reads — it must never be edited independently; if it ever needs to
-- differ from seller_commissions, that's a bug, not a feature.
create table if not exists settlements (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  seller_commission_id uuid not null references seller_commissions(id) on delete cascade,
  seller_id uuid not null references users(id) on delete cascade,
  shop_id uuid references shops(id) on delete set null,
  commission_amount numeric(12,2) not null,
  status text not null default 'owed' check (status in ('owed', 'invoiced', 'paid', 'waived')),
  dpay_invoice_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists idx_settlements_seller on settlements(seller_id);
create index if not exists idx_settlements_status on settlements(status);

-- One row per order that included a buyer-protection fee. Coverage status
-- is distinct from a generic dispute: a dispute can exist on an order with
-- no protection fee at all (buyer just complains), but a *claim* against
-- buyer protection specifically has its own approve/deny outcome, because
-- it's the thing the fee was actually sold as covering.
create table if not exists buyer_protection (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  fee_amount numeric(12,2) not null,
  status text not null default 'active' check (status in ('active', 'claimed', 'covered', 'denied', 'expired')),
  claim_dispute_id uuid,             -- fk added after disputes table exists
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists idx_buyer_protection_order on buyer_protection(order_id);

create table if not exists disputes (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  reporter_id uuid not null references users(id) on delete cascade,
  reason text not null check (reason in ('wrong_part', 'not_as_described', 'damaged', 'missing_items', 'wrong_item_sent', 'counterfeit', 'other')),
  description text not null,
  status text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'rejected')),
  -- What actually happened when an admin closed this out. Distinct from
  -- `status`: 'resolved' just means "an admin decided" — this says what
  -- they decided, which is the thing that must tie back to real money
  -- movement (refund_buyer means a real transfer happens outside this
  -- system today, since Ghayarak doesn't hold funds — see Model A notes).
  resolution_type text check (resolution_type in ('refund_buyer', 'release_seller', 'partial', 'rejected')),
  resolution_note text,
  resolved_by uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_disputes_order on disputes(order_id);
create index if not exists idx_disputes_status on disputes(status);

alter table buyer_protection drop constraint if exists fk_buyer_protection_dispute;
alter table buyer_protection add constraint fk_buyer_protection_dispute
  foreign key (claim_dispute_id) references disputes(id) on delete set null;

-- APPEND-ONLY. Every action taken on a dispute — status changes, notes,
-- evidence references, the final resolution. A dispute's current `status`
-- column can change; this log of how it got there cannot.
create table if not exists dispute_events (
  id uuid primary key default uuid_generate_v4(),
  dispute_id uuid not null references disputes(id) on delete cascade,
  actor_id uuid references users(id),
  event_type text not null check (event_type in ('opened', 'note_added', 'status_changed', 'resolved', 'rejected')),
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists idx_dispute_events_dispute on dispute_events(dispute_id);

-- Messages are deliberately scoped to an order (never a free-floating DM),
-- so every conversation has an audit trail attached to a real transaction
-- if a dispute needs it later. A message with no order yet — e.g. a buyer
-- asking a question before purchasing — attaches to the listing instead;
-- exactly one of order_id/listing_id is set.
create table if not exists messages (
  id uuid primary key default uuid_generate_v4(),
  order_id text references orders(id) on delete cascade,
  listing_id text references listings(id) on delete cascade,
  sender_id uuid not null references users(id) on delete cascade,
  recipient_id uuid not null references users(id) on delete cascade,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint messages_scope_check check (
    (order_id is not null and listing_id is null) or (order_id is null and listing_id is not null)
  )
);
create index if not exists idx_messages_order on messages(order_id);
create index if not exists idx_messages_listing on messages(listing_id);
create index if not exists idx_messages_recipient on messages(recipient_id, read_at);

-- In-app notification feed. Real push delivery (browser Push API / FCM /
-- APNs, or SMS/WhatsApp per the "considered later" note) is a separate
-- integration this table doesn't attempt — `channel` records what was
-- attempted so that layer can be added without a schema change.
create table if not exists notifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users(id) on delete cascade,
  type text not null check (type in (
    'order_accepted', 'order_preparing', 'order_dispatched', 'order_delivered', 'order_completed',
    'order_cancelled', 'dispute_update', 'request_response', 'new_order', 'matching_request',
    'new_message', 'settlement_due', 'listing_approved', 'listing_rejected',
    'new_dispute', 'suspicious_seller', 'large_transaction', 'failed_payment', 'commission_overdue'
  )),
  title text not null,
  body text,
  ref_type text,                      -- 'order' | 'listing' | 'request' | 'dispute' | 'settlement'
  ref_id text,
  channel text not null default 'in_app' check (channel in ('in_app', 'push', 'sms', 'whatsapp')),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user on notifications(user_id, read_at);

create table if not exists payments (
  id uuid primary key default uuid_generate_v4(),
  dpay_invoice_id text unique not null,
  kind text not null check (kind in ('boost', 'subscription', 'protected_deal', 'commission')),
  ref_id text not null,               -- listing id, shop id, deal id, or settlement id
  amount numeric(12,2) not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

-- Manual bank-transfer confirmation. Only relevant when payment_method =
-- 'bank' and there's no automated provider callback (yet) — the buyer
-- submits a reference, an admin checks it against the actual bank
-- statement outside this system, and marks it verified or rejected.
-- This is explicitly a bridge, not a real integration: replace with a
-- provider webhook the moment one exists for bank transfers.
create table if not exists bank_transfer_confirmations (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  submitted_by uuid not null references users(id) on delete cascade,
  reference_text text not null,       -- transaction ref / sender name / amount as the buyer reports it
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  verified_by uuid references users(id),
  verified_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_bank_transfer_order on bank_transfer_confirmations(order_id);
create unique index if not exists idx_bank_transfer_one_pending on bank_transfer_confirmations(order_id) where status = 'pending';

-- Refunds are a real state machine, not a status flip on the order. A
-- refund can originate from a resolved dispute OR be requested directly
-- (e.g. a seller cancels after an electronic payment already happened).
-- Per Model A, Ghayarak doesn't hold the money — 'refunded' here records
-- that the seller has attested to returning it, it does not itself move
-- money. That distinction matters for what this table can honestly claim.
create table if not exists refunds (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  dispute_id uuid references disputes(id) on delete set null,
  amount numeric(12,2) not null,
  reason text not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'processing', 'refunded', 'rejected')),
  requested_by uuid not null references users(id),
  approved_by uuid references users(id),
  rejection_reason text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  completed_at timestamptz
);
create index if not exists idx_refunds_order on refunds(order_id);
create index if not exists idx_refunds_status on refunds(status);

-- Every financial adjustment is its own row — never edit the original
-- order or revenue_events amount to reflect a refund. This is the ledger
-- entry a refund produces once it completes.
create table if not exists ledger_adjustments (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  refund_id uuid references refunds(id) on delete set null,
  adjustment_type text not null check (adjustment_type in ('refund', 'commission_waiver', 'correction')),
  amount numeric(12,2) not null,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_ledger_adjustments_order on ledger_adjustments(order_id);


create table if not exists revenue_events (
  id uuid primary key default uuid_generate_v4(),
  source text not null check (source in ('boost', 'subscription', 'protection', 'commission', 'refund')),
  amount numeric(12,2) not null,
  ref_id text,
  created_at timestamptz not null default now()
);

-- Rate limiting, DB-backed since there's no Redis in this stack yet. One
-- row per (identifier, action) attempt; middleware counts recent rows in
-- a rolling window rather than maintaining a counter, which is simpler to
-- reason about and self-cleans via the index below. identifier is a
-- contact, IP, or user id depending on what's being throttled.
create table if not exists rate_limit_events (
  id uuid primary key default uuid_generate_v4(),
  identifier text not null,
  action text not null,                 -- 'otp_request', 'login_attempt', 'listing_create', 'message_send', 'review_submit', etc.
  created_at timestamptz not null default now()
);
create index if not exists idx_rate_limit_lookup on rate_limit_events(identifier, action, created_at);

-- Counterfeit / stolen / misrepresented / unsafe reports on a LISTING —
-- distinct from `disputes`, which are order-scoped. A listing can be
-- reported before anyone has ever ordered it.
create table if not exists listing_reports (
  id uuid primary key default uuid_generate_v4(),
  listing_id text not null references listings(id) on delete cascade,
  reporter_id uuid references users(id),
  reason text not null check (reason in ('counterfeit', 'stolen', 'misrepresented', 'unsafe', 'other')),
  description text,
  status text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'dismissed')),
  resolution_action text check (resolution_action in ('none', 'listing_hidden', 'seller_contacted', 'seller_suspended')),
  resolved_by uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists idx_listing_reports_listing on listing_reports(listing_id);
create index if not exists idx_listing_reports_status on listing_reports(status);

-- Every committed search, with how many results it returned. This is the
-- source for "unfulfilled demand" reporting — queries that return zero or
-- few results are literally a list of inventory to go recruit sellers for.
create table if not exists search_queries (
  id uuid primary key default uuid_generate_v4(),
  query text not null,
  inferred_category text,
  city_filter text,
  result_count int not null,
  searcher_id uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_search_queries_created on search_queries(created_at);
create index if not exists idx_search_queries_result_count on search_queries(result_count);

-- Reviews only exist against a completed order — enforced by the app layer
-- checking order status before allowing a review, and by the unique index
-- below preventing a second review of the same direction on the same order.
-- This is deliberate: reviews tied to real transactions are much harder to
-- manipulate than open reviews, per the "legitimate completed transactions
-- only" requirement.
create table if not exists reviews (
  id uuid primary key default uuid_generate_v4(),
  order_id text not null references orders(id) on delete cascade,
  reviewer_id uuid not null references users(id) on delete cascade,
  reviewee_id uuid not null references users(id) on delete cascade,
  direction text not null check (direction in ('buyer_on_seller', 'seller_on_buyer')),
  overall_rating int not null check (overall_rating between 1 and 5),
  accuracy_rating int check (accuracy_rating between 1 and 5),
  condition_rating int check (condition_rating between 1 and 5),
  communication_rating int check (communication_rating between 1 and 5),
  speed_rating int check (speed_rating between 1 and 5),
  payment_rating int check (payment_rating between 1 and 5),
  pickup_rating int check (pickup_rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_reviews_order_direction on reviews(order_id, direction);
create index if not exists idx_reviews_reviewee on reviews(reviewee_id);

-- APPEND-ONLY. General-purpose ledger for administrative and financial
-- mutations that don't already have a dedicated history table above
-- (shop verification, manual settlement overrides, dispute resolution
-- decisions, etc). Every admin action that changes money or trust status
-- should write here, in addition to updating its own table.
create table if not exists audit_logs (
  id uuid primary key default uuid_generate_v4(),
  entity_type text not null,          -- e.g. 'settlement', 'shop', 'dispute', 'order'
  entity_id text not null,
  action text not null,               -- e.g. 'marked_paid', 'verified', 'resolved'
  actor_id uuid references users(id),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_logs_entity on audit_logs(entity_type, entity_id);

-- ---------------------------------------------------------------------
-- Append-only enforcement. Application code must never UPDATE or DELETE
-- rows in these tables — attempting to will raise a database error, not
-- just get caught by convention.
-- ---------------------------------------------------------------------
create or replace function reject_mutation() returns trigger as $$
begin
  raise exception 'Table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
end;
$$ language plpgsql;

do $$
declare
  t text;
begin
  foreach t in array array['order_status_history', 'seller_commissions', 'dispute_events', 'audit_logs', 'ledger_adjustments']
  loop
    execute format('drop trigger if exists trg_%s_append_only on %I', t, t);
    execute format(
      'create trigger trg_%s_append_only before update or delete on %I
       for each row execute function reject_mutation()', t, t
    );
  end loop;
end $$;
