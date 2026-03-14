/// <reference types="vitest/globals" />
/**
 * Global test setup for GMGN Signal Bot Chrome Extension
 *
 * Provides Chrome Extension API mocks (chrome.storage, chrome.runtime,
 * chrome.alarms, chrome.tabs) required by extension-specific test modules.
 * This file is executed before each test file via vitest.config.ts setupFiles.
 */

// Chrome storage mock — in-memory key-value store
const createStorageArea = () => {
  let store: Record<string, unknown> = {};
  return {
    get: vi.fn((keys?: string | string[] | Record<string, unknown> | null) => {
      if (keys === null || keys === undefined) {
        return Promise.resolve({ ...store });
      }
      if (typeof keys === 'string') {
        return Promise.resolve({ [keys]: store[keys] });
      }
      if (Array.isArray(keys)) {
        const result: Record<string, unknown> = {};
        for (const key of keys) {
          if (key in store) result[key] = store[key];
        }
        return Promise.resolve(result);
      }
      // keys is a Record with defaults
      const result: Record<string, unknown> = { ...keys };
      for (const [k, v] of Object.entries(store)) {
        result[k] = v;
      }
      return Promise.resolve(result);
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      Object.assign(store, items);
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      for (const key of keyArr) {
        delete store[key];
      }
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      store = {};
      return Promise.resolve();
    }),
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(() => false),
    },
  };
};

// Chrome runtime mock
const runtimeMock = {
  id: 'test-extension-id',
  sendMessage: vi.fn(() => Promise.resolve()),
  onMessage: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false),
  },
  onInstalled: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false),
  },
  getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
  getManifest: vi.fn(() => ({
    manifest_version: 3,
    name: 'GMGN Signal Bot',
    version: '1.0.0',
  })),
};

// Chrome alarms mock
const alarmsMock = {
  create: vi.fn(() => Promise.resolve()),
  get: vi.fn(() => Promise.resolve(undefined)),
  getAll: vi.fn(() => Promise.resolve([])),
  clear: vi.fn(() => Promise.resolve(true)),
  clearAll: vi.fn(() => Promise.resolve(true)),
  onAlarm: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false),
  },
};

// Chrome tabs mock
const tabsMock = {
  query: vi.fn(() => Promise.resolve([])),
  sendMessage: vi.fn(() => Promise.resolve()),
  onUpdated: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
    hasListener: vi.fn(() => false),
  },
};

// Assemble global chrome mock object
const chromeMock = {
  storage: {
    local: createStorageArea(),
    sync: createStorageArea(),
    session: createStorageArea(),
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(() => false),
    },
  },
  runtime: runtimeMock,
  alarms: alarmsMock,
  tabs: tabsMock,
};

// Assign to globalThis so all tests can access `chrome.*`
Object.defineProperty(globalThis, 'chrome', {
  value: chromeMock,
  writable: true,
  configurable: true,
});
