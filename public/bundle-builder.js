const $ = (id) => document.getElementById(id);
const state = {
  csrf: "",
  staff: null,
  recipes: [],
  draft: null,
  dirty: false,
  busy: false,
  currency: "GBP",
  picker: null,
  generation: 0,
};
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const money = (value) =>
  Number.isFinite(Number(value))
    ? new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: state.currency,
      }).format(Number(value))
    : "Price unavailable";
const itemName = (v) =>
  v.title === "Default Title"
    ? v.productTitle
    : `${v.productTitle} / ${v.title}`;
function status(message = "", error = false, picker = false) {
  const node = $(picker ? "picker-status" : "status");
  node.textContent = message;
  node.className = error ? "error" : "";
}
function button(text, action, className = "") {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", () => run(action));
  return node;
}
async function api(path, data, method = "POST") {
  const response = await fetch(`/api/bundles${path}`, {
    method: data === undefined ? "GET" : method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) login();
    const error = new Error(
      result.error || "Could not load bundle data. Please retry.",
    );
    error.status = response.status;
    throw error;
  }
  return result;
}
async function run(action) {
  if (state.busy) return;
  state.busy = true;
  const controls = [
    ...document.querySelectorAll(
      "#bundle-editor button, #bundle-editor input, #picker button, #picker input, #logout, #new-bundle, #bundle-list button, #login-form button",
    ),
  ];
  const prior = controls.map((n) => n.disabled);
  controls.forEach((n) => {
    n.disabled = true;
  });
  try {
    await action();
  } catch (error) {
    status(error.message, true, $("picker").open);
  } finally {
    controls.forEach((n, i) => {
      if (n.isConnected) n.disabled = prior[i];
    });
    state.busy = false;
    sync();
  }
}
function login() {
  state.generation++;
  state.csrf = "";
  state.staff = null;
  state.draft = null;
  state.dirty = false;
  state.recipes = [];
  state.picker = null;
  if ($("picker").open) $("picker").close();
  $("workspace").hidden = true;
  $("account").hidden = true;
  $("login-panel").hidden = false;
  $("bundle-list").replaceChildren();
  $("components").replaceChildren();
}
async function signedIn(session) {
  state.csrf = session.csrf;
  state.staff = session.staff;
  const data = await api("/recipes");
  state.recipes = data.recipes;
  // Currency only affects the optional price display; editing is still available if stock metadata is down.
  try {
    state.currency = (await api("/catalog")).currency;
  } catch (error) {
    if (!state.staff) throw error;
  }
  $("staff-name").textContent = session.staff.name;
  $("login-panel").hidden = true;
  $("workspace").hidden = false;
  $("account").hidden = false;
  $("new-bundle").hidden = session.staff.role !== "manager";
  showList();
  status();
}
function showList() {
  state.draft = null;
  state.dirty = false;
  state.generation++;
  $("bundle-editor").hidden = true;
  $("bundle-list-panel").hidden = false;
  const list = $("bundle-list");
  list.replaceChildren();
  if (!state.recipes.length) {
    const empty = el("div", undefined, "empty");
    empty.append(
      el("strong", "Your first bundle starts with a product."),
      el(
        "p",
        "Select it, add its components and save. No new Shopify products are created.",
      ),
    );
    list.append(empty);
  }
  for (const recipe of state.recipes) {
    const card = el("article", undefined, "bundle-card"),
      text = el("div", undefined, "grow");
    text.append(
      el("h3", recipe.name),
      el(
        "p",
        recipe.components.map((c) => `${c.quantity} × ${c.name}`).join(" · "),
      ),
      el("span", "Saved setup · stock updates off", "tag amber"),
    );
    card.append(
      text,
      button(
        state.staff.role === "manager" ? "Edit bundle" : "View bundle",
        () => edit(recipe.id),
      ),
    );
    list.append(card);
  }
}
function start() {
  state.draft = {
    name: "",
    finishedVariantIds: [],
    inventoryOwnership: "unconfirmed",
    components: [],
    finished: [],
  };
  state.dirty = false;
  showEditor();
}
async function edit(id) {
  const data = await api(`/definitions/${encodeURIComponent(id)}`);
  const parentIds = new Set(data.finished.map((v) => v.productId));
  state.draft = {
    ...data.recipe,
    finished: data.finished,
    components: data.components,
    ...(parentIds.size === 1
      ? { bundleProductId: data.finished[0].productId }
      : {}),
  };
  state.dirty = false;
  showEditor();
}
function showEditor() {
  $("bundle-list-panel").hidden = true;
  $("bundle-editor").hidden = false;
  $("editor-title").textContent = state.draft.id
    ? "Edit bundle"
    : "Set up new bundle";
  status();
  render();
  $("editor-title").scrollIntoView({ block: "nearest" });
}
function change() {
  state.dirty = true;
  sync();
}
function sync() {
  const d = state.draft,
    manager = state.staff?.role === "manager";
  $("select-bundle").disabled = state.busy || !manager;
  $("add-components").disabled = state.busy || !manager || !d?.finished.length;
  $("save-bundle").disabled =
    state.busy ||
    !manager ||
    !d?.finished.length ||
    !d?.components.length ||
    d.components.some((c) => !c.choices?.length || c.issue);
  $("confirm-picker").disabled = state.busy || !state.picker?.selected.size;
  if (state.picker)
    $("selection-count").textContent = state.picker.selected.size
      ? `${state.picker.selected.size} selected`
      : "Nothing selected";
}
function priceRange(rows) {
  const prices = [...new Set(rows.map((v) => v.price))];
  return prices.length === 1
    ? money(prices[0])
    : `${money(Math.min(...prices.map(Number)))}–${money(Math.max(...prices.map(Number)))}`;
}
function choiceList(rows) {
  const list = el("ul", undefined, "choice-list");
  for (const v of rows) {
    const line = el("li"),
      text = el("span", v.title === "Default Title" ? v.productTitle : v.title);
    text.append(el("small", v.sku || "No SKU"));
    line.append(text, el("span", money(v.price)));
    list.append(line);
  }
  return list;
}
function render() {
  const d = state.draft;
  if (!d) return;
  const summary = $("bundle-product");
  summary.replaceChildren();
  if (d.finished.length) {
    const titles = [...new Set(d.finished.map((v) => v.productTitle))];
    summary.append(
      el("strong", titles.join(" / ")),
      el(
        "div",
        d.finished.map((v) => v.sku || v.title).join(" · "),
        "product-meta",
      ),
      el(
        "div",
        `Shopify price: ${priceRange(d.finished)} · ${d.finished.length === 1 ? "1 bundle SKU" : `${d.finished.length} existing variants in this product`}`,
        "product-price",
      ),
    );
    if (d.finished.length !== d.finishedVariantIds.length)
      summary.append(
        el(
          "p",
          "Some saved bundle variants are missing. Select the bundle again before saving.",
          "component-warning",
        ),
      );
  }
  $("select-bundle").textContent = d.finished.length
    ? "Change bundle"
    : "Select bundle";
  const container = $("components");
  container.replaceChildren();
  for (const c of d.components) {
    const row = el("div", undefined, "component-row");
    row.dataset.componentId = c.id;
    const quantityLabel = el("label", "Quantity"),
      quantity = el("input");
    Object.assign(quantity, {
      type: "number",
      min: "1",
      max: "1000",
      step: "1",
      value: String(c.quantity),
      required: true,
    });
    quantity.setAttribute("aria-label", `Quantity for ${c.name}`);
    quantity.disabled = state.staff.role !== "manager";
    quantity.addEventListener("input", () => {
      c.quantity = Number(quantity.value);
      change();
    });
    quantityLabel.append(quantity);
    const info = el("div");
    info.append(el("div", c.name, "component-name"));
    const count = c.choices?.length || 0;
    const excluded = c.rule.excludeVariantIds?.length || 0;
    const label =
      c.rule.type === "product"
        ? `All colours${excluded ? ` except ${excluded} excluded` : ""} · ${count} eligible`
        : c.rule.type === "prefix"
          ? `SKU family ${c.rule.value}* · ${count} eligible`
          : c.rule.type === "exact_sku"
            ? `Specific item · ${c.rule.value}`
            : `${count} selected items`;
    info.append(el("span", label, "tag"));
    if (c.issue) info.append(el("p", c.issue, "component-warning"));
    if (c.choices?.length) {
      const details = el("details");
      details.append(
        el("summary", `View eligible items (${count})`),
        choiceList(c.choices),
      );
      info.append(details);
      if (new Set(c.choices.map((v) => v.price)).size > 1)
        info.append(
          el(
            "p",
            `Prices vary: ${priceRange(c.choices)}. Use Specific item if you want a fixed option.`,
            "component-warning",
          ),
        );
    }
    if (c.bindingMode === "by_finished") {
      info.append(
        el(
          "p",
          "Earlier setup: this component must match the bundle colour.",
          "component-warning",
        ),
      );
      if (state.staff.role === "manager")
        info.append(
          button(
            "Allow any eligible colour",
            () => {
              c.bindingMode = "any";
              c.bindings = {};
              change();
              render();
            },
            "inline-action",
          ),
        );
    }
    const actions = el("div", undefined, "component-actions");
    if (state.staff.role === "manager") {
      actions.append(
        button("Change", () => openPicker("component", c.id)),
        button(
          "Remove",
          () => {
            d.components = d.components.filter((v) => v.id !== c.id);
            change();
            render();
          },
          "danger",
        ),
      );
      actions.lastChild.setAttribute("aria-label", `Remove ${c.name}`);
    }
    row.append(quantityLabel, info, actions);
    container.append(row);
  }
  sync();
}
function openPicker(target, replaceId = null) {
  state.picker = {
    target,
    replaceId,
    mode: "product",
    selected: new Map(),
    cursor: null,
    query: "",
    serial: 0,
  };
  $("picker-title").textContent =
    target === "bundle"
      ? "Select bundle"
      : replaceId
        ? "Change component"
        : "Add components";
  $("picker-tabs").hidden = target === "bundle";
  setMode("product");
  $("picker").showModal();
  $("picker-query").focus();
}
function setMode(mode) {
  const p = state.picker;
  p.serial++;
  p.mode = mode;
  p.cursor = null;
  p.selected.clear();
  $("picker-results").replaceChildren();
  $("more-results").hidden = true;
  $("picker-query").value = "";
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode)),
    );
  const family = mode === "prefix";
  $("search-label").textContent = family
    ? "Family SKU / beginning of SKU"
    : mode === "exact_sku"
      ? "Exact SKU"
      : "Product name or SKU";
  $("picker-query").placeholder = family
    ? "e.g. BOX_1_ or RB_RC_M"
    : mode === "exact_sku"
      ? "e.g. PAPK_RDY"
      : "e.g. rolling box or grinder";
  $("picker-help").textContent =
    p.target === "bundle"
      ? "Choose the existing Shopify product that represents your bundle."
      : family
        ? "Use the shared beginning of the SKUs. Check the matching items before adding the family."
        : mode === "exact_sku"
          ? "Only this item qualifies. Use this for a fixed component or a different price."
          : "Select a product once to allow all its colours and variants, including new ones added later.";
  status("", false, true);
  sync();
}
function closePicker() {
  if (state.busy) return;
  state.picker = null;
  $("picker").close();
}
function selectionRow(key, value, title, subtitle, tag) {
  const p = state.picker,
    row = el("label", undefined, "pick-row"),
    input = el("input");
  input.type = p.target === "bundle" || p.replaceId ? "radio" : "checkbox";
  input.name = "picker-choice";
  input.checked = p.selected.has(key);
  input.setAttribute("aria-label", title);
  input.addEventListener("change", () => {
    if (input.type === "radio") p.selected.clear();
    if (input.checked) p.selected.set(key, value);
    else p.selected.delete(key);
    sync();
  });
  const text = el("span", undefined, "grow");
  text.append(el("span", title, "name"), el("span", subtitle, "product-meta"));
  row.append(input, text);
  if (tag) row.append(el("span", tag, "tag"));
  return row;
}
async function search(more = false) {
  const p = state.picker;
  if (!p) return;
  const serial = ++p.serial,
    q = more ? p.query : $("picker-query").value.trim();
  if (!q) return;
  if (!more) {
    p.query = q;
    p.cursor = null;
    $("picker-results").replaceChildren();
  }
  status("Searching Shopify…", false, true);
  if (p.mode === "product") {
    const data = await api(
      `/products?q=${encodeURIComponent(q)}${more && p.cursor ? `&after=${encodeURIComponent(p.cursor)}` : ""}`,
    );
    if (p !== state.picker || p.serial !== serial) return;
    let shown = 0;
    for (const product of data.products) {
      if (p.target !== "bundle" && product.id === state.draft.bundleProductId)
        continue;
      shown++;
      $("picker-results").append(
        selectionRow(
          product.id,
          { product },
          product.title,
          `${product.sku || "No SKU"}${product.variantCount > 1 ? ` · ${product.variantCount} variants` : ""}`,
          product.status === "DRAFT" ? "Draft" : "",
        ),
      );
    }
    p.cursor = data.nextCursor;
    $("more-results").hidden = !p.cursor;
    status(
      shown
        ? ""
        : "No matching products on this page. Try a different name or SKU.",
      false,
      true,
    );
  } else {
    const result = await api("/component-choices", {
      rule: { type: p.mode, value: q },
    });
    if (p !== state.picker || p.serial !== serial) return;
    if (
      result.variants.some((v) => v.productId === state.draft.bundleProductId)
    )
      throw new Error(
        "This family includes the bundle product itself. Use a narrower family SKU.",
      );
    p.selected.clear();
    if (!result.variants.length) {
      status("No matching items. Check the SKU and try again.", false, true);
      sync();
      return;
    }
    const family = p.mode === "prefix",
      name = family
        ? `${result.rule.value} · SKU family`
        : itemName(result.variants[0]);
    const candidate = { rule: result.rule, choices: result.variants, name };
    const card = el("div", undefined, "family-result");
    card.append(
      selectionRow(
        result.rule.value,
        candidate,
        name,
        `${result.variants.length} eligible item${result.variants.length === 1 ? "" : "s"}`,
        family ? "Any one" : "Exact item",
      ),
      choiceList(result.variants),
    );
    $("picker-results").append(card);
    status("Check the matches, then select this component.", false, true);
  }
  sync();
}
async function confirmPicker() {
  const p = state.picker,
    d = state.draft;
  if (!p?.selected.size || !d) return;
  const picked = [];
  for (const selected of p.selected.values()) {
    if (selected.product) {
      const result = await api("/component-choices", {
        rule: { type: "product", value: selected.product.id },
      });
      picked.push({
        rule: result.rule,
        choices: result.variants,
        name: selected.product.title,
        product: selected.product,
      });
    } else picked.push(selected);
  }
  if (state.picker !== p || state.draft !== d) return;
  if (picked.some((v) => !v.choices.length))
    throw new Error(
      "A selected product no longer has eligible items. Search again.",
    );
  if (p.target === "bundle") {
    const first = picked[0];
    if (
      state.recipes.some(
        (recipe) =>
          recipe.id !== d.id &&
          recipe.finishedVariantIds.some((id) =>
            first.choices.some((v) => v.id === id),
          ),
      )
    ) {
      throw new Error(
        "This product already has a saved bundle. Go back to Your bundles and edit that setup.",
      );
    }
    if (first.choices.length > 50)
      throw new Error(
        "This setup supports bundle products with up to 50 existing variants.",
      );
    if (
      d.components.some((c) =>
        c.choices?.some((v) => v.productId === first.product.id),
      )
    )
      throw new Error(
        "That product is already a component. Remove it from Components before choosing it as the bundle.",
      );
    if (
      d.components.some((c) => c.bindingMode === "by_finished") &&
      d.bundleProductId !== first.product.id
    )
      throw new Error(
        "Choose 'Allow any eligible colour' on the linked components before changing the bundle product.",
      );
    d.name = first.product.title;
    d.bundleProductId = first.product.id;
    d.finished = first.choices;
    d.finishedVariantIds = first.choices.map((v) => v.id);
  } else {
    const proposed = d.components.filter((c) => c.id !== p.replaceId);
    for (const item of picked) {
      if (item.choices.some((v) => v.productId === d.bundleProductId))
        throw new Error("The bundle product cannot also be a component.");
      const ids = new Set(item.choices.map((v) => v.id));
      if (proposed.some((c) => c.choices?.some((v) => ids.has(v.id))))
        throw new Error(
          "One of these items is already included. Increase its quantity instead of adding an overlapping component.",
        );
      const previous = d.components.find((c) => c.id === p.replaceId);
      proposed.push({
        id: previous?.id || crypto.randomUUID(),
        name: item.name,
        quantity: previous?.quantity || 1,
        rule: item.rule,
        choices: item.choices,
        bindingMode: "any",
        bindings: {},
      });
    }
    if (proposed.length > 30) throw new Error("Use at most 30 component rows.");
    d.components = proposed;
  }
  change();
  state.picker = null;
  $("picker").close();
  render();
}
async function save() {
  const d = state.draft;
  if (!d?.bundleProductId)
    throw new Error("Select one bundle product before saving.");
  const recipe = {
    name: d.name,
    bundleProductId: d.bundleProductId,
    finishedVariantIds: d.finishedVariantIds,
    inventoryOwnership: d.inventoryOwnership,
    components: d.components.map(({ choices, issue, ...c }) => c),
  };
  const result = await api(
    d.id ? `/recipes/${encodeURIComponent(d.id)}` : "/recipes",
    { recipe, ...(d.id ? { expectedVersion: d.version } : {}) },
    d.id ? "PUT" : "POST",
  );
  state.dirty = false;
  const index = state.recipes.findIndex((r) => r.id === result.recipe.id);
  if (index === -1) state.recipes.unshift(result.recipe);
  else state.recipes[index] = result.recipe;
  showList();
  status(
    `Saved “${result.recipe.name}”. You can reopen it below. Shopify stock is unchanged.`,
  );
}
function leaveEditor() {
  if (state.dirty) $("discard-dialog").showModal();
  else {
    showList();
    status();
  }
}
$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(async () => {
    const form = new FormData(event.currentTarget);
    const session = await api("/login", {
      username: form.get("username"),
      password: form.get("password"),
    });
    event.currentTarget?.reset();
    $("login-form").reset();
    await signedIn(session);
  });
});
$("logout").addEventListener("click", () =>
  run(async () => {
    if (state.dirty) {
      status("Save or discard your changes before signing out.", true);
      return;
    }
    await api("/logout", {});
    login();
    status("Signed out.");
  }),
);
$("new-bundle").addEventListener("click", () => run(start));
$("select-bundle").addEventListener("click", () =>
  run(() => openPicker("bundle")),
);
$("add-components").addEventListener("click", () =>
  run(() => openPicker("component")),
);
$("bundle-editor").addEventListener("submit", (event) => {
  event.preventDefault();
  run(save);
});
$("picker-search").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => search());
});
$("more-results").addEventListener("click", () => run(() => search(true)));
$("confirm-picker").addEventListener("click", () => run(confirmPicker));
for (const node of document.querySelectorAll("[data-mode]"))
  node.addEventListener("click", () => {
    if (!state.busy) setMode(node.dataset.mode);
  });
for (const id of ["close-picker", "cancel-picker"])
  $(id).addEventListener("click", closePicker);
$("picker").addEventListener("cancel", (event) => {
  if (state.busy) event.preventDefault();
  else state.picker = null;
});
for (const id of ["back", "discard"])
  $(id).addEventListener("click", leaveEditor);
$("keep-editing").addEventListener("click", () => $("discard-dialog").close());
$("confirm-discard").addEventListener("click", () => {
  $("discard-dialog").close();
  showList();
  status();
});
window.addEventListener("beforeunload", (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
run(async () => {
  status("Loading your bundles…");
  try {
    await signedIn(await api("/session"));
  } catch (error) {
    login();
    status(error.status === 401 ? "" : error.message, error.status !== 401);
  }
});
