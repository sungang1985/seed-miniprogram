const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  }
  return value;
}

function loadMap(properties = {}, overrides = {}) {
  let definition;
  let timerId = 0;
  const timers = new Map();
  const calls = [];
  const events = [];
  const updates = [];
  const mapContext = {
    moveToLocation(options) {
      calls.push({ method: 'moveToLocation', options });
      if (overrides.moveToLocation) overrides.moveToLocation(options);
      else if (options.success) options.success({});
    },
    getScale(options) {
      calls.push({ method: 'getScale', options });
      if (overrides.getScale) overrides.getScale(options);
      else if (options.success) options.success({ scale: 15 });
    }
  };
  const wx = {
    createMapContext(id, instance) {
      calls.push({ method: 'createMapContext', id, instance });
      if (overrides.createMapContext) return overrides.createMapContext(id, instance);
      return mapContext;
    },
    getLocation() {
      assert.fail('Displaying or recentering the map must not request user geolocation');
    }
  };
  const filename = path.join(__dirname, '../miniprogram/components/location-map/index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Component(value) { definition = value; },
    wx,
    console,
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  }, { filename });
  assert.ok(definition, 'location-map registers a Component');
  const props = Object.fromEntries(Object.entries(definition.properties).map(([key, item]) => [key, item.value]));
  Object.assign(props, properties);
  const component = Object.assign({}, definition.methods, {
    properties: props,
    data: Object.assign(copy(definition.data), props),
    setData(patch, callback) {
      updates.push(copy(patch));
      Object.assign(this.data, copy(patch));
      if (callback) callback.call(this);
    },
    triggerEvent(name, detail) { events.push({ name, detail: copy(detail) }); }
  });
  function lifecycle(name) {
    const callback = definition.lifetimes?.[name] || definition[name];
    if (callback) callback.call(component);
  }
  function updateProps(next) {
    Object.assign(component.properties, next);
    Object.assign(component.data, next);
    for (const [key, observer] of Object.entries(definition.observers || {})) {
      const keys = key.split(',').map((item) => item.trim());
      if (keys.some((item) => Object.hasOwn(next, item))) {
        observer.call(component, ...keys.map((item) => component.properties[item]));
      }
    }
    for (const [key, value] of Object.entries(next)) {
      const observer = definition.properties[key]?.observer;
      if (typeof observer === 'function') observer.call(component, value);
    }
  }
  lifecycle('attached');
  if (!overrides.skipReady) lifecycle('ready');
  return { component, calls, events, updates, timers, updateProps, lifecycle };
}

test('map initializes its configured marker without requesting location permissions', () => {
  const { component, calls } = loadMap({ title: '深圳市民中心', address: '福中三路' });
  assert.equal(component.data.centerLatitude, 22.543096);
  assert.equal(component.data.centerLongitude, 114.057865);
  assert.equal(component.data.currentScale, 15);
  assert.equal(component.data.markers.length, 1);
  assert.equal(component.data.markers[0].latitude, 22.543096);
  assert.equal(component.data.markers[0].longitude, 114.057865);
  assert.ok(component.data.markers[0].iconPath.endsWith('.png'));
  assert.equal(calls[0].method, 'createMapContext');
  assert.equal(calls[0].instance, component);
});

test('zero latitude and longitude remain valid and recenter uses explicit coordinates', () => {
  const { component, calls } = loadMap({ latitude: 0, longitude: 0 });
  assert.equal(component.data.errorMessage, '');
  assert.equal(component.data.centerLatitude, 0);
  assert.equal(component.data.centerLongitude, 0);
  component.onMapUpdated();
  component.onRecenter();
  const move = calls.find((call) => call.method === 'moveToLocation');
  assert.ok(move, 'native map context is recentered');
  assert.equal(move.options.latitude, 0);
  assert.equal(move.options.longitude, 0);
});

test('invalid coordinates show an error and recover when corrected', () => {
  const { component, events, updateProps } = loadMap({ latitude: 91, longitude: 114 });
  assert.equal(component.data.mapVisible, false);
  assert.equal(component.data.loading, false);
  assert.ok(component.data.errorMessage);
  assert.equal(events.at(-1).name, 'error');
  updateProps({ latitude: 22.5, longitude: 114.1 });
  assert.equal(component.data.mapVisible, true);
  assert.equal(component.data.errorMessage, '');
  assert.equal(component.data.markers[0].latitude, 22.5);
  updateProps({ latitude: NaN });
  assert.equal(component.data.mapVisible, false);
  updateProps({ latitude: 0, longitude: -181 });
  assert.equal(component.data.mapVisible, false);
});

test('zoom controls and externally supplied scale stay within native map limits', () => {
  const { component, updateProps } = loadMap({ scale: 20 });
  component.onMapUpdated();
  component.onZoomIn();
  assert.equal(component.data.currentScale, 20);
  component.onZoomOut();
  assert.equal(component.data.currentScale, 19);
  updateProps({ scale: -10 });
  component.onMapUpdated();
  assert.equal(component.data.currentScale, 3);
  component.onZoomOut();
  assert.equal(component.data.currentScale, 3);
  updateProps({ scale: 30 });
  assert.equal(component.data.currentScale, 20);
});

test('coordinate and title updates change the marker and emitted selection details', () => {
  const { component, events, updateProps } = loadMap();
  updateProps({ latitude: 31.2304, longitude: 121.4737, title: '上海示例点', address: '示例地址', height: 600 });
  const marker = component.data.markers[0];
  assert.equal(marker.latitude, 31.2304);
  assert.equal(marker.longitude, 121.4737);
  assert.equal(component.data.mapHeight, 600);
  component.onMarkerTap({ detail: { markerId: marker.id } });
  assert.deepEqual(events.at(-1), {
    name: 'markertap',
    detail: { markerId: marker.id, latitude: 31.2304, longitude: 121.4737, title: '上海示例点', address: '示例地址' }
  });
});

