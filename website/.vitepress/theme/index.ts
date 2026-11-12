import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import HomeLanding from './HomeLanding.vue'
import FeaturesPage from './FeaturesPage.vue'
import ConflictEnginePage from './ConflictEnginePage.vue'
import AiAgentsPage from './AiAgentsPage.vue'
import AgentPage from './AgentPage.vue'
import CompareMatrix from './CompareMatrix.vue'
import AdventCalendar from './advent/AdventCalendar.vue'
import AdventNavLink from './advent/AdventNavLink.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => h(AdventNavLink),
      'nav-screen-content-after': () => h(AdventNavLink),
    }),
  enhanceApp({ app }) {
    app.component('HomeLanding', HomeLanding)
    app.component('FeaturesPage', FeaturesPage)
    app.component('ConflictEnginePage', ConflictEnginePage)
    app.component('AiAgentsPage', AiAgentsPage)
    app.component('AgentPage', AgentPage)
    app.component('CompareMatrix', CompareMatrix)
    app.component('AdventCalendar', AdventCalendar)
  },
} satisfies Theme
