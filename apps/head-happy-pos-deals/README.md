# Head Happy POS Deals — Crown pilot

A private Shopify POS smart-grid extension for one real Crown Rolling Kit sale at 31 Cowgate. This is separate from the browser Bundle Builder, which remains preview-only.

Scan the actual box, grinder, Gold papers and Silver papers in POS. Tap **Crown deal · £14.99**, then **Apply Crown deal**. Complete payment in Shopify POS. The order contains the four actual component variants and a named cart discount. It does not contain or stock the draft finished-kit SKU.

## Scope

- One Crown Medium box: the RB_RC_M numbered colour family.
- Any variant of the Head Happy two-piece grinder product (8327686553754).
- One PAPK_RDY and one PAPR_RDY_A1.
- One complete kit, quantity one per component, with no other items or discounts in this first pilot.
- Price £14.99, checked against the existing Crown kit variant before applying.
- Only Head Happy / 31 Cowgate / GBP / tax-inclusive store settings.
- Fresh read of variant identity, active status, catalogue price, tracking and location availability.
- Native fixed cart discount; normal Shopify POS checkout handles payment and inventory.
- No Admin mutations, webhooks, inventory-write or order-write scopes, backend credentials or Render changes.
- Refuses subscriptions, custom sale lines, nested bundles, unsupported baskets and incomplete stock reads.

## Important pilot boundary

This is a supervised one-sale pilot, not an unattended automatic promotion engine. POS UI code cannot guarantee that a home tile remains mounted throughout checkout. The mounted tile/modal watches for edits and removes its identified discount where safe, but that is **not a checkout validation guarantee**.

If the basket changes, remove the deal and apply again. Always check all four items and £14.99 at the payment screen. Do not roll this out to staff or allow multi-deal baskets until native-device edit, suspend/resume, discount, checkout and refund checks pass. A later promotion architecture must provide appropriate checkout enforcement for general use.

The app never clears the basket or removes an unrelated discount. If another discount is combined with its own, it stops and asks a manager to resolve the discounts. Stock checks do not reserve inventory. Bundles.app settings cannot be inspected by this extension; verify these component SKUs are not finished bundle SKUs managed by another app.

## Development and verification

Requires Node >=22.12 and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm validate
pnpm build
```

Shopify CLI generated the app and POS extension. The unrelated FAQ sample extensions and template metadata were removed. The POS extension targets API 2026-10.

Local verification: 41 automated tests, TypeScript checks, Shopify app config validation and Shopify app build pass. The exact product/inventory GraphQL query was validated by successful execution against Head Happy using the existing read-only connector. The four black-colour test items were in stock, and the kit price was £14.99 on 29 October 2026. These are not a substitute for a fresh inventory snapshot before checkout.

The installed Shopify AI Toolkit UI validator was attempted for both targets but cannot start because its own package is missing TypeScript. Its search catalog also predates the generated 2026-10 target. The installed 2026.10.2 Shopify types and CLI build were used; do not report the Toolkit validator as passed.

CI runs tests, type checking, config validation and build without publishing. No deploy occurs on merge.

## Release and access

Remote app created under Head Happy organisation 20198220. Public client ID is in shopify.app.toml; no secret belongs in the repository. Configure **custom distribution for Head Happy only**, not public distribution.

The intended Admin scopes are **read_products,read_inventory** only. The extension uses Shopify's authenticated direct API and native POS session. It does not use the browser builder staff password.

Release/install is a separate approval step. Review the code and scope screen first. Do not publish or install the default template configuration, which originally requested write_products.

## One real test sale and restock

1. Install the reviewed version on Head Happy, update Shopify POS on the phone/tablet, sign in with an account allowed to use the app and apply discounts, and select 31 Cowgate. Add the Head Happy deals tile to the smart grid.
2. Start an empty basket. Use one in-stock Crown Medium box and one eligible grinder of any chosen colours, plus one Gold and one Silver paper. Record the exact four SKUs and fresh available stock counts immediately before the sale.
3. Scan all four products normally. Tap the tile and apply the deal. Verify four correct component lines, a named Crown discount and a £14.99 total.
4. Before payment, test changing a component/quantity and removing/reapplying the deal. Confirm that an incomplete or extra-item basket is refused. Test that other promotions are not overwritten. If a discount remains on an invalid basket, stop and remove it manually.
5. For the approved actual test, restore one complete deal and complete the sale in POS using the agreed test payment method. A cash test is a real order and affects cash records. Do not toggle live payment settings or enter a fake card.
6. Capture the order number and receipt. Read the order in Shopify and verify the selected variant IDs, quantities, £14.99 total, discount and 31 Cowgate. Confirm each selected component fell by one, allowing for any concurrent store sales; finished-kit stock should not change.
7. Refund the test through POS and select restock for all four components at the same location. Verify the refund and each stock return. Keep the order/refund audit trail rather than deleting it.

Do not mark end-to-end validation complete until the order, stock and refund evidence exists. No real POS sale has been completed by the implementation tests.

## Official references

- [POS Cart API](https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/contextual-apis/cart-api)
- [POS direct API access](https://shopify.dev/docs/api/pos-ui-extensions/latest#direct-api-access)
- [Shopify POS test transactions](https://help.shopify.com/en/manual/sell-in-person/getting-started/setup-payment-method/test-transaction)
