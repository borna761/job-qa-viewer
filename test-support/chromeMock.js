// A minimal, hand-written chrome.* mock — not a full chrome-types
// implementation, just the surface background.js/popup.js actually touch.
// Each call to createChromeMock() returns a fresh, independent object, so
// tests never leak state into each other via a shared module-level mock.
//
// Listener collections (onActivated, onUpdated, onInstalled, onStartup,
// onAlarm, onMessage) record every addListener() call and expose a _fire()
// helper so a test can simulate chrome dispatching an event.
function makeEvent() {
  const listeners = [];
  return {
    addListener: fn => listeners.push(fn),
    removeListener: fn => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    _listeners: listeners,
    _fire: (...args) => listeners.map(fn => fn(...args)),
  };
}

// chrome.tabs.get supports both chrome.tabs.get(id) -> Promise and
// chrome.tabs.get(id, cb) -> undefined (callback style) — background.js
// uses both. Mirrors that dual calling convention here.
function callbackOrPromise(fn) {
  return (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const result = fn(...args);
    if (cb) { Promise.resolve(result).then(v => cb(v)); return undefined; }
    return Promise.resolve(result);
  };
}

function createChromeMock(overrides = {}) {
  const storageData = { ...(overrides.storageData || {}) };
  const tabsById = new Map((overrides.tabs || []).map(t => [t.id, t]));

  const chrome = {
    runtime: {
      lastError: undefined,
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      onMessage: makeEvent(),
      // Default: echo {ok: true} back to the callback, as if a listener
      // handled it successfully. Override per test for specific behavior.
      sendMessage: overrides.sendMessage || ((msg, cb) => { if (cb) cb({ ok: true }); }),
    },
    storage: {
      local: {
        get: key => Promise.resolve(key in storageData ? { [key]: storageData[key] } : {}),
        set: obj => { Object.assign(storageData, obj); return Promise.resolve(); },
        _data: storageData,
      },
    },
    tabs: {
      query: overrides.tabsQuery || (() => Promise.resolve(overrides.activeTab ? [overrides.activeTab] : [])),
      get: callbackOrPromise(overrides.tabsGet || (id => tabsById.get(id) || null)),
      update: overrides.tabsUpdate || (() => Promise.resolve()),
      create: overrides.tabsCreate || (opts => Promise.resolve({ id: 999, ...opts })),
      remove: (id, cb) => { tabsById.delete(id); if (cb) cb(); },
      onActivated: makeEvent(),
      onUpdated: makeEvent(),
    },
    windows: {
      update: overrides.windowsUpdate || (() => Promise.resolve()),
    },
    alarms: {
      create: () => {},
      onAlarm: makeEvent(),
    },
    action: {
      setIcon: (opts, cb) => { chrome.action._setIconCalls.push(opts); if (cb) cb(); },
      setTitle: (opts, cb) => { chrome.action._setTitleCalls.push(opts); if (cb) cb(); },
      _setIconCalls: [],
      _setTitleCalls: [],
    },
    scripting: {
      executeScript: overrides.executeScript || (() => Promise.resolve([{ result: null }])),
    },
  };
  return chrome;
}

module.exports = { createChromeMock };
