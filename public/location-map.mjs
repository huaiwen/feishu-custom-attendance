import gcoord from './vendor/gcoord.mjs';
import './vendor/leaflet.js';

const crs = value => value === 'gcj02' ? gcoord.GCJ02 : gcoord.WGS84;

export function mountLocationMap(form, getPosition) {
  const field = name => form.elements.namedItem(name);
  const status = form.querySelector('#map-status');
  const coordinateSystem = field('coordinateSystem');
  let previousSystem = coordinateSystem.value;
  let active = true;
  const point = () => {
    if (!field('latitude').value || !field('longitude').value) return null;
    const lat = Number(field('latitude').value), lng = Number(field('longitude').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
    return gcoord.transform([lng, lat], crs(coordinateSystem.value), gcoord.WGS84).reverse();
  };
  const map = window.L.map(form.querySelector('#location-map'), { scrollWheelZoom: false, zoomControl: false }).setView(point() || [35, 105], point() ? 17 : 4);
  window.L.control.zoom({ zoomInTitle: '放大', zoomOutTitle: '缩小' }).addTo(map);
  window.L.control.scale({ imperial: false }).addTo(map);
  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).on('tileerror', () => { status.textContent = '底图加载失败，请检查网络后重新打开；也可展开坐标设置。'; }).addTo(map);
  let circle, marker;
  const update = () => {
    const center = point(), radius = Number(field('radius').value);
    if (!center || !Number.isFinite(radius) || radius < 10 || radius > 5000) return;
    if (circle) { circle.setLatLng(center).setRadius(radius); marker.setLatLng(center); }
    else {
      circle = window.L.circle(center, { radius, color: '#3370ff', weight: 2, fillOpacity: 0.12 }).addTo(map);
      marker = window.L.circleMarker(center, { radius: 6, color: '#fff', weight: 2, fillColor: '#3370ff', fillOpacity: 1 }).addTo(map);
      map.fitBounds(circle.getBounds(), { padding: [25, 25], maxZoom: 18 });
    }
    status.textContent = `已选中心 ${Number(field('latitude').value).toFixed(6)}, ${Number(field('longitude').value).toFixed(6)} · 半径 ${radius} 米`;
  };
  const select = latlng => {
    const wrapped = latlng.wrap();
    const [lng, lat] = gcoord.transform([wrapped.lng, wrapped.lat], gcoord.WGS84, crs(coordinateSystem.value));
    field('latitude').value = lat.toFixed(7); field('longitude').value = lng.toFixed(7);
    update();
  };
  map.on('click', event => select(event.latlng));
  form.querySelector('#select-map-center').onclick = () => select(map.getCenter());
  form.querySelector('#map-locate').onclick = async event => {
    const button = event.currentTarget; button.disabled = true; status.textContent = '正在获取当前位置…';
    try {
      const position = await getPosition();
      if (!active || !form.isConnected || !form.closest('dialog')?.open) return;
      const [lng, lat] = gcoord.transform([position.longitude, position.latitude], crs(position.coordinateSystem), gcoord.WGS84);
      map.setView([lat, lng], 17);
      status.textContent = `已移动到附近，定位误差约 ${Math.round(position.accuracy)} 米。请点击地图选择考勤中心。`;
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };
  const change = event => {
    if (event.target === coordinateSystem) {
      if (field('latitude').value && field('longitude').value) {
        const [lng, lat] = gcoord.transform([Number(field('longitude').value), Number(field('latitude').value)], crs(previousSystem), crs(coordinateSystem.value));
        field('latitude').value = lat.toFixed(7); field('longitude').value = lng.toFixed(7);
      }
      previousSystem = coordinateSystem.value;
    }
    if (['latitude', 'longitude', 'coordinateSystem', 'radius'].includes(event.target.name)) {
      update(); if (event.target.name !== 'radius' && point()) map.panTo(point());
      if (event.target.name === 'radius' && circle) map.fitBounds(circle.getBounds(), { padding: [25, 25], maxZoom: 18 });
    }
  };
  form.addEventListener('change', change);
  field('radius').addEventListener('input', update);
  update();
  return () => { active = false; map.remove(); form.removeEventListener('change', change); field('radius')?.removeEventListener('input', update); };
}
