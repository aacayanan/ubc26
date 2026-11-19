"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * The living centerpiece: fine filaments spiralling up a funnel above a ringed
 * horizon.
 *
 * Three passes share one analytic model, all on the GPU — no CPU simulation,
 * no per-frame allocation:
 *   - dust     ~78k points advecting up the funnel
 *   - filament  ~96 drawn arcs tracing the funnel's skeleton
 *   - horizon   ~40 ring outlines spreading across the ground plane
 *
 * Behaviour:
 * - pauses when scrolled out of view or when the tab is hidden
 * - renders one composed still frame under `prefers-reduced-motion`
 * - leaves the CSS underlay visible if WebGL is unavailable, so the hero is
 *   never blank
 */
const VORTEX_COUNT = 74_000;
const GROUND_COUNT = 18_000;
const PULSE_COUNT = 9_000;

const LINE_STRANDS = 96;
const LINE_SEGMENTS = 96;
const RING_LINES = 40;
const RING_SEGMENTS = 128;

/** Shared analytic field. Every pass must agree or the arcs drift off the dust. */
const fieldGLSL = /* glsl */ `
  const float TAU = 6.28318530718;

  float hash1(float n) {
    return fract(sin(n * 12.9898) * 43758.5453);
  }

  vec3 funnelPoint(float strandUnit, float h, float t, out float depth, out float sk) {
    float strand = floor(strandUnit * ${LINE_STRANDS.toFixed(1)});
    float sj = fract(strandUnit * ${LINE_STRANDS.toFixed(1)});
    sk = hash1(strand);

    float radiusScale = 0.74 + 0.38 * sk;
    float twist = 4.6 + sj * 4.8;

    float ang = strand / ${LINE_STRANDS.toFixed(1)} * TAU
              + h * twist
              + t * (0.02 + sj * 0.02);

    float r = (pow(h, 3.1) * 10.5 + 0.05) * radiusScale;
    r += sin(h * 3.6 + sk * 6.283 + t * 0.3) * 0.34 * h;

    vec3 p = vec3(cos(ang) * r, h * 7.0, sin(ang) * r);
    depth = mix(0.35, 1.0, smoothstep(-7.0, 4.5, p.z));
    return p;
  }

  vec3 ringPoint(float ringUnit, float angSeed, float t, out float ring) {
    ring = floor(ringUnit * 30.0) / 30.0;
    float r = 0.55 + pow(ring, 0.7) * 6.8;
    float ang = angSeed * TAU + t * (0.02 + 0.1 / (r + 1.0));
    return vec3(cos(ang) * r, 0.0, sin(ang) * r);
  }

  /* Three model hues feeding one arena: magenta, violet, pale ink. */
  vec3 modelTint(float strandUnit) {
    float m = mod(floor(strandUnit * ${LINE_STRANDS.toFixed(1)}), 3.0);
    if (m < 0.5) return vec3(1.0, 0.16, 0.55);
    if (m < 1.5) return vec3(0.55, 0.45, 1.0);
    return vec3(0.93, 0.88, 0.99);
  }

  /* A confirmed commitment: a ring wave running out across the plane. */
  vec3 pulsePoint(float angSeed, float phase) {
    float r = 0.35 + phase * 8.2;
    float ang = angSeed * TAU + phase * 1.6;
    return vec3(cos(ang) * r, 0.0, sin(ang) * r);
  }

  vec3 funnelColour(float h) {
    vec3 magenta = vec3(1.0, 0.16, 0.55);
    vec3 violet  = vec3(0.55, 0.45, 1.0);
    vec3 hot     = vec3(1.0, 0.82, 0.93);
    vec3 c = mix(magenta, violet, smoothstep(0.28, 0.95, h));
    return mix(hot, c, smoothstep(0.0, 0.1, h));
  }
`;

