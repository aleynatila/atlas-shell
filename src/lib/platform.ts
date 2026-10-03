// WKWebView's user agent always contains "Macintosh"; good enough to pick
// window chrome without an async OS-plugin round-trip.
export const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);

// Native traffic lights overlaid on the tab bar (see tauri.macos.conf.json).
// y is measured from the top of the window; 36px bar − 14px buttons ≈ 11.
export const MAC_TRAFFIC_LIGHTS = { x: 14, y: 12 };
// Width the tab bar keeps free for them: x + 3 buttons spaced 20px + margin.
export const MAC_TRAFFIC_LIGHTS_WIDTH = 78;
