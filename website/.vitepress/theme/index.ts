import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { defineComponent } from 'vue'
import HomeLanding from './HomeLanding.vue'
import FeaturesPage from './FeaturesPage.vue'
import ConflictEnginePage from './ConflictEnginePage.vue'
import AiAgentsPage from './AiAgentsPage.vue'
import AgentPage from './AgentPage.vue'
import CompareMatrix from './CompareMatrix.vue'
import './custom.css'

// Placeholder so the /advent pages build; Task 6 replaces it with the real calendar.
const AdventCalendar = defineComponent({
  props: { initialDay: Number },
  setup: () => () => null,
})

export default {
  extends: DefaultTheme,
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
