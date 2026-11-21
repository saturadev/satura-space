import { Composition } from 'remotion'
import { ClipVsGame, FPS, canvasFor, totalFrames, type ClipVsGameProps } from './ClipVsGame'

const defaults: ClipVsGameProps = {
  clipFile: 'clip.mp4',
  gameFile: 'gameplay.mp4',
  clipSeconds: 10,
  clipWidth: 1080,
  clipHeight: 1920,
  gameSeconds: 10,
  gameWidth: 1920,
  gameHeight: 1080,
  layout: 'side',
  title: '',
  credit: '',
  sound: 'none',
  endCard: true
}

export const Root = () => (
  <Composition
    id="ClipVsGame"
    component={ClipVsGame}
    fps={FPS}
    width={1920}
    height={1080}
    durationInFrames={300}
    defaultProps={defaults}
    calculateMetadata={({ props }) => ({ durationInFrames: totalFrames(props), ...canvasFor(props) })}
  />
)
