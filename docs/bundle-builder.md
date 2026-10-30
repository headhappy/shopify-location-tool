# Bundle Builder: recipe and preview release

Open `/bundle-builder.html` inside the existing Location app. This is phases 1–2
of the physical assembly brief. It saves recipes and costed, location-specific
planning snapshots. **No Shopify inventory mutations, reservations, assembly
commits, reversals or reconciliation executor exist in this release.** There is
no environment switch that enables inventory writes.

## Architecture and boundaries

- `server/bundle-catalog.js`: read-only Admin GraphQL operations, using the existing
  `createShopifyGraph` client and server-side Shopify credentials. Only this module
  pins API `2026-10`; legacy API versions and routes are untouched.
- `server/bundle-service.js`: rule validation, Crown colour matching, aggregation,
  stock checks, cost calculations and immutable preview snapshots.
- `server/bundle-store.js`: PostgreSQL recipes, full recipe version history,
  preview snapshots, sessions and login rate limits. Database is bound to one shop.
- `server/bundle-auth.js` / `bundle-routes.js`: individual staff identity, manager
  editing permissions, session/CSRF checks and exports.
- `public/bundle-builder.*`: staff login, visual recipe editor, variant picker,
  scanner keyboard input, assembly preview and history. No API credentials in UI.

Bundle routes mount **before** the existing wildcard CORS middleware. They do not
emit cross-origin access headers, require an authenticated session for catalogue,
costs and saved data, and require the configured Origin plus a session CSRF token
for writes. Cookies are HttpOnly, SameSite=Strict and Secure in production; tokens
are random and stored hashed in PostgreSQL. Sessions expire after eight hours,
are revoked on logout, and invalidate when an account is removed or its password
hash changes. Login attempts are limited per account and globally in PostgreSQL.

Existing location, barcode, label and stock-export endpoints retain their current
behaviour, including their existing access model. This is **not** a security retrofit
of those legacy endpoints. Before any future inventory executor is introduced,
review the whole app's security boundary, legacy writes and exposure. The new
module's recipe/preview API is protected now.

## Setup for review or a later approved deployment

The module's API in the existing app is disabled by default.
The static page shows setup guidance until an administrator configures it.

1. Install with `npm ci` (Node 22 or newer).
2. Provision a persistent PostgreSQL database. On Render, use a managed PostgreSQL
   service and its private connection string; configure backups. A local JSON file,
   SQLite file on an ephemeral disk, or browser storage is not an acceptable substitute.
3. Keep existing `SHOPIFY_SHOP` and `SHOPIFY_ACCESS_TOKEN`. Set `BUNDLE_DATABASE_URL`
   to the database connection string. Use TLS as required by your provider; do not
   disable certificate verification to work around connection errors.
4. Run `npm run bundle:migrate` with those variables. The migration is transactional,
   repeatable and refuses a database already bound to another shop. Run migrations
   once, separately from app startup. Tables use the `hh_bundle_` prefix.
5. Generate one scrypt password hash per person with `npm run bundle:password`.
   The utility reads a 12–256 character password from standard input, never a command
   argument. Supply it from a password manager or a secure stdin-capable tool; avoid
   typing a literal password into a shell command that will enter shell history.
   It outputs only the hash. Store hashes in the private environment, never Git.
6. Set `BUNDLE_STAFF_USERS` to a JSON array, for example:

   ```json
   [
     {
       "id": "alex",
       "name": "Alex",
       "role": "manager",
       "passwordHash": "<generated scrypt hash>"
     },
     {
       "id": "sam",
       "name": "Sam",
       "role": "staff",
       "passwordHash": "<different generated scrypt hash>"
     }
   ]
   ```

   Managers edit recipes and declare who manages finished stock. Both roles can
   read recipes/costs, save previews and export history. This first version assumes
   all configured staff may see all locations and preview history. Use individual
   accounts; there is no shared default password, registration or password reset API.

7. Set `BUNDLE_APP_ORIGIN` to the exact app origin with no trailing slash (for example
   `https://shopify-location-tool.onrender.com`). HTTP is allowed only for localhost
   outside production. Set `NODE_ENV=production` in production.
8. Set `BUNDLE_BUILDER_ENABLED=true`, then start the app. Missing configuration or
   unavailable/mismatched storage fails closed for this module; legacy tools continue.

