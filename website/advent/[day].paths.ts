export default {
  paths() {
    return Array.from({ length: 24 }, (_, i) => ({ params: { day: String(i + 1) } }))
  },
}
