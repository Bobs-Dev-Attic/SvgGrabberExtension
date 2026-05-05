/**
 * SVG Grabber – Vectorisation Web Worker
 *
 * Receives an ImageData object, traces it with ImageTracerJS, optionally
 * removes a background region, then applies Ramer-Douglas-Peucker (RDP)
 * simplification to the straight-line segments of every SVG path.
 *
 * Message in  → { type:'TRACE', imageData, options }
 * Message out → { type:'TRACE_RESULT', svgString }
 *            or { type:'TRACE_ERROR',  error }
 */
import ImageTracer from 'imagetracerjs';

// ── Ramer-Douglas-Peucker ────────────────────────────────────────────────────

function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];
  if (dx === 0 && dy === 0) {
    return Math.hypot(point[0] - lineStart[0], point[1] - lineStart[1]);
  }
  const lenSq = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1,
    ((point[0] - lineStart[0]) * dx + (point[1] - lineStart[1]) * dy) / lenSq,
  ));
  return Math.hypot(
    point[0] - (lineStart[0] + t * dx),
    point[1] - (lineStart[1] + t * dy),
  );
}

function rdpReduce(points, epsilon) {
  if (points.length < 3) return points.slice();

  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpReduce(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpReduce(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [points[0], points[points.length - 1]];
}

// ── SVG-path tokeniser ───────────────────────────────────────────────────────

function tokenizePathData(d) {
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  const segments = [];
  let m;
  while ((m = re.exec(d)) !== null) {
    segments.push({
      type: m[1].toUpperCase(),
      values: m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number),
    });
  }
  return segments;
}

const fmt = (n) => parseFloat(n.toFixed(2));

function simplifyPathData(d, epsilon) {
  if (epsilon <= 0) return d;

  const segments = tokenizePathData(d);
  const result = [];
  let polyline = [];

  function flushPolyline() {
    if (polyline.length === 0) return;
    const reduced = polyline.length >= 3 ? rdpReduce(polyline, epsilon) : polyline.slice();
    for (let i = 1; i < reduced.length; i++) {
      result.push(`L ${fmt(reduced[i][0])} ${fmt(reduced[i][1])}`);
    }
    polyline = [polyline[polyline.length - 1].slice()];
  }

  for (const { type: cmd, values: n } of segments) {
    switch (cmd) {
      case 'M':
        flushPolyline();
        polyline = [];
        result.push(`M ${fmt(n[0])} ${fmt(n[1])}`);
        polyline.push([n[0], n[1]]);
        break;
      case 'L':
        polyline.push([n[0], n[1]]);
        break;
      case 'Q':
        flushPolyline();
        result.push(`Q ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])} ${fmt(n[3])}`);
        polyline = [[n[2], n[3]]];
        break;
      case 'C':
        flushPolyline();
        result.push(`C ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])} ${fmt(n[3])} ${fmt(n[4])} ${fmt(n[5])}`);
        polyline = [[n[4], n[5]]];
        break;
      case 'Z':
        flushPolyline();
        polyline = [];
        result.push('Z');
        break;
      default:
        flushPolyline();
        result.push(`${cmd} ${n.join(' ')}`);
        polyline = n.length >= 2 ? [[n[n.length - 2], n[n.length - 1]]] : [];
    }
  }

  flushPolyline();
  return result.join(' ');
}

function simplifySVGPaths(svgString, epsilon) {
  return svgString.replace(/ d="([^"]+)"/g, (_match, d) => {
    return ` d="${simplifyPathData(d, epsilon)}"`;
  });
}

