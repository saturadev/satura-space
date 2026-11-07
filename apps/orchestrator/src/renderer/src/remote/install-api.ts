import { createApi } from '@shared/create-api'
import { connectionState, installConsoleForwarding, installTapTracking, onConnectionState, wsTransport } from './ws-transport'
import { setRemoteLink } from '../lib/remote-link'
import { installTunerShims, onPhoneTunerFrame, phoneTunerSurface } from './tuner/platform'
import { setMediaLoader } from '../lib/media-loader'
import { phoneMediaLoader } from './media-cache'
import { saveMedia } from './media-save'
import { installMediaStream, mediaStream } from './media-stream'
import { setInlineReportFrames } from '../components/report/frame-host'

installConsoleForwarding()
installTapTracking()

window.api = createApi(wsTransport, {
  getZoomFactor: () => 1,
  getPathForFile: () => '',
  dropSharedTexture: () => {},
  sharedStats: () => ({ sessions: 0, slots: 0, early: 0, stale: 0, retired: 0 }),
  onSharedFrame: () => () => {},
  onTunerFrame: onPhoneTunerFrame,
  tunerSurface: phoneTunerSurface,
  dropTunerSurface: () => {}
})
installTunerShims(window.api)
setRemoteLink(connectionState().state === 'online')
onConnectionState((s) => setRemoteLink(s === 'online'))
installMediaStream()
setMediaLoader({ ...phoneMediaLoader, save: saveMedia, stream: mediaStream.url, onStreamChange: mediaStream.onChange, onStreamError: mediaStream.onError })
setInlineReportFrames(new URL('./report-frame/', location.href).href)
