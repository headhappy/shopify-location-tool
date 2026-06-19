const $ = id => document.getElementById(id);
const searchInp = $("searchInput");
const displayInp = $("displayLocation");
const locationInp = $("location");
const loc2Inp = $("loc2");
const lodCheck = $("lodCheck");
const variantBox = $("variantField");
const variantSel = $("variantSelect");
const statusBox = $("status");
const saveBtn = $("saveBtn");
const clearDisplayBtn = $("clearDisplay");
const clearLocationBtn = $("clearLocation");
const clearLoc2Btn = $("clearLoc2");

let variants = [];
let original = null;

const chosenVariant = () => {
  if (!variants.length) return null;
  return variants.length === 1 ? variants[0] : variants[variantSel.selectedIndex];
};

function setStatus(message, state = "") {
  statusBox.textContent = message;
  statusBox.className = state;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseDisplayLocation(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (/^LOD$/i.test(raw)) return { position: "", lod: true };
  const match = raw.match(/^(.*?)\s*\(LOD\)\s*$/i);
  if (match) return { position: match[1].trim(), lod: true };
  return { position: raw, lod: false };
}

function composedDisplayLocation() {
  const position = displayInp.value.trim();
  if (!lodCheck.checked) return position;
  return position ? `${position} (LOD)` : "LOD";
}

function currentDesiredValues() {
  return {
    displayLoc: composedDisplayLocation(),
    location: locationInp.value.trim(),
    loc2: loc2Inp.value.trim(),
  };
}

function valuesChanged() {
  if (!original) return false;
  const next = currentDesiredValues();
  return next.displayLoc !== original.displayLoc || next.location !== original.location || next.loc2 !== original.loc2;
}

function updateButtons() {
  const variant = chosenVariant();
  saveBtn.disabled = !(variant && original && valuesChanged());
  clearDisplayBtn.disabled = !(variant && original?.displayLoc);
  clearLocationBtn.disabled = !(variant && original?.location);
  clearLoc2Btn.disabled = !(variant && original?.loc2);
}

function normaliseVariant(raw) {
  return {
    id: raw.id || raw.variant?.id || "",
    productId: raw.productId || raw.product?.id || "",
    sku: raw.sku || raw.variant?.sku || "",
    barcode: raw.barcode || raw.variant?.barcode || "",
    productTitle: raw.productTitle || "",
    variantTitle: raw.variantTitle || raw.variant?.title || "",
    title: raw.title || raw.productTitle || raw.sku || raw.id || "Product",
    currentDisplayLoc: raw.currentDisplayLoc || "",
    currentLocation: raw.currentLocation || "",
    currentLoc2: raw.currentLoc2 || "",
  };
}

function showSelected(fillInputs = true) {
  const variant = chosenVariant();
  if (!variant) return;

  const display = parseDisplayLocation(variant.currentDisplayLoc);
  original = {
    displayLoc: variant.currentDisplayLoc || "",
    location: variant.currentLocation || "",
    loc2: variant.currentLoc2 || "",
  };

  if (fillInputs) {
    displayInp.value = display.position;
    lodCheck.checked = display.lod;
    locationInp.value = variant.currentLocation || "";
    loc2Inp.value = variant.currentLoc2 || "";
  }

  $("productInfo").innerHTML = `<strong>Product:</strong> ${escapeHtml(variant.title)}${variant.sku ? ` <span class="pill">${escapeHtml(variant.sku)}</span>` : ""}${variant.barcode ? ` <span class="pill">${escapeHtml(variant.barcode)}</span>` : ""}`;
  $("currentLoc").hidden = false;
  $("currentLoc").innerHTML = `<strong>Current saved values:</strong><br>DISPLAY LOC: <span class="pill">${escapeHtml(variant.currentDisplayLoc || "BLANK")}</span> LOCATION: <span class="pill">${escapeHtml(variant.currentLocation || "BLANK")}</span> LOC2: <span class="pill">${escapeHtml(variant.currentLoc2 || "BLANK")}</span>`;
  updateButtons();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.detail || data.error || `Request failed (${response.status})`);
  return data;
}

async function runLookup() {
  const search = searchInp.value.trim();
  if (!search) return setStatus("Scan a barcode or enter a product name.", "error");

  setStatus("Searching Shopify…");
  saveBtn.disabled = true;
  try {
    const data = await postJson("/lookup-variant", { search });
    variants = (data.variants || (data.variant ? [{
      id: data.variant.id,
      productId: data.product?.id || "",
      sku: data.variant.sku || "",
      barcode: data.variant.barcode || "",
      productTitle: data.productTitle || "",
      variantTitle: data.variant.title || "",
      title: data.productTitle || data.variant.sku || data.variant.id,
      currentDisplayLoc: data.currentDisplayLoc || "",
      currentLocation: data.currentLocation || "",
      currentLoc2: data.currentLoc2 || "",
    }] : [])).map(normaliseVariant);

    if (!variants.length) throw new Error("No matching products found");

    variantBox.hidden = variants.length === 1;
    if (variants.length > 1) {
      variantSel.innerHTML = variants.map((variant, index) => {
        const details = [variant.title, variant.sku, variant.barcode].filter(Boolean).join(" | ");
        return `<option value="${index}">${escapeHtml(details)}</option>`;
      }).join("");
      variantSel.selectedIndex = 0;
    }
    showSelected(true);
    setStatus(`${variants.length} matching variant${variants.length === 1 ? "" : "s"} found. Review the values before saving.`, "ok");
  } catch (error) {
    variants = [];
    original = null;
    variantBox.hidden = true;
    $("productInfo").textContent = "";
    $("currentLoc").hidden = true;
    updateButtons();
    setStatus(error.message || "Lookup failed", "error");
  }
}

