const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocationSharing } = require('../miniprogram/services/location-sharing');

const ROOM_ID = 'a'.repeat(32);
const INVITE = 'b'.repeat(32);
const LEASE = 'c'.repeat(32);
const OTHER_LEASE = 'd'.repeat(32);
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness(overrides = {}, options = {}) {
  let timestamp = 100000;
  let nextTimer = 0;
  let currentLease = LEASE;
  const timers = new Map();
  const calls = [];
  const changes = [];
  const room = {
    roomId: ROOM_ID, expiresAt: timestamp + 1800000, serverTime: timestamp, status: 'active',
    selfId: 'self', ownerId: 'self',
    members: [{ id: 'self', label: '发起人', role: 'owner', sharing: false, location: null, live: false }]
  };
  function dataFor(action, data) {
    if (action === 'start') {
      room.members[0].sharing = true;
      room.members[0].location = null;
    }
    if (action === 'publish') {
      room.members[0].location = {
        latitude: data.location.latitude, longitude: data.location.longitude,
        accuracy: data.location.accuracy, sampledAt: data.location.timestamp, updatedAt: timestamp
      };
      room.members[0].live = true;
    }
    if (action === 'pause') {
      if (room.members[0].sharing && data.lease !== currentLease) {
        return { code: 'STALE_LEASE', message: '位置共享凭证已失效' };
      }
      room.members[0].sharing = false;
      room.members[0].location = null;
      room.members[0].live = false;
    }
    if (action === 'close') {
      room.status = 'closed';
      room.members.forEach((member) => { member.sharing = false; member.live = false; member.location = null; });
    }
    const response = Object.assign(clone(room), { serverTime: timestamp });
    if (action === 'create') response.inviteToken = INVITE;
    if (action === 'start') response.lease = currentLease;
    if (action === 'leave') response.members = [];
    return { code: 0, data: response };
  }
  const platform = {
    getLocation() { assert.fail('Sharing transport must not request native location'); },
    startLocationUpdate() { assert.fail('Sharing transport must not start native location'); },
    cloud: {
      init(config) { calls.push({ action: 'init', config }); },
      callFunction(request) {
        const action = request.data.action;
        calls.push({ action, data: clone(request.data) });
        const respond = () => request.success({ result: dataFor(action, request.data) });
        if (overrides[action]) overrides[action](request, respond);
        else respond();
      }
    }
  };
  function schedule(callback, delay, interval) {
    const id = ++nextTimer;
    timers.set(id, { callback, at: timestamp + delay, interval });
    return id;
  }
  const service = createLocationSharing(Object.assign({
    wx: platform,
    config: { cloudEnv: 'test-env', sharingFunctionName: 'location-share' },
    now: () => timestamp,
    onChange(value) { changes.push(value); },
    timers: {
      setTimeout: (callback, delay) => schedule(callback, delay, 0),
      clearTimeout: (id) => timers.delete(id),
      setInterval: (callback, delay) => schedule(callback, delay, delay),
      clearInterval: (id) => timers.delete(id)
    }
  }, options));
  return {
    service, calls, changes, timers, room, platform,
    fix(extra = {}) { return Object.assign({ latitude: 22.543, longitude: 114.057, accuracy: 8, timestamp }, extra); },
    setLease(value) { currentLease = value; },
    now: () => timestamp,
    advance(milliseconds) {
      const target = timestamp + milliseconds;
      while (true) {
        const item = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!item) break;
        const [id, timer] = item;
        timestamp = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.callback();
      }
      timestamp = target;
    }
  };
}

async function flush() { for (let index = 0; index < 16; index += 1) await Promise.resolve(); }

test('constructing or joining a room does not start GPS or share any location', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.equal(h.service.snapshot().configured, true);
  assert.equal(h.service.invitePath(), '');
  const joined = await h.service.join({ roomId: ROOM_ID, inviteToken: INVITE });
  assert.equal(joined.phase, 'active');
  assert.equal(joined.sharing, false);
  assert.deepEqual(h.calls.map((item) => item.action), ['init', 'join']);
  assert.equal(h.service.updateLocation(h.fix()), false);
  await h.service.destroy();
});

test('missing cloud configuration fails explicitly without fake room data', async () => {
  const h = harness({}, { config: { cloudEnv: '' } });
  const result = await h.service.create();
  assert.equal(result.configured, false);
  assert.equal(result.room, null);
  assert.equal(result.errorCode, 'CLOUD_NOT_CONFIGURED');
  assert.equal(h.calls.length, 0);
});

