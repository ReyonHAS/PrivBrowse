'use strict';
const {
  app, BrowserWindow, Menu, session, ipcMain, shell, webContents, nativeTheme, net, clipboard, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { FilterEngine, regDomain, hostSuffixes } = require('./filterengine');

let PARTITION = 'privbrowse'; // in-memory by default; becomes 'persist:privbrowse' if the user chooses to remember cookies
const REFRESH_MS = 3 * 24 * 3600 * 1000;
const LISTS = [
  ['easylist', 'https://easylist.to/easylist/easylist.txt'],
  ['easyprivacy', 'https://easylist.to/easylist/easyprivacy.txt'],
  ['ublock-filters', 'https://ublockorigin.github.io/uAssets/filters/filters.txt'],
];

// Tiny always-on domain list, active even before the big lists finish loading.
const BUILTIN = new Set([
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'adservice.google.com', 'facebook.net',
  'ads-twitter.com', 'scorecardresearch.com', 'quantserve.com', 'outbrain.com', 'taboola.com',
  'criteo.com', 'criteo.net', 'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net',
  'casalemedia.com', 'adsrvr.org', 'amazon-adsystem.com', 'moatads.com', 'hotjar.com',
  'mixpanel.com', 'fullstory.com', 'mouseflow.com', 'crazyegg.com', 'clarity.ms', 'demdex.net',
  'krxd.net', 'bluekai.com', 'adform.net',
]);
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const TYPE = {
  subFrame: 'subdocument', stylesheet: 'stylesheet', script: 'script', image: 'image',
  font: 'font', object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'ping',
  media: 'media', webSocket: 'websocket',
};
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

let win = null;
let ses = null;
let engine = null;
let blocked = 0;
let allowSites = new Set();
const httpOk = new Set();
const upgraded = new Map();
let userDomains = new Set();
const downloads = new Map();
let dlCounter = 0;

const dataDir = () => app.getPath('userData');
function readJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), name + '.json'), 'utf8')); } catch (e) { return null; }
}
function writeJson(name, data) {
  try { fs.writeFileSync(path.join(dataDir(), name + '.json'), JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ }
}
function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}
function topUrl(details) {
  try {
    if (details.webContentsId != null) {
      const wc = webContents.fromId(details.webContentsId);
      if (wc) return wc.getURL();
    }
  } catch (e) { /* ignore */ }
  return details.referrer || '';
}

