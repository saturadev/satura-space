export function playSound(url: string, volume: number): void {
  try {
    const audio = new Audio(url)
    audio.volume = Math.max(0, Math.min(1, volume))
    void audio.play().catch(() => {})
  } catch {
  }
}
