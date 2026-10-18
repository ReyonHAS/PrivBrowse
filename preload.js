'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pb', {
  storeGet: (name) => ipcRenderer.invoke('store:get', name),
  storeSet: (name, data) => ipcRenderer.invoke('store:set', name, data),
  paths: () => ipcRenderer.invoke('app:paths'),
  menu: (items) => ipcRenderer.invoke('menu:popup', items),
  siteCss: (host) => ipcRenderer.invoke('site:css', host),
  genericCss: () => ipcRenderer.invoke('filters:generic'),
  setFullscreen: (on) => ipcRenderer.send('window:fullscreen', !!on),
  setAllow: (list) => ipcRenderer.send('blocking:setAllow', list),
  allowHttp: (host) => ipcRenderer.send('blocking:allowHttp', host),
  resetBlocked: () => ipcRenderer.send('blocking:reset'),
  updateFilters: () => ipcRenderer.send('filters:update'),
  openPath: (p) => ipcRenderer.send('shell:open', p),
  showPath: (p) => ipcRenderer.send('shell:show', p),
  cancelDownload: (id) => ipcRenderer.send('dl:cancel', id),
  setDark: (on) => ipcRenderer.send('theme:dark', !!on),
  clearData: () => ipcRenderer.invoke('data:clear'),
  relaunchPrompt: () => ipcRenderer.send('app:relaunch-prompt'),
  on: (channel, cb) => {
    const allowed = ['shortcut', 'open-tab', 'stats', 'filters-status', 'filters-ready', 'dl', 'https-failed'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});
