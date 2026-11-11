const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const config = require('../miniprogram/config/index');
const storage = require('../miniprogram/utils/storage');
const session = require('../miniprogram/utils/session');
const http = require('../miniprogram/services/request');
const api = require('../miniprogram/services/api');
let values;
let requestHandler;
let lastRequest;
const originalConfig = { baseURL: config.baseURL, mock: config.mock };

beforeEach(() => {
  values = new Map();
  config.baseURL = 'https://api.example.test/v1';
  config.mock = true;
  requestHandler = (options) => options.success({ statusCode: 200, data: { code: 0, data: { ok: true } } });
  global.wx = {
    getStorageSync: (key) => values.has(key) ? values.get(key) : '',
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
    getStorageInfoSync: () => ({ keys: Array.from(values.keys()) }),
    request: (options) => {
      lastRequest = options;
      requestHandler(options);
    }
  };
});

after(() => {
  Object.assign(config, originalConfig);
  delete global.wx;
});

function signIn() {
  return session.setSession({ token: 'test-token', user: { id: 'user-1' }, expiresAt: Date.now() + 60000 });
}

test('environment detection selects trial and falls back safely without WeChat', () => {
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/config/index.js'), 'utf8');
  const trial = { module: { exports: {} }, wx: { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }) } };
  vm.runInNewContext(source, trial);
  assert.equal(trial.module.exports.env, 'trial');
  assert.equal(trial.module.exports.mock, true);
  const fallback = { module: { exports: {} } };
  vm.runInNewContext(source, fallback);
  assert.equal(fallback.module.exports.env, 'develop');
});

test('storage preserves falsy values and clears only project-owned keys', () => {
  assert.equal(storage.set('zero', 0), true);
  storage.set('flag', false);
  values.set('another-app:key', 'keep me');
  assert.equal(storage.get('zero'), 0);
  assert.equal(storage.get('flag'), false);
  assert.equal(storage.clear(), true);
  assert.equal(values.size, 1);
  assert.equal(values.get('another-app:key'), 'keep me');
});

test('storage invalidates expired or corrupt entries and survives read failures', () => {
  storage.set('expired', 'secret', 1000);
  values.get(config.storagePrefix + 'expired').expiresAt = Date.now() - 1;
  assert.equal(storage.get('expired', 'fallback'), 'fallback');
  assert.equal(values.has(config.storagePrefix + 'expired'), false);
  values.set(config.storagePrefix + 'broken', '{bad json');
  assert.equal(storage.get('broken'), null);
  assert.equal(values.has(config.storagePrefix + 'broken'), false);
  wx.getStorageSync = () => { throw new Error('disk failure'); };
  assert.equal(storage.get('anything', [] ).length, 0);
});

test('session persists, rejects invalid sessions and removes expired credentials', () => {
  const current = signIn();
  assert.deepEqual(session.getSession(), current);
  assert.equal(session.isLoggedIn(), true);
  assert.throws(() => session.setSession({ token: 'x', user: {} }), TypeError);
  values.get(config.storagePrefix + 'session').value.expiresAt = Date.now() - 1;
  assert.equal(session.getSession(), null);
  assert.equal(values.has(config.storagePrefix + 'session'), false);
});

test('session write failures do not report a successful login', () => {
  wx.setStorageSync = () => { throw new Error('full'); };
  assert.throws(() => signIn(), /无法保存登录状态/);
});

test('request joins URL and forwards token, payload, timeout and custom headers', async () => {
  signIn();
  const result = await http.post('/notes', { title: 'demo' }, { timeout: 1500, header: { 'x-trace': 'one' } });
  assert.deepEqual(result, { ok: true });
  assert.equal(lastRequest.url, 'https://api.example.test/v1/notes');
  assert.equal(lastRequest.method, 'POST');
  assert.deepEqual(lastRequest.data, { title: 'demo' });
  assert.equal(lastRequest.timeout, 1500);
  assert.equal(lastRequest.header.Authorization, 'Bearer test-token');
  assert.equal(lastRequest.header['x-trace'], 'one');
});

test('request preserves caller authorization without adding a duplicate case variant', async () => {
  signIn();
  await http.get('/notes', null, { header: { authorization: 'Custom token' } });
  assert.equal(lastRequest.header.authorization, 'Custom token');
  assert.equal(lastRequest.header.Authorization, undefined);
});

test('absolute third-party requests never receive the saved backend bearer token', async () => {
  signIn();
  await http.get('https://external.example.test/profile');
  assert.equal(lastRequest.header.Authorization, undefined);
  await http.get('https://API.EXAMPLE.TEST:443/v2/profile');
  assert.equal(lastRequest.header.Authorization, 'Bearer test-token');
});

test('corrupted infinite timestamps cannot create permanent sessions or cache entries', () => {
  signIn();
  values.get(config.storagePrefix + 'session').value.expiresAt = Infinity;
  assert.equal(session.getSession(), null);
  storage.set('cache', 'value');
  values.get(config.storagePrefix + 'cache').expiresAt = NaN;
  assert.equal(storage.get('cache'), null);
});

