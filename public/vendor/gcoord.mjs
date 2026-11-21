/**
 * @preserve
 * gcoord 1.0.8, geographic coordinate library
 * Copyright (c) 2026 Jiulong Hu <me@hujiulong.com>
 */
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a2, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a2, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a2, prop, b[prop]);
    }
  return a2;
};
var __spreadProps = (a2, b) => __defProps(a2, __getOwnPropDescs(b));

// src/crs/GCJ02.ts
var { sin, cos, sqrt, abs, PI } = Math;
var a = 6378245;
var ee = 0.006693421622965823;
function isInChinaBbox(lon, lat) {
  return lon >= 72.004 && lon <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}
function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * sqrt(abs(x));
  ret += (20 * sin(6 * x * PI) + 20 * sin(2 * x * PI)) * 2 / 3;
  ret += (20 * sin(y * PI) + 40 * sin(y / 3 * PI)) * 2 / 3;
  ret += (160 * sin(y / 12 * PI) + 320 * sin(y * PI / 30)) * 2 / 3;
  return ret;
}
function transformLon(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * sqrt(abs(x));
  ret += (20 * sin(6 * x * PI) + 20 * sin(2 * x * PI)) * 2 / 3;
  ret += (20 * sin(x * PI) + 40 * sin(x / 3 * PI)) * 2 / 3;
  ret += (150 * sin(x / 12 * PI) + 300 * sin(x / 30 * PI)) * 2 / 3;
  return ret;
}
function delta(lon, lat) {
  let dLon = transformLon(lon - 105, lat - 35);
  let dLat = transformLat(lon - 105, lat - 35);
  const radLat = lat / 180 * PI;
  let magic = sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = sqrt(magic);
  dLon = dLon * 180 / (a / sqrtMagic * cos(radLat) * PI);
  dLat = dLat * 180 / (a * (1 - ee) / (magic * sqrtMagic) * PI);
  return [dLon, dLat];
}
function WGS84ToGCJ02(coord) {
  const [lon, lat] = coord;
  if (!isInChinaBbox(lon, lat)) return [lon, lat];
  const d = delta(lon, lat);
  return [lon + d[0], lat + d[1]];
}
function GCJ02ToWGS84(coord) {
  const [lon, lat] = coord;
  if (!isInChinaBbox(lon, lat)) return [lon, lat];
  let [wgsLon, wgsLat] = [lon, lat];
  for (let i = 0; i < 10; i++) {
    const d = delta(wgsLon, wgsLat);
    const dx = wgsLon + d[0] - lon;
    const dy = wgsLat + d[1] - lat;
    if (abs(dx) <= 1e-6 && abs(dy) <= 1e-6) break;
    wgsLon -= dx;
    wgsLat -= dy;
  }
  return [wgsLon, wgsLat];
}

// src/crs/BD09.ts
var { sin: sin2, cos: cos2, atan2, sqrt: sqrt2, PI: PI2 } = Math;
var baiduFactor = PI2 * 3e3 / 180;
function BD09ToGCJ02(coord) {
  const [lon, lat] = coord;
  const x = lon - 65e-4;
  const y = lat - 6e-3;
  const z = sqrt2(x * x + y * y) - 2e-5 * sin2(y * baiduFactor);
  const theta = atan2(y, x) - 3e-6 * cos2(x * baiduFactor);
  const newLon = z * cos2(theta);
  const newLat = z * sin2(theta);
  return [newLon, newLat];
}
function GCJ02ToBD09(coord) {
  const [lon, lat] = coord;
  const x = lon;
  const y = lat;
  const z = sqrt2(x * x + y * y) + 2e-5 * sin2(y * baiduFactor);
  const theta = atan2(y, x) + 3e-6 * cos2(x * baiduFactor);
  const newLon = z * cos2(theta) + 65e-4;
  const newLat = z * sin2(theta) + 6e-3;
  return [newLon, newLat];
}

