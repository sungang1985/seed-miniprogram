const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadPage(name, overrides = {}) {
  let definition;
  const calls = [];
  const wx = Object.assign({
    showToast(options) { calls.push({ method: 'showToast', options }); },
    showModal(options) { calls.push({ method: 'showModal', options }); },
    switchTab(options) { calls.push({ method: 'switchTab', options }); },
    setClipboardData(options) { calls.push({ method: 'setClipboardData', options }); },
    stopPullDownRefresh() { calls.push({ method: 'stopPullDownRefresh' }); }
  }, overrides.wx);
  const modules = {
    '../../services/api': Object.assign({
      getOverview: async () => ({ status: 'ready' }),
      getFeatures: async () => [],
      getProfile: async () => ({ loggedIn: false, user: null }),
      loginDemo: async () => ({ user: { nickname: '体验用户', avatarText: '起' } }),
      logout() {}
    }, overrides.api),
    '../../config': { env: 'develop', mock: true, version: '1.0.0' },
    '../../utils/session': Object.assign({ getSession: () => null }, overrides.session),
    '../../utils/storage': Object.assign({ get: (key, fallback) => fallback, set: () => true, clear: () => true }, overrides.storage),
    '../../services/location-tracker': {
      createTracker() {
        const state = { status: 'idle', segments: [], distanceMeters: 0, durationMs: 0,
          currentSpeedMps: 0, averageSpeedMps: 0, pointCount: 0, currentLocation: null,
          errorMessage: '', errorCode: '', waitingForLocation: false };
        return { snapshot: () => state, start: async () => state, pause: async () => state,
          resume: async () => state, finish: async () => state, destroy: async () => {} };
      }
    }
  };
  const filename = path.join(__dirname, '../miniprogram/pages', name, 'index.js');
  const context = vm.createContext({
    Page(value) { definition = value; },
    require(specifier) {
      assert.ok(Object.hasOwn(modules, specifier), `Unexpected page dependency: ${specifier}`);
      return modules[specifier];
    },
    wx,
    console,
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout: overrides.clearTimeout || clearTimeout
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  assert.ok(definition, `${name} registers a Page definition`);
  const instance = Object.assign({}, definition, {
    data: clone(definition.data),
    setData(patch, callback) {
      Object.entries(patch).forEach(([key, value]) => {
        const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = this.data;
        segments.slice(0, -1).forEach((segment) => { target = target[segment]; });
        target[segments[segments.length - 1]] = value === undefined ? undefined : clone(value);
      });
      if (callback) callback.call(this);
    }
  });
  return { page: instance, calls };
}

test('home recovers from a failed initial request on retry', async () => {
  let shouldFail = true;
  const { page } = loadPage('home', {
    api: {
      getFeatures: async () => {
        if (shouldFail) throw new Error('服务暂时不可用');
        return [{ id: 'storage', title: '本地缓存', description: '恢复后的功能数据' }];
      }
    }
  });

  await page.loadData();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.errorMessage, '服务暂时不可用');

  shouldFail = false;
  await page.loadData();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.errorMessage, '');
  assert.equal(page.data.features[0].title, '本地缓存');
});

test('home request demo blocks duplicate taps and resets loading after failure', async () => {
  let rejectRequest;
  let requestCount = 0;
  const pending = new Promise((resolve, reject) => { rejectRequest = reject; });
  const { page, calls } = loadPage('home', {
    api: { getOverview() { requestCount += 1; return pending; } }
  });

  const first = page.onTestRequest();
  await page.onTestRequest();
  assert.equal(requestCount, 1);
  assert.equal(page.data.requesting, true);
  rejectRequest(new Error('网络连接失败'));
  await first;

  assert.equal(page.data.requesting, false);
  assert.equal(page.data.requestResult, '网络连接失败');
  assert.equal(calls.at(-1).method, 'showToast');
  assert.equal(calls.at(-1).options.icon, 'none');
});

