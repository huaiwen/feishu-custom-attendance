import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mountLocationMap} from '../public/location-map.mjs';
import gcoord from '../public/vendor/gcoord.mjs';

class Element {
  value = '';textContent = '';children = [];listeners = {};hidden = false;
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  removeEventListener(name) { delete this.listeners[name]; }
  focus() {}
}
function fixture(t, getPosition = async () => ({longitude:123,latitude:45,coordinateSystem:'gcj02',accuracy:10}), values = {}) {
  const nodes = new Map(), fields = new Map();
  for (const name of ['latitude','longitude','coordinateSystem','radius','name','address']) {const element = new Element();element.name = name;fields.set(name,element);}
  fields.get('coordinateSystem').value = 'gcj02';fields.get('radius').value = '100';
  const form = new Element();form.isConnected = true;form.closest = () => ({open:form.isConnected});
  form.elements = {namedItem:name => fields.get(name)};
  form.querySelector = selector => {if (!nodes.has(selector)) nodes.set(selector,new Element());return nodes.get(selector);};
  let map, searchCallback;
  class MockMap {
    events = {};overlays = [];moves = [];
    constructor(element,options) { map = this;this.options = options;this.center = options.center; }
    on(event,callback) { this.events[event] = callback; }
    addControl() {}
    add(items) { this.overlays.push(...items); }
    remove() { this.overlays = []; }
    setFitView() {}
    setCenter(center) { this.center = center; }
    getCenter() { return {getLng:() => this.center[0],getLat:() => this.center[1]}; }
    setZoomAndCenter(zoom,center) { this.center = center;this.moves.push(center); }
    destroy() { this.destroyed = true; }
  }
  class Circle { constructor(options) { Object.assign(this,options); }setCenter(center) { this.center = center; }setRadius(radius) { this.radius = radius; } }
  const savedWindow = globalThis.window, savedDocument = globalThis.document;
  globalThis.window = {AMap:{Map:MockMap,Circle,CircleMarker:Circle,ToolBar:class {},Scale:class {},PlaceSearch:class {search(keyword,callback) { searchCallback = callback; }}}};
  globalThis.document = {createElement:() => new Element()};
  for (const [name,value] of Object.entries(values)) fields.get(name).value = value;
  const timings = [];
  const cleanup = mountLocationMap(form,getPosition,(stage,started,outcome) => timings.push({stage,outcome}));
  t.after(() => {cleanup();if(savedWindow === undefined) delete globalThis.window;else globalThis.window=savedWindow;if(savedDocument === undefined)delete globalThis.document;else globalThis.document=savedDocument;});
  return {form,fields,nodes,cleanup,timings,get map() {return map;},get searchCallback() {return searchCallback;}};
}

test('Existing WGS84 locations retain their physical center without asking for a coordinate system or GPS', async t => {
  const f = fixture(t,async () => assert.fail('Editing must keep the saved center'),{longitude:'123',latitude:'45',coordinateSystem:'wgs84'});await setImmediate();
  const expected = gcoord.transform([123,45],gcoord.WGS84,gcoord.GCJ02);
  assert.ok(Math.abs(f.map.options.center[0]-expected[0]) < 1e-7);
  assert.equal(f.map.overlays[0].radius,100);
  f.fields.get('radius').value='150';f.fields.get('radius').listeners.input();
  assert.equal(f.map.overlays[0].radius,150);
  f.map.events.click({lnglat:{getLng:() => expected[0],getLat:() => expected[1]}});
  assert.ok(Math.abs(Number(f.fields.get('longitude').value)-123) < 1e-6);
});

test('New locations automatically move nearby once without saving the current position as the attendance center', async t => {
  let calls = 0;
  const f = fixture(t,async () => {calls++;return {longitude:123,latitude:45,coordinateSystem:'gcj02',accuracy:10};});await setImmediate();
  assert.equal(calls,1);assert.deepEqual(f.map.center,[123,45]);
  assert.equal(f.fields.get('longitude').value,'');
  assert.match(f.nodes.get('#map-status').textContent,/搜索/);
  f.map.events.complete();f.map.events.complete();
  assert.deepEqual(f.timings,[{stage:'map-sdk',outcome:'ok'},{stage:'map-tiles',outcome:'ok'}]);
});

test('Late automatic location cannot override a user selection; denied location leaves search available', async t => {
  let finish;
  const f = fixture(t,() => new Promise(resolve => {finish=resolve;}));await setImmediate();
  f.map.events.click({lnglat:{getLng:() => 116.4,getLat:() => 39.9}});
  finish({longitude:123,latitude:45,coordinateSystem:'gcj02',accuracy:10});await setImmediate();
  assert.equal(f.map.moves.length,0);assert.equal(f.fields.get('longitude').value,'116.4000000');
  f.cleanup();
  const denied = fixture(t,async () => {throw new Error('未允许定位');});await setImmediate();
  denied.map.events.complete();
  assert.equal(denied.nodes.get('#map-search-button').disabled,false);
  assert.match(denied.nodes.get('#map-status').textContent,/直接搜索地点/);
});

test('Search results use text nodes, selecting a place fills coordinates, and late results after close are ignored', async t => {
  let finishPosition;
  const f = fixture(t,() => new Promise(resolve => {finishPosition=resolve;}));await setImmediate();
  f.nodes.get('#map-search').value='办公楼';f.nodes.get('#map-search-button').onclick();
  f.searchCallback('complete',{poiList:{pois:[{name:'<script>not HTML</script>',address:'测试地址',location:{getLng:() => 116.4,getLat:() => 39.9}}]}});
  const result = f.nodes.get('#map-results').children[0];
  assert.equal(result.children[0].textContent,'<script>not HTML</script>');
  result.onclick();assert.equal(f.fields.get('longitude').value,'116.4000000');assert.equal(f.fields.get('address').value,'测试地址');
  f.nodes.get('#map-search-button').onclick();
  const locate = f.nodes.get('#map-locate').onclick();
  const moves = f.map.moves.length;f.cleanup();f.form.isConnected=false;
  f.searchCallback('complete',{poiList:{pois:[{name:'late',location:{}}]}});
  finishPosition({longitude:116,latitude:40,coordinateSystem:'wgs84',accuracy:10});await locate;
  assert.equal(f.map.moves.length,moves);assert.equal(f.map.destroyed,true);
  assert.equal(f.nodes.get('#map-results').children.length,0);
});
