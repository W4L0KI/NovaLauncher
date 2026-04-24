const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nova', {
  scanGames: () => ipcRenderer.invoke('games:scan'),
  launchGame: (game) => ipcRenderer.invoke('games:launch', game),
  openFolder: (folder) => ipcRenderer.invoke('games:open-folder', folder),
  chooseDir: () => ipcRenderer.invoke('games:choose-dir'),
  toggleFavorite: (id) => ipcRenderer.invoke('games:toggle-favorite', id),
  setCover: (id) => ipcRenderer.invoke('games:set-cover', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSteamGridDbKey: (apiKey) => ipcRenderer.invoke('settings:set-sgdb-key', apiKey),
  toggleAutoCovers: () => ipcRenderer.invoke('settings:toggle-auto-covers'),
  refreshCover: (game) => ipcRenderer.invoke('covers:refresh-one', game)
});