test('malformed cloud room data becomes an actionable error instead of crashing the page', async () => {
  const h = harness({ create(request) { request.success({ result: { code: 0, data: { roomId: ROOM_ID, status: 'active', expiresAt: 200000, serverTime: 100000, members: [null] } } }); } });
  const result = await h.service.create();
  assert.equal(result.room, null);
  assert.equal(result.errorCode, 'SHARING_BAD_RESPONSE');
  assert.equal(h.service.invitePath(), '');
});

test('invitations contain only room capability identifiers and snapshots never expose secrets', async () => {
  const h = harness();
  await h.service.create();
  await h.service.startPublishing();
  const path = h.service.invitePath();
  assert.equal(path, `/pages/location-share/index?roomId=${ROOM_ID}&inviteToken=${INVITE}`);
  assert.equal(/latitude|longitude|timestamp/.test(path), false);
  const serialized = JSON.stringify(h.service.snapshot());
  assert.equal(serialized.includes(INVITE), false);
  assert.equal(serialized.includes(LEASE), false);
  assert.equal(h.calls.filter((item) => item.action === 'init').length, 1);
  await h.service.destroy();
});

test('only fresh accurate fixes are published and busy periods coalesce to the newest sample', async () => {
  const h = harness();
  await h.service.create();
  await h.service.startPublishing();
  assert.equal(h.service.updateLocation(h.fix({ latitude: 0, longitude: 0 })), true);
  h.advance(0);
  await flush();
  assert.equal(h.calls.filter((item) => item.action === 'publish').length, 1);
  assert.equal(h.service.updateLocation(h.fix({ accuracy: null })), false);
  assert.equal(h.service.updateLocation(h.fix({ accuracy: 51 })), false);
  assert.equal(h.service.updateLocation(h.fix({ timestamp: h.now() - 31000 })), false);
  assert.equal(h.service.updateLocation(h.fix({ timestamp: h.now() + 6000 })), false);
  assert.equal(h.service.updateLocation(h.fix()), false, 'same sample is not uploaded twice');
  h.advance(1000);
  h.service.updateLocation(h.fix({ latitude: 22.544 }));
  h.advance(1000);
  h.service.updateLocation(h.fix({ latitude: 22.545 }));
  h.advance(1000);
  await flush();
  const publications = h.calls.filter((item) => item.action === 'publish');
  assert.equal(publications.length, 2);
  assert.equal(publications[1].data.location.latitude, 22.545);
  assert.equal(publications[1].data.location.timestamp, 102000);
  assert.deepEqual(publications.map((item) => item.data.sequence), [1, 2]);
  await h.service.destroy();
});

test('stopping revokes the exact lease and a late publish response cannot restore sharing', async () => {
  let latePublish;
  const h = harness({ publish(request) { latePublish = request; } });
  await h.service.create();
  await h.service.startPublishing();
  h.service.updateLocation(h.fix());
  h.advance(0);
  await flush();
  const stopped = await h.service.pausePublishing();
  assert.equal(stopped.sharing, false);
  assert.equal(stopped.pendingStop, false);
  assert.equal(h.calls.find((item) => item.action === 'pause').data.lease, LEASE);
  const old = clone(h.room);
  old.members[0].sharing = true;
  old.members[0].live = true;
  old.members[0].location = { latitude: 1, longitude: 2, accuracy: 8, sampledAt: h.now(), updatedAt: h.now() };
  latePublish.success({ result: { code: 0, data: old } });
  await flush();
  assert.equal(h.service.snapshot().sharing, false);
  assert.equal(h.service.snapshot().room.members[0].location, null);
  await h.service.destroy();
});

test('suspending during a delayed start cleans up its returned lease without enabling publishing', async () => {
  let finishStart;
  const h = harness({ start(request, respond) { finishStart = respond; } });
  await h.service.create();
  const starting = h.service.startPublishing();
  await flush();
  const hidden = h.service.suspend();
  assert.equal(h.service.snapshot().sharing, false);
  finishStart();
  await starting;
  await hidden;
  assert.equal(h.calls.find((item) => item.action === 'pause').data.lease, LEASE);
  assert.equal(h.service.snapshot().pendingStop, false);
  assert.equal(h.service.updateLocation(h.fix()), false);
  h.service.resumePolling();
  await flush();
  assert.equal(h.service.snapshot().sharing, false, 'returning only refreshes the room');
  await h.service.destroy();
});

