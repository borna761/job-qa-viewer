// Minimal OffscreenCanvas stand-in so makeFaviconImageData() completes
// without throwing in Node (it has no OffscreenCanvas global at all).
// Deliberately not trying to verify actual pixel output — that's the
// low-risk, stable part of background.js's icon code (see the split into
// decideTabIconState vs resolveIcon in background.js). This just lets
// orchestration tests confirm the pipeline ran to completion by checking
// that setIcon received a truthy imageData, not what's inside it.
class FakeCanvasContext {
  beginPath() {}
  fill() {}
  stroke() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  roundRect() {}
  getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
}

class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return new FakeCanvasContext();
  }
}

module.exports = { FakeOffscreenCanvas };
