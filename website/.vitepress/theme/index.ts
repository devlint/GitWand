import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import HomeLanding from './HomeLanding.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeLanding', HomeLanding)
  },
} satisfies Theme