`.env.bundle.example` lists the new variables. It is not automatically loaded;
use the existing `.env` or hosting environment. Never paste tokens or passwords into
the recipe editor, a PR, CSV files or screenshots.

## Shopify permissions and API references

This module requires `read_products`, `read_inventory`, and `read_locations` (the
corresponding write scope also grants read access). It checks the current app's
granted scopes. It does **not** request or require `write_inventory`. The existing
app may already have separate permissions for its location metafield updates.
Shopify unit-cost visibility must also be available to the app/account. Missing or
inaccessible costs do not become zero; previews flag them and suppress margin totals.

- [Product variant search and filters](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/productVariants)
- [Inventory item, unit cost and location inventory level](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/InventoryItem)
- [InventoryLevel and available quantities](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/InventoryLevel)
- [ProductVariant and requiresComponents](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ProductVariant)
- [Locations](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/locations)

All four new GraphQL operations were validated against Shopify's `2026-10` schema.
The connected-store product read confirms the Crown product is draft with four
finished variants; the grinder parent has six variants. Automated tests use synthetic
fixtures, not live inventory. Runtime credentials and permissions still need a
read-only staging smoke check after configuration.

## Rules and the Crown starter recipe

- **Exact SKU**: case-sensitive and must resolve to exactly one Shopify variant.
  The saved rule also pins its stable variant GID. SKU reassignment fails until a
  manager changes the rule or replaces the component group; an ordinary edit keeps
  the server's existing variant pin, regardless of a client's supplied pin.
- **Parent product**: a product GID or numeric product ID; all non-archived variants
  are resolved afresh, so new colours qualify automatically, except explicit exclusions.
- **Prefix**: literal letters/numbers/underscore/hyphen, with an optional final `*`.
  For example `RB_RC_M*`. Arbitrary regex and Shopify search operators are rejected.
  Matching is verified locally after Shopify search, including across parent products.
- **Restricted group**: explicit stable variant GIDs selected through the UI picker.
- **Colour matching**: a component may allow any eligible variant, or require an
  explicit binding for **every** finished variant. Bindings must belong to its rule.

The Crown template resolves product `16090289471869` and its SKUs at runtime, then
binds `RBK_RC_M1_A1` to `RB_RC_M1`, and likewise colours 2, 3 and 6. Its grinder rule
uses parent `8327686553754`; Gold and Silver papers use `PAPK_RDY` and `PAPR_RDY_A1`.
It is an unsaved starter until a manager reviews and saves it. It does not create
or publish any Shopify products. No prices or costs are hardcoded into previews.

Searches follow all pages; a non-advancing cursor or a rule spanning more than 5,000
variants fails explicitly. Narrow a broad rule rather than relying on partial results.
Recipes allow 50 finished variants, 30 component groups, 100 manually listed/excluded
variants per group, 1–1,000 units per component and 1–10,000 finished units per preview.
One actual variant is selected per component group per preview. For mixed colours
within a batch, create separate previews for each actual combination.

## Preview correctness and history

Every preview re-reads Shopify eligibility, available stock at the chosen location,
costs and selling price. Repeated selections of a variant are aggregated, and shared
inventory-item demand is also aggregated. Negative availability, missing levels,
untracked items, missing costs, currency mismatch and Shopify virtual-bundle flags
are blockers. The finished SKU must be tracked and stocked at the location.

The module cannot inspect Bundles.app's external configuration. The manager's
ownership declaration is an audited assertion, not automated proof of exclusion.
`unconfirmed` and `external` recipes can be saved/planned but receive a blocker.
Even `physical` recipes cannot execute adjustments in this release. Mylar 50-packs
and all existing Bundles.app rules remain untouched.

Costs use integer units with four decimal places before display rounding. Missing
costs suppress the whole total and margin rather than produce a misleading partial
sum. Margin is labelled **indicative price/cost margin**: Shopify price may include
VAT while costs may not, and labour, packaging and fees are not added. Do not treat
this value as an accounting gross margin without an agreed tax/cost basis.

Previews are immutable `PREVIEW_ONLY` records with server-attributed staff, full recipe
snapshot/version, exact variant/item GIDs, SKU snapshots, quantities, location, costs,
observed availability, blockers, timestamp and proposed deltas. They do not reserve
stock or promise availability at a later time. A retry with the same request key and
inputs returns the existing snapshot. Reuse for different inputs returns HTTP 409.
A changed recipe version must be reloaded. Recipe saves use optimistic concurrency
and preserve every version in a transaction with its manager and timestamp.

