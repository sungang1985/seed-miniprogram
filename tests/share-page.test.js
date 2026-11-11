const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INVITE = { roomId: 'a'.repeat(32), inviteToken: 'b'.repeat(32) };
const INVITE_PATH = `/pages/location-share/index?roomId=${INVITE.roomId}&inviteToken=${INVITE.inviteToken}`;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function exampleRoom() {
  return {
    roomId: INVITE.roomId, expiresAt: 1800000, serverTime: 10000, status: 'active', selfId: 'self', ownerId: 'owner',
    members: [
      { id: 'self', label: '好友1', role: 'member', sharing: false, location: null, live: false },
      { id: 'owner', label: '发起人', role: 'owner', sharing: true, location: { latitude: 0, longitude: 0, accuracy: 8, sampledAt: 9000, updatedAt: 9000 }, live: true },
      { id: 'old', label: '好友2', role: 'member', sharing: true, location: { latitude: 23, longitude: 115, updatedAt: 0 }, live: false }
    ]
  };
}

function loadPage(options = {}) {
  let definition;
  let sharingSubscriber;
  let gpsSubscriber;
  let shared = { configured: options.configured !== false, phase: 'idle', room: null, sharing: false, pendingStop: false, errorMessage: '', errorCode: '', busyAction: '' };
  let gps = { status: 'idle', currentLocation: null, waitingForLocation: false, errorMessage: '', errorCode: '', nativeStopFailed: false };
  const calls = [];
  const updates = [];
  function emitSharing(patch) {
    shared = Object.assign({}, shared, clone(patch));
    if (sharingSubscriber) sharingSubscriber(clone(shared));
    return clone(shared);
  }
  function emitGps(patch) {
    gps = Object.assign({}, gps, clone(patch));
    if (gpsSubscriber) gpsSubscriber(clone(gps));
    return clone(gps);
  }
  const sharing = {
    snapshot() { return clone(shared); },
    async join(invite) { calls.push({ method: 'join', invite }); return emitSharing({ phase: 'active', room: exampleRoom() }); },
    async startPublishing() {
      calls.push({ method: 'startPublishing' });
      if (options.startPublishing) return options.startPublishing(emitSharing);
      return emitSharing({ sharing: true });
    },
    updateLocation(fix) { calls.push({ method: 'updateLocation', fix: clone(fix) }); },
    async pausePublishing() {
      calls.push({ method: 'pausePublishing' });
      return emitSharing({ sharing: false, pendingStop: options.pauseFailure || false, errorMessage: options.pauseFailure ? '位置尚未撤回，请重试' : '' });
    },
    async leave() {
      calls.push({ method: 'leave' });
      return options.leaveFailure ? emitSharing({ pendingStop: true, errorMessage: '退出失败，请重试' }) : emitSharing({ phase: 'idle', room: null, sharing: false });
    },
    async close() { calls.push({ method: 'close' }); return emitSharing({ phase: 'closed', sharing: false, room: null }); },
    async suspend() { calls.push({ method: 'suspend' }); return emitSharing({ sharing: false }); },
    async resumePolling() { calls.push({ method: 'resumePolling' }); return clone(shared); },
    async destroy() { calls.push({ method: 'destroySharing' }); },
    invitePath() { return shared.room && shared.phase === 'active' ? INVITE_PATH : ''; }
  };
  const tracker = {
    snapshot() { return clone(gps); },
    async start() {
      calls.push({ method: 'startGps' });
      return emitGps(options.gpsDenied ? { status: 'paused', errorMessage: '未获得定位权限', errorCode: 'LOCATION_PERMISSION_DENIED' } : { status: 'recording', waitingForLocation: true });
    },
    async resume() { calls.push({ method: 'resumeGps' }); return emitGps({ status: 'recording', waitingForLocation: true }); },
    async pause(reason) { calls.push({ method: 'pauseGps', reason }); return emitGps({ status: 'paused', waitingForLocation: false, errorMessage: reason || '' }); },
    async destroy() { calls.push({ method: 'destroyGps' }); }
  };
  const modules = {
    '../../services/location-sharing': { createLocationSharing(settings) { calls.push({ method: 'createSharing' }); sharingSubscriber = settings.onChange; return sharing; } },
    '../../services/location-tracker': { createTracker(settings) { calls.push({ method: 'createTracker' }); gpsSubscriber = settings.onChange; return tracker; } }
  };
  const filename = path.join(__dirname, '../miniprogram/pages/location-share/index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value; },
    require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected page module ${name}`); return modules[name]; },
    wx: {
      switchTab(settings) { calls.push({ method: 'switchTab', settings }); },
      showToast(settings) { calls.push({ method: 'showToast', settings }); },
      showModal(settings) { calls.push({ method: 'showModal', settings }); if (settings.success) settings.success({ confirm: options.confirm !== false }); },
      openSetting(settings) { calls.push({ method: 'openSetting' }); if (settings.success) settings.success({}); },
      createMapContext() { return { moveToLocation(settings) { calls.push({ method: 'moveToLocation', settings }); } }; },
      getLocation() { assert.fail('The page must use only the explicit tracker service for GPS'); }
    },
    console,
    Date
  }, { filename });
  assert.ok(definition);
  const page = Object.assign({}, definition, {
    data: clone(definition.data),
    setData(patch, callback) { updates.push(clone(patch)); Object.assign(this.data, clone(patch)); if (callback) callback.call(this); }
  });
  page.onLoad(options.invite || INVITE);
  return { page, calls, updates, emitSharing, emitGps, sharing, tracker };
}

test('opening an invitation constructs controllers without joining, reading peers or starting GPS', () => {
  const { page, calls } = loadPage();
  assert.equal(page.data.inviteValid, true);
  assert.equal(page.data.joined, false);
  assert.equal(page.data.markers.length, 0);
  assert.deepEqual(calls.map((call) => call.method), ['createSharing', 'createTracker']);
});

test('malformed invitations cannot invoke the join API', async () => {
  const { page, calls } = loadPage({ invite: { roomId: 'not-valid', inviteToken: 'broken' } });
  await page.onJoinRoom();
  assert.equal(page.data.inviteValid, false);
  assert.equal(calls.some((call) => call.method === 'join'), false);
});

test('explicit join exposes only live peers and keeps viewing separate from sharing my location', async () => {
  const { page, calls } = loadPage();
  await page.onJoinRoom();
  assert.equal(page.data.joined, true);
  assert.equal(page.data.markers.length, 1);
  assert.equal(page.data.markers[0].latitude, 0);
  assert.equal(page.data.markers[0].longitude, 0);
  assert.equal(page.data.latitude, 0);
  assert.equal(page.data.longitude, 0);
  assert.equal(page.data.members.find((member) => member.id === 'old').live, false);
  assert.equal(calls.some((call) => call.method === 'startGps' || call.method === 'startPublishing'), false);
});

test('own sharing acquires a publishing lease before GPS and forwards only valid fresh fixes', async () => {
  const { page, calls, emitGps } = loadPage();
  await page.onJoinRoom();
  await page.onStartOwnSharing();
  const order = calls.map((call) => call.method);
  assert.ok(order.indexOf('startPublishing') < order.indexOf('startGps'));
  assert.equal(page.data.sharing, true);
  assert.equal(calls.some((call) => call.method === 'updateLocation'), false);
  emitGps({ status: 'recording', waitingForLocation: false, currentLocation: { latitude: 0, longitude: 0, timestamp: Date.now(), accuracy: 7 } });
  assert.equal(calls.filter((call) => call.method === 'updateLocation').length, 1);
  await page.onStopOwnSharing();
  emitGps({ currentLocation: { latitude: 1, longitude: 2, timestamp: Date.now(), accuracy: 7 } });
  assert.equal(calls.filter((call) => call.method === 'updateLocation').length, 1);
});

test('a denied GPS permission revokes publishing and offers settings without inventing a point', async () => {
  const { page, calls } = loadPage({ gpsDenied: true });
  await page.onJoinRoom();
  await page.onStartOwnSharing();
  assert.equal(page.data.sharing, false);
  assert.equal(page.data.canOpenSettings, true);
  assert.equal(calls.some((call) => call.method === 'pausePublishing'), true);
  assert.equal(calls.some((call) => call.method === 'updateLocation'), false);
});

test('hiding suspends sharing and GPS while showing the page resumes polling only', async () => {
  const { page, calls } = loadPage();
  await page.onJoinRoom();
  await page.onStartOwnSharing();
  await page.onHide();
  const before = calls.filter((call) => call.method === 'startGps' || call.method === 'resumeGps').length;
  page.onShow();
  assert.equal(calls.some((call) => call.method === 'pauseGps'), true);
  assert.equal(calls.some((call) => call.method === 'suspend'), true);
  assert.equal(calls.some((call) => call.method === 'resumePolling'), true);
  assert.equal(calls.filter((call) => call.method === 'startGps' || call.method === 'resumeGps').length, before);
});

test('a delayed sharing start cannot launch GPS after the page was hidden', async () => {
  let complete;
  const { page, calls } = loadPage({ startPublishing: (emit) => new Promise((resolve) => { complete = () => resolve(emit({ sharing: true })); }) });
  await page.onJoinRoom();
  const pending = page.onStartOwnSharing();
  await page.onHide();
  complete();
  await pending;
  assert.equal(calls.some((call) => call.method === 'startGps' || call.method === 'resumeGps'), false);
});

test('expiry clears peer markers and stops an active local publisher', async () => {
  const { page, calls, emitSharing } = loadPage();
  await page.onJoinRoom();
  await page.onStartOwnSharing();
  emitSharing({ phase: 'expired', room: null, sharing: false });
  assert.equal(page.data.joined, false);
  assert.equal(page.data.markers.length, 0);
  assert.equal(page.data.members.length, 0);
  assert.equal(calls.some((call) => call.method === 'pauseGps'), true);
});

test('revoked publishing pauses GPS and prevents later samples from being forwarded', async () => {
  const { page, calls, emitSharing, emitGps } = loadPage();
  await page.onJoinRoom();
  await page.onStartOwnSharing();
  emitSharing({ sharing: false });
  emitGps({ status: 'recording', waitingForLocation: false, currentLocation: { latitude: 22, longitude: 114, timestamp: Date.now(), accuracy: 8 } });
  assert.equal(calls.filter((call) => call.method === 'pauseGps').length, 1);
  assert.equal(calls.some((call) => call.method === 'updateLocation'), false);
});

test('membership loss clears the shared map even when the service retains a closed room summary', async () => {
  const { page, emitSharing } = loadPage();
  await page.onJoinRoom();
  emitSharing({ phase: 'error', sharing: false, room: Object.assign(exampleRoom(), { status: 'closed', members: [] }), errorCode: 'NOT_MEMBER' });
  assert.equal(page.data.joined, false);
  assert.equal(page.data.markers.length, 0);
  assert.equal(page.data.members.length, 0);
});

test('a failed position withdrawal remains pending with visible retry feedback', async () => {
  const { page } = loadPage({ pauseFailure: true });
  await page.onJoinRoom();
  await page.onStartOwnSharing();
  await page.onStopOwnSharing();
  assert.equal(page.data.pendingStop, true);
  assert.match(page.data.pageError, /尚未撤回/);
  assert.equal(page.data.sharing, false);
});

test('failed leave keeps the room visible for retry instead of navigating away', async () => {
  const { page, calls } = loadPage({ leaveFailure: true });
  await page.onJoinRoom();
  await page.onLeaveRoom();
  assert.equal(page.data.joined, true);
  assert.equal(page.data.pendingStop, true);
  assert.equal(calls.some((call) => call.method === 'switchTab'), false);
});

test('only the explicit invite button includes capability parameters and every card uses a static image', async () => {
  const { page } = loadPage();
  await page.onJoinRoom();
  const generic = page.onShareAppMessage({ from: 'menu' });
  assert.equal(generic.path, '/pages/home/index');
  const invite = page.onShareAppMessage({ from: 'button', target: { id: 'invite-friend' } });
  assert.equal(invite.path, INVITE_PATH);
  assert.equal(invite.path.includes('latitude'), false);
  assert.equal(invite.path.includes('longitude'), false);
  assert.equal(invite.imageUrl, '/assets/share/location-invite.png');
  assert.equal(generic.imageUrl, invite.imageUrl);
});

test('unloading destroys both controllers and ignores later callbacks', async () => {
  const { page, calls, updates, emitSharing, emitGps } = loadPage();
  await page.onJoinRoom();
  await page.onUnload();
  const before = updates.length;
  emitSharing({ phase: 'expired', room: null });
  emitGps({ errorMessage: 'late event' });
  assert.equal(updates.length, before);
  assert.equal(calls.filter((call) => call.method === 'destroySharing').length, 1);
  assert.equal(calls.filter((call) => call.method === 'destroyGps').length, 1);
});
