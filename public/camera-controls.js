// Optional controls never participate in opening/stopping the decoder. A browser
// rejecting a camera setting must not tear down a working scanner.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function cameraFeatures(capabilities = {}, supported = {}) {
  const range = capabilities.zoom;
  const zoom = range && Number.isFinite(range.min) && Number.isFinite(range.max) &&
    range.min > 0 && range.max > range.min
    ? { min: range.min, max: range.max, step: Number.isFinite(range.step) && range.step > 0 ? range.step : 0.1 }
    : null;
  const modes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
  return {
    torch: capabilities.torch === true || (Array.isArray(capabilities.torch) && capabilities.torch.includes(true)),
    zoom,
    // Keep tracking as staff move between the barcode and the phone. Choosing
    // single-shot first can leave focus fixed after the first tap.
    focus: modes.includes('continuous') ? 'continuous' : modes.includes('single-shot') ? 'single-shot' : null,
    continuousFocus: modes.includes('continuous'),
    points: supported.pointsOfInterest === true,
  };
}
export function zoomValue(value, range) {
  const number = Number(value);
  if (!range || !Number.isFinite(number)) throw new Error('Invalid zoom value.');
  return clamp(Number((range.min + Math.round((clamp(number, range.min, range.max) - range.min) / range.step) * range.step).toFixed(6)), range.min, range.max);
}
export function focusPoint(x, y, rect, mirrored = false) {
  if (!(rect.width > 0 && rect.height > 0)) return { x: 0.5, y: 0.5 };
  const horizontal = clamp((x - rect.left) / rect.width, 0, 1);
  return { x: mirrored ? 1 - horizontal : horizontal, y: clamp((y - rect.top) / rect.height, 0, 1) };
}

