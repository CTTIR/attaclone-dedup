/* eslint-disable no-undef */
// Bootstrapped extension entry points for Zotero 7.

var chromeHandle;

function log(msg) {
  Zotero.debug("Attaclone-dedup: " + msg);
}

async function startup({ id, version, rootURI }) {
  log("Starting up v" + version);

  // Register chrome (locale + content)
  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["locale", "attaclone-dedup", "en-US", rootURI + "locale/en-US/"],
    ["content", "attaclone-dedup", rootURI + "content/"],
  ]);

  // Load the main module into a sandbox-free scope
  Services.scriptloader.loadSubScript(
    rootURI + "content/attaclone-dedup.js",
    { Zotero, Services, Components, rootURI }
  );

  await Zotero.AttacloneDedup.init({ id, version, rootURI });

  // Register for all already-open windows
  const windows = Zotero.getMainWindows();
  for (const win of windows) {
    Zotero.AttacloneDedup.addToWindow(win);
  }
}

function onMainWindowLoad({ window }) {
  if (Zotero.AttacloneDedup) {
    Zotero.AttacloneDedup.addToWindow(window);
  }
}

function onMainWindowUnload({ window }) {
  if (Zotero.AttacloneDedup) {
    Zotero.AttacloneDedup.removeFromWindow(window);
  }
}

function shutdown() {
  log("Shutting down");
  if (Zotero.AttacloneDedup) {
    const windows = Zotero.getMainWindows();
    for (const win of windows) {
      Zotero.AttacloneDedup.removeFromWindow(win);
    }
    Zotero.AttacloneDedup.shutdown();
    delete Zotero.AttacloneDedup;
  }
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function install() {}
function uninstall() {}