const dustVertex = /* glsl */ `
  uniform float uTime;
  uniform float uPR;
  uniform float uSize;

  attribute vec3 aSeed;
  attribute float aKind;

  varying vec3 vColor;
  varying float vAlpha;

  ${fieldGLSL}

  void main() {
    vec3 p;
    float t = uTime;

    if (aKind < 1.5) {
      /* Inbound commitments: dots stream in from the wide mouth and fall
         toward the throat, brightening as they are sealed. */
      float sj = fract(aSeed.x * ${LINE_STRANDS.toFixed(1)});
      float h = 1.0 - fract(aSeed.y + t * (0.022 + sj * 0.03));

      float depth;
      float sk;
      p = funnelPoint(aSeed.x, h, t, depth, sk);

      vColor = mix(funnelColour(h), modelTint(aSeed.x), 0.55);
      vAlpha = smoothstep(0.0, 0.1, h)
             * (1.0 - smoothstep(0.32, 1.0, h))
             * 0.95
             * depth;
    } else if (aKind < 2.5) {
      /* horizon ring — the ledger the commitments land on */
      float ring;
      p = ringPoint(aSeed.x, aSeed.y, t, ring);

      vec3 magenta = vec3(1.0, 0.18, 0.576);
      vec3 fade    = vec3(0.48, 0.3, 0.7);

      vColor = mix(magenta, fade, smoothstep(0.0, 1.0, ring));
      vAlpha = (1.0 - smoothstep(0.0, 1.0, ring)) * 0.34;
    } else {
      /* outward confirmation pulses */
      float phase = fract(t * 0.085 + aSeed.z);
      p = pulsePoint(aSeed.y, phase);

      vColor = mix(vec3(1.0, 0.9, 0.97), vec3(1.0, 0.18, 0.58),
                   smoothstep(0.0, 0.55, phase));
      vAlpha = (1.0 - phase) * smoothstep(0.0, 0.08, phase) * 0.7;
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * uPR * (14.0 / -mv.z), 0.55, 2.8);
  }
`;

const lineVertex = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;

  attribute vec3 aSeed;
  attribute float aKind;

  varying vec3 vColor;
  varying float vAlpha;

  ${fieldGLSL}

  void main() {
    vec3 p;
    float t = uTime;

    if (aKind < 0.5) {
      /* drawn filament following the funnel skeleton */
      float h = aSeed.y;
      float depth;
      float sk;
      p = funnelPoint(aSeed.x, h, t, depth, sk);

      vColor = mix(funnelColour(h), modelTint(aSeed.x), 0.6);
      vAlpha = smoothstep(0.0, 0.06, h)
             * (1.0 - smoothstep(0.55, 1.0, h))
             * depth
             * uStrength;
    } else {
      /* ring outline on the ground plane */
      float ring;
      p = ringPoint(aSeed.x, aSeed.y, t, ring);

      vec3 magenta = vec3(1.0, 0.22, 0.6);
      vec3 fade    = vec3(0.5, 0.32, 0.75);

      vColor = mix(magenta, fade, smoothstep(0.0, 1.0, ring));
      vAlpha = (1.0 - smoothstep(0.0, 1.0, ring)) * uStrength * 0.5;
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

const dustFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c);
    if (d2 > 0.25) discard;
    float a = smoothstep(0.25, 0.0, d2);
    gl_FragColor = vec4(vColor, a * vAlpha);
  }
