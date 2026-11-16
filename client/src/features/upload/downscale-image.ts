/**
 * Browser-side image preparation for the upload queue: decode, downscale and re-encode.
 *
 * Downscaling is a courtesy, not the control. It keeps a capture's token cost independent of the
 * resolution it was taken at, while the dimension bound is enforced by the server, which re-reads
 * the dimensions from the received bytes. So this module never discards a file the server would
 * accept: a file that cannot be decoded here is reported to the caller as a plain rejection for
 * that one file, and a file that decodes is always returned resized rather than refused.
 *
 * The blank-frame check is advisory only. A uniformly coloured image is still queued and still
 * submitted; whether an image is readable is decided by the extraction outcome on the server, and
 * this hint exists solely so the upload surface can annotate the thumbnail.
 *
 * No request leaves this module, and no credential, service address or environment value is read
 * here. Only the browser's own decoder and canvas are used, so no image library enters the bundle.
 */

import {
  ACCEPTED_IMAGE_MIME_TYPES,
  MAX_LONG_EDGE_PX,
  type AcceptedImageMimeType,
} from "@trade-read/shared";

/** The size an image is drawn and re-encoded at. */
export interface TargetSize {
  width: number;
  height: number;
}

/**
 * The size to downscale a decoded image to before upload.
 *
 * Images already within the long-edge bound keep their dimensions, because upscaling would add
 * bytes without adding detail. Larger images are scaled proportionally and the long edge is then
 * pinned to the bound, so rounding cannot leave it a pixel short of the limit the server checks.
 * Degenerate dimensions resolve to one pixel per side rather than to zero, which a canvas cannot
 * represent.
 */
export function computeTargetSize(width: number, height: number): TargetSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }

  const longEdge = Math.max(width, height);

  if (longEdge <= MAX_LONG_EDGE_PX) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }

  const scale = MAX_LONG_EDGE_PX / longEdge;
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));

  return width >= height
    ? { width: MAX_LONG_EDGE_PX, height: scaledHeight }
    : { width: scaledWidth, height: MAX_LONG_EDGE_PX };
}

/**
 * Every fourth pixel. A capture is sampled rather than scanned: a uniform image is uniform across
 * far fewer pixels than it holds, and a full scan of a canvas at the bound costs more than the hint
 * is worth.
 */
const SAMPLE_STRIDE_PX = 4;

/** Rec. 709 relative luminance of the pixel starting at `offset`, treating a short tail as black. */
function luminanceAt(pixels: Uint8ClampedArray, offset: number): number {
  const red = pixels[offset] ?? 0;
  const green = pixels[offset + 1] ?? 0;
  const blue = pixels[offset + 2] ?? 0;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Whether a decoded frame looks uniformly coloured, which is the only way this module can suggest
 * that an image holds no chart.
 *
 * The answer is advisory: the caller annotates the thumbnail and still submits the file, because
 * readability is the server's extraction outcome to decide. A frame with nothing to compare is
 * therefore reported as not blank, so a one-pixel edge case cannot raise the note. An unusable
 * tolerance falls back to zero, which admits only exactly equal luminances.
 */
export function isBlankFrame(pixels: Uint8ClampedArray, tolerance = 8): boolean {
  if (pixels.length < 4) {
    return false;
  }

  const limit = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
  const baseline = luminanceAt(pixels, 0);
  const strideBytes = SAMPLE_STRIDE_PX * 4;

  for (let offset = strideBytes; offset + 2 < pixels.length; offset += strideBytes) {
    if (Math.abs(luminanceAt(pixels, offset) - baseline) > limit) {
      return false;
    }
  }

  return true;
}

/**
 * The tuple's first entry is the lossless format, and it doubles as the fallback for a file whose
 * own type is not one of the accepted ones. Deriving both from the shared tuple keeps this module
 * from restating a content type.
 */
const LOSSLESS_ENCODE_TYPE: AcceptedImageMimeType = ACCEPTED_IMAGE_MIME_TYPES[0];

/** High enough that printed chart labels survive the re-encode, which only lossy formats take. */
const LOSSY_ENCODE_QUALITY = 0.92;

/** One queued image, prepared for upload. */
export interface DownscaledImage {
  blob: Blob;
  width: number;
  height: number;
  blankFrame: boolean;
}

function isAcceptedImageMimeType(value: string): value is AcceptedImageMimeType {
  return (ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

async function decodeToBitmap(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("This browser cannot decode images, so the file was not added.");
  }

  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`"${file.name}" could not be read as an image.`);
  }
}

function encodeCanvas(
  canvas: HTMLCanvasElement,
  type: AcceptedImageMimeType,
  quality: number | undefined,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error("The image could not be re-encoded after downscaling."));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });
}

/**
 * Decodes one queued file, downscales it within the long-edge bound and re-encodes it for upload.
 *
 * Rejects only for a file this browser cannot decode or re-encode, which the caller reports
 * against that one file while the rest of the queue stands. The decoded bitmap is released on
 * every path, including failure, because it is held outside the JavaScript heap.
 */
export async function downscaleImage(file: File): Promise<DownscaledImage> {
  const bitmap = await decodeToBitmap(file);

  try {
    const target = computeTargetSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("This browser cannot provide a 2D canvas, so the image was not added.");
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, target.width, target.height);

    // Read from the pixels that will be uploaded rather than from the source, and before the
    // re-encode, so the note describes the bytes the server will actually receive.
    const blankFrame = isBlankFrame(context.getImageData(0, 0, target.width, target.height).data);

    const encodeType = isAcceptedImageMimeType(file.type) ? file.type : LOSSLESS_ENCODE_TYPE;
    const quality = encodeType === LOSSLESS_ENCODE_TYPE ? undefined : LOSSY_ENCODE_QUALITY;
    const blob = await encodeCanvas(canvas, encodeType, quality);

    return { blob, width: target.width, height: target.height, blankFrame };
  } finally {
    bitmap.close();
  }
}
