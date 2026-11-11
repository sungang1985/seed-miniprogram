const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NOW = 1700000000000;
const ROOM_ID = 'a'.repeat(32);
const INVITE_TOKEN = 'b'.repeat(32);
const INVITE_PATH = `/pages/location-share/index?roomId=${ROOM_ID}&inviteToken=${INVITE_TOKEN}`;
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function motion(status = 'idle', position = null) {
  return {
    status, segments: position ? [{ points: [position] }] : [],
    distanceMeters: 0, durationMs: 0, currentSpeedMps: 0, averageSpeedMps: 0,
    pointCount: position ? 1 : 0, currentLocation: position, waitingForLocation: false,
    errorCode: '', errorMessage: '', nativeStopFailed: false, limitReached: false
  };
}

function room() {
  return {
    roomId: ROOM_ID, expiresAt: NOW + 30 * 60000, serverTime: NOW, status: 'active',
    selfId: 'owner-member', ownerId: 'owner-member',
    members: [
      { id: 'owner-member', label: '发起人', role: 'owner', sharing: false, live: false, location: null },
      { id: 'friend-member', label: '好友1', role: 'member', sharing: true, live: true,
        location: { latitude: 31.2304, longitude: 121.4737, accuracy: 8, sampledAt: NOW, updatedAt: NOW } }
    ]
  };
}

function loadHome(options = {}) {
  let definition;
  let motionSubscriber;
  let shareSubscriber;
  let motionState = motion();
  let shareState = {
    configured: options.configured !== false, phase: 'idle', room: null, sharing: false,
    pendingStop: false, errorMessage: '', errorCode: '', busyAction: ''
  };
  const calls = [];
  const updates = [];
  const emitMotion = (next) => {
    motionState = clone(next);
    if (motionSubscriber) motionSubscriber(clone(next));
  };
  const emitShare = (next) => {
    shareState = Object.assign({}, shareState, clone(next));
    if (shareSubscriber) shareSubscriber(clone(shareState));
  };
  const tracker = {
    snapshot: () => clone(motionState),
    async start() {
      calls.push({ method: 'tracker.start' });
      if (options.startPending) return options.startPending(emitMotion);
      const point = { latitude: 22.543096, longitude: 114.057865, timestamp: NOW, accuracy: 6 };
      emitMotion(options.permissionDenied ? Object.assign(motion('paused'), {
        errorCode: 'LOCATION_PERMISSION_DENIED', errorMessage: '未获得定位权限'
      }) : motion('recording', point));
      return clone(motionState);
    },
    async resume() {
      calls.push({ method: 'tracker.resume' });
      emitMotion(Object.assign({}, motionState, { status: 'recording' }));
      return clone(motionState);
    },
    async pause() {
      calls.push({ method: 'tracker.pause' });
      emitMotion(Object.assign({}, motionState, { status: 'paused' }));
      return clone(motionState);
    },
    async finish() {
      calls.push({ method: 'tracker.finish' });
      emitMotion(Object.assign({}, motionState, { status: 'finished' }));
      return clone(motionState);
    },
    async destroy() { calls.push({ method: 'tracker.destroy' }); }
  };
  const sharing = {
    snapshot: () => clone(shareState),
    async create() {
      calls.push({ method: 'sharing.create' });
      if (options.createPending) await options.createPending;
      emitShare({ phase: 'active', room: room(), sharing: false });
      return clone(shareState);
    },
    async startPublishing() {
      calls.push({ method: 'sharing.startPublishing' });
      emitShare({ sharing: true, pendingStop: false, errorMessage: '', errorCode: '' });
      return clone(shareState);
    },
    updateLocation(point) { calls.push({ method: 'sharing.updateLocation', point: clone(point) }); },
    async pausePublishing() {
      calls.push({ method: 'sharing.pausePublishing' });
      emitShare({ sharing: false, pendingStop: !!options.stopFailure,
        errorMessage: options.stopFailure ? '停止共享未确认，请重试' : '' });
      return clone(shareState);
    },
    async suspend() {
      calls.push({ method: 'sharing.suspend' });
      emitShare({ sharing: false });
      return clone(shareState);
    },
    resumePolling() { calls.push({ method: 'sharing.resumePolling' }); return clone(shareState); },
    async close() {
      calls.push({ method: 'sharing.close' });
      emitShare({ phase: 'closed', room: null, sharing: false });
      return clone(shareState);
    },
    async destroy() { calls.push({ method: 'sharing.destroy' }); },
    invitePath() { return shareState.phase === 'active' && shareState.room ? INVITE_PATH : ''; }
  };
  const modules = {
    '../../services/api': { getOverview: async () => ({ stats: [] }), getFeatures: async () => [] },
    '../../config': { env: 'develop', mock: true, version: '1.0.0', cloudEnv: 'test-env' },
    '../../services/location-tracker': {
      createTracker(settings) { motionSubscriber = settings.onChange; calls.push({ method: 'createTracker' }); return tracker; }
    },
    '../../services/location-sharing': {
      createLocationSharing(settings) { shareSubscriber = settings.onChange; calls.push({ method: 'createLocationSharing' }); return sharing; }
    },
    '../../utils/storage': { get: (key, fallback) => fallback, set: () => true }
  };
  const wx = {
    showToast(settings) { calls.push({ method: 'showToast', settings }); },
    showModal(settings) {
      calls.push({ method: 'showModal', settings });
      if (settings.success) settings.success({ confirm: options.confirm !== false });
    },
    showShareMenu(settings) { calls.push({ method: 'showShareMenu', settings }); },
    hideShareMenu(settings) { calls.push({ method: 'hideShareMenu', settings }); },
    switchTab() {}, setClipboardData() {}, stopPullDownRefresh() {}, openSetting() {},
    getLocation() { assert.fail('Home must use its explicit location tracker'); },
    startLocationUpdate() { assert.fail('Home must use its explicit location tracker'); }
  };
  class Clock extends Date { static now() { return NOW; } }
  const filename = path.join(__dirname, '../miniprogram/pages/home/index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value; },
    require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name]; },
    wx, Date: Clock, console, setTimeout, clearTimeout, setInterval, clearInterval
  }, { filename });
  const page = Object.assign({}, definition, {
    data: clone(definition.data),
    setData(patch, callback) {
      updates.push(clone(patch));
      for (const [key, value] of Object.entries(patch)) {
        const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let object = this.data;
        for (const part of keys.slice(0, -1)) object = object[part];
        object[keys.at(-1)] = clone(value);
      }
      if (callback) callback.call(this);
    }
  });
  return { page, calls, updates, emitMotion, emitShare, tracker, sharing };
}

