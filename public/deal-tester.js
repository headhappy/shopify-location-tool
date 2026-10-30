const $ = (id) => document.getElementById(id);
const state = { csrf: "", recipes: [], deal: null, lines: [], queue: [], busy: false };
const money = (pence) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence === 0 ? 0 : pence / 100);
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function status(message = "", error = false) {
  $("status").textContent = message;
  $("status").className = error ? "error" : "";
}
function loginPanel() {
  state.csrf = "";
  state.deal = null;
  state.lines = [];
  state.queue = [];
  $("workspace").hidden = true;
  $("till").hidden = true;
  $("login-panel").hidden = false;
  $("basket").replaceChildren();
  $("eligible-items").replaceChildren();
}
async function api(path, body) {
  const response = await fetch(`/api/bundles${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) loginPanel();
    throw new Error(data.error || "Could not check this basket. Try again.");
  }
  return data;
}
async function signedIn(session) {
  state.csrf = session.csrf;
  const [catalog, result] = await Promise.all([api("/catalog"), api("/recipes")]);
  state.recipes = result.recipes;
  $("deal").replaceChildren(new Option("Choose a deal", ""));
  state.recipes.forEach((r) => $("deal").append(new Option(r.name, r.id)));
  $("location").replaceChildren(new Option("Choose a store", ""));
  catalog.locations.forEach((l) => $("location").append(new Option(l.name, l.id)));
  if (state.recipes.length === 1) $("deal").value = state.recipes[0].id;
  $("login-panel").hidden = true;
  $("workspace").hidden = false;
  status(state.recipes.length ? "" : "A manager needs to save a kit recipe in Bundle Builder first.");
}
function lockControls(busy) {
  document.querySelectorAll("#setup select, #setup button, #logout, #clear, #basket button, #eligible-items button").forEach((n) => { n.disabled = busy; });
}
function actionButton(text, fn, label) {
  const button = el("button", text, "secondary");
  button.type = "button";
  if (label) button.setAttribute("aria-label", label);
  button.addEventListener("click", fn);
  return button;
}
function itemName(item) {
  return `${item.productTitle}${item.title === "Default Title" ? "" : ` / ${item.title}`}`;
}
function choices(deal) {
  $("eligible-items").replaceChildren();
  for (const group of deal.groups) {
    const row = el("div", undefined, "choice-row");
    const label = el("label", `${group.name} · ${group.quantity} per deal`);
    const select = el("select");
    for (const item of group.items) select.append(new Option(`${item.sku} · ${itemName(item)} · ${item.available ?? "?"} available`, item.id));
    label.append(select);
    row.append(label, actionButton("Add", () => enqueue({ add: select.value }), `Add ${group.name}`));
    $("eligible-items").append(row);
  }
}
function total(label, amount, grand = false) {
  const row = el("div", undefined, `total-row${grand ? " grand-total" : ""}`);
  row.append(el("span", label), el("span", money(amount)));
  return row;
}
function render(result) {
  state.deal = result.deal;
  state.lines = result.lines.map((l) => ({ variantId: l.id, quantity: l.quantity }));
  $("deal-title").textContent = result.deal.product.title;
  $("deal-price").textContent = `${money(result.deal.price)} per complete deal · ${result.deal.location.name}`;
  $("basket").replaceChildren();
  for (const line of result.lines) {
    const row = el("div", undefined, "basket-line");
    const info = el("div", undefined, "item-info");
    info.append(el("strong", itemName(line)), el("small", `${line.sku} · ${line.quantity} scanned${line.extraQuantity ? ` · ${line.extraQuantity} at regular price` : ""}`));
    row.append(info, actionButton("−", () => enqueue({ remove: line.id }), `Remove one ${line.sku}`));
    $("basket").append(row);
  }
  $("result-title").textContent = result.sets ? `${result.sets} complete deal${result.sets === 1 ? "" : "s"}${result.warnings.length ? " · check below" : " recognised"}` : (result.lines.length ? "Keep scanning…" : "Scan your first item");
  $("progress").replaceChildren();
  result.groups.forEach((g) => {
    const note = result.sets ? `${g.required * result.sets} in the deal${result.sets === 1 ? "" : "s"}`
      : g.nextNeeded ? `${g.nextNeeded} more needed` : "ready";
    $("progress").append(el("li", `${g.name}: ${g.scanned} scanned · ${note}`));
  });
  $("totals").replaceChildren(total("Regular item prices", result.regularTotal), total("Deal saving", -result.saving), total("Test total", result.testTotal, true));
  $("warnings").replaceChildren(...result.warnings.map((w) => el("p", w, "warning")));
  $("till").hidden = false;
}
async function check(lines, scan) {
  return api(`/deals/${state.deal.id}/test`, {
    recipeVersion: state.deal.version, locationId: state.deal.location.id, lines,
    ...(scan === undefined ? {} : { scan }),
  });
}
async function enqueue(change) {
  if (!state.deal) return;
  state.queue.push(change);
  if (state.busy) return;
  state.busy = true;
  lockControls(true);
  try {
    while (state.queue.length) {
      $("queue-status").textContent = `Checking ${state.queue.length} queued scan / change…`;
      const next = state.queue.shift();
      let lines = state.lines.map((l) => ({ ...l }));
      if (next.clear) lines = [];
      if (next.add) lines.push({ variantId: next.add, quantity: 1 });
      if (next.remove) lines = lines.map((l) => ({ ...l, quantity: l.quantity - (l.variantId === next.remove ? 1 : 0) })).filter((l) => l.quantity > 0);
      render(await check(lines, next.scan));
      status("");
      lockControls(true);
    }
  } catch (error) {
    const skipped = state.queue.length;
    state.queue = [];
    status(`${error.message}${skipped ? ` ${skipped} later scans were not added; scan them again.` : ""}`, true);
  } finally {
    state.busy = false;
    lockControls(false);
    $("queue-status").textContent = "";
    if (state.deal) $("scan").focus();
  }
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const form = new FormData(event.currentTarget);
    const session = await api("/login", { username: form.get("username"), password: form.get("password") });
    $("login-form").reset();
    await signedIn(session);
  } catch (error) { status(error.message, true); }
  finally { button.disabled = false; }
});
$("logout").addEventListener("click", async () => {
  try { await api("/logout", {}); loginPanel(); status("Signed out."); }
  catch (error) { status(error.message, true); }
});
$("setup").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  lockControls(true);
  state.deal = null;
  state.lines = [];
  $("till").hidden = true;
  try {
    const recipe = state.recipes.find((r) => r.id === $("deal").value);
    status("Loading the deal and current stock…");
    const result = await api(`/deals/${recipe.id}/test`, { recipeVersion: recipe.version, locationId: $("location").value, lines: [] });
    render(result);
    choices(result.deal);
    $("scan").value = "";
    $("scan").focus();
    status("");
  } catch (error) { status(error.message, true); }
  finally { state.busy = false; lockControls(false); }
});
for (const id of ["deal", "location"]) $(id).addEventListener("change", () => {
  state.deal = null;
  state.lines = [];
  $("till").hidden = true;
  status("Press Start scanning to open an empty basket for this selection.");
});
$("scan-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const scan = $("scan").value.trim();
  if (!scan) return;
  $("scan").value = "";
  enqueue({ scan });
});
$("clear").addEventListener("click", () => enqueue({ clear: true }));
try { await signedIn(await api("/session")); }
catch (error) { if (state.csrf) status(error.message, true); }
