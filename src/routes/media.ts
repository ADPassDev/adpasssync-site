// Site media at /media/<name>: videos and their caption tracks, served from
// the MEDIA_BUCKET R2 bucket for pages such as /support/.
//
// They live in R2 rather than public/ because Workers static assets are
// limited to 25 MiB per file and videos don't belong in git. To add or
// replace one:
//
//   npx wrangler r2 object put adpasssync-media/<name> --file <path> --remote
//
// Public and unauthenticated, like the pages that embed them. Only names
// shaped like media files are looked up, so nothing else that ends up in the
// bucket can be reached by guessing keys, and the Content-Type comes from the
// extension, whatever metadata the upload set.
//
// Range and conditional requests are handled by src/lib/r2-serve.ts. A
// <video> needs 206s to seek, and Safari won't start an MP4 without them.

import { Hono } from 'hono';
import type { Env } from '../types';
// Explicit extension so `npm test` can load this file under Node's type
// stripping, which doesn't resolve extensionless relative imports.
import { serveR2Object } from '../lib/r2-serve.ts';

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  vtt: 'text/vtt; charset=utf-8',
};

// Lower-case letters and digits in runs joined by single '-', '_' or '.',
// then one of the extensions above: installation-walkthrough.mp4,
// installation-walkthrough.en.vtt. The name is also the R2 key, and goes into
// Content-Disposition as is, so nothing that needs quoting gets through.
const NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\.(mp4|webm|vtt)$/;
const MAX_NAME_LENGTH = 128;

// Browsers may reuse a copy for an hour, then revalidate it with the ETag (a
// 304 when nothing changed). A file replaced in place under the same name
// reaches returning viewers within the hour; for an immediate switch, upload
// it under a new name and point the page at that.
const CACHE_CONTROL = 'public, max-age=3600';

const mediaRoutes = new Hono<{ Bindings: Env }>();

// Hono answers HEAD by running the GET handler and dropping its body, so
// this serves HEAD too; serveR2Object() checks the method.
mediaRoutes.get('/:name', (c) => {
  const name = c.req.param('name');
  const ext = name.length <= MAX_NAME_LENGTH ? NAME_RE.exec(name)?.[1] : undefined;
  const notFound = () => c.json({ error: 'not_found' }, 404);
  if (!ext) return notFound();
  return serveR2Object(c, c.env.MEDIA_BUCKET, name, {
    contentType: CONTENT_TYPES[ext]!,
    cacheControl: CACHE_CONTROL,
    // inline: play in the browser; the filename is used if someone saves it.
    contentDisposition: `inline; filename="${name}"`,
    // public/_headers only applies to static assets, not Worker responses.
    extraHeaders: { 'X-Content-Type-Options': 'nosniff' },
    notFound,
  });
});

export default mediaRoutes;
