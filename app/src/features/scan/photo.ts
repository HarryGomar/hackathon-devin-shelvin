import { Image } from 'expo-image';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { ScanInput } from '@/api/types';

type PhotoInput = Extract<ScanInput, { kind: 'photo' }>;

/** Longest side sent for identification, and JPEG quality (plan §8 Camera). */
const MAX_SIDE = 1024;
const JPEG_QUALITY = 0.7;

const SAMPLE_PHOTO = require('@/assets/images/sample-product.jpg');

/**
 * Downscales to at most 1024 px on the longest side and re-encodes as JPEG with base64.
 * Accepts a file/data/remote URI or an image ref loaded with expo-image.
 */
export async function preparePhoto(source: Parameters<typeof ImageManipulator.manipulate>[0]): Promise<PhotoInput> {
  const context = ImageManipulator.manipulate(source, { maxWidth: MAX_SIDE, maxHeight: MAX_SIDE });
  const image = await context.renderAsync();
  const result = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY, base64: true });
  if (!result.base64) throw new Error('Image manipulator returned no base64 data');
  return { kind: 'photo', uri: result.uri, base64: result.base64, mimeType: 'image/jpeg' };
}

/** The bundled placeholder photo, run through the same resize as a real photo. */
export async function prepareSamplePhoto(): Promise<PhotoInput> {
  const ref = await Image.loadAsync(SAMPLE_PHOTO);
  return preparePhoto(ref);
}

/** Opens the photo library. Resolves `undefined` when the user cancels. */
export async function pickPhotoFromLibrary(): Promise<PhotoInput | undefined> {
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
  const asset = result.canceled ? undefined : result.assets[0];
  return asset ? preparePhoto(asset.uri) : undefined;
}
