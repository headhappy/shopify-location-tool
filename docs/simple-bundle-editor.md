# Simple bundle setup

`/bundle-builder.html` is the product-first editor. Select an existing Shopify product, add component rows with quantities, and save. It uses the existing staff sessions, PostgreSQL recipe documents and versioned change history; no database migration or new credentials are required.

Component choices:

- **Product · all colours** stores a parent product rule. Current and future variants qualify automatically.
- **SKU family** stores a literal prefix. Separate products such as `BOX_1_RED` and `BOX_1_BLUE` can qualify for one component row. The picker shows the actual matching SKUs before selection.
- **Specific item** stores an exact SKU pinned to its Shopify variant ID. A reassigned SKU cannot silently change the saved component.

Quantity applies to the component row, not to every eligible colour. One grinder with six eligible colours means choose one grinder. Prices are visible inside each row's eligible-item list; different prices are flagged without changing the bundle's Shopify price.

Product search reads real Shopify products (including drafts) and paginates. Saving checks that output variants belong to one parent product, rejects self-components and overlapping eligible groups, and retains optimistic version checks. Existing colour bindings are retained when opening an earlier recipe. A manager can explicitly choose **Allow any eligible colour**; simply opening the editor never alters saved data.

## Inventory and POS boundary

This release saves definitions in the app. It does not create Shopify products, publish bundles, update Bundles.app, or synchronize the separately deployed Crown POS pilot. The UI labels the setup as stock updates off. No inventory mutation, write-scope request, payment action or webhook handler was added. Identifying the actual component variants at sale time remains necessary for accurate stock deductions. A family is eligibility, not a guess about which colour was sold.

Earlier assembly previews and their saved history remain available at `/assembly-history.html`; the earlier basket checker stays at `/deal-tester.html`. Both retain their original styles and protections. Existing location tools are unchanged.

## Verification

Run `npm test` and `npm run test:bundles:browser`. Browser coverage includes creating a bundle with all three component modes, changing quantity, saving/reopening, automatic eligibility of a new colour, discarding unsaved changes, session expiry, 390px/320px layouts, and the original assembly/history flows. CI also runs the persistence checks against PostgreSQL 16.

Shopify product search follows the [products query reference](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/products). The reviewed query is included in the existing read-only transport allowlist and schema validation script.
