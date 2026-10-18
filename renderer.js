'use strict';

(async () => {
  // ------------------------------------------------------------ constants
  const SECOND_LEVEL = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp',
    'com.br', 'co.in', 'com.cn', 'com.mx', 'co.za', 'com.tr', 'com.sg', 'co.kr',
  ]);
  function regDomain(host) {
    const p = host.split('.');
    if (p.length <= 2) return host;
    if (SECOND_LEVEL.has(p.slice(-2).join('.'))) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  }

  const ENGINES = {
    'DuckDuckGo': { tpl: 'https://duckduckgo.com/?q={}', letter: 'D', color: '#de5833' },
    'Brave Search': { tpl: 'https://search.brave.com/search?q={}', letter: 'B', color: '#fb542b' },
    'Startpage': { tpl: 'https://www.startpage.com/sp/search?query={}', letter: 'S', color: '#6a7bff' },
    'Mojeek': { tpl: 'https://www.mojeek.com/search?q={}', letter: 'm', color: '#7ac143' },
    'Ecosia': { tpl: 'https://www.ecosia.org/search?q={}', letter: 'E', color: '#36acb4' },
    'Qwant': { tpl: 'https://www.qwant.com/?q={}', letter: 'Q', color: '#5c97ff' },
    'Google': { tpl: 'https://www.google.com/search?q={}', letter: 'G', color: '#4c8bf5' },
  };
  const GROUP_COLORS = [
    ['Grey', '#9aa0a6'], ['Blue', '#4c8bf5'], ['Red', '#e5534b'], ['Yellow', '#f2c94c'],
    ['Green', '#4caf50'], ['Pink', '#e86aa6'], ['Purple', '#a56cf0'], ['Cyan', '#3cc7d6'],
    ['Orange', '#f2994a'],
  ];
  const DEFAULT_SHORTCUTS = [
    { title: 'YouTube', url: 'https://www.youtube.com' },
    { title: 'Wikipedia', url: 'https://www.wikipedia.org' },
    { title: 'GitHub', url: 'https://github.com' },
    { title: 'Claude', url: 'https://claude.ai' },
  ];
  const DEFAULT_BOOKMARKS = [
    { title: 'DuckDuckGo', url: 'https://duckduckgo.com' },
    { title: 'Roblox', children: [
      { title: 'Roblox', url: 'https://www.roblox.com' },
      { title: 'Creator Hub', url: 'https://create.roblox.com' },
    ] },
    { title: 'Development Of Games', children: [
      { title: 'Godot', url: 'https://godotengine.org' },
      { title: 'itch.io', url: 'https://itch.io' },
    ] },
    { title: 'AI', children: [{ title: 'Claude', url: 'https://claude.ai' }] },
  ];

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ------------------------------------------------------------ storage
  async function loadArray(name, def) {
    const v = await pb.storeGet(name);
    return Array.isArray(v) ? v : def;
  }
  const settings = Object.assign(
    { engine: 'DuckDuckGo', allowSites: [], zoom: {}, dark: false },
    (await pb.storeGet('settings')) || {},
  );
  if (!ENGINES[settings.engine]) settings.engine = 'DuckDuckGo';
  let bookmarks = await loadArray('bookmarks', DEFAULT_BOOKMARKS);
  let shortcuts = await loadArray('shortcuts', DEFAULT_SHORTCUTS);
  const paths = await pb.paths();
  const saveSettings = () => pb.storeSet('settings', settings);
  const saveBookmarks = () => pb.storeSet('bookmarks', bookmarks);
  const saveShortcuts = () => pb.storeSet('shortcuts', shortcuts);
  pb.setAllow(settings.allowSites);
  pb.setDark(settings.dark);

  // ------------------------------------------------------------ state
  let tabs = [];
  const groups = new Map();
  let nextTabId = 1;
  let nextGroupId = 1;
  let activeId = null;
  let mru = [];
  let justAdded = null;
  let frozenWidth = null;
  let dragId = null;
  const closed = [];
  let blockedCount = 0;
  let genericCssText = '';
  let statusTimer = null;

  const tabById = (id) => tabs.find((t) => t.id === id);
  const idx = (id) => tabs.findIndex((t) => t.id === id);
  const activeTab = () => tabById(activeId);
  const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; } };
  const siteOf = (url) => regDomain(hostOf(url));
  const isNewtabUrl = (u) => u.startsWith(paths.newtab);
  const siteOff = (url) => !!url && settings.allowSites.includes(siteOf(url));

  function status(msg, ms = 4000) {
    $('#status').textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('#status').textContent = ''; }, ms);
  }

  // ------------------------------------------------------------ modal form
  function askForm(title, fields, okText = 'OK') {
    return new Promise((resolve) => {
      document.body.classList.add('modal');
      const back = el('div', 'modal-back');
      const box = el('div', 'modal-box');
      box.appendChild(el('h3', null, title));
      const inputs = {};
      for (const f of fields) {
        const label = el('label', null, f.label);
        const input = el('input');
        input.value = f.value || '';
        input.spellcheck = false;
        inputs[f.name] = input;
        label.appendChild(input);
        box.appendChild(label);
      }
      const row = el('div', 'modal-row');
      const cancel = el('button', null, 'Cancel');
      const ok = el('button', 'primary', okText);
      row.appendChild(cancel);
      row.appendChild(ok);
      box.appendChild(row);
      back.appendChild(box);
      document.body.appendChild(back);
      const close = (val) => { back.remove(); document.body.classList.remove('modal'); resolve(val); };
      cancel.onclick = () => close(null);
      ok.onclick = () => {
        const out = {};
        for (const k of Object.keys(inputs)) out[k] = inputs[k].value.trim();
        close(out);
      };
      back.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') ok.click();
        else if (e.key === 'Escape') cancel.click();
      });
      const first = inputs[fields[0].name];
      first.focus();
      first.select();
    });
  }

  // ------------------------------------------------------------ new tab page
  function makeNewtabUrl() {
    const data = { engine: settings.engine, tpl: ENGINES[settings.engine].tpl, shortcuts };
    return paths.newtab + '#' + encodeURIComponent(JSON.stringify(data));
  }
  function refreshNewtabs() {
    for (const t of tabs) if (t.newtab) loadInTab(t, makeNewtabUrl());
  }
  function loadInTab(tab, url) {
    if (tab.ready) {
      tab.wv.loadURL(url).catch(() => {});
    } else {
      tab.wv.setAttribute('src', url);
    }
  }

  async function handleAction(tab, a) {
    if (a.a === 'add' || a.a === 'edit') {
      const cur = a.a === 'edit' && shortcuts[a.i] ? shortcuts[a.i] : { title: '', url: 'https://' };
      const v = await askForm(a.a === 'add' ? 'Add shortcut' : 'Edit shortcut', [
        { name: 'title', label: 'Name', value: cur.title },
        { name: 'url', label: 'URL', value: cur.url },
      ], 'Save');
      if (!v || !v.title || !v.url) return;
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(v.url) ? v.url : 'https://' + v.url;
      const item = { title: v.title.slice(0, 24), url };
      if (a.a === 'edit' && shortcuts[a.i]) shortcuts[a.i] = item; else shortcuts.push(item);
      saveShortcuts();
      refreshNewtabs();
    } else if (a.a === 'remove') {
      if (shortcuts[a.i]) { shortcuts.splice(a.i, 1); saveShortcuts(); refreshNewtabs(); }
    } else if (a.a === 'allow-http') {
      const host = hostOf(a.url);
      if (host) { pb.allowHttp(host); loadInTab(tab, a.url); }
    }
  }

  // ------------------------------------------------------------ tabs: creation
  function createTab(o = {}) {
    const tab = {
      id: nextTabId++, wv: null, title: 'New Tab', url: o.url || '', favicon: '',
      groupId: o.groupId && groups.has(o.groupId) ? o.groupId : null,
      pinned: !!o.pinned, openerId: o.openerId == null ? null : o.openerId,
      loading: false, newtab: !!o.newtab, contentsId: null, ready: false, closing: false, zoom: 1,
    };
    const wv = document.createElement('webview');
    wv.setAttribute('partition', paths.partition);
    wv.className = 'hidden';
    $('#views').appendChild(wv);
    tab.wv = wv;
    attachEvents(tab);
    wv.setAttribute('src', tab.newtab ? makeNewtabUrl() : (o.url || 'about:blank'));

    let at = o.index;
    if (at == null) {
      const opener = tab.openerId != null ? tabById(tab.openerId) : null;
      if (opener) {
        at = idx(opener.id) + 1;
        while (at < tabs.length && tabs[at].openerId === opener.id) at++;
        if (opener.groupId && tab.groupId == null) tab.groupId = opener.groupId;
      } else {
        at = tabs.length;
      }
    }
    if (!tab.pinned) at = Math.max(at, tabs.filter((x) => x.pinned).length);
    tabs.splice(at, 0, tab);
    justAdded = tab.id;
    if (o.background) renderTabs();
    else {
      activate(tab.id);
      if (tab.newtab) focusUrl();
    }
    return tab;
  }

  function attachEvents(tab) {
    const wv = tab.wv;
    wv.addEventListener('dom-ready', () => {
      tab.ready = true;
      try { tab.contentsId = wv.getWebContentsId(); } catch (e) { /* ignore */ }
      applyZoom(tab);
      applyCosmetic(tab);
      if (tab.id === activeId) syncChrome();
    });
    wv.addEventListener('page-title-updated', (e) => {
      tab.title = e.title || tab.title;
      renderTabs();
      if (tab.id === activeId) syncChrome();
    });
    wv.addEventListener('did-navigate', (e) => onNav(tab, e.url));
    wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNav(tab, e.url); });
    wv.addEventListener('page-favicon-updated', (e) => {
      tab.favicon = (e.favicons && e.favicons[0]) || '';
      renderTabs();
    });
    wv.addEventListener('did-start-loading', () => { tab.loading = true; renderTabs(); });
    wv.addEventListener('did-stop-loading', () => { tab.loading = false; renderTabs(); if (tab.id === activeId) syncChrome(); });
    wv.addEventListener('enter-html-full-screen', () => setFs(true));
    wv.addEventListener('leave-html-full-screen', () => setFs(false));
    wv.addEventListener('console-message', (e) => {
      if (e.message && e.message.startsWith('PBACT:')) {
        try { handleAction(tab, JSON.parse(e.message.slice(6))); } catch (err) { /* ignore */ }
      }
    });
    wv.addEventListener('found-in-page', (e) => {
      if (tab.id !== activeId) return;
      const r = e.result;
      $('#find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : '0/0';
    });
  }

  function onNav(tab, url) {
    tab.newtab = isNewtabUrl(url);
    tab.url = tab.newtab || url.startsWith('data:') ? '' : url;
    if (tab.newtab) { tab.title = 'New Tab'; tab.favicon = ''; }
    if (tab.ready) applyZoom(tab);
    renderTabs();
    if (tab.id === activeId) syncChrome();
  }

  // ------------------------------------------------------------ cosmetic filtering
  const scratch = new CSSStyleSheet();
  function validSel(s) {
    try { scratch.insertRule(s + '{}', 0); scratch.deleteRule(0); return true; } catch (e) { return false; }
  }
  async function buildGeneric() {
    const list = await pb.genericCss();
    const ok = list.filter(validSel);
    let css = '';
    for (let i = 0; i < ok.length; i += 50) css += ok.slice(i, i + 50).join(',') + '{display:none!important}\n';
    genericCssText = css;
  }
  async function applyCosmetic(tab) {
    if (tab.newtab || !tab.url.startsWith('http') || siteOff(tab.url)) return;
    let css = genericCssText;
    try {
      const specific = await pb.siteCss(hostOf(tab.url));
      for (const s of specific) if (validSel(s)) css += s + '{display:none!important}\n';
      if (css) await tab.wv.insertCSS(css);
    } catch (e) { /* page may have navigated */ }
  }

  // ------------------------------------------------------------ zoom
  function applyZoom(tab) {
    const f = tab.newtab || !tab.url ? 1 : (settings.zoom[siteOf(tab.url)] || 1);
    tab.zoom = f;
    try { tab.wv.setZoomFactor(f); } catch (e) { /* not ready */ }
  }
  function zoomBy(delta) {
    const t = activeTab();
    if (!t || !t.ready) return;
    const f = delta === null ? 1 : Math.min(5, Math.max(0.25, Math.round((t.zoom + delta) * 100) / 100));
    t.zoom = f;
    try { t.wv.setZoomFactor(f); } catch (e) { return; }
    if (!t.newtab && t.url) {
      const k = siteOf(t.url);
      if (Math.abs(f - 1) < 0.01) delete settings.zoom[k]; else settings.zoom[k] = f;
      saveSettings();
    }
    status('Zoom ' + Math.round(f * 100) + '%', 2000);
  }

  // ------------------------------------------------------------ tabs: activate / close
  function activate(id) {
    const t = tabById(id);
    if (!t) return;
    const g = t.groupId ? groups.get(t.groupId) : null;
    if (g && g.collapsed) g.collapsed = false;
    activeId = id;
    mru = [id, ...mru.filter((x) => x !== id)];
    for (const x of tabs) x.wv.classList.toggle('hidden', x.id !== id);
    closeFind();
    renderTabs();
    syncChrome(true);
    try { t.wv.focus(); } catch (e) { /* ignore */ }
  }

  function pickNext(removedIndex) {
    const visible = (x) => !x.closing && !(x.groupId && groups.get(x.groupId) && groups.get(x.groupId).collapsed);
    for (const id of mru) {
      const x = tabById(id);
      if (x && visible(x)) return id;       // Opera-style: back to the tab you were on before
    }
    const cands = tabs.filter(visible);
    if (cands.length) return cands[Math.min(removedIndex, cands.length - 1)].id;
    return tabs[Math.min(removedIndex, tabs.length - 1)].id;
  }

  function closeTab(id, opts = {}) {
    const t = tabById(id);
    if (!t || t.closing) return;
    if (tabs.filter((x) => !x.closing).length <= 1) { window.close(); return; }
    t.closing = true;
    if (!t.newtab && t.url) {
      closed.push({ url: t.url, groupId: t.groupId, pinned: t.pinned });
      if (closed.length > 20) closed.shift();
    }
    const node = tabNode(id);
    if (opts.fromClick && node && !t.pinned) frozenWidth = node.offsetWidth;
    if (node) node.classList.add('closing');
    setTimeout(() => finishClose(id), 130);
  }

  function finishClose(id) {
    const i = idx(id);
    if (i < 0) return;
    const t = tabs[i];
    const wasActive = activeId === id;
    tabs.splice(i, 1);
    mru = mru.filter((x) => x !== id);
    t.wv.remove();
    pruneGroups();
    if (wasActive) activate(pickNext(i)); else renderTabs();
  }

  function reopenTab() {
    const c = closed.pop();
    if (!c) { status('No recently closed tabs'); return; }
    createTab({ url: c.url, groupId: c.groupId, pinned: c.pinned });
  }

  function moveTab(t, finalIndex) {
    tabs = tabs.filter((x) => x !== t);
    tabs.splice(finalIndex, 0, t);
  }

  function togglePin(t) {
    t.pinned = !t.pinned;
    const pinnedOthers = tabs.filter((x) => x.pinned && x !== t).length;
    moveTab(t, pinnedOthers);
    renderTabs();
  }

  // ------------------------------------------------------------ tab groups
  function pruneGroups() {
    const used = new Set(tabs.map((t) => t.groupId));
    for (const gid of Array.from(groups.keys())) if (!used.has(gid)) groups.delete(gid);
  }
  async function newGroupFor(t) {
    const v = await askForm('New group', [{ name: 'name', label: 'Group name' }], 'Create');
    if (!v) return;
    const gid = nextGroupId++;
    groups.set(gid, { name: v.name, color: GROUP_COLORS[(gid - 1) % GROUP_COLORS.length][1], collapsed: false });
    t.groupId = gid;
    renderTabs();
  }
  function placeAfterGroup(t, gid) {
    const others = tabs.filter((x) => x.groupId === gid && x !== t);
    if (!others.length) return;
    const last = Math.max(...others.map((x) => idx(x.id)));
    const old = idx(t.id);
    moveTab(t, old > last ? last + 1 : last);
  }
  function addToGroup(t, gid) {
    t.groupId = gid;
    placeAfterGroup(t, gid);
    pruneGroups();
    renderTabs();
  }
  function removeFromGroup(t) {
    const gid = t.groupId;
    t.groupId = null;
    placeAfterGroup(t, gid);
    pruneGroups();
    renderTabs();
  }
  async function renameGroup(gid) {
    const g = groups.get(gid);
    if (!g) return;
    const v = await askForm('Rename group', [{ name: 'name', label: 'Group name', value: g.name }], 'Save');
    if (v) { g.name = v.name; renderTabs(); }
  }
  function toggleCollapse(gid) {
    const g = groups.get(gid);
    if (!g) return;
    g.collapsed = !g.collapsed;
    const a = activeTab();
    if (g.collapsed && a && a.groupId === gid) {
      const other = tabs.find((x) => x.groupId !== gid);
      if (other) { activate(other.id); return; }
      g.collapsed = false;
    }
    renderTabs();
  }
  function ungroupAll(gid) {
    for (const t of tabs) if (t.groupId === gid) t.groupId = null;
    pruneGroups();
    renderTabs();
  }
  function closeGroup(gid) {
    for (const t of tabs.filter((x) => x.groupId === gid)) closeTab(t.id);
  }

  const colorItems = () => GROUP_COLORS.map(([n, hex]) => ({ label: n, id: 'color:' + hex }));

  function tabMenuItems(t) {
    const items = [
      { label: 'New tab to the right', id: 'right' },
      { label: 'Reload', id: 'reload' },
      { label: 'Duplicate', id: 'dup' },
      { label: t.pinned ? 'Unpin tab' : 'Pin tab', id: 'pin' },
      { separator: true },
    ];
    if (!t.groupId) {
      items.push({ label: 'Add tab to new group', id: 'newgroup' });
      if (groups.size) {
        items.push({
          label: 'Add tab to group',
          submenu: Array.from(groups.entries()).map(([gid, g]) => ({ label: g.name || 'Unnamed group', id: 'addgroup:' + gid })),
        });
      }
    } else {
      const others = Array.from(groups.entries()).filter(([gid]) => gid !== t.groupId);
      if (others.length) {
        items.push({
          label: 'Move to another group',
          submenu: others.map(([gid, g]) => ({ label: g.name || 'Unnamed group', id: 'addgroup:' + gid })),
        });
      }
      items.push({ label: 'Remove from group', id: 'ungroup1' });
      items.push({ separator: true });
      items.push({ label: 'Rename group…', id: 'rename' });
      items.push({ label: 'Change group color', submenu: colorItems() });
      items.push({ label: 'Ungroup all tabs in group', id: 'ungroupall' });
      items.push({ label: 'Close group', id: 'closegroup' });
    }
    items.push({ separator: true });
    items.push({ label: 'Close tab', id: 'close' });
    items.push({ label: 'Close other tabs', id: 'closeothers' });
    items.push({ label: 'Close tabs to the right', id: 'closeright' });
    items.push({ separator: true });
    items.push({ label: 'Reopen closed tab', id: 'reopen', enabled: closed.length > 0 });
    return items;
  }

  async function onTabMenu(t, id) {
    if (!id) return;
    if (id === 'right') createTab({ newtab: true, index: idx(t.id) + 1 });
    else if (id === 'reload') { try { t.wv.reload(); } catch (e) { /* ignore */ } }
    else if (id === 'dup') createTab({ url: t.newtab ? null : t.url, newtab: t.newtab, index: idx(t.id) + 1, groupId: t.groupId });
    else if (id === 'pin') togglePin(t);
    else if (id === 'newgroup') await newGroupFor(t);
    else if (id.startsWith('addgroup:')) addToGroup(t, Number(id.slice(9)));
    else if (id === 'ungroup1') removeFromGroup(t);
    else if (id === 'rename') await renameGroup(t.groupId);
    else if (id.startsWith('color:')) { const g = groups.get(t.groupId); if (g) { g.color = id.slice(6); renderTabs(); } }
    else if (id === 'ungroupall') ungroupAll(t.groupId);
    else if (id === 'closegroup') closeGroup(t.groupId);
    else if (id === 'close') closeTab(t.id);
    else if (id === 'closeothers') tabs.filter((x) => x !== t).forEach((x) => closeTab(x.id));
    else if (id === 'closeright') tabs.slice(idx(t.id) + 1).forEach((x) => closeTab(x.id));
    else if (id === 'reopen') reopenTab();
  }

  async function onGroupMenu(gid, id) {
    const g = groups.get(gid);
    if (!g || !id) return;
    if (id === 'rename') await renameGroup(gid);
    else if (id === 'collapse') toggleCollapse(gid);
    else if (id.startsWith('color:')) { g.color = id.slice(6); renderTabs(); }
    else if (id === 'ungroupall') ungroupAll(gid);
    else if (id === 'closegroup') closeGroup(gid);
  }

  // ------------------------------------------------------------ tab strip rendering
  const tabNode = (id) => document.querySelector(`.tab[data-id="${id}"]`);

  function chipEl(gid, g) {
    const c = el('div', 'chip' + (g.name ? '' : ' dot'), g.name || '');
    c.style.background = g.color;
    c.title = g.collapsed ? 'Click to expand group' : 'Click to collapse group';
    c.onclick = () => toggleCollapse(gid);
    c.oncontextmenu = async (ev) => {
      ev.preventDefault();
      const id = await pb.menu([
        { label: g.collapsed ? 'Expand group' : 'Collapse group', id: 'collapse' },
        { label: 'Rename group…', id: 'rename' },
        { label: 'Change group color', submenu: colorItems() },
        { label: 'Ungroup all tabs', id: 'ungroupall' },
        { label: 'Close group', id: 'closegroup' },
      ]);
      onGroupMenu(gid, id);
    };
    return c;
  }

  function tabEl(t, g) {
    const e = el('div', 'tab');
    e.dataset.id = t.id;
    e.draggable = true;
    if (t.id === activeId) e.classList.add('active');
    if (t.pinned) e.classList.add('pinned');
    if (t.loading) e.classList.add('loading');
    if (t.closing) e.classList.add('closing');
    if (t.id === justAdded) e.classList.add('enter');
    if (g) { e.classList.add('grouped'); e.style.setProperty('--gc', g.color); }
    if (frozenWidth && !t.pinned) e.style.flex = `0 0 ${frozenWidth}px`;

    const label = t.title || 'New Tab';
    if (t.favicon) {
      const img = el('img', 'fav');
      img.referrerPolicy = 'no-referrer';
      img.src = t.favicon;
      img.onerror = () => { t.favicon = ''; renderTabs(); };
      e.appendChild(img);
    } else {
      e.appendChild(el('span', 'letter', (label.trim()[0] || '•').toUpperCase()));
    }
    e.appendChild(el('span', 'title', label));
    const x = el('button', 'x', '\u2715');
    x.title = 'Close tab';
    x.onclick = (ev) => { ev.stopPropagation(); closeTab(t.id, { fromClick: true }); };
    e.appendChild(x);
    e.title = label;

    e.onclick = () => activate(t.id);
    e.onmousedown = (ev) => { if (ev.button === 1) ev.preventDefault(); };
    e.onauxclick = (ev) => { if (ev.button === 1) closeTab(t.id, { fromClick: true }); };
    e.oncontextmenu = async (ev) => {
      ev.preventDefault();
      onTabMenu(t, await pb.menu(tabMenuItems(t)));
    };
    e.ondragstart = (ev) => {
      dragId = t.id;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(t.id));
    };
    e.ondragover = (ev) => { if (dragId != null) ev.preventDefault(); };
    e.ondrop = (ev) => {
      ev.preventDefault();
      const dragged = tabById(dragId);
      dragId = null;
      if (!dragged || dragged === t || dragged.pinned !== t.pinned) return;
      const r = e.getBoundingClientRect();
      const after = ev.clientX > r.left + r.width / 2;
      tabs = tabs.filter((y) => y !== dragged);
      tabs.splice(idx(t.id) + (after ? 1 : 0), 0, dragged);
      renderTabs();
    };
    e.ondragend = () => { dragId = null; };
    return e;
  }

  function renderTabs() {
    const strip = $('#tabs');
    strip.textContent = '';
    let prevGroup = null;
    for (const t of tabs) {
      const g = t.groupId ? groups.get(t.groupId) : null;
      if (g && t.groupId !== prevGroup) strip.appendChild(chipEl(t.groupId, g));
      prevGroup = t.groupId || null;
      if (g && g.collapsed) continue;
      strip.appendChild(tabEl(t, g));
    }
    justAdded = null;
  }

  $('#tabstrip').addEventListener('mouseleave', () => {
    if (frozenWidth) { frozenWidth = null; renderTabs(); }
  });
  $('#strip-space').addEventListener('dblclick', () => createTab({ newtab: true }));
  $('#newtab-btn').onclick = () => createTab({ newtab: true });

  // ------------------------------------------------------------ address bar / navigation
  function toUrl(text) {
    text = text.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(text)) return 'http://' + text;
    if (!/\s/.test(text) && text.includes('.')) return 'https://' + text;
    return ENGINES[settings.engine].tpl.replace('{}', encodeURIComponent(text));
  }
  function navigateTo(text) {
    const t = activeTab();
    if (!t) return;
    t.newtab = false;
    loadInTab(t, toUrl(text));
    try { t.wv.focus(); } catch (e) { /* ignore */ }
  }
  function focusUrl() {
    const u = $('#url');
    u.focus();
    u.select();
  }
  $('#url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = $('#url').value; if (v.trim()) navigateTo(v); }
    else if (e.key === 'Escape') { syncChrome(true); try { activeTab().wv.focus(); } catch (err) { /* ignore */ } }
  });
  $('#url').addEventListener('focus', () => $('#url').select());

  function goBack() { const t = activeTab(); if (t && t.ready) { try { t.wv.goBack(); } catch (e) { t.wv.executeJavaScript('history.back()'); } } }
  function goForward() { const t = activeTab(); if (t && t.ready) { try { t.wv.goForward(); } catch (e) { t.wv.executeJavaScript('history.forward()'); } } }
  function reload() { const t = activeTab(); if (t && t.ready) { try { t.wv.reload(); } catch (e) { /* ignore */ } } }
  $('#back').onclick = goBack;
  $('#fwd').onclick = goForward;
  $('#reload').onclick = reload;

  // ------------------------------------------------------------ chrome sync
  function syncChrome(force) {
    const t = activeTab();
    const u = $('#url');
    if (force || document.activeElement !== u) u.value = t && !t.newtab ? t.url : '';
    const starred = !!t && !t.newtab && !!t.url && isBookmarked(t.url);
    $('#star').textContent = starred ? '\u2605' : '\u2606';
    $('#star').classList.toggle('on', starred);
    document.title = (t ? t.title : 'PrivBrowse') + ' - PrivBrowse';
    updateShield();
  }
  function updateShield() {
    const t = activeTab();
    const off = !!t && !t.newtab && siteOff(t.url);
    const s = $('#shield');
    s.textContent = off ? '\u{1F6E1} off' : `\u{1F6E1} ${blockedCount.toLocaleString()}`;
    s.classList.toggle('off', off);
    s.title = off
      ? 'Blocking is OFF for this site. Click to turn it back on.'
      : 'Blocked this session. Click to turn blocking off for this site (use if a site is broken).';
  }
  function toggleSiteBlocking() {
    const t = activeTab();
    if (!t || t.newtab || !t.url) return;
    const key = siteOf(t.url);
    const i = settings.allowSites.indexOf(key);
    if (i >= 0) { settings.allowSites.splice(i, 1); status(`Blocking back ON for ${key}`); }
    else { settings.allowSites.push(key); status(`Blocking OFF for ${key} (click the shield again to turn it back on)`, 6000); }
    saveSettings();
    pb.setAllow(settings.allowSites);
    reload();
    updateShield();
  }
  $('#shield').onclick = toggleSiteBlocking;

  // ------------------------------------------------------------ search engine
  function updateEngineUi() {
    const e = ENGINES[settings.engine];
    const b = $('#engine-btn');
    b.textContent = e.letter + ' \u25BE';
    b.style.color = e.color;
    $('#url').placeholder = `Search with ${settings.engine} or enter address`;
  }
  $('#engine-btn').onclick = async () => {
    const id = await pb.menu(Object.keys(ENGINES).map((n) => ({
      label: `${ENGINES[n].letter}    ${n}`, id: n, radio: true, checked: n === settings.engine,
    })));
    if (id && ENGINES[id]) { settings.engine = id; saveSettings(); updateEngineUi(); refreshNewtabs(); }
  };

  // ------------------------------------------------------------ bookmarks
  const norm = (u) => (u || '').replace(/\/$/, '');
  function allLinks() {
    const out = [];
    for (const b of bookmarks) { if (b.children) out.push(...b.children); else if (b.url) out.push(b); }
    return out;
  }
  const isBookmarked = (url) => allLinks().some((b) => norm(b.url) === norm(url));
  function removeBookmarkUrl(url) {
    const n = norm(url);
    bookmarks = bookmarks.filter((b) => b.children || norm(b.url) !== n);
    for (const b of bookmarks) if (b.children) b.children = b.children.filter((c) => norm(c.url) !== n);
  }
  function toggleBookmark() {
    const t = activeTab();
    if (!t || t.newtab || !t.url) return;
    if (isBookmarked(t.url)) { removeBookmarkUrl(t.url); status('Bookmark removed'); }
    else { bookmarks.push({ title: (t.title || hostOf(t.url)).slice(0, 28), url: t.url }); status('Bookmarked: ' + t.title); }
    saveBookmarks();
    renderBookmarks();
    syncChrome();
  }
  $('#star').onclick = toggleBookmark;

  function renderBookmarks() {
    const bar = $('#bmbar');
    bar.textContent = '';
    bookmarks.forEach((b, i) => {
      if (!b || !b.title) return;
      const btn = el('button', null, (b.children ? '\u{1F4C1} ' : '\u{1F310} ') + b.title);
      btn.onclick = async () => {
        if (b.children) onFolderChoice(i, await pb.menu(folderMenu(b)));
        else navigateTo(b.url);
      };
      btn.oncontextmenu = async (ev) => {
        ev.preventDefault();
        onBookmarkChoice(i, await pb.menu(bookmarkMenu(b)));
      };
      bar.appendChild(btn);
    });
  }
  function folderMenu(b) {
    const kids = b.children || [];
    const items = kids.length
      ? kids.map((c, j) => ({ label: c.title, id: 'open:' + j }))
      : [{ label: '(empty)', enabled: false }];
    items.push({ separator: true });
    if (kids.length) items.push({ label: 'Remove bookmark', submenu: kids.map((c, j) => ({ label: c.title, id: 'rm:' + j })) });
    items.push({ label: 'Rename folder…', id: 'rename' });
    items.push({ label: 'Delete folder', id: 'delete' });
    return items;
  }
  async function onFolderChoice(i, id) {
    const b = bookmarks[i];
    if (!b || !id) return;
    if (id.startsWith('open:')) navigateTo(b.children[Number(id.slice(5))].url);
    else if (id.startsWith('rm:')) { b.children.splice(Number(id.slice(3)), 1); saveBookmarks(); renderBookmarks(); syncChrome(); }
    else if (id === 'rename') await renameBookmark(i);
    else if (id === 'delete') { bookmarks.splice(i, 1); saveBookmarks(); renderBookmarks(); syncChrome(); }
  }
  function bookmarkMenu(b) {
    if (b.children) return [{ label: 'Rename folder…', id: 'rename' }, { label: 'Delete folder', id: 'delete' }];
    const folders = bookmarks.map((f, fi) => ({ f, fi })).filter((x) => x.f.children);
    const items = [{ label: 'Open in new tab', id: 'newtab' }, { label: 'Rename…', id: 'rename' }];
    if (folders.length) items.push({ label: 'Move to folder', submenu: folders.map((x) => ({ label: x.f.title, id: 'move:' + x.fi })) });
    items.push({ label: 'Remove', id: 'remove' });
    return items;
  }
  async function renameBookmark(i) {
    const b = bookmarks[i];
    const v = await askForm('Rename', [{ name: 'title', label: 'Name', value: b.title }], 'Save');
    if (v && v.title) { b.title = v.title; saveBookmarks(); renderBookmarks(); }
  }
  async function onBookmarkChoice(i, id) {
    const b = bookmarks[i];
    if (!b || !id) return;
    if (id === 'newtab') createTab({ url: b.url });
    else if (id === 'rename') await renameBookmark(i);
    else if (id === 'delete' || id === 'remove') { bookmarks.splice(i, 1); saveBookmarks(); renderBookmarks(); syncChrome(); }
    else if (id.startsWith('move:')) {
      const folder = bookmarks[Number(id.slice(5))];
      bookmarks.splice(i, 1);
      if (folder) folder.children.push(b);
      saveBookmarks();
      renderBookmarks();
    }
  }
  async function newFolder() {
    const v = await askForm('New bookmark folder', [{ name: 'title', label: 'Folder name' }], 'Create');
    if (v && v.title) { bookmarks.push({ title: v.title, children: [] }); saveBookmarks(); renderBookmarks(); }
  }

  // ------------------------------------------------------------ find in page
  function openFind() {
    if (!activeTab()) return;
    $('#findbar').hidden = false;
    const i = $('#find-input');
    i.focus();
    i.select();
    if (i.value) doFind(true, true);
  }
  function doFind(forward, fresh) {
    const t = activeTab();
    const text = $('#find-input').value;
    if (!t || !t.ready) return;
    try {
      if (!text) { t.wv.stopFindInPage('clearSelection'); $('#find-count').textContent = ''; return; }
      t.wv.findInPage(text, fresh ? {} : { findNext: true, forward });
    } catch (e) { /* ignore */ }
  }
  function closeFind() {
    if ($('#findbar').hidden) return;
    $('#findbar').hidden = true;
    const t = activeTab();
    try { if (t && t.ready) { t.wv.stopFindInPage('clearSelection'); t.wv.focus(); } } catch (e) { /* ignore */ }
  }
  $('#find-input').addEventListener('input', () => doFind(true, true));
  $('#find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doFind(!e.shiftKey, false);
    else if (e.key === 'Escape') closeFind();
  });
  $('#find-next').onclick = () => doFind(true, false);
  $('#find-prev').onclick = () => doFind(false, false);
  $('#find-close').onclick = closeFind;

  // ------------------------------------------------------------ downloads
  const dls = new Map();
  const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';
  function renderDownloads() {
    const shelf = $('#dlshelf');
    shelf.textContent = '';
    for (const d of Array.from(dls.values()).reverse()) {
      const row = el('div', 'dl');
      row.appendChild(el('span', 'name', d.name));
      let st = '';
      if (d.state === 'completed') st = 'Done';
      else if (d.state === 'progressing' || d.state === 'interrupted') {
        st = d.total > 0 ? `${Math.round((d.received / d.total) * 100)}%  (${fmtMB(d.received)} / ${fmtMB(d.total)})` : fmtMB(d.received);
      } else st = 'Failed';
      row.appendChild(el('span', 'state', st));
      if (d.state === 'completed') {
        const o = el('button', null, 'Open'); o.onclick = () => pb.openPath(d.path); row.appendChild(o);
        const f = el('button', null, 'Show in folder'); f.onclick = () => pb.showPath(d.path); row.appendChild(f);
      } else if (d.state === 'progressing') {
        const c = el('button', null, 'Cancel'); c.onclick = () => pb.cancelDownload(d.id); row.appendChild(c);
      }
      const x = el('button', null, '\u2715');
      x.onclick = () => { dls.delete(d.id); renderDownloads(); if (!dls.size) shelf.hidden = true; };
      row.appendChild(x);
      shelf.appendChild(row);
    }
  }
  function toggleShelf() {
    const shelf = $('#dlshelf');
    if (!dls.size) { status('No downloads yet'); return; }
    shelf.hidden = !shelf.hidden;
  }
  $('#dl-btn').onclick = toggleShelf;

  // ------------------------------------------------------------ fullscreen
  function setFs(on) {
    document.body.classList.toggle('fs', !!on);
    pb.setFullscreen(!!on);
  }

  // ------------------------------------------------------------ main menu
  $('#menu-btn').onclick = async () => {
    const t = activeTab();
    const off = !!t && !t.newtab && siteOff(t.url);
    const id = await pb.menu([
      { label: 'New tab', id: 'newtab' },
      { label: 'Reopen closed tab', id: 'reopen', enabled: closed.length > 0 },
      { separator: true },
      { label: 'Bookmark this page', id: 'bookmark' },
      { label: 'New bookmark folder…', id: 'newfolder' },
      { separator: true },
      { label: 'Find in page', id: 'find' },
      { label: 'Zoom in', id: 'zin' },
      { label: 'Zoom out', id: 'zout' },
      { label: 'Reset zoom', id: 'zreset' },
      { label: 'Downloads', id: 'downloads' },
      { separator: true },
      { label: off ? 'Turn blocking ON for this site' : 'Turn blocking OFF for this site', id: 'site' },
      { label: 'Update filter lists', id: 'update' },
      { label: 'Reset blocked counter', id: 'reset' },
      { label: 'Dark mode for web pages', id: 'dark', checkbox: true, checked: settings.dark },
      { label: 'Remember logins & cookies (restart needed)', id: 'remember', checkbox: true, checked: settings.remember === true },
      { label: 'Clear cookies & site data…', id: 'cleardata' },
      { separator: true },
      { label: 'Developer tools (F12)', id: 'devtools' },
      { label: 'Quit', id: 'quit' },
    ]);
    runCommand(id);
  };

  function openDevtools() { const t = activeTab(); if (t && t.ready) { try { t.wv.openDevTools(); } catch (e) { /* ignore */ } } }

  async function clearSiteData() {
    if (!window.confirm('Sign out of all sites and delete all cookies and site data?')) return;
    await pb.clearData();
    status('Cookies and site data cleared');
    reload();
  }

  function runCommand(id) {
    switch (id) {
      case 'newtab': case 'new-tab': createTab({ newtab: true }); break;
      case 'close-tab': closeTab(activeId, { fromClick: false }); break;
      case 'reopen': case 'reopen-tab': reopenTab(); break;
      case 'bookmark': toggleBookmark(); break;
      case 'newfolder': newFolder(); break;
      case 'find': openFind(); break;
      case 'zin': case 'zoom-in': zoomBy(0.1); break;
      case 'zout': case 'zoom-out': zoomBy(-0.1); break;
      case 'zreset': case 'zoom-reset': zoomBy(null); break;
      case 'downloads': toggleShelf(); break;
      case 'site': toggleSiteBlocking(); break;
      case 'update': case 'update-filters': pb.updateFilters(); break;
      case 'reset': pb.resetBlocked(); blockedCount = 0; updateShield(); break;
      case 'dark': settings.dark = !settings.dark; saveSettings(); pb.setDark(settings.dark); break;
      case 'remember': settings.remember = !settings.remember; saveSettings(); pb.relaunchPrompt(); break;
      case 'cleardata': clearSiteData(); break;
      case 'devtools': openDevtools(); break;
      case 'quit': window.close(); break;
      case 'focus-url': focusUrl(); break;
      case 'reload': reload(); break;
      case 'back': goBack(); break;
      case 'forward': goForward(); break;
      case 'fullscreen': setFs(!document.body.classList.contains('fs')); break;
      case 'next-tab': case 'prev-tab': {
        const vis = tabs.filter((x) => !x.closing && !(x.groupId && groups.get(x.groupId) && groups.get(x.groupId).collapsed));
        if (vis.length < 2) break;
        const i = vis.findIndex((x) => x.id === activeId);
        const step = id === 'next-tab' ? 1 : -1;
        activate(vis[(i + step + vis.length) % vis.length].id);
        break;
      }
      default: break;
    }
  }

  // ------------------------------------------------------------ messages from the main process
  pb.on('shortcut', runCommand);
  pb.on('open-tab', (d) => {
    if (!/^https?:\/\//i.test(d.url) && d.url !== 'about:blank') return;
    const opener = tabs.find((x) => x.contentsId === d.from);
    createTab({ url: d.url, openerId: opener ? opener.id : null, background: !!d.background });
  });
  pb.on('stats', (d) => { blockedCount = d.blocked; updateShield(); });
  pb.on('filters-status', (d) => { $('#filters').textContent = 'Filters: ' + d.text; });
  pb.on('filters-ready', async (d) => {
    await buildGeneric();
    let text = `Filters: ${d.count.toLocaleString()} rules`;
    if (d.failed && d.failed.length) text += ` (couldn't download: ${d.failed.join(', ')})`;
    $('#filters').textContent = text;
  });
  pb.on('dl', (d) => {
    dls.set(d.id, d);
    renderDownloads();
    $('#dlshelf').hidden = false;
    if (d.state === 'completed') status('Downloaded ' + d.name + ' (Downloads folder)', 6000);
  });
  pb.on('https-failed', (d) => {
    const t = tabs.find((x) => x.contentsId === d.contentsId);
    if (!t) return;
    const host = hostOf(d.url).replace(/[<>&"]/g, '');
    const html = '<!doctype html><meta charset="utf-8"><title>Connection not secure</title>'
      + '<style>body{background:#2b2a33;color:#fbfbfe;font-family:Segoe UI,sans-serif;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}button{margin:6px;padding:9px 16px;'
      + 'border:none;border-radius:8px;background:#42414d;color:#fff;font-size:14px;cursor:pointer}p{max-width:520px;color:#cfcfd8}</style>'
      + '<h1>This site doesn\'t support a secure connection</h1>'
      + `<p>PrivBrowse tried to open <b>${host}</b> over HTTPS, but it didn't work. You can continue over plain HTTP, `
      + 'but anything you send could be read by others on the network.</p>'
      + '<div><button onclick="history.back()">Go back</button><button id="c">Continue (not secure)</button></div>'
      + `<script>document.getElementById('c').onclick=function(){console.log('PBACT:'+JSON.stringify({a:'allow-http',url:${JSON.stringify(d.url)}}))}<\/script>`;
    loadInTab(t, 'data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });

  // ------------------------------------------------------------ start
  updateEngineUi();
  renderBookmarks();
  createTab({ newtab: true });
})();