test('home request success gives feedback and opens the components tab', async () => {
  const { page, calls } = loadPage('home');
  await page.onTestRequest();
  assert.match(page.data.requestResult, /请求成功/);
  assert.equal(page.data.requesting, false);
  assert.equal(calls.at(-1).options.icon, 'success');
  page.onOpenComponents();
  assert.equal(calls.at(-1).method, 'switchTab');
  assert.equal(calls.at(-1).options.url, '/pages/components/index');
});

test('home pull-to-refresh stops the native indicator after a request error', async () => {
  const { page, calls } = loadPage('home', {
    api: { getOverview: async () => { throw new Error('刷新失败'); } }
  });
  page.onPullDownRefresh();
  await new Promise(setImmediate);
  assert.equal(page.data.loading, false);
  assert.equal(calls.filter((call) => call.method === 'stopPullDownRefresh').length, 1);
});

test('component loading button prevents duplicate submission and cancels work on unload', () => {
  const scheduled = [];
  const cancelled = [];
  const { page, calls } = loadPage('components', {
    setTimeout(callback) { scheduled.push(callback); return scheduled.length; },
    clearTimeout(id) { cancelled.push(id); }
  });

  page.onPrimaryTap();
  page.onPrimaryTap();
  assert.equal(page.data.submitting, true);
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  assert.equal(page.data.submitting, false);
  assert.equal(calls.at(-1).options.icon, 'success');

  page.onPrimaryTap();
  page.onUnload();
  assert.deepEqual(cancelled, [2]);
});

test('component form validates whitespace and counter obeys its bounds', () => {
  const { page, calls } = loadPage('components');
  page.onNameInput({ detail: { value: '  ' } });
  page.onSubmitName();
  assert.equal(calls.at(-1).options.icon, 'none');
  page.onNameInput({ detail: { value: '  小明  ' } });
  page.onSubmitName();
  assert.equal(page.data.name, '小明');
  assert.match(calls.at(-1).options.title, /小明/);

  page.setData({ count: 0 });
  page.onCountChange({ currentTarget: { dataset: { delta: '-1' } } });
  assert.equal(page.data.count, 0);
  page.onCountChange({ currentTarget: { dataset: { delta: '1' } } });
  assert.equal(page.data.count, 1);
  page.setData({ count: 99 });
  page.onCountChange({ currentTarget: { dataset: { delta: 1 } } });
  page.onCountChange({ currentTarget: { dataset: { delta: 'invalid' } } });
  assert.equal(page.data.count, 99);
});

test('profile shows a cached session immediately and retains it when profile fetch fails', async () => {
  const saved = { user: { id: 'cached-user', nickname: '已登录用户' } };
  const { page } = loadPage('profile', {
    session: { getSession: () => saved },
    api: { getProfile: async () => { throw new Error('资料服务暂时不可用'); } }
  });

  page.onShow();
  assert.equal(page.data.loggedIn, true);
  assert.equal(page.data.user.id, 'cached-user');
  await new Promise(setImmediate);
  assert.equal(page.data.loading, false);
  assert.equal(page.data.profileError, '资料服务暂时不可用');
  assert.equal(page.data.user.id, 'cached-user');
});

test('profile ignores an older response after a newer profile request completes', async () => {
  const resolvers = [];
  const { page } = loadPage('profile', {
    api: { getProfile: () => new Promise((resolve) => resolvers.push(resolve)) }
  });
  const oldRequest = page.loadProfile();
  const newRequest = page.loadProfile();
  resolvers[1]({ loggedIn: true, user: { id: 'latest-user' } });
  await newRequest;
  resolvers[0]({ loggedIn: false, user: null });
  await oldRequest;

  assert.equal(page.data.loggedIn, true);
  assert.equal(page.data.user.id, 'latest-user');
  assert.equal(page.data.loading, false);
});