function estimatePathBounds(d) {
  const segments = tokenizePathData(d);
  let cursorX = 0;
  let cursorY = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function includePoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    cursorX = x;
    cursorY = y;
  }

  for (const { type: cmd, values } of segments) {
    switch (cmd) {
      case 'M':
      case 'L':
      case 'T':
        for (let i = 0; i < values.length; i += 2) includePoint(values[i], values[i + 1]);
        break;
      case 'H':
        values.forEach((x) => includePoint(x, cursorY));
        break;
      case 'V':
        values.forEach((y) => includePoint(cursorX, y));
        break;
      case 'Q':
      case 'S':
        for (let i = 0; i < values.length; i += 4) {
          includePoint(values[i], values[i + 1]);
          includePoint(values[i + 2], values[i + 3]);
        }
        break;
      case 'C':
        for (let i = 0; i < values.length; i += 6) {
          includePoint(values[i], values[i + 1]);
          includePoint(values[i + 2], values[i + 3]);
          includePoint(values[i + 4], values[i + 5]);
        }
        break;
      case 'A':
        for (let i = 0; i < values.length; i += 7) {
          includePoint(values[i + 5], values[i + 6]);
        }
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { area: 0 };
  }

  return { area: Math.max(1, (maxX - minX) * (maxY - minY)) };
}

function limitSvgPaths(svgString, coveragePercent) {
  if (coveragePercent >= 100) return svgString;

  const pathMatches = [...svgString.matchAll(/<path\b[^>]*d="([^"]+)"[^>]*\/>/g)];
  if (pathMatches.length < 2) return svgString;

  const keepCount = Math.max(1, Math.ceil(pathMatches.length * (coveragePercent / 100)));
  if (keepCount >= pathMatches.length) return svgString;

  const ranked = pathMatches.map((match, index) => ({
    index,
    tag: match[0],
    start: match.index,
    end: match.index + match[0].length,
    area: estimatePathBounds(match[1]).area,
  }));

  const selected = new Set(
    ranked
      .slice()
      .sort((a, b) => b.area - a.area)
      .slice(0, keepCount)
      .map((item) => item.index),
  );

  const orderedTags = ranked
    .filter((item) => selected.has(item.index))
    .map((item) => item.tag)
    .join('');

  const first = ranked[0];
  const last = ranked[ranked.length - 1];
  return `${svgString.slice(0, first.start)}${orderedTags}${svgString.slice(last.end)}`;
}

// ── Background removal ───────────────────────────────────────────────────────

function getPixelIndex(width, x, y) {
  return (y * width + x) * 4;
}

