/**
 * SVG Grabber – Vectorisation Web Worker
 *
 * Receives an ImageData object, traces it with ImageTracerJS, optionally
 * removes a background colour, then applies Ramer-Douglas-Peucker (RDP)
 * simplification to the straight-line segments of every SVG path.
 *
 * Message in  → { type:'TRACE', imageData, options }
 * Message out → { type:'TRACE_RESULT', svgString }
 *            or { type:'TRACE_ERROR',  error }
 */
import ImageTracer from 'imagetracerjs';

// ── Ramer-Douglas-Peucker ────────────────────────────────────────────────────

/**
 * Perpendicular distance from `point` to the line defined by
 * `lineStart`→`lineEnd` (clamped to the segment).
 */
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

/** Recursive RDP point-reduction. Returns a new (smaller) array of points. */
function rdpReduce(points, epsilon) {
  if (points.length < 3) return points.slice();

  let maxDist = 0;
  let maxIdx  = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left  = rdpReduce(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpReduce(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [points[0], points[points.length - 1]];
}

// ── SVG-path tokeniser ───────────────────────────────────────────────────────

/** Split a path `d` attribute into an array of { type, values } segments. */
function tokenizePathData(d) {
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  const segments = [];
  let m;
  while ((m = re.exec(d)) !== null) {
    segments.push({
      type:   m[1].toUpperCase(),
      values: m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number),
    });
  }
  return segments;
}

const fmt = (n) => parseFloat(n.toFixed(2));

/**
 * Apply RDP to every consecutive run of L (line-to) commands inside a path
 * `d` string.  Q/C (bezier) commands are left intact.
 */
function simplifyPathData(d, epsilon) {
  if (epsilon <= 0) return d;

  const segments = tokenizePathData(d);
  const result   = [];
  // polyline accumulates consecutive L endpoints so RDP can act on the run.
  let polyline   = [];

  function flushPolyline() {
    if (polyline.length === 0) return;
    const reduced = polyline.length >= 3 ? rdpReduce(polyline, epsilon) : polyline.slice();
    for (let i = 1; i < reduced.length; i++) {
      result.push(`L ${fmt(reduced[i][0])} ${fmt(reduced[i][1])}`);
    }
    // Keep last point as seed for the next consecutive L-run.
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
        // Pass through any other command unchanged.
        result.push(`${cmd} ${n.join(' ')}`);
        polyline = n.length >= 2 ? [[n[n.length - 2], n[n.length - 1]]] : [];
    }
  }

  flushPolyline();
  return result.join(' ');
}

/** Apply RDP simplification to every `d="…"` attribute in an SVG string. */
function simplifySVGPaths(svgString, epsilon) {
  return svgString.replace(/ d="([^"]+)"/g, (_match, d) => {
    return ` d="${simplifyPathData(d, epsilon)}"`;
  });
}

// ── Background removal ───────────────────────────────────────────────────────

/**
 * Sample the four corner patches of `imageData` and return the most
 * frequently occurring colour as { r, g, b }.
 */
function detectCornerColor(imageData) {
  const { data, width, height } = imageData;
  const patch = 8; // px per corner
  const counts = new Map();

  function sample(px, py) {
    for (let y = py; y < Math.min(py + patch, height); y++) {
      for (let x = px; x < Math.min(px + patch, width); x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] < 128) continue; // skip transparent
        const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  sample(0, 0);
  sample(width - patch, 0);
  sample(0, height - patch);
  sample(width - patch, height - patch);

  if (counts.size === 0) return null;

  let best = null, bestCount = 0;
  for (const [key, c] of counts) {
    if (c > bestCount) { bestCount = c; best = key; }
  }
  const [r, g, b] = best.split(',').map(Number);
  return { r, g, b };
}

/**
 * Set pixels whose colour is within `tolerance` (Euclidean RGB distance) of
 * the background colour to fully transparent.  Returns a new ImageData.
 */
function eraseBackground(imageData, bgColor, tolerance) {
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data);

  for (let i = 0; i < out.length; i += 4) {
    const dr = out[i]     - bgColor.r;
    const dg = out[i + 1] - bgColor.g;
    const db = out[i + 2] - bgColor.b;
    if (Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance) {
      out[i + 3] = 0; // make transparent
    }
  }

  return new ImageData(out, width, height);
}

// ── Main ─────────────────────────────────────────────────────────────────────

self.onmessage = (e) => {
  if (e.data.type !== 'TRACE') return;

  const { imageData, options = {} } = e.data;

  const {
    colorQuantization = 50,  // 0–100
    smoothing         = 0,   // 0–100
    simplification    = 0,   // 0–100
    removeBackground  = false,
    bgTolerance       = 32,  // Euclidean RGB tolerance for bg removal
  } = options;

  // ── Map slider percentages to ImageTracerJS options ──────────────────────
  const numColors = Math.max(2, Math.min(16, Math.round(2 + (colorQuantization / 100) * 14)));
  const blurRadius = Math.round((smoothing / 100) * 5);
  const lineFilter = smoothing > 50;
  // pathomit: minimum path bounding-box size; higher → fewer tiny artefacts.
  const pathomit = Math.max(4, Math.round(4 + (simplification / 100) * 44));
  // RDP epsilon: scale 0-100 → 0-5 (device pixels).
  const rdpEpsilon = (simplification / 100) * 5;

  const tracerOptions = {
    numberofcolors:     numColors,
    blurradius:         blurRadius,
    linefilter:         lineFilter,
    rightangleenhance:  true,
    strokewidth:        1,
    scale:              1,
    ltres:              1,
    qtres:              1,
    pathomit,
  };

  try {
    let imgData = imageData;

    // ── Optional background removal (pre-trace) ──────────────────────────
    if (removeBackground) {
      const bgColor = detectCornerColor(imgData);
      if (bgColor) {
        imgData = eraseBackground(imgData, bgColor, bgTolerance);
      }
    }

    let svgString = ImageTracer.imagedataToSVG(imgData, tracerOptions);

    // ── RDP simplification (post-trace) ──────────────────────────────────
    if (rdpEpsilon > 0) {
      svgString = simplifySVGPaths(svgString, rdpEpsilon);
    }

    self.postMessage({ type: 'TRACE_RESULT', svgString });
  } catch (err) {
    self.postMessage({ type: 'TRACE_ERROR', error: err.message });
  }
};
