const TOKEN_KEY = 'undercut.token';
const REFRESH_MS = 5000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  edit: 'M4 20h4L19 9l-4-4L4 16v4M13 7l4 4',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 5l12 7-12 7V5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
};

const $ = (selector, root = document) => root.querySelector(selector);
const coins = new Intl.NumberFormat();

let token = readToken();
let cfg = null;
let state = null;
let swRegistration = null;
let editingId = null;
let confirmRemoveId = null;
let confirmTimer = null;
let lastAlertId = null;
let installPrompt = null;
let toastTimer = null;
let mutations = 0;
let refreshing = null;
let creatingAccount = null;
let searchTimer = null;
let searchSequence = 0;
let searchResults = [];

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(value) {
  token = value;
  try {
    localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // Private browsing can block storage. The session still works until reload.
  }
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const mutating = method !== 'GET';
  if (mutating) mutations += 1;
  try {
    let response;
    try {
      response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new RequestError(0, 'Cannot reach the server.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new RequestError(response.status, data.error || 'Something went wrong.');
    return data;
  } finally {
    if (mutating) mutations += 1;
  }
}

function createAccount() {
  creatingAccount ??= api('/api/accounts', { method: 'POST' })
    .then((result) => writeToken(result.token))
    .finally(() => { creatingAccount = null; });
  return creatingAccount;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function icon(name) {
  const root = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  root.append(svg('path', { d: ICONS[name] }));
  return root;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3800);
}

async function act(fn) {
  try {
    return await fn();
  } catch (error) {
    toast(error.message);
    return undefined;
  }
}

function parseCoins(raw) {
  const text = raw.trim().toLowerCase().replace(/\s/g, '');
  if (!text) return null;
  const short = /^(\d+(?:[.,]\d{1,3})?)([km])$/.exec(text);
  if (short) {
    const multiplier = short[2] === 'k' ? 1_000 : 1_000_000;
    return Math.round(Number(short[1].replace(',', '.')) * multiplier);
  }
  if (/^\d{1,3}([.,]\d{3})+$/.test(text)) return Number(text.replace(/[.,]/g, ''));
  return /^\d+$/.test(text) ? Number(text) : null;
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

const platformLabel = (platform) => (platform === 'pc' ? 'PC' : 'Console');

function statusOf(watch) {
  if (watch.paused) return { key: 'paused', label: 'Paused' };
  if (watch.currentPrice === null) {
    return watch.lastError ? { key: 'error', label: 'No price' } : { key: 'pending', label: 'Checking' };
  }
  if (watch.lastError) return { key: 'error', label: 'Price stale' };
  const gap = ((watch.currentPrice - watch.targetPrice) / watch.targetPrice) * 100;
  if (gap < 0) return { key: 'under', label: `${Math.abs(gap).toFixed(1)}% under` };
  if (gap === 0) return { key: 'above', label: 'At target' };
  return { key: 'above', label: `${gap.toFixed(1)}% above` };
}

// Price history drawn against the target line, with the zone under the target shaded.
function sparkline(watch) {
  const root = svg('svg', { class: 'spark', viewBox: '0 0 100 32', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const values = watch.history.length >= 2 ? watch.history : [];
  const min = Math.min(...values, watch.targetPrice * 0.97);
  const max = Math.max(...values, watch.targetPrice * 1.03);
  const range = max - min || 1;
  const y = (value) => 30 - ((value - min) / range) * 28;
  const targetY = Number(y(watch.targetPrice).toFixed(2));
  root.append(
    svg('rect', { class: 'zone', x: 0, y: targetY, width: 100, height: Math.max(0, 32 - targetY) }),
    svg('line', { class: 'target', x1: 0, x2: 100, y1: targetY, y2: targetY }),
  );
  if (values.length) {
    const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${y(value).toFixed(2)}`);
    root.append(svg('polyline', { class: 'line', points: points.join(' ') }));
  }
  return root;
}

function watchRow(watch, signature) {
  const status = statusOf(watch);
  const removing = confirmRemoveId === watch.id;
  const name = watch.playerName;

  const actions = el('div', { class: 'actions' },
    cfg.provider.canSimulateDrop && !watch.paused
      ? el('button', { class: 'text-action', type: 'button', onclick: () => simulateDrop(watch.id) }, 'Test drop')
      : null,
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Edit target for ${name}`, title: 'Edit target', onclick: () => openDialog(watch) }, icon('edit')),
    el('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': `${watch.paused ? 'Resume' : 'Pause'} ${name}`,
      title: watch.paused ? 'Resume' : 'Pause',
      onclick: () => togglePause(watch),
    }, icon(watch.paused ? 'play' : 'pause')),
    removing
      ? el('button', { class: 'text-action is-danger', type: 'button', onclick: () => removeWatch(watch.id) }, 'Remove?')
      : el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${name}`, title: 'Remove', onclick: () => askRemove(watch.id) }, icon('trash')),
  );

  const row = el('li', { class: `watch is-${status.key}` },
    el('div', { class: 'who' },
      el('strong', { title: name }, name),
      el('span', {}, `${watch.cardVersion}, ${platformLabel(watch.platform)}`)),
    sparkline(watch),
    el('div', { class: 'prices' },
      el('b', {}, watch.currentPrice === null ? '–' : coins.format(watch.currentPrice)),
      el('span', {}, `Target ${coins.format(watch.targetPrice)}`)),
    el('span', { class: `gap ${status.key}` }, status.label),
    actions,
  );
  row.dataset.id = watch.id;
  row.dataset.signature = signature;
  return row;
}

function renderWatches() {
  const list = $('#watchList');
  const existing = new Map([...list.children].map((node) => [Number(node.dataset.id), node]));
  const nodes = state.watches.map((watch) => {
    const { lastChecked, ...visible } = watch;
    const signature = JSON.stringify([visible, confirmRemoveId === watch.id]);
    const current = existing.get(watch.id);
    if (current?.dataset.signature === signature) return current;
    const fresh = watchRow(watch, signature);
    if (current) current.replaceWith(fresh);
    return fresh;
  });

  let cursor = list.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }

  const used = state.watches.length;
  $('#watchEmpty').hidden = used > 0;
  $('#listHead').hidden = used === 0;
  $('#slots').textContent = `${used} of ${state.limit} players`;
  $('#slotFill').style.width = `${(used / state.limit) * 100}%`;
  const full = used >= state.limit;
  $('#addButton').disabled = full;
  $('#addButton').title = full ? `You can watch up to ${state.limit} players` : '';
}

function renderAlerts() {
  const items = state.alerts.map((alert) => el('li', { class: `alert${alert.read ? '' : ' is-unread'}` },
    el('strong', { title: alert.playerName }, alert.playerName),
    el('b', {}, coins.format(alert.price)),
    el('span', {}, `${alert.cardVersion}, ${platformLabel(alert.platform)}. Target ${coins.format(alert.targetPrice)}`),
    el('time', { datetime: new Date(alert.createdAt).toISOString() }, timeAgo(alert.createdAt)),
  ));
  $('#alertList').replaceChildren(...items);
  $('#alertsEmpty').hidden = items.length > 0;
  $('#markRead').hidden = state.unread === 0;
  const badge = $('#tabBadge');
  badge.hidden = state.unread === 0;
  badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
}

function renderMeta() {
  const when = state.lastRun?.at;
  $('#lastChecked').textContent = when ? `Checked ${timeAgo(when)}` : '';
}

function applyState(next) {
  const newest = next.alerts[0]?.id ?? 0;
  if (lastAlertId !== null && newest > lastAlertId) {
    const alert = next.alerts[0];
    toast(`${alert.playerName} dropped to ${coins.format(alert.price)}`);
  }
  lastAlertId = newest;
  state = next;
  renderWatches();
  renderAlerts();
  renderMeta();
  if (document.body.dataset.view === 'alerts' && state.unread > 0 && isCompact()) markRead();
}

const isCompact = () => matchMedia('(max-width: 860px)').matches;

async function recoverAccount(rejectedToken) {
  try {
    if (token === rejectedToken) {
      await createAccount();
      toast('That link was not recognized, so a new watchlist was started.');
    }
    applyState(await api('/api/state'));
  } catch (error) {
    toast(error.message);
  }
}

async function loadState() {
  const usedToken = token;
  const seenMutations = mutations;
  try {
    const next = await api('/api/state');
    // Drop a poll that started before a change, so it cannot undo that change on screen.
    if (seenMutations === mutations && usedToken === token) applyState(next);
  } catch (error) {
    if (error.status === 401) await recoverAccount(usedToken);
    else if (error.status === 0) $('#lastChecked').textContent = 'Offline';
  }
}

function refresh() {
  refreshing ??= loadState().finally(() => { refreshing = null; });
  return refreshing;
}

async function markRead() {
  await act(async () => applyState((await api('/api/alerts/read', { method: 'POST' })).state));
}

async function simulateDrop(id) {
  await act(async () => applyState((await api(`/api/watches/${id}/simulate-drop`, { method: 'POST' })).state));
}

async function togglePause(watch) {
  await act(async () => {
    const result = await api(`/api/watches/${watch.id}`, { method: 'PATCH', body: { paused: !watch.paused } });
    applyState(result.state);
  });
}

function askRemove(id) {
  confirmRemoveId = id;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    confirmRemoveId = null;
    renderWatches();
  }, 3500);
  renderWatches();
}

async function removeWatch(id) {
  clearTimeout(confirmTimer);
  confirmRemoveId = null;
  await act(async () => applyState((await api(`/api/watches/${id}`, { method: 'DELETE' })).state));
}

function updateTargetHint() {
  const raw = $('#fieldTarget').value;
  const value = parseCoins(raw);
  $('#targetHint').textContent = !raw.trim()
    ? 'Try 125k, 1.2m or 45,000.'
    : value === null ? 'Enter a whole coin amount.' : `Alert when under ${coins.format(value)} coins.`;
}

function setSearchHint(message) {
  const hint = $('#searchHint');
  hint.textContent = message;
  hint.hidden = !message;
}

function renderCardResults(cards) {
  searchResults = cards;
  const platform = $('#watchForm').elements.platform.value;
  const items = cards.map((card) => {
    const price = card.prices[platform];
    const details = [card.position, card.version, card.club].filter(Boolean).join(', ');
    return el('li', {},
      el('button', { class: 'card-result', type: 'button', onclick: () => chooseCard(card) },
        el('b', {}, card.rating === null ? '–' : String(card.rating)),
        el('span', {}, el('strong', {}, card.name), el('small', {}, details)),
        el('em', {}, price === null ? '–' : coins.format(price))));
  });
  $('#cardResults').replaceChildren(...items);
  $('#cardResults').hidden = items.length === 0;
}

function chooseCard(card) {
  $('#fieldName').value = card.name;
  $('#fieldVersion').value = card.version;
  $('#fieldRef').value = card.ref;
  renderCardResults([]);
  const rated = [card.rating, card.position].filter(Boolean).join(' ');
  setSearchHint(`Selected: ${[card.name, rated, card.version, card.club].filter(Boolean).join(', ')}`);
  $('#formError').hidden = true;
  $('#fieldTarget').focus();
}

const searchCopy = () => cfg.provider.search ?? {
  label: 'Search player',
  placeholder: 'Type a player name',
  hint: '',
  empty: 'No cards found.',
};

async function runCardSearch(query, sequence) {
  try {
    const { cards } = await api(`/api/cards/search?q=${encodeURIComponent(query)}`);
    if (sequence !== searchSequence) return;
    renderCardResults(cards);
    setSearchHint(cards.length ? '' : searchCopy().empty);
  } catch (error) {
    if (sequence === searchSequence) setSearchHint(error.message);
  }
}

function onNameInput() {
  if (!cfg.provider.canSearch || editingId !== null) return;
  $('#fieldRef').value = '';
  $('#fieldVersion').value = '';
  clearTimeout(searchTimer);
  searchSequence += 1;
  const sequence = searchSequence;
  const query = $('#fieldName').value.trim();
  if (query.length < 2) {
    renderCardResults([]);
    setSearchHint(searchCopy().hint);
    return;
  }
  setSearchHint('Searching');
  searchTimer = setTimeout(() => runCardSearch(query.slice(0, 200), sequence), 350);
}

function openDialog(watch = null) {
  if (!watch && state.watches.length >= state.limit) {
    toast(`You can watch up to ${state.limit} players.`);
    return;
  }
  editingId = watch?.id ?? null;
  const form = $('#watchForm');
  form.reset();
  clearTimeout(searchTimer);
  searchSequence += 1;
  renderCardResults([]);
  const searching = cfg.provider.canSearch && !watch;
  const copy = searchCopy();
  setSearchHint(searching ? copy.hint : '');
  $('#formError').hidden = true;
  $('#dialogTitle').textContent = watch ? 'Edit target' : 'Add player';
  $('#formSubmit').textContent = watch ? 'Save target' : 'Start watching';
  $('#refField').hidden = !cfg.provider.requiresRef || cfg.provider.canSearch;
  $('#versionField').hidden = searching;
  $('#nameLabel').textContent = searching ? copy.label : 'Player name';
  $('#fieldName').placeholder = searching ? copy.placeholder : 'Player name';

  for (const field of [$('#fieldName'), $('#fieldVersion'), $('#fieldRef')]) field.disabled = Boolean(watch);
  const platforms = cfg.provider.platforms;
  $('#platformHint').hidden = Boolean(watch) || platforms.includes('pc');
  for (const radio of form.elements.platform) {
    radio.disabled = Boolean(watch) || !platforms.includes(radio.value);
    radio.checked = watch ? radio.value === watch.platform : radio.value === platforms[0];
  }
  if (watch) {
    $('#fieldName').value = watch.playerName;
    $('#fieldVersion').value = watch.cardVersion;
    $('#fieldRef').value = watch.sourceRef;
    $('#fieldTarget').value = String(watch.targetPrice);
  }
  updateTargetHint();
  $('#watchDialog').showModal();
  (watch ? $('#fieldTarget') : $('#fieldName')).focus();
}

async function submitForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorNode = $('#formError');
  const showError = (message) => {
    errorNode.textContent = message;
    errorNode.hidden = false;
  };

  const targetPrice = parseCoins($('#fieldTarget').value);
  if (targetPrice === null) return showError('Enter a target price, like 125k.');
  if (editingId === null && $('#fieldName').value.trim().length < 2) return showError('Enter a player name.');
  if (editingId === null && cfg.provider.canSearch && !$('#fieldRef').value) {
    return showError('Choose a card from the search results.');
  }

  const submit = $('#formSubmit');
  submit.disabled = true;
  try {
    const result = editingId === null
      ? await api('/api/watches', {
        method: 'POST',
        body: {
          playerName: $('#fieldName').value,
          cardVersion: $('#fieldVersion').value,
          sourceRef: $('#fieldRef').value,
          platform: form.elements.platform.value,
          targetPrice,
        },
      })
      : await api(`/api/watches/${editingId}`, { method: 'PATCH', body: { targetPrice } });
    $('#watchDialog').close();
    applyState(result.state);
  } catch (error) {
    showError(error.message);
  } finally {
    submit.disabled = false;
  }
  return undefined;
}

function setView(view) {
  document.body.dataset.view = view;
  for (const tab of document.querySelectorAll('[data-tab]')) {
    if (tab.dataset.tab === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (view === 'alerts' && state?.unread > 0 && isCompact()) markRead();
  window.scrollTo({ top: 0 });
}

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function currentSubscription() {
  if (!swRegistration || !pushSupported()) return null;
  return swRegistration.pushManager.getSubscription();
}

async function renderPush() {
  const text = $('#pushText');
  const enable = $('#pushEnable');
  const test = $('#pushTest');
  const disable = $('#pushDisable');
  enable.hidden = true;
  test.hidden = true;
  disable.hidden = true;

  if (!window.isSecureContext) {
    text.textContent = 'Notifications need an HTTPS address on this device.';
  } else if (isIOS() && !isInstalled()) {
    text.textContent = 'On iPhone, tap Share, choose Add to Home Screen, then open Undercut from there.';
  } else if (!pushSupported()) {
    text.textContent = 'This browser does not support push notifications.';
  } else if (!swRegistration) {
    text.textContent = 'Notifications could not start in this browser.';
  } else if (Notification.permission === 'denied') {
    text.textContent = 'Notifications are blocked. Allow them for this site in your browser settings.';
  } else if (Notification.permission === 'granted' && await currentSubscription()) {
    text.textContent = 'On for this device. You will be alerted even when the app is closed.';
    test.hidden = false;
    disable.hidden = false;
  } else {
    text.textContent = 'Turn on alerts for this device.';
    enable.hidden = false;
  }
}

async function enablePush() {
  await act(async () => {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      let subscription = await currentSubscription();
      if (!subscription) {
        subscription = await swRegistration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(cfg.vapidPublicKey),
        });
      }
      await api('/api/push/subscribe', { method: 'POST', body: subscription.toJSON() });
      toast('Notifications are on.');
    }
  });
  await renderPush();
}

async function disablePush() {
  await act(async () => {
    const subscription = await currentSubscription();
    if (subscription) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } });
      await subscription.unsubscribe();
    }
    toast('Notifications are off on this device.');
  });
  await renderPush();
}

async function testPush() {
  await act(async () => {
    const result = await api('/api/push/test', { method: 'POST' });
    toast(result.delivered > 0 ? 'Test notification sent.' : 'The test notification could not be delivered.');
  });
}

async function syncSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) await api('/api/push/subscribe', { method: 'POST', body: subscription.toJSON() }).catch(() => {});
}

async function copyLink() {
  const link = `${location.origin}/#sync=${token}`;
  const output = $('#linkOutput');
  try {
    await navigator.clipboard.writeText(link);
    output.hidden = true;
    toast('Private link copied.');
  } catch {
    output.value = link;
    output.hidden = false;
    output.select();
  }
}

function consumeSyncLink() {
  const match = /^#sync=([\w-]{20,100})$/.exec(location.hash);
  if (!match) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (match[1] === token) return;
  if (!token || window.confirm('Replace the watchlist on this device with the linked one?')) {
    writeToken(match[1]);
  }
}

function renderInstall() {
  const hint = $('#installHint');
  $('#installApp').hidden = !installPrompt || isInstalled();
  hint.hidden = !isIOS() || isInstalled();
  hint.textContent = 'To install on iPhone, tap Share, then Add to Home Screen.';
}

function bindEvents() {
  $('#addButton').addEventListener('click', () => openDialog());
  $('#emptyAdd').addEventListener('click', () => openDialog());
  $('#dialogClose').addEventListener('click', () => $('#watchDialog').close());
  $('#watchDialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $('#watchForm').addEventListener('submit', submitForm);
  $('#fieldTarget').addEventListener('input', updateTargetHint);
  $('#fieldName').addEventListener('input', onNameInput);
  $('#platformField').addEventListener('change', () => renderCardResults(searchResults));
  $('#markRead').addEventListener('click', markRead);
  $('#pushEnable').addEventListener('click', enablePush);
  $('#pushDisable').addEventListener('click', disablePush);
  $('#pushTest').addEventListener('click', testPush);
  $('#copyLink').addEventListener('click', copyLink);
  $('#installApp').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    renderInstall();
  });
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => setView(tab.dataset.tab));
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    renderInstall();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    renderInstall();
  });
}

async function start() {
  bindEvents();
  consumeSyncLink();

  try {
    cfg = await api('/api/config');
    if (!token) await createAccount();
  } catch (error) {
    $('#sourceLabel').textContent = 'Offline';
    toast(error.message);
    return;
  }

  $('#sourceLabel').textContent = cfg.provider.label;
  $('#sourcePill').classList.add(cfg.provider.live ? 'is-live' : 'is-demo');
  $('#demoBanner').hidden = !cfg.provider.notice;
  $('#demoTitle').textContent = cfg.provider.notice?.title ?? '';
  $('#demoText').textContent = cfg.provider.notice?.text ?? '';
  if (cfg.provider.credit) {
    $('#creditLink').textContent = cfg.provider.credit.text;
    $('#creditLink').href = cfg.provider.credit.url;
    $('#credit').hidden = false;
  }

  const requestedView = new URLSearchParams(location.search).get('view');
  await refresh();
  if (['alerts', 'settings'].includes(requestedView)) setView(requestedView);

  if ('serviceWorker' in navigator) {
    try {
      swRegistration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    } catch {
      swRegistration = null;
    }
  }
  await syncSubscription();
  await renderPush();
  renderInstall();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, REFRESH_MS);
}

start();