function sampleAverageColor(imageData, x, y, radius) {
  const { data, width, height } = imageData;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  const startX = Math.max(0, x - radius);
  const endX = Math.min(width - 1, x + radius);
  const startY = Math.max(0, y - radius);
  const endY = Math.min(height - 1, y + radius);

  for (let py = startY; py <= endY; py++) {
    for (let px = startX; px <= endX; px++) {
      const i = getPixelIndex(width, px, py);
      if (data[i + 3] < 8) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
  }

  if (count === 0) {
    const i = getPixelIndex(width, x, y);
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

function colorDistanceSq(data, i, color) {
  const dr = data[i] - color.r;
  const dg = data[i + 1] - color.g;
  const db = data[i + 2] - color.b;
  return dr * dr + dg * dg + db * db;
}

function floodFillMask(imageData, seeds, tolerance, sampleRadius) {
  const { data, width, height } = imageData;
  const total = width * height;
  const mask = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const toleranceSq = tolerance * tolerance;

  for (const seed of seeds) {
    if (!seed) continue;
    const sx = Math.max(0, Math.min(width - 1, Math.round(seed.x)));
    const sy = Math.max(0, Math.min(height - 1, Math.round(seed.y)));
    const targetColor = sampleAverageColor(imageData, sx, sy, sampleRadius);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    const startIndex = sy * width + sx;

    if (visited[startIndex]) continue;

    queue[tail++] = startIndex;
    visited[startIndex] = 1;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      const pixelIndex = idx * 4;

      if (data[pixelIndex + 3] < 8 || colorDistanceSq(data, pixelIndex, targetColor) > toleranceSq) {
        continue;
      }

      mask[idx] = 1;

      if (x > 0) {
        const next = idx - 1;
        if (!visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (x + 1 < width) {
        const next = idx + 1;
        if (!visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (y > 0) {
        const next = idx - width;
        if (!visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (y + 1 < height) {
        const next = idx + width;
        if (!visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
  }

  return mask;
}

function dilateMask(mask, width, height, radius) {
  if (radius <= 0) return mask;

  let current = mask;

  for (let step = 0; step < radius; step++) {
    const next = current.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!current[idx]) continue;
        if (x > 0) next[idx - 1] = 1;
        if (x + 1 < width) next[idx + 1] = 1;
        if (y > 0) next[idx - width] = 1;
        if (y + 1 < height) next[idx + width] = 1;
      }
    }
    current = next;
  }

  return current;
}

function applyMask(imageData, mask) {
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data);

  for (let idx = 0; idx < mask.length; idx++) {
    if (mask[idx]) {
      out[idx * 4 + 3] = 0;
    }
  }

  return new ImageData(out, width, height);
}

function cropTransparentBounds(imageData) {
  const { data, width, height } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    return imageData;
  }

  const croppedWidth = maxX - minX + 1;
  const croppedHeight = maxY - minY + 1;
  if (croppedWidth === width && croppedHeight === height) {
    return imageData;
  }

  const out = new Uint8ClampedArray(croppedWidth * croppedHeight * 4);
  for (let y = 0; y < croppedHeight; y++) {
    const srcStart = ((minY + y) * width + minX) * 4;
    const srcEnd = srcStart + croppedWidth * 4;
    out.set(data.slice(srcStart, srcEnd), y * croppedWidth * 4);
  }

  return new ImageData(out, croppedWidth, croppedHeight);
}

function buildBackgroundMask(imageData, options) {
  const {
    bgTolerance = 32,
    bgSampleRadius = 1,
    bgExpand = 1,
    bgSeedPoint = null,
  } = options;

  const { width, height } = imageData;
  const cornerSeeds = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 },
  ];

  const seeds = bgSeedPoint ? [bgSeedPoint] : cornerSeeds;
  const mask = floodFillMask(imageData, seeds, bgTolerance, bgSampleRadius);
  return dilateMask(mask, width, height, bgExpand);
}

// ── Main ─────────────────────────────────────────────────────────────────────

self.onmessage = (e) => {
  if (e.data.type !== 'TRACE') return;

  const { imageData, options = {} } = e.data;

  const {
    colorQuantization = 50,
    smoothing = 0,
    simplification = 0,
    removeBackground = false,
    trimTransparent = false,
    pathCoverage = 100,
  } = options;

  const numColors = Math.max(2, Math.min(16, Math.round(2 + (colorQuantization / 100) * 14)));
  const blurRadius = Math.round((smoothing / 100) * 5);
  const lineFilter = smoothing > 50;
  const pathomit = Math.max(4, Math.round(4 + (simplification / 100) * 44));
  const rdpEpsilon = (simplification / 100) * 5;

  const tracerOptions = {
    numberofcolors: numColors,
    blurradius: blurRadius,
    linefilter: lineFilter,
    rightangleenhance: true,
    strokewidth: 1,
    scale: 1,
    ltres: 1,
    qtres: 1,
    pathomit,
  };

  try {
    let imgData = imageData;

    if (removeBackground) {
      const mask = buildBackgroundMask(imgData, options);
      imgData = applyMask(imgData, mask);
      if (trimTransparent) {
        imgData = cropTransparentBounds(imgData);
      }
    }

    let svgString = ImageTracer.imagedataToSVG(imgData, tracerOptions);

    if (rdpEpsilon > 0) {
      svgString = simplifySVGPaths(svgString, rdpEpsilon);
    }

    svgString = limitSvgPaths(svgString, pathCoverage);

    self.postMessage({ type: 'TRACE_RESULT', svgString });
  } catch (err) {
    self.postMessage({ type: 'TRACE_ERROR', error: err.message });
  }
};
