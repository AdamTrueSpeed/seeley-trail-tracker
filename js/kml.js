// Writing the Google Earth export, and reading an existing KML / KMZ trail map.

import { widthLabel, widthNote } from './width.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cdata = (s) => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const num = (v, d) => Number(v).toFixed(d);
const coord = (p) => `${num(p.lon, 7)},${num(p.lat, 7)},${p.alt == null ? 0 : num(p.alt, 1)}`;

/** High-visibility line colours, as CSS and as KML (aabbggrr). */
export const TRAIL_COLORS = {
  orange: { label: 'Neon orange', css: '#ff6a00', kml: 'ff006aff' },
  cyan: { label: 'Cyan', css: '#00e5ff', kml: 'ffffe500' },
  magenta: { label: 'Magenta', css: '#ff2bd6', kml: 'ffd62bff' },
  yellow: { label: 'Yellow', css: '#ffee00', kml: 'ff00eeff' },
};

function segmentBalloon(s, system) {
  const alts = s.points.map((p) => p.alt).filter((a) => a != null);
  const rows = s.points.map((p, i) =>
    `<tr><td>${i + 1}</td><td>${num(p.lat, 6)}</td><td>${num(p.lon, 6)}</td><td>${p.alt == null ? '' : num(p.alt, 1)}</td></tr>`).join('');
  const facts = [
    ['Trail system', esc(system)],
    ['Branch', s.branch ? esc(s.branch) : 'not named yet'],
    ['Segment ID', s.id],
    ['Length', `${num(s.length, 0)} m`],
    ['Mapping points', s.points.length],
    ['Times ridden', s.passes],
    s.width ? ['Estimated width', `${widthLabel(s.width)}. ${esc(widthNote(s.width))}`] : null,
    s.width && s.width.passes > 1 ? ['Outermost passes + vehicle', `${num(s.width.swept, 1)} m (no allowance for GPS error)`] : null,
    s.width ? ['Widest through', `${esc(s.width.via ?? 'vehicle')}, ${num(s.width.vehicle, 2)} m, measured from its centre line`] : null,
    s.vehicles?.length ? ['Travelled by', s.vehicles.map(esc).join(', ')] : null,
    alts.length ? ['GPS elevation', `${num(Math.min(...alts), 0)} to ${num(Math.max(...alts), 0)} m`] : null,
    s.ref ? ['On existing map as', s.ref] : null,
    s.contributors?.length ? ['Surveyed by', s.contributors.map(esc).join(', ')] : null,
    s.rides.length ? ['From rides', s.rides.map(esc).join(', ')] : null,
  ].filter(Boolean).map(([k, v]) => `<tr><th align="left">${k}</th><td>${v}</td></tr>`).join('');
  return `<table>${facts}</table>`
    + `<p><b>Point by point</b> (elevation is raw GPS height)</p>`
    + `<table border="1" cellpadding="3" cellspacing="0"><tr><th>#</th><th>Latitude</th><th>Longitude</th><th>Elev m</th></tr>${rows}</table>`;
}

/** One trail segment as a KML placemark: the line, its balloon, and the same facts as data fields. */
function segmentPlacemark(s, system) {
  const data = (name, value) => `<Data name="${name}"><value>${esc(value)}</value></Data>`;
  return [
    '<Placemark>',
    `<name>${esc(s.name ?? s.id)}</name>`,
    `<description>${cdata(segmentBalloon(s, system))}</description>`,
    '<ExtendedData>'
      + data('trail_system', system)
      + data('branch', s.branch ?? '')
      + data('segment_id', s.id)
      + data('length_m', num(s.length, 1))
      + data('points', s.points.length)
      + data('passes', s.passes)
      + (s.width
        ? data('width_m', num(s.width.width, 1))
          + data('width_basis', s.width.basis)
          + data('width_swept_m', num(s.width.swept, 1))
          + data('width_passes', s.width.passes)
          + data('gps_accuracy_m', s.width.acc == null ? '' : num(s.width.acc, 1))
          + data('vehicle_width_m', num(s.width.vehicle, 2))
          + data('vehicles', (s.vehicles ?? []).join('; '))
        : '')
      + data('existing_trail', s.ref ?? '')
      + data('contributors', (s.contributors ?? []).join('; '))
      + data('rides', s.rides.join('; '))
      + '</ExtendedData>',
    '<styleUrl>#trail</styleUrl>',
    '<LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>'
      + `<coordinates>${s.points.map(coord).join(' ')}</coordinates></LineString>`,
    '</Placemark>',
  ].join('\n');
}

