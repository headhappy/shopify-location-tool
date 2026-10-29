# Location scanner controls (1.4.2)

The Product Locations, Batch Scan and Scan Location pages share this helper.
Light and zoom appear only when the running camera advertises those capabilities.
Refocus requests single-shot focus, or continuous autofocus if that is the only
available mode. Taps use normalized points of interest when the browser supports
them; if that request fails, the control retries autofocus without a point.
The UI says focus was requested, never that the barcode is now in focus.

Zoom changes the video track used by both the preview and barcode decoder. It is
not a CSS enlargement of the preview. The slider uses the device's range/step.
Unsupported controls are explained inline. Camera selection lists the lenses
exposed by the browser after permission, using `enumerateDevices` without opening
a second stream just to obtain the list. This is especially important on phones
where another capture request can interrupt the first camera.

The 1.4.1 measurable-container and joined-video-playback fixes are preserved.
Camera start/stop remain serialized and generation-guarded. Optional controls use
a separate serialized queue, retain previous successful settings and capture
constraints, and ignore completions after teardown. Control failure never closes
the scanner. Closing, switching cameras and page navigation release the tracks;
single scans still close only after a valid result, and batch scans remain open.

No barcode images leave the browser. This change does not touch location saving,
Shopify inventory, bundle assemblies, credentials or API permissions.

## Validation limits

Automated browser tests use the real html5-qrcode 2.3.8 decoder with Chromium's
virtual camera. Hardware control responses and lens choices are simulated to
exercise support, rejection and lifecycle races. QR and Code 128 decoding are
also tested with generated images. Layout checks cover 320px/390px portrait and
844px landscape, alongside desktop.

These checks are not physical iPhone/Android camera tests. Lens hardware,
minimum focusing distance, browser support and permission settings differ.
On a real phone, check light on/off, the whole zoom range, tap/refocus, lens
selection, stop/reopen and background/return before relying on that device for
continuous stock work. Unsupported capabilities cannot be added by this website.

References:
- https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/getCapabilities
- https://www.w3.org/TR/image-capture/ (camera constraints and normalized focus points)
- https://scanapp.org/html5-qrcode-docs/docs/apis/classes/Html5Qrcode
