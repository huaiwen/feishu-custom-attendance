import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('let feishuSdkReady;');
const end = app.indexOf('async function checkin(', start);
assert.ok(start >= 0 && end > start, 'test the actual SDK preparation and location functions');

function sdkHarness(userAgent = 'Feishu mobile', autoLocate = true) {
  const callbacks = {};
  const timers = new Map();
  let timerId = 0;
  let locationCalls = 0;
  let configCalls = 0;
  let now = 1800000000000;
  const context = createContext({
    Date: class extends Date { static now() {return now;} },
    ui: { db: { mode: 'feishu' } },
    navigator: { userAgent, geolocation: { getCurrentPosition() { assert.fail('Production must use Feishu location, never browser GPS'); } } },
    location: { href: 'https://attendance.example.com/#checkin' },
    api: async () => ({ appId: 'cli_test', signature: 'test-signature' }),
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    window: {
      h5sdk: {
        error: callback => { callbacks.error = callback; },
        ready: callback => { callbacks.ready = callback; },
        config: options => { configCalls++; callbacks.config = options; },
      },
      tt: {
        getLocation: options => {
          locationCalls++;
          callbacks.location = options;
          if (autoLocate) options.success({ latitude: 40, longitude: 116, horizontalAccuracy: 5, timestamp: now, type: 'wgs84' });
        },
      },
    },
  });
  runInContext(app.slice(start, end), context);
  return { callbacks, timers, context, advance:ms=>{now+=ms;}, warm:()=>context.warmLocation(), mapPosition:options=>context.getMapPosition(options), getPosition: () => context.getPosition(), locationCalls: () => locationCalls, configCalls: () => configCalls };
}

test('Feishu location waits for authentication when SDK ready arrives first', async () => {
  const sdk = sdkHarness();
  const pending = sdk.getPosition();
  await setImmediate();
  sdk.callbacks.ready();
  await setImmediate();
  assert.equal(sdk.locationCalls(), 0, 'SDK readiness alone must not start location');
  assert.equal(sdk.timers.size, 1, 'authentication must still have a timeout');
  sdk.callbacks.config.onSuccess({ session_key: 'test-session' });
  assert.equal((await pending).coordinateSystem, 'wgs84');
  assert.equal(sdk.locationCalls(), 1);
  assert.equal(sdk.timers.size, 0);
});

test('Feishu location also waits for SDK ready when authentication succeeds first', async () => {
  const sdk = sdkHarness();
  const pending = sdk.getPosition();
  await setImmediate();
  sdk.callbacks.config.onSuccess({ session_key: 'test-session' });
  await setImmediate();
  assert.equal(sdk.locationCalls(), 0);
  sdk.callbacks.ready();
  await pending;
  assert.equal(sdk.locationCalls(), 1);
  assert.equal(sdk.timers.size, 0);
});

for (const failure of ['onFail', 'error']) {
  test(`Feishu authentication ${failure} rejects without location and permits a fresh retry`, async () => {
    const sdk = sdkHarness();
    const pending = sdk.getPosition();
    const rejected = assert.rejects(pending, /认证失败/);
    await setImmediate();
    if (failure === 'onFail') sdk.callbacks.ready();
    else sdk.callbacks.config.onSuccess({ session_key: 'test-session' });
    await setImmediate();
    if (failure === 'onFail') sdk.callbacks.config.onFail({ errCode: 1 });
    else sdk.callbacks.error({ errCode: 1 });
    await rejected;
    sdk.callbacks.ready();
    sdk.callbacks.config.onSuccess({ session_key: 'late-session' });
    await setImmediate();
    assert.equal(sdk.locationCalls(), 0, 'late callbacks cannot revive a failed attempt');
    assert.equal(sdk.timers.size, 0);

    const retry = sdk.getPosition();
    await setImmediate();
    assert.equal(sdk.configCalls(), 2, 'failed initialization must not remain cached');
    sdk.callbacks.config.onSuccess({ session_key: 'new-session' });
    sdk.callbacks.ready();
    await retry;
    assert.equal(sdk.locationCalls(), 1);
  });
}

