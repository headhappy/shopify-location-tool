# Head Happy POS Deals

Scan the actual components in Shopify POS, open **Head Happy deals**, and press **Apply deal** beneath a saved bundle. Check the total, then complete checkout normally.

The app reads the existing Bundle Builder recipes and takes the deal price from their existing Shopify product. It does not add that parent SKU to the basket or create another product. Shopify sells and deducts stock from the actual scanned variants.

## Staff setup

In the **Shopify POS app**, use **Add tile → App → Head Happy POS Deals / Head Happy deals**. Staff need access to the installed app and permission to apply discounts. The app uses the Shopify POS session; the browser builder password is not needed on the till.

1. Scan the actual box, grinder and both papers.
2. Tap **Head Happy deals**, then **Apply deal** under the saved Crown bundle.
3. For one Crown kit at its current price, confirm **£14.99** before payment.
4. If the basket changes, apply again.

Several complete sets of the same saved deal can share one basket. Any eligible colours qualify. Unrelated ordinary products remain full price. A single selected deal is applied per basket; applying another replaces this app's previous deal.

## Pricing and safety

The server refreshes the saved version, exact family membership, prices and available stock at the active POS location. GBP and tax-inclusive prices are required. Existing discounts, gift cards, custom sales, subscriptions and nested bundles stop the operation for review.

Native fixed line discounts are per unit. The saving is distributed across qualifying product lines in exact pennies. Repeated units of one variant share their line's saving, including surplus units on that line. Unrelated product lines never receive it. If the exact total cannot be represented by per-unit pennies, staff are asked to use a separate basket for complete deals.

The mounted tile/modal attempts to remove stale discounts. This is a manual workflow, not a checkout Function: cleanup cannot be guaranteed while the extension is unmounted, suspended or the basket is read-only. Staff must check/reapply after edits. The app never clears scanned products or removes an unrelated discount.

## Backend

The existing Render service hosts /api/pos-deals and reads the existing Postgres recipes. No new tables are needed. Shopify's official @shopify/shopify-api library verifies POS session signatures and audience; the route also checks Head Happy destination/issuer, user and expiry. Only Shopify extension origins receive CORS access. Builder cookies do not authorize this endpoint. Responses omit component costs and staff history.

Private Render variables:

- POS_SHOPIFY_API_KEY: existing app client ID in shopify.app.toml.
- POS_SHOPIFY_API_SECRET: existing app client secret, stored only in Render's environment.

Missing configuration disables only the POS endpoint. No secret belongs in source, browser code or logs. Existing backend read-only catalogue credentials are reused. The app keeps read_products and read_inventory scopes. It does not write inventory, orders or payments.

## Validation and release

At the repository root: node --test tests/*.test.js. CI also uses real PostgreSQL 16 and browser checks. In this folder run pnpm test, pnpm typecheck, pnpm build:check, pnpm validate and pnpm build.

Deploy only to headhappy-bundle-preview, then update the existing Shopify app. The production location service is separate. The app home now explains how to add the POS tile.

The installed Shopify AI Toolkit UI validator cannot start because its own TypeScript dependency is missing. Pinned 2026.10.2 Shopify types, offline bundling and the Shopify CLI build provide local validation. Do not claim the Toolkit validator or a native sale passed when they did not.

## Native sale and refund verification

Automated tests simulate native cart methods; they do not complete a real POS sale. With the owner supervising, verify mixed colours, multiple kits, missing components, existing discounts, basket edits, suspend/resume and payment totals. The Shopify order should contain the exact component variants and named line discounts. Checkout should reduce their stock once.

Use Shopify's ordinary refund/restock workflow to reverse a test sale. Verify refund amounts and restored component quantities. No development test executes a payment, sale, refund or inventory adjustment.
