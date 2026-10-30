# Head Happy POS Deals

Tap **Build a deal** in Shopify POS, choose or scan the actual colours, check the complete set (including fixed components such as papers), and confirm to add it at the deal price. Return to the basket, check the total, then complete checkout normally.

The app reads the existing Bundle Builder recipes and takes the deal price from their existing Shopify product. It does not add that parent SKU to the basket or create another product. Matching items already scanned are reused; only missing quantities are added. Shopify sells and deducts stock from the actual selected variants at checkout.

## Staff setup

In the **Shopify POS app**, use **Add tile → App → Head Happy POS Deals** and select its **Build a deal** tile (the extension may still be listed as Head Happy deals). Staff need access to the installed app and permission to apply discounts. The app uses the Shopify POS session; the browser builder password is not needed on the till.

If the app is missing from that list, first verify that the active Shopify app version includes `[pos] embedded = true`. The top-level `embedded = true` only enables Shopify admin embedding; it does not make the app available in POS. Release the corrected app configuration, then verify **Head Happy POS Deals** appears under the Point of Sale channel's app settings before asking staff to add the tile. This is separate from Discounty.

1. Tap **Build a deal**. If several bundles are saved, choose the one to sell.
2. Choose or scan the box colour, then the grinder colour. Choices already in the basket are preselected. A shared barcode prompts staff to tap the actual colour.
3. Check the complete set, including both papers, and confirm to add it. Keep the guide open while it adds the items and confirms the price.
4. Return to the basket. For one Crown kit at its current price, confirm **£14.99** before payment.

Use **Number of deals** for several complete sets of the same bundle. Choose the required quantity in each step; colours can differ between kits. Unrelated ordinary products remain full price. Only the selected quantity of deals receives the price, even if more eligible components are in the basket. A single saved deal is applied per basket. To change an applied deal, remove its discount in the guide and review the choices again. Components stay in the basket.

Shopify requires a tap to open this custom guide. Scanning the parent barcode in the normal basket cannot open the questions automatically. Do not scan the parent product as well as its components; the guide refuses that combination to avoid charging twice. The old Apply deal tap's reported lack of response has not been reproduced on a physical till; the replacement has visible progress, errors and confirmation at the top, plus POS toasts.

## Pricing and safety

The server refreshes the saved version, exact family membership, prices and available stock at the active POS location. GBP and tax-inclusive prices are required. Existing discounts, gift cards, custom sales, subscriptions and nested bundles stop the operation for review.

Currency compatibility: earlier native Cart contracts do not include `currency`. When that field is absent, use the documented active-location `session.currency`, including in the transmitted quote and basket fingerprint. Never substitute a hard-coded GBP value or the shop's default currency. An explicitly conflicting basket currency, non-GBP session or unknown session currency still stops the deal with a specific message. Regression tests cover both native cart shapes; the guide footer identifies this release as **Guided GBP fix**. See Shopify's [Session API](https://shopify.dev/docs/api/pos-ui-extensions/2025-10/target-apis/standard-apis/session-api) and [earlier Cart API](https://shopify.dev/docs/api/pos-ui-extensions/2025-10/target-apis/contextual-apis/cart-api).

Native fixed line discounts are per unit. The saving is distributed across qualifying product lines in exact pennies. Repeated units of one variant share their line's saving, including surplus units on that line. Unrelated product lines never receive it. If the exact total cannot be represented by per-unit pennies, staff are asked to use a separate basket for complete deals.

The mounted tile attempts to remove stale discounts; the open guide also flags an applied deal that no longer matches the basket. This is a manual workflow, not a checkout Function: cleanup cannot be guaranteed while the extension is unmounted, suspended or the basket is read-only. Staff must check/review after edits. The app never clears previously scanned products or removes an unrelated discount.

Before adding anything, the guide refreshes the definition and validates the exact selected quantities, stock, price and reviewed basket. New lines carry an operation tag. A failed or cancelled build attempts to remove only its own unchanged new lines. If cleanup cannot be confirmed, the guide explicitly says not to take payment and to review with a manager. Native cart calls are not atomic: closing or suspending the extension during an operation can interrupt it, so keep it open and verify the final basket.

## Backend

The existing Render service hosts `/api/pos-deals`, `/definition` and `/quote`, and reads the existing Postgres recipes. The guided definition returns eligible colours and stock; quotes validate exact selections and the requested number of deals. No new tables are needed. Shopify's official @shopify/shopify-api library verifies POS session signatures and audience; the route also checks Head Happy destination/issuer, user and expiry. Only Shopify extension origins receive CORS access. Builder cookies do not authorize this endpoint. Responses omit component costs and staff history.

Private Render variables:

- POS_SHOPIFY_API_KEY: existing app client ID in shopify.app.toml.
- POS_SHOPIFY_API_SECRET: existing app client secret, stored only in Render's environment.

Missing configuration disables only the POS endpoint. No secret belongs in source, browser code or logs. Existing backend read-only catalogue credentials are reused. The app keeps read_products and read_inventory scopes. It does not write inventory, orders or payments.

## Validation and release

At the repository root: `node --test tests/*.test.js` and `node tests/pos-guide-browser.mjs`. CI also uses real PostgreSQL 16 and existing builder browser checks. The guide browser test runs the actual Preact modal with simulated Shopify cart APIs; it is not the native POS runtime. In this folder run `pnpm test`, `pnpm typecheck`, `pnpm build:check`, `pnpm validate` and `pnpm build`.

Deploy only to headhappy-bundle-preview **before** updating the existing Shopify app: the guide needs the new `/definition` endpoint. The production location service is separate. The app home and builder help explain the guided flow.

The installed Shopify AI Toolkit UI validator cannot start because its own TypeScript dependency is missing. Pinned 2026.10.2 Shopify types, offline bundling and the Shopify CLI build provide local validation. Do not claim the Toolkit validator or a native sale passed when they did not.

## Native sale and refund verification

Automated tests simulate native cart methods; they do not complete a real POS sale. With the owner supervising, verify mixed colours, multiple kits, missing components, existing discounts, basket edits, suspend/resume and payment totals. The Shopify order should contain the exact component variants and named line discounts. Checkout should reduce their stock once.

Use Shopify's ordinary refund/restock workflow to reverse a test sale. Verify refund amounts and restored component quantities. No development test executes a payment, sale, refund or inventory adjustment.
