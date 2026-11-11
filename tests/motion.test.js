const test = require('node:test');
const assert = require('node:assert/strict');
const { MotionTrack, haversineDistance } = require('../miniprogram/utils/motion');

function fix(latitude, longitude = 0, extra = {}) {
  return Object.assign({ latitude, longitude, accuracy: 5 }, extra);
}

test('haversine measures known equatorial distance and survives antipodal rounding', () => {
  assert.ok(Math.abs(haversineDistance(fix(0, 0), fix(0, 1)) - 111194.9266) < 0.1);
  assert.ok(Math.abs(haversineDistance(fix(0, 0), fix(0, 180)) - Math.PI * 6371000) < 0.01);
  assert.equal(haversineDistance(fix(90, 180), fix(90, 180)), 0);
  assert.ok(Number.isNaN(haversineDistance(fix(100), fix(0))));
});

test('recording retains zero coordinates, accumulates movement and returns independent snapshots', () => {
  const track = new MotionTrack();
  assert.equal(track.snapshot(0).status, 'idle');
  track.start(0);
  assert.equal(track.addLocation(fix(0, 0), 0).accepted, true);
  const result = track.addLocation(fix(0.0001, 0, { speed: 2 }), 5000);
  assert.equal(result.accepted, true);
  assert.ok(Math.abs(result.state.distanceMeters - 11.11949) < 0.001);
  assert.equal(result.state.currentSpeedMps, 2);
  assert.equal(result.state.durationMs, 5000);
  assert.equal(result.state.pointCount, 2);
  assert.ok(result.state.averageSpeedMps > 2);
  result.state.segments[0].points[0].latitude = 80;
  result.state.currentLocation.longitude = 90;
  const original = track.snapshot(5000);
  assert.equal(original.segments[0].points[0].latitude, 0);
  assert.equal(original.currentLocation.longitude, 0);
});

test('paused time is excluded and resumed segments never connect across a location gap', () => {
  const track = new MotionTrack();
  track.start(1000);
  track.addLocation(fix(0), 1000);
  track.addLocation(fix(0.0001), 6000);
  const distance = track.pause(11000).distanceMeters;
  assert.equal(track.addLocation(fix(1), 12000).reason, 'not-recording');
  assert.equal(track.snapshot(30000).durationMs, 10000);
  track.resume(31000);
  track.addLocation(fix(1), 31000);
  track.addLocation(fix(1.0001), 36000);
  const result = track.finish(41000);
  assert.equal(result.status, 'finished');
  assert.equal(result.durationMs, 20000);
  assert.equal(result.segments.length, 2);
  assert.ok(Math.abs(result.distanceMeters - distance * 2) < 0.0001);
  assert.equal(result.currentSpeedMps, 0);
  assert.equal(track.snapshot(100000).durationMs, 20000);
});

test('small successive moves accumulate against the previous accepted point while jitter stays filtered', () => {
  const track = new MotionTrack();
  track.start(0);
  track.addLocation(fix(0), 0);
  assert.equal(track.addLocation(fix(0.00001), 1000).reason, 'jitter');
  assert.equal(track.addLocation(fix(0.00002), 2000).reason, 'jitter');
  const third = track.addLocation(fix(0.00003), 3000);
  assert.equal(third.accepted, true);
  assert.equal(third.state.pointCount, 2);
  assert.ok(third.state.distanceMeters > 3);
  assert.equal(third.state.lastRejection, null);
});

test('poor fixes, invalid fields, out-of-order fixes and jumps cannot inflate distance', () => {
  const track = new MotionTrack();
  track.start(1000);
  track.addLocation(fix(0), 1000);
  assert.equal(track.addLocation(fix(91), 2000).reason, 'invalid-coordinate');
  assert.equal(track.addLocation(fix(0.0001, 0, { accuracy: Infinity }), 2000).reason, 'invalid-accuracy');
  assert.equal(track.addLocation(fix(0.0001, 0, { accuracy: -1 }), 2000).reason, 'invalid-accuracy');
  assert.equal(track.addLocation(fix(0.0001, 0, { accuracy: 100 }), 2000).reason, 'poor-accuracy');
  assert.equal(track.addLocation(fix(0.001), 2000).reason, 'jump');
  assert.equal(track.addLocation(fix(0.0001), 500).reason, 'out-of-order');
  const good = track.addLocation(fix(0.0001), 6000);
  assert.equal(good.accepted, true);
  assert.equal(good.state.pointCount, 2);
  assert.ok(good.state.distanceMeters < 12);
  assert.equal(track.addLocation(fix(0.0002), 6000).reason, 'out-of-order');
});

test('long reliable-fix outages start a separate line without inventing travel distance', () => {
  const track = new MotionTrack();
  track.start(0);
  track.addLocation(fix(0), 0);
  track.addLocation(fix(0.0001), 5000);
  const distance = track.snapshot(5000).distanceMeters;
  const later = track.addLocation(fix(1), 40000);
  assert.equal(later.accepted, true);
  assert.equal(later.state.segments.length, 2);
  assert.equal(later.state.distanceMeters, distance);
  assert.equal(later.state.durationMs, 40000);
});

test('stationary reliable samples do not create false outage segments', () => {
  const track = new MotionTrack();
  track.start(0);
  track.addLocation(fix(0), 0);
  for (let time = 5000; time <= 60000; time += 5000) track.addLocation(fix(0), time);
  const result = track.addLocation(fix(0.0001), 65000);
  assert.equal(result.state.segments.length, 1);
  assert.equal(result.state.pointCount, 2);
  assert.ok(result.state.distanceMeters > 11);
});

test('point budget finishes explicitly and preserves complete distance and route', () => {
  const track = new MotionTrack({ maxPoints: 3 });
  track.start(0);
  track.addLocation(fix(0), 0);
  track.addLocation(fix(0.0001), 5000);
  const result = track.addLocation(fix(0.0002), 10000);
  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'point-limit');
  assert.equal(result.state.limitReached, true);
  assert.equal(result.state.status, 'finished');
  assert.equal(result.state.pointCount, 3);
  assert.ok(result.state.distanceMeters > 22);
  assert.equal(track.addLocation(fix(0.0003), 15000).reason, 'not-recording');
  assert.equal(track.snapshot(15000).pointCount, 3);
});

test('invalid speed uses measured movement and time snapshots do not run backwards', () => {
  const track = new MotionTrack();
  track.start(1000);
  track.addLocation(fix(0), 1000);
  const result = track.addLocation(fix(0.0001, 0, { speed: -1 }), 6000);
  assert.ok(Math.abs(result.state.currentSpeedMps - 2.2238985) < 0.001);
  assert.equal(track.pause(5000).durationMs, 5000);
  assert.equal(track.snapshot(2000).durationMs, 5000);
});

test('duplicate start does not erase an active session and a finished session can be reset', () => {
  const track = new MotionTrack();
  track.start(0);
  track.addLocation(fix(0), 0);
  assert.equal(track.start(1000).pointCount, 1);
  track.pause(2000);
  assert.equal(track.start(3000).status, 'paused');
  track.finish(4000);
  const restarted = track.start(5000);
  assert.equal(restarted.status, 'recording');
  assert.equal(restarted.pointCount, 0);
  assert.equal(restarted.durationMs, 0);
  assert.equal(restarted.limitReached, false);
  assert.throws(() => track.snapshot(NaN), TypeError);
  assert.throws(() => new MotionTrack({ maxPoints: 0 }), TypeError);
});