// src/crs/EPSG3857.ts
var R2D = 180 / Math.PI;
var D2R = Math.PI / 180;
var A = 6378137;
var MAXEXTENT = 20037508342789244e-9;
function EPSG3857ToWGS84(xy) {
  return [
    xy[0] * R2D / A,
    (Math.PI * 0.5 - 2 * Math.atan(Math.exp(-xy[1] / A))) * R2D
  ];
}
function WGS84ToEPSG3857(lonLat) {
  const adjusted = Math.abs(lonLat[0]) <= 180 ? lonLat[0] : lonLat[0] - (lonLat[0] < 0 ? -1 : 1) * 360;
  const xy = [
    A * adjusted * D2R,
    A * Math.log(Math.tan(Math.PI * 0.25 + 0.5 * lonLat[1] * D2R))
  ];
  if (xy[0] > MAXEXTENT) xy[0] = MAXEXTENT;
  if (xy[0] < -MAXEXTENT) xy[0] = -MAXEXTENT;
  if (xy[1] > MAXEXTENT) xy[1] = MAXEXTENT;
  if (xy[1] < -MAXEXTENT) xy[1] = -MAXEXTENT;
  return xy;
}

// src/crs/BD09MC.ts
var { abs: abs2 } = Math;
var MCBAND = [1289059486e-2, 836237787e-2, 5591021, 348198983e-2, 167804312e-2, 0];
var LLBAND = [75, 60, 45, 30, 15, 0];
var MC2LL = [
  [
    1410526172116255e-23,
    898305509648872e-20,
    -1.9939833816331,
    200.9824383106796,
    -187.2403703815547,
    91.6087516669843,
    -23.38765649603339,
    2.57121317296198,
    -0.03801003308653,
    173379812e-1
  ],
  [
    -7.435856389565537e-9,
    8983055097726239e-21,
    -0.78625201886289,
    96.32687599759846,
    -1.85204757529826,
    -59.36935905485877,
    47.40033549296737,
    -16.50741931063887,
    2.28786674699375,
    1026014486e-2
  ],
  [
    -3.030883460898826e-8,
    898305509983578e-20,
    0.30071316287616,
    59.74293618442277,
    7.357984074871,
    -25.38371002664745,
    13.45380521110908,
    -3.29883767235584,
    0.32710905363475,
    685681737e-2
  ],
  [
    -1.981981304930552e-8,
    8983055099779535e-21,
    0.03278182852591,
    40.31678527705744,
    0.65659298677277,
    -4.44255534477492,
    0.85341911805263,
    0.12923347998204,
    -0.04625736007561,
    448277706e-2
  ],
  [
    309191371068437e-23,
    8983055096812155e-21,
    6995724062e-14,
    23.10934304144901,
    -23663490511e-14,
    -0.6321817810242,
    -0.00663494467273,
    0.03430082397953,
    -0.00466043876332,
    25551644e-1
  ],
  [
    2890871144776878e-24,
    8983055095805407e-21,
    -3.068298e-8,
    7.47137025468032,
    -353937994e-14,
    -0.02145144861037,
    -1234426596e-14,
    10322952773e-14,
    -323890364e-14,
    826088.5
  ]
];
var LL2MC = [
  [
    -0.0015702102444,
    111320.7020616939,
    1704480524535203,
    -10338987376042340,
    26112667856603880,
    -35149669176653700,
    26595700718403920,
    -10725012454188240,
    1800819912950474,
    82.5
  ],
  [
    8277824516172526e-19,
    111320.7020463578,
    6477955746671607e-7,
    -4082003173.641316,
    1077490566351142e-5,
    -15171875531.51559,
    1205306533862167e-5,
    -5124939663.577472,
    9133119359512032e-7,
    67.5
  ],
  [
    0.00337398766765,
    111320.7020202162,
    4481351045890365e-9,
    -23393751.19931662,
    7968221547186455e-8,
    -115964993.2797253,
    9723671115602145e-8,
    -43661946.33752821,
    8477230501135234e-9,
    52.5
  ],
  [
    0.00220636496208,
    111320.7020209128,
    51751.86112841131,
    3796837749470245e-9,
    992013.7397791013,
    -1221952.21711287,
    1340652697009075e-9,
    -620943.6990984312,
    144416.9293806241,
    37.5
  ],
  [
    -3441963504368392e-19,
    111320.7020576856,
    278.2353980772752,
    2485758690035394e-9,
    6070.750963243378,
    54821.18345352118,
    9540.606633304236,
    -2710.55326746645,
    1405.483844121726,
    22.5
  ],
  [
    -3218135878613132e-19,
    111320.7020701615,
    0.00369383431289,
    823725.6402795718,
    0.46104986909093,
    2351.343141331292,
    1.58060784298199,
    8.77738589078284,
    0.37238884252424,
    7.45
  ]
];
function transform(x, y, factors) {
  const cc = abs2(y) / factors[9];
  let xt = factors[0] + factors[1] * abs2(x);
  let yt = factors[2] + factors[3] * cc + factors[4] * cc ** 2 + factors[5] * cc ** 3 + factors[6] * cc ** 4 + factors[7] * cc ** 5 + factors[8] * cc ** 6;
  xt *= x < 0 ? -1 : 1;
  yt *= y < 0 ? -1 : 1;
  return [xt, yt];
}
function BD09toBD09MC(coord) {
  const [lng, lat] = coord;
  let factors = LL2MC[LL2MC.length - 1];
  for (let i = 0; i < LLBAND.length; i++) {
    if (abs2(lat) > LLBAND[i]) {
      factors = LL2MC[i];
      break;
    }
  }
  return transform(lng, lat, factors);
}
function BD09MCtoBD09(coord) {
  const [x, y] = coord;
  let factors = [];
  for (let i = 0; i < MCBAND.length; i++) {
    if (abs2(y) >= MCBAND[i]) {
      factors = MC2LL[i];
      break;
    }
  }
  return transform(x, y, factors);
}

