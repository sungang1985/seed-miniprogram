const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker } = require('../miniprogram/services/location-tracker');

function harness(overrides = {}, trackerOptions = {}) {
  let timestamp = 1000;
  let nextTimer = 0;
  const scheduled = new Map();
  const calls = [];
  const changes = [];
  const locations = new Set();
  const errors = new Set();
  const platform = {
    requirePrivacyAuthorize(options) { calls.push({ name: 'privacy', options }); options.success({}); },
    authorize(options) { calls.push({ name: 'authorize', options }); options.success({}); },
    startLocationUpdate(options) { calls.push({ name: 'start', options }); options.success({}); },
    stopLocationUpdate(options) { calls.push({ name: 'stop', options }); options.success({}); },
    onLocationChange(callback) { calls.push({ name: 'onLocation', callback }); locations.add(callback); },
    offLocationChange(callback) { calls.push({ name: 'offLocation', callback }); locations.delete(callback); },
    onLocationChangeError(callback) { calls.push({ name: 'onError', callback }); errors.add(callback); },
    offLocationChangeError(callback) { calls.push({ name: 'offError', callback }); errors.delete(callback); }
  };
  Object.assign(platform, overrides);
  function schedule(callback, delay, interval) {
    const id = ++nextTimer;
    scheduled.set(id, { callback, at: timestamp + delay, interval });
    return id;
  }
  const tracker = createTracker(Object.assign({
    wx: platform,
    now: () => timestamp,
    onChange(value) { changes.push(value); },
    timers: {
      setTimeout: (callback, delay) => schedule(callback, delay, 0),
      clearTimeout: (id) => scheduled.delete(id),
      setInterval: (callback, delay) => schedule(callback, delay, delay),
      clearInterval: (id) => scheduled.delete(id)
    }
  }, trackerOptions));
  return {
    tracker, calls, changes, locations, errors, scheduled, platform,
    fix(location) { for (const callback of [...locations]) callback(location); },
    streamError(error = {}) { for (const callback of [...errors]) callback(error); },
    advance(milliseconds) {
      const target = timestamp + milliseconds;
      while (true) {
        const item = [...scheduled.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!item) break;
        const [id, timer] = item;
        timestamp = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else scheduled.delete(id);
        timer.callback();
      }
      timestamp = target;
    }
  };
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

test('constructing a tracker requests no permission or location before explicit start', () => {
  const h = harness();
  assert.equal(h.tracker.snapshot().status, 'idle');
  assert.equal(h.calls.length, 0);
  assert.equal(h.scheduled.size, 0);
});

test('explicit start authorizes privacy/location once and starts a GCJ-02 stream', async () => {
  const h = harness();
  const first = h.tracker.start();
  const second = h.tracker.start();
  assert.equal(first, second);
  assert.equal(h.tracker.snapshot().status, 'starting');
  await first;
  assert.equal(h.tracker.snapshot().status, 'recording');
  assert.equal(h.tracker.snapshot().waitingForLocation, true);
  assert.deepEqual(h.calls.map((call) => call.name).slice(0, 3), ['privacy', 'authorize', 'onLocation']);
  assert.equal(h.calls.find((call) => call.name === 'authorize').options.scope, 'scope.userLocation');
  assert.equal(h.calls.find((call) => call.name === 'start').options.type, 'gcj02');
  assert.equal(h.calls.filter((call) => call.name === 'start').length, 1);
  await h.tracker.destroy();
});

test('privacy or location denial leaves a retryable paused state without starting GPS', async () => {
  const privacy = harness({ requirePrivacyAuthorize(options) { options.fail({ errMsg: 'deny privacy' }); } });
  await privacy.tracker.start();
  assert.equal(privacy.tracker.snapshot().errorCode, 'PRIVACY_DENIED');
  assert.equal(privacy.tracker.snapshot().status, 'paused');
  assert.equal(privacy.calls.some((call) => call.name === 'authorize' || call.name === 'start'), false);

  const permission = harness({ authorize(options) { options.fail({ errMsg: 'auth deny' }); } });
  await permission.tracker.start();
  assert.equal(permission.tracker.snapshot().errorCode, 'LOCATION_PERMISSION_DENIED');
  assert.equal(permission.tracker.snapshot().status, 'paused');
  assert.equal(permission.calls.some((call) => call.name === 'start'), false);
  permission.platform.authorize = (options) => options.success({});
  await permission.tracker.resume();
  assert.equal(permission.tracker.snapshot().status, 'recording');
  await permission.tracker.destroy();
});

test('older clients can record without the optional privacy/error APIs', async () => {
  const h = harness({ requirePrivacyAuthorize: undefined, onLocationChangeError: undefined, offLocationChangeError: undefined });
  await h.tracker.start();
  assert.equal(h.tracker.snapshot().status, 'recording');
  assert.equal(h.errors.size, 0);
  await h.tracker.destroy();
});

test('missing required continuous location support fails without prompting permission', async () => {
  const h = harness({ offLocationChange: undefined });
  await h.tracker.start();
  assert.equal(h.tracker.snapshot().status, 'paused');
  assert.equal(h.tracker.snapshot().errorCode, 'LOCATION_UNSUPPORTED');
  assert.equal(h.calls.length, 0);
});

test('location fixes create a route and timer ticks change duration without fabricating points', async () => {
  const h = harness();
  await h.tracker.start();
  h.fix({ latitude: 0, longitude: 0, accuracy: 5 });
  h.advance(5000);
  assert.equal(h.tracker.snapshot().pointCount, 1);
  assert.equal(h.tracker.snapshot().durationMs, 5000);
  h.fix({ latitude: 0, longitude: 0.0001, accuracy: 5 });
  const value = h.tracker.snapshot();
  assert.equal(value.pointCount, 2);
  assert.ok(value.distanceMeters > 11 && value.distanceMeters < 12);
  assert.equal(value.waitingForLocation, false);
  await h.tracker.destroy();
});

test('pause detaches exact handlers and resume creates a new segment without a pause bridge', async () => {
  const h = harness();
  await h.tracker.start();
  h.fix({ latitude: 0, longitude: 0, accuracy: 5 });
  const listener = [...h.locations][0];
  const errorListener = [...h.errors][0];
  h.advance(3000);
  await h.tracker.pause('离开页面，已暂停');
  const paused = h.tracker.snapshot();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.errorMessage, '离开页面，已暂停');
  assert.equal(h.locations.size, 0);
  assert.equal(h.errors.size, 0);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.calls.find((call) => call.name === 'offLocation').callback, listener);
  assert.equal(h.calls.find((call) => call.name === 'offError').callback, errorListener);
  listener({ latitude: 1, longitude: 1, accuracy: 5 });
  assert.equal(h.tracker.snapshot().pointCount, 1);
  h.advance(60000);
  await h.tracker.resume();
  h.fix({ latitude: 2, longitude: 2, accuracy: 5 });
  assert.equal(h.tracker.snapshot().segments.length, 2);
  assert.equal(h.tracker.snapshot().distanceMeters, 0);
  assert.equal(h.tracker.snapshot().durationMs, 3000);
  await h.tracker.destroy();
});

