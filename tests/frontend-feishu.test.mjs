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
  const timings = [];
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
    api: async (path, body) => {if (path === '/api/location-timing') timings.push(body);return { appId: 'cli_test', signature: 'test-signature' };},
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
  return { callbacks, timers, timings, context, advance:ms=>{now+=ms;}, warm:()=>context.warmLocation(), mapPosition:options=>context.getMapPosition(options), getPosition: () => context.getPosition(), locationCalls: () => locationCalls, configCalls: () => configCalls };
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
  assert.equal(sdk.callbacks.location.timeout,5);
  assert.equal(sdk.callbacks.location.accuracy,'best');
  assert.equal(sdk.callbacks.location.cacheTimeout,0);
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

test('Startup, map and punch share one pending location and a precise fix younger than 15 seconds', async () => {
  const sdk = sdkHarness('iPhone Feishu',false);
  sdk.warm();
  await setImmediate();assert.equal(sdk.configCalls(),1);
  sdk.callbacks.ready();sdk.callbacks.config.onSuccess({});await setImmediate();
  assert.equal(sdk.locationCalls(),1);
  const pendingMap=sdk.mapPosition();
  const pendingPunch=sdk.getPosition();
  assert.equal(sdk.locationCalls(),1,'map and punch share the in-flight startup location');
  sdk.callbacks.location.success({latitude:40,longitude:116,horizontalAccuracy:5,timestamp:1800000000000,type:'wgs84'});
  assert.equal((await pendingMap).latitude,40);
  assert.equal((await pendingPunch).latitude,40);
  await sdk.mapPosition();assert.equal(sdk.locationCalls(),1,'recent map position is immediate');
  sdk.advance(14_999);await sdk.getPosition();assert.equal(sdk.locationCalls(),1,'a recent precise fix avoids a duplicate GPS wait');
  sdk.advance(1);
  const punch=sdk.getPosition();await setImmediate();assert.equal(sdk.locationCalls(),2,'punch cache expires at 15 seconds');
  sdk.callbacks.location.success({latitude:40.01,longitude:116,horizontalAccuracy:5,timestamp:1800000000001,type:'wgs84'});
  assert.equal((await punch).latitude,40.01);
});

test('Cached fixes use the device timestamp and are never reused if stale, future-dated or imprecise', async () => {
  for (const override of [{timestamp:1800000000000-15_000},{timestamp:1800000000000+1000},{horizontalAccuracy:80}]) {
    const sdk=sdkHarness('iPhone Feishu',false);const first=sdk.mapPosition();await setImmediate();sdk.callbacks.ready();sdk.callbacks.config.onSuccess({});await setImmediate();
    sdk.callbacks.location.success({latitude:40,longitude:116,horizontalAccuracy:5,timestamp:1800000000000,type:'wgs84',...override});await first;
    const punch=sdk.getPosition();await setImmediate();assert.equal(sdk.locationCalls(),2);
    sdk.callbacks.location.success({latitude:40,longitude:116,horizontalAccuracy:5,timestamp:1800000000000,type:'wgs84'});await punch;
  }
});

test('Location diagnostics separate preparation and native GPS without coordinates or identity', async () => {
  const sdk=sdkHarness('iPhone Feishu',false);const pending=sdk.getPosition();await setImmediate();sdk.advance(1200);sdk.callbacks.ready();sdk.callbacks.config.onSuccess({});await setImmediate();sdk.advance(13_000);
  sdk.callbacks.location.success({latitude:40,longitude:116,horizontalAccuracy:5,timestamp:1800000014200,type:'wgs84'});await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(sdk.timings)),[{stage:'prepare',durationMs:1200,outcome:'ok'},{stage:'locate',durationMs:13000,outcome:'ok'}]);
  const failing=sdkHarness('iPhone Feishu',false);const failed=failing.getPosition();const rejected=assert.rejects(failed,/定位失败/);await setImmediate();failing.callbacks.ready();failing.callbacks.config.onSuccess({});await setImmediate();failing.advance(15_000);failing.callbacks.location.fail();await rejected;
  assert.equal(failing.timings.at(-1).outcome,'error');assert.equal(failing.timings.at(-1).durationMs,15_000);
});

test('Feishu script and server signature load in parallel; failed telemetry never blocks location', async () => {
  const sdk=sdkHarness();const h5sdk=sdk.context.window.h5sdk;delete sdk.context.window.h5sdk;
  let script, signatureStarted=false;
  sdk.context.document={createElement:()=>({remove(){}}),head:{append:value=>{script=value;}}};
  sdk.context.api=async path=>{if(path==='/api/location-timing') throw new Error('offline');signatureStarted=true;return {};};
  const pending=sdk.getPosition();await setImmediate();assert.equal(signatureStarted,true);assert.ok(script);assert.equal(sdk.locationCalls(),0);
  sdk.context.window.h5sdk=h5sdk;script.onload();await setImmediate();sdk.callbacks.ready();sdk.callbacks.config.onSuccess({});await pending;
  assert.equal(sdk.locationCalls(),1);
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
