// Bridge for the shell's own pages (the connection screen). The Mike web app
// itself gets no privileged APIs: it must behave identically in a browser.
// Every channel is gated main-side to the shell's own bundled pages.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mikeDesktop", {
  getServerUrl: () => ipcRenderer.invoke("mike:get-server-url"),
  setServerUrl: (url) => ipcRenderer.invoke("mike:set-server-url", url),
  retry: () => ipcRenderer.invoke("mike:retry"),
  openConnect: () => ipcRenderer.invoke("mike:open-connect"),
});
