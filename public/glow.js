// Grid with glows drifting between its intersections, in the same style as QuantumTrace's hero.
// Colours follow the status palette: red, amber and teal. Paused while hidden or off-screen,
// capped at about 30 frames a second, and a still frame for people who prefer reduced motion.
const PALETTE = ['255, 93, 82', '242, 180, 65', '67, 209, 177'];
const GRID = 48;
const GLOWS = 9;
const FRAME_MS = 33;

export function startGlow(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 0;
  let height = 0;
  let frame = 0;
  let lastDraw = 0;
  let visible = true;
  let glows = [];

  const snap = (max) => Math.floor(Math.random() * (max / GRID + 1)) * GRID;
  const make = () => ({
    x: snap(width),
    y: snap(height),
    tx: snap(width),
    ty: snap(height),
    r: Math.random() * 80 + 40,
    speed: Math.random() * 0.015 + 0.01,
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    alpha: still ? 1 : 0,
  });

  function draw(move) {
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(232, 235, 239, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= width; x += GRID) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (let y = 0; y <= height; y += GRID) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();

    for (const glow of glows) {
      if (move) {
        glow.x += (glow.tx - glow.x) * glow.speed;
        glow.y += (glow.ty - glow.y) * glow.speed;
        if (Math.abs(glow.tx - glow.x) < 1 && Math.abs(glow.ty - glow.y) < 1) {
          glow.tx = snap(width);
          glow.ty = snap(height);
        }
        glow.alpha = Math.min(1, glow.alpha + 0.02);
      }
      const gradient = ctx.createRadialGradient(glow.x, glow.y, 0, glow.x, glow.y, glow.r);
      gradient.addColorStop(0, `rgba(${glow.color}, 1)`);
      gradient.addColorStop(1, 'rgba(10, 13, 18, 0)');
      ctx.globalAlpha = glow.alpha;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(glow.x, glow.y, glow.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    glows = Array.from({ length: GLOWS }, make);
    draw(false);
  }

  function loop(time) {
    if (time - lastDraw >= FRAME_MS) {
      lastDraw = time;
      draw(true);
    }
    frame = requestAnimationFrame(loop);
  }

  function run() {
    cancelAnimationFrame(frame);
    if (!still && visible && !document.hidden) frame = requestAnimationFrame(loop);
  }

  resize();
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    run();
  }).observe(canvas);
  document.addEventListener('visibilitychange', run);
  run();
}