/**
 * @param o.name      name of the trail system (becomes the document name)
 * @param o.branches  [{ name (null = not named yet), length, segments }] the segments grouped by branch
 * @param o.travel    [{ name, rides, dist }] distance covered by each method of travel
 * @param o.segments  merged network from buildNetwork (optionally with .name / .ref / .branch / .contributors)
 * @param o.waypoints [{ name, by, lat, lon, alt, t, rideName }]
 * @param o.rides     [{ name, by, vehicle: { name }, startedAt, segments: [[{lat, lon, alt}]] }] raw tracks (hidden folder)
 * @param o.contributors [{ name, rides, dist, pins }] who recorded what
 * @param o.color     key of TRAIL_COLORS
 * @param o.settings  { threshold, smoothing } recorded in the description
 */
export function buildKml(o) {
  const color = (TRAIL_COLORS[o.color] ?? TRAIL_COLORS.orange).kml;
  const total = o.segments.reduce((d, s) => d + s.length, 0);
  const who = (o.contributors ?? []).map((c) =>
    `${c.name} (${c.rides} ride${c.rides === 1 ? '' : 's'}, ${num(c.dist / 1000, 2)} km, ${c.pins} pin${c.pins === 1 ? '' : 's'})`);
  const travel = (o.travel ?? []).map((t) => `${t.name} ${num(t.dist / 1000, 2)} km (${t.rides} ride${t.rides === 1 ? '' : 's'})`);
  const groups = o.branches ?? [{ name: null, length: total, segments: o.segments }];
  const namedBranches = groups.filter((b) => b.name !== null).length;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
  out.push('<Document>');
  out.push(`<name>${esc(o.name)}</name>`);
  out.push(`<description>${esc(
    `${o.name}: GPS-surveyed trail system with ${namedBranches} named branch${namedBranches === 1 ? '' : 'es'}, `
    + `${o.segments.length} segments, ${num(total, 0)} m, from ${o.rides.length} ride(s). `
    + (travel.length ? `Distance travelled: ${travel.join('; ')}. ` : '')
    + (who.length ? `Contributors: ${who.join('; ')}. ` : '')
    + `Overlapping passes merged within ${o.settings.threshold} m; smoothing ${o.settings.smoothing}. `
    + 'Trail widths are rough estimates: the width of the widest thing known to have travelled each segment, with the phone on its centre line, plus any spread between passes that GPS error does not explain. '
    + `Exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by Seeley Trail Tracker.`)}</description>`);
  out.push(`<Style id="trail"><LineStyle><color>${color}</color><width>4</width></LineStyle></Style>`);
  out.push('<Style id="raw"><LineStyle><color>99ffffff</color><width>1.5</width></LineStyle></Style>');
  out.push('<Style id="pin"><IconStyle><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href></Icon>'
    + '<hotSpot x="20" y="2" xunits="pixels" yunits="pixels"/></IconStyle></Style>');
  out.push('<Style id="photo"><IconStyle><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/camera.png</href></Icon></IconStyle></Style>');

  // One folder per branch, so Google Earth lists the system as: system > Branches > branch > its segments.
  out.push('<Folder><name>Branches</name><open>1</open>');
  for (const b of groups) {
    out.push(`<Folder><name>${esc(b.name ?? 'Not named yet')}</name>`
      + `<description>${esc(`${b.name === null ? 'Stretches with no branch name yet' : 'Branch'} of ${o.name}: `
        + `${b.segments.length} segment${b.segments.length === 1 ? '' : 's'}, ${num(b.length, 0)} m.`)}</description>`);
    for (const s of b.segments) out.push(segmentPlacemark(s, o.name));
    out.push('</Folder>');
  }
  out.push('</Folder>');

  if (o.waypoints.length) {
    out.push('<Folder><name>Waypoints</name><open>1</open>');
    for (const p of o.waypoints) {
      // p.image is the picture's path inside the KMZ file (see buildKmz).
      const info = (p.image ? `<p><img src="${esc(p.image)}" width="480"></p>` : '')
        + `<table>`
        + `<tr><th align="left">Latitude</th><td>${num(p.lat, 6)}</td></tr>`
        + `<tr><th align="left">Longitude</th><td>${num(p.lon, 6)}</td></tr>`
        + (p.alt == null ? '' : `<tr><th align="left">GPS elevation</th><td>${num(p.alt, 1)} m</td></tr>`)
        + `<tr><th align="left">Marked</th><td>${new Date(p.t).toLocaleString()}</td></tr>`
        + (p.by ? `<tr><th align="left">Marked by</th><td>${esc(p.by)}</td></tr>` : '')
        + (p.rideName ? `<tr><th align="left">During</th><td>${esc(p.rideName)}</td></tr>` : '')
        + `</table>`;
      out.push(`<Placemark><name>${esc(p.name)}</name><description>${cdata(info)}</description><styleUrl>#${p.image ? 'photo' : 'pin'}</styleUrl>`
        + `<Point><altitudeMode>clampToGround</altitudeMode><coordinates>${coord(p)}</coordinates></Point></Placemark>`);
    }
    out.push('</Folder>');
  }

  if (o.rides.length) {
    // Unmerged tracks, hidden by default: tick the folder in Google Earth to compare.
    out.push('<Folder><name>Raw GPS rides (unmerged)</name><visibility>0</visibility>');
    for (const r of o.rides) {
      const lines = r.segments.filter((s) => s.length > 1).map((s) =>
        `<LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>${s.map(coord).join(' ')}</coordinates></LineString>`);
      if (!lines.length) continue;
      out.push(`<Placemark><name>${esc(r.name)}</name><visibility>0</visibility>`
        + `<description>${esc(`Raw GPS track recorded ${new Date(r.startedAt).toLocaleString()}${r.by ? ` by ${r.by}` : ''}${r.vehicle ? ` (${r.vehicle.name})` : ''}`)}</description>`
        + `<styleUrl>#raw</styleUrl><MultiGeometry>${lines.join('')}</MultiGeometry></Placemark>`);
    }
    out.push('</Folder>');
  }

  out.push('</Document>');
  out.push('</kml>');
  return out.join('\n');
}

