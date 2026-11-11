const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLocationShareService, ROOM_LIFETIME_MS } = require('../cloudfunctions/location-share/service');
const { createCloudRepository } = require('../cloudfunctions/location-share/repository');

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function setup() {
  let timestamp = 1700000000000;
  let nextToken = 0;
  let queue = Promise.resolve();
  const rooms = new Map();
  const repository = {
    mutate(id, update) {
      const operation = queue.then(() => {
        const result = update(copy(rooms.get(id) || null));
        if (result.room) rooms.set(id, copy(result.room));
        return copy(result.value);
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
  const service = createLocationShareService({
    repository,
    now: () => timestamp,
    randomBytes(size) { return Buffer.alloc(size, ++nextToken); }
  });
  return {
    service,
    rooms,
    setTime(value) { timestamp = value; },
    advance(milliseconds) { timestamp += milliseconds; },
    now: () => timestamp,
    call: (action, user, data = {}) => service.execute(Object.assign({ action }, data), user),
    fix(overrides = {}) {
      return Object.assign({ latitude: 22.543096, longitude: 114.057865, accuracy: 8, timestamp }, overrides);
    }
  };
}

async function joined(setupValue) {
  const owner = await setupValue.call('create', 'owner');
  const request = { roomId: owner.roomId, inviteToken: owner.inviteToken };
  const guest = await setupValue.call('join', 'guest', request);
  return { owner, guest, request };
}

function rejectsCode(promise, code) {
  return assert.rejects(promise, (error) => error.code === code);
}

test('create returns a short-lived invitation with no positions or exposed identities', async () => {
  const app = setup();
  const room = await app.call('create', 'trusted-owner');
  assert.match(room.roomId, /^[a-f0-9]{32}$/);
  assert.match(room.inviteToken, /^[a-f0-9]{32}$/);
  assert.equal(room.expiresAt - room.serverTime, ROOM_LIFETIME_MS);
  assert.equal(room.members.length, 1);
  assert.equal(room.members[0].sharing, false);
  assert.equal(room.members[0].location, null);
  assert.equal(JSON.stringify(room).includes('trusted-owner'), false);
  assert.equal(room.selfId, room.ownerId);
  const stored = app.rooms.get(room.roomId);
  assert.equal(JSON.stringify(stored).includes(room.inviteToken), false);
  assert.equal(stored.inviteHash.length, 64);
});

test('identity must come from the server context and forged client identity fields have no effect', async () => {
  const app = setup();
  await rejectsCode(app.service.execute({ action: 'create', openId: 'owner' }, ''), 'UNAUTHENTICATED');
  const room = await app.call('create', 'owner');
  await rejectsCode(app.call('poll', 'outsider', { roomId: room.roomId, openId: 'owner' }), 'NOT_MEMBER');
  await rejectsCode(app.call('close', 'outsider', { roomId: room.roomId, openId: 'owner' }), 'NOT_MEMBER');
});

test('a room ID alone cannot reveal locations or grant membership', async () => {
  const app = setup();
  const { owner, request } = await joined(app);
  const started = await app.call('start', 'owner', request);
  await app.call('publish', 'owner', { roomId: owner.roomId, lease: started.lease, sequence: 1, location: app.fix() });
  await rejectsCode(app.call('join', 'unknown', { roomId: owner.roomId, inviteToken: '0'.repeat(32) }), 'INVITE_INVALID');
  await rejectsCode(app.call('poll', 'unknown', request), 'NOT_MEMBER');
  const guestView = await app.call('poll', 'guest', request);
  assert.equal(guestView.members.find((member) => member.id === owner.selfId).location.latitude, 22.543096);
});

test('explicit join does not start publishing and repeat joins are membership-idempotent', async () => {
  const app = setup();
  const { guest, request } = await joined(app);
  const second = await app.call('join', 'guest', request);
  assert.equal(second.selfId, guest.selfId);
  assert.equal(second.members.length, 2);
  assert.equal(second.members.find((member) => member.id === guest.selfId).sharing, false);
  assert.equal(second.lease, undefined);
  assert.equal(second.inviteToken, undefined);
});

test('concurrent joins enforce the eight-member limit without losing accepted members', async () => {
  const app = setup();
  const owner = await app.call('create', 'owner');
  const request = { roomId: owner.roomId, inviteToken: owner.inviteToken };
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => app.call('join', `guest-${index}`, request)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 7);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'ROOM_FULL'));
  const room = await app.call('poll', 'owner', request);
  assert.equal(room.members.length, 8);
  assert.equal(new Set(room.members.map((member) => member.id)).size, 8);
});

test('each user can publish only their own position through their own lease', async () => {
  const app = setup();
  const { owner, guest, request } = await joined(app);
  const leaseOwner = await app.call('start', 'owner', request);
  const leaseGuest = await app.call('start', 'guest', request);
  await rejectsCode(app.call('publish', 'guest', {
    roomId: owner.roomId, lease: leaseOwner.lease, sequence: 1, memberId: owner.selfId, location: app.fix()
  }), 'STALE_LEASE');
  const updated = await app.call('publish', 'guest', {
    roomId: owner.roomId, lease: leaseGuest.lease, sequence: 1, memberId: owner.selfId, location: app.fix({ latitude: 0, longitude: 0 })
  });
  assert.equal(updated.members.find((member) => member.id === guest.selfId).location.latitude, 0);
  assert.equal(updated.members.find((member) => member.id === owner.selfId).location, null);
  assert.equal(JSON.stringify(app.rooms.get(owner.roomId)).includes(leaseGuest.lease), false);
  const polled = await app.call('poll', 'owner', request);
  assert.equal(polled.lease, undefined);
});

test('pause immediately clears the server position and old in-flight publishes cannot restore it', async () => {
  const app = setup();
  const { owner, request } = await joined(app);
  const started = await app.call('start', 'owner', request);
  const publish = { roomId: owner.roomId, lease: started.lease, sequence: 1, location: app.fix() };
  await app.call('publish', 'owner', publish);
  const paused = await app.call('pause', 'owner', Object.assign({}, request, { lease: started.lease }));
  const own = paused.members.find((member) => member.id === owner.selfId);
  assert.equal(own.location, null);
  assert.equal(own.sharing, false);
  await rejectsCode(app.call('publish', 'owner', Object.assign({}, publish, { sequence: 2 })), 'STALE_LEASE');
  const stored = app.rooms.get(owner.roomId).members[owner.selfId];
  assert.equal(stored.location, null);
  assert.equal(stored.leaseHash, null);
  assert.equal((await app.call('pause', 'owner', request)).members.find((member) => member.id === owner.selfId).sharing, false);
});

test('resume receives a fresh lease so a previous sharing generation stays revoked', async () => {
  const app = setup();
  const room = await app.call('create', 'owner');
  const args = { roomId: room.roomId };
  const old = await app.call('start', 'owner', args);
  await app.call('pause', 'owner', Object.assign({}, args, { lease: old.lease }));
  const current = await app.call('start', 'owner', args);
  assert.notEqual(old.lease, current.lease);
  await rejectsCode(app.call('publish', 'owner', {
    roomId: room.roomId, lease: old.lease, sequence: 2, location: app.fix()
  }), 'STALE_LEASE');
  await app.call('publish', 'owner', { roomId: room.roomId, lease: current.lease, sequence: 1, location: app.fix() });
});

test('an old page delayed pause cannot revoke a replacement page fresh lease', async () => {
  const app = setup();
  const room = await app.call('create', 'owner');
  const request = { roomId: room.roomId };
  const previous = await app.call('start', 'owner', request);
  const current = await app.call('start', 'owner', request);
  await app.call('publish', 'owner', {
    roomId: room.roomId, lease: current.lease, sequence: 1, location: app.fix()
  });
  await rejectsCode(app.call('pause', 'owner', Object.assign({}, request, { lease: previous.lease })), 'STALE_LEASE');
  await rejectsCode(app.call('pause', 'owner', request), 'STALE_LEASE');
  const poll = await app.call('poll', 'owner', request);
  assert.equal(poll.members[0].sharing, true);
  assert.equal(poll.members[0].live, true);
  assert.equal(poll.members[0].location.latitude, 22.543096);
});

test('replayed sequences and recaptured old samples cannot refresh a location', async () => {
  const app = setup();
  const room = await app.call('create', 'owner');
  const started = await app.call('start', 'owner', { roomId: room.roomId });
  const input = { roomId: room.roomId, lease: started.lease, sequence: 1, location: app.fix() };
  await app.call('publish', 'owner', input);
  app.advance(1000);
  await rejectsCode(app.call('publish', 'owner', input), 'STALE_SEQUENCE');
  await rejectsCode(app.call('publish', 'owner', Object.assign({}, input, { sequence: 2 })), 'STALE_LOCATION');
  const updated = await app.call('publish', 'owner', Object.assign({}, input, { sequence: 2, location: app.fix() }));
  assert.equal(updated.members[0].location.updatedAt, app.now());
});

test('invalid, inaccurate, stale and future fixes are rejected before mutation', async () => {
  const app = setup();
  const room = await app.call('create', 'owner');
  const started = await app.call('start', 'owner', { roomId: room.roomId });
  const input = { roomId: room.roomId, lease: started.lease, sequence: 1 };
  for (const location of [app.fix({ latitude: 91 }), app.fix({ longitude: NaN }), app.fix({ accuracy: 51 }), app.fix({ accuracy: null })]) {
    await rejectsCode(app.call('publish', 'owner', Object.assign({}, input, { location })), 'INVALID_LOCATION');
  }
  await rejectsCode(app.call('publish', 'owner', Object.assign({}, input, { location: app.fix({ timestamp: app.now() - 30001 }) })), 'STALE_LOCATION');
  await rejectsCode(app.call('publish', 'owner', Object.assign({}, input, { location: app.fix({ timestamp: app.now() + 5001 }) })), 'STALE_LOCATION');
  assert.equal(app.rooms.get(room.roomId).members[room.selfId].location, null);
});

test('polling hides stale positions instead of labelling old coordinates as live', async () => {
  const app = setup();
  const { owner, request } = await joined(app);
  const started = await app.call('start', 'owner', request);
  await app.call('publish', 'owner', { roomId: owner.roomId, lease: started.lease, sequence: 1, location: app.fix() });
  app.advance(30001);
  const view = await app.call('poll', 'guest', request);
  const own = view.members.find((member) => member.id === owner.selfId);
  assert.equal(own.live, false);
  assert.equal(own.location, null);
});

test('leave removes member coordinates and rejoining never revives an earlier lease', async () => {
  const app = setup();
  const { guest, request } = await joined(app);
  const started = await app.call('start', 'guest', request);
  await app.call('publish', 'guest', { roomId: request.roomId, lease: started.lease, sequence: 1, location: app.fix() });
  const left = await app.call('leave', 'guest', request);
  assert.deepEqual(left.members, []);
  assert.equal(app.rooms.get(request.roomId).members[guest.selfId], undefined);
  await rejectsCode(app.call('poll', 'guest', request), 'NOT_MEMBER');
  const rejoined = await app.call('join', 'guest', request);
  assert.equal(rejoined.members.find((member) => member.id === guest.selfId).location, null);
  await rejectsCode(app.call('publish', 'guest', { roomId: request.roomId, lease: started.lease, sequence: 2, location: app.fix() }), 'STALE_LEASE');
});

test('only the trusted creator can close and closing clears every coordinate and lease', async () => {
  const app = setup();
  const { owner, request } = await joined(app);
  const started = await app.call('start', 'owner', request);
  await app.call('publish', 'owner', { roomId: owner.roomId, lease: started.lease, sequence: 1, location: app.fix() });
  await rejectsCode(app.call('close', 'guest', request), 'FORBIDDEN');
  const closed = await app.call('close', 'owner', request);
  assert.equal(closed.status, 'closed');
  assert.ok(closed.members.every((member) => !member.sharing && !member.live && member.location === null));
  assert.equal(app.rooms.get(owner.roomId).inviteHash, null);
  await rejectsCode(app.call('start', 'guest', request), 'ROOM_CLOSED');
  await rejectsCode(app.call('join', 'new-guest', request), 'ROOM_CLOSED');
  await rejectsCode(app.call('publish', 'owner', { roomId: owner.roomId, lease: started.lease, sequence: 2, location: app.fix() }), 'ROOM_CLOSED');
  const view = await app.call('poll', 'guest', request);
  assert.ok(view.members.every((member) => member.location === null));
});

test('creator leaving ends the room so remaining members cannot keep it active', async () => {
  const app = setup();
  const { owner, request } = await joined(app);
  await app.call('leave', 'owner', request);
  const view = await app.call('poll', 'guest', request);
  assert.equal(view.status, 'closed');
  assert.ok(view.members.every((member) => member.location === null));
  assert.equal(app.rooms.get(owner.roomId).members[owner.selfId], undefined);
});

test('expiry is enforced for every read and write even if the document still exists', async () => {
  const app = setup();
  const { owner, request } = await joined(app);
  const started = await app.call('start', 'owner', request);
  await app.call('publish', 'owner', { roomId: owner.roomId, lease: started.lease, sequence: 1, location: app.fix() });
  app.setTime(owner.expiresAt);
  for (const action of ['poll', 'join', 'start', 'pause', 'close', 'leave']) {
    await rejectsCode(app.call(action, 'owner', request), 'ROOM_EXPIRED');
  }
  const result = await app.service.handle({ action: 'poll', roomId: owner.roomId }, 'owner');
  assert.equal(result.code, 'ROOM_EXPIRED');
  assert.equal(result.data, null);
  assert.equal(JSON.stringify(result).includes('latitude'), false);
});

test('safe envelopes hide storage failures and validate unsupported inputs', async () => {
  const app = setup();
  assert.equal((await app.service.handle({ action: 'unknown' }, 'owner')).code, 'INVALID_REQUEST');
  assert.equal((await app.service.handle(null, 'owner')).code, 'INVALID_REQUEST');
  assert.equal((await app.service.handle({ action: 'poll', roomId: 'invalid' }, 'owner')).code, 'INVALID_REQUEST');
  const broken = createLocationShareService({ repository: { mutate: async () => { throw new Error('secret database failure'); } } });
  const response = await broken.handle({ action: 'create' }, 'owner');
  assert.equal(response.code, 'INTERNAL_ERROR');
  assert.equal(response.message.includes('secret'), false);
});

test('cloud repository uses one transaction and the WeChat SDK data wrapper', async () => {
  let transactions = 0;
  const writes = [];
  const database = {
    async runTransaction(operation) {
      transactions += 1;
      return operation({ collection(name) {
        assert.equal(name, 'share_rooms');
        return { doc(id) {
          assert.equal(id, 'room');
          return {
            get: async () => ({ data: { _id: 'room', value: 1 } }),
            set: async (input) => writes.push(input)
          };
        } };
      } });
    }
  };
  const result = await createCloudRepository(database).mutate('room', (room) => ({ room: Object.assign(room, { value: 2 }), value: 'done' }));
  assert.equal(result, 'done');
  assert.equal(transactions, 1);
  assert.deepEqual(writes, [{ data: { value: 2 } }]);
});

test('cloud repository handles only missing-document errors and never swallows permission errors', async () => {
  function database(error) {
    return { runTransaction: async (operation) => operation({ collection: () => ({ doc: () => ({
      get: async () => { throw error; }, set: async () => {}
    }) }) }) };
  }
  const missing = createCloudRepository(database({ code: 'DATABASE_DOCUMENT_NOT_EXIST' }));
  assert.equal(await missing.mutate('new', (room) => ({ value: room })), null);
  const denied = createCloudRepository(database({ code: 'DATABASE_PERMISSION_DENIED' }));
  await assert.rejects(denied.mutate('new', () => ({ value: true })), (error) => error.code === 'DATABASE_PERMISSION_DENIED');
});

test('deployed handler authenticates from getWXContext instead of request fields', async () => {
  let handlerInput;
  const moduleObject = { exports: {} };
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, database() { return {}; },
    getWXContext() { return { OPENID: 'server-trusted' }; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cloudfunctions/location-share/index.js'), 'utf8'), {
    exports: moduleObject.exports,
    require(name) {
      if (name === 'wx-server-sdk') return cloud;
      if (name === './repository') return { createCloudRepository: () => ({}) };
      if (name === './service') return { createLocationShareService: () => ({ handle(event, openId) {
        handlerInput = { event, openId };
        return { code: 0, data: null };
      } }) };
      throw new Error('Unexpected dependency');
    }
  });
  await moduleObject.exports.main({ action: 'create', openId: 'forged-user' });
  assert.equal(handlerInput.openId, 'server-trusted');
  assert.equal(handlerInput.event.openId, 'forged-user');
});