test('ready is emitted once per map configuration and cancels the load timeout', () => {
  const { component, events, timers, updateProps } = loadMap();
  assert.ok(timers.size > 0);
  component.onMapUpdated();
  component.onMapUpdated();
  assert.equal(component.data.loading, false);
  assert.equal(timers.size, 0);
  assert.equal(events.filter((event) => event.name === 'ready').length, 1);
  assert.deepEqual(events.find((event) => event.name === 'ready').detail, { latitude: 22.543096, longitude: 114.057865, scale: 15 });
  updateProps({ longitude: 114.2 });
  component.onMapUpdated();
  assert.equal(events.filter((event) => event.name === 'ready').length, 2);
});

test('load timeout offers a retry and detached components cancel pending work', () => {
  const { component, events, timers, updates, lifecycle } = loadMap();
  const pending = [...timers.values()][0];
  timers.clear();
  pending.callback();
  assert.equal(component.data.loading, false);
  assert.ok(component.data.errorMessage);
  assert.equal(events.at(-1).name, 'error');
  component.onRetry();
  assert.equal(component.data.errorMessage, '');
  assert.ok(timers.size > 0);
  const staleTimeout = [...timers.values()][0].callback;
  lifecycle('detached');
  assert.equal(timers.size, 0);
  const updateCount = updates.length;
  const eventCount = events.length;
  staleTimeout();
  component.onMapUpdated();
  assert.equal(updates.length, updateCount);
  assert.equal(events.length, eventCount);
});

test('native context startup and recenter failures are surfaced without throwing', () => {
  const contextFailure = loadMap({}, { createMapContext() { throw new Error('native map unavailable'); } });
  assert.ok(contextFailure.component.data.errorMessage);
  assert.equal(contextFailure.events.at(-1).name, 'error');
  const moveFailure = loadMap({}, { moveToLocation(options) { options.fail({ errMsg: 'move failed' }); } });
  moveFailure.component.onMapUpdated();
  assert.doesNotThrow(() => moveFailure.component.onRecenter());
  assert.equal(moveFailure.events.at(-1).name, 'error');
});

test('native pinch scale is reflected by the next zoom control action', () => {
  const { component } = loadMap();
  component.onMapUpdated();
  component.onRegionChange({ detail: { type: 'end', scale: 9 } });
  component.onZoomIn();
  assert.equal(component.data.currentScale, 10);
  component.onRegionChange({ type: 'end', detail: { scale: 19 } });
  component.onZoomOut();
  assert.equal(component.data.currentScale, 18);
});

test('actions wait for the initial native render before operating the map', () => {
  const { component, calls } = loadMap();
  component.onRecenter();
  component.onZoomIn();
  assert.equal(component.data.currentScale, 15);
  assert.equal(calls.filter((call) => call.method === 'moveToLocation').length, 0);
});

test('recovering from invalid props creates a context for the replacement native map', () => {
  const { component, calls, updateProps } = loadMap();
  component.onMapUpdated();
  assert.equal(calls.filter((call) => call.method === 'createMapContext').length, 1);
  updateProps({ latitude: 100 });
  assert.equal(component.data.mapVisible, false);
  updateProps({ latitude: 31.2304, longitude: 121.4737 });
  assert.equal(component.data.mapVisible, true);
  assert.equal(calls.filter((call) => call.method === 'createMapContext').length, 2);
});

test('an older recenter failure cannot hide a newly configured map', () => {
  let rejectMove;
  const { component, events, updateProps } = loadMap({}, {
    moveToLocation(options) { rejectMove = options.fail; }
  });
  component.onMapUpdated();
  component.onRecenter();
  assert.equal(typeof rejectMove, 'function');
  updateProps({ latitude: 31.2304, longitude: 121.4737 });
  component.onMapUpdated();
  rejectMove({ errMsg: 'late failure from previous map' });
  assert.equal(component.data.mapVisible, true);
  assert.equal(component.data.errorMessage, '');
  assert.equal(events.filter((event) => event.name === 'error').length, 0);
});

test('metadata updates preserve a rendered map and its user-selected zoom', () => {
  const { component, events, timers, updateProps } = loadMap();
  component.onMapUpdated();
  component.onRegionChange({ detail: { type: 'end', scale: 10 } });
  updateProps({ address: '新的地点描述', height: 620 });
  assert.equal(component.data.loading, false);
  assert.equal(component.data.currentScale, 10);
  assert.equal(component.data.mapHeight, 620);
  assert.equal(timers.size, 0);
  assert.equal(events.filter((event) => event.name === 'ready').length, 1);
});

test('region change reads missing native scale but ignores callbacks from a previous map', () => {
  const pending = [];
  const { component, calls, updateProps } = loadMap({}, {
    getScale(options) { pending.push(options.success); }
  });
  component.onMapUpdated();
  component.onRegionChange({ type: 'end', detail: {} });
  assert.equal(calls.at(-1).method, 'getScale');
  pending[0]({ scale: 11 });
  component.onZoomIn();
  assert.equal(component.data.currentScale, 12);
  component.onRegionChange({ detail: { type: 'end' } });
  updateProps({ longitude: 114.2 });
  component.onMapUpdated();
  pending[1]({ scale: 4 });
  assert.equal(component.data.currentScale, 15);
});
