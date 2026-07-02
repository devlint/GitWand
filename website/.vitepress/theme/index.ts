import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import HomeLanding from './HomeLanding.vue'
import FeaturesPage from './FeaturesPage.vue'
import ConflictEnginePage from './ConflictEnginePage.vue'
import AiAgentsPage from './AiAgentsPage.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('HomeLanding', HomeLanding)
    app.component('FeaturesPage', FeaturesPage)
    app.component('ConflictEnginePage', ConflictEnginePage)
    app.component('AiAgentsPage', AiAgentsPage)
  },
} satisfies Theme