// ---- KMZ: the KML plus its pictures in one file ---------------------------------

let crcTable;
function crc32(bytes) {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A KMZ is a zip file holding doc.kml and the pictures it refers to. The
 * entries are stored without compression (JPEGs do not shrink anyway), which
 * keeps this to a few lines and every unzip tool can read it.
 * @param kml   the KML text
 * @param files [{ name: 'files/x.jpg', data: Uint8Array }]
 * @returns Blob
 */
export function buildKmz(kml, files) {
  const entries = [{ name: 'doc.kml', data: new TextEncoder().encode(kml) }, ...files];
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const crc = crc32(e.data);
    // Fields shared by the entry's own header and its line in the directory at the end.
    const common = new DataView(new ArrayBuffer(26));
    common.setUint16(0, 20, true);          // version needed
    common.setUint16(2, 0x0800, true);      // names are UTF-8
    common.setUint16(4, 0, true);           // stored, not compressed
    common.setUint16(6, time, true);
    common.setUint16(8, date, true);
    common.setUint32(10, crc, true);
    common.setUint32(14, e.data.length, true);
    common.setUint32(18, e.data.length, true);
    common.setUint16(22, name.length, true);
    common.setUint16(24, 0, true);          // no extra field
    const local = new DataView(new ArrayBuffer(4));
    local.setUint32(0, 0x04034b50, true);
    parts.push(local.buffer, common.buffer, name, e.data);
    const dir = new DataView(new ArrayBuffer(6)), tail = new DataView(new ArrayBuffer(14));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);             // version made by
    tail.setUint32(10, offset, true);       // where this entry starts (comment, disk and attribute fields stay 0)
    central.push(dir.buffer, common.buffer, tail.buffer, name);
    offset += 4 + 26 + name.length + e.data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/vnd.google-earth.kmz' });
}

