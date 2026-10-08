// Lane C: WeChat screen recognition from artifact images. See docs/lanes/lane-c.md.
// Read-only by construction: image file in, PageFacts out.
export { createRecognizer, readTheme, type RecognizerOptions } from './recognizer.ts';
export { analyze, conversationTitle, requestSection, chatRows, detailPane, bubbles, inputBox, buttonHits, dialogButtons, classify, scrollbarVisible, type AnalyzeInput, type RequestSection, type PageFactsWithConversation } from './analyze.ts';
export { identityCandidates, sameName, MIN_IDENTITY_CONFIDENCE, type IdentityCandidates, type AmbiguityReason } from './identity.ts';
export { loadProfiles, parseProfile, publicProfile, Geometry, PROFILES_DIR, type WeChatLayoutProfile, type ProfileLayout, type ProfileVocabulary } from './profile.ts';
export { decodePng, pngSize, PixelSampler, NO_PIXELS, PngError, type Pixels, type Sampler, type ColourShares } from './png.ts';
export { createOcrRunner, ocrAvailable, OcrError, DEFAULT_OCR_PATH, type OcrRunner } from './ocr.ts';
export { norm, untruncate, isTruncated } from './text.ts';