`;

function buildDustGeometry() {
  const total = VORTEX_COUNT + GROUND_COUNT + PULSE_COUNT;
  const positions = new Float32Array(total * 3);
  const seeds = new Float32Array(total * 3);
  const kinds = new Float32Array(total);

  let n = 0;
  const push = (kind: number) => {
    const o = n * 3;
    seeds[o] = Math.random();
    seeds[o + 1] = Math.random();
    seeds[o + 2] = Math.random();
    kinds[n] = kind;
    n += 1;
  };
  for (let i = 0; i < VORTEX_COUNT; i++) push(0);
  for (let i = 0; i < GROUND_COUNT; i++) push(1);
  for (let i = 0; i < PULSE_COUNT; i++) push(2);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
  g.setAttribute("aKind", new THREE.BufferAttribute(kinds, 1));
  return g;
}

function buildLineGeometry() {
  const segs = LINE_STRANDS * LINE_SEGMENTS + RING_LINES * RING_SEGMENTS;
  const verts = segs * 2;
  const positions = new Float32Array(verts * 3);
  const seeds = new Float32Array(verts * 3);
  const kinds = new Float32Array(verts);

  let v = 0;
  const put = (kind: number, seedX: number, seedY: number) => {
    const o = v * 3;
    seeds[o] = seedX;
    seeds[o + 1] = seedY;
    seeds[o + 2] = 0;
    kinds[v] = kind;
    v += 1;
  };

  // funnel filaments: continuous strands sampled bottom to top
  for (let s = 0; s < LINE_STRANDS; s++) {
    const strandUnit = (s + 0.5) / LINE_STRANDS;
    for (let i = 0; i < LINE_SEGMENTS; i++) {
      put(0, strandUnit, i / LINE_SEGMENTS);
      put(0, strandUnit, (i + 1) / LINE_SEGMENTS);
    }
  }

  // horizon ring outlines
  for (let r = 0; r < RING_LINES; r++) {
    const ringUnit = (r + 0.5) / RING_LINES;
    for (let i = 0; i < RING_SEGMENTS; i++) {
      put(1, ringUnit, i / RING_SEGMENTS);
      put(1, ringUnit, (i + 1) / RING_SEGMENTS);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
  g.setAttribute("aKind", new THREE.BufferAttribute(kinds, 1));
  return g;
}

export default function VortexField({
  className = "",
}: {
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      return; // CSS underlay stays
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 120);
    camera.position.set(0, 3.1, 9.2);
    camera.lookAt(0, 2.35, 0);

    const uniforms = {
      uTime: { value: reduceMotion ? 18 : 0 },
      uPR: { value: dpr },
      uSize: { value: 1.18 },
      uStrength: { value: 0.5 },
    };

    const dustGeometry = buildDustGeometry();
    const dustMaterial = new THREE.ShaderMaterial({
      vertexShader: dustVertex,
      fragmentShader: dustFragment,
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dust = new THREE.Points(dustGeometry, dustMaterial);
    dust.frustumCulled = false;
    scene.add(dust);

    const lineGeometry = buildLineGeometry();
    const lineMaterial = new THREE.ShaderMaterial({
      vertexShader: lineVertex,
      fragmentShader,
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const filaments = new THREE.LineSegments(lineGeometry, lineMaterial);
    filaments.frustumCulled = false;
    scene.add(filaments);

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // keep the funnel framed on tall, narrow screens
      camera.fov = camera.aspect < 1 ? 64 : 50;
      camera.updateProjectionMatrix();
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(host);

    let raf = 0;
    let visible = true;
    let last = performance.now();
    let elapsed = reduceMotion ? 18 : 0;

    const render = () => {
      uniforms.uTime.value = elapsed;
      renderer.render(scene, camera);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      elapsed += dt;
      render();
    };

    const play = () => {
      if (reduceMotion || raf || !visible) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const pause = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    render(); // static first frame
    play();

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) play();
        else pause();
      },
      { threshold: 0 },
    );
    io.observe(host);

    const onVisibility = () => {
      if (document.hidden) pause();
      else play();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      pause();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      dustGeometry.dispose();
      dustMaterial.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div className={`absolute inset-0 ${className}`}>
      {/* Fallback the canvas composites over; also the composed still when
          WebGL is unavailable. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(56% 42% at 50% 76%, rgba(255,46,147,0.20), transparent 72%)," +
            "radial-gradient(44% 26% at 50% 96%, rgba(255,46,147,0.10), transparent 70%)," +
            "radial-gradient(40% 32% at 50% 26%, rgba(124,107,255,0.12), transparent 74%)",
        }}
      />
      <div ref={hostRef} className="absolute inset-0" aria-hidden="true" />
    </div>
  );
}