// ---------------------------------------------------------------- filters
async function loadFilters(force) {
  send('filters-status', { text: force ? 'updating…' : 'loading…' });
  const dir = path.join(dataDir(), 'filters');
  fs.mkdirSync(dir, { recursive: true });
  const eng = new FilterEngine();
  const failed = [];
  for (const [name, url] of LISTS) {
    const file = path.join(dir, name + '.txt');
    let stale = force || !fs.existsSync(file);
    if (!stale) stale = Date.now() - fs.statSync(file).mtimeMs > REFRESH_MS;
    if (stale) {
      try {
        const res = await net.fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        fs.writeFileSync(file + '.tmp', text);
        fs.renameSync(file + '.tmp', file);
      } catch (e) { failed.push(name); }
    }
    if (fs.existsSync(file)) {
      await eng.loadLinesAsync(fs.readFileSync(file, 'utf8').split(/\r?\n/));
    }
  }
  // optional user rules: blocklist.txt in the data folder (domains, hosts lines or ABP rules)
  const userFile = path.join(dataDir(), 'blocklist.txt');
  const domains = new Set();
  if (fs.existsSync(userFile)) {
    const abp = [];
    for (const raw of fs.readFileSync(userFile, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^(!|\[|\|\||@@|\/|\|)/.test(line) || line.includes('##') || line.includes('$')) { abp.push(line); continue; }
      const host = line.split('#')[0].trim().toLowerCase().split(/\s+/).pop();
      if (host && !['localhost', '0.0.0.0', '127.0.0.1'].includes(host)) domains.add(host);
    }
    await eng.loadLinesAsync(abp);
  }
  userDomains = domains;
  eng.finalize();
  engine = eng;
  send('filters-ready', { count: eng.ruleCount, failed });
}

// ---------------------------------------------------------------- session
function setupSession() {
  ses = session.fromPartition(PARTITION);
  ses.setUserAgent(
    ses.getUserAgent().replace(/\s*Electron\/\S+/, '').replace(/\s*privbrowse\/\S+/i, ''),
  );

  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      let u;
      try { u = new URL(details.url); } catch (e) { callback({}); return; }
      const host = u.hostname.toLowerCase();
      const isMain = details.resourceType === 'mainFrame';
      const fpHost = isMain ? host : (hostOf(topUrl(details)) || host);
      const exempt = allowSites.size > 0 && allowSites.has(regDomain(fpHost));

      if (!exempt) {
        if (!isMain && host) {
          for (const s of hostSuffixes(host)) {
            if (BUILTIN.has(s) || userDomains.has(s)) { blocked++; callback({ cancel: true }); return; }
          }
          if (engine) {
            const third = regDomain(fpHost) !== regDomain(host);
            const kind = TYPE[details.resourceType] || 'other';
            if (engine.shouldBlock(details.url, host, kind, third, fpHost)) {
              blocked++;
              callback({ cancel: true });
              return;
            }
          }
        }
        if (u.protocol === 'http:' && !LOCAL.has(host) && !httpOk.has(host)) {
          if (isMain) upgraded.set(host, Date.now());
          u.protocol = 'https:';
          callback({ redirectURL: u.toString() });
          return;
        }
      }
      callback({});
    },
  );

  const isThirdParty = (details) => {
    if (details.resourceType === 'mainFrame') return false;
    const fpHost = hostOf(topUrl(details));
    const host = hostOf(details.url);
    if (!fpHost || !host) return false;
    if (allowSites.has(regDomain(fpHost))) return false;
    return regDomain(fpHost) !== regDomain(host);
  };

  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const h = details.requestHeaders;
    h['Sec-GPC'] = '1';
    h.DNT = '1';
    if (isThirdParty(details)) {
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'cookie') delete h[k];
    }
    callback({ requestHeaders: h });
  });

  ses.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const h = details.responseHeaders || {};
    if (isThirdParty(details)) {
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'set-cookie') delete h[k];
    }
    callback({ responseHeaders: h });
  });

  ses.setPermissionRequestHandler((wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  ses.on('will-download', (event, item) => {
    const dir = app.getPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    const orig = item.getFilename() || 'download';
    const ext = path.extname(orig);
    const base = path.basename(orig, ext);
    let name = orig;
    let n = 1;
    while (fs.existsSync(path.join(dir, name))) name = `${base} (${n++})${ext}`;
    const full = path.join(dir, name);
    item.setSavePath(full);
    const id = ++dlCounter;
    downloads.set(id, item);
    const report = (state) => send('dl', {
      id, name, path: full, state, received: item.getReceivedBytes(), total: item.getTotalBytes(),
    });
    report('progressing');
    item.on('updated', (_e, state) => report(state));
    item.once('done', (_e, state) => report(state));
  });
}

// ---------------------------------------------------------------- shortcuts
const SHORTCUTS = {
  'Ctrl+t': 'new-tab', 'Ctrl+w': 'close-tab', 'Ctrl+l': 'focus-url', 'Ctrl+r': 'reload',
  F5: 'reload', 'Ctrl+d': 'bookmark', 'Ctrl+f': 'find', 'Ctrl+=': 'zoom-in', 'Ctrl++': 'zoom-in',
  'Ctrl+-': 'zoom-out', 'Ctrl+0': 'zoom-reset', F11: 'fullscreen', F12: 'devtools',
  'Ctrl+Shift+i': 'devtools', 'Ctrl+Shift+t': 'reopen-tab', 'Ctrl+Tab': 'next-tab',
  'Ctrl+Shift+Tab': 'prev-tab', 'Alt+ArrowLeft': 'back', 'Alt+ArrowRight': 'forward',
  'Ctrl+j': 'downloads', 'Ctrl+Shift+u': 'update-filters',
};
function comboOf(input) {
  let key = input.key;
  if (key.length === 1) key = key.toLowerCase();
  const parts = [];
  if (input.control || input.meta) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift && key !== '+') parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

function toTemplate(items, done) {
  return items.map((it) => {
    if (it.separator) return { type: 'separator' };
    const o = { label: it.label, enabled: it.enabled !== false };
    if (it.submenu) {
      o.submenu = toTemplate(it.submenu, done);
    } else {
      if (it.radio) { o.type = 'radio'; o.checked = !!it.checked; }
      else if (it.checkbox) { o.type = 'checkbox'; o.checked = !!it.checked; }
      o.click = () => done(it.id);
    }
    return o;
  });
}

function guestContextMenu(contents, params) {
  const t = [];
  const open = (url, background) => send('open-tab', { url, from: contents.id, background });
  if (params.linkURL) {
    t.push({ label: 'Open link in new tab', click: () => open(params.linkURL, false) });
    t.push({ label: 'Open link in background tab', click: () => open(params.linkURL, true) });
    t.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    t.push({ type: 'separator' });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    t.push({ label: 'Open image in new tab', click: () => open(params.srcURL, false) });
    t.push({ label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) });
    t.push({ type: 'separator' });
  }
  if (params.isEditable) {
    t.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
  } else if (params.selectionText) {
    t.push({ role: 'copy' }, { type: 'separator' });
  }
  const hist = contents.navigationHistory;
  t.push({ label: 'Back', enabled: hist ? hist.canGoBack() : true, click: () => (hist ? hist.goBack() : contents.goBack()) });
  t.push({ label: 'Forward', enabled: hist ? hist.canGoForward() : true, click: () => (hist ? hist.goForward() : contents.goForward()) });
  t.push({ label: 'Reload', click: () => contents.reload() });
  t.push({ type: 'separator' });
  t.push({ label: 'Inspect element', click: () => contents.inspectElement(params.x, params.y) });
  Menu.buildFromTemplate(t).popup({ window: win });
}

