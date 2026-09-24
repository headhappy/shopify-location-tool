// Keep the scan container measurable BEFORE Html5Qrcode creates its video.
// The library clears the container and reads clientWidth while it is empty.
export const CAMERA_VERSION = '1.4.1';

export function scanBox(width, height) {
  if (width < 60 || height < 60) throw new Error('Camera preview is too small. Open the scanner in a visible area.');
  return {
    width: Math.min(380, Math.floor(width * 0.9)),
    height: Math.min(230, Math.floor(height * 0.7)),
  };
}

function cameraError(error) {
  const detail = typeof error === 'string' ? error : error?.message || String(error || 'Unknown camera error');
  if (/NotAllowedError|PermissionDenied|permission denied/i.test(detail)) {
    return new Error('Camera permission was blocked. Allow Camera for this site in your browser, then tap Scan again.');
  }
  return new Error(`Could not start the scanner: ${detail}`);
}

export class Camera {
  constructor() {
    this.reader = null;
    this.box = null;
    this.generation = 0;
    this.pending = Promise.resolve();
    this.previousStyle = null;
  }

  // Serialise start/stop. Stopping during a permission prompt must wait for
  // the in-flight start to settle, not clear a video that is still starting.
  enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  async release() {
    const reader = this.reader, box = this.box, previous = this.previousStyle;
    this.reader = null;
    this.box = null;
    this.previousStyle = null;
    const videos = box ? [...box.querySelectorAll('video')] : [];
    const tracks = videos.flatMap(video => video.srcObject?.getTracks?.() || []);
    if (reader) {
      try { await reader.stop(); } catch { /* Not yet scanning, or startup failed. */ }
      try { reader.clear(); } catch { /* Video tracks are also released below. */ }
    }
    for (const track of tracks) track.stop();
    for (const video of videos) video.srcObject = null;
    if (box) {
      box.replaceChildren();
      box.style.display = previous?.display || '';
      box.style.width = previous?.width || '';
      box.removeAttribute('aria-busy');
      delete box.dataset.cameraState;
    }
  }

  stop() {
    ++this.generation; // Invalidate callbacks immediately, even during startup.
    return this.enqueue(() => this.release());
  }

  start(box, onCode, { continuous = false } = {}) {
    const generation = ++this.generation;
    return this.enqueue(async () => {
      await this.release();
      if (generation !== this.generation) return;
      if (!globalThis.Html5Qrcode) throw new Error('Camera library unavailable. Reload this page or type the barcode.');
      if (!box?.id || typeof onCode !== 'function') throw new Error('Scanner container or callback is missing.');
      this.box = box;
      this.previousStyle = { display: box.style.display, width: box.style.width };
      // Inline display is intentional: it beats .scanner:empty and older cached CSS.
      box.style.display = 'block';
      box.style.width = '100%';
      box.dataset.cameraState = 'starting';
      box.dataset.cameraVersion = CAMERA_VERSION;
      box.setAttribute('aria-busy', 'true');
      let decoding = false;
      try {
        if (box.clientWidth < 60) throw new Error('The camera area is hidden or too narrow. Open this page normally and try again.');
        const reader = new globalThis.Html5Qrcode(box.id);
        this.reader = reader;
        await reader.start(
          { facingMode: 'environment' },
          { fps: 8, qrbox: scanBox },
          text => {
            if (generation !== this.generation || decoding || !String(text ?? '').trim()) return;
            decoding = true;
            void (async () => {
              if (!continuous) {
                const stoppedGeneration = generation + 1;
                await this.stop();
                // A later Scan/Stop must not apply a code to a different field.
                if (this.generation !== stoppedGeneration) return;
              }
              await onCode(text);
            })().catch(error => console.error('Scan result could not be handled:', error))
              .finally(() => { decoding = false; });
          },
          () => {} // No code in this frame is normal; keep the camera open.
        );
        if (generation !== this.generation) {
          await this.release();
          return;
        }
        box.dataset.cameraState = 'scanning';
        box.setAttribute('aria-busy', 'false');
      } catch (error) {
        await this.release();
        if (generation === this.generation) throw cameraError(error);
      }
    });
  }
}