// src/helper.ts
function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}
function isArray(input) {
  return !!input && Object.prototype.toString.call(input) === "[object Array]";
}
function isNumber(input) {
  if (typeof input === "number") return Number.isFinite(input);
  if (typeof input === "string" && input.trim() !== "") {
    return Number.isFinite(Number(input));
  }
  return false;
}
function compose(...funcs) {
  const start = funcs.length - 1;
  return function(arg) {
    let i = start;
    let result = funcs[start](arg);
    while (i--) result = funcs[i].call(null, result);
    return result;
  };
}
function coordEach(geojson, callback, excludeWrapCoord = false) {
  if (geojson === null) return;
  let j;
  let k;
  let l;
  let geometry;
  let coords;
  let stopG;
  let wrapShrink = 0;
  let coordIndex = 0;
  let geometryMaybeCollection;
  let isGeometryCollection;
  const { type } = geojson;
  const isFeatureCollection = type === "FeatureCollection";
  const isFeature = type === "Feature";
  const stop = isFeatureCollection ? geojson.features.length : 1;
  for (let featureIndex = 0; featureIndex < stop; featureIndex++) {
    geometryMaybeCollection = isFeatureCollection ? geojson.features[featureIndex].geometry : isFeature ? geojson.geometry : geojson;
    isGeometryCollection = geometryMaybeCollection ? geometryMaybeCollection.type === "GeometryCollection" : false;
    stopG = isGeometryCollection ? geometryMaybeCollection.geometries.length : 1;
    for (let geomIndex = 0; geomIndex < stopG; geomIndex++) {
      let multiFeatureIndex = 0;
      let geometryIndex = 0;
      geometry = isGeometryCollection ? geometryMaybeCollection.geometries[geomIndex] : geometryMaybeCollection;
      if (geometry === null) continue;
      const geomType = geometry.type;
      wrapShrink = excludeWrapCoord && (geomType === "Polygon" || geomType === "MultiPolygon") ? 1 : 0;
      switch (geomType) {
        case null:
          break;
        case "Point":
          coords = geometry.coordinates;
          if (callback(
            coords,
            coordIndex,
            featureIndex,
            multiFeatureIndex,
            geometryIndex
          ) === false)
            return false;
          coordIndex++;
          multiFeatureIndex++;
          break;
        case "LineString":
        case "MultiPoint":
          coords = geometry.coordinates;
          for (j = 0; j < coords.length; j++) {
            if (callback(
              coords[j],
              coordIndex,
              featureIndex,
              multiFeatureIndex,
              geometryIndex
            ) === false)
              return false;
            coordIndex++;
            if (geomType === "MultiPoint") multiFeatureIndex++;
          }
          if (geomType === "LineString") multiFeatureIndex++;
          break;
        case "Polygon":
        case "MultiLineString":
          coords = geometry.coordinates;
          for (j = 0; j < coords.length; j++) {
            for (k = 0; k < coords[j].length - wrapShrink; k++) {
              if (callback(
                coords[j][k],
                coordIndex,
                featureIndex,
                multiFeatureIndex,
                geometryIndex
              ) === false)
                return false;
              coordIndex++;
            }
            if (geomType === "MultiLineString") multiFeatureIndex++;
            if (geomType === "Polygon") geometryIndex++;
          }
          if (geomType === "Polygon") multiFeatureIndex++;
          break;
        case "MultiPolygon":
          coords = geometry.coordinates;
          for (j = 0; j < coords.length; j++) {
            geometryIndex = 0;
            for (k = 0; k < coords[j].length; k++) {
              for (l = 0; l < coords[j][k].length - wrapShrink; l++) {
                if (callback(
                  coords[j][k][l],
                  coordIndex,
                  featureIndex,
                  multiFeatureIndex,
                  geometryIndex
                ) === false)
                  return false;
                coordIndex++;
              }
              geometryIndex++;
            }
            multiFeatureIndex++;
          }
          break;
        case "GeometryCollection":
          for (j = 0; j < geometry.geometries.length; j++) {
            if (coordEach(
              geometry.geometries[j],
              callback,
              excludeWrapCoord
            ) === false)
              return false;
          }
          break;
        default:
          throw new Error("Unknown Geometry Type");
      }
    }
  }
}

