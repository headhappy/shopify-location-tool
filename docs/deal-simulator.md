# Mix-and-match till simulator

Open `/deal-tester.html` from **Scan a deal · test** in Bundle Builder. Use the
existing staff login, choose a saved recipe and store, then scan the actual
component barcodes or exact SKUs. The manual item picker provides the same test
without a scanner. Complete sets receive the existing deal product's price in
the simulation. Extra eligible units remain at normal price; removing an item
recalculates the result. The practice basket is not saved.

## Scope and safety

- This is a browser simulator, not an installed Shopify POS extension.
- It uses existing recipe product/prefix/exact SKU/restricted-group rules.
  Product rules include all variants except explicit exclusions. Across this
  simulator only, physical-kit colour bindings do not apply. Recipes are never
  edited by testing a basket.
- Exactly one selected deal, one parent deal product, one currency (GBP), and
  one price across the listed finished variants are supported. Overlapping
  component groups refuse to match. Unrelated items are rejected in this first
  prototype rather than simulated as a general-purpose till.
- Eligibility, stock and prices are read afresh on every basket change. Scans
  match exact barcode or SKU across the catalogue; duplicates fail visibly.
  Basket changes are queued in order, including fast scanner submissions.
- Components that are untracked or themselves bundles are rejected. Missing
  stock, stock shortages and draft components warn; these are test estimates,
  never permission to complete a sale. Stock is not reserved.
- Pricing uses integer pennies. A deal cannot suggest a surcharge when its
  components are cheaper separately. Current POS discounts, tax calculations,
  refunds, offline operation and competing deals are not simulated.
- Every API is behind the existing staff session. POST requests also require
  the configured origin and CSRF token. Existing Shopify read-only operation
  allowlisting remains in force. No new scopes, migrations or credentials.
- There is no order creation, inventory adjustment, live discount or checkout
  endpoint. Tests do not save previews or create Shopify products.

## Shopify POS integration decision

The merchant's confirmed subscription is **Shopify Basic with POS Pro** (29 Oct
2026). Do not design the next stage around a Plus-only custom Function app.
Shopify documents POS UI extensions and cart/line discounts. Investigate that
route on a development store with the actual POS version and staff permissions.
Do not promise automatic grouping under one parent POS line or zero-tap
discounting until it is verified on that surface.

The future sale should retain actual component variant lines, allowing Shopify
to account for component inventory once. Do not also run assembly deductions or
Bundles.app deductions for the same sale. Validate returns, removals, retries,
existing discounts (including Discounty), overlapping deals, offline behaviour,
and staff permissions before any live rollout. The existing draft Crown product
and its four colour variants are untouched; its eventual role in the real POS
receipt still needs to be established.

Official references:

- https://shopify.dev/docs/apps/build/pos
- https://shopify.dev/docs/api/pos-ui-extensions/2026-10/target-apis/contextual-apis/cart-api
- https://shopify.dev/docs/apps/build/functions (custom Function plan limits)

## Validation

`npm test` covers matching, quantities, exclusions, stale recipes, exact scans,
duplicate codes, stock aggregation, decimal prices, auth and disabled writes.
`npm run test:bundles:browser` exercises scanner queueing, mixed colours, removal,
manual additions, errors, responsive layouts and logout alongside the original
assembly-preview tests. CI runs the suite with PostgreSQL 16.
