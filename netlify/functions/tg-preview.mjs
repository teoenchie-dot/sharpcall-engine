// netlify/functions/tg-preview.mjs
// SAFE preview endpoint — composes the exact daily posts from live data but NEVER sends anything.
// GET /.netlify/functions/tg-preview  -> { free, pro }
import { buildPosts, gather } from "./tg-post.mjs";

export default async () => {
  const posts = buildPosts(await gather());
  return new Response(JSON.stringify(posts, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
  });
};
