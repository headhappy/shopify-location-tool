(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "headhappy.label-station.queue.v1";
  const TEMPLATE_KEY = "headhappy.label-station.template.v1";
  const MAX_PRINT_PAGES = 500;

  const TEMPLATE_NAMES = {
    customer: "Customer",
    product: "Product + location",
    staff: "Staff",
    barcode: "Barcode only",
    "product-qr": "Product QR",
    location: "Location",
    information: "Information",
    "web-qr": "Web link QR",
    calibration: "Printer calibration",
  };
  const PRODUCT_TEMPLATES = ["customer", "product", "staff", "barcode", "product-qr"];

  const SAMPLE_PRODUCT = {
    id: "sample",
    sourceType: "product",
    template: "product",
    copies: 1,
    productTitle: "Ataraxy Trifection 62mm Grinder",
    variantTitle: "Black",
    sku: "GM_3PC_AXY_A1",
    barcode: "710420218597",
    price: "64.99",
    stock: 7,
    handle: "ataraxy-trifection-62mm-grinder",
    displayLoc: "Cabinet 7",
    quickLoc: "Till Drawer 9",
    loc2: "S7",
  };

  const state = {
    activeTemplate: PRODUCT_TEMPLATES.includes(localStorage.getItem(TEMPLATE_KEY))
      ? localStorage.getItem(TEMPLATE_KEY)
      : "product",
    queue: loadQueue(),
    results: [],
    selectedQueueId: null,
    locationCatalog: [],
  };

  const els = {
    searchForm: $("searchForm"),
    searchInput: $("searchInput"),
    status: $("status"),
    results: $("searchResults"),
    queue: $("queueList"),
    queueLineCount: $("queueLineCount"),
    totalLabelCount: $("totalLabelCount"),
    clearQueue: $("clearQueueBtn"),
    printQueue: $("printQueueBtn"),
    headerPrint: $("headerPrintBtn"),
    headerPrintCount: $("headerPrintCount"),
    activeTemplateChip: $("activeTemplateChip"),
    templatePicker: $("templatePicker"),
    preview: $("labelPreview"),
    printSheet: $("printSheet"),
    loadLocations: $("loadAllLocationsBtn"),
    locationProductSelect: $("locationProductSelect"),
    locationProductCopies: $("locationProductCopies"),
    locationProductMeta: $("locationProductMeta"),
    loadLocationProducts: $("loadLocationProductsBtn"),
  };

  function clean(value) {
    return String(value ?? "").trim();
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function uid() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function clampCopies(value) {
    const number = Math.floor(Number(value) || 1);
    return Math.max(1, Math.min(MAX_PRINT_PAGES, number));
  }

  function normaliseQueueItem(item) {
    const template = TEMPLATE_NAMES[item?.template] ? item.template : "product";
    return {
      ...item,
      id: clean(item?.id) || uid(),
      template,
      sourceType: clean(item?.sourceType) || "product",
      copies: clampCopies(item?.copies),
    };
  }

  function loadQueue() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.slice(0, 500).map(normaliseQueueItem) : [];
    } catch {
      return [];
    }
  }

  function saveQueue() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.queue));
    } catch {
      setStatus("The labels are ready, but this browser could not save the queue for later.", "error");
    }
  }

  function setStatus(message, tone = "") {
    els.status.textContent = message;
    els.status.className = `status${tone ? ` ${tone}` : ""}`;
  }

  function money(value) {
    const raw = clean(value).replace(/[£,]/g, "");
    if (!raw && raw !== "0") return "£—";
    const amount = Number(raw);
    return Number.isFinite(amount) ? `£${amount.toFixed(2)}` : `£${escapeHtml(raw)}`;
  }

  function productUrl(item) {
    if (clean(item.url)) return normaliseUrl(item.url);
    const handle = clean(item.handle);
    return handle ? `https://headhappy.co.uk/products/${encodeURIComponent(handle)}` : "";
  }

  function normaliseUrl(value) {
    const raw = clean(value);
    if (!raw) return "";
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  }

  function barcodeValue(item) {
    return clean(item.barcode) || clean(item.sku) || clean(item.locationCode);
  }

  function code128Svg(value, height = 6.4) {
    const text = clean(value);
    if (!text) return '<span class="fallback-code">NO BARCODE</span>';
    try {
      if (!globalThis.bwipjs?.toSVG) throw new Error("Barcode renderer unavailable");
      return globalThis.bwipjs.toSVG({
        bcid: "code128",
        text,
        scale: 2,
        height,
        includetext: false,
        paddingwidth: 4,
        paddingheight: 0,
        backgroundcolor: "FFFFFF",
        barcolor: "000000",
      });
    } catch {
      return `<span class="fallback-code">${escapeHtml(text)}</span>`;
    }
  }

  function qrSvg(value) {
    const text = clean(value);
    if (!text) return '<span class="fallback-code">NO LINK</span>';
    try {
      if (!globalThis.bwipjs?.toSVG) throw new Error("QR renderer unavailable");
      return globalThis.bwipjs.toSVG({
        bcid: "qrcode",
        text,
        scale: 3,
        eclevel: "M",
        padding: 0,
        backgroundcolor: "FFFFFF",
        barcolor: "000000",
      });
    } catch {
      return `<span class="fallback-code">${escapeHtml(text)}</span>`;
    }
  }

  function labelPage(art) {
    return `<article class="label-page"><div class="label-art ${art.className}">${art.body}</div></article>`;
  }

  function renderLabel(item) {
    const template = TEMPLATE_NAMES[item.template] ? item.template : "product";
    const name = escapeHtml(clean(item.productTitle) || clean(item.title) || "Head Happy");
    const variant = escapeHtml(clean(item.variantTitle));
    const sku = escapeHtml(clean(item.sku) || "NO SKU");
    const code = barcodeValue(item);

    if (template === "customer") {
      return labelPage({
        className: "template-customer",
        body: `
          <div class="label-name">${name}</div>
          <div class="label-variant">${variant || "&nbsp;"}</div>
          <div class="customer-price">${money(item.price)}</div>
          <div class="label-barcode">${code128Svg(code, 6.6)}</div>`,
      });
    }

    if (template === "staff") {
      return labelPage({
        className: "template-staff",
        body: `
          <div class="label-name">${name}</div>
          <div class="label-variant">${variant || "&nbsp;"}</div>
          <div class="staff-sku">${sku}</div>
          <div class="staff-line"><strong>DISPLAY</strong><span>${escapeHtml(clean(item.displayLoc) || "—")}</span></div>
          <div class="staff-line"><strong>QUICK</strong><span>${escapeHtml(clean(item.quickLoc) || "—")}</span></div>
          <div class="staff-line"><strong>BULK / LOC2</strong><span>${escapeHtml(clean(item.loc2) || "—")}</span></div>`,
      });
    }

    if (template === "barcode") {
      return labelPage({
        className: "template-barcode",
        body: `
          <div class="label-name">${name}${variant ? ` · ${variant}` : ""}</div>
          <div class="label-barcode">${code128Svg(code, 10.5)}</div>
          <div class="barcode-value">${escapeHtml(code || "NO BARCODE")}</div>`,
      });
    }

    if (template === "product-qr") {
      const url = productUrl(item);
      return labelPage({
        className: "template-product-qr",
        body: `
          <div class="label-qr">${qrSvg(url)}</div>
          <div class="qr-copy">
            <div class="qr-kicker">SCAN FOR DETAILS</div>
            <div class="qr-title">${name}</div>
            <div class="qr-variant">${variant || "&nbsp;"}</div>
            <div class="qr-site">headhappy.co.uk</div>
          </div>`,
      });
    }

    if (template === "location") {
      const location = clean(item.locationCode) || "LOCATION";
      const types = Array.isArray(item.locationTypes) ? item.locationTypes.join(" + ") : clean(item.locationType) || "STORE LOCATION";
      return labelPage({
        className: "template-location",
        body: `
          <div class="location-type">${escapeHtml(types)}</div>
          <div class="location-code">${escapeHtml(location)}</div>
          <div class="label-barcode">${code128Svg(location, 8.8)}</div>`,
      });
    }

    if (template === "information") {
      return labelPage({
        className: "template-information",
        body: `
          <div class="info-title">${escapeHtml(clean(item.title) || "INFORMATION")}</div>
          <div class="info-body">${escapeHtml(clean(item.body) || "Head Happy")}</div>
          <div class="info-footer">HEAD HAPPY · DUNDEE</div>`,
      });
    }

    if (template === "web-qr") {
      const url = productUrl(item);
      let hostname = "headhappy.co.uk";
      try { hostname = new URL(url).hostname.replace(/^www\./, ""); } catch { /* Keep fallback. */ }
      return labelPage({
        className: "template-web-qr",
        body: `
          <div class="label-qr">${qrSvg(url)}</div>
          <div class="qr-copy">
            <div class="qr-kicker">SCAN TO OPEN</div>
            <div class="qr-title">${escapeHtml(clean(item.title) || "Web link")}</div>
            <div class="qr-site">${escapeHtml(hostname)}</div>
          </div>`,
      });
    }

    if (template === "calibration") {
      return labelPage({
        className: "template-calibration",
        body: `
          <div class="calibration-frame">
            <strong>HEAD HAPPY · 40 × 25 mm</strong>
            <span>All four corners and this border should be visible.</span>
            <div class="calibration-rule"><span>36 mm safe width</span></div>
            <small>100% scale · no margins · headers off</small>
          </div>`,
      });
    }

    const quickLocation = clean(item.quickLoc);
    const bulkLocation = clean(item.loc2);
    const locationText = [quickLocation ? `Q: ${quickLocation}` : "", bulkLocation ? `B: ${bulkLocation}` : ""].filter(Boolean).join(" · ") || "LOCATION: —";
    return labelPage({
      className: "template-product",
      body: `
        <div class="label-name">${name}</div>
        <div class="label-variant">${variant || "&nbsp;"}</div>
        <div class="label-barcode">${code128Svg(code, 6.5)}</div>
        <div class="product-price">${money(item.price)}</div>
        <div class="product-footer"><span>${escapeHtml(locationText)}</span><span class="sku">${sku}</span></div>`,
    });
  }

  function normaliseLookupRow(row, envelope = {}) {
    const product = envelope.product || {};
    return {
      variantId: clean(row.id || row.variantId),
      productId: clean(row.productId || product.id),
      productTitle: clean(row.productTitle || envelope.productTitle || row.product_title || "Product"),
      variantTitle: clean(row.variantTitle || row.variant_title || row.title).replace(/^Default Title$/i, ""),
      sku: clean(row.sku),
      barcode: clean(row.barcode),
      price: clean(row.price ?? envelope.price ?? product.price),
      stock: Number(row.stock ?? row.inventoryQuantity ?? row.inventory_quantity ?? envelope.stock ?? 0),
      handle: clean(row.handle || envelope.handle || product.handle),
      vendor: clean(row.vendor || envelope.vendor || product.vendor),
      displayLoc: clean(row.currentDisplayLoc ?? row.displayLoc ?? envelope.currentDisplayLoc),
      quickLoc: clean(row.currentLocation ?? row.quickLoc ?? envelope.currentLocation),
      loc2: clean(row.currentLoc2 ?? row.loc2 ?? envelope.currentLoc2),
    };
  }

  function lookupRows(data) {
    if (Array.isArray(data?.variants)) return data.variants.map((row) => normaliseLookupRow(row, data));
    if (!data?.variant) return [];
    return [normaliseLookupRow(data.variant, data)];
  }

  function queueIdentity(item) {
    if (item.sourceType === "product") return `${item.template}|product|${item.variantId || item.productId || item.sku || item.barcode}`;
    if (item.sourceType === "location") return `${item.template}|location|${clean(item.locationCode).toLowerCase()}`;
    if (item.sourceType === "web") return `${item.template}|web|${normaliseUrl(item.url).toLowerCase()}`;
    return `${item.template}|info|${clean(item.title).toLowerCase()}|${clean(item.body).toLowerCase()}`;
  }

  function addQueueItem(item, { incrementExisting = true, render = true } = {}) {
    const next = normaliseQueueItem({ ...item, id: uid(), copies: item.copies || 1 });
    const identity = queueIdentity(next);
    const existing = state.queue.find((queued) => queueIdentity(queued) === identity);
    if (existing) {
      if (incrementExisting) existing.copies = clampCopies(existing.copies + next.copies);
      state.selectedQueueId = existing.id;
      if (render) commitQueue();
      return { item: existing, added: false };
    }
    state.queue.push(next);
    state.selectedQueueId = next.id;
    if (render) commitQueue();
    return { item: next, added: true };
  }

  function addProduct(row, { render = true, copies = 1 } = {}) {
    return addQueueItem({
      ...row,
      sourceType: "product",
      template: state.activeTemplate,
      copies: clampCopies(copies),
    }, { render });
  }

  function commitQueue() {
    saveQueue();
    renderQueue();
    renderPreview();
  }

  function totalCopies(items = state.queue) {
    return items.reduce((sum, item) => sum + clampCopies(item.copies), 0);
  }

  function templateOptions(item) {
    const allowed = item.sourceType === "product" ? PRODUCT_TEMPLATES : [item.template];
    return allowed.map((template) => `<option value="${template}"${template === item.template ? " selected" : ""}>${escapeHtml(TEMPLATE_NAMES[template])}</option>`).join("");
  }

  function itemSubtitle(item) {
    if (item.sourceType === "location") return `${(item.locationTypes || [item.locationType || "STORE LOCATION"]).join(" + ")} · location label`;
    if (item.sourceType === "information") return clean(item.body) || "Information label";
    if (item.sourceType === "web") return clean(item.url);
    return [clean(item.variantTitle), clean(item.sku), clean(item.barcode)].filter(Boolean).join(" · ");
  }

  function preflightWarning(item) {
    const warnings = [];
    if (["customer", "product", "barcode"].includes(item.template) && !clean(item.barcode)) {
      if (clean(item.sku)) warnings.push("No barcode stored — Code 128 will use the SKU.");
      else warnings.push("No barcode or SKU is available; this label will show NO BARCODE.");
    }
    if (["customer", "product"].includes(item.template) && clean(item.price) === "") warnings.push("No price is stored for this variant.");
    if (item.template === "product-qr" && !productUrl(item)) warnings.push("No Shopify handle is available for the product QR.");
    return warnings.join(" ");
  }

  function renderQueue() {
    const lines = state.queue.length;
    const labels = totalCopies();
    els.queueLineCount.textContent = `${lines} ${lines === 1 ? "item" : "items"}`;
    els.totalLabelCount.textContent = String(labels);
    els.headerPrintCount.textContent = String(labels);
    els.clearQueue.disabled = lines === 0;
    els.printQueue.disabled = labels === 0;
    els.headerPrint.disabled = labels === 0;

    if (!lines) {
      els.queue.innerHTML = '<div class="empty-state"><strong>No labels queued yet.</strong><span>Scan a product above, or use a quick label on the right.</span></div>';
      return;
    }

    els.queue.innerHTML = state.queue.map((item) => {
      const warning = preflightWarning(item);
      return `
        <div class="queue-row${state.selectedQueueId === item.id ? " selected" : ""}" data-id="${escapeHtml(item.id)}">
          <button class="queue-item-button" type="button" data-action="select" data-id="${escapeHtml(item.id)}">
            <strong>${escapeHtml(clean(item.productTitle) || clean(item.locationCode) || clean(item.title) || "Label")}</strong>
            <span>${escapeHtml(itemSubtitle(item))}</span>
          </button>
          <select class="queue-template-select" data-role="template" data-id="${escapeHtml(item.id)}" aria-label="Label type">${templateOptions(item)}</select>
          <div class="copy-control" aria-label="Number of copies">
            <button type="button" data-action="decrease" data-id="${escapeHtml(item.id)}" aria-label="Decrease copies">−</button>
            <input data-role="copies" data-id="${escapeHtml(item.id)}" type="number" min="1" max="500" value="${clampCopies(item.copies)}" aria-label="Copies" />
            <button type="button" data-action="increase" data-id="${escapeHtml(item.id)}" aria-label="Increase copies">+</button>
          </div>
          <div class="row-actions">
            <button class="icon-button" type="button" data-action="print-one" data-id="${escapeHtml(item.id)}" title="Print this label"><span aria-hidden="true">⎙</span><span class="sr-only">Print this label</span></button>
            <button class="icon-button remove" type="button" data-action="remove" data-id="${escapeHtml(item.id)}" title="Remove"><span aria-hidden="true">×</span><span class="sr-only">Remove label</span></button>
          </div>
          ${warning ? `<div class="queue-warning">${escapeHtml(warning)}</div>` : ""}
        </div>`;
    }).join("");
  }

  function renderPreview() {
    const selected = state.queue.find((item) => item.id === state.selectedQueueId);
    const previewItem = selected && selected.sourceType !== "product"
      ? selected
      : { ...(selected || SAMPLE_PRODUCT), template: state.activeTemplate };
    els.preview.innerHTML = renderLabel(previewItem);
  }

  function applyTemplate(template) {
    if (!PRODUCT_TEMPLATES.includes(template)) return;
    state.activeTemplate = template;
    localStorage.setItem(TEMPLATE_KEY, template);
    els.activeTemplateChip.textContent = TEMPLATE_NAMES[template];
    els.templatePicker.querySelectorAll("[data-template]").forEach((button) => {
      const active = button.dataset.template === template;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    renderPreview();
  }

  function resultMeta(row) {
    return [
      row.sku ? `<span class="meta-pill">${escapeHtml(row.sku)}</span>` : "",
      row.barcode ? `<span class="meta-pill">${escapeHtml(row.barcode)}</span>` : '<span class="meta-pill">NO BARCODE</span>',
      `<span class="meta-pill ${row.stock > 0 ? "stock-in" : "stock-out"}">STOCK ${Number(row.stock || 0)}</span>`,
      row.price !== "" ? `<span class="meta-pill">${money(row.price)}</span>` : "",
    ].filter(Boolean).join("");
  }

  function renderResults() {
    if (!state.results.length) {
      els.results.innerHTML = '<div class="empty-state compact">Search results will appear here.</div>';
      return;
    }
    const toolbar = state.results.length > 1
      ? `<div class="results-toolbar"><span>${state.results.length} matching variants</span><button id="addAllResultsBtn" class="small-button secondary-small" type="button">Add all variants</button></div>`
      : "";
    els.results.innerHTML = toolbar + state.results.map((row, index) => `
      <div class="result-row">
        <div>
          <div class="result-title">${escapeHtml(row.productTitle)}${row.variantTitle ? ` <span class="variant-name">· ${escapeHtml(row.variantTitle)}</span>` : ""}</div>
          <div class="meta-row">${resultMeta(row)}</div>
        </div>
        <button class="small-button" type="button" data-result-index="${index}">Add label</button>
      </div>`).join("");

    els.results.querySelectorAll("[data-result-index]").forEach((button) => {
      button.addEventListener("click", () => {
        const row = state.results[Number(button.dataset.resultIndex)];
        const result = addProduct(row);
        setStatus(`${result.added ? "Added" : "Increased copies for"} ${row.productTitle}${row.variantTitle ? ` · ${row.variantTitle}` : ""}.`, "ok");
        els.searchInput.focus();
      });
    });
    $("addAllResultsBtn")?.addEventListener("click", () => {
      let added = 0;
      state.results.forEach((row) => { if (addProduct(row, { render: false }).added) added += 1; });
      commitQueue();
      setStatus(`Added ${added} new label${added === 1 ? "" : "s"}; existing matches were left in the queue.`, "ok");
      els.searchInput.focus();
    });
  }

  async function searchProducts(term) {
    setStatus("Searching Shopify…", "busy");
    try {
      const response = await fetch("/lookup-variant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search: term }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || "No matching product found.");
      const rows = lookupRows(data);
      if (!rows.length) throw new Error("No matching product or variant found.");

      state.results = rows;
      if (rows.length === 1) {
        const result = addProduct(rows[0]);
        renderResults();
        els.searchInput.value = "";
        setStatus(`${result.added ? "Added" : "Increased copies for"} ${rows[0].productTitle}${rows[0].variantTitle ? ` · ${rows[0].variantTitle}` : ""}. Ready for the next scan.`, "ok");
        els.searchInput.focus();
        return;
      }

      renderResults();
      setStatus(`${rows.length} variants found. Choose one, or add all variants.`, "ok");
    } catch (error) {
      state.results = [];
      renderResults();
      setStatus(error.message || "Product search failed.", "error");
      els.searchInput.select();
    }
  }

  function locationCatalogLabel(location) {
    const types = Array.isArray(location.types) && location.types.length ? location.types.join(" + ") : "STORE LOCATION";
    const variants = Number(location.variantCount || 0);
    return `${clean(location.code)} · ${types} · ${variants} product${variants === 1 ? "" : "s"}`;
  }

  function renderLocationProductMeta() {
    const code = clean(els.locationProductSelect?.value);
    const location = state.locationCatalog.find((row) => clean(row.code) === code);
    if (!location) {
      if (els.locationProductMeta) els.locationProductMeta.textContent = state.locationCatalog.length ? "Choose a location to see its mapped products." : "No locations loaded.";
      if (els.loadLocationProducts) els.loadLocationProducts.disabled = true;
      return;
    }
    const types = Array.isArray(location.types) && location.types.length ? location.types.join(" + ") : "STORE LOCATION";
    const products = Number(location.variantCount || location.productCount || 0);
    const stock = Number(location.stockTotal || 0);
    els.locationProductMeta.textContent = `${types} · ${products} mapped product${products === 1 ? "" : "s"} · stock ${stock}`;
    els.loadLocationProducts.disabled = false;
  }

  async function loadLocationCatalog() {
    if (!els.locationProductSelect) return [];
    els.locationProductSelect.disabled = true;
    els.loadLocationProducts.disabled = true;
    try {
      const response = await fetch("/api/labels/locations");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || "Location list failed.");
      const locations = Array.isArray(data.locations) ? data.locations : Array.isArray(data.rows) ? data.rows : [];
      state.locationCatalog = locations.filter((row) => clean(row.code));
      els.locationProductSelect.innerHTML = '<option value="">Choose a location…</option>' + state.locationCatalog
        .map((location) => `<option value="${escapeHtml(clean(location.code))}">${escapeHtml(locationCatalogLabel(location))}</option>`)
        .join("");
      els.locationProductSelect.disabled = false;
      renderLocationProductMeta();
      return state.locationCatalog;
    } catch (error) {
      state.locationCatalog = [];
      els.locationProductSelect.innerHTML = '<option value="">Could not load locations</option>';
      els.locationProductMeta.textContent = error.message || "Could not load locations.";
      setStatus(error.message || "Could not load store locations.", "error");
      return [];
    }
  }

  async function loadProductsFromLocation() {
    const location = clean(els.locationProductSelect?.value);
    if (!location) return setStatus("Choose a store location first.", "error");
    const copies = clampCopies(els.locationProductCopies?.value || 1);
    els.loadLocationProducts.disabled = true;
    setStatus(`Loading every product in ${location}…`, "busy");
    try {
      const response = await fetch(`/api/labels/location-products?location=${encodeURIComponent(location)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || "Location product list failed.");
      const rows = Array.isArray(data.rows) ? data.rows.map((row) => normaliseLookupRow(row, data)) : [];
      if (!rows.length) throw new Error(`No active products are mapped exactly to ${location}.`);

      let added = 0;
      let increased = 0;
      rows.forEach((row) => {
        const result = addProduct(row, { copies, render: false });
        result.added ? added += 1 : increased += 1;
      });
      commitQueue();
      setStatus(
        `Loaded ${rows.length} product${rows.length === 1 ? "" : "s"} from ${location} at ${copies} cop${copies === 1 ? "y" : "ies"} each${increased ? `; ${increased} already queued and increased` : ""}.`,
        "ok"
      );
    } catch (error) {
      setStatus(error.message || "Could not load products from this location.", "error");
    } finally {
      renderLocationProductMeta();
    }
  }

  async function loadAllLocations() {
    els.loadLocations.disabled = true;
    setStatus("Loading the unique store location codes…", "busy");
    try {
      const response = await fetch("/api/labels/locations");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || "Location list failed.");
      const locations = Array.isArray(data.locations) ? data.locations : Array.isArray(data.rows) ? data.rows : [];
      if (!locations.length) throw new Error("No usable location codes were found.");
      if (locations.length > 100 && !window.confirm(`Found ${locations.length} unique active location codes. Add all of them to the print queue?`)) {
        setStatus(`Location list loaded: ${locations.length} unique codes. Nothing was added.`, "ok");
        return;
      }
      let added = 0;
      let skipped = 0;
      locations.forEach((location) => {
        const result = addQueueItem({
          sourceType: "location",
          template: "location",
          copies: 1,
          locationCode: clean(location.code),
          locationTypes: Array.isArray(location.types) ? location.types : [clean(location.type) || "STORE LOCATION"],
        }, { incrementExisting: false, render: false });
        result.added ? added += 1 : skipped += 1;
      });
      commitQueue();
      setStatus(`Added ${added} unique store location label${added === 1 ? "" : "s"}${skipped ? `; ${skipped} already queued` : ""}.`, "ok");
    } catch (error) {
      setStatus(error.message || "Could not load store locations.", "error");
    } finally {
      els.loadLocations.disabled = false;
    }
  }

  async function printItems(items) {
    const pages = [];
    items.forEach((item) => {
      for (let copy = 0; copy < clampCopies(item.copies); copy += 1) pages.push(renderLabel(item));
    });
    if (!pages.length) return setStatus("Add at least one label before printing.", "error");
    if (pages.length > MAX_PRINT_PAGES) {
      return setStatus(`This job has ${pages.length} labels. Split it into batches of ${MAX_PRINT_PAGES} or fewer so the print window stays reliable.`, "error");
    }

    els.printSheet.innerHTML = pages.join("");
    els.printSheet.setAttribute("aria-hidden", "false");
    setStatus(`Opening the print window for ${pages.length} label${pages.length === 1 ? "" : "s"}…`, "busy");
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.print();
      setStatus(`Print window opened for ${pages.length} label${pages.length === 1 ? "" : "s"}. The queue has been kept for reprints.`, "ok");
    } finally {
      els.printSheet.setAttribute("aria-hidden", "true");
    }
  }

  els.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const term = clean(els.searchInput.value);
    if (!term) return setStatus("Scan a barcode or enter a product name or SKU.", "error");
    searchProducts(term);
  });

  els.templatePicker.addEventListener("click", (event) => {
    const button = event.target.closest("[data-template]");
    if (button) applyTemplate(button.dataset.template);
  });

  els.queue.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const item = state.queue.find((queued) => queued.id === button.dataset.id);
    if (!item) return;
    const action = button.dataset.action;
    if (action === "select") {
      state.selectedQueueId = item.id;
      if (PRODUCT_TEMPLATES.includes(item.template)) applyTemplate(item.template);
      renderQueue();
      renderPreview();
      return;
    }
    if (action === "increase") item.copies = clampCopies(item.copies + 1);
    if (action === "decrease") item.copies = clampCopies(item.copies - 1);
    if (action === "remove") {
      state.queue = state.queue.filter((queued) => queued.id !== item.id);
      if (state.selectedQueueId === item.id) state.selectedQueueId = state.queue.at(-1)?.id || null;
    }
    if (action === "print-one") return printItems([item]);
    commitQueue();
  });

  els.queue.addEventListener("change", (event) => {
    const item = state.queue.find((queued) => queued.id === event.target.dataset.id);
    if (!item) return;
    if (event.target.dataset.role === "copies") item.copies = clampCopies(event.target.value);
    if (event.target.dataset.role === "template" && PRODUCT_TEMPLATES.includes(event.target.value)) {
      item.template = event.target.value;
      applyTemplate(item.template);
    }
    state.selectedQueueId = item.id;
    commitQueue();
  });

  els.clearQueue.addEventListener("click", () => {
    if (!state.queue.length) return;
    if (!window.confirm(`Clear all ${state.queue.length} queued label items?`)) return;
    state.queue = [];
    state.selectedQueueId = null;
    commitQueue();
    setStatus("Print queue cleared.");
    els.searchInput.focus();
  });

  els.printQueue.addEventListener("click", () => printItems(state.queue));
  els.headerPrint.addEventListener("click", () => printItems(state.queue));
  $("printCalibrationBtn").addEventListener("click", () => printItems([{ sourceType: "calibration", template: "calibration", copies: 1 }]));
  els.loadLocations.addEventListener("click", loadAllLocations);
  els.locationProductSelect?.addEventListener("change", renderLocationProductMeta);
  els.locationProductCopies?.addEventListener("change", () => {
    els.locationProductCopies.value = String(clampCopies(els.locationProductCopies.value));
  });
  els.loadLocationProducts?.addEventListener("click", loadProductsFromLocation);

  $("manualLocationForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = clean($("manualLocationCode").value);
    if (!code) return setStatus("Enter the location code to print.", "error");
    const type = clean($("manualLocationType").value) || "STORE LOCATION";
    const result = addQueueItem({ sourceType: "location", template: "location", copies: 1, locationCode: code, locationTypes: [type] });
    $("manualLocationCode").value = "";
    setStatus(`${result.added ? "Added" : "Increased copies for"} location ${code}.`, "ok");
  });

  $("manualInfoForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = clean($("manualInfoTitle").value);
    const body = clean($("manualInfoBody").value);
    if (!title && !body) return setStatus("Enter a heading or some information to print.", "error");
    addQueueItem({ sourceType: "information", template: "information", copies: 1, title: title || "INFORMATION", body });
    $("manualInfoTitle").value = "";
    $("manualInfoBody").value = "";
    setStatus("Information label added.", "ok");
  });

  $("manualQrForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const title = clean($("manualQrTitle").value);
    const url = normaliseUrl($("manualQrUrl").value);
    if (!url) return setStatus("Enter the web address for the QR code.", "error");
    addQueueItem({ sourceType: "web", template: "web-qr", copies: 1, title: title || "Web link", url });
    $("manualQrTitle").value = "";
    $("manualQrUrl").value = "";
    setStatus("Web link QR label added.", "ok");
  });

  applyTemplate(state.activeTemplate);
  if (state.queue.length) state.selectedQueueId = state.queue.at(-1).id;
  renderQueue();
  renderPreview();
  loadLocationCatalog();
})();
