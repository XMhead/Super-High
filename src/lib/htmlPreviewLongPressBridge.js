;(() => {
  const MESSAGE_TYPE = 'superhigh:html-preview-long-press';
  const DELAY = 600;
  const TOLERANCE = 6;
  let timer = 0;
  let start = null;
  let suppressClick = false;
  const cancel = () => { clearTimeout(timer); timer = 0; start = null; };
  document.addEventListener('pointerdown', (event) => {
    cancel();
    suppressClick = false;
    if (event.button !== 0 || !event.isPrimary) return;
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      timer = 0;
      start = null;
      suppressClick = true;
      window.parent.postMessage({ type: MESSAGE_TYPE }, '*');
    }, DELAY);
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > TOLERANCE) cancel();
  }, true);
  document.addEventListener('pointerup', cancel, true);
  document.addEventListener('pointercancel', cancel, true);
  window.addEventListener('blur', cancel);
  document.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
})();
