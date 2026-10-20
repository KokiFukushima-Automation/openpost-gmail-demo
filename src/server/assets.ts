// Canonical 43-byte fully transparent 1x1 GIF89a (doc 02 §1.3).
//
// Deviation note: the literal base64 constant given in doc 02 §1.3
// ("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7") decodes to only 42 bytes (its
// image-data sub-block is missing one byte), which conflicts with the doc's own "43-byte" claim
// and the spec's explicit Content-Length: 43 requirement (tests + acceptance criteria). This is
// the standard, well-formed 43-byte transparent GIF89a instead.
const TRANSPARENT_GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

export const TRANSPARENT_GIF: Buffer = Buffer.from(TRANSPARENT_GIF_BASE64, 'base64');
