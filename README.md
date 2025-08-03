# Shopify Variant Location Updater

This is a simple Shopify admin tool that lets you scan a product barcode, select or scan a location, and update a custom metafield on the corresponding product variant. It works well on mobile devices and is intended to be embedded in your Shopify admin via a private or custom app.

## Features

* **Scan Product Barcode** – Uses the device camera to scan UPC or barcode codes. Alternatively, users can type the code manually.
* **Scan Location Code** – Scan a shelf or location QR code or type a location manually.
* **Look up variant** – The app searches your Shopify store for the first product variant matching the barcode using the `productVariants` GraphQL query.
* **Write metafield** – When you update, it uses the `metafieldsSet` mutation to write a `stock.location` metafield on the variant.
* **Mobile friendly** – Works in your phone’s browser when used inside the Shopify admin.

## Getting Started

### Prerequisites

* A Shopify store.
* A private or custom app configured in Shopify with access to **read and write product metafields** and **read products**.
* Node.js 16+ installed locally or on your hosting platform.

### Clone or Download

If you are using GitHub:

```bash
git clone https://github.com/your-account/shopify-location-tool.git
cd shopify-location-tool
```

Or download the repository as a ZIP and extract it.

### Environment Variables

Rename `.env.example` to `.env` and fill in your store details:

```
SHOPIFY_SHOP=myshop.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...
SHOPIFY_API_VERSION=2024-04
PORT=3000
```

* **SHOPIFY_SHOP** – Your `.myshopify.com` domain (no https://).
* **SHOPIFY_ACCESS_TOKEN** – Admin API access token from your private or custom app.
* **SHOPIFY_API_VERSION** – (Optional) Admin API version. Defaults to `2024-04` if omitted.
* **PORT** – Port the server will listen on. Defaults to 3000.

### Install Dependencies & Run

```bash
npm install
npm start
```

The server will start on `http://localhost:3000` (or the port you set). Open this URL in your browser to use the tool.

### Embedding in Shopify Admin

1. **Create a Custom or Private App** – In your Shopify admin, go to *Settings → Apps and sales channels → Develop apps*. Create a new app and add **Admin API** credentials with access to Products and Metafields.
2. **Set the App URL** – Under *App setup*, set the App URL to your hosted server’s HTTPS URL (e.g., `https://your-tool.onrender.com`). Shopify requires HTTPS for embedded apps.
3. **Install the App** – Install the app on your store. It will appear under the **Apps** menu in your admin.
4. **Use the App** – From your mobile or desktop Shopify admin, open the app from the Apps menu. It will load the `index.html` from the `public` folder and allow you to scan barcodes and update variant locations.

### Deployment

This app can be hosted on any platform that runs Node.js. Popular options include Render, Heroku, Vercel (converted to serverless functions), or your own server. Make sure the app is accessible via HTTPS when embedding in Shopify.

## Important Notes

* The lookup endpoint returns the **first** variant found by barcode. If multiple variants share the same barcode, only the first will be updated.
* The metafield key and namespace are hard‑coded to `stock.location`. If your store uses a different key or namespace, update `index.js` accordingly.
* This app does **not** modify inventory quantities or product details; it only writes a simple metafield.

## License

This project is provided as-is under the [MIT License](LICENSE). Feel free to adapt it for your own use.