test('poor fixes cannot indefinitely postpone the first valid location timeout', async () => {
  const h = harness();
  await h.tracker.start();
  h.advance(10000);
  h.fix({ latitude: 22, longitude: 114, accuracy: 1000 });
  h.advance(10000);
  await flush();
  assert.equal(h.tracker.snapshot().status, 'paused');
  assert.equal(h.tracker.snapshot().errorCode, 'LOCATION_TIMEOUT');
  assert.equal(h.tracker.snapshot().pointCount, 0);
  assert.equal(h.locations.size, 0);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.calls.filter((call) => call.name === 'stop').length, 1);
});

test('a lost stream pauses at the valid-fix deadline while jitter fixes keep it alive', async () => {
  const h = harness();
  await h.tracker.start();
  h.fix({ latitude: 22, longitude: 114, accuracy: 5 });
  h.advance(25000);
  h.fix({ latitude: 22, longitude: 114, accuracy: 5 });
  h.advance(25000);
  assert.equal(h.tracker.snapshot().status, 'recording');
  h.advance(5000);
  await flush();
  assert.equal(h.tracker.snapshot().status, 'paused');
  assert.equal(h.tracker.snapshot().errorCode, 'LOCATION_TIMEOUT');
  assert.equal(h.tracker.snapshot().pointCount, 1);
});

test('a native stream error pauses recording and removes callbacks and timers', async () => {
  const h = harness();
  await h.tracker.start();
  h.streamError({ errMsg: 'signal unavailable' });
  await flush();
  assert.equal(h.tracker.snapshot().status, 'paused');
  assert.equal(h.tracker.snapshot().errorCode, 'LOCATION_STREAM_ERROR');
  assert.equal(h.locations.size, 0);
  assert.equal(h.errors.size, 0);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.calls.filter((call) => call.name === 'stop').length, 1);
});

