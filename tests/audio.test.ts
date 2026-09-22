import { describe, expect, it } from 'vitest';
import { pcmToWav } from '../src/audio.ts';

describe('G2 PCM to WAV (REQ-001)', () => {
  it('writes a 16 kHz mono PCM16LE header and preserves sample order across chunks', () => {
    // Little-endian samples: zero, maximum positive, minimum negative, minus one.
    const chunks = [new Uint8Array([0, 0, 255, 127]), new Uint8Array([0, 128, 255, 255])];
    const wav = pcmToWav(chunks);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const text = (start: number, end: number) => new TextDecoder().decode(wav.subarray(start, end));
    expect(wav.byteLength).toBe(52);
    expect(text(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(text(8, 12)).toBe('WAVE');
    expect(text(12, 16)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 40)).toBe('data');
    expect(view.getUint32(40, true)).toBe(8);
    expect([44, 46, 48, 50].map(offset => view.getInt16(offset, true))).toEqual([0, 32767, -32768, -1]);
  });

  it('accepts exactly 30 seconds but rejects a single extra sample', () => {
    const limit = 16_000 * 2 * 30;
    expect(pcmToWav([new Uint8Array(limit)]).byteLength).toBe(44 + limit);
    expect(() => pcmToWav([new Uint8Array(limit), new Uint8Array(2)])).toThrow();
  });

  it.each([
    { label: 'no chunks', chunks: [] },
    { label: 'empty chunk', chunks: [new Uint8Array(0)] },
    { label: 'one byte', chunks: [new Uint8Array(1)] },
    { label: 'odd combined size', chunks: [new Uint8Array(2), new Uint8Array(1)] },
  ])(
    'rejects $label', ({ chunks }) => {
      expect(() => pcmToWav(chunks)).toThrow();
    },
  );

  it('respects chunk offsets and returns a copy that cannot mutate the original audio', () => {
    const backing = new Uint8Array([90, 90, 1, 2, 3, 4, 91, 91]);
    const chunk = backing.subarray(2, 6);
    const wav = pcmToWav([chunk]);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
    wav[44] = 99;
    expect([...backing]).toEqual([90, 90, 1, 2, 3, 4, 91, 91]);
    chunk[1] = 88;
    expect(wav[45]).toBe(2);
  });
});