export class CameraSettings {
  constructor(track) { this.track = track; this.active = true; this.accepted = {}; this.pending = Promise.resolve(); }
  close() { this.active = false; }
  apply(patch, { remove = [] } = {}) {
    const operation = this.pending.then(async () => {
      if (!this.active || this.track.readyState === 'ended') return false;
      // Keep capture/device constraints and previously accepted controls. Avoid
      // mutually contradictory advanced sets when a slider is moved again.
      const current = this.track.getConstraints?.() || {};
      const changes = { ...this.accepted, ...patch }, base = { ...current };
      for (const key of remove) delete changes[key];
      const replaced = [...Object.keys(changes), ...remove];
      for (const key of replaced) delete base[key];
      const advanced = (current.advanced || []).map((set) => {
        const kept = { ...set }; for (const key of replaced) delete kept[key]; return kept;
      }).filter((set) => Object.keys(set).length);
      await this.track.applyConstraints({ ...base, advanced: [...advanced, changes] });
      if (!this.active || this.track.readyState === 'ended') return false;
      this.accepted = changes;
      return true;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function read(track, method) { try { return track?.[method]?.() || {}; } catch { return {}; } }

export function attachCameraControls({ box, video, track, onClose, onCamera, active }) {
  const settings = new CameraSettings(track);
  const events = new AbortController();
  const features = cameraFeatures(read(track, 'getCapabilities'), navigator.mediaDevices?.getSupportedConstraints?.() || {});
  const initial = read(track, 'getSettings');
  const tools = node('div', '', 'camera-tools');
  tools.setAttribute('aria-label', 'Scanner controls');
  const buttons = node('div', '', 'camera-buttons');
  const message = node('p', '', 'camera-message');
  message.setAttribute('role', 'status');
  const hint = node('p', 'Keep the whole barcode inside the frame. If it is blurry, move a little further away.', 'hint');
  tools.append(buttons, message, hint);
  box.append(tools);
  const live = () => settings.active && active();
  const say = (text) => { if (live()) message.textContent = text; };
  const listen = (element, event, handler, options = {}) => element.addEventListener(event, handler, { ...options, signal: events.signal });
  const button = (text, handler) => {
    const control = node('button', text, 'secondary'); control.type = 'button';
    listen(control, 'click', handler); buttons.append(control); return control;
  };
  let torchOn = initial.torch === true;
  if (features.torch) {
    const torch = button(torchOn ? 'Light off' : 'Light on', async () => {
      torch.disabled = true;
      try {
        const next = !torchOn;
        if (await settings.apply({ torch: next })) {
          torchOn = next; torch.textContent = next ? 'Light off' : 'Light on';
          torch.setAttribute('aria-pressed', String(next)); say(next ? 'Light on.' : 'Light off.');
        }
      } catch { say('This camera could not change its light. Scanning is still running.'); }
      finally { if (live()) torch.disabled = false; }
    });
    torch.setAttribute('aria-pressed', String(torchOn));
  }
  if (features.zoom) {
    const row = node('label', 'Zoom', 'camera-zoom'), output = node('output');
    const slider = node('input'); slider.type = 'range'; slider.min = features.zoom.min;
    slider.max = features.zoom.max; slider.step = features.zoom.step;
    slider.value = zoomValue(initial.zoom ?? features.zoom.min, features.zoom);
    const display = () => { output.textContent = `${Number(slider.value).toFixed(1)}×`; slider.setAttribute('aria-valuetext', output.textContent); };
    display(); row.append(output, slider); tools.insertBefore(row, message);
    // Apply after the drag/keyboard change, not for every touch-move event.
    listen(slider, 'input', display);
    listen(slider, 'change', async () => {
      const value = zoomValue(slider.value, features.zoom); slider.disabled = true;
      try {
        if (await settings.apply({ zoom: value })) {
          const actual = read(track, 'getSettings').zoom;
          slider.value = Number.isFinite(actual) ? zoomValue(actual, features.zoom) : value;
          display(); say(Number.isFinite(actual) && Math.abs(actual - value) > features.zoom.step
            ? 'This camera kept its current zoom. Try another camera below.' : `Zoom ${output.textContent}.`);
        }
      } catch {
        slider.value = zoomValue(read(track, 'getSettings').zoom ?? initial.zoom ?? features.zoom.min, features.zoom);
        display(); say('Zoom is unavailable on this camera. Scanning is still running.');
      } finally { if (live()) slider.disabled = false; }
    });
  }
  let focusing = false, markerTimer, focusButton, lastPoint = { x: 0.5, y: 0.5 };
  const marker = node('span', '', 'camera-focus-marker'); marker.hidden = true; marker.setAttribute('aria-hidden', 'true'); box.append(marker);
  const canTapFocus = () => !!features.focus && features.points;
  const canRefocus = () => canTapFocus() || features.focus === 'single-shot';
  const updateHint = () => {
    hint.textContent = 'Keep the whole barcode inside the frame. If it is blurry, move a little further away.';
    if (canTapFocus()) hint.textContent += ' Tap the barcode to choose a focus area. Refocus retries that spot (or the centre before a tap). The yellow square marks your request, not confirmed sharpness.';
    else if (features.focus === 'single-shot') hint.textContent += ' Use Refocus for a fresh focus attempt. This camera cannot focus at a tapped point.';
    else hint.textContent += ' Focus is controlled by your phone; tap-to-focus is not available on this camera/browser.';
    const unavailable = [!features.torch && 'light', !features.zoom && 'zoom'].filter(Boolean);
    if (unavailable.length) hint.textContent += ` This camera/browser does not offer ${unavailable.join(', ')} controls.`;
    if (focusButton) focusButton.hidden = !canRefocus();
  };
  async function refocus(point = lastPoint) {
    if (focusing || !live() || !canRefocus()) return;
    focusing = true;
    if (focusButton) focusButton.disabled = true;
    if (canTapFocus()) {
      lastPoint = point;
      const rect = video.getBoundingClientRect(), boxRect = box.getBoundingClientRect();
      const mirrored = getComputedStyle(video).transform.startsWith('matrix(-1');
      marker.style.left = `${rect.left - boxRect.left + rect.width * (mirrored ? 1 - point.x : point.x)}px`;
      marker.style.top = `${rect.top - boxRect.top + rect.height * point.y}px`;
      marker.hidden = false; clearTimeout(markerTimer); markerTimer = setTimeout(() => { marker.hidden = true; }, 900);
    }
    say('Requesting focus… Hold the barcode steady.');
    try {
      const patch = { focusMode: features.focus };
      if (features.points) patch.pointsOfInterest = [point];
      let applied;
      try { applied = await settings.apply(patch); }
      catch (error) {
        if (!features.points) throw error;
        // Some browsers advertise points but the selected lens refuses them.
        features.points = false;
        marker.hidden = true;
        updateHint();
        // Remove an earlier successful point too, so it cannot poison fallback
        // or later light/zoom requests if the lens stops accepting points.
        applied = await settings.apply({ focusMode: features.focus }, { remove: ['pointsOfInterest'] });
      }
      if (applied) {
        const actual = read(track, 'getSettings');
        if (features.points) {
          const confirmed = actual.pointsOfInterest?.some(p => Math.abs(p.x - point.x) < 0.02 && Math.abs(p.y - point.y) < 0.02);
          if (!confirmed) {
            marker.hidden = true;
            say('Focus requested, but this camera has not confirmed the point. Move a little further away or try another camera.');
          } else say(actual.focusMode === 'continuous'
            ? 'Focus area requested. Automatic focus keeps adjusting as you move.'
            : 'Focus area requested. Hold steady; tap again if you move.');
        } else say(features.continuousFocus
          ? 'Tap-to-focus is unavailable on this camera. Automatic focus remains in control.'
          : 'Autofocus requested. Keep the barcode near the centre.');
      }
    } catch { marker.hidden = true; say('This camera could not refocus on request. Move slightly further away and hold steady.'); }
    finally { focusing = false; if (live() && focusButton) focusButton.disabled = false; }
  }
  if (canRefocus()) {
    focusButton = button('Refocus', () => { void refocus(); });
    listen(box, 'click', (event) => {
      if (tools.contains(event.target) || focusing || !canTapFocus() || !live()) return;
      const rect = video.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
      const mirrored = getComputedStyle(video).transform.startsWith('matrix(-1');
      void refocus(focusPoint(event.clientX, event.clientY, rect, mirrored));
    });
  }
  if (onClose) button('Close camera', onClose);
  updateHint();
  // Autofocus is best-effort and does not block camera startup or teardown.
  if (features.continuousFocus) void settings.apply({ focusMode: 'continuous' }).catch(() => {});
  // enumerateDevices uses the existing permission; do not call getUserMedia a
  // second time merely to list lenses (that can interrupt iPhone capture).
  if (onCamera) void (async () => {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
      if (!live() || devices.length < 2) return;
      const label = node('label', 'Camera', 'camera-device'), select = node('select');
      devices.forEach((d, i) => select.append(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
      if (devices.some((d) => d.deviceId === initial.deviceId)) select.value = initial.deviceId;
      else { select.prepend(new Option('Current camera', '', true, true)); }
      label.append(select); tools.insertBefore(label, hint);
      listen(select, 'change', () => { if (select.value && live()) { select.disabled = true; onCamera(select.value); } });
    } catch { /* Listing lenses is optional; retain the running camera. */ }
  })();
  return { destroy() { settings.close(); events.abort(); clearTimeout(markerTimer); tools.remove(); marker.remove(); } };
}