test('canceling while privacy authorization is pending never starts location afterward', async () => {
  let privacy;
  const h = harness({ requirePrivacyAuthorize(options) { privacy = options; } });
  const start = h.tracker.start();
  await flush();
  const paused = h.tracker.pause();
  assert.equal(h.tracker.snapshot().status, 'paused');
  privacy.success({});
  await Promise.all([start, paused]);
  assert.equal(h.calls.some((call) => call.name === 'start' || call.name === 'authorize'), false);
  assert.equal(h.scheduled.size, 0);
});

test('destroy during native startup stops the late successful stream and emits no later updates', async () => {
  let nativeStart;
  const h = harness({ startLocationUpdate(options) { nativeStart = options; } });
  const start = h.tracker.start();
  await flush();
  const oldListener = [...h.locations][0];
  const destroyed = h.tracker.destroy();
  const updateCount = h.changes.length;
  assert.equal(h.locations.size, 0);
  nativeStart.success({});
  await Promise.all([start, destroyed]);
  oldListener({ latitude: 22, longitude: 114, accuracy: 5 });
  assert.equal(h.calls.filter((call) => call.name === 'stop').length, 1);
  assert.equal(h.changes.length, updateCount);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.tracker.destroy(), destroyed);
});

test('rapid resume waits for an in-flight native stop before restarting', async () => {
  let stop;
  const h = harness({ stopLocationUpdate(options) { stop = options; } });
  await h.tracker.start();
  const paused = h.tracker.pause();
  const resumed = h.tracker.resume();
  await flush();
  assert.equal(h.calls.filter((call) => call.name === 'start').length, 1);
  stop.success({});
  await Promise.all([paused, resumed]);
  assert.equal(h.calls.filter((call) => call.name === 'start').length, 2);
  assert.equal(h.tracker.snapshot().status, 'recording');
  h.platform.stopLocationUpdate = (options) => options.success({});
  await h.tracker.destroy();
});

test('native stop failures remain visible and repeated failure cannot trap the controller in starting', async () => {
  const h = harness({ stopLocationUpdate(options) { options.fail({ errMsg: 'stop failed' }); } });
  await h.tracker.start();
  await h.tracker.pause();
  assert.equal(h.tracker.snapshot().nativeStopFailed, true);
  assert.equal(h.tracker.snapshot().errorCode, 'LOCATION_STOP_FAILED');
  await h.tracker.resume();
  assert.equal(h.tracker.snapshot().status, 'paused');
  assert.equal(h.tracker.snapshot().nativeStopFailed, true);
  h.platform.stopLocationUpdate = (options) => options.success({});
  await h.tracker.resume();
  assert.equal(h.tracker.snapshot().status, 'recording');
  assert.equal(h.tracker.snapshot().nativeStopFailed, false);
  assert.equal(h.tracker.snapshot().errorMessage, '');
  await h.tracker.destroy();
});

test('native startup failure leaves retryable state and removes installed callbacks', async () => {
  const h = harness({ startLocationUpdate(options) { options.fail({ errMsg: 'account has not applied' }); } });
  await h.tracker.start();
  assert.equal(h.tracker.snapshot().status, 'paused');
  assert.equal(h.tracker.snapshot().errorCode, 'LOCATION_START_FAILED');
  assert.equal(h.locations.size, 0);
  assert.equal(h.errors.size, 0);
  assert.equal(h.scheduled.size, 0);
});

test('location events delivered during startup are retained once the native stream is ready', async () => {
  let nativeStart;
  const h = harness({ startLocationUpdate(options) { nativeStart = options; } });
  const start = h.tracker.start();
  await flush();
  h.fix({ latitude: 0, longitude: 0, accuracy: 5 });
  nativeStart.success({});
  await start;
  assert.equal(h.tracker.snapshot().pointCount, 1);
  assert.equal(h.tracker.snapshot().waitingForLocation, false);
  await h.tracker.destroy();
});

test('the route-point limit automatically finishes and stops the owned stream', async () => {
  const h = harness({}, { motionOptions: { maxPoints: 2 } });
  await h.tracker.start();
  h.fix({ latitude: 0, longitude: 0, accuracy: 5 });
  h.advance(5000);
  h.fix({ latitude: 0, longitude: 0.0001, accuracy: 5 });
  await flush();
  const value = h.tracker.snapshot();
  assert.equal(value.status, 'finished');
  assert.equal(value.limitReached, true);
  assert.equal(value.pointCount, 2);
  assert.equal(value.errorCode, 'TRACK_POINT_LIMIT');
  assert.equal(h.locations.size, 0);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.calls.filter((call) => call.name === 'stop').length, 1);
});

