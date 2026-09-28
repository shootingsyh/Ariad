export const ART_CAPABILITY_CATALOG = Object.freeze({
  'image.create': { media: 'image', recommendations: ['ComfyUI image workflow', 'browser/search/download image source'] },
  'image.review': { media: 'image', recommendations: ['vision-capable reviewer model'] },
  'video.create': { media: 'video', recommendations: ['video generation tool', 'browser/search/download video source'] },
  'video.review': { media: 'video', recommendations: ['video-capable model or keyframe/screenshot review'] },
  'audio.create': { media: 'audio', recommendations: ['audio generation tool', 'browser/search/download audio source'] },
  'audio.review': { media: 'audio', recommendations: ['audio-capable review model'] },
  'music.create': { media: 'music', recommendations: ['music generation tool/model', 'browser/search/download licensed music source'] },
  'music.review': { media: 'music', recommendations: ['music/audio understanding model'] },
});

export function requiredArtCapabilities(art = {}) {
  if (!art?.required) return [];
  const media = Array.isArray(art.media) ? art.media : [];
  return [...new Set(media.flatMap(kind =>
    ['image', 'video', 'audio', 'music'].includes(kind) ? [`${kind}.create`, `${kind}.review`] : []
  ))];
}

export function artCapabilityRecommendations(capabilities = []) {
  return capabilities.map(capability => ({
    capability,
    recommendations: ART_CAPABILITY_CATALOG[capability]?.recommendations ?? [],
  }));
}