test('Feishu authentication timeout rejects after SDK ready and permits retry', async () => {
  const sdk = sdkHarness();
  const pending = sdk.getPosition();
  const rejected = assert.rejects(pending, /认证超时/);
  await setImmediate();
  sdk.callbacks.ready();
  await setImmediate();
  assert.equal(sdk.locationCalls(), 0);
  const [id, timer] = [...sdk.timers.entries()].find(([, timer]) => timer.delay === 15000);
  sdk.timers.delete(id);
  timer.callback();
  await rejected;
  sdk.callbacks.config.onSuccess({ session_key: 'late-session' });
  await setImmediate();
  assert.equal(sdk.locationCalls(), 0);

  const retry = sdk.getPosition();
  await setImmediate();
  sdk.callbacks.ready();
  sdk.callbacks.config.onSuccess({ session_key: 'new-session' });
  await retry;
  assert.equal(sdk.configCalls(), 2);
  assert.equal(sdk.locationCalls(), 1);
});


test('Production location rejects an ordinary browser without using browser GPS', async () => {
  const sdk = sdkHarness('Mozilla/5.0 iPhone Safari');
  await assert.rejects(sdk.getPosition(), /手机飞书工作台/);
  assert.equal(sdk.locationCalls(), 0);
  assert.equal(sdk.configCalls(), 0);
});

test('Opening the mobile app starts location early, shares the pending map request, and keeps punches fresh', async () => {
  const sdk = sdkHarness('iPhone Feishu',false);
  sdk.warm();
  await setImmediate();assert.equal(sdk.configCalls(),1);
  sdk.callbacks.ready();sdk.callbacks.config.onSuccess({});await setImmediate();
  assert.equal(sdk.locationCalls(),1);
  const pendingMap=sdk.mapPosition();
  assert.equal(sdk.locationCalls(),1,'opening a map shares the in-flight startup location');
  sdk.callbacks.location.success({latitude:40,longitude:116,horizontalAccuracy:5,timestamp:1800000000000,type:'wgs84'});
  assert.equal((await pendingMap).latitude,40);
  await sdk.mapPosition();assert.equal(sdk.locationCalls(),1,'recent map position is immediate');
  const punch=sdk.getPosition();await setImmediate();assert.equal(sdk.locationCalls(),2,'punches never reuse the map cache');
  sdk.callbacks.location.success({latitude:40.01,longitude:116,horizontalAccuracy:5,timestamp:1800000000001,type:'wgs84'});
  assert.equal((await punch).latitude,40.01);
});

test('Map cache expires, manual refresh reacquires location, and startup failures allow a retry', async () => {
  const sdk=sdkHarness();const first=sdk.mapPosition();await setImmediate();sdk.callbacks.ready();sdk.callbacks.config.onSuccess({});await first;
  sdk.advance(60_000);await sdk.mapPosition();assert.equal(sdk.locationCalls(),2);
  await sdk.mapPosition({fresh:true});assert.equal(sdk.locationCalls(),3);
  const denied=sdkHarness('iPhone Feishu',false);denied.warm();await setImmediate();denied.callbacks.ready();denied.callbacks.config.onSuccess({});await setImmediate();denied.callbacks.location.fail();await setImmediate();
  const retry=denied.mapPosition();await setImmediate();assert.equal(denied.locationCalls(),2);
  denied.callbacks.location.success({latitude:40,longitude:116,horizontalAccuracy:5,timestamp:1800000000000,type:'wgs84'});await retry;
});

test('Startup does not request location in ordinary browsers, desktop Feishu or the local demo', async () => {
  for(const userAgent of ['iPhone Safari','Feishu desktop']) {const sdk=sdkHarness(userAgent);sdk.warm();await setImmediate();assert.equal(sdk.configCalls(),0);}
  const demo=sdkHarness();demo.context.ui.db.mode='demo';demo.warm();await setImmediate();assert.equal(demo.locationCalls(),0);
});