// src/crs/index.ts
var CRSTypes = /* @__PURE__ */ ((CRSTypes3) => {
  CRSTypes3["WGS84"] = "WGS84";
  CRSTypes3["WGS1984"] = "WGS84" /* WGS84 */;
  CRSTypes3["EPSG4326"] = "WGS84" /* WGS84 */;
  CRSTypes3["GCJ02"] = "GCJ02";
  CRSTypes3["AMap"] = "GCJ02" /* GCJ02 */;
  CRSTypes3["BD09"] = "BD09";
  CRSTypes3["BD09LL"] = "BD09" /* BD09 */;
  CRSTypes3["Baidu"] = "BD09" /* BD09 */;
  CRSTypes3["BMap"] = "BD09" /* BD09 */;
  CRSTypes3["BD09MC"] = "BD09MC";
  CRSTypes3["BD09Meter"] = "BD09MC" /* BD09MC */;
  CRSTypes3["EPSG3857"] = "EPSG3857";
  CRSTypes3["EPSG900913"] = "EPSG3857" /* EPSG3857 */;
  CRSTypes3["EPSG102100"] = "EPSG3857" /* EPSG3857 */;
  CRSTypes3["WebMercator"] = "EPSG3857" /* EPSG3857 */;
  CRSTypes3["WM"] = "EPSG3857" /* EPSG3857 */;
  return CRSTypes3;
})(CRSTypes || {});
var WGS84 = {
  to: {
    ["GCJ02" /* GCJ02 */]: WGS84ToGCJ02,
    ["BD09" /* BD09 */]: compose(GCJ02ToBD09, WGS84ToGCJ02),
    ["BD09MC" /* BD09MC */]: compose(BD09toBD09MC, GCJ02ToBD09, WGS84ToGCJ02),
    ["EPSG3857" /* EPSG3857 */]: WGS84ToEPSG3857
  }
};
var GCJ02 = {
  to: {
    ["WGS84" /* WGS84 */]: GCJ02ToWGS84,
    ["BD09" /* BD09 */]: GCJ02ToBD09,
    ["BD09MC" /* BD09MC */]: compose(BD09toBD09MC, GCJ02ToBD09),
    ["EPSG3857" /* EPSG3857 */]: compose(WGS84ToEPSG3857, GCJ02ToWGS84)
  }
};
var BD09 = {
  to: {
    ["WGS84" /* WGS84 */]: compose(GCJ02ToWGS84, BD09ToGCJ02),
    ["GCJ02" /* GCJ02 */]: BD09ToGCJ02,
    ["EPSG3857" /* EPSG3857 */]: compose(WGS84ToEPSG3857, GCJ02ToWGS84, BD09ToGCJ02),
    ["BD09MC" /* BD09MC */]: BD09toBD09MC
  }
};
var EPSG3857 = {
  to: {
    ["WGS84" /* WGS84 */]: EPSG3857ToWGS84,
    ["GCJ02" /* GCJ02 */]: compose(WGS84ToGCJ02, EPSG3857ToWGS84),
    ["BD09" /* BD09 */]: compose(GCJ02ToBD09, WGS84ToGCJ02, EPSG3857ToWGS84),
    ["BD09MC" /* BD09MC */]: compose(
      BD09toBD09MC,
      GCJ02ToBD09,
      WGS84ToGCJ02,
      EPSG3857ToWGS84
    )
  }
};
var BD09MC = {
  to: {
    ["WGS84" /* WGS84 */]: compose(GCJ02ToWGS84, BD09ToGCJ02, BD09MCtoBD09),
    ["GCJ02" /* GCJ02 */]: compose(BD09ToGCJ02, BD09MCtoBD09),
    ["EPSG3857" /* EPSG3857 */]: compose(
      WGS84ToEPSG3857,
      GCJ02ToWGS84,
      BD09ToGCJ02,
      BD09MCtoBD09
    ),
    ["BD09" /* BD09 */]: BD09MCtoBD09
  }
};
var crsMap = {
  WGS84,
  GCJ02,
  BD09,
  EPSG3857,
  BD09MC
};
var crs_default = crsMap;