async function mounted(options) {
  const harness = loadHome(options);
  await harness.page.onLoad();
  if (harness.page.onShow) await harness.page.onShow();
  await new Promise(setImmediate);
  return harness;
}

test('opening home prepares sharing without creating rooms, starting GPS or publishing', async () => {
  const { calls } = await mounted();
  assert.equal(calls.filter((call) => call.method === 'createLocationSharing').length, 1);
  assert.equal(calls.some((call) => ['sharing.create', 'sharing.startPublishing', 'sharing.updateLocation', 'tracker.start'].includes(call.method)), false);
});

test('personal motion samples stay outside the sharing adapter until sharing is explicitly enabled', async () => {
  const { emitMotion, calls } = await mounted();
  emitMotion(motion('recording', { latitude: 22, longitude: 114, timestamp: NOW, accuracy: 8 }));
  assert.equal(calls.some((call) => call.method === 'sharing.updateLocation'), false);
});

test('explicit creation obtains a room before publishing and forwards the actual location sample', async () => {
  const { page, calls } = await mounted();
  await page.onCreateFriendShare();
  const methods = calls.map((call) => call.method);
  assert.ok(methods.indexOf('sharing.create') >= 0);
  assert.ok(methods.indexOf('sharing.startPublishing') > methods.indexOf('sharing.create'));
  const published = calls.filter((call) => call.method === 'sharing.updateLocation');
  assert.ok(published.length > 0);
  assert.equal(published.at(-1).point.timestamp, NOW);
  assert.equal(published.at(-1).point.accuracy, 6);
  assert.equal(page.data.friendShare.sharing, true);
});