`GET /api/bundles/previews.csv` exports all history in keyset-paginated batches,
including entries with identical timestamps. Numeric proposed deltas remain numeric;
untrusted spreadsheet formula prefixes are neutralised. `AppliedDelta` is always 0,
`InventoryChanged` is FALSE, and `Status` is PREVIEW_ONLY. Import into Access as a
**planning/history table**, never as an instruction to adjust stock. IDs should be
text fields; timestamps are UTC ISO strings and costs are decimal values.
`GET /api/bundles/previews` returns 100 entries and an optional `nextCursor`; pass
that as `?cursor=...`. Recipe version history is available at
`GET /api/bundles/recipes/:id/history`.

## Verification

```sh
npm ci
npm test
npx playwright install chromium
npm run test:bundles:browser
```

`npm test` includes existing location/network tests, resolver and preview safety,
PostgreSQL persistence, version conflicts, replay collisions, CSV export, real Express
HTTP authentication, CSRF, roles, login throttling and session expiry/revocation.
Locally it uses pg-mem; PR CI supplies `BUNDLE_TEST_DATABASE_URL` for actual PostgreSQL 16. Each test creates and drops a fresh random schema in that **test database**.
Never point that variable at production. Real database rollback testing runs in CI.
The browser test drives real UI and routes with synthetic Shopify reads at desktop,
390px and 320px widths. `BUNDLE_BROWSER_CHANNEL=chrome` can use an installed Chrome
instead of a downloaded test browser. Screenshots go to ignored `test-results/`.

## Separate future stage: inventory transactions

Phase 3 is not implemented here. Before authorising it, design and test:

1. An explicit finished-product ownership register and Bundles.app exclusion review.
2. Inventory-write scope verification and an authorised staff/security boundary.
3. Durable assembly intent, unique idempotency key, exact per-item/location ledger,
   compare-and-set/precondition checks and concurrent-assembly coordination.
4. States such as PREPARED, APPLYING, NEEDS_RECONCILIATION, COMPLETED, REVERSING and
   REVERSED; never assume an ambiguous network failure means a mutation did not run.
5. Evidence-based reconciliation of partial/unknown results before retrying anything.
6. Reversal from the original component ledger, with finished-stock availability and
   double-reversal safeguards; retain costs and staff attribution, do not recompute
   the original recipe from today's rules.
7. Mocked partial-failure tests followed by a separately approved one-kit Black Crown
   pilot. Verify every exact component decrement and exactly one finished increment.

No merge or live inventory write is required to test this release.

## Isolated Render test service

Deploy the PR branch `codex/bundle-builder-preview` as a separate Node web service.
Use `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` for the build and
`npm run start:bundle-preview` to start. Set `NODE_ENV=production`, the existing
`SHOPIFY_SHOP` and `SHOPIFY_ACCESS_TOKEN`, `BUNDLE_DATABASE_URL` to a separate private
PostgreSQL database, and `BUNDLE_STAFF_USERS` to individual account hashes. This
entry point uses Render's `RENDER_EXTERNAL_URL` for the origin unless explicitly
overridden by `BUNDLE_APP_ORIGIN`.

The test entry point runs the repeatable migration before listening, because free
Render services have no pre-deploy hook. It refuses to start with invalid credentials
or unavailable storage. `/health` checks PostgreSQL and reports the deployed commit
and `inventoryWritesEnabled: false`. Only builder assets and its protected API are
served; no legacy mutation routes are mounted. Navigation to the existing location,
label and stock tools opens their original live service.

The Shopify transport accepts only the four reviewed query constants. Mutations and
unreviewed queries fail before any network call. There is no inventory-write flag.
Component resolution, preview and recipe edits all reject stale recipe versions.

Use a separate PostgreSQL 16 instance in the same region, disable public database
access, and keep its URL in Render's private environment. A free database has no
backups and expires after 30 days; export records or upgrade before expiry. Do not
use it as the permanent assembly ledger. Keep test-service auto-deploy disabled
and deploy reviewed commits deliberately. This does not modify the production
Location app or merge the PR.
