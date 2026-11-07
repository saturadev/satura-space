import { defineHandle } from './registry'
import { clearPhoneVideos, phoneVideoCache, phoneVideoLimits, videoPlan } from '../remote/phone-video'
import { clearPhoneVideoStills, phoneVideoStills } from '../remote/phone-video-still'
import { appCaches, clearAppCaches } from '../app-caches'
import { APP_CACHE_IDS, type AppCacheId } from '@shared/app-caches'

defineHandle({
  name: 'remote.phoneVideos',
  side: 'main',
  description:
    "Reads the cache of phone versions the Mac makes for report videos the phone can't play well as they are (4K, high bitrate, ProRes, HEVC tagged hev1, moov at the end): cache folder, total size, cap, the free space the Mac keeps, free space now, cached files (newest use first, recipe r1080/r720/r480 for the renditions the phone's quality picker asks for) and running or queued jobs, plus the first-frame stills the phone shows before play (count, bytes, size and whether WebCodecs or avconvert and WebCodecs made each). capMB and minFreeGB change the cap and the kept free space for this run (0 keeps the current value; the defaults are 2000 MB and 10 GB), so eviction and the low-disk guard can be tried without filling the disk. clear: true deletes every phone version, rendition and still. plan: <absolute video path> returns the playback plan the phone would get for that file (and queues the phone version), with hevc/webm saying what the phone can decode.",
  params: { capMB: 0, minFreeGB: 0, clear: false, plan: '', hevc: true, webm: false },
  async run(p) {
    if (Number(p.capMB) > 0) phoneVideoLimits.capBytes = Number(p.capMB) * 1e6
    if (Number(p.minFreeGB) > 0) phoneVideoLimits.minFreeBytes = Number(p.minFreeGB) * 1e9
    if (p.clear) {
      await clearPhoneVideos()
      await clearPhoneVideoStills()
    }
    const plan = p.plan ? await videoPlan({ path: String(p.plan), hevc: !!p.hevc, webm: !!p.webm }) : undefined
    return { ...(await phoneVideoCache()), stills: await phoneVideoStills(), ...(plan ? { plan } : {}) }
  }
})

defineHandle({
  name: 'app.caches',
  side: 'main',
  description:
    "Reads what Settings, Storage shows: the caches the app keeps on this computer, each with its id, bytes, file count and whether it can be deleted (phone-versions, phone-1080, phone-720, phone-480 and phone-stills are the copies of report videos made for Satura Remote; web, code and gpu are the web views' HTTP, script and graphics caches), the total, the phone video folder and userData. clear: a list of ids deletes those the way the Delete buttons do and returns the sizes after, with what was cleared and the bytes freed.",
  params: { clear: [] as string[] },
  async run(p) {
    const ids = (Array.isArray(p.clear) ? p.clear : []).map(String).filter((id): id is AppCacheId => APP_CACHE_IDS.includes(id as AppCacheId))
    return ids.length ? clearAppCaches(ids) : appCaches()
  }
})
