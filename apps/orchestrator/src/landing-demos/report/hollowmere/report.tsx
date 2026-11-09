import { Report, Summary, Checks, Check, Video, BeforeAfter, Change, CodeRef, Text } from '@satura/report'

export default function HealthPackReachReport() {
  return (
    <Report title="Health pack: taken when the runner runs past" subtitle="HealthPack.Within measured 3D distance from the runner's body, so a pass 1 m off the line on the ground missed" status="pass">
      <Summary tone="ok">A runner who runs past a health pack on the ground within the 1.2 m reach now takes it. Before the fix, a pass 1 m off the line missed because the body centre sits about 1 m above the ground.</Summary>
      <Checks>
        <Check name="Packs/RunPast(1)" status="pass" detail="Taken at 1.70 s, health 50% → 100%" video="run" t={1.7} />
        <Check name="Packs/RunPast(0)" status="pass" detail="Straight over the pack: taken, closest 1.26 m on the ground" />
        <Check name="Packs/RunPast(1.2)" status="pass" detail="At the edge of reach: taken, closest 1.20 m on the ground" />
        <Check name="Packs/RunPast(1.6)" status="pass" detail="Beyond reach: not taken, health stays 50%" />
      </Checks>
      <Video id="run" src="/hollowmere/.sspace/videos/health-pack-reach.mp4" title="Runner passes 1 m off a health pack on the ground" label="game view" events={[
        { t: 0.41, kind: 'info', label: 'Pack dropped 6 m ahead, 1 m off the line' },
        { t: 1.7, kind: 'ok', label: 'Taken, health 50% → 100%' },
      ]} />
      <BeforeAfter title="Pass 1 m off the line">
        <Change name="Pack taken" before={0} after={1} unit="" better="higher" />
        <Change name="Health after the pass" before={50} after={100} unit="%" better="higher" />
      </BeforeAfter>
      <Text tone="muted" size="sm">Fix: <CodeRef path="Assets/Rollmates/Scripts/HealthPack.cs" line={50} endLine={56} /> now drops the height difference before comparing against the reach. The reach itself is unchanged (RunnerHealth.reach, 1.2 m).</Text>
      <Text tone="muted" size="sm">Video marks are on the handle's clock, measured from its start. The video started before the handle, so the marks may be off by a few tenths of a second; they were not checked frame by frame.</Text>
    </Report>
  )
}