test('failed stop remains visibly unconfirmed and can be retried', async () => {
  let failPause = true;
  const h = harness({ pause(request, respond) { if (failPause) request.fail({}); else respond(); } });
  await h.service.create();
  await h.service.startPublishing();
  const failed = await h.service.pausePublishing();
  assert.equal(failed.sharing, false);
  assert.equal(failed.pendingStop, true);
  assert.equal(failed.errorCode, 'SHARING_NETWORK_ERROR');
  assert.equal(h.service.updateLocation(h.fix()), false);
  failPause = false;
  const stopped = await h.service.pausePublishing();
  assert.equal(stopped.pendingStop, false);
  assert.equal(stopped.room.members[0].sharing, false);
  await h.service.destroy();
});

test('a newer page lease makes an old known lease harmless without stopping the new page', async () => {
  const h = harness();
  await h.service.create();
  await h.service.startPublishing();
  h.setLease(OTHER_LEASE);
  const stopped = await h.service.pausePublishing();
  assert.equal(stopped.sharing, false);
  assert.equal(stopped.pendingStop, false);
  assert.equal(h.room.members[0].sharing, true, 'new page membership is untouched');
  await h.service.destroy();
});

test('old cached samples age out offline using capture time rather than recent publish time', async () => {
  let failPoll = false;
  const h = harness({ poll(request, respond) { if (failPoll) request.fail({}); else respond(); } });
  h.room.members.push({ id: 'friend', label: '好友 1', role: 'member', sharing: true, live: true,
    location: { latitude: 31, longitude: 121, accuracy: 8, sampledAt: 80000, updatedAt: 100000 } });
  await h.service.create();
  assert.ok(h.service.snapshot().room.members[1].location);
  failPoll = true;
  h.advance(11000);
  await flush();
  assert.equal(h.service.snapshot().room.members[1].location, null);
  assert.equal(h.service.snapshot().room.members[1].live, false);
  assert.equal(h.service.snapshot().room.serverTime, 111000, 'view clock advances without inventing a new location sample');
  await h.service.destroy();
});

test('local expiry removes every position and sharing capability even if the network is unavailable', async () => {
  const h = harness({ poll(request) { request.fail({}); } });
  h.room.expiresAt = h.now() + 5000;
  await h.service.create();
  await h.service.startPublishing();
  h.advance(5000);
  await flush();
  const expired = h.service.snapshot();
  assert.equal(expired.phase, 'expired');
  assert.equal(expired.sharing, false);
  assert.equal(expired.room.members.length, 0);
  assert.equal(h.service.invitePath(), '');
  assert.equal(h.service.updateLocation(h.fix()), false);
  await h.service.destroy();
});

test('server closure clears live positions and rejects later publications', async () => {
  const h = harness({ poll(request) { request.success({ result: { code: 'ROOM_CLOSED', message: '本次共享已结束' } }); } });
  await h.service.create();
  await h.service.startPublishing();
  h.advance(3000);
  await flush();
  assert.equal(h.service.snapshot().phase, 'closed');
  assert.equal(h.service.snapshot().sharing, false);
  assert.equal(h.service.snapshot().room.members.length, 0);
  assert.equal(h.service.updateLocation(h.fix()), false);
  await h.service.destroy();
});

test('timed-out start never claims sharing or successful cleanup without the missing lease', async () => {
  const h = harness({ start() {} }, { requestTimeoutMs: 1000 });
  await h.service.create();
  const starting = h.service.startPublishing();
  await flush();
  h.advance(1000);
  await starting;
  assert.equal(h.service.snapshot().sharing, false);
  assert.equal(h.service.snapshot().pendingStop, true);
  assert.equal(h.service.snapshot().errorCode, 'SHARING_TIMEOUT');
  await h.service.close();
  assert.equal(h.service.snapshot().pendingStop, false);
  assert.equal(h.service.snapshot().phase, 'closed');
  await h.service.destroy();
});

test('destroy removes timers and suppresses callbacks while completing server revocation', async () => {
  const h = harness();
  await h.service.create();
  await h.service.startPublishing();
  const before = h.changes.length;
  await h.service.destroy();
  const after = h.changes.length;
  h.advance(60000);
  await flush();
  assert.equal(after, before + 1, 'only the immediate stopping state can be observed before disposal');
  assert.equal(h.changes.length, after);
  assert.equal(h.timers.size, 0);
  assert.equal(h.service.updateLocation(h.fix()), false);
  assert.equal(h.room.members[0].sharing, false);
});