test('profile prevents duplicate demo login and resets busy state on rejection', async () => {
  let rejectLogin;
  let loginCalls = 0;
  const { page, calls } = loadPage('profile', {
    api: {
      loginDemo() {
        loginCalls += 1;
        return new Promise((resolve, reject) => { rejectLogin = reject; });
      }
    }
  });
  const first = page.onDemoLogin();
  await page.onDemoLogin();
  assert.equal(page.data.loggingIn, true);
  assert.equal(loginCalls, 1);
  rejectLogin(new Error('登录状态保存失败'));
  await first;

  assert.equal(page.data.loggingIn, false);
  assert.equal(page.data.loggedIn, false);
  assert.equal(calls.at(-1).options.title, '登录状态保存失败');
  assert.equal(calls.at(-1).options.icon, 'none');
});

test('a guest profile request started during login cannot overwrite successful login', async () => {
  let resolveLogin;
  let resolveProfile;
  const { page } = loadPage('profile', {
    api: {
      loginDemo: () => new Promise((resolve) => { resolveLogin = resolve; }),
      getProfile: () => new Promise((resolve) => { resolveProfile = resolve; })
    }
  });

  const login = page.onDemoLogin();
  page.onShow();
  resolveLogin({ user: { id: 'new-user', nickname: '体验用户' } });
  await login;
  if (resolveProfile) resolveProfile({ loggedIn: false, user: null });
  await new Promise(setImmediate);

  assert.equal(page.data.loggedIn, true);
  assert.equal(page.data.user.id, 'new-user');
  assert.equal(page.data.loggingIn, false);
});

test('cache clear requires confirmation and clears the displayed session only on success', () => {
  let clears = 0;
  const { page, calls } = loadPage('profile', {
    storage: { clear() { clears += 1; return true; } }
  });
  page.applySession({ user: { id: 'user-1' } });
  page.onClearCache();
  calls.at(-1).options.success({ confirm: false });
  assert.equal(clears, 0);
  assert.equal(page.data.loggedIn, true);

  page.onClearCache();
  calls.at(-1).options.success({ confirm: true });
  assert.equal(clears, 1);
  assert.equal(page.data.loggedIn, false);
  assert.equal(page.data.user, null);
  assert.equal(calls.at(-1).options.icon, 'success');
});

test('failed persistent cache clear keeps the visible session and shows failure feedback', () => {
  const { page, calls } = loadPage('profile', { storage: { clear: () => false } });
  page.applySession({ user: { id: 'user-1' } });
  page.onClearCache();
  calls.at(-1).options.success({ confirm: true });

  assert.equal(page.data.loggedIn, true);
  assert.equal(page.data.user.id, 'user-1');
  assert.equal(calls.at(-1).options.icon, 'none');
  assert.match(calls.at(-1).options.title, /失败/);
});

test('cache clear cannot race an in-flight demo login', async () => {
  let resolveLogin;
  let clears = 0;
  const { page, calls } = loadPage('profile', {
    api: { loginDemo: () => new Promise((resolve) => { resolveLogin = resolve; }) },
    storage: { clear() { clears += 1; return true; } }
  });
  const login = page.onDemoLogin();
  page.onClearCache();
  const modal = calls.find((call) => call.method === 'showModal');
  if (modal) modal.options.success({ confirm: true });
  assert.equal(clears, 0);
  resolveLogin({ user: { id: 'user-1' } });
  await login;
  assert.equal(page.data.loggedIn, true);
});

test('logout failure does not falsely report the session as cleared', () => {
  const { page, calls } = loadPage('profile', { api: { logout: () => false } });
  page.applySession({ user: { id: 'user-1' } });
  page.onLogout();
  assert.equal(page.data.loggedIn, true);
  assert.equal(page.data.user.id, 'user-1');
  assert.match(calls.at(-1).options.title, /退出失败/);
});

test('a pending profile response cannot restore a user after successful logout', async () => {
  let resolveProfile;
  const { page } = loadPage('profile', {
    api: {
      getProfile: () => new Promise((resolve) => { resolveProfile = resolve; }),
      logout: () => true
    }
  });
  page.applySession({ user: { id: 'user-1' } });
  const pending = page.loadProfile();
  page.onLogout();
  resolveProfile({ loggedIn: true, user: { id: 'user-1' } });
  await pending;
  assert.equal(page.data.loggedIn, false);
  assert.equal(page.data.user, null);
  assert.equal(page.data.loading, false);
});