test('sharing reuses an active motion recorder instead of resetting its track', async () => {
  const { page, calls, emitMotion } = await mounted();
  emitMotion(motion('recording', { latitude: 0, longitude: 0, timestamp: NOW, accuracy: 5 }));
  await page.onCreateFriendShare();
  assert.equal(calls.some((call) => call.method === 'tracker.start' || call.method === 'tracker.resume'), false);
  assert.equal(calls.filter((call) => call.method === 'sharing.updateLocation').at(-1).point.latitude, 0);
});

test('missing cloud configuration and denied location never enable publication', async () => {
  const unavailable = await mounted({ configured: false });
  await unavailable.page.onCreateFriendShare();
  assert.equal(unavailable.calls.some((call) => call.method === 'sharing.create' || call.method === 'tracker.start'), false);
  const denied = await mounted({ permissionDenied: true });
  await denied.page.onCreateFriendShare();
  assert.equal(denied.calls.some((call) => call.method === 'sharing.startPublishing' || call.method === 'sharing.updateLocation'), false);
});

test('hiding suspends sharing and GPS; returning resumes polling without automatic publication', async () => {
  const { page, calls, emitMotion, updates } = await mounted();
  await page.onCreateFriendShare();
  await page.onHide();
  assert.ok(calls.some((call) => call.method === 'sharing.suspend'));
  assert.ok(calls.some((call) => call.method === 'tracker.pause'));
  const publications = calls.filter((call) => call.method === 'sharing.updateLocation').length;
  emitMotion(motion('recording', { latitude: 23, longitude: 115, timestamp: NOW + 1, accuracy: 5 }));
  assert.equal(calls.filter((call) => call.method === 'sharing.updateLocation').length, publications);
  const starts = calls.filter((call) => call.method === 'sharing.startPublishing' || call.method === 'tracker.start').length;
  await page.onShow();
  assert.equal(calls.filter((call) => call.method === 'sharing.startPublishing' || call.method === 'tracker.start').length, starts);
  await page.onUnload();
  assert.ok(calls.some((call) => call.method === 'sharing.destroy'));
  assert.ok(calls.some((call) => call.method === 'tracker.destroy'));
  const updateCount = updates.length;
  emitMotion(motion('recording'));
  assert.equal(updates.length, updateCount);
});

test('a late room creation cannot activate location sharing after the homepage is hidden', async () => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const { page, calls } = await mounted({ createPending: pending });
  const creation = page.onCreateFriendShare();
  await new Promise(setImmediate);
  await page.onHide();
  complete();
  await creation;
  assert.equal(calls.some((call) => call.method === 'tracker.start' || call.method === 'sharing.startPublishing'), false);
});

test('only the explicit invite button shares the room path, without coordinates or tokens in Page data', async () => {
  const { page } = await mounted();
  await page.onCreateFriendShare();
  const invite = page.onShareAppMessage({ from: 'button', target: { dataset: { action: 'invite-room' } } });
  assert.equal(invite.path, INVITE_PATH);
  assert.doesNotMatch(invite.path, /latitude|longitude|22\.543096|114\.057865/);
  assert.equal(JSON.stringify(page.data).includes(INVITE_TOKEN), false);
  assert.equal(invite.imageUrl, '/assets/share/location-invite.png');
  const ordinary = page.onShareAppMessage({ from: 'menu' });
  assert.doesNotMatch(ordinary.path, /roomId|inviteToken/);
  assert.equal(ordinary.imageUrl, invite.imageUrl);
});

test('a failed stop is displayed as pending while local motion recording stays separate', async () => {
  const { page, calls } = await mounted({ stopFailure: true });
  await page.onCreateFriendShare();
  await page.onPauseFriendShare();
  assert.equal(page.data.friendShare.pendingStop, true);
  assert.match(page.data.friendShare.errorMessage, /停止|重试/);
  assert.equal(calls.some((call) => call.method === 'tracker.pause'), false);
});