// src/transform.ts
function transform2(input, crsFrom, crsTo) {
  assert(!!input, "The args[0] input coordinate is required");
  assert(!!crsFrom, "The args[1] original coordinate system is required");
  assert(!!crsTo, "The args[2] target coordinate system is required");
  const from = crs_default[crsFrom];
  assert(!!from, `Invalid original coordinate system: ${crsFrom}`);
  const to = crsFrom === crsTo ? void 0 : from.to[crsTo];
  assert(
    crsFrom === crsTo || !!to,
    `Invalid target coordinate system: ${crsTo}`
  );
  const type = typeof input;
  assert(
    type === "string" || type === "object",
    `Invalid input coordinate type: ${type}`
  );
  if (type === "string") {
    try {
      input = JSON.parse(input);
    } catch (e) {
      throw new Error(`Invalid input coordinate: ${input}`);
    }
  }
  let isPosition = false;
  if (isArray(input)) {
    assert(input.length >= 2, `Invalid input coordinate: ${input}`);
    assert(
      isNumber(input[0]) && isNumber(input[1]),
      `Invalid input coordinate: ${input}`
    );
    input = input.map(Number);
    isPosition = true;
  }
  if (crsFrom === crsTo) return input;
  const convert = to;
  if (isPosition) {
    const position = input;
    const converted = convert(position);
    return [...converted, ...position.slice(2)];
  }
  coordEach(input, (coord) => {
    [coord[0], coord[1]] = convert(coord);
  });
  return input;
}

// src/index.ts
var exported = __spreadProps(__spreadValues({}, CRSTypes), {
  // 兼容原来gcoord.WGS84的使用方式
  CRSTypes,
  transform: transform2
});
var index_default = exported;

export { index_default as default };
