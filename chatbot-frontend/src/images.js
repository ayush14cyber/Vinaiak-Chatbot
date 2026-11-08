/** Most images one message may carry, as the chatbot takes. */
export const MAX_IMAGES = 3;
/** Largest image the chatbot takes, in bytes. */
const MAX_BYTES = 1024 * 1024;
/** Tries at shrinking an image under `MAX_BYTES`: its longest side, and the JPEG quality. */
const SIZES = [
  [1536, 0.85],
  [1536, 0.7],
  [1024, 0.7],
  [768, 0.6],
];

/**
 * An image attached to a message: what the chatbot gets, and a small copy to show and keep.
 * @typedef {{ image: string; thumbnail: string }} Attachment
 */

/**
 * `file`, any image the browser can read, as a JPEG the chatbot takes, with its thumbnail. Large
 * photos and screenshots are shrunk, as the model doesn't need more. Rejects what isn't an image.
 */
export async function attach(file) {
  const bitmap = await createImageBitmap(file);
  try {
    for (const [side, quality] of SIZES) {
      const image = jpeg(bitmap, side, quality);
      if (bytes(image) <= MAX_BYTES) return { image, thumbnail: jpeg(bitmap, 256, 0.6) };
    }
    throw new Error("The image stays too large");
  } finally {
    bitmap.close();
  }
}

/** `bitmap` as a JPEG `data:` URL, at most `side` pixels wide and tall. */
function jpeg(bitmap, side, quality) {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  // JPEG has no transparency, which would turn black.
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** The size of the data in `dataUrl`, which is base64. */
function bytes(dataUrl) {
  return Math.floor(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);
}
