import {normalizeImageForModel, probeImage, nativeImageProbeAvailable} from '../../interactive-tui/imageEngine';
import {makePngFixture} from '../helpers/png-fixture';

describe('sift interactive — image engine', () => {
  it('extracts true mime and dimensions from image bytes', () => {
    const result = probeImage(makePngFixture(2, 3));

    expect(result).toMatchObject({
      mime: 'image/png',
      width: 2,
      height: 3,
      source: 'ts',
    });
    expect(result.bytes).toBeGreaterThan(29);
  });

  it('accepts generated high-resolution PNG fixtures under the default caps', () => {
    const result = probeImage(makePngFixture(3840, 2160, 'solid'));

    expect(result).toMatchObject({
      mime: 'image/png',
      width: 3840,
      height: 2160,
      source: 'ts',
    });
    expect(result.bytes).toBeLessThan(5 * 1024 * 1024);
  });

  it('rejects oversized image payloads before trusting metadata', () => {
    expect(() => probeImage(makePngFixture(2, 3), {maxBytes: 8})).toThrow('image paste: image too large');
  });

  it('rejects high-resolution images over the configured pixel cap', () => {
    expect(() => probeImage(makePngFixture(3840, 2160, 'solid'), {maxPixels: 1024 * 1024})).toThrow(
      'image paste: image too large'
    );
  });

  it('downscales high-resolution images over the configured pixel cap before model send', async () => {
    const result = await normalizeImageForModel(makePngFixture(3840, 2160, 'solid'), {
      maxPixels: 1024 * 1024,
    });

    expect(result.normalized).toBe(true);
    expect(result.mime).toBe('image/jpeg');
    expect(result.width * result.height).toBeLessThanOrEqual(1024 * 1024);
    expect(result.bytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(result.original).toMatchObject({mime: 'image/png', width: 3840, height: 2160});
  });

  it('re-encodes high-entropy images that exceed the default byte cap', async () => {
    const input = makePngFixture(1920, 1080, 'noise');

    expect(() => probeImage(input)).toThrow('image paste: image too large');

    const result = await normalizeImageForModel(input);
    expect(result.normalized).toBe(true);
    expect(result.mime).toBe('image/jpeg');
    expect(result.bytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(result.width).toBeLessThanOrEqual(1920);
    expect(result.height).toBeLessThanOrEqual(1080);
  });

  it('rejects unsupported non-image bytes', () => {
    expect(() => probeImage(new TextEncoder().encode('not an image'))).toThrow('image paste: unsupported image type');
  });

  it('does not require native Zig library under the Node/Jest runtime', () => {
    expect(nativeImageProbeAvailable()).toBe(false);
  });
});