test('room closure clears previously shown friend markers', async () => {
  const { page } = await mounted();
  await page.onCreateFriendShare();
  assert.equal(page.data.friendMarkers.length, 1);
  await page.onCloseFriendShare();
  assert.equal(page.data.friendMarkers.length, 0);
});

test('two actual client services exchange positions through the actual backend and revoke them on pause/close', async () => {
  const { createLocationSharing } = require('../miniprogram/services/location-sharing');
  const { createLocationShareService } = require('../cloudfunctions/location-share/service');
  const documents = new Map();
  let transaction = Promise.resolve();
  const repository = {
    mutate(id, update) {
      const result = transaction.then(() => {
        const changed = update(clone(documents.get(id) || null));
        if (changed.room) documents.set(id, clone(changed.room));
        return clone(changed.value);
      });
      transaction = result.catch(() => {});
      return result;
    }
  };
  const server = createLocationShareService({ repository, now: () => NOW });
  let taskId = 0;
  const tasks = new Map();
  const timers = {
    setTimeout(callback, delay) { const id = ++taskId; tasks.set(id, { callback, delay, interval: false }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    setInterval(callback, delay) { const id = ++taskId; tasks.set(id, { callback, delay, interval: true }); return id; },
    clearInterval(id) { tasks.delete(id); }
  };
  const requests = [];
  function platform(openId) {
    return { cloud: {
      init() {},
      callFunction(settings) {
        requests.push({ openId, data: clone(settings.data) });
        server.handle(settings.data, openId).then((result) => settings.success({ result }), settings.fail);
      }
    } };
  }
  const config = { cloudEnv: 'integration-test', sharingFunctionName: 'location-share' };
  const owner = createLocationSharing({ wx: platform('owner-openid'), config, now: () => NOW, timers });
  const guest = createLocationSharing({ wx: platform('guest-openid'), config, now: () => NOW, timers });
  async function settle() { await new Promise(setImmediate); }
  async function publishDue() {
    for (const [id, task] of [...tasks]) {
      if (!task.interval && task.delay === 0) {
        tasks.delete(id);
        task.callback();
      }
    }
    await settle();
  }
  try {
    assert.equal((await owner.create()).phase, 'active');
    const parameters = new URL('https://example.test' + owner.invitePath()).searchParams;
    assert.equal((await guest.join({ roomId: parameters.get('roomId'), inviteToken: parameters.get('inviteToken') })).phase, 'active');
    assert.equal((await owner.startPublishing()).sharing, true);
    assert.equal(owner.updateLocation({ latitude: 0, longitude: 0, timestamp: NOW, accuracy: 5 }), true);
    await publishDue();
    guest.resumePolling();
    await settle();
    const ownerMember = guest.snapshot().room.members.find((member) => member.role === 'owner');
    assert.equal(ownerMember.live, true);
    assert.equal(ownerMember.location.latitude, 0);
    assert.equal(ownerMember.location.longitude, 0);
    assert.equal(JSON.stringify(guest.snapshot()).includes('owner-openid'), false);
    assert.equal((await guest.startPublishing()).sharing, true);
    guest.updateLocation({ latitude: 31.2304, longitude: 121.4737, timestamp: NOW, accuracy: 6 });
    await publishDue();
    owner.resumePolling();
    await settle();
    assert.equal(owner.snapshot().room.members.filter((member) => member.live).length, 2);
    const sent = requests.find((request) => request.openId === 'owner-openid' && request.data.action === 'publish');
    const paused = await owner.pausePublishing();
    assert.equal(paused.pendingStop, false, 'client passes the lease required by backend pause');
    const late = await server.handle(Object.assign({}, sent.data, { sequence: sent.data.sequence + 1 }), 'owner-openid');
    assert.equal(late.code, 'STALE_LEASE');
    guest.resumePolling();
    await settle();
    assert.equal(guest.snapshot().room.members.find((member) => member.role === 'owner').location, null);
    await owner.close();
    guest.resumePolling();
    await settle();
    assert.equal(guest.snapshot().phase, 'closed');
    assert.deepEqual(guest.snapshot().room.members, []);
  } finally {
    await owner.destroy();
    await guest.destroy();
  }
});