app.on('web-contents-created', (_e, contents) => {
  const type = contents.getType();
  if (type !== 'webview' && type !== 'window') return;

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const action = SHORTCUTS[comboOf(input)];
    if (!action) return;
    event.preventDefault();
    send('shortcut', action);
  });

  if (type === 'webview') {
    contents.setWindowOpenHandler(({ url, disposition }) => {
      send('open-tab', { url, from: contents.id, background: disposition === 'background-tab' });
      return { action: 'deny' };
    });
    contents.on('context-menu', (_ev, params) => guestContextMenu(contents, params));
    contents.on('did-fail-load', (_ev, code, _desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || !url.startsWith('https://')) return;
      const host = hostOf(url);
      if (upgraded.has(host) && Date.now() - upgraded.get(host) < 60000) {
        send('https-failed', { contentsId: contents.id, url: url.replace(/^https:/, 'http:') });
      }
    });
  }
});

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, backgroundColor: '#1c1b22', title: 'PrivBrowse',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'privbrowse-host', // in-memory too
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    params.partition = PARTITION;
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
}

ipcMain.handle('store:get', (_e, name) => readJson(name));
ipcMain.handle('store:set', (_e, name, data) => { writeJson(name, data); return true; });
ipcMain.handle('app:paths', () => ({
  newtab: pathToFileURL(path.join(__dirname, 'newtab.html')).href,
  partition: PARTITION,
  remember: PARTITION.startsWith('persist:'),
}));
ipcMain.handle('data:clear', async () => {
  if (!ses) return false;
  await ses.clearStorageData();
  await ses.clearCache();
  return true;
});
ipcMain.on('app:relaunch-prompt', async () => {
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
    message: 'Restart PrivBrowse to apply this change?',
  });
  if (r.response === 0) { app.relaunch(); app.exit(0); }
});
ipcMain.handle('site:css', (_e, host) => (engine ? engine.cosmeticFor(host) : []));
ipcMain.handle('filters:generic', () => (engine ? engine.genericCss : []));
ipcMain.handle('menu:popup', (e, items) => new Promise((resolve) => {
  let finished = false;
  const done = (id) => { if (!finished) { finished = true; resolve(id); } };
  const menu = Menu.buildFromTemplate(toTemplate(items, done));
  menu.popup({
    window: BrowserWindow.fromWebContents(e.sender) || win,
    callback: () => setTimeout(() => done(null), 80),
  });
}));
ipcMain.on('window:fullscreen', (_e, on) => { if (win) win.setFullScreen(!!on); });
ipcMain.on('blocking:setAllow', (_e, list) => { allowSites = new Set(list || []); });
ipcMain.on('blocking:allowHttp', (_e, host) => { if (host) httpOk.add(String(host).toLowerCase()); });
ipcMain.on('blocking:reset', () => { blocked = 0; });
ipcMain.on('filters:update', () => { loadFilters(true); });
ipcMain.on('shell:open', (_e, p) => { shell.openPath(p); });
ipcMain.on('shell:show', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.on('dl:cancel', (_e, id) => { const it = downloads.get(id); if (it) it.cancel(); });
ipcMain.on('theme:dark', (_e, on) => { nativeTheme.themeSource = on ? 'dark' : 'system'; });

app.whenReady().then(() => {
  const saved = readJson('settings') || {};
  if (typeof saved.remember !== 'boolean') {
    const r = dialog.showMessageBoxSync({
      type: 'question',
      title: 'PrivBrowse',
      buttons: ['Yes, remember me', 'No, keep it private'],
      defaultId: 0,
      cancelId: 1,
      message: 'Remember logins and cookies?',
      detail: 'Choose YES if you want sites like YouTube to keep you signed in and remember your watch history, recommendations and settings between sessions.\n\nChoose NO to forget everything when you close PrivBrowse (most private).\n\nYou can change this later in the menu.',
    });
    saved.remember = r === 0;
    writeJson('settings', saved);
  }
  PARTITION = saved.remember ? 'persist:privbrowse' : 'privbrowse';
  setupSession();
  createWindow();
  loadFilters(false);
  setInterval(() => send('stats', { blocked }), 700);
});
app.on('window-all-closed', () => app.quit());
