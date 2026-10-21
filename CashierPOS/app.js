async function api(path, method, body) {
  const res = await fetch(API_BASE + path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

const $ = (id) => document.getElementById(id);
const peso = (n) => '₱' + Number(n).toLocaleString('en-PH');
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const RESTAURANT_NAME = 'Geek Restaurant';   // shown at the top of receipts
function fmtDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}
function say(text) { $('msg').textContent = text; }
function sayOrder(text) { $('orderMsg').textContent = text; }

let menu = [];
const cart = new Map();        // line key -> { key, id, variant, opts, qty }
const selections = new Map();  // item id -> { groupKey: choice label } picked on the menu card
const invalid = new Set();     // item ids whose required choice is still missing
let current = null;
let busy = false;
let sampleOrders = null;
let historyOrders = [];
let historyFilter = 'ALL';

/* ---------- data ---------- */

async function loadSample() {
  if (!sampleOrders) {
    sampleOrders = await (await fetch('sample.json')).json();
    const now = Date.now();
    sampleOrders.forEach((o, i) => {
      if (!o.created_at) o.created_at = new Date(now - (sampleOrders.length - i) * 45 * 60000).toISOString();
      if (o.payment_status === 'PAID' && !o.paid_at) o.paid_at = new Date(Date.parse(o.created_at) + 10 * 60000).toISOString();
    });
  }
  return sampleOrders;
}

async function getMenu() {
  if (USE_SAMPLE) return (await fetch('menu.json')).json();
  return api('/menu');
}

async function getOrder(no) {
  if (USE_SAMPLE) {
    const orders = await loadSample();
    const o = orders.find((x) => x.order_no === no);
    if (!o) throw new Error('Order not found');
    return o;
  }
  return api('/orders/' + encodeURIComponent(no));
}

async function getHistory() {
  if (USE_SAMPLE) return [...(await loadSample())];
  return api('/orders');
}

async function findOrdersByItem(code) {
  if (USE_SAMPLE) {
    const orders = await loadSample();
    return orders.filter((o) => o.items.some((i) => i.id === code));
  }
  return api('/orders?item=' + encodeURIComponent(code));
}

async function createOrder(lines) {
  if (USE_SAMPLE) {
    const orders = await loadSample();
    const o = {
      order_no: 'A' + (1001 + orders.length),
      items: lines.map((l) => ({ id: l.id, name: l.name, qty: l.qty, price: l.price })),
      total: lines.reduce((sum, l) => sum + l.price * l.qty, 0),
      payment_status: 'PENDING',
      fulfillment_status: 'RECEIVED',
      created_at: new Date().toISOString(),
    };
    orders.push(o);
    return o;
  }
  return api('/orders', 'POST', {
    items: lines.map((l) => ({ id: l.id, qty: l.qty, variant: l.variant, options: l.options })),
  });
}

async function payOrder(o) {
  if (USE_SAMPLE) {
    if (o.payment_status !== 'PENDING') throw new Error('Not allowed now: ' + o.payment_status);
    o.payment_status = 'PAID';
    o.paid_at = new Date().toISOString();
    return o;
  }
  return api('/orders/' + o.order_no + '/payment', 'PATCH');
}

/* ---------- cart ---------- */

function itemById(id) { return menu.find((m) => m.id === id); }

// Turns a cart entry into a priced line (size and chosen options included).
function lineInfo(c) {
  const m = itemById(c.id);
  const v = c.variant && m.variants ? m.variants.find((x) => x.label === c.variant) : null;
  let price = v ? v.price : m.price;
  const parts = v ? [v.label] : [];
  (m.options || []).forEach((g) => {
    const choice = g.choices.find((x) => x.label === (c.opts || {})[g.key]);
    if (choice) {
      price += choice.price;
      parts.push(choice.label + (g.suffix ? ' ' + g.suffix : ''));
    }
  });
  return {
    key: c.key, id: c.id, qty: c.qty, price,
    name: m.name + (parts.length ? ' (' + parts.join(', ') + ')' : ''),
    variant: v ? v.label : null,
    options: { ...(c.opts || {}) },
  };
}

function cartLines() {
  return [...cart.values()].filter((c) => itemById(c.id)).map(lineInfo);
}

function addToCart(id, variant, opts) {
  const m = itemById(id);
  const key = [id, variant || '', (m.options || []).map((g) => (opts || {})[g.key] || '').join(',')].join('|');
  const existing = cart.get(key);
  if (existing) existing.qty += 1;
  else cart.set(key, { key, id, variant, opts: { ...(opts || {}) }, qty: 1 });
  selections.delete(id);
  invalid.delete(id);
  sayOrder('');
  renderMenu();
  renderCart();
  return key;
}

function changeQty(key, delta) {
  const c = cart.get(key);
  if (!c) return;
  c.qty += delta;
  if (c.qty <= 0) cart.delete(key);
  sayOrder('');
  renderMenu();
  renderCart();
}

function missingGroups(m, opts) {
  return (m.options || []).filter((g) => g.required && !(opts || {})[g.key]);
}

function renderMenu() {
  const box = $('menu');
  box.replaceChildren();
  let category = null;

  menu.forEach((m) => {
    if (m.category !== category) {
      category = m.category;
      if (category) box.append(el('h3', 'cat', category));
    }

    const card = el('div', 'item');
    card.append(el('div', 'item-code', m.id));
    card.append(el('div', 'item-name', m.name));

    const prices = m.variants ? m.variants.map((v) => v.price) : [m.price];
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    card.append(el('div', 'item-price', lo === hi ? peso(lo) : peso(lo) + ' – ' + peso(hi)));

    const inCart = [...cart.values()].filter((c) => c.id === m.id).reduce((s, c) => s + c.qty, 0);
    if (inCart) card.append(el('span', 'badge', '×' + inCart));

    (m.options || []).forEach((g) => {
      const wrap = el('label', 'opt');
      wrap.append(el('span', 'opt-label', g.label + (g.required ? ' *' : '')));
      const sel = el('select');
      sel.dataset.item = m.id;
      sel.dataset.group = g.key;
      const blank = el('option', '', g.required ? 'Choose…' : 'None');
      blank.value = '';
      sel.append(blank);
      g.choices.forEach((ch) => {
        const o = el('option', '', ch.label + (ch.price ? ' (+' + peso(ch.price) + ')' : ''));
        o.value = ch.label;
        sel.append(o);
      });
      sel.value = (selections.get(m.id) || {})[g.key] || '';
      if (invalid.has(m.id) && g.required && !sel.value) sel.classList.add('invalid');
      wrap.append(sel);
      card.append(wrap);
    });

    if (m.variants) {
      const sizes = el('div', 'sizes');
      m.variants.forEach((v) => {
        const b = el('button', 'add', v.label + ' ' + peso(v.price));
        b.type = 'button';
        b.dataset.act = 'add';
        b.dataset.id = m.id;
        b.dataset.variant = v.label;
        b.setAttribute('aria-label', 'Add ' + m.name + ' ' + v.label);
        sizes.append(b);
      });
      card.append(sizes);
    } else {
      const b = el('button', 'add', 'Add to order');
      b.type = 'button';
      b.dataset.act = 'add';
      b.dataset.id = m.id;
      b.setAttribute('aria-label', 'Add ' + m.name);
      card.append(b);
    }

    box.append(card);
  });
}

function renderCart() {
  const list = $('cart');
  list.replaceChildren();
  const lines = cartLines();

  if (!lines.length) {
    list.append(el('li', 'empty', 'No items yet. Tap a menu item to add it.'));
  }

  lines.forEach((l) => {
    const li = el('li');

    const info = el('div');
    info.append(el('div', 'line-name', l.id + ' · ' + l.name), el('div', 'line-price', peso(l.price) + ' each'));

    const qty = el('div', 'qty');
    const minus = el('button', '', '−');
    minus.type = 'button';
    minus.dataset.act = 'dec';
    minus.dataset.key = l.key;
    minus.setAttribute('aria-label', 'Remove one ' + l.name);
    const plus = el('button', '', '+');
    plus.type = 'button';
    plus.dataset.act = 'inc';
    plus.dataset.key = l.key;
    plus.setAttribute('aria-label', 'Add one ' + l.name);
    qty.append(minus, el('span', '', String(l.qty)), plus);

    li.append(info, qty, el('div', 'line-total', peso(l.price * l.qty)));
    list.append(li);
  });

  const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  $('total').textContent = peso(total);
  $('place').disabled = !lines.length || busy;
  $('clear').disabled = !lines.length;
}

$('menu').onclick = (e) => {
  const b = e.target.closest('button[data-act="add"]');
  if (!b) return;
  const m = itemById(b.dataset.id);
  const opts = selections.get(m.id) || {};
  const missing = missingGroups(m, opts);
  if (missing.length) {
    invalid.add(m.id);
    sayOrder(m.name + ': choose ' + missing.map((g) => g.label.toLowerCase()).join(' and ') + ' first');
    renderMenu();
    return;
  }
  addToCart(m.id, b.dataset.variant || null, opts);
};

$('menu').onchange = (e) => {
  const s = e.target.closest('select[data-item]');
  if (!s) return;
  const picked = selections.get(s.dataset.item) || {};
  if (s.value) picked[s.dataset.group] = s.value; else delete picked[s.dataset.group];
  selections.set(s.dataset.item, picked);
  invalid.delete(s.dataset.item);
  s.classList.remove('invalid');
};

$('cart').onclick = (e) => {
  const b = e.target.closest('button[data-act]');
  if (b) changeQty(b.dataset.key, b.dataset.act === 'inc' ? 1 : -1);
};

/* ---------- quick add by item code ---------- */

function optionHelp(m) {
  const parts = [];
  if (m.variants) parts.push('Size: ' + m.variants.map((v) => v.label).join(' / '));
  (m.options || []).forEach((g) => parts.push(g.label + ': ' + g.choices.map((c) => c.label).join(' / ')));
  return parts.length ? 'Choices - ' + parts.join('; ') : m.name + ' has no options';
}

// "M001", "M001 spicy", "D001 M", "DS003 fried strawberry"
function addByCode(text) {
  const words = text.trim().toUpperCase()
    .replace(/\b(NOT|NON)\s*FRIED\b/g, 'NOTFRIED')
    .split(/\s+/).filter(Boolean);
  const code = words.shift();
  if (!code) { sayOrder('Type an item code, e.g. M001'); return false; }
  const m = itemById(code);
  if (!m) { sayOrder('No item with code ' + code); return false; }

  const norm = (s) => s.toUpperCase().replace(/\s+/g, '');
  let variant = null;
  const opts = {};

  for (const w of words) {
    let hit = false;

    if (m.variants) {
      const v = m.variants.filter((x) => x.label.toUpperCase().startsWith(w));
      if (v.length === 1) { variant = v[0].label; hit = true; }
    }

    if (!hit) {
      for (const g of m.options || []) {
        const matches = g.choices.filter((ch) =>
          norm(ch.label).startsWith(w) || ch.label.toUpperCase().split(/\s+/).some((p) => p.startsWith(w)));
        const pick = matches.length > 1 ? matches.filter((ch) => norm(ch.label) === w) : matches;
        if (pick.length === 1) { opts[g.key] = pick[0].label; hit = true; break; }
        if (matches.length > 1) {
          sayOrder("'" + w.toLowerCase() + "' could mean more than one choice. Type a bit more of the name.");
          return false;
        }
      }
    }

    if (!hit) {
      sayOrder("Not sure what '" + w.toLowerCase() + "' means for " + m.name + '. ' + optionHelp(m));
      return false;
    }
  }

  const needs = [];
  if (m.variants && !variant) {
    needs.push('a size (' + m.variants.map((v) => v.label).join(', ') + '). Example: ' + m.id + ' ' + m.variants[0].label[0]);
  }
  missingGroups(m, opts).forEach((g) => {
    needs.push(g.label.toLowerCase() + ' (' + g.choices.map((c) => c.label).join(' or ') + '). Example: ' + m.id + ' ' + g.choices[0].label.toLowerCase());
  });
  if (needs.length) { sayOrder(m.name + ' needs ' + needs.join(' Also needs ')); return false; }

  const key = addToCart(m.id, variant, opts);
  sayOrder('Added ' + m.id + ' ' + lineInfo(cart.get(key)).name);
  return true;
}

$('addcode').onclick = () => {
  if (addByCode($('code').value)) $('code').value = '';
  $('code').focus();
};
$('code').onkeydown = (e) => { if (e.key === 'Enter') $('addcode').onclick(); };

$('clear').onclick = () => {
  cart.clear();
  selections.clear();
  invalid.clear();
  sayOrder('');
  renderMenu();
  renderCart();
};

$('place').onclick = async () => {
  if (busy) return;
  const lines = cartLines();
  if (!lines.length) { sayOrder('Add at least one item'); return; }
  busy = true;
  renderCart();
  try {
    const o = await createOrder(lines);
    cart.clear();
    current = o;
    $('no').value = o.order_no;
    say('');
    sayOrder('Order ' + o.order_no + ' placed. Take payment below.');
    renderMenu();
    refreshHistory();
  } catch (e) { sayOrder(e.message); }
  busy = false;
  renderCart();
  showOrder();
};

/* ---------- payment ---------- */

function showOrder() {
  const o = current;
  const box = $('details');
  box.replaceChildren();

  if (o) {
    const head = el('div', 'order-head');
    head.append(
      el('strong', '', 'Order ' + o.order_no),
      el('span', 'status ' + o.payment_status.toLowerCase(), o.payment_status)
    );
    box.append(head);

    const list = el('ul', 'order-lines');
    o.items.forEach((i) => {
      const li = el('li');
      li.append(
        el('span', 'code', i.id),
        el('span', 'oname', i.qty + '× ' + i.name),
        el('span', 'oprice', peso(i.price * i.qty))
      );
      list.append(li);
    });
    box.append(list);

    const total = el('div', 'order-total');
    total.append(el('span', '', 'Total'), el('strong', '', peso(o.total)));
    box.append(total);
  }

  $('pay').disabled = !o || o.payment_status !== 'PENDING';
  renderReceipt();
  renderHistory();
}

function renderReceipt() {
  const box = $('receipt');
  box.replaceChildren();
  const o = current;
  if (!o || o.payment_status !== 'PAID') { box.hidden = true; return; }
  box.hidden = false;

  const row = (left, right, cls) => {
    const r = el('div', 'r-row' + (cls ? ' ' + cls : ''));
    r.append(el('span', '', left), el('span', 'r-amt', right));
    return r;
  };

  box.append(el('div', 'r-title', RESTAURANT_NAME), el('div', 'r-sub', 'Payment receipt'));

  const meta = el('div', 'r-meta');
  meta.append(el('div', '', 'Order: ' + o.order_no));
  if (o.created_at) meta.append(el('div', '', 'Ordered: ' + fmtDate(o.created_at)));
  if (o.paid_at) meta.append(el('div', '', 'Paid: ' + fmtDate(o.paid_at)));
  box.append(meta);

  const items = el('div', 'r-items');
  o.items.forEach((i) => {
    items.append(row(i.id + ' ' + i.name, peso(i.price * i.qty)));
    items.append(el('div', 'r-detail', i.qty + ' × ' + peso(i.price)));
  });
  box.append(items);

  box.append(row('TOTAL', peso(o.total), 'r-total'));
  box.append(el('div', 'r-paid', 'PAID'));
  box.append(el('div', 'r-thanks', 'Thank you! Please come again.'));

  const btn = el('button', 'primary no-print', 'Print receipt');
  btn.type = 'button';
  btn.onclick = () => window.print();
  box.append(btn);
}

/* ---------- history ---------- */

function renderHistory() {
  const box = $('history');
  box.replaceChildren();
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.f === historyFilter));

  const rows = historyOrders
    .filter((o) => historyFilter === 'ALL' || o.payment_status === historyFilter)
    .slice()
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)
      || b.order_no.localeCompare(a.order_no, undefined, { numeric: true }));

  if (!rows.length) { box.append(el('p', 'note', 'No orders to show.')); return; }

  const table = el('table');
  const head = el('tr');
  ['Order', 'Time', 'Items', 'Total', 'Status', ''].forEach((h) => head.append(el('th', '', h)));
  const thead = el('thead');
  thead.append(head);
  table.append(thead);

  const tbody = el('tbody');
  rows.forEach((o) => {
    const tr = el('tr', current && current.order_no === o.order_no ? 'sel' : '');
    const btn = el('button', '', o.payment_status === 'PAID' ? 'Receipt' : 'Open');
    btn.type = 'button';
    btn.dataset.no = o.order_no;
    const action = el('td');
    action.append(btn);
    const status = el('td');
    status.append(el('span', 'status ' + o.payment_status.toLowerCase(), o.payment_status));
    tr.append(
      el('td', 'code', o.order_no),
      el('td', '', fmtDate(o.created_at)),
      el('td', '', String(o.items.reduce((sum, i) => sum + i.qty, 0))),
      el('td', 'oprice', peso(o.total)),
      status,
      action
    );
    tbody.append(tr);
  });
  table.append(tbody);
  box.append(table);
}