test('finish retains measured route and no timer or stale callback can extend it', async () => {
  const h = harness();
  await h.tracker.start();
  h.fix({ latitude: 22, longitude: 114, accuracy: 5 });
  const oldListener = [...h.locations][0];
  h.advance(5000);
  await h.tracker.finish();
  const value = h.tracker.snapshot();
  h.advance(10000);
  oldListener({ latitude: 23, longitude: 115, accuracy: 5 });
  assert.equal(h.tracker.snapshot().status, 'finished');
  assert.equal(h.tracker.snapshot().durationMs, value.durationMs);
  assert.equal(h.tracker.snapshot().pointCount, 1);
  assert.equal(h.scheduled.size, 0);
});

test('a replacement Page waits for an old late startup to finish cleanup before owning GPS', async () => {
  let oldStart;
  const oldPage = harness({ startLocationUpdate(options) { oldStart = options; } });
  const starting = oldPage.tracker.start();
  await flush();
  const disposing = oldPage.tracker.destroy();
  const newPage = harness();
  const replacement = newPage.tracker.start();
  await flush();
  assert.equal(newPage.calls.some((call) => call.name === 'start'), false);
  oldStart.success({});
  await Promise.all([starting, disposing, replacement]);
  assert.equal(oldPage.calls.filter((call) => call.name === 'stop').length, 1);
  assert.equal(newPage.calls.filter((call) => call.name === 'start').length, 1);
  assert.equal(newPage.calls.filter((call) => call.name === 'stop').length, 0);
  assert.equal(newPage.tracker.snapshot().status, 'recording');
  await newPage.tracker.destroy();
});

test('a new controller can retry failed cleanup of a destroyed owner without a permanent lease lock', async () => {
  const oldPage = harness({ stopLocationUpdate(options) { options.fail({ errMsg: 'temporary stop error' }); } });
  await oldPage.tracker.start();
  await oldPage.tracker.destroy();
  const newPage = harness();
  await newPage.tracker.start();
  assert.equal(newPage.tracker.snapshot().status, 'paused');
  assert.equal(newPage.tracker.snapshot().errorCode, 'LOCATION_CLEANUP_FAILED');
  assert.equal(newPage.tracker.snapshot().nativeStopFailed, true);
  assert.equal(newPage.calls.some((call) => call.name === 'start'), false);
  oldPage.platform.stopLocationUpdate = (options) => options.success({});
  await newPage.tracker.resume();
  assert.equal(newPage.tracker.snapshot().status, 'recording');
  assert.equal(newPage.tracker.snapshot().nativeStopFailed, false);
  await newPage.tracker.destroy();
});

test('another active recorder is refused without stopping its stream', async () => {
  const first = harness();
  await first.tracker.start();
  const second = harness();
  await second.tracker.start();
  assert.equal(second.tracker.snapshot().status, 'paused');
  assert.equal(second.tracker.snapshot().errorCode, 'LOCATION_IN_USE');
  assert.equal(second.calls.length, 0);
  assert.equal(first.tracker.snapshot().status, 'recording');
  assert.equal(first.calls.some((call) => call.name === 'stop'), false);
  await second.tracker.destroy();
  assert.equal(first.calls.some((call) => call.name === 'stop'), false);
  await first.tracker.destroy();
});

test('simultaneous fresh controllers atomically acquire only one shared native stream', async () => {
  const first = harness();
  const second = harness({}, { wx: first.platform });
  await Promise.all([first.tracker.start(), second.tracker.start()]);
  const states = [first.tracker.snapshot(), second.tracker.snapshot()];
  assert.equal(states.filter((state) => state.status === 'recording').length, 1);
  assert.equal(states.filter((state) => state.status === 'paused' && state.errorCode === 'LOCATION_IN_USE').length, 1);
  assert.equal(first.calls.filter((call) => call.name === 'start').length, 1);
  assert.equal(first.locations.size, 1);
  await Promise.all([first.tracker.destroy(), second.tracker.destroy()]);
  assert.equal(first.calls.filter((call) => call.name === 'stop').length, 1);
  assert.equal(first.locations.size, 0);
});