test('synchronous transport failures are normalized', async () => {
  wx.request = () => { throw new Error('transport unavailable'); };
  await assert.rejects(http.get('/profile'), (error) => error instanceof http.RequestError && error.code === 'REQUEST_FAILED');
});

test('request accepts documented success envelopes and raw JSON', async () => {
  for (const response of [{ code: 200, data: 0 }, { code: '0', data: false }, { success: true, data: [] }, ['raw']]) {
    requestHandler = (options) => options.success({ statusCode: 200, data: response });
    const actual = await http.get('/example');
    assert.deepEqual(actual, Array.isArray(response) ? response : response.data);
  }
});

test('business failures carry error code without discarding HTTP status', async () => {
  requestHandler = (options) => options.success({ statusCode: 200, data: { code: 'OUT_OF_STOCK', message: '库存不足' } });
  await assert.rejects(http.get('/orders'), (error) => error instanceof http.RequestError && error.code === 'OUT_OF_STOCK' && error.statusCode === 200 && error.message === '库存不足');
  requestHandler = (options) => options.success({ statusCode: 200, data: { success: false, message: '操作失败' } });
  await assert.rejects(http.get('/orders'), (error) => error.code === 'BUSINESS_ERROR');
});

test('HTTP and business 401 both clear persisted login state', async () => {
  signIn();
  requestHandler = (options) => options.success({ statusCode: 401, data: { message: '请重新登录' } });
  await assert.rejects(http.get('/private'), (error) => error.code === 'HTTP_ERROR' && error.statusCode === 401);
  assert.equal(session.getSession(), null);
  signIn();
  requestHandler = (options) => options.success({ statusCode: 200, data: { code: '401', message: '会话已失效' } });
  await assert.rejects(http.get('/private'), (error) => error.code === '401');
  assert.equal(session.getSession(), null);
});

test('third-party HTTP and business 401 never clear the backend session', async () => {
  const current = signIn();
  requestHandler = (options) => options.success({ statusCode: 401, data: { message: '第三方会话已失效' } });
  await assert.rejects(http.get('https://external.example.test/private'), (error) => error.statusCode === 401);
  assert.deepEqual(session.getSession(), current);
  requestHandler = (options) => options.success({ statusCode: 200, data: { code: '401', message: '第三方会话已失效' } });
  await assert.rejects(http.get('https://external.example.test/private'), (error) => error.code === '401');
  assert.deepEqual(session.getSession(), current);
});

test('HTTP failures and network failures become actionable normalized errors', async () => {
  requestHandler = (options) => options.success({ statusCode: 503, data: 'temporarily unavailable' });
  await assert.rejects(http.get('/notes'), (error) => error.code === 'HTTP_ERROR' && error.statusCode === 503);
  requestHandler = (options) => options.fail({ errMsg: 'request:fail timeout' });
  await assert.rejects(http.get('/notes'), (error) => error.code === 'TIMEOUT');
  requestHandler = (options) => options.fail({ errMsg: 'request:fail network' });
  await assert.rejects(http.get('/notes'), (error) => error.code === 'NETWORK_ERROR');
});

test('missing backend URL and insecure URLs fail before network access', async () => {
  config.baseURL = '';
  lastRequest = null;
  await assert.rejects(http.get('/profile'), (error) => error.code === 'API_NOT_CONFIGURED');
  await assert.rejects(http.get('http://api.example.test/profile'), (error) => error.code === 'INVALID_URL');
  assert.equal(lastRequest, null);
});

test('mock endpoints work without a backend and demo login can be restored and cleared', async () => {
  config.baseURL = '';
  const [overview, features, guest] = await Promise.all([api.getOverview(), api.getFeatures(), api.getProfile()]);
  assert.equal(overview.status, 'ready');
  assert.equal(features.length, 6);
  assert.equal(guest.loggedIn, false);
  const current = await api.loginDemo();
  assert.equal(current.user.nickname, '体验用户');
  const profile = await api.getProfile();
  assert.equal(profile.loggedIn, true);
  assert.equal(profile.user.id, current.user.id);
  assert.equal(api.logout(), true);
  assert.equal(session.isLoggedIn(), false);
});

test('logout reports failed persistent removal without pretending the session is cleared', () => {
  signIn();
  wx.removeStorageSync = () => { throw new Error('storage unavailable'); };
  assert.equal(api.logout(), false);
  assert.equal(session.isLoggedIn(), true);
});

test('disabling mock routes APIs to backend and blocks demo credentials', async () => {
  config.mock = false;
  const result = await api.getOverview();
  assert.deepEqual(result, { ok: true });
  assert.equal(lastRequest.url, 'https://api.example.test/v1/overview');
  await assert.rejects(api.loginDemo(), /未开启演示登录/);
});
