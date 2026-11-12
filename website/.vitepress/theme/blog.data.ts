import { createContentLoader } from 'vitepress'
import { toBlogPosts, type BlogPost } from './blog-posts'

/**
 * Every article in website/blog/, newest first. Re-evaluated on each build
 * (and on file change in dev), so publishing an article is enough to update
 * the home page card: nothing to edit in HomeLanding.vue.
 */
declare const data: BlogPost[]
export { data }

export default createContentLoader('blog/*.md', {
  includeSrc: true,
  transform: (pages) => toBlogPosts(pages),
})
