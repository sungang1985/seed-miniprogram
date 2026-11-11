const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function initialState(status = 'idle') {
  return {
    status,
    segments: [],
    distanceMeters: 0,
    durationMs: 0,
    currentSpeedMps: 0,
    averageSpeedMps: 0,
    pointCount: 0,
    currentLocation: null,
    limitReached: false,
    lastRejection: null,
    errorMessage: '',
    errorCode: '',
    waitingForLocation: false
  };
}

function recordedState(status = 'recording') {
  const first = { latitude: 22.543, longitude: 114.057, timestamp: 1000, accuracy: 8 };
  const second = { latitude: 22.544, longitude: 114.058, timestamp: 2000, accuracy: 7 };
  const resumed = { latitude: 22.55, longitude: 114.065, timestamp: 7000, accuracy: 9 };
  const last = { latitude: 22.551, longitude: 114.066, timestamp: 8000, accuracy: 6 };
  return Object.assign(initialState(status), {
    segments: [{ points: [first, second] }, { points: [resumed, last] }],
    distanceMeters: 1234,
    durationMs: 65000,
    currentSpeedMps: status === 'recording' ? 2 : 0,
    averageSpeedMps: 1.5,
    pointCount: 4,
    currentLocation: last
  });
}

function loadHome(options = {}) {
  let definition;
  let subscriber;
  let state = initialState();
  const calls = [];
  const updates = [];
  const saved = [];
  const tracker = {
    snapshot() { calls.push({ method: 'snapshot' }); return clone(state); },
    async start() {
      calls.push({ method: 'start' });
      if (options.start) return options.start(emit, state);
      emit(Object.assign(initialState('recording'), { waitingForLocation: true }));
      return clone(state);
    },
    async pause(reason) {
      calls.push({ method: 'pause', reason });
      emit(Object.assign({}, state, { status: 'paused', currentSpeedMps: 0, waitingForLocation: false }));
      return clone(state);
    },
    async resume() {
      calls.push({ method: 'resume' });
      emit(Object.assign({}, state, { status: 'recording', waitingForLocation: true }));
      return clone(state);
    },
    async finish() {
      calls.push({ method: 'finish' });
      emit(Object.assign({}, state, { status: 'finished', currentSpeedMps: 0, waitingForLocation: false }));
      return clone(state);
    },
    async destroy() { calls.push({ method: 'destroy' }); }
  };

  function emit(next) {
    state = clone(next);
    if (subscriber) subscriber(clone(state));
  }

  const modules = {
    '../../services/api': {
      getOverview: async () => ({ stats: [] }),
      getFeatures: async () => []
    },
    '../../config': { env: 'develop', mock: true, version: '1.0.0' },
    '../../services/location-sharing': {
      createLocationSharing() {
        const value = { configured: false, phase: 'idle', room: null, sharing: false,
          pendingStop: false, errorMessage: '', errorCode: '', busyAction: '' };
        const snapshot = () => value;
        return { snapshot, create: async () => value, join: async () => value,
          startPublishing: async () => value, pausePublishing: async () => value,
          leave: async () => value, close: async () => value, suspend: async () => value,
          resumePolling: snapshot, destroy: async () => value, updateLocation() {}, invitePath: () => '' };
      }
    },
    '../../services/location-tracker': {
      createTracker(settings) {
        calls.push({ method: 'createTracker' });
        subscriber = settings.onChange;
        return tracker;
      }
    },
    '../../utils/storage': {
      get(key, fallback) {
        calls.push({ method: 'storage.get', key });
        return options.stored === undefined ? fallback : clone(options.stored);
      },
      set(key, value) {
        saved.push({ key, value: clone(value) });
        return options.saveSuccess !== false;
      }
    }
  };
  const wx = {
    showToast(settings) { calls.push({ method: 'showToast', settings }); },
    showModal(settings) {
      calls.push({ method: 'showModal', settings });
      if (options.confirm !== undefined && settings.success) settings.success({ confirm: options.confirm });
    },
    openSetting(settings) {
      calls.push({ method: 'openSetting', settings });
      if (settings.success) settings.success({ authSetting: {} });
    },
    setKeepScreenOn(settings) { calls.push({ method: 'setKeepScreenOn', settings }); },
    switchTab(settings) { calls.push({ method: 'switchTab', settings }); },
    setClipboardData(settings) { calls.push({ method: 'setClipboardData', settings }); },
    stopPullDownRefresh() {},
    getLocation() { assert.fail('The homepage must obtain location only through the explicit tracker service'); },
    startLocationUpdate() { assert.fail('The homepage must obtain location only through the explicit tracker service'); }
  };
  const filename = path.join(__dirname, '../miniprogram/pages/home/index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value; },
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Unexpected home dependency: ${name}`);
      return modules[name];
    },
    wx,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }, { filename });
  assert.ok(definition, 'home registers Page');
  const page = Object.assign({}, definition, {
    data: clone(definition.data),
    setData(patch, callback) {
      updates.push(clone(patch));
      for (const [key, value] of Object.entries(patch)) {
        const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let object = this.data;
        for (const segment of segments.slice(0, -1)) object = object[segment];
        object[segments.at(-1)] = clone(value);
      }
      if (callback) callback.call(this);
    }
  });
  return { page, calls, updates, saved, emit, tracker };
}

async function mounted(options) {
  const harness = loadHome(options);
  await harness.page.onLoad();
  await new Promise(setImmediate);
  return harness;
}

test('opening the homepage prepares controls without activating location tracking', async () => {
  const { page, calls } = await mounted();
  assert.equal(calls.filter((call) => call.method === 'createTracker').length, 1);
  assert.equal(calls.some((call) => call.method === 'start'), false);
  assert.equal(page.data.trackActive, false);
  assert.equal(page.data.track.status, 'idle');
});

test('explicit start enables recording and projects stats and disconnected route segments', async () => {
  const { page, calls, emit } = await mounted();
  await page.onStartTrack();
  assert.equal(calls.filter((call) => call.method === 'start').length, 1);
  assert.equal(page.data.track.status, 'recording');
  emit(recordedState());

  assert.equal(page.data.trackActive, true);
  assert.equal(page.data.track.hasLocation, true);
  assert.equal(page.data.track.distanceText, '1.23');
  assert.equal(page.data.track.speedText, '7.2');
  assert.equal(page.data.track.averageSpeedText, '5.4');
  assert.match(page.data.track.durationText, /01:05$/);
  assert.equal(page.data.track.pointCount, 4);
  assert.equal(page.data.trackLocation.latitude, 22.551);
  assert.equal(page.data.trackPolyline.length, 2);
  assert.equal(page.data.trackPolyline[0].points.length, 2);
  assert.equal(page.data.trackPolyline[1].points[0].latitude, 22.55);
});

test('leaving the homepage pauses tracking and unloading disposes it', async () => {
  const { page, calls, emit, updates } = await mounted();
  emit(recordedState());
  await page.onHide();
  assert.equal(calls.filter((call) => call.method === 'pause').length, 1);
  assert.equal(page.data.track.status, 'paused');
  assert.equal(page.data.trackActive, false);
  assert.equal(page.data.trackPolyline.length, 2);
  await page.onUnload();
  assert.equal(calls.filter((call) => call.method === 'destroy').length, 1);
  const count = updates.length;
  emit(recordedState());
  assert.equal(updates.length, count, 'late service events do not update an unloaded page');
});

test('a completed track is saved locally and restored without restarting location services', async () => {
  const first = await mounted();
  first.emit(recordedState());
  await first.page.onFinishTrack();
  assert.equal(first.saved.length, 1);
  assert.equal(first.saved[0].key, 'motion:last-session');
  assert.equal(first.page.data.track.status, 'finished');
  const restored = await mounted({ stored: first.saved[0].value });
  assert.equal(restored.page.data.track.status, 'finished');
  assert.equal(restored.page.data.trackPolyline.length, 2);
  assert.equal(restored.page.data.trackActive, false);
  assert.equal(restored.calls.some((call) => call.method === 'start' || call.method === 'resume'), false);
});

test('failed local persistence preserves the finished route and reports the failure', async () => {
  const { page, calls, emit } = await mounted({ saveSuccess: false });
  emit(recordedState());
  await page.onFinishTrack();
  assert.equal(page.data.track.status, 'finished');
  assert.equal(page.data.trackPolyline.length, 2);
  const userFeedback = calls.filter((call) => call.method === 'showToast').map((call) => call.settings.title).join(' ');
  assert.match(`${userFeedback} ${page.data.track.errorMessage}`, /保存|缓存|存储/);
});

test('a valid zero-coordinate fix updates the live marker without drawing a one-point route', async () => {
  const { page, emit } = await mounted();
  const fix = { latitude: 0, longitude: 0, timestamp: 1000, accuracy: 5 };
  emit(Object.assign(initialState('recording'), {
    segments: [{ points: [fix] }],
    pointCount: 1,
    currentLocation: fix
  }));
  assert.equal(page.data.track.hasLocation, true);
  assert.equal(page.data.trackLocation.latitude, 0);
  assert.equal(page.data.trackLocation.longitude, 0);
  assert.equal(page.data.trackPolyline.length, 0);
});

test('an unfinished cached record is ignored instead of resuming location tracking', async () => {
  const { page, calls } = await mounted({ stored: { version: 1, snapshot: recordedState('recording'), savedAt: 1000 } });
  assert.equal(page.data.track.status, 'idle');
  assert.equal(page.data.trackActive, false);
  assert.equal(calls.some((call) => call.method === 'start' || call.method === 'resume'), false);
  await page.onHide();
  assert.equal(calls.some((call) => call.method === 'pause'), false, 'idle lifecycle does not operate the location service');
});

test('automatic point-limit completion saves once without requiring an end-button tap', async () => {
  const { page, emit, saved, calls } = await mounted();
  emit(recordedState());
  const completed = Object.assign(recordedState('finished'), {
    limitReached: true,
    errorCode: 'TRACK_POINT_LIMIT',
    errorMessage: '本次记录已达到轨迹点上限，已自动结束'
  });
  emit(completed);
  emit(completed);
  assert.equal(page.data.track.status, 'finished');
  assert.equal(page.data.trackActive, false);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].value.snapshot.limitReached, true);
  assert.equal(calls.some((call) => call.method === 'finish'), false);
});