async function saveChanges() {
  const variant = chosenVariant();
  if (!variant || !original) return;
  const next = currentDesiredValues();
  const changes = [];

  if (next.displayLoc !== original.displayLoc) {
    if (!next.displayLoc && original.displayLoc) return setStatus("Use Clear DISPLAY LOC to erase an existing value.", "error");
    changes.push({ name:"DISPLAY LOC", url:"/update-display-location", body:{ productId:variant.productId, displayLocationValue:next.displayLoc } });
  }
  if (next.location !== original.location) {
    if (!next.location && original.location) return setStatus("Use Clear LOCATION to erase an existing value.", "error");
    changes.push({ name:"LOCATION", url:"/update-location", body:{ variantId:variant.id, locationValue:next.location } });
  }
  if (next.loc2 !== original.loc2) {
    if (!next.loc2 && original.loc2) return setStatus("Use Clear LOC2 to erase an existing value.", "error");
    changes.push({ name:"LOC2", url:"/update-loc2", body:{ productId:variant.productId, loc2Value:next.loc2 } });
  }
  if (!changes.length) return setStatus("Nothing has changed.");

  saveBtn.disabled = true;
  setStatus(`Saving ${changes.map(change => change.name).join(" + ")}…`);
  try {
    for (const change of changes) await postJson(change.url, change.body);
    variant.currentDisplayLoc = next.displayLoc;
    variant.currentLocation = next.location;
    variant.currentLoc2 = next.loc2;
    showSelected(true);
    setStatus(`Saved ${changes.map(change => change.name).join(" + ")} ✓`, "ok");
  } catch (error) {
    setStatus(error.message || "Save failed", "error");
    updateButtons();
  }
}

async function clearValue(kind) {
  const variant = chosenVariant();
  if (!variant || !original) return;
  const labels = { display:"DISPLAY LOC", location:"LOCATION", loc2:"LOC2" };
  const label = labels[kind];
  if (!confirm(`Clear the saved ${label}? This cannot be undone automatically.`)) return;

  setStatus(`Clearing ${label}…`);
  try {
    if (kind === "display") {
      await postJson("/update-display-location", { productId:variant.productId, displayLocationValue:"" });
      variant.currentDisplayLoc = "";
    } else if (kind === "location") {
      await postJson("/update-location", { variantId:variant.id, locationValue:"" });
      variant.currentLocation = "";
    } else {
      await postJson("/update-loc2", { productId:variant.productId, loc2Value:"" });
      variant.currentLoc2 = "";
    }
    showSelected(true);
    setStatus(`${label} cleared.`, "ok");
  } catch (error) {
    setStatus(error.message || `Could not clear ${label}`, "error");
  }
}

function startScan(kind) {
  const boxes = { search:"searchScanner", display:"displayScanner", location:"locationScanner", loc2:"loc2Scanner" };
  const inputs = { search:searchInp, display:displayInp, location:locationInp, loc2:loc2Inp };
  const box = $(boxes[kind]);
  const input = inputs[kind];
  if (!window.Html5Qrcode) return setStatus("Camera scanner library did not load.", "error");
  if (box.style.display === "block") { box.innerHTML = ""; box.style.display = "none"; return; }

  box.innerHTML = "";
  box.style.display = "block";
  const scanner = new Html5Qrcode(box.id);
  scanner.start(
    { facingMode:"environment" },
    { fps:10, qrbox:{ width:250, height:250 } },
    value => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles:true }));
      scanner.stop().catch(() => {});
      box.style.display = "none";
      if (kind === "search") runLookup();
    }
  ).catch(() => {
    box.style.display = "none";
    setStatus("Camera permission was denied or unavailable.", "error");
  });
}

$("lookupBtn").addEventListener("click", runLookup);
searchInp.addEventListener("keydown", event => { if (event.key === "Enter") runLookup(); });
variantSel.addEventListener("change", () => showSelected(true));
[displayInp, locationInp, loc2Inp, lodCheck].forEach(element => element.addEventListener("input", updateButtons));
lodCheck.addEventListener("change", updateButtons);
saveBtn.addEventListener("click", saveChanges);
clearDisplayBtn.addEventListener("click", () => clearValue("display"));
clearLocationBtn.addEventListener("click", () => clearValue("location"));
clearLoc2Btn.addEventListener("click", () => clearValue("loc2"));
$("scanSearch").addEventListener("click", () => startScan("search"));
$("scanDisplay").addEventListener("click", () => startScan("display"));
$("scanLocation").addEventListener("click", () => startScan("location"));
$("scanLoc2").addEventListener("click", () => startScan("loc2"));
