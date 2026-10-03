// WKWebView's user agent always contains "Macintosh"; good enough to pick
// window chrome without an async OS-plugin round-trip.
export const IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);

// Native traffic lights overlaid on the tab bar (see tauri.macos.conf.json).
// Tuned from a screenshot: y=12 left the buttons' centre 8pt above the
// 36px bar's; y moves them down 1:1.
export const MAC_TRAFFIC_LIGHTS = { x: 14, y: 20 };
// Width the tab bar keeps free for them: x + 3 buttons spaced 20px + margin.
export const MAC_TRAFFIC_LIGHTS_WIDTH = 78;