async function refreshHistory() {
  try {
    historyOrders = await getHistory();
  } catch (e) {
    $('history').replaceChildren(el('p', 'note', 'Could not load history: ' + e.message));
    return;
  }
  renderHistory();
}

$('history').onclick = (e) => {
  const b = e.target.closest('button[data-no]');
  if (!b) return;
  const o = historyOrders.find((x) => x.order_no === b.dataset.no);
  if (!o) return;
  current = o;
  $('no').value = o.order_no;
  $('results').replaceChildren();
  say('');
  showOrder();
  $('details').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

$('filters').onclick = (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  historyFilter = b.dataset.f;
  renderHistory();
};

function renderResults(code, orders) {
  const box = $('results');
  box.replaceChildren();
  const m = itemById(code);
  box.append(el('div', 'results-head', 'Orders with ' + code + ' ' + m.name + ' (' + orders.length + ')'));
  orders.slice().reverse().forEach((o) => {
    const b = el('button', 'result');
    b.type = 'button';
    b.dataset.no = o.order_no;
    b.append(
      el('span', '', o.order_no),
      el('span', 'status ' + o.payment_status.toLowerCase(), o.payment_status),
      el('span', 'oprice', peso(o.total))
    );
    box.append(b);
  });
  box.onclick = (e) => {
    const r = e.target.closest('button[data-no]');
    if (!r) return;
    current = orders.find((o) => o.order_no === r.dataset.no) || null;
    say('');
    showOrder();
  };
}

$('find').onclick = async () => {
  const q = $('no').value.trim().toUpperCase();
  $('results').replaceChildren();
  current = null;
  if (!q) { say('Enter an order number or item code'); showOrder(); return; }
  try {
    if (itemById(q)) {
      const orders = await findOrdersByItem(q);
      renderResults(q, orders);
      say(orders.length ? 'Tap an order to open it' : 'No orders with ' + q);
    } else {
      current = await getOrder(q);
      say('');
    }
  } catch (e) { current = null; say(e.message); }
  showOrder();
};
$('no').onkeydown = (e) => { if (e.key === 'Enter') $('find').onclick(); };

$('pay').onclick = async () => {
  if (busy) return;
  if (!current) { say('Find an order first'); return; }
  busy = true;
  try {
    current = await payOrder(current);
    say('Payment recorded. Receipt is ready.');
    refreshHistory();
  } catch (e) { say(e.message); }
  busy = false;
  showOrder();
};

/* ---------- start ---------- */

(async function init() {
  try {
    menu = await getMenu();
  } catch (e) {
    sayOrder('Could not load the menu: ' + e.message);
  }
  renderMenu();
  renderCart();
  showOrder();
  refreshHistory();
})();