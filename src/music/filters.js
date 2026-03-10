/**
 * Audio filter presets for Lavalink v4.
 * 14 built-in filters: nightcore, bassboost, 8d, lofi, earrape, chipmunk,
 * vaporwave, karaoke, tremolo, vibrato, rotation, distortion, soft, pop.
 */

export const FILTERS = {
  nightcore: {
    timescale: { speed: 1.3, pitch: 1.3, rate: 1.0 },
    equalizer: [
      { band: 0, gain: 0.1 },
      { band: 1, gain: 0.1 },
    ],
  },
  bassboost: {
    equalizer: [
      { band: 0, gain: 0.6 },
      { band: 1, gain: 0.5 },
      { band: 2, gain: 0.3 },
      { band: 3, gain: 0.1 },
    ],
  },
  '8d': {
    rotation: { rotationHz: 0.2 },
  },
  lofi: {
    timescale: { speed: 0.9, pitch: 0.85, rate: 0.9 },
    equalizer: [
      { band: 0, gain: 0.15 },
      { band: 1, gain: 0.15 },
    ],
    lowPass: { smoothing: 20.0 },
  },
  earrape: {
    equalizer: Array.from({ length: 15 }, (_, i) => ({ band: i, gain: 0.5 })),
    distortion: {
      sinOffset: 0.0, sinScale: 1.0,
      cosOffset: 0.0, cosScale: 1.0,
      tanOffset: 0.0, tanScale: 1.0,
      offset: 0.0, scale: 4.0,
    },
  },
  chipmunk: {
    timescale: { speed: 1.5, pitch: 1.5, rate: 1.0 },
  },
  vaporwave: {
    timescale: { speed: 0.8, pitch: 0.8, rate: 1.0 },
    equalizer: [
      { band: 0, gain: 0.3 },
      { band: 1, gain: 0.3 },
    ],
  },
  karaoke: {
    karaoke: {
      level: 1.0,
      monoLevel: 1.0,
      filterBand: 220.0,
      filterWidth: 100.0,
    },
  },
  tremolo: {
    tremolo: { frequency: 2.0, depth: 0.5 },
  },
  vibrato: {
    vibrato: { frequency: 2.0, depth: 0.5 },
  },
  rotation: {
    rotation: { rotationHz: 0.5 },
  },
  distortion: {
    distortion: {
      sinOffset: 0.0, sinScale: 1.0,
      cosOffset: 0.0, cosScale: 1.0,
      tanOffset: 0.0, tanScale: 1.0,
      offset: 0.0, scale: 1.5,
    },
  },
  soft: {
    lowPass: { smoothing: 20.0 },
  },
  pop: {
    equalizer: [
      { band: 0, gain: -0.05 },
      { band: 1, gain:  0.05 },
      { band: 2, gain:  0.10 },
      { band: 3, gain:  0.15 },
      { band: 4, gain:  0.13 },
      { band: 5, gain:  0.05 },
      { band: 6, gain: -0.03 },
    ],
  },
};

/** Payload that clears all active filters on Lavalink. */
export const RESET_PAYLOAD = {
  equalizer:   [],
  karaoke:     null,
  timescale:   null,
  tremolo:     null,
  vibrato:     null,
  rotation:    null,
  distortion:  null,
  channelMix:  null,
  lowPass:     null,
};

export function getFilterPayload(name) {
  return FILTERS[name.toLowerCase()] ?? null;
}

export function listFilters() {
  return Object.keys(FILTERS);
}

export function resetFiltersPayload() {
  return { ...RESET_PAYLOAD };
}
