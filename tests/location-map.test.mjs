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
function fixture(t, getPosition = async () => ({})) {
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
  const cleanup = mountLocationMap(form,getPosition);
  t.after(() => {cleanup();if(savedWindow === undefined) delete globalThis.window;else globalThis.window=savedWindow;if(savedDocument === undefined)delete globalThis.document;else globalThis.document=savedDocument;});
  return {form,fields,nodes,cleanup,get map() {return map;},get searchCallback() {return searchCallback;}};
}

test('AMap points preserve physical location across coordinate-system changes and show the selected radius', async t => {
  const f = fixture(t);await setImmediate();
  f.map.events.click({lnglat:{getLng:() => 123,getLat:() => 45}});
  assert.equal(f.fields.get('longitude').value,'123.0000000');
  assert.equal(f.map.overlays[0].radius,100);
  f.fields.get('coordinateSystem').value = 'wgs84';
  f.form.listeners.change({target:f.fields.get('coordinateSystem')});
  const expected = gcoord.transform([123,45],gcoord.GCJ02,gcoord.WGS84);
  assert.ok(Math.abs(Number(f.fields.get('longitude').value)-expected[0]) < 1e-7);
  assert.ok(Math.abs(f.map.overlays[0].center[0]-123)<1e-6);
  f.fields.get('radius').value='150';f.fields.get('radius').listeners.input();
  assert.equal(f.map.overlays[0].radius,150);
  f.fields.get('latitude').value='';f.form.listeners.change({target:f.fields.get('latitude')});
  assert.equal(f.map.overlays.length,0,'invalidated center cannot leave a stale circle');
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
