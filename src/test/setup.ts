import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

/**
 * jsdom's Blob/File predate `arrayBuffer()`, which every real browser has and
 * which the import pipeline uses to control text decoding. Polyfill it here
 * rather than working around it in production code.
 */
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(this)
    })
  }
}