// ---- reading ---------------------------------------------------------------

const kmlColorToCss = (c) => (/^[0-9a-f]{8}$/i.test(c) ? `#${c.slice(6, 8)}${c.slice(4, 6)}${c.slice(2, 4)}` : null);

function parseCoords(text) {
  const pts = [];
  for (const tuple of (text ?? '').trim().split(/\s+/)) {
    const [lon, lat] = tuple.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon]);
  }
  return pts;
}

/**
 * Pull the lines and labelled points out of a KML document.
 * @returns { name, lines: [{ name, color, parts: [[[lat, lon]]], boundary }], points: [{ name, lat, lon }] }
 */
export function parseKml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('That file is not a readable KML map.');
  const child = (el, tag) => [...el.children].find((c) => c.localName === tag);
  const lineColor = (style) => {
    const ls = style?.getElementsByTagName('LineStyle')[0];
    return ls ? kmlColorToCss(ls.getElementsByTagName('color')[0]?.textContent.trim() ?? '') : null;
  };

  const styles = {};
  for (const st of doc.getElementsByTagName('Style')) {
    const id = st.getAttribute('id');
    if (id) styles['#' + id] = lineColor(st);
  }
  for (const sm of doc.getElementsByTagName('StyleMap')) {
    const id = sm.getAttribute('id');
    const url = sm.getElementsByTagName('styleUrl')[0]?.textContent.trim();
    if (id && url) styles['#' + id] = styles[url] ?? null;
  }

  const lines = [], points = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const name = child(pm, 'name')?.textContent.trim() ?? '';
    const parts = [];
    for (const tag of ['LineString', 'LinearRing']) {
      for (const g of pm.getElementsByTagName(tag)) {
        const pts = parseCoords(g.getElementsByTagName('coordinates')[0]?.textContent);
        if (pts.length > 1) parts.push(pts);
      }
    }
    if (parts.length) {
      const color = lineColor(child(pm, 'Style')) ?? styles[child(pm, 'styleUrl')?.textContent.trim()] ?? null;
      lines.push({ name, color, parts, boundary: /boundary|property line|lot line/i.test(name) });
    }
    const pt = pm.getElementsByTagName('Point')[0];
    if (pt) {
      const [p] = parseCoords(pt.getElementsByTagName('coordinates')[0]?.textContent);
      if (p) points.push({ name, lat: p[0], lon: p[1] });
    }
  }
  if (!lines.length && !points.length) throw new Error('No trails or points were found in that file.');
  const docName = doc.getElementsByTagName('Document')[0];
  return { name: (docName && child(docName, 'name')?.textContent.trim()) || 'Existing trail map', lines, points };
}

/** Text of a .kml file, or of the first .kml inside a .kmz (zip) file. */
export async function readKmlFile(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  if (!(u8[0] === 0x50 && u8[1] === 0x4b)) return new TextDecoder().decode(u8);

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = u8.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('That KMZ file could not be opened.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (/\.kml$/i.test(name)) {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = u8.subarray(start, start + size);
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8) {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).text();
      }
      throw new Error('That KMZ file uses a compression this app cannot read.');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('No KML map was found inside that KMZ file.');
}
