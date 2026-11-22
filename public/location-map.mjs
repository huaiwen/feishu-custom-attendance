import gcoord from './vendor/gcoord.mjs';

const crs = value => value === 'gcj02' ? gcoord.GCJ02 : gcoord.WGS84;
let sdk;
function loadMap() {
  if (window.AMap?.Map) return Promise.resolve(window.AMap);
  if (!sdk) sdk = (async () => {
    const response = await fetch('/api/maps/config', { headers: { Accept: 'application/json' } });
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || '高德地图暂时不可用，请稍后重试');
    window._AMapSecurityConfig = { serviceHost: `${location.origin}/_AMapService` };
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const fail = () => { clearTimeout(timer);script.remove();delete window.__attendanceMapReady;reject(new Error('高德地图加载失败，请检查网络后重试')); };
      const timer = setTimeout(fail, 20_000);
      window.__attendanceMapReady = () => { clearTimeout(timer);delete window.__attendanceMapReady;resolve(window.AMap); };
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.key)}&plugin=AMap.ToolBar,AMap.Scale,AMap.PlaceSearch&callback=__attendanceMapReady`;
      script.onerror = fail;
      document.head.append(script);
    });
  })().catch(error => { sdk = null;throw error; });
  return sdk;
}

export function mountLocationMap(form, getPosition) {
  const field = name => form.elements.namedItem(name);
  const status = form.querySelector('#map-status');
  const results = form.querySelector('#map-results');
  const search = form.querySelector('#map-search');
  const searchButton = form.querySelector('#map-search-button');
  const locateButton = form.querySelector('#map-locate');
  const centerButton = form.querySelector('#select-map-center');
  const retryButton = form.querySelector('#map-retry');
  const coordinateSystem = field('coordinateSystem');
  let active = true, map, circle, marker, places, readinessTimer, searchRequest = 0, interaction = 0;
  const isOpen = () => active && form.isConnected && form.closest('dialog')?.open;
  const point = () => {
    if (!field('latitude').value || !field('longitude').value) return null;
    const lat = Number(field('latitude').value), lng = Number(field('longitude').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
    return gcoord.transform([lng, lat], crs(coordinateSystem.value), gcoord.GCJ02);
  };
  const update = () => {
    if (!map) return;
    const center = point(), radius = Number(field('radius').value);
    if (!center || !Number.isFinite(radius) || radius < 10 || radius > 5000) {
      if (circle) { map.remove([circle, marker]);circle = marker = null; }
      status.textContent = '请先搜索地点或在地图上选取中心，再确认打卡半径。';
      return;
    }
    if (circle) { circle.setCenter(center);circle.setRadius(radius);marker.setCenter(center); }
    else {
      circle = new window.AMap.Circle({ center, radius, strokeColor: '#3370ff', strokeWeight: 2, fillColor: '#3370ff', fillOpacity: 0.12, bubble: true });
      marker = new window.AMap.CircleMarker({ center, radius: 6, strokeColor: '#fff', strokeWeight: 2, fillColor: '#3370ff', fillOpacity: 1, bubble: true });
      map.add([circle, marker]);
      map.setFitView([circle], true, [30, 30, 30, 30], 18);
    }
    status.textContent = `已选定考勤中心 · 半径 ${radius} 米。可继续点击地图微调，确认后保存地点。`;
  };
  const select = lnglat => {
    interaction++;
    const [lng, lat] = gcoord.transform([lnglat.getLng(), lnglat.getLat()], gcoord.GCJ02, crs(coordinateSystem.value));
    field('latitude').value = lat.toFixed(7);field('longitude').value = lng.toFixed(7);
    update();
  };
  const searchPlaces = () => {
    const keyword = search.value.trim();
    if (!keyword || !places) { status.textContent = '请输入园区、楼栋名称或地址。';search.focus();return; }
    interaction++;
    const request = ++searchRequest;
    searchButton.disabled = true;results.replaceChildren();status.textContent = '正在搜索高德地图…';
    places.search(keyword, (code, data) => {
      if (!isOpen() || request !== searchRequest) return;
      searchButton.disabled = false;
      if (code !== 'complete' || !data?.poiList?.pois?.length) {
        status.textContent = code === 'no_data' ? '没有找到该地点，请加上城市名称重试，或直接在地图选点。' : '地点搜索暂时不可用，请重试或直接在地图选点。';
        return;
      }
      for (const place of data.poiList.pois.filter(p => p.location)) {
        const button = document.createElement('button');button.type = 'button';button.className = 'map-result';
        const name = document.createElement('strong');name.textContent = place.name;
        const address = document.createElement('span');address.textContent = [place.pname, place.cityname, place.adname, typeof place.address === 'string' ? place.address : ''].filter(Boolean).join(' ');
        button.append(name, address);
        button.onclick = () => {
          select(place.location);map.setZoomAndCenter(17, [place.location.getLng(), place.location.getLat()]);
          field('name').value = place.name.slice(0, 60);
          field('address').value = address.textContent.slice(0, 200);
          results.replaceChildren();
        };
        results.append(button);
      }
      status.textContent = results.children.length ? '选择下方搜索结果，再在地图上核对楼栋中心。' : '搜索结果没有可选坐标，请调整关键词或直接在地图选点。';
    });
  };
  searchButton.onclick = searchPlaces;
  const searchKey = event => { if (event.key === 'Enter') { event.preventDefault();searchPlaces(); } };
  search.addEventListener('keydown', searchKey);
  centerButton.onclick = () => { if (map) select(map.getCenter()); };
  const locate = async (fresh = false) => {
    const before = interaction;
    locateButton.disabled = true;status.textContent = '正在通过飞书获取附近位置…';
    try {
      const position = await getPosition({fresh});
      if (!isOpen() || !map || interaction !== before) return;
      const center = gcoord.transform([position.longitude, position.latitude], crs(position.coordinateSystem), gcoord.GCJ02);
      map.setZoomAndCenter(17, center);
      status.textContent = `已移到你附近。搜索园区或楼栋，选择结果后确认打卡范围。`;
    } catch (error) { if (isOpen() && interaction === before) status.textContent = `${error.message}。也可以直接搜索地点。`; }
    finally { if (active) locateButton.disabled = false; }
  };
  locateButton.onclick = () => locate(true);
  const change = event => {
    if (event.target.name === 'radius') {
      update();
      if (map && circle) map.setFitView([circle], true, [30, 30, 30, 30], 18);
    }
  };
  const start = async () => {
    for (const control of [searchButton, locateButton, centerButton]) control.disabled = true;
    retryButton.hidden = true;status.textContent = '正在加载高德地图…';
    clearTimeout(readinessTimer);map?.destroy();map = circle = marker = null;
    try {
      const AMap = await loadMap();
      if (!isOpen()) return;
      map = new AMap.Map(form.querySelector('#location-map'), { viewMode: '2D', center: point() || [105, 35], zoom: point() ? 17 : 4, scrollWheel: false });
      map.addControl(new AMap.ToolBar());map.addControl(new AMap.Scale());
      places = new AMap.PlaceSearch({ pageSize: 5, extensions: 'base', citylimit: false });
      map.on('click', event => select(event.lnglat));
      map.on('dragstart', () => { interaction++; });
      map.on('complete', () => { clearTimeout(readinessTimer);if (!isOpen()) return;retryButton.hidden = true;if (point()) update(); });
      readinessTimer = setTimeout(() => { if (isOpen()) { status.textContent = '高德底图尚未加载完成，请检查网络或点击重新加载。';retryButton.hidden = false; } }, 20_000);
      for (const control of [searchButton, locateButton, centerButton]) control.disabled = false;
      update();
      if (!point()) locate();
    } catch (error) { if (isOpen()) { status.textContent = error instanceof TypeError ? '高德地图组件加载失败，请重新加载或联系管理员。' : error.message;retryButton.hidden = false; } }
  };
  retryButton.onclick = start;
  form.addEventListener('change', change);field('radius').addEventListener('input', update);
  start();
  return () => { active = false;searchRequest++;clearTimeout(readinessTimer);map?.destroy();form.removeEventListener('change', change);search.removeEventListener('keydown', searchKey);field('radius')?.removeEventListener('input', update); };
}
